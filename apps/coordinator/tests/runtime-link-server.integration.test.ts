import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  RUNTIME_LINK_SUBPROTOCOL,
  parseRuntimeLinkServerMessage,
  runtimeLinkAuthenticateV1Schema,
  runtimeLinkClientProofInput,
  runtimeLinkServerProofInput,
  skillInvocationV1Schema,
  type BotHeartbeatV1,
  type ControlAuthorizationContext,
  type RuntimeLinkChallengeV1,
  type RuntimeLinkProofContext,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  BotRegistry,
  InMemoryStopAuditSink,
  RuntimeLinkServer,
  StopController,
} from "../src/index.js";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-link-test";
const KEY_ID = "runtime-key-01";
const SECRET = "runtime-link-test-secret-000000000000000000000001";
const SECRET_SHA256 = createHash("sha256").update(SECRET, "utf8").digest("hex");
const CHALLENGE_NONCE = Buffer.alloc(32, 1).toString("base64url");
const CLIENT_NONCE = Buffer.alloc(32, 2).toString("base64url");

const logger: AppLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const servers: RuntimeLinkServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.clearAllMocks();
});

describe("Coordinator Runtime Link server", () => {
  it("authenticates both directions, ingests telemetry, and confirms a stop", async () => {
    const { registry, server, url } = await startServer();
    const socket = await authenticate(url);

    const heartbeat = heartbeatMessage(1);
    const acknowledgementPromise = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeat));
    await expect(acknowledgementPromise).resolves.toMatchObject({
      type: "runtime.link.telemetry-ack.v1",
      payload: {
        telemetryMessageId: heartbeat.messageId,
        accepted: true,
        reason: "accepted",
      },
    });
    expect(registry.get(BOT_ID, NOW)).toMatchObject({
      botId: BOT_ID,
      runtimeInstanceId: RUNTIME_ID,
      connectionState: "online",
    });

    const commandPromise = nextServerMessage(socket);
    const controller = new StopController({
      instanceId: "coordinator-test",
      registry,
      transport: server,
      auditSink: new InMemoryStopAuditSink(),
      logger,
      now: () => NOW,
      randomId: uuidSequence(500),
    });
    const stopPromise = controller.requestStop({
      commandId: testUuid(600),
      traceId: testUuid(601),
      botId: BOT_ID,
      mode: "graceful",
      reason: "Operator confirmed Runtime Link test stop.",
      gracePeriodMs: 1_000,
      timeoutMs: 2_000,
      authorization: {
        decisionId: testUuid(602),
        actorId: "operator-01",
        permissions: new Set(["bot.stop"]),
        issuedAt: new Date(NOW.getTime() - 1_000),
        expiresAt: new Date(NOW.getTime() + 10_000),
      },
    });
    const command = (await commandPromise) as StopBotCommandV1;
    expect(command).toMatchObject({
      type: "bot.stop.command.v1",
      botId: BOT_ID,
      traceId: testUuid(601),
      payload: {
        commandId: testUuid(600),
        expectedRuntimeInstanceId: RUNTIME_ID,
      },
    });

    socket.send(
      JSON.stringify({
        schemaVersion: "1.0",
        messageId: testUuid(700),
        traceId: command.traceId,
        timestamp: NOW.toISOString(),
        source: { service: "bot-runtime", instanceId: RUNTIME_ID },
        botId: BOT_ID,
        type: "bot.stop.result.v1",
        payload: {
          commandId: command.payload.commandId,
          runtimeInstanceId: RUNTIME_ID,
          outcome: "completed",
          completedAt: NOW.toISOString(),
        },
      }),
    );
    await expect(stopPromise).resolves.toMatchObject({
      traceId: command.traceId,
      payload: { outcome: "completed" },
    });
    expect(registry.get(BOT_ID, NOW)?.connectionState).toBe("offline");
  });

  it("acknowledges duplicate telemetry without mutating newer state", async () => {
    const { registry, url } = await startServer();
    const socket = await authenticate(url);
    const heartbeat = heartbeatMessage(1);

    const firstAck = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeat));
    await firstAck;
    const duplicateAck = nextServerMessage(socket);
    socket.send(JSON.stringify(heartbeat));
    await expect(duplicateAck).resolves.toMatchObject({
      type: "runtime.link.telemetry-ack.v1",
      payload: { accepted: false, reason: "duplicate_message" },
    });
    expect(registry.get(BOT_ID, NOW)?.lastSequence).toBe(1);
  });

  it("round-trips an authorized, version-bound skill invocation", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const command = skillCommand(testUuid(740), testUuid(741));
    const commandReceived = nextServerMessage(socket);
    const resultPromise = server.sendSkillInvocation(
      command,
      skillAuthorizationContext(command),
      new AbortController().signal,
    );

    await expect(commandReceived).resolves.toEqual(command);
    const result = skillResult(command);
    socket.send(JSON.stringify(result));
    await expect(resultPromise).resolves.toEqual(result);
  });

  it("rejects an invalid client proof before registry mutation", async () => {
    const { registry, url } = await startServer();
    const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL);
    sockets.push(socket);
    const challenge = (await nextServerMessage(socket)) as RuntimeLinkChallengeV1;
    const closed = once(socket, "close");
    socket.send(
      JSON.stringify(
        runtimeLinkAuthenticateV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(800),
          timestamp: NOW.toISOString(),
          type: "runtime.link.authenticate.v1",
          payload: {
            challengeMessageId: challenge.messageId,
            coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
            challengeNonce: challenge.payload.challengeNonce,
            clientNonce: CLIENT_NONCE,
            botId: BOT_ID,
            runtimeInstanceId: RUNTIME_ID,
            keyId: KEY_ID,
            clientProof: Buffer.alloc(32, 9).toString("base64url"),
          },
        }),
      ),
    );
    const [code] = await closed;
    expect(code).toBe(1008);
    expect(registry.get(BOT_ID, NOW)).toBeNull();
  });

  it("rejects binary application frames", async () => {
    const { url } = await startServer();
    const socket = await authenticate(url);
    const closed = once(socket, "close");
    socket.send(Buffer.from("{}"));
    const [code] = await closed;
    expect(code).toBe(1003);
  });

  it("rejects browser-origin WebSocket upgrades", async () => {
    const { url } = await startServer();
    expect(await rejectedWebSocketStatus(url, "https://untrusted.example")).toBe(
      403,
    );
  });

  it("cleans a pending stop when its caller aborts", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const abortController = new AbortController();
    const command = stopCommand(testUuid(900), testUuid(901));
    const commandReceived = nextServerMessage(socket);
    const pending = server.sendStopCommand(
      command,
      authorizationContext(command),
      abortController.signal,
    );
    await commandReceived;
    abortController.abort();
    await expect(pending).rejects.toMatchObject({ code: "RUNTIME_LINK_ABORTED" });
  });

  it("fails a pending stop when the authenticated Runtime disconnects", async () => {
    const { server, url } = await startServer();
    const socket = await authenticateAndActivate(url);
    const command = stopCommand(testUuid(910), testUuid(911));
    const commandReceived = nextServerMessage(socket);
    const pending = server.sendStopCommand(
      command,
      authorizationContext(command),
      new AbortController().signal,
    );
    await commandReceived;
    socket.terminate();
    await expect(pending).rejects.toMatchObject({
      code: "RUNTIME_LINK_UNAVAILABLE",
    });
  });

  it("bounds unauthenticated sessions and pending stop commands", async () => {
    const { server, url } = await startServer({
      maxSessions: 1,
      maxPendingStops: 1,
    });
    const socket = await authenticateAndActivate(url);
    expect(await rejectedWebSocketStatus(url)).toBe(503);

    const firstAbort = new AbortController();
    const firstCommand = stopCommand(testUuid(930), testUuid(931));
    const firstReceived = nextServerMessage(socket);
    const firstPending = server.sendStopCommand(
      firstCommand,
      authorizationContext(firstCommand),
      firstAbort.signal,
    );
    await firstReceived;

    const secondCommand = stopCommand(testUuid(932), testUuid(933));
    await expect(
      server.sendStopCommand(
        secondCommand,
        authorizationContext(secondCommand),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "RUNTIME_LINK_BACKPRESSURE" });
    firstAbort.abort();
    await expect(firstPending).rejects.toMatchObject({
      code: "RUNTIME_LINK_ABORTED",
    });
  });
});

async function startServer(
  overrides: Partial<{ maxSessions: number; maxPendingStops: number }> = {},
): Promise<{
  registry: BotRegistry;
  server: RuntimeLinkServer;
  url: string;
}> {
  const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
  const server = new RuntimeLinkServer({
    host: "127.0.0.1",
    port: 0,
    instanceId: "coordinator-test",
    peers: [{ keyId: KEY_ID, botId: BOT_ID, secretSha256: SECRET_SHA256 }],
    registry,
    logger,
    now: () => NOW,
    randomId: uuidSequence(1),
    randomNonce: () => CHALLENGE_NONCE,
    ...overrides,
  });
  servers.push(server);
  const address = await server.start();
  return {
    registry,
    server,
    url: `ws://127.0.0.1:${address.port}/v1/runtime-link`,
  };
}

async function authenticate(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL);
  sockets.push(socket);
  const challenge = (await nextServerMessage(socket)) as RuntimeLinkChallengeV1;
  const context: RuntimeLinkProofContext = {
    challengeMessageId: challenge.messageId,
    coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
    challengeNonce: challenge.payload.challengeNonce,
    clientNonce: CLIENT_NONCE,
    botId: BOT_ID,
    runtimeInstanceId: RUNTIME_ID,
    keyId: KEY_ID,
  };
  const authenticateMessageId = testUuid(300);
  const acceptedPromise = nextServerMessage(socket);
  socket.send(
    JSON.stringify(
      runtimeLinkAuthenticateV1Schema.parse({
        schemaVersion: "1.0",
        messageId: authenticateMessageId,
        timestamp: NOW.toISOString(),
        type: "runtime.link.authenticate.v1",
        payload: {
          ...context,
          clientProof: hmac(runtimeLinkClientProofInput(context)),
        },
      }),
    ),
  );
  const accepted = await acceptedPromise;
  expect(accepted).toMatchObject({
    type: "runtime.link.accepted.v1",
    payload: {
      authenticateMessageId,
      botId: BOT_ID,
      runtimeInstanceId: RUNTIME_ID,
      keyId: KEY_ID,
    },
  });
  if (accepted.type !== "runtime.link.accepted.v1") {
    throw new Error("Expected Runtime Link accepted message.");
  }
  expect(accepted.payload.serverProof).toBe(
    hmac(runtimeLinkServerProofInput({ ...context, authenticateMessageId })),
  );
  return socket;
}

async function authenticateAndActivate(url: string): Promise<WebSocket> {
  const socket = await authenticate(url);
  const acknowledgement = nextServerMessage(socket);
  socket.send(JSON.stringify(heartbeatMessage(1)));
  await acknowledgement;
  return socket;
}

function nextServerMessage(socket: WebSocket) {
  return new Promise<ReturnType<typeof parseRuntimeLinkServerMessage>>(
    (resolve, reject) => {
      socket.once("message", (data) => {
        try {
          resolve(parseRuntimeLinkServerMessage(JSON.parse(data.toString()) as unknown));
        } catch (cause) {
          reject(cause);
        }
      });
      socket.once("error", reject);
    },
  );
}

function rejectedWebSocketStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, RUNTIME_LINK_SUBPROTOCOL, {
      ...(origin ? { headers: { Origin: origin } } : {}),
    });
    socket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    socket.once("error", () => undefined);
    socket.once("open", () => {
      socket.terminate();
      reject(new Error("Expected Runtime Link session limit rejection."));
    });
  });
}

function heartbeatMessage(sequence: number): BotHeartbeatV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(400 + sequence),
    traceId: "trace-runtime-link",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.heartbeat.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      uptimeMs: sequence * 1_000,
      lastStatusSequence: null,
      currentTaskId: null,
    },
  };
}

function stopCommand(commandId: string, traceId: string): StopBotCommandV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(920),
    traceId,
    timestamp: NOW.toISOString(),
    source: { service: "coordinator", instanceId: "coordinator-test" },
    botId: BOT_ID,
    type: "bot.stop.command.v1",
    payload: {
      commandId,
      mode: "graceful",
      reason: "Operator confirmed Runtime Link transport stop.",
      requestedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      gracePeriodMs: 1_000,
      expectedRuntimeInstanceId: RUNTIME_ID,
      authorization: {
        decisionId: testUuid(921),
        actorId: "operator-01",
        permission: "bot.stop",
        issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      },
    },
  };
}

function authorizationContext(
  command: StopBotCommandV1,
): ControlAuthorizationContext {
  return {
    decisionId: command.payload.authorization.decisionId,
    actorId: command.payload.authorization.actorId,
    botId: command.botId,
    commandId: command.payload.commandId,
    permissions: new Set(["bot.stop"]),
    now: NOW,
  };
}

function skillCommand(messageId: string, invocationId: string): SkillInvocationV1 {
  const expiresAt = new Date(NOW.getTime() + 10_000).toISOString();
  return skillInvocationV1Schema.parse({
    schemaVersion: "1.0",
    messageId,
    traceId: "trace-runtime-link-skill",
    timestamp: NOW.toISOString(),
    source: { service: "coordinator", instanceId: "coordinator-test" },
    botId: BOT_ID,
    taskId: "task-runtime-link-skill",
    type: "skill.invoke.v1",
    payload: {
      invocationId,
      skillId: "movement.goto",
      skillVersion: "1.0.0",
      expectedRuntimeInstanceId: RUNTIME_ID,
      expectedStateSequence: 5,
      taskVersion: 2,
      expiresAt,
      input: { target: { x: 1, y: 64, z: 1 } },
      authorization: {
        decisionId: testUuid(742),
        actorId: "coordinator-policy",
        issuedAt: NOW.toISOString(),
        expiresAt,
      },
    },
  });
}

function skillAuthorizationContext(command: SkillInvocationV1) {
  return {
    decisionId: command.payload.authorization.decisionId,
    actorId: command.payload.authorization.actorId,
    botId: command.botId,
    taskId: command.taskId,
    invocationId: command.payload.invocationId,
    skillId: command.payload.skillId,
    skillVersion: command.payload.skillVersion,
    permissions: new Set(["skill.invoke" as const]),
    now: NOW,
  };
}

function skillResult(command: SkillInvocationV1): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(743),
    traceId: command.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    taskId: command.taskId,
    type: "skill.result.v1",
    payload: {
      invocationId: command.payload.invocationId,
      skillId: command.payload.skillId,
      skillVersion: command.payload.skillVersion,
      outcome: "completed",
      attempts: 1,
      completedAt: NOW.toISOString(),
      output: { reached: true },
    },
  };
}

function hmac(value: string): string {
  const key = createHash("sha256").update(SECRET, "utf8").digest();
  return createHmac("sha256", key).update(value, "utf8").digest("base64url");
}

function uuidSequence(start: number): () => string {
  let value = start;
  return () => testUuid(value++);
}

function testUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

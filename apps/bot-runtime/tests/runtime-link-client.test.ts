import { createHash, createHmac } from "node:crypto";

import { createStructuredLogger } from "@minecraft-studio/observability";
import {
  RUNTIME_LINK_MAX_PAYLOAD_BYTES,
  RUNTIME_LINK_SUBPROTOCOL,
  parseRuntimeLinkClientMessage,
  runtimeLinkAcceptedV1Schema,
  runtimeLinkChallengeV1Schema,
  runtimeLinkClientProofInput,
  runtimeLinkServerProofInput,
  runtimeLinkStateRequestV1Schema,
  runtimeLinkTelemetryAckV1Schema,
  skillInvocationV1Schema,
  stopBotCommandV1Schema,
  type BotStopResultV1,
  type BotTelemetryMessageV1,
  type RuntimeLinkAuthenticateV1,
  type RuntimeLinkStateRequestV1,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";

import {
  RuntimeLinkClient,
  type RuntimeLinkClientOptions,
} from "../src/runtime-link-client.js";
import type { RuntimeLinkClientConfig } from "../src/runtime-link-config.js";

const BOT_ID = "studio-bot-01";
const RUNTIME_ID = "runtime-test-01";
const KEY_ID = "runtime-key-01";
const SECRET = "correct-horse-battery-staple-123456";
const COORDINATOR_ID = "coordinator-test-01";

type TestServer = {
  url: string;
  server: WebSocketServer;
  sockets: Set<WebSocket>;
  telemetry: BotTelemetryMessageV1[];
  stopResults: BotStopResultV1[];
  skillResults: SkillExecutionResultV1[];
  receivedTelemetryIds: string[];
  connectionCount: () => number;
  authenticated: Promise<WebSocket>;
  close: () => Promise<void>;
};

const servers: TestServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(({ close }) => close()));
});

describe("RuntimeLinkClient", () => {
  it("authenticates mutually, ACKs telemetry, and executes a scoped stop", async () => {
    const testServer = await createTestServer();
    const handled = vi.fn<RuntimeLinkClientOptions["handleStopCommand"]>(
      async (command, authorizationContext) => {
        expect([...authorizationContext.permissions]).toEqual(["bot.stop"]);
        expect(authorizationContext).toMatchObject({
          decisionId: command.payload.authorization.decisionId,
          actorId: command.payload.authorization.actorId,
          botId: BOT_ID,
          commandId: command.payload.commandId,
        });
        return stopResult(command);
      },
    );
    const publishCurrentState = vi.fn();
    const failClosed = vi.fn();
    const client = runtimeLinkClient(testServer.url, {
      handleStopCommand: handled,
      publishCurrentState,
      failClosed,
    });

    await client.start();
    expect(client.isAuthenticated()).toBe(true);
    const telemetry = heartbeat("11111111-1111-4111-8111-111111111111", 1);
    client.publishTelemetry(telemetry);
    await vi.waitFor(() => expect(testServer.telemetry).toEqual([telemetry]));

    const socket = await testServer.authenticated;
    const command = stopCommand();
    socket.send(JSON.stringify(command));
    await vi.waitFor(() => {
      expect(handled).toHaveBeenCalledTimes(1);
      expect(testServer.stopResults).toEqual([
        expect.objectContaining({
          traceId: command.traceId,
          botId: BOT_ID,
          type: "bot.stop.result.v1",
          payload: expect.objectContaining({
            commandId: command.payload.commandId,
            runtimeInstanceId: RUNTIME_ID,
            outcome: "completed",
          }),
        }),
      ]);
    });
    expect(publishCurrentState).not.toHaveBeenCalled();
    expect(failClosed).not.toHaveBeenCalled();

    await client.close();
  });

  it("resends one unacknowledged telemetry message with the same messageId", async () => {
    const testServer = await createTestServer({
      closeBeforeFirstAck: true,
    });
    const publishCurrentState = vi.fn();
    const failClosed = vi.fn();
    const client = runtimeLinkClient(
      testServer.url,
      { publishCurrentState, failClosed },
      {
        telemetryAckTimeoutMs: 20,
        reconnect: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
      },
    );

    await client.start();
    const message = heartbeat(
      "22222222-2222-4222-8222-222222222222",
      2,
    );
    client.publishTelemetry(message);

    await vi.waitFor(() => {
      expect(testServer.receivedTelemetryIds).toHaveLength(2);
    });
    expect(testServer.receivedTelemetryIds).toEqual([
      message.messageId,
      message.messageId,
    ]);
    expect(publishCurrentState).toHaveBeenCalledTimes(1);
    expect(failClosed).not.toHaveBeenCalled();

    await client.close();
  });

  it("executes a Coordinator skill invocation only after mutual authentication", async () => {
    const testServer = await createTestServer();
    const handled = vi.fn<RuntimeLinkClientOptions["handleSkillInvocation"]>(
      async (invocation, coordinatorInstanceId) => {
        expect(coordinatorInstanceId).toBe(COORDINATOR_ID);
        return skillResult(invocation);
      },
    );
    const client = runtimeLinkClient(testServer.url, {
      handleSkillInvocation: handled,
    });

    await client.start();
    const socket = await testServer.authenticated;
    const invocation = skillInvocation();
    socket.send(JSON.stringify(invocation));
    await vi.waitFor(() => {
      expect(handled).toHaveBeenCalledWith(invocation, COORDINATOR_ID);
      expect(testServer.skillResults).toEqual([skillResult(invocation)]);
    });
    await client.close();
  });

  it("publishes current state for a valid authenticated state request", async () => {
    const testServer = await createTestServer();
    const publishCurrentState = vi.fn();
    const failClosed = vi.fn();
    const client = runtimeLinkClient(testServer.url, {
      publishCurrentState,
      failClosed,
    });

    await client.start();
    const socket = await testServer.authenticated;
    socket.send(JSON.stringify(stateRequest()));

    await vi.waitFor(() => {
      expect(publishCurrentState).toHaveBeenCalledTimes(1);
    });
    expect(client.isAuthenticated()).toBe(true);
    expect(failClosed).not.toHaveBeenCalled();
    await client.close();
  });

  it.each([
    [
      "Coordinator",
      (request: RuntimeLinkStateRequestV1) => ({
        ...request,
        source: { ...request.source, instanceId: "coordinator-other-01" },
      }),
    ],
    [
      "Bot",
      (request: RuntimeLinkStateRequestV1) => ({
        ...request,
        botId: "studio-bot-other-01",
      }),
    ],
    [
      "Runtime",
      (request: RuntimeLinkStateRequestV1) => ({
        ...request,
        payload: {
          ...request.payload,
          expectedRuntimeInstanceId: "runtime-other-01",
        },
      }),
    ],
  ])(
    "rejects a state request with a mismatched %s identity without publishing",
    async (_identity, mutate) => {
      const testServer = await createTestServer();
      const publishCurrentState = vi.fn();
      const client = runtimeLinkClient(
        testServer.url,
        { publishCurrentState },
        {
          reconnect: {
            maxAttempts: 2,
            baseDelayMs: 1_000,
            maxDelayMs: 1_000,
          },
        },
      );

      await client.start();
      const socket = await testServer.authenticated;
      const closed = new Promise<{ code: number; reason: string }>((resolve) => {
        socket.once("close", (code, reason) => {
          resolve({ code, reason: reason.toString("utf8") });
        });
      });
      socket.send(JSON.stringify(mutate(stateRequest())));

      await expect(closed).resolves.toEqual({
        code: 1008,
        reason: "state_request_rejected",
      });
      expect(publishCurrentState).not.toHaveBeenCalled();
      await client.close();
    },
  );

  it("rejects an expired state request without publishing", async () => {
    const testServer = await createTestServer();
    const publishCurrentState = vi.fn();
    const client = runtimeLinkClient(
      testServer.url,
      { publishCurrentState },
      {
        reconnect: {
          maxAttempts: 2,
          baseDelayMs: 1_000,
          maxDelayMs: 1_000,
        },
      },
    );

    await client.start();
    const socket = await testServer.authenticated;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });
    socket.send(
      JSON.stringify(stateRequest(new Date(Date.now() - 10_000), 5_000)),
    );

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "state_request_rejected",
    });
    expect(publishCurrentState).not.toHaveBeenCalled();
    await client.close();
  });

  it("rejects a state request beyond the allowed future clock skew", async () => {
    const testServer = await createTestServer();
    const publishCurrentState = vi.fn();
    const client = runtimeLinkClient(
      testServer.url,
      { publishCurrentState },
      {
        reconnect: {
          maxAttempts: 2,
          baseDelayMs: 1_000,
          maxDelayMs: 1_000,
        },
      },
    );

    await client.start();
    const socket = await testServer.authenticated;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });
    socket.send(
      JSON.stringify(stateRequest(new Date(Date.now() + 60_000), 5_000)),
    );

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "state_request_rejected",
    });
    expect(publishCurrentState).not.toHaveBeenCalled();
    await client.close();
  });

  it("rejects a stale state request even when its expiry is still in the future", async () => {
    const testServer = await createTestServer();
    const publishCurrentState = vi.fn();
    const client = runtimeLinkClient(
      testServer.url,
      { publishCurrentState },
      {
        reconnect: {
          maxAttempts: 2,
          baseDelayMs: 1_000,
          maxDelayMs: 1_000,
        },
      },
    );

    await client.start();
    const socket = await testServer.authenticated;
    const closed = new Promise<{ code: number; reason: string }>((resolve) => {
      socket.once("close", (code, reason) => {
        resolve({ code, reason: reason.toString("utf8") });
      });
    });
    socket.send(
      JSON.stringify(stateRequest(new Date(Date.now() - 40_000), 60_000)),
    );

    await expect(closed).resolves.toEqual({
      code: 1008,
      reason: "state_request_rejected",
    });
    expect(publishCurrentState).not.toHaveBeenCalled();
    await client.close();
  });

  it("rejects a forged server proof and fails closed after bounded retries", async () => {
    const testServer = await createTestServer({ forgeServerProof: true });
    const failClosed = vi.fn();
    const client = runtimeLinkClient(
      testServer.url,
      { failClosed },
      {
        handshakeTimeoutMs: 30,
        reconnect: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
      },
    );

    await expect(client.start()).rejects.toMatchObject({
      code: "RUNTIME_LINK_RETRY_EXHAUSTED",
    });
    expect(failClosed).toHaveBeenCalledTimes(1);
    expect(client.isAuthenticated()).toBe(false);

    await client.close();
  });

  it("fails closed when non-coalescible telemetry exhausts the bounded queue", async () => {
    const testServer = await createTestServer({ suppressTelemetryAck: true });
    const failClosed = vi.fn();
    const client = runtimeLinkClient(
      testServer.url,
      { failClosed },
      {
        queue: {
          maxMessages: 2,
          maxBytes: 64 * 1_024,
          maxSocketBufferedBytes: 64 * 1_024,
        },
      },
    );

    await client.start();
    client.publishTelemetry(disconnected(uuid(71), 1));
    client.publishTelemetry(disconnected(uuid(72), 2));
    client.publishTelemetry(disconnected(uuid(73), 3));

    await vi.waitFor(() => {
      expect(failClosed).toHaveBeenCalledWith(
        expect.objectContaining({ code: "RUNTIME_LINK_QUEUE_OVERFLOW" }),
      );
    });
    expect(client.isAuthenticated()).toBe(false);
    await client.close();
  });

  it("does not reconnect after an intentional close", async () => {
    const testServer = await createTestServer();
    const failClosed = vi.fn();
    const client = runtimeLinkClient(testServer.url, { failClosed });

    await client.start();
    expect(testServer.connectionCount()).toBe(1);
    await client.close();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(testServer.connectionCount()).toBe(1);
    expect(failClosed).not.toHaveBeenCalled();
  });
});

function runtimeLinkClient(
  url: string,
  overrides: Partial<RuntimeLinkClientOptions> = {},
  configOverrides: Partial<RuntimeLinkClientConfig> = {},
): RuntimeLinkClient {
  const config: RuntimeLinkClientConfig = {
    url,
    keyId: KEY_ID,
    secret: SECRET,
    handshakeTimeoutMs: 200,
    telemetryAckTimeoutMs: 200,
    reconnect: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 },
    queue: {
      maxMessages: 16,
      maxBytes: 64 * 1_024,
      maxSocketBufferedBytes: 64 * 1_024,
    },
    ...configOverrides,
  };
  return new RuntimeLinkClient({
    config,
    botId: BOT_ID,
    runtimeInstanceId: RUNTIME_ID,
    logger: createStructuredLogger({
      service: "bot-runtime",
      instanceId: RUNTIME_ID,
      sink: () => undefined,
    }),
    handleStopCommand:
      overrides.handleStopCommand ?? (async (command) => stopResult(command)),
    handleSkillInvocation:
      overrides.handleSkillInvocation ??
      (async (invocation) => skillResult(invocation)),
    handleSkillCancellation:
      overrides.handleSkillCancellation ?? (() => false),
    publishCurrentState: overrides.publishCurrentState ?? (() => undefined),
    failClosed: overrides.failClosed ?? (() => undefined),
  });
}

async function createTestServer(
  options: Readonly<{
    closeBeforeFirstAck?: boolean;
    forgeServerProof?: boolean;
    suppressTelemetryAck?: boolean;
  }> = {},
): Promise<TestServer> {
  const telemetry: BotTelemetryMessageV1[] = [];
  const stopResults: BotStopResultV1[] = [];
  const skillResults: SkillExecutionResultV1[] = [];
  const receivedTelemetryIds: string[] = [];
  const sockets = new Set<WebSocket>();
  let connectionCount = 0;
  let authenticateCount = 0;
  let resolveAuthenticated: (socket: WebSocket) => void = () => undefined;
  const authenticated = new Promise<WebSocket>((resolve) => {
    resolveAuthenticated = resolve;
  });
  const server = new WebSocketServer({
    host: "127.0.0.1",
    port: 0,
    maxPayload: RUNTIME_LINK_MAX_PAYLOAD_BYTES,
    perMessageDeflate: false,
    handleProtocols: (protocols) =>
      protocols.has(RUNTIME_LINK_SUBPROTOCOL)
        ? RUNTIME_LINK_SUBPROTOCOL
        : false,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    connectionCount += 1;
    const challenge = runtimeLinkChallengeV1Schema.parse({
      schemaVersion: "1.0",
      messageId: uuid(10 + connectionCount),
      timestamp: new Date().toISOString(),
      type: "runtime.link.challenge.v1",
      payload: {
        coordinatorInstanceId: COORDINATOR_ID,
        challengeNonce: Buffer.alloc(32, connectionCount).toString("base64url"),
      },
    });
    socket.send(JSON.stringify(challenge));

    socket.on("message", (data, isBinary) => {
      if (isBinary) return;
      const message = parseRuntimeLinkClientMessage(
        JSON.parse(data.toString()) as unknown,
      );
      if (message.type === "runtime.link.authenticate.v1") {
        authenticateCount += 1;
        verifyClientProof(message);
        const proofContext = {
          challengeMessageId: challenge.messageId,
          authenticateMessageId: message.messageId,
          coordinatorInstanceId: COORDINATOR_ID,
          challengeNonce: challenge.payload.challengeNonce,
          clientNonce: message.payload.clientNonce,
          botId: BOT_ID,
          runtimeInstanceId: RUNTIME_ID,
          keyId: KEY_ID,
        };
        const accepted = runtimeLinkAcceptedV1Schema.parse({
          schemaVersion: "1.0",
          messageId: uuid(30 + authenticateCount),
          timestamp: new Date().toISOString(),
          type: "runtime.link.accepted.v1",
          payload: {
            challengeMessageId: challenge.messageId,
            authenticateMessageId: message.messageId,
            coordinatorInstanceId: COORDINATOR_ID,
            botId: BOT_ID,
            runtimeInstanceId: RUNTIME_ID,
            keyId: KEY_ID,
            serverProof: options.forgeServerProof
              ? Buffer.alloc(32, 255).toString("base64url")
              : sign(runtimeLinkServerProofInput(proofContext)),
          },
        });
        socket.send(JSON.stringify(accepted));
        if (!options.forgeServerProof) resolveAuthenticated(socket);
        return;
      }
      if (message.type === "bot.stop.result.v1") {
        stopResults.push(message);
        return;
      }
      if (message.type === "skill.result.v1") {
        skillResults.push(message);
        return;
      }
      receivedTelemetryIds.push(message.messageId);
      if (options.closeBeforeFirstAck && receivedTelemetryIds.length === 1) {
        socket.close(1013, "test_retry");
        return;
      }
      telemetry.push(message);
      if (options.suppressTelemetryAck) return;
      socket.send(
        JSON.stringify(
          runtimeLinkTelemetryAckV1Schema.parse({
            schemaVersion: "1.0",
            messageId: uuid(50 + receivedTelemetryIds.length),
            timestamp: new Date().toISOString(),
            type: "runtime.link.telemetry-ack.v1",
            payload: {
              telemetryMessageId: message.messageId,
              accepted: receivedTelemetryIds.length === 1,
              reason:
                receivedTelemetryIds.length === 1
                  ? "accepted"
                  : "duplicate_message",
            },
          }),
        ),
      );
    });
    socket.once("close", () => sockets.delete(socket));
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test Runtime Link did not expose a TCP address.");
  }
  const value: TestServer = {
    url: `ws://127.0.0.1:${address.port}/v1/runtime-link`,
    server,
    sockets,
    telemetry,
    stopResults,
    skillResults,
    receivedTelemetryIds,
    connectionCount: () => connectionCount,
    authenticated,
    close: async () => {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  servers.push(value);
  return value;
}

function verifyClientProof(message: RuntimeLinkAuthenticateV1): void {
  const expected = sign(
    runtimeLinkClientProofInput({
      challengeMessageId: message.payload.challengeMessageId,
      coordinatorInstanceId: message.payload.coordinatorInstanceId,
      challengeNonce: message.payload.challengeNonce,
      clientNonce: message.payload.clientNonce,
      botId: message.payload.botId,
      runtimeInstanceId: message.payload.runtimeInstanceId,
      keyId: message.payload.keyId,
    }),
  );
  expect(message.payload.clientProof).toBe(expected);
}

function sign(input: string): string {
  const key = createHash("sha256").update(SECRET, "utf8").digest();
  return createHmac("sha256", key).update(input, "utf8").digest("base64url");
}

function heartbeat(messageId: string, sequence: number): BotTelemetryMessageV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    messageId,
    traceId: "trace-runtime-link",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.heartbeat.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: now,
      connectionState: "online",
      uptimeMs: 1_000,
      lastStatusSequence: null,
      currentTaskId: null,
    },
  };
}

function disconnected(
  messageId: string,
  sequence: number,
): BotTelemetryMessageV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    messageId,
    traceId: "trace-runtime-link",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.disconnected.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: now,
      reason: "runtime_error",
      expected: false,
      lastStatusSequence: null,
    },
  };
}

function stopCommand(): StopBotCommandV1 {
  const requestedAt = new Date();
  return stopBotCommandV1Schema.parse({
    schemaVersion: "1.0",
    messageId: "33333333-3333-4333-8333-333333333333",
    traceId: "trace-runtime-stop",
    timestamp: requestedAt.toISOString(),
    source: { service: "coordinator", instanceId: COORDINATOR_ID },
    botId: BOT_ID,
    type: "bot.stop.command.v1",
    payload: {
      commandId: "44444444-4444-4444-8444-444444444444",
      mode: "graceful",
      reason: "Authorized test stop.",
      requestedAt: requestedAt.toISOString(),
      expiresAt: new Date(requestedAt.getTime() + 5_000).toISOString(),
      gracePeriodMs: 1_000,
      expectedRuntimeInstanceId: RUNTIME_ID,
      authorization: {
        decisionId: "55555555-5555-4555-8555-555555555555",
        actorId: "operator-test",
        permission: "bot.stop",
        issuedAt: new Date(requestedAt.getTime() - 1_000).toISOString(),
        expiresAt: new Date(requestedAt.getTime() + 5_000).toISOString(),
      },
    },
  });
}

function stateRequest(
  requestedAt = new Date(),
  lifetimeMs = 5_000,
): RuntimeLinkStateRequestV1 {
  return runtimeLinkStateRequestV1Schema.parse({
    schemaVersion: "1.0",
    messageId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    traceId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    timestamp: requestedAt.toISOString(),
    source: { service: "coordinator", instanceId: COORDINATOR_ID },
    botId: BOT_ID,
    type: "runtime.link.state-request.v1",
    payload: {
      expectedRuntimeInstanceId: RUNTIME_ID,
      afterStatusSequence: 7,
      expiresAt: new Date(requestedAt.getTime() + lifetimeMs).toISOString(),
    },
  });
}

function stopResult(command: StopBotCommandV1): BotStopResultV1 {
  const completedAt = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    messageId: "66666666-6666-4666-8666-666666666666",
    traceId: command.traceId,
    timestamp: completedAt,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.stop.result.v1",
    payload: {
      commandId: command.payload.commandId,
      runtimeInstanceId: RUNTIME_ID,
      outcome: "completed",
      completedAt,
    },
  };
}

function skillInvocation(): SkillInvocationV1 {
  const requestedAt = new Date();
  return skillInvocationV1Schema.parse({
    schemaVersion: "1.0",
    messageId: "77777777-7777-4777-8777-777777777777",
    traceId: "trace-runtime-skill",
    timestamp: requestedAt.toISOString(),
    source: { service: "coordinator", instanceId: COORDINATOR_ID },
    botId: BOT_ID,
    taskId: "task-runtime-skill",
    type: "skill.invoke.v1",
    payload: {
      invocationId: "88888888-8888-4888-8888-888888888888",
      skillId: "movement.goto",
      skillVersion: "1.0.0",
      expiresAt: new Date(requestedAt.getTime() + 5_000).toISOString(),
      input: { target: { x: 1, y: 64, z: 2 } },
      authorization: {
        decisionId: "99999999-9999-4999-8999-999999999999",
        actorId: "coordinator-agent",
        issuedAt: new Date(requestedAt.getTime() - 1_000).toISOString(),
        expiresAt: new Date(requestedAt.getTime() + 5_000).toISOString(),
      },
    },
  });
}

function skillResult(invocation: SkillInvocationV1): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    traceId: invocation.traceId,
    timestamp: invocation.timestamp,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1",
    payload: {
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      completedAt: invocation.timestamp,
      outcome: "completed",
      attempts: 1,
      output: { reached: true },
    },
  };
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

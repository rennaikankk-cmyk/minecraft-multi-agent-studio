import { createHash, createHmac } from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  CONTROL_LINK_SUBPROTOCOL,
  controlLinkAuthenticateV1Schema,
  controlLinkClientProofInput,
  controlLinkGoalRequestV1Schema,
  controlLinkServerProofInput,
  controlLinkStopRequestV1Schema,
  parseControlLinkServerMessage,
  type BotHeartbeatV1,
  type BotStatusV1,
  type ControlLinkChallengeV1,
  type ControlLinkProofContext,
  type ControlLinkServerMessageV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import { BotRegistry, ControlLinkServer } from "../src/index.js";

const NOW = new Date("2026-08-07T10:00:00.000Z");
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-control-test";
const CLIENT_ID = "control-api";
const CONTROL_API_INSTANCE_ID = "control-api-test";
const KEY_ID = "control-key-01";
const SECRET = "control-link-test-secret-000000000000000000000001";
const SECRET_SHA256 = createHash("sha256").update(SECRET, "utf8").digest("hex");
const CHALLENGE_NONCE = Buffer.alloc(32, 3).toString("base64url");
const CLIENT_NONCE = Buffer.alloc(32, 4).toString("base64url");

const logger: AppLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const servers: ControlLinkServer[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.clearAllMocks();
});

describe("Coordinator Control Link server", () => {
  it("mutually authenticates and streams an atomic snapshot then upserts", async () => {
    const { registry, url } = await startServer();
    registry.ingest(statusMessage(1), NOW);
    const { reader } = await authenticate(url);

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.snapshot-begin.v1",
      payload: { baseSequence: 1, botCount: 1 },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.snapshot-item.v1",
      payload: {
        index: 0,
        bot: {
          botId: BOT_ID,
          positionRedacted: false,
          position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
        },
      },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.snapshot-end.v1",
      payload: { baseSequence: 1, botCount: 1 },
    });

    registry.ingest(heartbeatMessage(2), NOW);
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: { streamSequence: 2, bot: { botId: BOT_ID } },
    });
  });

  it("rebuilds trusted stop authorization from the authenticated client", async () => {
    const requestStop = vi.fn(async (request) => ({
      schemaVersion: "1.0" as const,
      messageId: testUuid(910),
      traceId: request.traceId,
      timestamp: NOW.toISOString(),
      source: { service: "bot-runtime" as const, instanceId: RUNTIME_ID },
      botId: request.botId,
      type: "bot.stop.result.v1" as const,
      payload: {
        commandId: request.commandId,
        runtimeInstanceId: RUNTIME_ID,
        outcome: "completed" as const,
        completedAt: NOW.toISOString(),
      },
    }));
    const { registry, url } = await startServer({ stopController: { requestStop } });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);

    const operationId = testUuid(920);
    socket.send(JSON.stringify(stopRequest(operationId, testUuid(921))));
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.stop-response.v1",
      ok: true,
      payload: {
        operationId,
        botId: BOT_ID,
        result: { traceId: operationId, payload: { commandId: operationId } },
      },
    });
    expect(requestStop).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId: operationId,
        traceId: operationId,
        botId: BOT_ID,
        mode: "graceful",
        reason: "dashboard_operator_confirmed",
        gracePeriodMs: 5_000,
        timeoutMs: 15_000,
        authorization: expect.objectContaining({
          decisionId: operationId,
          actorId: "operator-01",
          permissions: new Set(["bot.stop"]),
        }),
      }),
    );
  });

  it("treats renewed authorization timestamps as the same idempotent stop", async () => {
    let release: ((result: any) => void) | undefined;
    const requestStop = vi.fn(
      (request) =>
        new Promise((resolve) => {
          release = resolve as (result: any) => void;
        }).then(() => ({
      schemaVersion: "1.0" as const,
      messageId: testUuid(915),
      traceId: request.traceId,
      timestamp: NOW.toISOString(),
      source: { service: "bot-runtime" as const, instanceId: RUNTIME_ID },
      botId: request.botId,
      type: "bot.stop.result.v1" as const,
      payload: {
        commandId: request.commandId,
        runtimeInstanceId: RUNTIME_ID,
        outcome: "completed" as const,
        completedAt: NOW.toISOString(),
      },
        })),
    );
    const { registry, server, url } = await startServer({
      stopController: { requestStop },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(916);
    socket.send(JSON.stringify(stopRequest(operationId, testUuid(917))));
    await vi.waitFor(() => expect(requestStop).toHaveBeenCalledTimes(1));

    const retried = stopRequest(operationId, testUuid(918));
    socket.send(
      JSON.stringify({
        ...retried,
        timestamp: new Date(NOW.getTime() + 1_000).toISOString(),
        payload: {
          ...retried.payload,
          issuedAt: new Date(NOW.getTime() + 1_000).toISOString(),
          expiresAt: new Date(NOW.getTime() + 31_000).toISOString(),
        },
      }),
    );
    await vi.waitFor(() => {
      const pending = (server as unknown as {
        pendingStops: Map<string, { responders: Map<string, unknown> }>;
      }).pendingStops.get(operationId);
      expect(pending?.responders.size).toBe(2);
    });
    release?.({});
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.stop-response.v1",
      ok: true,
      payload: { operationId },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.stop-response.v1",
      ok: true,
      payload: { requestMessageId: testUuid(918), operationId },
    });
    expect(requestStop).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid client proof", async () => {
    const { url } = await startServer();
    const socket = new WebSocket(url, CONTROL_LINK_SUBPROTOCOL);
    sockets.push(socket);
    const reader = new MessageReader(socket);
    const challenge = (await reader.next()) as ControlLinkChallengeV1;
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(
      JSON.stringify(
        controlLinkAuthenticateV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(930),
          timestamp: NOW.toISOString(),
          type: "control.link.authenticate.v1",
          payload: {
            challengeMessageId: challenge.messageId,
            coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
            challengeNonce: challenge.payload.challengeNonce,
            clientNonce: CLIENT_NONCE,
            clientId: CLIENT_ID,
            controlApiInstanceId: CONTROL_API_INSTANCE_ID,
            keyId: KEY_ID,
            clientProof: Buffer.alloc(32, 9).toString("base64url"),
          },
        }),
      ),
    );
    await expect(closed).resolves.toBe(1008);
  });

  it("rejects browser Origin and binary application frames", async () => {
    const { url } = await startServer();
    await expect(rejectedWebSocketStatus(url, "https://untrusted.example")).resolves.toBe(
      403,
    );
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(Buffer.from("{}"));
    await expect(closed).resolves.toBe(1003);
  });

  it("rejects authenticated client frames outside the clock-skew window", async () => {
    const { url } = await startServer();
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send(
      JSON.stringify({
        ...stopRequest(testUuid(932), testUuid(933)),
        timestamp: new Date(NOW.getTime() - 31_000).toISOString(),
      }),
    );
    await expect(closed).resolves.toBe(1008);
  });

  it("fails closed before a queued valid stop request can be dispatched", async () => {
    const requestStop = vi.fn(async () => {
      throw new Error("stop_must_not_run");
    });
    const { registry, url } = await startServer({
      stopController: { requestStop },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);

    const closed = new Promise<number>((resolve) => {
      socket.once("close", (code) => resolve(code));
    });
    socket.send("{");
    socket.send(JSON.stringify(stopRequest(testUuid(935), testUuid(936))));

    await expect(closed).resolves.toBe(1008);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestStop).not.toHaveBeenCalled();
  });

  it("bounds sessions and concurrent unique stop operations", async () => {
    let releaseFirst: (() => void) | undefined;
    const requestStop = vi.fn(
      () =>
        new Promise<never>((_resolve, reject) => {
          releaseFirst = () => reject(new Error("released"));
        }),
    );
    const { registry, url } = await startServer({
      maxSessions: 1,
      maxPendingStops: 1,
      stopController: { requestStop },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    await expect(rejectedWebSocketStatus(url)).resolves.toBe(503);

    socket.send(JSON.stringify(stopRequest(testUuid(940), testUuid(941))));
    await vi.waitFor(() => expect(requestStop).toHaveBeenCalledTimes(1));
    socket.send(JSON.stringify(stopRequest(testUuid(942), testUuid(943))));
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.stop-response.v1",
      ok: false,
      payload: { errorCode: "CONTROL_LINK_BACKPRESSURE" },
    });
    releaseFirst?.();
  });

  it("executes an authenticated goal through the guarded planner", async () => {
    const planAndDispatch = vi.fn(async (request: any) => ({
      action: "noop" as const,
      reasonCode: "NO_SAFE_SKILL",
      ai: {
        requestId: request.requestId,
        botId: request.botId,
        priority: 30,
        value: { content: "{}", model: "local-test", usage: {} },
        attempts: 1,
        enqueuedAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        queueTimeMs: 2,
        executionTimeMs: 98,
        totalTimeMs: 100,
      },
    }));
    const { url } = await startServer({ goalPlanner: { planAndDispatch } });
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(980);
    const goalMessage = controlLinkGoalRequestV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(981),
          timestamp: NOW.toISOString(),
          type: "control.link.goal-request.v1",
          payload: {
            coordinatorInstanceId: "coordinator-test",
            clientId: CLIENT_ID,
            controlApiInstanceId: CONTROL_API_INSTANCE_ID,
            operationId,
            taskId: operationId,
            botId: BOT_ID,
            actorId: "operator-01",
            operatorGoal: "采集附近的木材",
            timeoutMs: 30_000,
            issuedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 35_000).toISOString(),
          },
        });
    socket.send(JSON.stringify(goalMessage));

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: true,
      payload: {
        operationId,
        botId: BOT_ID,
        result: {
          action: "noop",
          reasonCode: "NO_SAFE_SKILL",
          ai: { queueTimeMs: 2, executionTimeMs: 98, totalTimeMs: 100 },
        },
      },
    });
    expect(planAndDispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: operationId,
        taskId: operationId,
        botId: BOT_ID,
        operatorGoal: "采集附近的木材",
      }),
    );

    socket.send(JSON.stringify({ ...goalMessage, messageId: testUuid(982) }));
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: true,
      payload: {
        requestMessageId: testUuid(982),
        operationId,
        result: { action: "noop", reasonCode: "NO_SAFE_SKILL" },
      },
    });
    expect(planAndDispatch).toHaveBeenCalledTimes(1);

    socket.send(JSON.stringify({
      ...goalMessage,
      messageId: testUuid(984),
      timestamp: new Date(NOW.getTime() + 1_000).toISOString(),
      payload: {
        ...goalMessage.payload,
        issuedAt: new Date(NOW.getTime() + 1_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 36_000).toISOString(),
      },
    }));
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: true,
      payload: {
        requestMessageId: testUuid(984),
        operationId,
        result: { action: "noop", reasonCode: "NO_SAFE_SKILL" },
      },
    });
    expect(planAndDispatch).toHaveBeenCalledTimes(1);

    socket.send(JSON.stringify({
      ...goalMessage,
      messageId: testUuid(983),
      payload: { ...goalMessage.payload, operatorGoal: "冲突目标" },
    }));
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: false,
      payload: { requestMessageId: testUuid(983), errorCode: "GOAL_ID_CONFLICT" },
    });
    expect(planAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("aborts an active goal when the Coordinator stops", async () => {
    let receivedSignal: AbortSignal | undefined;
    const planAndDispatch = vi.fn(
      async (request: any) =>
        new Promise((_resolve, reject) => {
          receivedSignal = request.signal;
          request.signal.addEventListener(
            "abort",
            () => reject(request.signal.reason),
            { once: true },
          );
        }),
    );
    const { server, url } = await startServer({
      goalPlanner: { planAndDispatch },
    });
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    socket.send(
      JSON.stringify(
        controlLinkGoalRequestV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(991),
          timestamp: NOW.toISOString(),
          type: "control.link.goal-request.v1",
          payload: {
            coordinatorInstanceId: "coordinator-test",
            clientId: CLIENT_ID,
            controlApiInstanceId: CONTROL_API_INSTANCE_ID,
            operationId: testUuid(990),
            taskId: testUuid(990),
            botId: BOT_ID,
            actorId: "operator-01",
            operatorGoal: "等待关闭测试",
            timeoutMs: 30_000,
            issuedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 35_000).toISOString(),
          },
        }),
      ),
    );
    await vi.waitFor(() => expect(receivedSignal).toBeDefined());

    await server.stop();

    expect(receivedSignal?.aborted).toBe(true);
  });
});

async function startServer(
  overrides: Partial<{
    maxSessions: number;
    maxPendingStops: number;
    stopController: { requestStop: (...args: any[]) => Promise<any> };
    goalPlanner: { planAndDispatch: (...args: any[]) => Promise<any> };
  }> = {},
): Promise<{ registry: BotRegistry; server: ControlLinkServer; url: string }> {
  const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
  const stopController = overrides.stopController ?? {
    requestStop: vi.fn(async () => {
      throw new Error("stop_not_expected");
    }),
  };
  const server = new ControlLinkServer({
    host: "127.0.0.1",
    port: 0,
    instanceId: "coordinator-test",
    clients: [
      {
        clientId: CLIENT_ID,
        keyId: KEY_ID,
        secretSha256: SECRET_SHA256,
        capabilities: overrides.goalPlanner
          ? ["bot.read", "bot.stop", "goal.submit"]
          : ["bot.read", "bot.stop"],
      },
    ],
    registry,
    stopController,
    ...(overrides.goalPlanner === undefined
      ? {}
      : { goalPlanner: overrides.goalPlanner }),
    logger,
    now: () => NOW,
    randomId: uuidSequence(1),
    randomNonce: () => CHALLENGE_NONCE,
    ...(overrides.maxSessions === undefined
      ? {}
      : { maxSessions: overrides.maxSessions }),
    ...(overrides.maxPendingStops === undefined
      ? {}
      : { maxPendingStops: overrides.maxPendingStops }),
  });
  servers.push(server);
  const address = await server.start();
  return {
    registry,
    server,
    url: `ws://127.0.0.1:${address.port}/v1/control-link`,
  };
}

async function authenticate(
  url: string,
): Promise<{ socket: WebSocket; reader: MessageReader }> {
  const socket = new WebSocket(url, CONTROL_LINK_SUBPROTOCOL);
  sockets.push(socket);
  const reader = new MessageReader(socket);
  const challenge = (await reader.next()) as ControlLinkChallengeV1;
  const context: ControlLinkProofContext = {
    challengeMessageId: challenge.messageId,
    coordinatorInstanceId: challenge.payload.coordinatorInstanceId,
    challengeNonce: challenge.payload.challengeNonce,
    clientNonce: CLIENT_NONCE,
    clientId: CLIENT_ID,
    controlApiInstanceId: CONTROL_API_INSTANCE_ID,
    keyId: KEY_ID,
  };
  const authenticateMessageId = testUuid(300);
  socket.send(
    JSON.stringify(
      controlLinkAuthenticateV1Schema.parse({
        schemaVersion: "1.0",
        messageId: authenticateMessageId,
        timestamp: NOW.toISOString(),
        type: "control.link.authenticate.v1",
        payload: {
          ...context,
          clientProof: hmac(controlLinkClientProofInput(context)),
        },
      }),
    ),
  );
  const accepted = await reader.next();
  expect(accepted).toMatchObject({
    type: "control.link.accepted.v1",
    payload: {
      authenticateMessageId,
      clientId: CLIENT_ID,
      controlApiInstanceId: CONTROL_API_INSTANCE_ID,
      keyId: KEY_ID,
    },
  });
  if (accepted.type !== "control.link.accepted.v1") {
    throw new Error("Expected Control Link accepted message.");
  }
  expect(accepted.payload.serverProof).toBe(
    hmac(controlLinkServerProofInput({ ...context, authenticateMessageId })),
  );
  return { socket, reader };
}

async function readSnapshot(reader: MessageReader): Promise<void> {
  const begin = await reader.next();
  if (begin.type !== "control.link.snapshot-begin.v1") {
    throw new Error("Expected snapshot begin.");
  }
  for (let index = 0; index < begin.payload.botCount; index += 1) {
    const item = await reader.next();
    if (item.type !== "control.link.snapshot-item.v1") {
      throw new Error("Expected snapshot item.");
    }
  }
  const end = await reader.next();
  if (end.type !== "control.link.snapshot-end.v1") {
    throw new Error("Expected snapshot end.");
  }
}

class MessageReader {
  private readonly queue: ControlLinkServerMessageV1[] = [];
  private readonly waiting: Array<{
    resolve: (message: ControlLinkServerMessageV1) => void;
    reject: (cause: unknown) => void;
  }> = [];

  constructor(socket: WebSocket) {
    socket.on("message", (data) => {
      try {
        const message = parseControlLinkServerMessage(
          JSON.parse(data.toString()) as unknown,
        );
        const waiter = this.waiting.shift();
        if (waiter) waiter.resolve(message);
        else this.queue.push(message);
      } catch (cause) {
        const waiter = this.waiting.shift();
        if (waiter) waiter.reject(cause);
      }
    });
  }

  next(): Promise<ControlLinkServerMessageV1> {
    const message = this.queue.shift();
    if (message) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      this.waiting.push({ resolve, reject });
    });
  }
}

function statusMessage(sequence: number): BotStatusV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(400 + sequence),
    traceId: "trace-control-link",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.status.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
    },
  };
}

function heartbeatMessage(sequence: number): BotHeartbeatV1 {
  return {
    schemaVersion: "1.0",
    messageId: testUuid(500 + sequence),
    traceId: "trace-control-link",
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
      lastStatusSequence: 1,
      currentTaskId: null,
    },
  };
}

function stopRequest(operationId: string, messageId: string) {
  return controlLinkStopRequestV1Schema.parse({
    schemaVersion: "1.0",
    messageId,
    timestamp: NOW.toISOString(),
    type: "control.link.stop-request.v1",
    payload: {
      coordinatorInstanceId: "coordinator-test",
      clientId: CLIENT_ID,
      controlApiInstanceId: CONTROL_API_INSTANCE_ID,
      operationId,
      botId: BOT_ID,
      actorId: "operator-01",
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
    },
  });
}

function rejectedWebSocketStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, CONTROL_LINK_SUBPROTOCOL, {
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
      reject(new Error("Expected Control Link upgrade rejection."));
    });
  });
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

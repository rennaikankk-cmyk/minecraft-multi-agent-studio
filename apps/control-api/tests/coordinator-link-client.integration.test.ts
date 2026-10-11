import { createHash } from "node:crypto";

import {
  BotRegistry,
  ControlLinkServer,
  durableGoalFingerprint,
  InMemoryStopAuditSink,
  StopController,
  type GoalLifecycleSnapshot,
  type GoalLifecycleStore,
  type StopBotRequest,
} from "@minecraft-studio/coordinator";
import type {
  BotHeartbeatV1,
  BotStopResultV1,
  ControlLinkStopRequestV1,
  ControlLinkStopResponseV1,
  ControlLinkTaskDetailResponseV1,
  ControlLinkTaskListResponseV1,
  StopBotCommandV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  CoordinatorLinkClient,
  type CoordinatorLinkClientConfig,
  type ControlApiLogger,
} from "../src/index.js";

const NOW = new Date("2026-08-07T12:00:00.000Z");
const SECRET = "control-link-integration-secret-000000000000000001";
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-control-link-test";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";

const logger: ControlApiLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const clients: CoordinatorLinkClient[] = [];
const servers: ControlLinkServer[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(servers.splice(0).map((server) => server.stop()));
  vi.clearAllMocks();
});

describe("Control API Coordinator Link client", () => {
  it("round-trips strict task history reads over an authenticated session", async () => {
    const client = new CoordinatorLinkClient({
      config: {
        url: "ws://127.0.0.1:3221/v1/control-link",
        clientId: "control-api-test",
        keyId: "control-key-test",
        secret: SECRET,
        handshakeTimeoutMs: 2_000,
        livenessTimeoutMs: 75_000,
        stopTimeoutMs: 3_000,
        reconnect: { baseDelayMs: 10, maxDelayMs: 50 },
        maxPendingStops: 8,
        maxPendingGoals: 8,
        maxSocketBufferedBytes: 256 * 1_024,
      },
      instanceId: "control-api-task-test",
      logger,
      now: () => NOW,
      randomId: uuidSequence(),
    });
    const sent: string[] = [];
    const internals = client as unknown as {
      ready: boolean;
      authenticated: boolean;
      coordinatorInstanceId: string | null;
      socket: { readyState: number; bufferedAmount: number; send(value: string): void } | null;
      pendingTaskLists: Map<string, { message: { messageId: string } }>;
      pendingTaskDetails: Map<string, { message: { messageId: string } }>;
      handleTaskListResponse(message: ControlLinkTaskListResponseV1): void;
      handleTaskDetailResponse(message: ControlLinkTaskDetailResponseV1): void;
    };
    internals.ready = true;
    internals.authenticated = true;
    internals.coordinatorInstanceId = "coordinator-task-test";
    internals.socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      send: (value) => sent.push(value),
    };

    const listOperationId = "14141414-1414-4414-8414-141414141414";
    const list = client.listTaskHistory({
      operationId: listOperationId,
      actorId: "task-reader-01",
      query: { limit: 25, cursor: null, status: null, botId: null },
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10_000),
    });
    const listMessage = internals.pendingTaskLists.get(listOperationId)?.message;
    if (!listMessage) throw new Error("task_list_request_missing");
    const summary = publicTaskSummary(listOperationId);
    internals.handleTaskListResponse({
      schemaVersion: "1.0",
      messageId: "15151515-1515-4515-8515-151515151515",
      timestamp: NOW.toISOString(),
      type: "control.link.task-list-response.v1",
      ok: true,
      payload: {
        coordinatorInstanceId: "coordinator-task-test",
        requestMessageId: listMessage.messageId,
        operationId: listOperationId,
        result: { generatedAt: NOW.toISOString(), tasks: [summary], nextCursor: null },
      },
    });
    await expect(list).resolves.toEqual({
      generatedAt: NOW.toISOString(),
      tasks: [summary],
      nextCursor: null,
    });

    const detailOperationId = "16161616-1616-4616-8616-161616161616";
    const detail = client.getTaskDetail({
      operationId: detailOperationId,
      actorId: "task-reader-01",
      taskId: listOperationId,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10_000),
    });
    const detailMessage = internals.pendingTaskDetails.get(detailOperationId)?.message;
    if (!detailMessage) throw new Error("task_detail_request_missing");
    internals.handleTaskDetailResponse({
      schemaVersion: "1.0",
      messageId: "17171717-1717-4717-8717-171717171717",
      timestamp: NOW.toISOString(),
      type: "control.link.task-detail-response.v1",
      ok: true,
      payload: {
        coordinatorInstanceId: "coordinator-task-test",
        requestMessageId: detailMessage.messageId,
        operationId: detailOperationId,
        result: {
          generatedAt: NOW.toISOString(),
          task: { ...summary, operatorGoal: "采集附近的木材" },
        },
      },
    });
    await expect(detail).resolves.toMatchObject({
      task: { taskId: listOperationId, operatorGoal: "采集附近的木材" },
    });

    const boundOperationId = "18181818-1818-4818-8818-181818181818";
    const boundDetail = client.getTaskDetail({
      operationId: boundOperationId,
      actorId: "task-reader-01",
      taskId: listOperationId,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 10_000),
    });
    const boundMessage = internals.pendingTaskDetails.get(boundOperationId)?.message;
    if (!boundMessage) throw new Error("bound_task_detail_request_missing");
    const response = {
      schemaVersion: "1.0",
      messageId: "19191919-1919-4919-8919-191919191919",
      timestamp: NOW.toISOString(),
      type: "control.link.task-detail-response.v1",
      ok: true,
      payload: {
        coordinatorInstanceId: "coordinator-task-test",
        requestMessageId: boundMessage.messageId,
        operationId: boundOperationId,
        result: {
          generatedAt: NOW.toISOString(),
          task: { ...summary, operatorGoal: "采集附近的木材" },
        },
      },
    } as const;
    expect(() =>
      internals.handleTaskDetailResponse({
        ...response,
        payload: {
          ...response.payload,
          result: {
            ...response.payload.result,
            task: {
              ...response.payload.result.task,
              taskId: "20202020-2020-4020-8020-202020202020",
            },
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "COORDINATOR_LINK_IDENTITY_MISMATCH" }),
    );
    internals.handleTaskDetailResponse(response);
    await expect(boundDetail).resolves.toMatchObject({
      task: { taskId: listOperationId },
    });
    expect(sent.map((value) => JSON.parse(value).type)).toEqual([
      "control.link.task-list-request.v1",
      "control.link.task-detail-request.v1",
      "control.link.task-detail-request.v1",
    ]);
  });

  it("authenticates, mirrors authoritative state, confirms a stop, and clears on disconnect", async () => {
    const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
    registry.ingest(heartbeat(1), NOW);
    const sendStopCommand = vi.fn(
      async (command: StopBotCommandV1): Promise<BotStopResultV1> => ({
        schemaVersion: "1.0",
        messageId: "55555555-5555-4555-8555-555555555555",
        traceId: command.traceId,
        timestamp: NOW.toISOString(),
        source: { service: "bot-runtime", instanceId: RUNTIME_ID },
        botId: command.botId,
        type: "bot.stop.result.v1",
        payload: {
          commandId: command.payload.commandId,
          runtimeInstanceId: RUNTIME_ID,
          outcome: "completed",
          completedAt: NOW.toISOString(),
        },
      }),
    );
    const stopController = new StopController({
      instanceId: "coordinator-control-test",
      registry,
      transport: { sendStopCommand },
      auditSink: new InMemoryStopAuditSink(),
      now: () => NOW,
    });
    const server = new ControlLinkServer({
      host: "127.0.0.1",
      port: 0,
      instanceId: "coordinator-control-test",
      clients: [
        {
          clientId: "control-api-test",
          keyId: "control-key-test",
          secretSha256: createHash("sha256")
            .update(SECRET, "utf8")
            .digest("hex"),
          capabilities: ["bot.read", "bot.stop"],
        },
      ],
      registry,
      stopController,
      logger,
      now: () => NOW,
    });
    servers.push(server);
    const address = await server.start();
    const client = new CoordinatorLinkClient({
      config: {
        url: `ws://127.0.0.1:${address.port}/v1/control-link`,
        clientId: "control-api-test",
        keyId: "control-key-test",
        secret: SECRET,
        handshakeTimeoutMs: 2_000,
        livenessTimeoutMs: 75_000,
        stopTimeoutMs: 3_000,
        reconnect: { baseDelayMs: 10, maxDelayMs: 50 },
        maxPendingStops: 8,
        maxPendingGoals: 8,
        maxSocketBufferedBytes: 256 * 1_024,
      },
      instanceId: "control-api-test-instance",
      logger,
      now: () => NOW,
      random: () => 0.5,
    });
    clients.push(client);

    await client.start();
    expect(client.isReady()).toBe(true);
    expect(client.list(NOW)).toEqual([
      expect.objectContaining({ botId: BOT_ID, connectionState: "online" }),
    ]);

    const result = await client.requestStop({
      commandId: OPERATION_ID,
      traceId: OPERATION_ID,
      botId: BOT_ID,
      mode: "graceful",
      reason: "dashboard_operator_confirmed",
      gracePeriodMs: 5_000,
      timeoutMs: 15_000,
      authorization: {
        decisionId: OPERATION_ID,
        actorId: "operator-01",
        permissions: new Set(["bot.stop"]),
        issuedAt: NOW,
        expiresAt: new Date(NOW.getTime() + 30_000),
      },
    });
    expect(result.payload.outcome).toBe("completed");
    expect(sendStopCommand).toHaveBeenCalledTimes(1);
    await waitFor(() => client.get(BOT_ID, NOW)?.connectionState === "offline");

    await server.stop();
    await waitFor(() => !client.isReady());
    expect(() => client.list(NOW)).toThrowError(
      expect.objectContaining({ code: "COORDINATOR_LINK_UNAVAILABLE" }),
    );
  });

  it("submits one authenticated goal and reuses an identical pending operation", async () => {
    const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
    // Round 6.6：goal 提交要求 bot goal-ready（online+status+catalog）。
    registry.ingest({
      schemaVersion: "1.0", messageId: crypto.randomUUID(),
      traceId: "trace-goal-test", timestamp: NOW.toISOString(),
      source: { service: "bot-runtime", instanceId: "runtime-goal-test" },
      botId: "worker-01", type: "bot.status.v1",
      payload: {
        serverProfileId: "isolated-test", runtimeInstanceId: "runtime-goal-test",
        sequence: 1, observedAt: NOW.toISOString(), connectionState: "online",
        health: { current: 20, maximum: 20 }, food: { level: 20, saturation: 5 },
        armorPoints: 0, position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
        latencyMs: 10, currentTask: null,
      },
    });
    registry.ingest({
      schemaVersion: "1.0", messageId: crypto.randomUUID(),
      traceId: "trace-goal-test", timestamp: NOW.toISOString(),
      source: { service: "bot-runtime", instanceId: "runtime-goal-test" },
      botId: "worker-01", type: "bot.skill-catalog.v1",
      payload: {
        serverProfileId: "isolated-test", runtimeInstanceId: "runtime-goal-test",
        sequence: 2, observedAt: NOW.toISOString(),
        minecraftVersion: "1.21.11", protocolVersion: 774,
        skills: [{
          skillId: "movement.goto", skillVersion: "1.0.0", availability: "available",
          verification: "unverified", inputSchema: { type: "object", additionalProperties: false },
          timeoutMs: 30_000, idempotent: true, selectedVariantId: "portable", unavailableReasons: [],
        }],
      },
    });
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
    const server = new ControlLinkServer({
      host: "127.0.0.1",
      port: 0,
      instanceId: "coordinator-goal-test",
      clients: [{
        clientId: "control-api-test",
        keyId: "control-key-test",
        secretSha256: createHash("sha256")
          .update(SECRET, "utf8")
          .digest("hex"),
        capabilities: ["bot.read", "bot.stop", "goal.submit"],
      }],
      registry,
      stopController: {
        requestStop: vi.fn(async () => {
          throw new Error("stop_not_expected");
        }),
      },
      goalPlanner: { planAndDispatch },
      goalStore: inMemoryGoalStore(),
      logger,
      now: () => NOW,
    });
    servers.push(server);
    const address = await server.start();
    const client = new CoordinatorLinkClient({
      config: {
        url: `ws://127.0.0.1:${address.port}/v1/control-link`,
        clientId: "control-api-test",
        keyId: "control-key-test",
        secret: SECRET,
        handshakeTimeoutMs: 2_000,
        livenessTimeoutMs: 75_000,
        stopTimeoutMs: 3_000,
        reconnect: { baseDelayMs: 10, maxDelayMs: 50 },
        maxPendingStops: 8,
        maxPendingGoals: 8,
        maxSocketBufferedBytes: 256 * 1_024,
      },
      instanceId: "control-api-goal-test",
      logger,
      now: () => NOW,
      random: () => 0.5,
    });
    clients.push(client);
    await client.start();

    const request = {
      operationId: OPERATION_ID,
      taskId: OPERATION_ID,
      botId: BOT_ID,
      actorId: "operator-01",
      operatorGoal: "采集附近的木材",
      timeoutMs: 60_000,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 65_000),
    };
    const first = client.submitGoal(request);
    const duplicate = client.submitGoal({
      ...request,
      issuedAt: new Date(NOW.getTime() + 1_000),
      expiresAt: new Date(NOW.getTime() + 66_000),
    });

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      action: "noop",
      botId: BOT_ID,
      taskId: OPERATION_ID,
      reasonCode: "NO_SAFE_SKILL",
      ai: { totalTimeMs: 100 },
    });
    expect(planAndDispatch).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the Coordinator cannot verify its configured secret", async () => {
    const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
    const server = new ControlLinkServer({
      host: "127.0.0.1",
      port: 0,
      instanceId: "coordinator-auth-test",
      clients: [
        {
          clientId: "control-api-test",
          keyId: "control-key-test",
          secretSha256: createHash("sha256")
            .update(SECRET, "utf8")
            .digest("hex"),
          capabilities: ["bot.read", "bot.stop"],
        },
      ],
      registry,
      stopController: {
        requestStop: vi.fn(async () => {
          throw new Error("stop_not_expected");
        }),
      },
      logger,
      now: () => NOW,
    });
    servers.push(server);
    const address = await server.start();
    const client = new CoordinatorLinkClient({
      config: {
        url: `ws://127.0.0.1:${address.port}/v1/control-link`,
        clientId: "control-api-test",
        keyId: "control-key-test",
        secret: "different-control-link-secret-000000000000000001",
        handshakeTimeoutMs: 2_000,
        livenessTimeoutMs: 75_000,
        stopTimeoutMs: 3_000,
        reconnect: { baseDelayMs: 10, maxDelayMs: 50 },
        maxPendingStops: 8,
        maxPendingGoals: 8,
        maxSocketBufferedBytes: 256 * 1_024,
      },
      instanceId: "control-api-auth-test",
      logger,
      now: () => NOW,
    });
    clients.push(client);

    await expect(client.start()).rejects.toMatchObject({
      code: "COORDINATOR_LINK_AUTH_FAILED",
    });
    expect(client.isReady()).toBe(false);
  });

  it("invalidates the mirror before closing a sequence-invalid socket", async () => {
    const { client, server } = await startLinkPair({
      coordinatorInstanceId: "coordinator-sequence-test",
    });
    const clientSocket = (
      client as unknown as { socket: WebSocket | null }
    ).socket;
    if (!clientSocket) throw new Error("client_socket_missing");
    let socketClosed = false;
    clientSocket.once("close", () => {
      socketClosed = true;
    });
    let observation:
      | { socketClosed: boolean; ready: boolean; listUnavailable: boolean }
      | undefined;
    const unavailable = new Promise<void>((resolve) => {
      client.subscribeAvailability((ready) => {
        if (ready) return;
        let listUnavailable = false;
        try {
          client.list(NOW);
        } catch {
          listUnavailable = true;
        }
        observation = {
          socketClosed,
          ready: client.isReady(),
          listUnavailable,
        };
        resolve();
      });
    });
    const session = [
      ...(
        server as unknown as {
          activeSessions: Map<string, { socket: WebSocket }>;
        }
      ).activeSessions.values(),
    ][0];
    const bot = client.list(NOW)[0];
    if (!session || !bot) throw new Error("control_session_missing");

    session.socket.send(
      JSON.stringify({
        schemaVersion: "1.0",
        messageId: "66666666-6666-4666-8666-666666666666",
        timestamp: NOW.toISOString(),
        type: "control.link.state-upsert.v1",
        payload: {
          coordinatorInstanceId: "coordinator-sequence-test",
          streamSequence: 2,
          bot,
        },
      }),
    );
    session.socket.send(
      JSON.stringify({
        schemaVersion: "1.0",
        messageId: "67676767-6767-4767-8767-676767676767",
        timestamp: NOW.toISOString(),
        type: "control.link.state-upsert.v1",
        payload: {
          coordinatorInstanceId: "coordinator-sequence-test",
          streamSequence: 1,
          bot,
        },
      }),
    );

    await unavailable;
    expect(observation).toEqual({
      socketClosed: false,
      ready: false,
      listUnavailable: true,
    });
    await waitFor(() => client.isReady());
    expect(
      (client as unknown as { permanentlyFailed: boolean }).permanentlyFailed,
    ).toBe(false);
    await client.close();
  });

  it("resynchronizes after a valid frame falls outside the clock-skew window", async () => {
    let coordinatorNow = NOW;
    let clientNow = NOW;
    const { client, server } = await startLinkPair({
      coordinatorInstanceId: "coordinator-clock-resync-test",
      now: () => coordinatorNow,
      clientNow: () => clientNow,
    });
    const unavailable = new Promise<void>((resolve) => {
      client.subscribeAvailability((ready) => {
        if (ready) return;
        coordinatorNow = clientNow;
        resolve();
      });
    });
    const session = [
      ...(
        server as unknown as {
          activeSessions: Map<string, { socket: WebSocket }>;
        }
      ).activeSessions.values(),
    ][0];
    const bot = client.list(NOW)[0];
    if (!session || !bot) throw new Error("control_session_missing");
    clientNow = new Date(NOW.getTime() + 31_000);

    session.socket.send(
      JSON.stringify({
        schemaVersion: "1.0",
        messageId: "68686868-6868-4868-8868-686868686868",
        timestamp: NOW.toISOString(),
        type: "control.link.state-upsert.v1",
        payload: {
          coordinatorInstanceId: "coordinator-clock-resync-test",
          streamSequence: 1,
          bot,
        },
      }),
    );

    await unavailable;
    expect(client.isReady()).toBe(false);
    await waitFor(() => client.isReady());
    expect(
      (client as unknown as { permanentlyFailed: boolean }).permanentlyFailed,
    ).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "control_api_coordinator_link_frame_rejected",
      expect.objectContaining({
        code: "COORDINATOR_LINK_RESYNC_REQUIRED",
        reason: "timestamp_out_of_window",
      }),
    );
    await client.close();
  });

  it("rejects queued snapshot frames after a handshake timeout and reconnects", async () => {
    const coordinatorInstanceId = "coordinator-handshake-timeout-test";
    const { server, port } = await startCoordinatorServer({
      coordinatorInstanceId,
    });
    type SnapshotBatch = Readonly<{
      session: { socket: WebSocket };
      frames: readonly unknown[];
    }>;
    type SendFrames = (
      session: { socket: WebSocket },
      frames: readonly unknown[],
      callback: (error?: Error) => void,
    ) => void;
    const serverInternals = server as unknown as { sendFrames: SendFrames };
    const sendFrames = serverInternals.sendFrames.bind(server);
    let intercepted = false;
    let heldSnapshot: SnapshotBatch | null = null;
    serverInternals.sendFrames = (session, frames, callback) => {
      if (!intercepted) {
        intercepted = true;
        heldSnapshot = { session, frames };
        return;
      }
      sendFrames(session, frames, callback);
    };

    let client!: CoordinatorLinkClient;
    let clientConfig: CoordinatorLinkClientConfig | null = null;
    let failedSocket: WebSocket | null = null;
    let queuedSnapshotAtTimeout = false;
    let timeoutObservedWhileOpen = false;
    const timeoutLogger: ControlApiLogger = {
      info: vi.fn(),
      warn: vi.fn((event, fields) => {
        if (
          event !== "control_api_coordinator_link_frame_rejected" ||
          fields.reason !== "handshake_timeout" ||
          !heldSnapshot
        ) {
          return;
        }
        if (clientConfig) {
          (clientConfig as { handshakeTimeoutMs: number }).handshakeTimeoutMs =
            2_000;
        }
        failedSocket = (
          client as unknown as { socket: WebSocket | null }
        ).socket;
        timeoutObservedWhileOpen =
          failedSocket?.readyState === WebSocket.OPEN;
        for (const frame of heldSnapshot.frames) {
          heldSnapshot.session.socket.send(JSON.stringify(frame));
        }
        queuedSnapshotAtTimeout = true;
      }),
      error: vi.fn(),
    };
    const created = createLinkClient(port, 75_000, () => NOW, timeoutLogger);
    client = created.client;
    clientConfig = created.config;
    (clientConfig as { handshakeTimeoutMs: number }).handshakeTimeoutMs = 200;

    await client.start();

    expect(intercepted).toBe(true);
    expect(queuedSnapshotAtTimeout).toBe(true);
    expect(timeoutObservedWhileOpen).toBe(true);
    expect(failedSocket).not.toBeNull();
    expect(
      (client as unknown as { socket: WebSocket | null }).socket,
    ).not.toBe(failedSocket);
    expect(client.isReady()).toBe(true);
    expect(
      (client as unknown as { permanentlyFailed: boolean }).permanentlyFailed,
    ).toBe(false);
    expect(timeoutLogger.warn).toHaveBeenCalledWith(
      "control_api_coordinator_link_frame_rejected",
      expect.objectContaining({
        code: "COORDINATOR_LINK_RESYNC_REQUIRED",
        reason: "handshake_timeout",
      }),
    );
    await client.close();
  });

  it("reconnects after the coordinator closes the session with a transient 1012", async () => {
    // 跨包交互面审计候选 2：服务端的瞬态关闭（handshake_timeout /
    // message_time_invalid / session_identity_mismatch）改用 1012——客户端
    // 对非 1008 走退避重连；只有认证/协议策略类 1008 才永久失效。
    const { client, server } = await startLinkPair({
      coordinatorInstanceId: "coordinator-transient-close-test",
    });
    expect(client.isReady()).toBe(true);
    const firstSocket = (client as unknown as { socket: WebSocket | null }).socket;
    expect(firstSocket).not.toBeNull();

    // 真实服务端路径：经 closeSession 以 1012 关闭（与 handshake_timeout
    // 超时路径同一入口），客户端应断开后退避重连。
    const internals = server as unknown as {
      sessions: Set<{ socket: WebSocket; closing: boolean }>;
      closeSession(session: { socket: WebSocket }, code: number, reason: string): void;
    };
    const session = [...internals.sessions].find((candidate) => !candidate.closing);
    expect(session).toBeDefined();
    internals.closeSession(session!, 1012, "handshake_timeout");
    // 断言纯结果（ready 且 socket 已更换）：waitFor 整体重试到重连完成——
    // 断开传播与 10ms 退避重连都是异步，中间态窗口极小，不做竞态断言。
    await vi.waitFor(() => {
      const current = (client as unknown as { socket: WebSocket | null }).socket;
      expect(client.isReady()).toBe(true);
      expect(current).not.toBe(firstSocket);
    });
    expect(
      (client as unknown as { permanentlyFailed: boolean }).permanentlyFailed,
    ).toBe(false);
    await client.close();
  });

  it("invalidates immediately on outbound backpressure and marks every pending stop unsent", async () => {
    const neverCompletes = new Promise<BotStopResultV1>(() => undefined);
    const requestStop = vi.fn(() => neverCompletes);
    const { client, config } = await startLinkPair({
      coordinatorInstanceId: "coordinator-backpressure-test",
      requestStop,
    });
    const first = client.requestStop(stopRequest(OPERATION_ID));
    void first.catch(() => undefined);
    await waitFor(() => requestStop.mock.calls.length === 1);

    (
      config as { maxSocketBufferedBytes: number }
    ).maxSocketBufferedBytes = 1;
    const second = client.requestStop(
      stopRequest("77777777-7777-4777-8777-777777777777"),
    );
    void second.catch(() => undefined);

    expect(client.isReady()).toBe(false);
    expect(() => client.list(NOW)).toThrowError(
      expect.objectContaining({ code: "COORDINATOR_LINK_UNAVAILABLE" }),
    );
    const pending = (
      client as unknown as {
        pendingStops: Map<string, { sent: boolean }>;
      }
    ).pendingStops;
    expect(pending.size).toBe(2);
    expect([...pending.values()].every((item) => !item.sent)).toBe(true);

    await client.close();
    await Promise.allSettled([first, second]);
  });

  it("ignores a retired late stop response while the same operation retry is pending", async () => {
    const coordinatorInstanceId = "coordinator-retired-stop-test";
    const requestStop = vi.fn(
      () => new Promise<BotStopResultV1>(() => undefined),
    );
    const { client, server, config } = await startLinkPair({
      coordinatorInstanceId,
      requestStop,
    });
    (config as { stopTimeoutMs: number }).stopTimeoutMs = 250;
    type PendingStopView = { message: ControlLinkStopRequestV1 };
    const internals = client as unknown as {
      pendingStops: Map<string, PendingStopView>;
      retiredStops: Map<
        string,
        { operationId: string; requestMessageId: string; botId: string }
      >;
      permanentlyFailed: boolean;
      handleStopResponse: (message: ControlLinkStopResponseV1) => void;
    };

    const first = client.requestStop(stopRequest(OPERATION_ID));
    const firstMessage = internals.pendingStops.get(OPERATION_ID)?.message;
    if (!firstMessage) throw new Error("first_stop_request_missing");
    await expect(first).rejects.toMatchObject({ code: "STOP_TIMEOUT" });
    expect(internals.retiredStops.get(firstMessage.messageId)).toMatchObject({
      operationId: OPERATION_ID,
      requestMessageId: firstMessage.messageId,
      botId: BOT_ID,
    });

    const retry = client.requestStop(stopRequest(OPERATION_ID));
    let retrySettled = false;
    void retry.then(
      () => {
        retrySettled = true;
      },
      () => {
        retrySettled = true;
      },
    );
    const retryMessage = internals.pendingStops.get(OPERATION_ID)?.message;
    if (!retryMessage) throw new Error("retry_stop_request_missing");
    expect(retryMessage.messageId).not.toBe(firstMessage.messageId);
    const handleStopResponse = vi.spyOn(internals, "handleStopResponse");
    const session = [
      ...(
        server as unknown as {
          activeSessions: Map<string, { socket: WebSocket }>;
        }
      ).activeSessions.values(),
    ][0];
    if (!session) throw new Error("control_session_missing");

    session.socket.send(
      JSON.stringify(
        successfulStopResponse({
          coordinatorInstanceId,
          requestMessageId: firstMessage.messageId,
          messageId: "12121212-1212-4212-8212-121212121212",
        }),
      ),
    );
    await waitFor(() => handleStopResponse.mock.calls.length === 1);
    expect(client.isReady()).toBe(true);
    expect(internals.permanentlyFailed).toBe(false);
    expect(retrySettled).toBe(false);
    expect(internals.pendingStops.get(OPERATION_ID)?.message.messageId).toBe(
      retryMessage.messageId,
    );

    session.socket.send(
      JSON.stringify(
        successfulStopResponse({
          coordinatorInstanceId,
          requestMessageId: retryMessage.messageId,
          messageId: "13131313-1313-4313-8313-131313131313",
        }),
      ),
    );
    await expect(retry).resolves.toMatchObject({
      payload: { commandId: OPERATION_ID, outcome: "completed" },
    });
    expect(handleStopResponse).toHaveBeenCalledTimes(2);
    expect(client.isReady()).toBe(true);
    expect(internals.permanentlyFailed).toBe(false);
    expect(requestStop).toHaveBeenCalledTimes(1);
    await client.close();
  });

  it("invalidates immediately on a socket error and reconnects", async () => {
    const { client } = await startLinkPair({
      coordinatorInstanceId: "coordinator-socket-error-test",
    });
    const internals = client as unknown as {
      socket: WebSocket | null;
      permanentlyFailed: boolean;
    };
    const failedSocket = internals.socket;
    if (!failedSocket) throw new Error("client_socket_missing");
    let failedSocketClosed = false;
    failedSocket.once("close", () => {
      failedSocketClosed = true;
    });
    let unavailableBeforeClose = false;
    const unavailable = new Promise<void>((resolve) => {
      client.subscribeAvailability((ready) => {
        if (ready) return;
        unavailableBeforeClose = !failedSocketClosed;
        resolve();
      });
    });

    failedSocket.emit("error", new Error("synthetic_transport_failure"));

    await unavailable;
    expect(unavailableBeforeClose).toBe(true);
    expect(client.isReady()).toBe(false);
    expect(() => client.list(NOW)).toThrowError(
      expect.objectContaining({ code: "COORDINATOR_LINK_UNAVAILABLE" }),
    );
    await waitFor(
      () =>
        client.isReady() &&
        (client as unknown as { socket: WebSocket | null }).socket !==
          failedSocket,
    );
    expect(internals.permanentlyFailed).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "control_api_coordinator_link_socket_error",
      expect.objectContaining({ code: "COORDINATOR_LINK_TRANSPORT_ERROR" }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "control_api_coordinator_link_frame_rejected",
      expect.objectContaining({
        code: "COORDINATOR_LINK_RESYNC_REQUIRED",
        reason: "socket_error",
      }),
    );
    await client.close();
  });

  it("expires a silent loopback Coordinator and reconnects without stale availability", async () => {
    const { client } = await startLinkPair({
      coordinatorInstanceId: "coordinator-liveness-test",
      pingIntervalMs: 120_000,
      livenessTimeoutMs: 200,
    });
    const availability: boolean[] = [];
    client.subscribeAvailability((ready) => availability.push(ready));

    await waitFor(() => availability.includes(false));
    await waitFor(() => {
      const unavailableIndex = availability.indexOf(false);
      return (
        unavailableIndex >= 0 &&
        availability.slice(unavailableIndex + 1).includes(true)
      );
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "control_api_coordinator_link_liveness_timeout",
      expect.objectContaining({ code: "COORDINATOR_LINK_UNAVAILABLE" }),
    );
    expect(client.isReady()).toBe(true);
    await client.close();
  });

  it("rejects pending stops from an old Coordinator identity while keeping the new link ready", async () => {
    const firstStop = vi.fn(
      () => new Promise<BotStopResultV1>(() => undefined),
    );
    const firstServer = await startCoordinatorServer({
      coordinatorInstanceId: "coordinator-before-restart",
      requestStop: firstStop,
    });
    const { client, config } = createLinkClient(firstServer.port, 75_000);
    await client.start();
    const pending = client.requestStop(stopRequest(OPERATION_ID));
    const pendingOutcome = pending.catch((cause: unknown) => cause);
    await waitFor(() => firstStop.mock.calls.length === 1);

    await firstServer.server.stop();
    await startCoordinatorServer({
      coordinatorInstanceId: "coordinator-after-restart",
      port: firstServer.port,
    });

    await expect(pendingOutcome).resolves.toMatchObject({
      code: "COORDINATOR_LINK_IDENTITY_CHANGED",
    });
    await waitFor(() => client.isReady());
    expect(client.list(NOW)).toEqual([
      expect.objectContaining({ botId: BOT_ID, connectionState: "online" }),
    ]);
    const replacement = await client.requestStop(
      stopRequest("88888888-8888-4888-8888-888888888888"),
    );
    expect(replacement.payload.outcome).toBe("completed");
    expect(config.url).toBe(
      `ws://127.0.0.1:${firstServer.port}/v1/control-link`,
    );
  });
});

type LinkServerOptions = Readonly<{
  coordinatorInstanceId: string;
  port?: number;
  pingIntervalMs?: number;
  now?: () => Date;
  requestStop?: (request: StopBotRequest) => Promise<BotStopResultV1>;
}>;

async function startCoordinatorServer(
  options: LinkServerOptions,
): Promise<{ server: ControlLinkServer; port: number }> {
  const now = options.now ?? (() => NOW);
  const registry = new BotRegistry({ staleAfterMs: 15_000, now });
  registry.ingest(heartbeat(1), now());
  const server = new ControlLinkServer({
    host: "127.0.0.1",
    port: options.port ?? 0,
    instanceId: options.coordinatorInstanceId,
    clients: [
      {
        clientId: "control-api-test",
        keyId: "control-key-test",
        secretSha256: createHash("sha256")
          .update(SECRET, "utf8")
          .digest("hex"),
        capabilities: ["bot.read", "bot.stop"],
      },
    ],
    registry,
    stopController: {
      requestStop:
        options.requestStop ??
        (async (request) => confirmedStopResult(request)),
    },
    logger,
    now,
    ...(options.pingIntervalMs === undefined
      ? {}
      : { pingIntervalMs: options.pingIntervalMs }),
  });
  servers.push(server);
  const address = await server.start();
  return { server, port: address.port };
}

function createLinkClient(
  port: number,
  livenessTimeoutMs: number,
  now: () => Date = () => NOW,
  clientLogger: ControlApiLogger = logger,
): { client: CoordinatorLinkClient; config: CoordinatorLinkClientConfig } {
  const config: CoordinatorLinkClientConfig = {
    url: `ws://127.0.0.1:${port}/v1/control-link`,
    clientId: "control-api-test",
    keyId: "control-key-test",
    secret: SECRET,
    handshakeTimeoutMs: 2_000,
    livenessTimeoutMs,
    stopTimeoutMs: 10_000,
    reconnect: { baseDelayMs: 10, maxDelayMs: 50 },
    maxPendingStops: 8,
        maxPendingGoals: 8,
    maxSocketBufferedBytes: 256 * 1_024,
  };
  const client = new CoordinatorLinkClient({
    config,
    instanceId: "control-api-test-instance",
    logger: clientLogger,
    now,
    random: () => 0.5,
  });
  clients.push(client);
  return { client, config };
}

async function startLinkPair(
  options: LinkServerOptions &
    Readonly<{ livenessTimeoutMs?: number; clientNow?: () => Date }>,
): Promise<{
  server: ControlLinkServer;
  client: CoordinatorLinkClient;
  config: CoordinatorLinkClientConfig;
}> {
  const { server, port } = await startCoordinatorServer(options);
  const { client, config } = createLinkClient(
    port,
    options.livenessTimeoutMs ?? 75_000,
    options.clientNow,
  );
  await client.start();
  return { server, client, config };
}

function stopRequest(operationId: string): StopBotRequest {
  return {
    commandId: operationId,
    traceId: operationId,
    botId: BOT_ID,
    mode: "graceful",
    reason: "dashboard_operator_confirmed",
    gracePeriodMs: 5_000,
    timeoutMs: 15_000,
    authorization: {
      decisionId: operationId,
      actorId: "operator-01",
      permissions: new Set(["bot.stop"]),
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 30_000),
    },
  };
}

function inMemoryGoalStore(): GoalLifecycleStore {
  const requests = new Map<
    string,
    Parameters<GoalLifecycleStore["begin"]>[0]
  >();
  const snapshots = new Map<string, GoalLifecycleSnapshot>();
  const snapshot = (
    request: Parameters<GoalLifecycleStore["begin"]>[0],
    status: GoalLifecycleSnapshot["status"],
    result: GoalLifecycleSnapshot["result"],
    errorCode: GoalLifecycleSnapshot["errorCode"],
  ): GoalLifecycleSnapshot => ({
    operationId: request.payload.operationId,
    taskId: request.payload.taskId,
    botId: request.payload.botId,
    fingerprint: durableGoalFingerprint(request),
    title: "Submitted goal",
    status,
    startedAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    result,
    errorCode,
  });
  return {
    initialize: async () => [],
    refresh: async () => [...snapshots.values()],
    begin: async (request) => {
      requests.set(request.payload.taskId, request);
      const running = snapshot(request, "running", null, null);
      snapshots.set(request.payload.operationId, running);
      return {
        kind: "execute",
        lease: {
          taskId: request.payload.taskId,
          leaseOwner: "goal-control-api-test",
          revision: 2,
        },
        snapshot: running,
      };
    },
    recordResult: async (lease, result) => {
      const request = requests.get(lease.taskId);
      if (!request) throw new Error("goal_test_request_missing");
      const status =
        result.action === "noop"
          ? "failed"
          : result.outcome === "completed"
            ? "completed"
            : result.outcome === "cancelled"
              ? "cancelled"
              : result.outcome === "timed_out"
                ? "expired"
                : "failed";
      const terminal = snapshot(request, status, result, null);
      snapshots.set(request.payload.operationId, terminal);
      return terminal;
    },
    recordError: async (lease, errorCode, status) => {
      const request = requests.get(lease.taskId);
      if (!request) throw new Error("goal_test_request_missing");
      const terminal = snapshot(request, status, null, errorCode);
      snapshots.set(request.payload.operationId, terminal);
      return terminal;
    },
  };
}

function confirmedStopResult(request: StopBotRequest): BotStopResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: "99999999-9999-4999-8999-999999999999",
    traceId: request.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: request.botId,
    type: "bot.stop.result.v1",
    payload: {
      commandId: request.commandId,
      runtimeInstanceId: RUNTIME_ID,
      outcome: "completed",
      completedAt: NOW.toISOString(),
    },
  };
}

function successfulStopResponse(options: {
  coordinatorInstanceId: string;
  requestMessageId: string;
  messageId: string;
}): ControlLinkStopResponseV1 {
  return {
    schemaVersion: "1.0",
    messageId: options.messageId,
    timestamp: NOW.toISOString(),
    type: "control.link.stop-response.v1",
    ok: true,
    payload: {
      coordinatorInstanceId: options.coordinatorInstanceId,
      requestMessageId: options.requestMessageId,
      operationId: OPERATION_ID,
      botId: BOT_ID,
      result: confirmedStopResult(stopRequest(OPERATION_ID)),
    },
  };
}

function heartbeat(sequence: number): BotHeartbeatV1 {
  return {
    schemaVersion: "1.0",
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: "control-link-test-trace",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.heartbeat.v1",
    payload: {
      serverProfileId: "isolated-control-link-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      uptimeMs: 1_000,
      lastStatusSequence: null,
      currentTaskId: null,
    },
  };
}

function publicTaskSummary(taskId: string) {
  return {
    taskId,
    taskType: "planner.goal",
    title: "Collect nearby wood",
    status: "completed" as const,
    priority: 50,
    riskLevel: "R1" as const,
    botId: BOT_ID,
    failureReason: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    finishedAt: NOW.toISOString(),
    revision: 2,
  };
}

function uuidSequence(): () => string {
  let value = 20_000;
  return () => `00000000-0000-4000-8000-${(++value).toString(16).padStart(12, "0")}`;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

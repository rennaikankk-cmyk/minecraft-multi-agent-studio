import { createHash, createHmac } from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  CONTROL_LINK_SUBPROTOCOL,
  controlLinkAuthenticateV1Schema,
  controlLinkClientProofInput,
  controlLinkGoalRequestV1Schema,
  controlLinkServerProofInput,
  controlLinkStopRequestV1Schema,
  controlLinkTaskDetailRequestV1Schema,
  controlLinkTaskListRequestV1Schema,
  parseControlLinkServerMessage,
  type BotHeartbeatV1,
  type BotStatusV1,
  type ControlLinkChallengeV1,
  type ControlLinkGoalErrorCode,
  type ControlLinkGoalRequestV1,
  type ControlLinkProofContext,
  type ControlLinkServerMessageV1,
  type GoalDispatchResultV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  BotRegistry,
  ControlLinkServer,
  durableGoalFingerprint,
  GoalLifecycleStoreError,
  LocalPlannerError,
  type GoalLifecycleSnapshot,
  type GoalLifecycleStore,
  type QueuedGoalLifecycleStore,
  type TaskHistoryReader,
} from "../src/index.js";

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
          combat: {
            schemaVersion: "1.0",
            stance: "engaging",
            target: { entityId: 42, kind: "player" },
            latestRefusal: null,
            reflexProbe: {
              status: "denied",
              denial: "NO_PROBE_DATA",
            },
          },
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

  it("serves authorized task history list and detail over Control Link", async () => {
    const taskId = testUuid(905);
    const summary = {
      taskId,
      taskType: "coordinator.goal",
      title: "Submitted goal",
      status: "completed" as const,
      priority: 50,
      riskLevel: "R1" as const,
      botId: BOT_ID,
      failureReason: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      startedAt: NOW.toISOString(),
      finishedAt: NOW.toISOString(),
      revision: 3,
    };
    const listTaskHistory = vi.fn(async () => ({
      generatedAt: NOW.toISOString(),
      tasks: [summary],
      nextCursor: null,
    }));
    const getTaskDetail = vi.fn(async () => ({
      generatedAt: NOW.toISOString(),
      task: { ...summary, operatorGoal: "Collect nearby wood" },
    }));
    const { url } = await startServer({
      taskHistoryReader: { listTaskHistory, getTaskDetail },
    });
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);

    const listOperationId = testUuid(906);
    socket.send(
      JSON.stringify(
        controlLinkTaskListRequestV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(907),
          timestamp: NOW.toISOString(),
          type: "control.link.task-list-request.v1",
          payload: {
            coordinatorInstanceId: "coordinator-test",
            clientId: CLIENT_ID,
            controlApiInstanceId: CONTROL_API_INSTANCE_ID,
            operationId: listOperationId,
            actorId: "operator-01",
            query: { limit: 10, cursor: null, status: null, botId: null },
            issuedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
          },
        }),
      ),
    );
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.task-list-response.v1",
      ok: true,
      payload: {
        operationId: listOperationId,
        result: { tasks: [{ taskId }] },
      },
    });
    expect(listTaskHistory).toHaveBeenCalledWith({
      limit: 10,
      cursor: null,
      status: null,
      botId: null,
    });

    const detailOperationId = testUuid(908);
    socket.send(
      JSON.stringify(
        controlLinkTaskDetailRequestV1Schema.parse({
          schemaVersion: "1.0",
          messageId: testUuid(909),
          timestamp: NOW.toISOString(),
          type: "control.link.task-detail-request.v1",
          payload: {
            coordinatorInstanceId: "coordinator-test",
            clientId: CLIENT_ID,
            controlApiInstanceId: CONTROL_API_INSTANCE_ID,
            operationId: detailOperationId,
            actorId: "operator-01",
            taskId,
            issuedAt: NOW.toISOString(),
            expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
          },
        }),
      ),
    );
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.task-detail-response.v1",
      ok: true,
      payload: {
        operationId: detailOperationId,
        result: { task: { taskId, operatorGoal: "Collect nearby wood" } },
      },
    });
    expect(getTaskDetail).toHaveBeenCalledWith(taskId);
  });

  it("fails task history reads closed when permission or storage is absent", async () => {
    const listTaskHistory = vi.fn(async () => emptyTaskHistoryPage());
    const denied = await startServer({
      taskHistoryReader: {
        listTaskHistory,
        getTaskDetail: async () => null,
      },
      taskReadCapability: false,
    });
    const deniedSession = await authenticate(denied.url);
    await readSnapshot(deniedSession.reader);
    deniedSession.socket.send(
      JSON.stringify(taskListRequest(testUuid(1200), testUuid(1201))),
    );
    await expect(deniedSession.reader.next()).resolves.toMatchObject({
      type: "control.link.task-list-response.v1",
      ok: false,
      payload: {
        operationId: testUuid(1200),
        errorCode: "AUTHORIZATION_REJECTED",
      },
    });
    expect(listTaskHistory).not.toHaveBeenCalled();

    const unavailable = await startServer({ taskReadCapability: true });
    const unavailableSession = await authenticate(unavailable.url);
    await readSnapshot(unavailableSession.reader);
    unavailableSession.socket.send(
      JSON.stringify(taskListRequest(testUuid(1202), testUuid(1203))),
    );
    await expect(unavailableSession.reader.next()).resolves.toMatchObject({
      type: "control.link.task-list-response.v1",
      ok: false,
      payload: {
        operationId: testUuid(1202),
        errorCode: "TASK_HISTORY_UNAVAILABLE",
      },
    });
  });

  it("returns a stable not-found error for an absent task detail", async () => {
    const { url } = await startServer({
      taskHistoryReader: {
        listTaskHistory: async () => emptyTaskHistoryPage(),
        getTaskDetail: async () => null,
      },
    });
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    socket.send(
      JSON.stringify(
        taskDetailRequest(testUuid(1210), testUuid(1211), testUuid(1212)),
      ),
    );

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.task-detail-response.v1",
      ok: false,
      payload: {
        operationId: testUuid(1210),
        errorCode: "TASK_NOT_FOUND",
      },
    });
  });

  it("bounds concurrent task reads even when message IDs are reused", async () => {
    const releases: Array<() => void> = [];
    const listTaskHistory = vi.fn(async () => {
      if (releases.length < 2) {
        await new Promise<void>((resolve) => releases.push(resolve));
      }
      return emptyTaskHistoryPage();
    });
    const { url } = await startServer({
      taskHistoryReader: {
        listTaskHistory,
        getTaskDetail: async () => null,
      },
      maxPendingTaskReads: 2,
    });
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const reusedMessageId = testUuid(1220);

    socket.send(
      JSON.stringify(taskListRequest(testUuid(1221), reusedMessageId)),
    );
    await vi.waitFor(() => expect(listTaskHistory).toHaveBeenCalledTimes(1));
    socket.send(
      JSON.stringify(taskListRequest(testUuid(1222), reusedMessageId)),
    );
    await vi.waitFor(() => expect(listTaskHistory).toHaveBeenCalledTimes(2));
    socket.send(
      JSON.stringify(taskListRequest(testUuid(1223), reusedMessageId)),
    );

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.task-list-response.v1",
      ok: false,
      payload: {
        operationId: testUuid(1223),
        errorCode: "CONTROL_LINK_BACKPRESSURE",
      },
    });
    expect(listTaskHistory).toHaveBeenCalledTimes(2);
    for (const release of releases) release();
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

  it("trims terminal goal history before any still-running goal", async () => {
    const { server } = await startServer();
    const internals = server as unknown as {
      trackedGoals: Map<string, { status: string }>;
      trimTrackedGoals(): void;
    };
    internals.trackedGoals.set("running-goal", { status: "running" });
    for (let index = 0; index < 1_000; index += 1) {
      internals.trackedGoals.set(`terminal-${index}`, { status: "completed" });
    }

    internals.trimTrackedGoals();

    expect(internals.trackedGoals.size).toBe(1_000);
    expect(internals.trackedGoals.has("running-goal")).toBe(true);
    expect(internals.trackedGoals.has("terminal-0")).toBe(false);
  });

  it("executes an authenticated goal through the guarded planner", async () => {
    const lifecycleOrder: string[] = [];
    const baseStore = testGoalStore();
    const begin = vi.fn(async (request: ControlLinkGoalRequestV1) => {
      lifecycleOrder.push("persisted-begin");
      return baseStore.begin(request);
    });
    const recordResult = vi.fn(
      async (...args: Parameters<GoalLifecycleStore["recordResult"]>) => {
        lifecycleOrder.push("persisted-terminal");
        return baseStore.recordResult(...args);
      },
    );
    const planAndDispatch = vi.fn(async (request: any) => {
      lifecycleOrder.push("planner-executed");
      return {
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
      };
    });
    const { url } = await startServer({
      goalPlanner: { planAndDispatch },
      goalStore: { ...baseStore, begin, recordResult },
    });
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
        assignmentLeaseOwner: expect.any(String),
      }),
    );
    expect(lifecycleOrder).toEqual([
      "persisted-begin",
      "planner-executed",
      "persisted-terminal",
    ]);

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

  it("streams queued goal state through completion before acknowledging success", async () => {
    const operationId = testUuid(1100);
    const request = goalRequest(operationId, testUuid(1101));
    const result: GoalDispatchResultV1 = {
      action: "skill_result",
      botId: BOT_ID,
      taskId: operationId,
      reasonCode: "GOAL_COMPLETED",
      skillId: "collect.block",
      skillVersion: "1.0.0",
      outcome: "completed",
      ai: {
        attempts: 1,
        queueTimeMs: 2,
        executionTimeMs: 98,
        totalTimeMs: 100,
      },
    };
    const queued = goalSnapshot(request, "queued");
    const terminal = goalSnapshot(request, "completed", result);
    const queuedGoalStore: QueuedGoalLifecycleStore = {
      submitQueued: vi.fn(async (submittedRequest) => {
        expect(submittedRequest).toEqual(request);
        return queued;
      }),
      waitForQueuedTerminal: vi.fn(async (taskId, signal) => {
        expect(taskId).toBe(operationId);
        expect(signal.aborted).toBe(false);
        return terminal;
      }),
      requestQueuedCancellation: vi.fn(async () => undefined),
    };
    const planAndDispatch = vi.fn(async () => {
      throw new Error("queued_goal_must_not_use_local_planner");
    });
    const { registry, url } = await startServer({
      goalPlanner: { planAndDispatch },
      queuedGoalStore,
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    socket.send(JSON.stringify(request));

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: {
        bot: {
          botId: BOT_ID,
          currentTask: {
            taskId: operationId,
            title: "Submitted goal",
            status: "queued",
            startedAt: null,
          },
        },
      },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: {
        bot: {
          botId: BOT_ID,
          currentTask: {
            taskId: operationId,
            status: "completed",
          },
        },
      },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: true,
      payload: {
        operationId,
        taskId: operationId,
        result: {
          action: "skill_result",
          outcome: "completed",
        },
      },
    });
    expect(queuedGoalStore.submitQueued).toHaveBeenCalledTimes(1);
    expect(queuedGoalStore.waitForQueuedTerminal).toHaveBeenCalledTimes(1);
    expect(queuedGoalStore.requestQueuedCancellation).not.toHaveBeenCalled();
    expect(planAndDispatch).not.toHaveBeenCalled();
  });

  it("requests durable cancellation and returns AI_TIMEOUT for a queued goal timeout", async () => {
    const operationId = testUuid(1110);
    const request = goalRequest(operationId, testUuid(1111), 1_000);
    const queued = goalSnapshot(request, "queued");
    const requestQueuedCancellation = vi.fn(async () => undefined);
    const queuedGoalStore: QueuedGoalLifecycleStore = {
      submitQueued: vi.fn(async () => queued),
      waitForQueuedTerminal: vi.fn(
        async (_taskId, signal) =>
          new Promise<GoalLifecycleSnapshot>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          }),
      ),
      requestQueuedCancellation,
    };
    const { registry, url } = await startServer({
      goalPlanner: { planAndDispatch: vi.fn(async () => undefined) },
      queuedGoalStore,
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    socket.send(JSON.stringify(request));

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: { bot: { currentTask: { taskId: operationId, status: "queued" } } },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: false,
      payload: {
        operationId,
        taskId: operationId,
        errorCode: "AI_TIMEOUT",
      },
    });
    expect(requestQueuedCancellation).toHaveBeenCalledWith(
      operationId,
      "AI_TIMEOUT",
    );
  });

  it("requests durable cancellation when the Coordinator stops a queued goal", async () => {
    const operationId = testUuid(1120);
    const request = goalRequest(operationId, testUuid(1121));
    const queued = goalSnapshot(request, "queued");
    const requestQueuedCancellation = vi.fn(async () => undefined);
    const queuedGoalStore: QueuedGoalLifecycleStore = {
      submitQueued: vi.fn(async () => queued),
      waitForQueuedTerminal: vi.fn(
        async (_taskId, signal) =>
          new Promise<GoalLifecycleSnapshot>((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(signal.reason),
              { once: true },
            );
          }),
      ),
      requestQueuedCancellation,
    };
    const { registry, server, url } = await startServer({
      goalPlanner: { planAndDispatch: vi.fn(async () => undefined) },
      queuedGoalStore,
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    socket.send(JSON.stringify(request));
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: { bot: { currentTask: { taskId: operationId, status: "queued" } } },
    });

    await server.stop();

    expect(requestQueuedCancellation).toHaveBeenCalledWith(
      operationId,
      "CONTROL_LINK_STOPPED",
    );
  });

  it("does not acknowledge success when the terminal result is not durable", async () => {
    const baseStore = testGoalStore();
    const recordResult = vi.fn(async () => {
      throw new GoalLifecycleStoreError(
        "CONTROL_LINK_INTERNAL_ERROR",
        "injected terminal write failure",
      );
    });
    const recordError = vi.fn(async () => {
      throw new GoalLifecycleStoreError(
        "CONTROL_LINK_INTERNAL_ERROR",
        "injected fallback write failure",
      );
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
    const { url } = await startServer({
      goalPlanner: { planAndDispatch },
      goalStore: { ...baseStore, recordResult, recordError },
    });
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(975);
    socket.send(JSON.stringify(controlLinkGoalRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: testUuid(976),
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
    })));

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: false,
      payload: {
        operationId,
        errorCode: "CONTROL_LINK_INTERNAL_ERROR",
      },
    });
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(recordError).toHaveBeenCalledTimes(1);
  });

  it("reports a completed Skill's own counts, including zeros", async () => {
    const planAndDispatch = vi.fn(async () => ({
      action: "skill_result",
      reasonCode: "GOAL_COMPLETED",
      result: {
        payload: {
          skillId: "collect.block",
          skillVersion: "1.0.0",
          outcome: "completed",
          // What a live collect reported for trace 80a6506a: it found nothing.
          // Before the summary field the operator saw the same bare
          // `outcome: "completed"` a full eight-log collect produces.
          output: {
            blockName: "cobblestone",
            targetsFound: 0,
            itemsCollected: 0,
          },
        },
      },
      ai: {
        attempts: 1,
        queueTimeMs: 2,
        executionTimeMs: 55,
        totalTimeMs: 57,
      },
    }));
    const { registry, url } = await startServer({
      goalPlanner: { planAndDispatch },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(987);
    socket.send(JSON.stringify(controlLinkGoalRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: testUuid(988),
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
        operatorGoal: "采集一些圆石",
        timeoutMs: 30_000,
        issuedAt: NOW.toISOString(),
        expiresAt: new Date(NOW.getTime() + 35_000).toISOString(),
      },
    })));

    let response = await reader.next();
    while (response.type !== "control.link.goal-response.v1") {
      response = await reader.next();
    }
    expect(response).toMatchObject({
      ok: true,
      payload: {
        operationId,
        result: {
          action: "skill_result",
          outcome: "completed",
          summary: { targetsFound: 0, itemsCollected: 0 },
        },
      },
    });
    // The allow-list is by name: a block name is not a count, and the goal
    // response must not become wider than the planner's prompt boundary.
    expect(JSON.stringify(response)).not.toContain("cobblestone");
  });

  it("streams the submitted task ID from running through completion", async () => {
    let finishGoal!: (value: any) => void;
    const planAndDispatch = vi.fn(
      (request: any) =>
        new Promise((resolve) => {
          finishGoal = resolve;
        }),
    );
    const { registry, url } = await startServer({
      goalPlanner: { planAndDispatch },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(985);
    const goalMessage = controlLinkGoalRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: testUuid(986),
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

    await vi.waitFor(() => expect(planAndDispatch).toHaveBeenCalledTimes(1));
    const running = await reader.next();
    expect(running).toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: {
        bot: {
          botId: BOT_ID,
          currentTask: {
            taskId: operationId,
            title: "Submitted goal",
            status: "running",
            startedAt: NOW.toISOString(),
          },
        },
      },
    });
    expect(JSON.stringify(running)).not.toContain(goalMessage.payload.operatorGoal);

    finishGoal({
      action: "skill_result",
      reasonCode: "GOAL_COMPLETED",
      result: {
        payload: {
          skillId: "collect.block",
          skillVersion: "1.0.0",
          outcome: "completed",
        },
      },
      ai: {
        attempts: 1,
        queueTimeMs: 2,
        executionTimeMs: 98,
        totalTimeMs: 100,
      },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: {
        bot: {
          botId: BOT_ID,
          currentTask: {
            taskId: operationId,
            status: "completed",
          },
        },
      },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: true,
      payload: {
        operationId,
        taskId: operationId,
        result: { action: "skill_result", outcome: "completed" },
      },
    });

    const laterTaskId = "task-runtime-follow-up";
    registry.ingest(statusMessage(2, {
      taskId: laterTaskId,
      title: "movement.goto",
      status: "running",
      startedAt: NOW.toISOString(),
    }), NOW);
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: {
        bot: {
          currentTask: {
            taskId: laterTaskId,
            title: "movement.goto",
            status: "running",
          },
        },
      },
    });
  });

  it("projects planner timeouts as an expired task before the error response", async () => {
    const planAndDispatch = vi.fn(async () => {
      throw new LocalPlannerError("PLANNER_TIMEOUT", "injected timeout");
    });
    const { registry, url } = await startServer({
      goalPlanner: { planAndDispatch },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(987);
    socket.send(JSON.stringify(controlLinkGoalRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: testUuid(988),
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
    })));

    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: { bot: { currentTask: { taskId: operationId, status: "running" } } },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.state-upsert.v1",
      payload: { bot: { currentTask: { taskId: operationId, status: "expired" } } },
    });
    await expect(reader.next()).resolves.toMatchObject({
      type: "control.link.goal-response.v1",
      ok: false,
      payload: { operationId, taskId: operationId, errorCode: "AI_TIMEOUT" },
    });
  });

  it("logs the originating planner code and step without widening the client error", async () => {
    const planAndDispatch = vi.fn(async () => {
      throw new LocalPlannerError(
        "PLANNER_GOAL_EXECUTION_FAILED",
        "injected step failure",
        { stepIndex: 1, stepSkillId: "craft.item" },
      );
    });
    const { registry, url } = await startServer({
      goalPlanner: { planAndDispatch },
    });
    registry.ingest(statusMessage(1), NOW);
    const { socket, reader } = await authenticate(url);
    await readSnapshot(reader);
    const operationId = testUuid(989);
    socket.send(JSON.stringify(controlLinkGoalRequestV1Schema.parse({
      schemaVersion: "1.0",
      messageId: testUuid(992),
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
    })));

    // The wire keeps the coarse code, so no planner internals leak to the
    // client; the log is where triage learns which failure it actually was.
    let failure: any;
    await vi.waitFor(async () => {
      failure = await reader.next();
      expect(failure).toMatchObject({
        type: "control.link.goal-response.v1",
        ok: false,
        payload: { operationId, errorCode: "PLANNER_REJECTED" },
      });
    });
    expect(JSON.stringify(failure)).not.toContain("craft.item");
    expect(logger.warn).toHaveBeenCalledWith(
      "coordinator_control_link_goal_failed",
      expect.objectContaining({
        code: "PLANNER_REJECTED",
        plannerCode: "PLANNER_GOAL_EXECUTION_FAILED",
        plannerStepIndex: 1,
        plannerStepSkillId: "craft.item",
      }),
    );
  });

  it("aborts an active goal when the Coordinator stops", async () => {
    let receivedSignal: AbortSignal | undefined;
    const baseStore = testGoalStore();
    const recordError = vi.fn(baseStore.recordError);
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
      goalStore: { ...baseStore, recordError },
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
    expect(recordError).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: testUuid(990) }),
      "CONTROL_LINK_STOPPED",
      "cancelled",
    );
  });
});

async function startServer(
  overrides: Partial<{
    maxSessions: number;
    maxPendingStops: number;
    stopController: { requestStop: (...args: any[]) => Promise<any> };
    goalPlanner: { planAndDispatch: (...args: any[]) => Promise<any> };
    goalStore: GoalLifecycleStore;
    queuedGoalStore: QueuedGoalLifecycleStore;
    taskHistoryReader: TaskHistoryReader;
    taskReadCapability: boolean;
    maxPendingTaskReads: number;
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
        capabilities: [
          "bot.read",
          "bot.stop",
          ...(overrides.goalPlanner ? (["goal.submit"] as const) : []),
          ...(overrides.taskReadCapability ?? overrides.taskHistoryReader
            ? (["task.read"] as const)
            : []),
        ],
      },
    ],
    registry,
    stopController,
    ...(overrides.goalPlanner === undefined
      ? {}
      : {
          goalPlanner: overrides.goalPlanner,
          goalStore: overrides.goalStore ?? testGoalStore(),
        }),
    ...(overrides.queuedGoalStore === undefined
      ? {}
      : { queuedGoalStore: overrides.queuedGoalStore }),
    ...(overrides.taskHistoryReader === undefined
      ? {}
      : { taskHistoryReader: overrides.taskHistoryReader }),
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
    ...(overrides.maxPendingTaskReads === undefined
      ? {}
      : { maxPendingTaskReads: overrides.maxPendingTaskReads }),
  });
  servers.push(server);
  const address = await server.start();
  return {
    registry,
    server,
    url: `ws://127.0.0.1:${address.port}/v1/control-link`,
  };
}

function testGoalStore(): GoalLifecycleStore {
  const requests = new Map<string, ControlLinkGoalRequestV1>();
  const states = new Map<string, GoalLifecycleSnapshot>();
  const state = (
    request: ControlLinkGoalRequestV1,
    status: GoalLifecycleSnapshot["status"],
    result: GoalDispatchResultV1 | null,
    errorCode: ControlLinkGoalErrorCode | null,
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
    refresh: async () => [...states.values()],
    begin: async (request) => {
      requests.set(request.payload.taskId, request);
      const snapshot = state(request, "running", null, null);
      states.set(request.payload.operationId, snapshot);
      return {
        kind: "execute",
        lease: {
          taskId: request.payload.taskId,
          leaseOwner: "goal-test-lease",
          revision: 2,
        },
        snapshot,
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
      const snapshot = state(request, status, result, null);
      states.set(request.payload.operationId, snapshot);
      return snapshot;
    },
    recordError: async (lease, errorCode, status) => {
      const request = requests.get(lease.taskId);
      if (!request) throw new Error("goal_test_request_missing");
      const snapshot = state(request, status, null, errorCode);
      states.set(request.payload.operationId, snapshot);
      return snapshot;
    },
  };
}

function goalRequest(
  operationId: string,
  messageId: string,
  timeoutMs = 30_000,
): ControlLinkGoalRequestV1 {
  return controlLinkGoalRequestV1Schema.parse({
    schemaVersion: "1.0",
    messageId,
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
      operatorGoal: "排队目标",
      timeoutMs,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + timeoutMs + 5_000).toISOString(),
    },
  });
}

function goalSnapshot(
  request: ControlLinkGoalRequestV1,
  status: GoalLifecycleSnapshot["status"],
  result: GoalDispatchResultV1 | null = null,
  errorCode: ControlLinkGoalErrorCode | null = null,
): GoalLifecycleSnapshot {
  return {
    operationId: request.payload.operationId,
    taskId: request.payload.taskId,
    botId: request.payload.botId,
    fingerprint: durableGoalFingerprint(request),
    title: "Submitted goal",
    status,
    startedAt: status === "queued" ? null : NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    result,
    errorCode,
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

function statusMessage(
  sequence: number,
  currentTask: BotStatusV1["payload"]["currentTask"] = null,
): BotStatusV1 {
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
      currentTask,
      combat: {
        schemaVersion: "1.0",
        stance: "engaging",
        target: { entityId: 42, kind: "player" },
        latestRefusal: null,
        reflexProbe: {
          status: "denied",
          denial: "NO_PROBE_DATA",
        },
      },
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

function taskListRequest(operationId: string, messageId: string) {
  return controlLinkTaskListRequestV1Schema.parse({
    schemaVersion: "1.0",
    messageId,
    timestamp: NOW.toISOString(),
    type: "control.link.task-list-request.v1",
    payload: {
      coordinatorInstanceId: "coordinator-test",
      clientId: CLIENT_ID,
      controlApiInstanceId: CONTROL_API_INSTANCE_ID,
      operationId,
      actorId: "operator-01",
      query: { limit: 10, cursor: null, status: null, botId: null },
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
    },
  });
}

function taskDetailRequest(
  operationId: string,
  messageId: string,
  taskId: string,
) {
  return controlLinkTaskDetailRequestV1Schema.parse({
    schemaVersion: "1.0",
    messageId,
    timestamp: NOW.toISOString(),
    type: "control.link.task-detail-request.v1",
    payload: {
      coordinatorInstanceId: "coordinator-test",
      clientId: CLIENT_ID,
      controlApiInstanceId: CONTROL_API_INSTANCE_ID,
      operationId,
      actorId: "operator-01",
      taskId,
      issuedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 5_000).toISOString(),
    },
  });
}

function emptyTaskHistoryPage() {
  return {
    generatedAt: NOW.toISOString(),
    tasks: [],
    nextCursor: null,
  };
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

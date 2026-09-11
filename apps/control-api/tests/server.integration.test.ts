import { createHash } from "node:crypto";
import {
  request as createHttpRequest,
  type ClientRequest,
} from "node:http";

import { BotRegistry, type StopController } from "@minecraft-studio/coordinator";
import type { BotStatusV1, BotStopResultV1 } from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  ControlApiServer,
  type ApiPrincipalConfig,
  type BotStateSource,
  type ControlApiLogger,
  type GoalSubmitter,
  TaskHistorySourceError,
  type TaskHistorySource,
} from "../src/index.js";

const READER_TOKEN = "control-api-reader-token-000000000001";
const POSITION_TOKEN = "control-api-position-token-000000001";
const DENIED_TOKEN = "control-api-position-only-token-00000001";
const OPERATOR_TOKEN = "control-api-stop-operator-token-00000001";
const TASK_READER_TOKEN = "control-api-task-reader-token-0000000001";

const principals: ApiPrincipalConfig[] = [
  {
    subject: "reader-01",
    tokenSha256: hash(READER_TOKEN),
    permissions: ["bot.read"],
  },
  {
    subject: "position-reader-01",
    tokenSha256: hash(POSITION_TOKEN),
    permissions: ["bot.read", "bot.position.read"],
  },
  {
    subject: "position-only-01",
    tokenSha256: hash(DENIED_TOKEN),
    permissions: ["bot.position.read"],
  },
  {
    subject: "operator-01",
    tokenSha256: hash(OPERATOR_TOKEN),
    permissions: ["bot.read", "bot.position.read", "bot.stop", "goal.submit"],
  },
  {
    subject: "task-reader-01",
    tokenSha256: hash(TASK_READER_TOKEN),
    permissions: ["task.read"],
  },
];

const logger: ControlApiLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const runningServers: ControlApiServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
  vi.clearAllMocks();
});

describe("Control API HTTP and WebSocket integration", () => {
  it("reads a Minecraft BotID starting with underscore through the real HTTP validator", async () => {
    const { registry, baseUrl } = await startServer();
    registry.ingest({ ...statusMessage(1), botId: "_Miner" }, new Date());
    const response = await authenticatedFetch(`${baseUrl}/v1/bots/_Miner`, READER_TOKEN);
    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).toContain('"botId":"_Miner"');
    const invalid = await authenticatedFetch(`${baseUrl}/v1/bots/_bad-name`, READER_TOKEN);
    expect(invalid.status).toBe(400);
  });

  it("rejects a non-loopback bind at the server boundary", () => {
    expect(
      () =>
        new ControlApiServer({
          host: "0.0.0.0" as "127.0.0.1",
          port: 0,
          registry: new BotRegistry({ staleAfterMs: 30_000 }),
          principals,
          logger,
        }),
    ).toThrowError("Control API only permits an explicit loopback bind.");
  });

  it("authenticates list/detail reads and redacts position without permission", async () => {
    const { registry, baseUrl } = await startServer();
    registry.ingest(statusMessage(1), new Date());

    const unauthorized = await fetch(`${baseUrl}/v1/bots`);
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error.code).toBe("AUTH_REQUIRED");
    const forbidden = await authenticatedFetch(`${baseUrl}/v1/bots`, DENIED_TOKEN);
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("PERMISSION_DENIED");

    const list = await authenticatedFetch(`${baseUrl}/v1/bots`, READER_TOKEN);
    const listBody = await list.json();
    expect(list.status).toBe(200);
    expect(listBody.data.bots).toEqual([
      expect.objectContaining({ botId: "worker-01", connectionState: "online" }),
    ]);
    expect(JSON.stringify(listBody)).not.toContain("serverProfileId");
    expect(JSON.stringify(listBody)).not.toContain("runtimeInstanceId");

    const redacted = await authenticatedFetch(
      `${baseUrl}/v1/bots/worker-01`,
      READER_TOKEN,
    );
    const redactedBody = await redacted.json();
    expect(redactedBody.data.bot).toMatchObject({
      position: null,
      positionRedacted: true,
      minecraftVersion: {
        selection: "auto",
        resolvedVersion: "1.21.8",
        supportLevel: "tested",
      },
      safety: {
        mode: "monitoring",
        activeRisks: [],
        normalTasksPaused: false,
      },
      combat: {
        schemaVersion: "1.0",
        stance: "retreating",
        target: { entityId: 91, kind: "monster" },
        latestRefusal: {
          reasonCode: "HEALTH_BELOW_ENGAGE_FLOOR",
        },
        reflexProbe: {
          status: "denied",
          denial: "P99_ABOVE_BUDGET",
        },
      },
    });
    expect(JSON.stringify(redactedBody)).not.toContain("isolated-test");

    const visible = await authenticatedFetch(
      `${baseUrl}/v1/bots/worker-01`,
      POSITION_TOKEN,
    );
    expect((await visible.json()).data.bot.position).toEqual({
      x: 10,
      y: 64,
      z: -5,
      dimension: "minecraft:overworld",
    });
  });

  it("projects missing runtime combat telemetry as explicit null", async () => {
    const { registry, baseUrl } = await startServer();
    registry.ingest(statusMessage(1, false), new Date());

    const response = await authenticatedFetch(
      `${baseUrl}/v1/bots/worker-01`,
      READER_TOKEN,
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.bot).toHaveProperty("combat", null);
  });

  it("rejects invalid input, unknown bots, and protocol mismatch", async () => {
    const { baseUrl } = await startServer();
    const invalid = await authenticatedFetch(
      `${baseUrl}/v1/bots/%2F`,
      READER_TOKEN,
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_REQUEST");

    const missing = await authenticatedFetch(
      `${baseUrl}/v1/bots/missing-bot`,
      READER_TOKEN,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("BOT_NOT_FOUND");

    const incompatible = await fetch(`${baseUrl}/v1/bots`, {
      headers: {
        Authorization: `Bearer ${READER_TOKEN}`,
        "X-Studio-Schema-Version": "2.0",
      },
    });
    expect(incompatible.status).toBe(400);
    expect((await incompatible.json()).error.code).toBe(
      "UNSUPPORTED_SCHEMA_VERSION",
    );
  });

  it("enforces request rate limits", async () => {
    const { baseUrl } = await startServer({ requestLimitPerMinute: 1 });
    expect((await authenticatedFetch(`${baseUrl}/v1/bots`, READER_TOKEN)).status).toBe(
      200,
    );
    const limited = await authenticatedFetch(`${baseUrl}/v1/bots`, READER_TOKEN);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
  });

  it("sends a snapshot first and then ordered incremental events", async () => {
    const { registry, webSocketUrl } = await startServer();
    registry.ingest(statusMessage(1), new Date());
    const authProtocol = `auth.${Buffer.from(READER_TOKEN).toString("base64url")}`;
    const { webSocket, firstMessage } = await connectWebSocket(webSocketUrl, [
      "minecraft-studio.v1",
      authProtocol,
    ]);

    expect(firstMessage).toMatchObject({
      type: "bot.stream.snapshot.v1",
      payload: { bots: [expect.objectContaining({ botId: "worker-01" })] },
    });
    const eventPromise = nextMessage(webSocket);
    registry.ingest(heartbeatMessage(2), new Date());
    const event = await eventPromise;
    expect(event).toMatchObject({
      type: "bot.stream.event.v1",
      payload: {
        event: "upsert",
        bot: expect.objectContaining({ botId: "worker-01" }),
      },
    });
    expect(event.streamSequence).toBeGreaterThan(firstMessage.streamSequence);
    webSocket.close();
  });

  it("rejects incompatible WebSocket protocols and remains read-only", async () => {
    const { webSocketUrl } = await startServer();
    expect(await rejectedWebSocketStatus(webSocketUrl, ["minecraft-studio.v2"])).toBe(
      426,
    );
    expect(
      await rejectedWebSocketStatus(webSocketUrl, ["minecraft-studio.v1"]),
    ).toBe(401);

    const { webSocket } = await connectWebSocket(
      webSocketUrl,
      ["minecraft-studio.v1"],
      READER_TOKEN,
    );
    const closed = new Promise<number>((resolve) =>
      webSocket.once("close", (code) => resolve(code)),
    );
    webSocket.send(JSON.stringify({ command: "stop" }));
    expect(await closed).toBe(1008);
  });

  it("rejects a browser Origin on the bot stream upgrade while the origin-less proxy still connects", async () => {
    const { webSocketUrl } = await startServer();

    // 浏览器页面（Origin）即便持有有效令牌也必须被拒绝——与 Coordinator
    // runtime-link 同纪律：内部流只允许服务端代理（不发 Origin）。
    const browserOrigin = await rejectedWebSocketResponse(
      webSocketUrl,
      ["minecraft-studio.v1"],
      {
        origin: "http://attacker.example",
        headers: { Authorization: `Bearer ${READER_TOKEN}` },
      },
    );
    expect(browserOrigin.status).toBe(403);
    expect(browserOrigin.body.error.code).toBe("PERMISSION_DENIED");

    // 没有令牌时也必须先被 Origin 闸门挡住，而不是退化成 401。
    const anonymousOrigin = await rejectedWebSocketResponse(
      webSocketUrl,
      ["minecraft-studio.v1"],
      { origin: `http://127.0.0.1:${new URL(webSocketUrl).port}` },
    );
    expect(anonymousOrigin.status).toBe(403);

    // 合法客户端（dashboard 服务端代理，不发 Origin）照常建立连接。
    const { webSocket, firstMessage } = await connectWebSocket(
      webSocketUrl,
      ["minecraft-studio.v1"],
      READER_TOKEN,
    );
    expect(firstMessage).toMatchObject({
      type: "bot.stream.snapshot.v1",
      payload: { bots: [] },
    });
    webSocket.close();
  });

  it("requires stop permission and returns the real confirmed stop result", async () => {
    const requestStop = vi.fn(async (request: Parameters<StopController["requestStop"]>[0]) =>
      stopResult(request),
    );
    const { registry, baseUrl } = await startServer({
      stopController: { requestStop },
    });
    registry.ingest(statusMessage(1), new Date());

    const denied = await stopFetch(baseUrl, READER_TOKEN, testUuid(2_001));
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("PERMISSION_DENIED");

    const commandId = testUuid(2_002);
    const accepted = await stopFetch(baseUrl, OPERATOR_TOKEN, commandId);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data).toEqual({
      botId: "worker-01",
      traceId: commandId,
      commandId,
      outcome: "completed",
      errorCode: null,
    });
    expect(requestStop).toHaveBeenCalledWith(
      expect.objectContaining({
        commandId,
        traceId: commandId,
        botId: "worker-01",
        mode: "graceful",
        authorization: expect.objectContaining({ actorId: "operator-01" }),
      }),
    );
    const authorization = requestStop.mock.calls[0]?.[0].authorization;
    expect(authorization?.permissions.has("bot.stop")).toBe(true);
    expect(logger.info).toHaveBeenCalledWith(
      "control_api_stop_requested",
      expect.objectContaining({ traceId: commandId, botId: "worker-01" }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "control_api_stop_result",
      expect.objectContaining({
        traceId: commandId,
        botId: "worker-01",
        outcome: "completed",
      }),
    );
  });

  it("reports unavailable control instead of fabricating a stop", async () => {
    const { registry, baseUrl } = await startServer();
    registry.ingest(statusMessage(1), new Date());
    const response = await stopFetch(baseUrl, OPERATOR_TOKEN, testUuid(2_003));
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CONTROL_UNAVAILABLE");
  });

  it("requires goal permission and returns only the bounded dispatch summary", async () => {
    const submitGoal = vi.fn<GoalSubmitter["submitGoal"]>(async (request) => ({
      action: "skill_result",
      botId: request.botId,
      taskId: request.taskId,
      reasonCode: "GOAL_ADVANCED",
      skillId: "gather.wood",
      skillVersion: "1.0.0",
      outcome: "completed",
      ai: {
        attempts: 1,
        queueTimeMs: 4,
        executionTimeMs: 120,
        totalTimeMs: 124,
      },
    }));
    const { baseUrl } = await startServer({ goalController: { submitGoal } });
    const requestId = testUuid(2_010);

    const denied = await goalFetch(baseUrl, READER_TOKEN, requestId);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("PERMISSION_DENIED");

    const accepted = await goalFetch(baseUrl, OPERATOR_TOKEN, requestId);
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).data).toEqual({
      action: "skill_result",
      botId: "worker-01",
      taskId: requestId,
      reasonCode: "GOAL_ADVANCED",
      skillId: "gather.wood",
      skillVersion: "1.0.0",
      outcome: "completed",
      ai: {
        attempts: 1,
        queueTimeMs: 4,
        executionTimeMs: 120,
        totalTimeMs: 124,
      },
    });
    expect(submitGoal).toHaveBeenCalledWith(
      expect.objectContaining({
        operationId: requestId,
        taskId: requestId,
        botId: "worker-01",
        actorId: "operator-01",
        operatorGoal: "采集附近的木材",
        timeoutMs: 60_000,
      }),
    );
  });

  it("returns 503 instead of an empty list when the Coordinator mirror is unavailable", async () => {
    const unavailableSource: BotStateSource = {
      isReady: () => false,
      get: () => null,
      list: () => [],
      subscribe: () => () => undefined,
      subscribeAvailability: () => () => undefined,
    };
    const { baseUrl } = await startServer({ stateSource: unavailableSource });
    const response = await authenticatedFetch(
      `${baseUrl}/v1/bots`,
      READER_TOKEN,
    );
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("CONTROL_UNAVAILABLE");
  });

  it("protects task history and returns only strict public projections", async () => {
    const summary = taskSummary(testUuid(2_020));
    const listTaskHistory = vi.fn<TaskHistorySource["listTaskHistory"]>(
      async () => ({
        generatedAt: summary.updatedAt,
        tasks: [summary],
        nextCursor: null,
      }),
    );
    const getTaskDetail = vi.fn<TaskHistorySource["getTaskDetail"]>(async () => ({
      generatedAt: summary.updatedAt,
      task: { ...summary, operatorGoal: "采集附近的木材" },
    }));
    const taskHistorySource: TaskHistorySource = {
      isTaskHistoryReady: () => true,
      listTaskHistory,
      getTaskDetail,
    };
    const { baseUrl } = await startServer({ taskHistorySource });

    const denied = await authenticatedFetch(`${baseUrl}/v1/tasks`, READER_TOKEN);
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.code).toBe("PERMISSION_DENIED");

    const list = await authenticatedFetch(
      `${baseUrl}/v1/tasks?limit=25&status=completed&botId=worker-01`,
      TASK_READER_TOKEN,
    );
    expect(list.status).toBe(200);
    const listBody = await list.json();
    expect(listBody.data.tasks).toEqual([summary]);
    expect(JSON.stringify(listBody)).not.toMatch(/description|operatorGoal|target|result|evidence/u);
    expect(listTaskHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "task-reader-01",
        query: {
          limit: 25,
          cursor: null,
          status: "completed",
          botId: "worker-01",
        },
      }),
    );

    const detail = await authenticatedFetch(
      `${baseUrl}/v1/tasks/${summary.taskId}`,
      TASK_READER_TOKEN,
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.data.task.operatorGoal).toBe("采集附近的木材");
    expect(JSON.stringify(detailBody)).not.toMatch(/target|result|evidence/u);
    expect(getTaskDetail).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "task-reader-01",
        taskId: summary.taskId,
      }),
    );
  });

  it("fails closed when task history is missing, unavailable, or queried invalidly", async () => {
    const withoutSource = await startServer();
    const missing = await authenticatedFetch(
      `${withoutSource.baseUrl}/v1/tasks`,
      TASK_READER_TOKEN,
    );
    expect(missing.status).toBe(503);
    expect((await missing.json()).error.code).toBe("TASK_HISTORY_UNAVAILABLE");

    const taskHistorySource: TaskHistorySource = {
      isTaskHistoryReady: () => true,
      listTaskHistory: async () => {
        throw new TaskHistorySourceError(
          "TASK_HISTORY_UNAVAILABLE",
          "database details must stay private",
        );
      },
      getTaskDetail: async () => {
        throw new TaskHistorySourceError("TASK_NOT_FOUND", "private detail");
      },
    };
    const available = await startServer({ taskHistorySource });
    const unavailable = await authenticatedFetch(
      `${available.baseUrl}/v1/tasks`,
      TASK_READER_TOKEN,
    );
    expect(unavailable.status).toBe(503);
    const unavailableBody = await unavailable.json();
    expect(unavailableBody.error).toEqual({
      code: "TASK_HISTORY_UNAVAILABLE",
      message: "Task history is unavailable.",
    });
    expect(JSON.stringify(unavailableBody)).not.toContain("database details");

    const invalid = await authenticatedFetch(
      `${available.baseUrl}/v1/tasks?limit=25&limit=50`,
      TASK_READER_TOKEN,
    );
    expect(invalid.status).toBe(400);
    const notFound = await authenticatedFetch(
      `${available.baseUrl}/v1/tasks/${testUuid(2_021)}`,
      TASK_READER_TOKEN,
    );
    expect(notFound.status).toBe(404);
    expect((await notFound.json()).error.code).toBe("TASK_NOT_FOUND");
  });

  it("returns 503 when the Coordinator mirror drops while reading a stop body", async () => {
    let ready = true;
    const isReady = vi.fn(() => ready);
    const requestStop = vi.fn(async () => {
      throw new Error("stop_must_not_run");
    });
    const source: BotStateSource = {
      isReady,
      get: () => null,
      list: () => [],
      subscribe: () => () => undefined,
      subscribeAvailability: () => () => undefined,
    };
    const { baseUrl } = await startServer({
      stateSource: source,
      stopController: { requestStop },
    });
    const requestId = testUuid(2_004);
    const body = JSON.stringify({
      schemaVersion: "1.0",
      requestId,
      confirmation: "confirmed",
    });
    const pending = beginChunkedStop(baseUrl);
    pending.request.write(body.slice(0, -1));
    await waitFor(() => isReady.mock.calls.length > 0);

    ready = false;
    pending.request.end(body.slice(-1));
    const result = await pending.response;

    expect(result.status).toBe(503);
    expect(result.body.error.code).toBe("CONTROL_UNAVAILABLE");
    expect(requestStop).not.toHaveBeenCalled();
  });

  it("cleans up a failed WebSocket initialization before admitting the next client", async () => {
    const list = vi
      .fn<BotStateSource["list"]>()
      .mockImplementationOnce(() => {
        throw new Error("snapshot_source_failed");
      })
      .mockReturnValue([]);
    const source: BotStateSource = {
      isReady: () => true,
      get: () => null,
      list,
      subscribe: () => () => undefined,
      subscribeAvailability: () => () => undefined,
    };
    const { server, webSocketUrl } = await startServer({
      stateSource: source,
      maxConnectionsPerSubject: 1,
    });

    expect(
      await webSocketCloseCode(webSocketUrl, READER_TOKEN),
    ).toBe(1011);
    await waitFor(() => controlSocketCount(server) === 0);
    expect(controlSocketAliveCount(server)).toBe(0);

    const { webSocket, firstMessage } = await connectWebSocket(
      webSocketUrl,
      ["minecraft-studio.v1"],
      READER_TOKEN,
    );
    expect(firstMessage).toMatchObject({
      type: "bot.stream.snapshot.v1",
      payload: { bots: [] },
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(logger.error).not.toHaveBeenCalledWith(
      "control_api_upgrade_failed",
      expect.anything(),
    );
    webSocket.close();
  });
});

async function startServer(
  overrides: Partial<{
    requestLimitPerMinute: number;
    stopController: Pick<StopController, "requestStop">;
    stateSource: BotStateSource;
    maxConnectionsPerSubject: number;
    goalController: GoalSubmitter;
    taskHistorySource: TaskHistorySource;
  }> = {},
): Promise<{
  server: ControlApiServer;
  registry: BotRegistry;
  baseUrl: string;
  webSocketUrl: string;
}> {
  const registry = new BotRegistry({ staleAfterMs: 30_000 });
  const server = new ControlApiServer({
    host: "127.0.0.1",
    port: 0,
    registry: overrides.stateSource ?? registry,
    principals,
    logger,
    staleSweepIntervalMs: 10_000,
    webSocketPingIntervalMs: 10_000,
    randomId: uuidSequence(),
    ...(overrides.requestLimitPerMinute === undefined
      ? {}
      : { requestLimitPerMinute: overrides.requestLimitPerMinute }),
    ...(overrides.stopController === undefined
      ? {}
      : { stopController: overrides.stopController }),
    ...(overrides.goalController === undefined
      ? {}
      : { goalController: overrides.goalController }),
    ...(overrides.taskHistorySource === undefined
      ? {}
      : { taskHistorySource: overrides.taskHistorySource }),
    ...(overrides.maxConnectionsPerSubject === undefined
      ? {}
      : { maxConnectionsPerSubject: overrides.maxConnectionsPerSubject }),
  });
  runningServers.push(server);
  const address = await server.start();
  return {
    server,
    registry,
    baseUrl: `http://127.0.0.1:${address.port}`,
    webSocketUrl: `ws://127.0.0.1:${address.port}/v1/bots/stream`,
  };
}

function beginChunkedStop(baseUrl: string): {
  request: ClientRequest;
  response: Promise<{ status: number; body: any }>;
} {
  let request!: ClientRequest;
  const response = new Promise<{ status: number; body: any }>(
    (resolve, reject) => {
      request = createHttpRequest(
        `${baseUrl}/v1/bots/worker-01/stop`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${OPERATOR_TOKEN}`,
            "Content-Type": "application/json",
          },
        },
        (incoming) => {
          const chunks: Buffer[] = [];
          incoming.on("data", (chunk) =>
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
          );
          incoming.once("end", () => {
            try {
              resolve({
                status: incoming.statusCode ?? 0,
                body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (cause) {
              reject(cause);
            }
          });
          incoming.once("error", reject);
        },
      );
      request.once("error", reject);
    },
  );
  return { request, response };
}

function authenticatedFetch(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

function stopFetch(baseUrl: string, token: string, requestId: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/bots/worker-01/stop`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId,
      confirmation: "confirmed",
    }),
  });
}

function goalFetch(baseUrl: string, token: string, requestId: string): Promise<Response> {
  return fetch(`${baseUrl}/v1/goals`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId,
      botId: "worker-01",
      operatorGoal: "采集附近的木材",
      timeoutMs: 60_000,
    }),
  });
}

function connectWebSocket(
  url: string,
  protocols: string[],
  bearerToken?: string,
): Promise<{ webSocket: WebSocket; firstMessage: any }> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, protocols, {
      ...(bearerToken
        ? { headers: { Authorization: `Bearer ${bearerToken}` } }
        : {}),
    });
    let firstMessage: any;
    webSocket.once("message", (data) => {
      firstMessage = JSON.parse(data.toString());
      if (webSocket.readyState === WebSocket.OPEN) {
        resolve({ webSocket, firstMessage });
      }
    });
    webSocket.once("error", reject);
  });
}

function nextMessage(webSocket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (data) => resolve(JSON.parse(data.toString())));
    webSocket.once("error", reject);
  });
}

function rejectedWebSocketStatus(url: string, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, protocols);
    webSocket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    webSocket.once("error", () => undefined);
    webSocket.once("open", () => {
      webSocket.close();
      reject(new Error("Expected WebSocket upgrade rejection."));
    });
  });
}

/** 与 rejectedWebSocketStatus 相同，但可精确控制 Origin 头并读回拒绝正文。 */
function rejectedWebSocketResponse(
  url: string,
  protocols: string[],
  options: { origin?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, protocols, options);
    webSocket.once("unexpected-response", (_request, response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.once("end", () => {
        resolve({
          status: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
        });
      });
      response.once("error", reject);
    });
    webSocket.once("error", () => undefined);
    webSocket.once("open", () => {
      webSocket.close();
      reject(new Error("Expected WebSocket upgrade rejection."));
    });
  });
}

function webSocketCloseCode(url: string, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, ["minecraft-studio.v1"], {
      headers: { Authorization: `Bearer ${token}` },
    });
    webSocket.once("close", (code) => resolve(code));
    webSocket.once("error", reject);
  });
}

function controlSocketCount(server: ControlApiServer): number {
  return (server as unknown as { sockets: Set<WebSocket> }).sockets.size;
}

function controlSocketAliveCount(server: ControlApiServer): number {
  return (
    server as unknown as { socketAlive: Map<WebSocket, boolean> }
  ).socketAlive.size;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition_timeout");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function statusMessage(sequence: number, includeCombat = true): BotStatusV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    messageId: testUuid(sequence),
    traceId: "trace-api-test",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: "runtime-api-test" },
    botId: "worker-01",
    type: "bot.status.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-api-test",
      sequence,
      observedAt: now,
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 10, y: 64, z: -5, dimension: "minecraft:overworld" },
      latencyMs: 15,
      currentTask: null,
      safety: {
        mode: "monitoring",
        activeRisks: [],
        normalTasksPaused: false,
        lastDecisionId: "l0-api-test",
        lastAction: null,
      },
      ...(includeCombat
        ? {
            combat: {
              schemaVersion: "1.0" as const,
              stance: "retreating" as const,
              target: { entityId: 91, kind: "monster" as const },
              latestRefusal: {
                reasonCode: "HEALTH_BELOW_ENGAGE_FLOOR",
                observedAt: now,
              },
              reflexProbe: {
                status: "denied" as const,
                denial: "P99_ABOVE_BUDGET" as const,
              },
            },
          }
        : {}),
      minecraftVersion: {
        selection: "auto",
        requestedVersion: null,
        resolvedVersion: "1.21.8",
        supportLevel: "tested",
        supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
      },
    },
  };
}

function heartbeatMessage(sequence: number) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0" as const,
    messageId: testUuid(sequence),
    traceId: "trace-api-test",
    timestamp: now,
    source: { service: "bot-runtime" as const, instanceId: "runtime-api-test" },
    botId: "worker-01",
    type: "bot.heartbeat.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-api-test",
      sequence,
      observedAt: now,
      connectionState: "online" as const,
      uptimeMs: sequence * 1_000,
      lastStatusSequence: 1,
      currentTaskId: null,
    },
  };
}

function stopResult(
  request: Parameters<StopController["requestStop"]>[0],
): BotStopResultV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    messageId: testUuid(3_001),
    traceId: request.traceId,
    timestamp: now,
    source: { service: "bot-runtime", instanceId: "runtime-api-test" },
    botId: request.botId,
    type: "bot.stop.result.v1",
    payload: {
      commandId: request.commandId,
      runtimeInstanceId: "runtime-api-test",
      outcome: "completed",
      completedAt: now,
    },
  };
}

function uuidSequence(): () => string {
  let value = 1_000;
  return () => testUuid(++value);
}

function taskSummary(taskId: string) {
  const timestamp = "2026-08-22T10:00:00.000Z";
  return {
    taskId,
    taskType: "planner.goal",
    title: "Collect nearby wood",
    status: "completed" as const,
    priority: 50,
    riskLevel: "R1" as const,
    botId: "worker-01",
    failureReason: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    startedAt: timestamp,
    finishedAt: timestamp,
    revision: 2,
  };
}

function testUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

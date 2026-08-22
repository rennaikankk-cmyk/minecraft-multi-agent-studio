import { createHash, timingSafeEqual } from "node:crypto";

import {
  botDetailResponseV1Schema,
  botListResponseV1Schema,
  controlApiErrorV1Schema,
  submitGoalHttpResponseV1Schema,
  stopBotHttpResponseV1Schema,
  taskDetailResponseV1Schema,
  taskListResponseV1Schema,
  type ControlApiErrorCode,
  type DashboardApiErrorCode,
  type PublicBotDetailV1,
  type GoalDispatchResultV1,
  type StopBotHttpResponseV1,
  type PublicTaskDetailV1,
  type TaskHistoryListPageV1,
  type TaskHistoryListQueryV1,
} from "@minecraft-studio/protocol";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BOT_LIMIT = 100;
const DASHBOARD_GOAL_TIMEOUT_MS = 120_000;
const DASHBOARD_GOAL_HTTP_TIMEOUT_MS = DASHBOARD_GOAL_TIMEOUT_MS + 5_000;

export type DashboardControlConfig = Readonly<{
  baseUrl: string;
  token: string;
  stopConfirmationSha256: string | null;
}>;

export type DashboardControlErrorCode = DashboardApiErrorCode;

export class DashboardControlError extends Error {
  constructor(
    readonly code: DashboardControlErrorCode,
    message: string,
    readonly httpStatus: number = defaultHttpStatus(code),
    readonly upstreamCode: ControlApiErrorCode | null = null,
  ) {
    super(message);
    this.name = "DashboardControlError";
  }
}

export function loadDashboardControlConfig(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): DashboardControlConfig {
  const rawUrl = environment.DASHBOARD_CONTROL_API_URL ?? "http://127.0.0.1:3210";
  const token = environment.DASHBOARD_CONTROL_API_TOKEN;
  if (!token || token.length < 32 || token.length > 512) {
    throw new DashboardControlError(
      "DASHBOARD_CONTROL_NOT_CONFIGURED",
      "Dashboard 尚未配置 Control API 访问令牌。",
    );
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new DashboardControlError(
      "DASHBOARD_CONTROL_NOT_CONFIGURED",
      "Dashboard Control API 地址无效。",
    );
  }
  if (
    url.protocol !== "http:" ||
    !LOOPBACK_HOSTS.has(url.hostname) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new DashboardControlError(
      "DASHBOARD_CONTROL_NOT_CONFIGURED",
      "Dashboard 当前只允许连接本机回环 Control API。",
    );
  }

  const rawHash = environment.DASHBOARD_STOP_CONFIRMATION_SHA256?.toLowerCase() ?? "";
  if (rawHash !== "" && !SHA256_PATTERN.test(rawHash)) {
    throw new DashboardControlError(
      "DASHBOARD_CONTROL_NOT_CONFIGURED",
      "停止确认码哈希配置无效。",
    );
  }
  return {
    baseUrl: url.origin,
    token,
    stopConfirmationSha256: rawHash || null,
  };
}

export async function fetchDashboardBots(
  config: DashboardControlConfig,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ generatedAt: string; bots: PublicBotDetailV1[] }> {
  const listValue = await requestJson(
    config,
    "/v1/bots",
    { method: "GET" },
    fetchImplementation,
  );
  const list = botListResponseV1Schema.safeParse(listValue);
  if (!list.success || list.data.data.bots.length > BOT_LIMIT) {
    throw new DashboardControlError(
      "INVALID_CONTROL_RESPONSE",
      "Control API 返回了无法识别或超出上限的机器人列表。",
    );
  }

  const details: PublicBotDetailV1[] = [];
  for (let index = 0; index < list.data.data.bots.length; index += 10) {
    const batch = list.data.data.bots.slice(index, index + 10);
    const values = await Promise.all(
      batch.map(async (summary) => {
        const detailValue = await requestJson(
          config,
          `/v1/bots/${encodeURIComponent(summary.botId)}`,
          { method: "GET" },
          fetchImplementation,
        );
        const detail = botDetailResponseV1Schema.safeParse(detailValue);
        if (!detail.success || detail.data.data.bot.botId !== summary.botId) {
          throw new DashboardControlError(
            "INVALID_CONTROL_RESPONSE",
            "Control API 返回了不匹配的机器人详情。",
          );
        }
        return detail.data.data.bot;
      }),
    );
    details.push(...values);
  }
  return { generatedAt: list.data.data.generatedAt, bots: details };
}

export async function requestDashboardBotStop(
  config: DashboardControlConfig,
  botId: string,
  commandId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<StopBotHttpResponseV1> {
  const value = await requestJson(
    config,
    `/v1/bots/${encodeURIComponent(botId)}/stop`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: commandId,
        confirmation: "confirmed",
      }),
    },
    fetchImplementation,
    20_000,
  );
  const parsed = stopBotHttpResponseV1Schema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.data.botId !== botId ||
    parsed.data.data.traceId !== commandId ||
    parsed.data.data.commandId !== commandId
  ) {
    throw new DashboardControlError(
      "INVALID_CONTROL_RESPONSE",
      "Control API 返回了无法识别的停止结果。",
    );
  }
  return parsed.data;
}

export async function requestDashboardGoal(
  config: DashboardControlConfig,
  request: Readonly<{
    requestId: string;
    botId: string;
    operatorGoal: string;
  }>,
  fetchImplementation: typeof fetch = fetch,
): Promise<GoalDispatchResultV1> {
  const value = await requestJson(
    config,
    "/v1/goals",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: "1.0",
        requestId: request.requestId,
        botId: request.botId,
        operatorGoal: request.operatorGoal,
        timeoutMs: DASHBOARD_GOAL_TIMEOUT_MS,
      }),
    },
    fetchImplementation,
    DASHBOARD_GOAL_HTTP_TIMEOUT_MS,
  );
  const parsed = submitGoalHttpResponseV1Schema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.data.botId !== request.botId ||
    parsed.data.data.taskId !== request.requestId
  ) {
    throw new DashboardControlError(
      "INVALID_CONTROL_RESPONSE",
      "Control API 返回了无法识别的目标执行结果。",
    );
  }
  return parsed.data.data;
}

export async function fetchDashboardTasks(
  config: DashboardControlConfig,
  query: TaskHistoryListQueryV1,
  fetchImplementation: typeof fetch = fetch,
): Promise<TaskHistoryListPageV1> {
  const search = new URLSearchParams({ limit: String(query.limit) });
  if (query.cursor !== null) search.set("cursor", query.cursor);
  if (query.status !== null) search.set("status", query.status);
  if (query.botId !== null) search.set("botId", query.botId);
  const value = await requestJson(
    config,
    `/v1/tasks?${search.toString()}`,
    { method: "GET" },
    fetchImplementation,
  );
  const parsed = taskListResponseV1Schema.safeParse(value);
  if (!parsed.success) {
    throw new DashboardControlError(
      "INVALID_CONTROL_RESPONSE",
      "Control API 返回了无法识别的任务历史。",
    );
  }
  return parsed.data.data;
}

export async function fetchDashboardTaskDetail(
  config: DashboardControlConfig,
  taskId: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<{ generatedAt: string; task: PublicTaskDetailV1 }> {
  const value = await requestJson(
    config,
    `/v1/tasks/${encodeURIComponent(taskId)}`,
    { method: "GET" },
    fetchImplementation,
  );
  const parsed = taskDetailResponseV1Schema.safeParse(value);
  if (!parsed.success || parsed.data.data.task.taskId !== taskId) {
    throw new DashboardControlError(
      "INVALID_CONTROL_RESPONSE",
      "Control API 返回了不匹配的任务详情。",
    );
  }
  return parsed.data.data;
}

export function verifyStopConfirmation(
  config: DashboardControlConfig,
  confirmationCode: string,
): boolean {
  if (!config.stopConfirmationSha256) return false;
  const actual = createHash("sha256").update(confirmationCode, "utf8").digest();
  const expected = Buffer.from(config.stopConfirmationSha256, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function requestJson(
  config: DashboardControlConfig,
  path: string,
  init: RequestInit,
  fetchImplementation: typeof fetch,
  timeoutMs = 4_000,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${config.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Authorization: `Bearer ${config.token}`,
        "X-Studio-Schema-Version": "1.0",
        ...init.headers,
      },
    });
  } catch {
    throw new DashboardControlError(
      "CONTROL_API_UNAVAILABLE",
      "无法连接本机 Control API。",
    );
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new DashboardControlError(
      "INVALID_CONTROL_RESPONSE",
      "Control API 返回了非 JSON 响应。",
    );
  }
  if (!response.ok) {
    const error = controlApiErrorV1Schema.safeParse(value);
    if (!error.success) {
      throw new DashboardControlError(
        "INVALID_CONTROL_RESPONSE",
        "Control API 返回了无法识别的错误响应。",
        502,
      );
    }
    const mapped = mapControlApiError(error.data.error.code, response.status);
    throw new DashboardControlError(
      mapped.code,
      mapped.message,
      mapped.httpStatus,
      error.data.error.code,
    );
  }
  return value;
}

function mapControlApiError(
  upstreamCode: ControlApiErrorCode,
  upstreamStatus: number,
): Readonly<{
  code: DashboardControlErrorCode;
  message: string;
  httpStatus: number;
}> {
  switch (upstreamCode) {
    case "AI_QUEUE_FULL":
      return {
        code: "RATE_LIMITED",
        message: "Local AI 队列已满，请稍后重试。",
        httpStatus: 429,
      };
    case "RATE_LIMITED":
      return {
        code: "RATE_LIMITED",
        message: "Control API 请求过于频繁，请稍后重试。",
        httpStatus: 429,
      };
    case "AI_UNAVAILABLE":
      return {
        code: "CONTROL_API_UNAVAILABLE",
        message: "Local AI 当前不可用。",
        httpStatus: 503,
      };
    case "CONTROL_UNAVAILABLE":
      return {
        code: "CONTROL_API_UNAVAILABLE",
        message: "Coordinator 控制链路当前不可用。",
        httpStatus: 503,
      };
    case "TASK_HISTORY_UNAVAILABLE":
      return {
        code: "TASK_HISTORY_UNAVAILABLE",
        message: "任务历史后端当前不可用。",
        httpStatus: 503,
      };
    case "TASK_NOT_FOUND":
      return {
        code: "TASK_NOT_FOUND",
        message: "未找到该任务。",
        httpStatus: 404,
      };
    case "GOAL_TIMEOUT":
      return {
        code: "GOAL_FAILED",
        message: "目标执行结果在时限内无法确认。",
        httpStatus: 504,
      };
    case "GOAL_REJECTED":
      return {
        code: "CONTROL_API_REJECTED",
        message: "Coordinator 拒绝了该目标。",
        httpStatus: 409,
      };
    case "STOP_TIMEOUT":
      return {
        code: "STOP_FAILED",
        message: "停止结果在时限内无法确认。",
        httpStatus: 504,
      };
    case "STOP_FAILED":
      return {
        code: "STOP_FAILED",
        message: "机器人停止操作失败。",
        httpStatus: 502,
      };
    default:
      return {
        code: upstreamStatus >= 500
          ? "CONTROL_API_UNAVAILABLE"
          : "CONTROL_API_REJECTED",
        message: `Control API 拒绝了请求（${upstreamCode}）。`,
        httpStatus: upstreamStatus >= 500
          ? 502
          : normalizeUpstreamStatus(upstreamStatus),
      };
  }
}

function normalizeUpstreamStatus(status: number): number {
  return Number.isInteger(status) && status >= 400 && status <= 499 ? status : 409;
}

function defaultHttpStatus(code: DashboardControlErrorCode): number {
  switch (code) {
    case "DASHBOARD_CONTROL_NOT_CONFIGURED":
    case "CONTROL_API_UNAVAILABLE":
    case "TASK_HISTORY_UNAVAILABLE":
      return 503;
    case "RATE_LIMITED":
      return 429;
    case "CONTROL_API_REJECTED":
      return 409;
    case "CONFIRMATION_REQUIRED":
      return 403;
    case "INVALID_REQUEST":
      return 400;
    case "TASK_NOT_FOUND":
      return 404;
    default:
      return 502;
  }
}

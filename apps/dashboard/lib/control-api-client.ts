import { createHash, timingSafeEqual } from "node:crypto";

import {
  botDetailResponseV1Schema,
  botListResponseV1Schema,
  controlApiErrorV1Schema,
  stopBotHttpResponseV1Schema,
  type PublicBotDetailV1,
  type StopBotHttpResponseV1,
} from "@minecraft-studio/protocol";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BOT_LIMIT = 100;

export type DashboardControlConfig = Readonly<{
  baseUrl: string;
  token: string;
  stopConfirmationSha256: string | null;
}>;

export type DashboardControlErrorCode =
  | "DASHBOARD_CONTROL_NOT_CONFIGURED"
  | "CONTROL_API_UNAVAILABLE"
  | "CONTROL_API_REJECTED"
  | "INVALID_CONTROL_RESPONSE";

export class DashboardControlError extends Error {
  constructor(
    readonly code: DashboardControlErrorCode,
    message: string,
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
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImplementation(`${config.baseUrl}${path}`, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(4_000),
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
    const suffix = error.success ? `（${error.data.error.code}）` : "";
    throw new DashboardControlError(
      response.status >= 500 ? "CONTROL_API_UNAVAILABLE" : "CONTROL_API_REJECTED",
      `Control API 拒绝了请求${suffix}。`,
    );
  }
  return value;
}

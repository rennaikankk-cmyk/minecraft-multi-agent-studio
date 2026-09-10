/**
 * 断线原因映射与 timeout 判定（从 mineflayer-client.ts 拆出，2026-09-10 结构拆分批次 5）。
 */
import type { BotDisconnectInfo } from "./client.js";

export function safeDetail(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized =
    typeof text === "string"
      ? text.replace(/[\r\n\t]+/gu, " ").trim()
      : undefined;
  return normalized ? normalized.slice(0, 500) : undefined;
}

export function mapDisconnectReason(
  requestedStop: boolean,
  versionUnsupported: boolean,
  kickedDetail: string | undefined,
  errorDetail: string | undefined,
  endReason: string,
  kickPhase?: "PRE_LOGIN" | "POST_LOGIN" | "POST_SPAWN",
): BotDisconnectInfo {
  if (requestedStop) {
    return { reason: "requested_stop", expected: true };
  }
  if (versionUnsupported) {
    return {
      reason: "runtime_error",
      expected: false,
      detail: "unsupported_minecraft_version",
    };
  }
  if (kickedDetail) {
    return {
      reason: "kicked",
      expected: false,
      detail: kickedDetail,
      ...(kickPhase !== undefined ? { phase: kickPhase } : {}),
    };
  }
  if (errorDetail) {
    const authentication = /auth|login|token|session/iu.test(errorDetail);
    return {
      reason: authentication ? "authentication_error" : "network_error",
      expected: false,
      detail: errorDetail,
    };
  }
  const detail = safeDetail(endReason);
  return {
    reason: "unknown",
    expected: false,
    ...(detail ? { detail } : {}),
  };
}

/**
 * timeout 判定只认明确语义：Node errno（ETIMEDOUT/ESOCKETTIMEDOUT）或消息
 * 里带 "timed out"/"timeout"。ECONNRESET/证书错误等不算——宁可漏报也不把
 * 别的断线原因臆断成 timeout。
 */
const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

export function isTimeoutLikeError(error: Error): boolean {
  const errno = (error as NodeJS.ErrnoException).code;
  if (typeof errno === "string" && TIMEOUT_ERRNOS.has(errno)) return true;
  return /timed?\s*out|timeout/iu.test(error.message);
}

export function isTimeoutLikeReason(reason: unknown): boolean {
  return typeof reason === "string" && /timed?\s*out|timeout/iu.test(reason);
}

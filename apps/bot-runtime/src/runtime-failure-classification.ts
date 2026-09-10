import { z } from "zod";

/**
 * Runtime 的失败/kick 分类纯函数域（从 runtime.ts 拆出，2026-09-10 结构
 * 拆分批次 3）：技能终态 → IncidentType 推导、kick 原文机器可归类摘要、
 * 服务器文本安全化、ZodError 首因摘要。
 */

/**
 * 技能终态失败的 IncidentType 推导：根因码属于 pathfinder 家族时用
 * PATH_FAILED/UNREACHABLE（快慢两种故障在 type/fingerprint 上必须可区分），
 * 其余保持 SKILL_FAILED。
 */
export function skillFaultIncidentType(rootErrorCode: string): string {
  if (rootErrorCode === "PATHFINDER_GOTO_FAILED" || rootErrorCode === "PATH_NO_PROGRESS") return "PATH_FAILED";
  if (rootErrorCode === "PATH_UNREACHABLE") return "UNREACHABLE";
  // P1-1 Build 家族稳定码：wrong-block/false-success 与不可达在 type 上可区分
  if (rootErrorCode === "BUILD_WRONG_BLOCK" || rootErrorCode === "BUILD_MISSING_BLOCK"
    || rootErrorCode === "BUILD_PLACEMENT_REJECTED" || rootErrorCode === "BUILD_MATERIAL_MISSING") return "PLACEMENT_FAILED";
  if (rootErrorCode === "BUILD_VERIFY_TIMEOUT") return "VERIFY_TIMEOUT";
  if (rootErrorCode === "BUILD_CELL_UNREACHABLE") return "UNREACHABLE";
  if (rootErrorCode === "FACILITY_VERIFY_FAILED") return "FALSE_SUCCESS";
  if (rootErrorCode === "FACILITY_SLOT_INVALID") return "STATE_DIVERGENCE";
  if (rootErrorCode === "FACILITY_RESERVATION_CORRUPT") return "RESERVATION_CONFLICT";
  return "SKILL_FAILED";
}

/** kick 原文的机器可归类摘要（证据字段；不下结论——根因仍看 A/B/C 矩阵）。 */
export function normalizeKickReason(detail: string | undefined): string {
  const text = (detail ?? "").toLowerCase();
  if (text.includes("fml") || text.includes("forge")) return "forge_or_modded_server";
  if (text.includes("outdated client")) return "outdated_client";
  if (text.includes("outdated server")) return "outdated_server";
  if (text.includes("banned")) return "banned";
  if (text.includes("whitelist") || text.includes("not whitelisted")) return "whitelist";
  if (text.includes("already connected") || text.includes("logged in from another location")) return "duplicate_session";
  if (text.includes("captcha") || text.includes("/login") || text.includes("register")) return "auth_plugin_gate";
  if (text.includes("timeout")) return "timeout";
  if (text.includes("server full") || text.includes("is full")) return "server_full";
  return detail === undefined ? "unknown" : "server_kick_unclassified";
}

/** 服务器文本安全转纯文本：去控制字符/折叠空白/限长（保留原文语义，去传输层噪音）。 */
export function sanitizeServerText(detail: string | undefined): string {
  if (detail === undefined) return "";
  const flattened = detail
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flattened.slice(0, 2000);
}

/**
 * A ZodError carries every issue in `message` as a JSON blob. Take the first
 * issue with its path instead, matching how ServerProfile validation reports
 * failures, and keep the result bounded for the log sink.
 */
export function statusFailureReason(cause: unknown): string {
  if (cause instanceof z.ZodError) {
    const issue = cause.issues[0];
    if (!issue) return "status payload failed schema validation";
    const path = issue.path.join(".");
    return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
  }
  return cause instanceof Error ? cause.message : String(cause);
}

import type { CombatDriverReceipt } from "./combat-driver.js";

import type { SkillCapabilityRequest } from "@minecraft-studio/skills";

/**
 * 战斗反应循环的纯规则域（从 runtime.ts 拆出，2026-09-10 结构拆分批次 3）：
 * 档位常量、终态理由表、意图解析与合成回执。执行循环仍归 SingleBotRuntime
 * （它编排 client 与技能调用）；本模块只承载可独立判定的规则。
 */

export const COMBAT_REACTION_MAX_STEPS = 32;
export const COMBAT_REACTION_MAX_DURATION_MS = 8_000;
export const COMBAT_REACTION_TICK_MS = 100;
// 无规则档：反击循环贴近 tick 节奏（50ms），封顶拉长——对面是外挂，
// 8 秒的窗口不够打出一场完整的遭遇战。
export const ANARCHY_COMBAT_REACTION_MAX_STEPS = 200;
export const ANARCHY_COMBAT_REACTION_MAX_DURATION_MS = 30_000;
export const ANARCHY_COMBAT_REACTION_TICK_MS = 50;

export const COMBAT_REACTION_TERMINAL_REASONS = new Set([
  "COMBAT_NO_HOSTILE_TARGET",
  "COMBAT_NO_USABLE_WEAPON",
  "COMBAT_NO_TOTEM_AVAILABLE",
  "COMBAT_HEALTH_BELOW_ENGAGE_FLOOR",
  "COMBAT_TOTEM_RESERVE_INSUFFICIENT",
  "COMBAT_OUTNUMBERED",
  "COMBAT_GEAR_OUTCLASSED",
  "COMBAT_OBSERVATION_UNAVAILABLE",
  "COMBAT_TARGET_OBSERVATION_STALE",
  "COMBAT_HAZARD_OBSERVATION_UNAVAILABLE",
  "COMBAT_MOVEMENT_BLOCKED_BY_HAZARD",
  "COMBAT_MOVEMENT_NOT_REQUIRED",
  "COMBAT_REFLEX_NOT_CLEARED",
  "COMBAT_ACTION_EXECUTION_FAILED",
  "COMBAT_EXECUTION_ACK_INVALID",
  "COMBAT_TARGET_NOT_FOUND",
  "COMBAT_WEAPON_NOT_IN_INVENTORY",
  "COMBAT_TOTEM_NOT_IN_INVENTORY",
]);

export type CombatReactionOutcome = "completed" | "cancelled" | "failed";

export type CombatIntent = "ENGAGE" | "DISENGAGE";

export function combatReactionShouldStop(
  receipt: CombatDriverReceipt,
  anarchy = false,
): boolean {
  // 无规则档：撤退是走位不是缴械——RETREAT_MOVE 之后继续打，
  // 只有终态理由（没有目标/没有武器）才结束整场。
  if (receipt.actual.action === "RETREAT" && !anarchy) return true;
  if (receipt.actual.primitiveAction !== "NONE") return false;
  return (
    receipt.actual.reasonCode === null ||
    COMBAT_REACTION_TERMINAL_REASONS.has(receipt.actual.reasonCode)
  );
}

export function combatIntentForRequest(
  request: Pick<SkillCapabilityRequest, "capability" | "operation">,
): CombatIntent | null {
  if (request.capability !== "combat.control") return null;
  if (request.operation === "combat.engage") return "ENGAGE";
  if (request.operation === "combat.disengage") return "DISENGAGE";
  return null;
}

export function syntheticCombatReceipt(
  action: CombatIntent,
  requestedAtMs: number,
  reasonCode: string,
): CombatDriverReceipt {
  const safeRequestedAtMs = Number.isSafeInteger(requestedAtMs) && requestedAtMs >= 0
    ? requestedAtMs
    : 0;
  const safeReasonCode = /^[A-Z][A-Z0-9_]{2,127}$/u.test(reasonCode)
    ? reasonCode
    : "SKILL_CAPABILITY_FAILED";
  return {
    requested: { action, requestedAtMs: safeRequestedAtMs },
    actual: {
      disposition: "dropped",
      action: "NONE",
      primitiveAction: "NONE",
      executedAtMs: null,
      reasonCode: safeReasonCode,
      targetEntityId: null,
    },
  };
}

import { describe, expect, it } from "vitest";

import {
  classifyFailure,
  failureCategories,
  isRecoverableFailure,
  isTerminalRecoveryAction,
  planRecovery,
  recoveryActions,
  recoveryLadderFor,
  type FailureCategory,
  type RecoveryAction,
} from "../src/index.js";

/** 走完某个码的整条阶梯，返回依次取到的动作。 */
function walk(errorCode: string, attempts = 6): readonly RecoveryAction[] {
  return Array.from({ length: attempts }, (_, index) =>
    planRecovery(errorCode, index + 1).action,
  );
}

describe("recovery ladders are well-formed", () => {
  it("gives every category a non-empty ladder ending in a terminal action", () => {
    for (const category of failureCategories) {
      const ladder = recoveryLadderFor(category);
      expect(ladder.length).toBeGreaterThan(0);
      const last = ladder.at(-1);
      expect(last).toBeDefined();
      expect(isTerminalRecoveryAction(last as RecoveryAction)).toBe(true);
    }
  });

  it("puts the terminal action last and nowhere else", () => {
    // 阶梯中途出现终止动作等于后面几级永远走不到,那是配置错误而不是策略。
    for (const category of failureCategories) {
      const ladder = recoveryLadderFor(category);
      for (const action of ladder.slice(0, -1)) {
        expect(isTerminalRecoveryAction(action)).toBe(false);
      }
    }
  });

  it("only uses declared recovery actions", () => {
    for (const category of failureCategories) {
      for (const action of recoveryLadderFor(category)) {
        expect(recoveryActions).toContain(action);
      }
    }
  });
});

describe("classifyFailure uses the explicit table for known codes", () => {
  const cases: readonly (readonly [string, FailureCategory])[] = [
    ["NORMAL_ACTIONS_PAUSED", "SAFETY_INTERRUPT"],
    ["SKILL_CANCELLED", "SAFETY_INTERRUPT"],
    ["RUNTIME_STOPPING", "SAFETY_INTERRUPT"],
    ["BOT_NOT_ONLINE", "SAFETY_INTERRUPT"],
    ["PLACE_TARGET_OCCUPIED", "STALE_WORLD"],
    ["CRAFTING_TABLE_NOT_FOUND", "STALE_WORLD"],
    ["SKILL_PRECONDITION_FAILED", "STALE_WORLD"],
    ["TARGET_OUT_OF_REACH", "OUT_OF_REACH"],
    ["FURNACE_OUT_OF_REACH", "OUT_OF_REACH"],
    ["TARGET_OUT_OF_SAFE_RANGE", "OUT_OF_REACH"],
    ["ITEM_NOT_IN_INVENTORY", "MISSING_RESOURCE"],
    ["RECIPE_UNAVAILABLE", "MISSING_RESOURCE"],
    ["COLLECT_BLOCKS_FAILED", "TRANSIENT"],
    ["SKILL_TIMEOUT", "TRANSIENT"],
    ["SKILL_CAPABILITY_FAILED", "TRANSIENT"],
    ["SKILL_CAPABILITY_UNSUPPORTED", "UNSUPPORTED"],
    ["BLOCK_NAME_UNKNOWN", "UNSUPPORTED"],
    ["SKILL_INPUT_INVALID", "CONTRACT_BUG"],
    ["ARMOR_ITEM_SLOT_MISMATCH", "CONTRACT_BUG"],
    ["SKILL_PRECONDITION_EVALUATION_FAILED", "CONTRACT_BUG"],
    ["PLAN_ITEM_UNOBTAINABLE", "UNSUPPORTED"],
    ["PLAN_TOOL_TIER_UNREACHABLE", "UNSUPPORTED"],
    ["PLAN_GOAL_INVALID", "CONTRACT_BUG"],
    ["PLAN_CYCLIC_DEPENDENCY", "CONTRACT_BUG"],
    ["PROBE_TARGET_NOT_ISOLATED", "UNSUPPORTED"],
  ];

  it.each(cases)("classifies %s as %s from the table", (code, category) => {
    expect(classifyFailure(code)).toMatchObject({ category, source: "table" });
  });

  it("prefers the table over shape when the two would disagree", () => {
    // RECIPE_UNAVAILABLE 形态上含 UNAVAILABLE(→UNSUPPORTED),但真实病因是缺料。
    // 显式表必须赢,否则会把"去采材料"降级成"上报人工"。
    expect(classifyFailure("RECIPE_UNAVAILABLE")).toMatchObject({
      category: "MISSING_RESOURCE",
      source: "table",
    });
    // ITEM_NOT_IN_INVENTORY 形态上含 NOT_FOUND 之外的 NOT_IN_INVENTORY,
    // 而 SKILL_PRECONDITION_FAILED 形态上含 FAILED(→TRANSIENT)。
    expect(classifyFailure("SKILL_PRECONDITION_FAILED").source).toBe("table");
    expect(classifyFailure("SKILL_CAPABILITY_UNAVAILABLE")).toMatchObject({
      category: "UNSUPPORTED",
      source: "table",
    });
  });

  it("does not label a legitimate planning outcome as a bug", () => {
    // category 会进日志和面板。"配方表里推不出钻石"是规划器给出的正确答案,
    // 不是接线缺陷——标成 CONTRACT_BUG 会让人去查一个不存在的问题。
    // 两者的阶梯都是上报,所以只有标签能把它们区分开。
    for (const code of ["PLAN_ITEM_UNOBTAINABLE", "PLAN_TOOL_TIER_UNREACHABLE"]) {
      expect(classifyFailure(code).category).toBe("UNSUPPORTED");
    }
    // 但目标非法/配方成环确实是输入或数据的问题。
    for (const code of ["PLAN_GOAL_INVALID", "PLAN_CYCLIC_DEPENDENCY"]) {
      expect(classifyFailure(code).category).toBe("CONTRACT_BUG");
    }
  });

  it("normalizes case and surrounding whitespace", () => {
    expect(classifyFailure("  skill_timeout  ")).toMatchObject({
      errorCode: "SKILL_TIMEOUT",
      category: "TRANSIENT",
      source: "table",
    });
  });
});

/**
 * 这一组是形态兜底存在的全部理由:错误码 schema 是 pattern 而非枚举,
 * 新技能随时引入没进过表的码。这些码**故意**都不在显式表里。
 */
describe("classifyFailure falls back on code shape for unknown codes", () => {
  const cases: readonly (readonly [string, FailureCategory])[] = [
    ["POLICY_REACH_EXCEEDED", "POLICY_BLOCKED"],
    ["POLICY_SOMETHING_BRAND_NEW", "POLICY_BLOCKED"],
    ["SERVER_POLICY_WOULD_RELAX", "CONTRACT_BUG"],
    ["PROBE_EVIDENCE_INVALID", "CONTRACT_BUG"],
    ["RESOURCE_CYCLE", "CONTRACT_BUG"],
    ["CRYSTAL_PLACE_CANCELLED", "SAFETY_INTERRUPT"],
    ["TOTEM_SWAP_INTERRUPTED", "SAFETY_INTERRUPT"],
    ["ANCHOR_OUT_OF_REACH", "OUT_OF_REACH"],
    ["ENDER_CHEST_TOO_FAR", "OUT_OF_REACH"],
    ["TOTEM_NOT_IN_INVENTORY", "MISSING_RESOURCE"],
    ["INSUFFICIENT_CRYSTALS", "MISSING_RESOURCE"],
    ["OBSIDIAN_TARGET_OCCUPIED", "STALE_WORLD"],
    ["ANCHOR_BLOCK_NOT_FOUND", "STALE_WORLD"],
    ["ELYTRA_UNSUPPORTED", "UNSUPPORTED"],
    ["WEAPON_NAME_UNKNOWN", "UNSUPPORTED"],
    ["ROTATION_TARGET_INVALID", "CONTRACT_BUG"],
    ["WEAPON_SLOT_MISMATCH", "CONTRACT_BUG"],
    ["CRYSTAL_PLACE_TIMEOUT", "TRANSIENT"],
    ["TOTEM_EQUIP_FAILED", "TRANSIENT"],
  ];

  it.each(cases)("classifies unseen %s as %s by shape", (code, category) => {
    const result = classifyFailure(code);
    expect(result).toMatchObject({ category, source: "shape" });
  });

  it("keeps a prefix family together even when the suffix suggests otherwise", () => {
    // POLICY_* 整族同病因:被策略拦下。后缀里的 EXCEEDED/FORBIDDEN 不该抢走判定,
    // 否则同一族错误码会散落到不同恢复路径上。
    for (const code of [
      "POLICY_RATE_EXCEEDED",
      "POLICY_SPRINT_FORBIDDEN",
      "POLICY_ACTION_INTERVAL_TOO_SHORT",
      "POLICY_FALL_TOO_FAR",
    ]) {
      expect(classifyFailure(code).category).toBe("POLICY_BLOCKED");
    }
  });

  it("lands on UNKNOWN only when no shape rule matches at all", () => {
    for (const code of ["WAT", "SOMETHING_ODD", "X", "銅"]) {
      expect(classifyFailure(code)).toMatchObject({
        category: "UNKNOWN",
        source: "default",
      });
    }
    expect(classifyFailure("")).toMatchObject({
      errorCode: "",
      category: "UNKNOWN",
      source: "default",
    });
  });

  it("treats UNKNOWN as non-retryable so unseen failures are not spun on", () => {
    expect(isRecoverableFailure("SOMETHING_ODD")).toBe(false);
    expect(planRecovery("SOMETHING_ODD", 1)).toMatchObject({
      action: "ESCALATE_TO_OPERATOR",
      terminal: true,
    });
  });
});

describe("planRecovery advances the ladder by attempt", () => {
  it("escalates a transient failure instead of retrying the same thing forever", () => {
    expect(walk("SKILL_TIMEOUT", 4)).toEqual([
      "RETRY_SAME",
      "REOBSERVE_THEN_RETRY",
      "ABORT",
      "ABORT",
    ]);
  });

  it("moves closer first, then re-observes, then gives up", () => {
    expect(walk("TARGET_OUT_OF_REACH", 3)).toEqual([
      "MOVE_CLOSER_THEN_RETRY",
      "REOBSERVE_THEN_RETRY",
      "ABORT",
    ]);
  });

  it("routes missing materials to acquisition, which is what feeds the planner", () => {
    const first = planRecovery("ITEM_NOT_IN_INVENTORY", 1);
    expect(first).toMatchObject({
      category: "MISSING_RESOURCE",
      action: "ACQUIRE_RESOURCES_THEN_RETRY",
      terminal: false,
    });
    expect(first.remainingRungs).toBe(2);
  });

  it("slows down twice before giving up on a policy denial", () => {
    // 被策略拦下时原样重试同一时序只会再被拦一次,所以两级都是降速。
    expect(walk("POLICY_RATE_EXCEEDED", 3)).toEqual([
      "SLOW_DOWN_THEN_RETRY",
      "SLOW_DOWN_THEN_RETRY",
      "ABORT",
    ]);
  });

  it("waits for safety to clear rather than treating a pause as a fault", () => {
    expect(walk("NORMAL_ACTIONS_PAUSED", 2)).toEqual([
      "WAIT_FOR_SAFETY_CLEAR",
      "ABORT",
    ]);
  });

  it("escalates contract bugs on the first failure — retrying cannot help", () => {
    for (const code of ["SKILL_INPUT_INVALID", "SKILL_CAPABILITY_UNDECLARED"]) {
      expect(planRecovery(code, 1)).toMatchObject({
        action: "ESCALATE_TO_OPERATOR",
        terminal: true,
        remainingRungs: 0,
      });
      expect(isRecoverableFailure(code)).toBe(false);
    }
  });

  it("clamps past the end of the ladder to the terminal rung", () => {
    for (const attempt of [3, 4, 99, 1_000_000]) {
      expect(planRecovery("SKILL_TIMEOUT", attempt)).toMatchObject({
        action: "ABORT",
        terminal: true,
        remainingRungs: 0,
      });
    }
  });

  it("fails toward termination on a nonsensical attempt number", () => {
    // 宁可多上报一次,也不要因为一个 NaN 把某类失败变成无限重试。
    for (const attempt of [Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(planRecovery("SKILL_TIMEOUT", attempt).terminal).toBe(true);
    }
    // 0 与负数当作第一次失败,而不是绕回阶梯末尾。
    for (const attempt of [0, -1, -99]) {
      expect(planRecovery("SKILL_TIMEOUT", attempt)).toMatchObject({
        attempt: 1,
        action: "RETRY_SAME",
      });
    }
    // 小数向下取整,1.9 仍是第一次。
    expect(planRecovery("SKILL_TIMEOUT", 1.9).action).toBe("RETRY_SAME");
  });

  it("is a pure function of code and attempt", () => {
    const once = planRecovery("COLLECT_BLOCKS_FAILED", 2);
    const twice = planRecovery("COLLECT_BLOCKS_FAILED", 2);
    expect(once).toEqual(twice);
  });

  it("hands back frozen results so a consumer cannot mutate the ladder", () => {
    const decision = planRecovery("SKILL_TIMEOUT", 1);
    expect(Object.isFrozen(decision)).toBe(true);
    const ladder = recoveryLadderFor("TRANSIENT");
    expect(Object.isFrozen(ladder)).toBe(true);
    expect(() => (ladder as RecoveryAction[]).push("ABORT")).toThrow();
    expect(recoveryLadderFor("TRANSIENT")).toEqual([
      "RETRY_SAME",
      "REOBSERVE_THEN_RETRY",
      "ABORT",
    ]);
  });
});

describe("every error code the package emits is classifiable", () => {
  /**
   * 这些码是从 packages/skills/src 里 grep 出来的实际抛出值。
   * 断言全部不落到 UNKNOWN——分类器上线第一天就不该对自家错误码一无所知。
   */
  const emitted: readonly string[] = [
    "BOT_NOT_ONLINE",
    "BOT_OFFLINE",
    "BOT_POSITION_UNAVAILABLE",
    "CONTAINER_OUT_OF_REACH",
    "CRAFTING_TABLE_OUT_OF_REACH",
    "FURNACE_OUT_OF_REACH",
    "PLAN_CYCLIC_DEPENDENCY",
    "PLAN_DEPTH_EXCEEDED",
    "PLAN_GOAL_INVALID",
    "PLAN_ITEM_UNOBTAINABLE",
    "PLAN_STEP_LIMIT_EXCEEDED",
    "PLAN_TOOL_TIER_UNREACHABLE",
    "POLICY_REACH_EXCEEDED",
    "POLICY_ATTACK_REACH_EXCEEDED",
    "POLICY_RATE_EXCEEDED",
    "POLICY_ACTION_INTERVAL_TOO_SHORT",
    "POLICY_SPRINT_FORBIDDEN",
    "POLICY_JUMP_FORBIDDEN",
    "POLICY_SPRINT_JUMP_FORBIDDEN",
    "POLICY_AIR_STRAFE_FORBIDDEN",
    "POLICY_FALL_TOO_FAR",
    "PROBE_ALREADY_RUNNING",
    "PROBE_AUTHORIZATION_INVALID",
    "PROBE_EVIDENCE_INVALID",
    "PROBE_NOT_RUNNING",
    "PROBE_OBSERVATION_MISMATCH",
    "PROBE_TARGET_NOT_ISOLATED",
    "RESOURCE_CYCLE",
    "RESOURCE_INPUT_UNKNOWN",
    "RESOURCE_RECIPE_DUPLICATE",
    "SERVER_POLICY_WOULD_RELAX",
    "SKILL_AUTH_CONTEXT_INVALID",
    "SKILL_AUTH_EXPIRED",
    "SKILL_AUTH_MISMATCH",
    "SKILL_CANCELLED",
    "SKILL_CAPABILITY_DENIED",
    "SKILL_CAPABILITY_FAILED",
    "SKILL_CAPABILITY_INPUT_INVALID",
    "SKILL_CAPABILITY_OUTPUT_INVALID",
    "SKILL_CAPABILITY_REQUEST_INVALID",
    "SKILL_CAPABILITY_UNAVAILABLE",
    "SKILL_CAPABILITY_UNDECLARED",
    "SKILL_CAPABILITY_UNSUPPORTED",
    "SKILL_HANDLER_FAILED",
    "SKILL_INPUT_INVALID",
    "SKILL_NOT_FOUND",
    "SKILL_OUTPUT_INVALID",
    "SKILL_OUTPUT_NOT_SERIALIZABLE",
    "SKILL_PRECONDITION_EVALUATION_FAILED",
    "SKILL_PRECONDITION_FAILED",
    "SKILL_STATE_INVALID",
    "SKILL_TIMEOUT",
    "SKILL_VERSION_UNAVAILABLE",
    "TARGET_DIMENSION_MISMATCH",
    "TARGET_OUT_OF_REACH",
    "TARGET_OUT_OF_SAFE_RANGE",
    "TARGET_SERVER_PROFILE_MISMATCH",
  ];

  it.each(emitted)("classifies %s without falling through to UNKNOWN", (code) => {
    const result = classifyFailure(code);
    expect(result.category).not.toBe("UNKNOWN");
    expect(result.source).not.toBe("default");
  });

  it("never leaves a classified failure without an actionable first rung", () => {
    for (const code of emitted) {
      const first = planRecovery(code, 1);
      expect(recoveryActions).toContain(first.action);
      expect(first.attempt).toBe(1);
    }
  });
});

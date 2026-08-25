import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
    ["COMBAT_OBSERVATION_UNAVAILABLE", "STALE_WORLD"],
    ["COMBAT_OBSERVATION_PROFILE_MISMATCH", "CONTRACT_BUG"],
    ["COMBAT_DRIVER_UNAVAILABLE", "UNSUPPORTED"],
    ["COMBAT_REFLEX_NOT_CLEARED", "UNSUPPORTED"],
    ["COMBAT_EXECUTION_RECEIPT_INVALID", "CONTRACT_BUG"],
    ["COMBAT_EXECUTION_ACK_INVALID", "CONTRACT_BUG"],
    ["COMBAT_ACTION_ADAPTER_UNAVAILABLE", "UNSUPPORTED"],
    ["COMBAT_ACTION_EXECUTION_FAILED", "TRANSIENT"],
    ["COMBAT_TARGET_OBSERVATION_STALE", "STALE_WORLD"],
    ["COMBAT_HAZARD_OBSERVATION_UNAVAILABLE", "STALE_WORLD"],
    ["COMBAT_WEAPON_NOT_IN_INVENTORY", "MISSING_RESOURCE"],
    ["COMBAT_TOTEM_NOT_IN_INVENTORY", "MISSING_RESOURCE"],
    ["COMBAT_WEAPON_COOLDOWN", "POLICY_BLOCKED"],
    ["COMBAT_TOTEM_REEQUIPPED", "STALE_WORLD"],
    ["COMBAT_WEAPON_EQUIPPED", "STALE_WORLD"],
    ["COMBAT_ROTATION_POLICY_CLIPPED", "POLICY_BLOCKED"],
    ["COMBAT_ROTATION_IN_PROGRESS", "POLICY_BLOCKED"],
    ["COMBAT_CLOSING_DISTANCE", "OUT_OF_REACH"],
    ["COMBAT_NO_WEAPON", "MISSING_RESOURCE"],
    ["COMBAT_OUT_OF_RANGE", "OUT_OF_REACH"],
    ["PLACE_TARGET_OCCUPIED", "STALE_WORLD"],
    ["CRAFTING_TABLE_NOT_FOUND", "STALE_WORLD"],
    ["SKILL_PRECONDITION_FAILED", "STALE_WORLD"],
    ["TARGET_OUT_OF_REACH", "OUT_OF_REACH"],
    ["FURNACE_OUT_OF_REACH", "OUT_OF_REACH"],
    ["TARGET_OUT_OF_SAFE_RANGE", "OUT_OF_REACH"],
    ["TRADE_PRICE_UNACCEPTABLE", "UNSUPPORTED"],
    ["POLICY_ROUTE_SEGMENT_LIMIT", "POLICY_BLOCKED"],
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

  it("keeps every smelt failure on the rung its cause deserves", () => {
    // 这六条曾经有两条是错的，而且都是形态规则"顺手"给出的错答案：
    // FURNACE_NOT_EMPTY 没进表，落到 UNKNOWN → 把"炉子被别人占着"升级成人工工单；
    // FURNACE_OUTPUT_MISMATCH 被 "MISMATCH" 规则读成 CONTRACT_BUG → 让人去查一个
    // 并不存在的 schema 问题。两者其实都是世界变了，重新观察换个空炉子就能继续。
    // 所以这里锁的不只是分类，还有"凭什么"——source 必须是 table，
    // 将来谁改形态规则都不会把它们悄悄拽回去。
    const smelt: readonly (readonly [string, FailureCategory])[] = [
      ["FURNACE_NOT_EMPTY", "STALE_WORLD"],
      ["FURNACE_OUTPUT_MISMATCH", "STALE_WORLD"],
      ["SMELT_OUTPUT_NOT_CONFIRMED", "STALE_WORLD"],
      ["SMELT_INPUT_INSUFFICIENT", "MISSING_RESOURCE"],
      ["SMELT_FUEL_INSUFFICIENT", "MISSING_RESOURCE"],
      ["SMELT_FAILED", "TRANSIENT"],
    ];
    for (const [code, category] of smelt) {
      expect(classifyFailure(code)).toMatchObject({ category, source: "table" });
    }
    // 缺料/缺燃料要能生成补齐子计划，缺一步都到不了 GoalPlanner。
    expect(walk("SMELT_INPUT_INSUFFICIENT", 1)[0]).toBe("ACQUIRE_RESOURCES_THEN_RETRY");
    expect(walk("SMELT_FUEL_INSUFFICIENT", 1)[0]).toBe("ACQUIRE_RESOURCES_THEN_RETRY");
    // 炉子被占的第一步是重新观察，不是找人。
    expect(walk("FURNACE_NOT_EMPTY", 1)[0]).toBe("REOBSERVE_THEN_RETRY");
    expect(isRecoverableFailure("FURNACE_NOT_EMPTY")).toBe(true);
    expect(isRecoverableFailure("FURNACE_OUTPUT_MISMATCH")).toBe(true);
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

  it("refreshes combat observations but never retries around driver or reflex gates", () => {
    expect(walk("COMBAT_OBSERVATION_UNAVAILABLE", 2)).toEqual([
      "REOBSERVE_THEN_RETRY",
      "ABORT",
    ]);
    for (const code of ["COMBAT_DRIVER_UNAVAILABLE", "COMBAT_REFLEX_NOT_CLEARED"]) {
      expect(planRecovery(code, 1)).toMatchObject({
        category: "UNSUPPORTED",
        action: "ESCALATE_TO_OPERATOR",
        terminal: true,
      });
    }
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

describe("non-idempotent replay protection", () => {
  it("escalates an uncertain operation result without retrying", () => {
    expect(classifyFailure("NON_IDEMPOTENT_RESULT_UNCERTAIN")).toMatchObject({
      category: "CONTRACT_BUG",
      source: "table",
    });
    expect(planRecovery("NON_IDEMPOTENT_RESULT_UNCERTAIN", 1)).toMatchObject({
      action: "ESCALATE_TO_OPERATOR",
      terminal: true,
    });
  });
});

// ---------------------------------------------------------------------------
// "装不下"与"缺东西"是互为反面的两种失败。合成一类会让满背包走上
// ACQUIRE_RESOURCES_THEN_RETRY —— 也就是"再去弄更多东西回来" —— 方向正好相反,
// 把一次卡死变成无限刷任务。这一组盯的就是这个反向。
// ---------------------------------------------------------------------------
describe("a full backpack gets the opposite ladder from a missing item", () => {
  it("frees space first, then re-observes, then gives up", () => {
    // 中间那级不是凑数:别人可能刚把箱子里的东西拿走,空间自己就腾开了。
    expect(walk("INVENTORY_FULL", 3)).toEqual([
      "FREE_INVENTORY_THEN_RETRY",
      "REOBSERVE_THEN_RETRY",
      "ABORT",
    ]);
  });

  it("never routes a full backpack into resource acquisition", () => {
    const decision = planRecovery("INVENTORY_FULL", 1);
    expect(decision.category).toBe("INVENTORY_FULL");
    expect(decision.action).not.toBe("ACQUIRE_RESOURCES_THEN_RETRY");
    expect(walk("INVENTORY_FULL", 6)).not.toContain(
      "ACQUIRE_RESOURCES_THEN_RETRY",
    );
  });

  it("classifies INVENTORY_FULL from the explicit table, not the shape fallback", () => {
    // 最常见的一个码不该依赖兜底层:兜底一旦改动会静默改判,而这条必须稳定。
    expect(classifyFailure("INVENTORY_FULL")).toMatchObject({
      category: "INVENTORY_FULL",
      source: "table",
    });
  });

  it("beats the missing-resource rule on codes that contain both signatures", () => {
    // 卡点是 INSUFFICIENT_SPACE:缺料规则认裸 "INSUFFICIENT",两条规则顺序颠倒
    // 就会把"装不下"判成"缺东西",于是 bot 背着装不下的货再去采更多。
    for (const code of [
      "CHEST_INVENTORY_FULL",
      "TARGET_CONTAINER_FULL",
      "SHULKER_NO_SPACE",
      "SHULKER_INSUFFICIENT_SPACE",
      "BARREL_INSUFFICIENT_SPACE",
      "HOTBAR_NO_FREE_SLOT",
    ]) {
      expect(classifyFailure(code)).toMatchObject({
        category: "INVENTORY_FULL",
        source: "shape",
      });
      expect(planRecovery(code, 1).action).toBe("FREE_INVENTORY_THEN_RETRY");
    }
  });

  it("leaves a genuinely missing item on the acquisition ladder", () => {
    // 反向对照:含 "INVENTORY" 但语义是缺料的码不能被新规则抢走。
    for (const code of ["ITEM_NOT_IN_INVENTORY", "ARMOR_ITEM_NOT_IN_INVENTORY"]) {
      expect(classifyFailure(code).category).toBe("MISSING_RESOURCE");
      expect(planRecovery(code, 1).action).toBe("ACQUIRE_RESOURCES_THEN_RETRY");
    }
  });

  it("does not apply the free-space ladder to unrelated queue overflow", () => {
    // AI_QUEUE_FULL(ai-router 的调度队列溢出)与背包无关。裸 "_FULL" 形态规则
    // 会把它拖进腾背包的阶梯,让恢复层去清一个根本不存在的背包。
    expect(classifyFailure("AI_QUEUE_FULL").category).not.toBe("INVENTORY_FULL");
    expect(planRecovery("AI_QUEUE_FULL", 1).action).not.toBe(
      "FREE_INVENTORY_THEN_RETRY",
    );
  });

  it("still ends the ladder on a terminal rung", () => {
    const ladder = recoveryLadderFor("INVENTORY_FULL");
    expect(isTerminalRecoveryAction(ladder[ladder.length - 1]!)).toBe(true);
    expect(isRecoverableFailure("INVENTORY_FULL")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 从源码里**扫**出实际会落到技能结果上的错误码，而不是手抄一份清单。
//
// 手抄过一次，代价已经付了：适配器那批码整体漏收，PATH_TARGET_NOT_REACHED
// 一直落在 UNKNOWN 上，把"走到了但差半格"升级成人工工单——而这恰是
// movement.goto 最常见的失败。清单是第二份真相，第二份真相一定会漂。
//
// 只认**产生机制**，不认具体码，所以新技能新抛一个码就自动进入断言：
//   SkillFault / PlanAbort / SkillAbortError / 前置条件 failureCode /
//   策略闸 deny() / executor 直接构造的 rejected|failed 结果码。
//
// 刻意不收 apps/bot-runtime 里的裸 `errorCode:` 字面量：那些是
// L0SafetyActionResult 与 RuntimeStopOutcome 的字段（NO_SAFE_FOOD、
// RUNTIME_ACTION_REQUIRED、SAFETY_ACTION_FAILED、CLIENT_CLOSE_FAILED），
// 走的是安全动作/停机协议，永远不会作为技能失败码出现。把它们塞进来只会
// 逼分类器去认领一个它不负责的域。
// ---------------------------------------------------------------------------

const SKILL_FAILURE_PATTERNS: readonly RegExp[] = [
  /new SkillFault\(\s*"([A-Z0-9_]+)"/g,
  /new PlanAbort\(\s*"([A-Z0-9_]+)"/g,
  /new SkillAbortError\(\s*"([A-Z0-9_]+)"/g,
  // SkillRefusal 是 SkillFault 的子类（"证明什么都没动"的拒绝）。它单独列一条，
  // 因为上面那条正则认的是构造函数名而不是类型层次：只用 SkillRefusal 抛的码
  // 会整族扫不出来，于是静默落回 UNKNOWN → 直接升级人工。
  /new SkillRefusal\(\s*"([A-Z0-9_]+)"/g,
  /failureCode:\s*"([A-Z0-9_]+)"/g,
  /\bdeny\(\s*"([A-Z0-9_]+)"/g,
  /"(?:rejected|failed)",\s*[^,)]*,\s*[^,)]*,\s*"([A-Z0-9_]+)"/g,
];

/** packages/skills 内部的策略/探针结果码也是操作者可见的失败面，一并收。 */
const SKILL_PACKAGE_ERROR_CODE = /errorCode:\s*"([A-Z0-9_]+)"/g;

const testDir = path.dirname(fileURLToPath(import.meta.url));
const skillsSrc = path.join(testDir, "..", "src");
const runtimeSrc = path.join(testDir, "..", "..", "..", "apps", "bot-runtime", "src");

function typescriptFilesIn(dir: string): readonly string[] {
  const found: string[] = [];
  const visit = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) visit(full);
      else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) found.push(full);
    }
  };
  visit(dir);
  return found;
}

function scanEmittedFailureCodes(): readonly string[] {
  const codes = new Set<string>();
  const skillFiles = typescriptFilesIn(skillsSrc);
  const runtimeFiles = typescriptFilesIn(runtimeSrc);
  for (const file of [...skillFiles, ...runtimeFiles]) {
    const source = readFileSync(file, "utf8");
    for (const pattern of SKILL_FAILURE_PATTERNS) {
      for (const match of source.matchAll(pattern)) codes.add(match[1] as string);
    }
  }
  for (const file of skillFiles) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(SKILL_PACKAGE_ERROR_CODE)) {
      codes.add(match[1] as string);
    }
  }
  return Object.freeze([...codes].sort());
}

describe("every error code the package emits is classifiable", () => {
  const emitted = scanEmittedFailureCodes();

  it("actually found the emission sites (a silent zero-hit scan proves nothing)", () => {
    // 扫不到东西的扫描器会让下面每条断言都空转通过。
    expect(emitted.length).toBeGreaterThan(60);
    // 六种机制各抓一个代表码，任一模式失效都会在这里露出来。
    for (const code of [
      "NORMAL_ACTIONS_PAUSED", // SkillFault
      "PLAN_CYCLIC_DEPENDENCY", // PlanAbort
      "SKILL_TIMEOUT", // SkillAbortError
      "FURNACE_OUT_OF_REACH", // 前置条件 failureCode
      "POLICY_REACH_EXCEEDED", // 策略闸 deny()
      "SKILL_NOT_FOUND", // executor 结果码
      "PATH_TARGET_NOT_REACHED", // 适配器码：曾整批漏收的那一类
      "RUNTIME_STOPPING", // 适配器 SkillFault
    ]) {
      expect(emitted).toContain(code);
    }
  });

  it("keeps the L0 safety-action vocabulary out of the skill failure domain", () => {
    // 这些码属于安全动作/停机协议，不该被当成技能失败码收进来。
    for (const code of [
      "NO_SAFE_FOOD",
      "RUNTIME_ACTION_REQUIRED",
      "SAFETY_ACTION_FAILED",
      "CLIENT_CLOSE_FAILED",
    ]) {
      expect(emitted).not.toContain(code);
    }
  });

  const legacyList: readonly string[] = [
    "ARMOR_EQUIP_FAILED",
    "ARMOR_ITEM_NOT_IN_INVENTORY",
    "ARMOR_ITEM_SLOT_MISMATCH",
    "BLOCK_NAME_UNKNOWN",
    "BOT_MOVEMENT_BUSY",
    "BOT_NOT_ONLINE",
    "BOT_OFFLINE",
    "BOT_POSITION_UNAVAILABLE",
    "COMBAT_TOTEM_DEPLETED",
    "COMBAT_HEALTH_CRITICAL",
    "COMBAT_HEALTH_LOW",
    "COMBAT_CRYSTAL_THREAT",
    "COMBAT_RETREAT_REQUIRED",
    "COLLECT_BLOCKS_FAILED",
    "CONTAINER_NOT_FOUND",
    "CONTAINER_TRANSFER_FAILED",
    "CRAFTING_TABLE_NOT_FOUND",
    "CRAFT_FAILED",
    "FURNACE_NOT_EMPTY",
    "FURNACE_NOT_FOUND",
    "FURNACE_OUTPUT_MISMATCH",
    "ITEM_NAME_UNKNOWN",
    "ITEM_NOT_IN_INVENTORY",
    "NORMAL_ACTIONS_PAUSED",
    "PATHFINDER_GOTO_FAILED",
    "PATH_TARGET_NOT_REACHED",
    "PLACE_BLOCK_FAILED",
    "PLACE_NOT_CONFIRMED",
    "PLACE_TARGET_OCCUPIED",
    "RECIPE_UNAVAILABLE",
    "REFERENCE_BLOCK_NOT_FOUND",
    "SKILL_EXECUTION_INTERRUPTED",
    "SMELT_FAILED",
    "SMELT_FUEL_INSUFFICIENT",
    "SMELT_INPUT_INSUFFICIENT",
    "SMELT_OUTPUT_NOT_CONFIRMED",
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

  /**
   * 扫描是活的来源，这份历史清单是**回归地板**：其中有些码只以联合类型成员
   * 存在（如 BOT_OFFLINE），扫不到但仍会出现在结果里。两者取并集断言，
   * 于是"扫描漏了"和"曾经分对过的码退化了"都盖得住。
   */
  const allCodes: readonly string[] = Object.freeze(
    [...new Set([...emitted, ...legacyList])].sort(),
  );

  it.each(allCodes)("classifies %s without falling through to UNKNOWN", (code) => {
    const result = classifyFailure(code);
    expect(result.category).not.toBe("UNKNOWN");
    expect(result.source).not.toBe("default");
  });

  it("never leaves a classified failure without an actionable first rung", () => {
    for (const code of allCodes) {
      const first = planRecovery(code, 1);
      expect(recoveryActions).toContain(first.action);
      expect(first.attempt).toBe(1);
    }
  });
});

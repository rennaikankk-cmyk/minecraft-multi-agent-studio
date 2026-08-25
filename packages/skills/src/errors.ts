import { skillErrorCodeSchema } from "@minecraft-studio/protocol";

export type SkillFrameworkErrorCode =
  | "INVALID_SKILL_DEFINITION"
  | "DUPLICATE_SKILL_VERSION"
  | "INVALID_SKILL_INVOCATION";

export class SkillFrameworkError extends Error {
  readonly code: SkillFrameworkErrorCode;

  constructor(code: SkillFrameworkErrorCode, message: string) {
    super(message);
    this.name = "SkillFrameworkError";
    this.code = code;
  }
}

/**
 * `SkillFault` 不带说明时的占位文本。诊断侧要能把它和真正的原因区分开：
 * 它读起来像一句解释，实际什么都没说，当成 reason 记下去就是凭空造证据。
 */
export const SKILL_FAULT_DEFAULT_MESSAGE = "Skill execution failed.";

export class SkillFault extends Error {
  readonly code: string;

  constructor(code: string, message = SKILL_FAULT_DEFAULT_MESSAGE) {
    skillErrorCodeSchema.parse(code);
    super(message);
    this.name = "SkillFault";
    this.code = code;
  }
}

/**
 * 一次**证明什么都没动**的拒绝。
 *
 * 为什么需要一个独立的类型，而不是复用 `attempts === 0`：协调器的
 * `nonIdempotentStepOutcome` 要判断"重投一次安不安全"，而 `attempts` 回答不了
 * 这个问题——executor 的 `attempts` 在 `definition.execute` 一进去就变成 1，
 * 不管适配器有没有真的碰过世界。实测后果是 collect.block 的**前置**可达性检查
 * （什么都没挖）被和 `collect()` 挖了一半再失败当成同一件事，真实码
 * `COLLECT_TARGET_UNREACHABLE`（STALE_WORLD → REOBSERVE_THEN_RETRY）被改写成
 * `NON_IDEMPOTENT_RESULT_UNCERTAIN`（CONTRACT_BUG → ESCALATE_TO_OPERATOR），
 * 一个本该重新观察再试的步骤在第一次尝试就被升级成人工工单：
 *   {"reportedErrorCode":"NON_IDEMPOTENT_RESULT_UNCERTAIN",
 *    "skillErrorCode":"COLLECT_TARGET_UNREACHABLE","repairStepsInserted":0}
 *
 * 同一个错误码可能从"动过"和"没动过"两个分支抛出（collect 的
 * `COLLECT_TARGET_UNREACHABLE` 就是：前置检查 vs `NoPath` catch），所以
 * 协调器侧按码放行必然不成立——只有抛出点自己知道。这个类型就是抛出点
 * 把那个事实说出口的方式，executor 据此报 `rejected`。
 *
 * **契约**：只有在世界状态、背包、容器都还没有被这次调用改动过时才可以抛它。
 * 拿不准就用 `SkillFault`——保守屏蔽的代价是多一次人工，谎报没动过的代价是
 * 上层安心重放一个已经产生副作用的操作。
 */
export class SkillRefusal extends SkillFault {
  constructor(code: string, message?: string) {
    super(code, ...(message === undefined ? [] : ([message] as const)));
    this.name = "SkillRefusal";
  }
}

export class SkillAbortError extends SkillFault {
  constructor(code: "SKILL_CANCELLED" | "SKILL_TIMEOUT") {
    super(code, code === "SKILL_TIMEOUT" ? "Skill timed out." : "Skill cancelled.");
    this.name = "SkillAbortError";
  }
}

// ---------------------------------------------------------------------------
// FailureClassifier —— 把任意 errorCode 归类，并给出恢复阶梯。
//
// docs/skill-verification-runbook.md §4 已经用表格写清了"errorCode → 病因 →
// 下一步"，但那是给人看的。这里把同一份知识变成数据，让恢复决策可判定、可单测，
// 而不是每次失败都要人查表。
//
// 两条设计原则：
//   1. **先查表，再按形态兜底**。显式表覆盖已知码；未知码走前缀/后缀启发式，
//      因为 skillErrorCodeSchema 是 pattern 而非枚举，新技能随时会引入新码。
//      只覆盖固定样例的分类器上线第一天就会遇到没见过的码。
//   2. **阶梯而不是布尔**。"能不能重试"信息量太少：同样的失败，第一次该重新观察，
//      第二次该走近点，第三次该去补材料，第四次才该放弃。阶梯按 attempt 推进，
//      每一级都是一个具体的、可执行的动作。
//
// 分类器本身是纯函数式的：无 IO、无随机、无时钟，同样输入恒定输出。
// ---------------------------------------------------------------------------

export const failureCategories = [
  /** 偶发抖动，原样重试有意义。 */
  "TRANSIENT",
  /** 世界状态与快照不符（方块没了/被占了），要重新观察再决策。 */
  "STALE_WORLD",
  /** 距离不够，先移动再重试。 */
  "OUT_OF_REACH",
  /** 缺材料或缺工具，要先补齐——这一类会回灌给 GoalPlanner 生成子任务。 */
  "MISSING_RESOURCE",
  /** ServerPolicy 拦下的动作：要降速/收紧，重试同样的时序只会再被拦。 */
  "POLICY_BLOCKED",
  /** L0 安全层或取消：不算技能坏，等恢复而不是修。 */
  "SAFETY_INTERRUPT",
  /** 技能与运行时的契约不一致（schema/能力没接线）：重试无意义，得改代码。 */
  "CONTRACT_BUG",
  /** 当前环境/版本不支持：换变体或放弃，别重试。 */
  "UNSUPPORTED",
  /** 归不了类。保守当作不可重试，避免把未知失败当偶发抖动刷。 */
  "UNKNOWN",
] as const;

export type FailureCategory = (typeof failureCategories)[number];

export const recoveryActions = [
  "RETRY_SAME",
  "REOBSERVE_THEN_RETRY",
  "MOVE_CLOSER_THEN_RETRY",
  "ACQUIRE_RESOURCES_THEN_RETRY",
  "SLOW_DOWN_THEN_RETRY",
  "WAIT_FOR_SAFETY_CLEAR",
  "ESCALATE_TO_OPERATOR",
  "ABORT",
] as const;

export type RecoveryAction = (typeof recoveryActions)[number];

/** 冻结一条阶梯。显式参数类型让拼错的动作名在编译期就被挡住。 */
function ladder(...actions: readonly RecoveryAction[]): readonly RecoveryAction[] {
  return Object.freeze(actions);
}

/** 每一类失败的恢复阶梯，按尝试次数依次取用，最后一级恒为终止动作。 */
const LADDERS: Readonly<Record<FailureCategory, readonly RecoveryAction[]>> =
  Object.freeze({
    TRANSIENT: ladder("RETRY_SAME", "REOBSERVE_THEN_RETRY", "ABORT"),
    STALE_WORLD: ladder("REOBSERVE_THEN_RETRY", "ABORT"),
    OUT_OF_REACH: ladder("MOVE_CLOSER_THEN_RETRY", "REOBSERVE_THEN_RETRY", "ABORT"),
    MISSING_RESOURCE: ladder(
      "ACQUIRE_RESOURCES_THEN_RETRY",
      "REOBSERVE_THEN_RETRY",
      "ABORT",
    ),
    POLICY_BLOCKED: ladder("SLOW_DOWN_THEN_RETRY", "SLOW_DOWN_THEN_RETRY", "ABORT"),
    SAFETY_INTERRUPT: ladder("WAIT_FOR_SAFETY_CLEAR", "ABORT"),
    CONTRACT_BUG: ladder("ESCALATE_TO_OPERATOR"),
    UNSUPPORTED: ladder("ESCALATE_TO_OPERATOR"),
    UNKNOWN: ladder("ESCALATE_TO_OPERATOR"),
  });

/** 终止级动作：走到这一级就不再重试了。 */
const TERMINAL: ReadonlySet<RecoveryAction> = new Set<RecoveryAction>([
  "ABORT",
  "ESCALATE_TO_OPERATOR",
]);

export function isTerminalRecoveryAction(action: RecoveryAction): boolean {
  return TERMINAL.has(action);
}

/**
 * 显式分类表。来源是 runbook §4 与各技能实际抛出的错误码，
 * 不是猜的——每一条都对应一个真实存在的失败签名。
 */
const EXPLICIT: Readonly<Record<string, FailureCategory>> = Object.freeze({
  // —— 安全与取消：预期行为，最高优先级，不算故障 ——
  NORMAL_ACTIONS_PAUSED: "SAFETY_INTERRUPT",
  SKILL_CANCELLED: "SAFETY_INTERRUPT",
  RUNTIME_STOPPING: "SAFETY_INTERRUPT",
  BOT_NOT_ONLINE: "SAFETY_INTERRUPT",
  BOT_OFFLINE: "SAFETY_INTERRUPT",

  // —— 世界状态过期：重新观察，别原样重试 ——
  REFERENCE_BLOCK_NOT_FOUND: "STALE_WORLD",
  PLACE_TARGET_OCCUPIED: "STALE_WORLD",
  PLACE_NOT_CONFIRMED: "STALE_WORLD",
  CRAFTING_TABLE_NOT_FOUND: "STALE_WORLD",
  CONTAINER_NOT_FOUND: "STALE_WORLD",
  FURNACE_NOT_FOUND: "STALE_WORLD",
  BOT_POSITION_UNAVAILABLE: "STALE_WORLD",
  // 前置条件不满足通常是"世界还没到位"，不是技能坏了：重新观察再试。
  // 但前置条件求值本身抛异常是前置条件的代码有问题，得人来修。
  SKILL_PRECONDITION_FAILED: "STALE_WORLD",
  SKILL_PRECONDITION_EVALUATION_FAILED: "CONTRACT_BUG",

  // —— 距离：先走近 ——
  TARGET_OUT_OF_REACH: "OUT_OF_REACH",
  CRAFTING_TABLE_OUT_OF_REACH: "OUT_OF_REACH",
  CONTAINER_OUT_OF_REACH: "OUT_OF_REACH",
  FURNACE_OUT_OF_REACH: "OUT_OF_REACH",
  TARGET_OUT_OF_SAFE_RANGE: "OUT_OF_REACH",

  // —— 缺资源：这一类要生成补齐子任务 ——
  RECIPE_UNAVAILABLE: "MISSING_RESOURCE",
  ITEM_NOT_IN_INVENTORY: "MISSING_RESOURCE",
  ARMOR_ITEM_NOT_IN_INVENTORY: "MISSING_RESOURCE",
  INSUFFICIENT_MATERIALS: "MISSING_RESOURCE",
  TOOL_TIER_INSUFFICIENT: "MISSING_RESOURCE",

  // —— 偶发：重试有意义 ——
  COLLECT_BLOCKS_FAILED: "TRANSIENT",
  CRAFT_FAILED: "TRANSIENT",
  PLACE_BLOCK_FAILED: "TRANSIENT",
  CONTAINER_TRANSFER_FAILED: "TRANSIENT",
  ARMOR_EQUIP_FAILED: "TRANSIENT",
  SMELT_FAILED: "TRANSIENT",
  BOT_MOVEMENT_BUSY: "TRANSIENT",
  PATH_NOT_FOUND: "TRANSIENT",
  SKILL_TIMEOUT: "TRANSIENT",
  SKILL_HANDLER_FAILED: "TRANSIENT",
  // 适配器把底层错误原样抬上来：可能是抖动，重试一次是合理的第一步。
  SKILL_CAPABILITY_FAILED: "TRANSIENT",

  // —— 契约/接线问题：重试一万次也一样 ——
  SKILL_CAPABILITY_UNSUPPORTED: "UNSUPPORTED",
  SKILL_CAPABILITY_UNAVAILABLE: "UNSUPPORTED",
  SKILL_VERSION_UNAVAILABLE: "UNSUPPORTED",
  BLOCK_NAME_UNKNOWN: "UNSUPPORTED",
  ITEM_NAME_UNKNOWN: "UNSUPPORTED",
  ARMOR_ITEM_SLOT_MISMATCH: "CONTRACT_BUG",
  SKILL_CAPABILITY_INPUT_INVALID: "CONTRACT_BUG",
  SKILL_CAPABILITY_OUTPUT_INVALID: "CONTRACT_BUG",
  SKILL_CAPABILITY_REQUEST_INVALID: "CONTRACT_BUG",
  SKILL_CAPABILITY_UNDECLARED: "CONTRACT_BUG",
  SKILL_CAPABILITY_DENIED: "CONTRACT_BUG",
  SKILL_INPUT_INVALID: "CONTRACT_BUG",
  SKILL_OUTPUT_INVALID: "CONTRACT_BUG",
  SKILL_OUTPUT_NOT_SERIALIZABLE: "CONTRACT_BUG",
  SKILL_STATE_INVALID: "CONTRACT_BUG",
  SKILL_NOT_FOUND: "CONTRACT_BUG",
  SKILL_AUTH_MISMATCH: "CONTRACT_BUG",
  SKILL_AUTH_EXPIRED: "CONTRACT_BUG",
  SKILL_AUTH_CONTEXT_INVALID: "CONTRACT_BUG",
  TARGET_SERVER_PROFILE_MISMATCH: "CONTRACT_BUG",
  TARGET_DIMENSION_MISMATCH: "CONTRACT_BUG",

  // —— 规划结果：不是运行时故障，别当成 bug 报 ——
  // 这几条区分得很细，因为 category 会进日志和面板。把"配方表里推不出这个物品"
  // 标成 CONTRACT_BUG 会让人去查一个并不存在的接线问题；它其实是"当前知识不支持"。
  PLAN_ITEM_UNOBTAINABLE: "UNSUPPORTED",
  PLAN_TOOL_TIER_UNREACHABLE: "UNSUPPORTED",
  // 这几条相反：目标非法、配方成环、深度/步数爆了，都是输入或数据本身有问题。
  PLAN_GOAL_INVALID: "CONTRACT_BUG",
  PLAN_CYCLIC_DEPENDENCY: "CONTRACT_BUG",
  PLAN_DEPTH_EXCEEDED: "CONTRACT_BUG",
  PLAN_STEP_LIMIT_EXCEEDED: "CONTRACT_BUG",

  // —— 边界探测：拒绝在非隔离目标上探测是策略拒绝，不是缺陷 ——
  PROBE_TARGET_NOT_ISOLATED: "UNSUPPORTED",
});

function has(code: string, ...fragments: readonly string[]): boolean {
  return fragments.some((fragment) => code.includes(fragment));
}

type ShapeRule = Readonly<{
  when: (code: string) => boolean;
  category: FailureCategory;
}>;

/**
 * 形态兜底规则。数组顺序即优先级：越具体、越高优先级的语义先判。
 *
 * 这一层的存在理由写在文件头：错误码是 pattern 不是枚举，新技能会带来没进过表的码。
 * 与其一律 UNKNOWN → 直接上报人工，不如按结构给出一个保守但可执行的动作。
 * 每条规则都只认**结构**，不认具体技能，所以新技能沿用命名约定就能自动被覆盖。
 */
const SHAPE_RULES: readonly ShapeRule[] = Object.freeze([
  // 前缀是最强信号：整族错误码共享同一病因。
  { when: (code) => code.startsWith("POLICY_"), category: "POLICY_BLOCKED" },
  {
    when: (code) =>
      code.startsWith("SERVER_POLICY_") ||
      code.startsWith("PROBE_") ||
      code.startsWith("PLAN_") ||
      code.startsWith("RESOURCE_"),
    category: "CONTRACT_BUG",
  },
  // 安全/取消优先于一切：它不是故障，重试反而是错的。
  {
    when: (code) =>
      has(code, "CANCELLED", "CANCELED", "PAUSED", "STOPPING", "OFFLINE", "NOT_ONLINE", "INTERRUPT"),
    category: "SAFETY_INTERRUPT",
  },
  {
    when: (code) => has(code, "OUT_OF_REACH", "OUT_OF_RANGE", "TOO_FAR"),
    category: "OUT_OF_REACH",
  },
  {
    when: (code) =>
      has(code, "NOT_IN_INVENTORY", "INSUFFICIENT", "UNOBTAINABLE", "MISSING_", "NO_MATERIAL"),
    category: "MISSING_RESOURCE",
  },
  {
    when: (code) => has(code, "NOT_FOUND", "OCCUPIED", "NOT_CONFIRMED", "STALE", "CHANGED"),
    category: "STALE_WORLD",
  },
  {
    when: (code) => has(code, "UNSUPPORTED", "UNAVAILABLE", "NAME_UNKNOWN"),
    category: "UNSUPPORTED",
  },
  {
    when: (code) =>
      has(code, "INVALID", "MISMATCH", "UNDECLARED", "DENIED", "NOT_SERIALIZABLE", "FORBIDDEN"),
    category: "CONTRACT_BUG",
  },
  {
    when: (code) => has(code, "TIMEOUT", "BUSY", "FAILED", "TRANSIENT"),
    category: "TRANSIENT",
  },
]);

/** 分类依据。可观测性要的不只是结论，还有"凭什么"——未知码走了兜底得能看出来。 */
export const classificationSources = ["table", "shape", "default"] as const;

export type ClassificationSource = (typeof classificationSources)[number];

export type FailureClassification = Readonly<{
  /** 归一化后的错误码（去空白、转大写）。 */
  errorCode: string;
  category: FailureCategory;
  source: ClassificationSource;
  /** 该类别的完整恢复阶梯，末级恒为终止动作。 */
  ladder: readonly RecoveryAction[];
}>;

function normalizeCode(errorCode: string): string {
  return errorCode.trim().toUpperCase();
}

/** 把任意错误码归类。纯函数：同样输入恒定输出，无 IO、无时钟。 */
export function classifyFailure(errorCode: string): FailureClassification {
  const code = normalizeCode(errorCode);
  const explicit = EXPLICIT[code];
  if (explicit !== undefined) {
    return Object.freeze({
      errorCode: code,
      category: explicit,
      source: "table" as const,
      ladder: LADDERS[explicit],
    });
  }
  if (code.length > 0) {
    for (const rule of SHAPE_RULES) {
      if (!rule.when(code)) continue;
      return Object.freeze({
        errorCode: code,
        category: rule.category,
        source: "shape" as const,
        ladder: LADDERS[rule.category],
      });
    }
  }
  return Object.freeze({
    errorCode: code,
    category: "UNKNOWN" as const,
    source: "default" as const,
    ladder: LADDERS.UNKNOWN,
  });
}

export type RecoveryDecision = Readonly<{
  errorCode: string;
  category: FailureCategory;
  source: ClassificationSource;
  /** 这是第几次失败（1 起）。 */
  attempt: number;
  action: RecoveryAction;
  /** 走到终止级就不再重试了——调用方据此决定上报还是继续。 */
  terminal: boolean;
  /** 阶梯上还剩几级（不含当前级）。 */
  remainingRungs: number;
}>;

/**
 * 按失败次数在阶梯上取动作。第 1 次失败取第 1 级，第 2 次取第 2 级，
 * 超出阶梯长度则恒为末级（末级必为终止动作），所以重试次数天然有上限。
 *
 * attempt 非法时**向终止端失败**：宁可多上报一次，也不要因为一个 NaN
 * 把某类失败变成无限重试。
 */
export function planRecovery(errorCode: string, attempt: number): RecoveryDecision {
  const classification = classifyFailure(errorCode);
  const ladder = classification.ladder;
  const lastIndex = ladder.length - 1;
  const index = Number.isFinite(attempt)
    ? Math.min(Math.max(Math.floor(attempt), 1), ladder.length) - 1
    : lastIndex;
  const action = ladder[index] ?? "ESCALATE_TO_OPERATOR";
  return Object.freeze({
    errorCode: classification.errorCode,
    category: classification.category,
    source: classification.source,
    attempt: Number.isFinite(attempt) ? Math.max(Math.floor(attempt), 1) : index + 1,
    action,
    terminal: isTerminalRecoveryAction(action),
    remainingRungs: Math.max(0, lastIndex - index),
  });
}

/** 这个码值得再试一次吗——即阶梯首级是否非终止。 */
export function isRecoverableFailure(errorCode: string): boolean {
  const first = classifyFailure(errorCode).ladder[0];
  return first !== undefined && !isTerminalRecoveryAction(first);
}

/** 该类别的恢复阶梯（只读）。用于文档生成与测试断言。 */
export function recoveryLadderFor(category: FailureCategory): readonly RecoveryAction[] {
  return LADDERS[category];
}



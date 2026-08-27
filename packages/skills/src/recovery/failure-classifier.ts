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
  /**
   * 背包/容器装不下了，要先腾地方。
   *
   * 刻意不并入 MISSING_RESOURCE：那条阶梯第一级是 ACQUIRE_RESOURCES_THEN_RETRY，
   * 也就是"再去弄更多东西回来"——对一个已经装满的背包来说方向正好相反，会把
   * 卡死变成刷任务。装不下与缺东西是互为反面的两种失败，必须分开。
   */
  "INVENTORY_FULL",
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
  /** 腾出背包空间（存箱子/丢垃圾）再重试。宿主没有这个能力就如实走终止级。 */
  "FREE_INVENTORY_THEN_RETRY",
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
    // 先腾空间，再重新观察（可能是别人拿走了东西已经腾开了），最后放弃。
    INVENTORY_FULL: ladder(
      "FREE_INVENTORY_THEN_RETRY",
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
  // 能力执行期间掉线/被 L0 暂停：等恢复，不是技能坏了。
  SKILL_EXECUTION_INTERRUPTED: "SAFETY_INTERRUPT",

  COMBAT_OBSERVATION_UNAVAILABLE: "STALE_WORLD",
  COMBAT_OBSERVATION_PROFILE_MISMATCH: "CONTRACT_BUG",
  COMBAT_DRIVER_UNAVAILABLE: "UNSUPPORTED",
  COMBAT_REFLEX_NOT_CLEARED: "UNSUPPORTED",
  COMBAT_EXECUTION_RECEIPT_INVALID: "CONTRACT_BUG",
  COMBAT_EXECUTION_ACK_INVALID: "CONTRACT_BUG",
  COMBAT_ACTION_ADAPTER_UNAVAILABLE: "UNSUPPORTED",
  COMBAT_ROTATION_UNAVAILABLE: "UNSUPPORTED",
  COMBAT_WEAPON_NOT_IN_INVENTORY: "MISSING_RESOURCE",
  COMBAT_TOTEM_NOT_IN_INVENTORY: "MISSING_RESOURCE",
  COMBAT_NO_USABLE_WEAPON: "MISSING_RESOURCE",
  COMBAT_TARGET_NOT_FOUND: "STALE_WORLD",
  COMBAT_TARGET_OBSERVATION_STALE: "STALE_WORLD",
  COMBAT_HAZARD_OBSERVATION_UNAVAILABLE: "STALE_WORLD",
  COMBAT_MOVEMENT_BLOCKED_BY_HAZARD: "STALE_WORLD",
  COMBAT_MOVEMENT_NOT_REQUIRED: "STALE_WORLD",
  COMBAT_ACTION_EXECUTION_FAILED: "TRANSIENT",
  COMBAT_WEAPON_COOLDOWN: "POLICY_BLOCKED",
  COMBAT_ALREADY_DISENGAGED: "STALE_WORLD",
  COMBAT_NO_HOSTILE_TARGET: "STALE_WORLD",
  COMBAT_HEALTH_BELOW_ENGAGE_FLOOR: "SAFETY_INTERRUPT",
  COMBAT_TOTEM_RESERVE_INSUFFICIENT: "SAFETY_INTERRUPT",
  COMBAT_NO_TOTEM_AVAILABLE: "SAFETY_INTERRUPT",
  COMBAT_OUTNUMBERED: "SAFETY_INTERRUPT",
  COMBAT_GEAR_OUTCLASSED: "SAFETY_INTERRUPT",
  COMBAT_TOTEM_DEPLETED: "SAFETY_INTERRUPT",
  COMBAT_HEALTH_CRITICAL: "SAFETY_INTERRUPT",
  COMBAT_HEALTH_LOW: "SAFETY_INTERRUPT",
  COMBAT_CRYSTAL_THREAT: "SAFETY_INTERRUPT",
  COMBAT_RETREAT_REQUIRED: "SAFETY_INTERRUPT",
  // These are structured combat dispositions/reasons rather than faults, but
  // they remain classifiable if they cross a generic skill-failure boundary.
  COMBAT_TOTEM_REEQUIPPED: "STALE_WORLD",
  COMBAT_WEAPON_EQUIPPED: "STALE_WORLD",
  COMBAT_ROTATION_POLICY_CLIPPED: "POLICY_BLOCKED",
  COMBAT_ROTATION_IN_PROGRESS: "POLICY_BLOCKED",
  COMBAT_CLOSING_DISTANCE: "OUT_OF_REACH",
  COMBAT_NO_WEAPON: "MISSING_RESOURCE",
  COMBAT_OUT_OF_RANGE: "OUT_OF_REACH",

  // —— 世界状态过期：重新观察，别原样重试 ——
  REFERENCE_BLOCK_NOT_FOUND: "STALE_WORLD",
  PLACE_TARGET_OCCUPIED: "STALE_WORLD",
  PLACE_NOT_CONFIRMED: "STALE_WORLD",
  CRAFTING_TABLE_NOT_FOUND: "STALE_WORLD",
  CONTAINER_NOT_FOUND: "STALE_WORLD",
  FURNACE_NOT_FOUND: "STALE_WORLD",
  // 熔炉里有别人的东西、或炉内容物中途被改：都是世界变了，不是接线坏了。
  // 没有这两条显式项，FURNACE_NOT_EMPTY 会落到 UNKNOWN（把"炉子占着"升级给人工），
  // FURNACE_OUTPUT_MISMATCH 会被 "MISMATCH" 形态规则读成 CONTRACT_BUG（让人去查一个
  // 并不存在的 schema 问题）。重新观察后换一个空炉子才是对的下一步。
  FURNACE_NOT_EMPTY: "STALE_WORLD",
  FURNACE_OUTPUT_MISMATCH: "STALE_WORLD",
  SMELT_OUTPUT_NOT_CONFIRMED: "STALE_WORLD",
  BOT_POSITION_UNAVAILABLE: "STALE_WORLD",
  // 寻路自认为到了，但读回的真实距离仍超出 radius+0.5：世界模型与实际不符
  // （地形被改、被推开、目标本就进不去）。原样重投同一个 goal 会再短一次，
  // 所以下一步是重新观察。没有这条显式项它会落到 UNKNOWN，把"走近了但不够近"
  // 当成未知故障升级给人工。
  PATH_TARGET_NOT_REACHED: "STALE_WORLD",
  // A* 搜完了、确实没有路（pathfinder 的 `NoPath`）。这不是抖动：把同一个
  // goal 原样重投只会再搜一次同样的空，所以走 REOBSERVE 而不是 RETRY_SAME。
  // 它与下面的 COLLECT_PATH_SEARCH_EXHAUSTED 必须分开——后者根本没搜完，
  // 合并两者就等于用"预算不够"冒充"不可达"。
  COLLECT_TARGET_UNREACHABLE: "STALE_WORLD",
  // 前置条件不满足通常是"世界还没到位"，不是技能坏了：重新观察再试。
  // 但前置条件求值本身抛异常是前置条件的代码有问题，得人来修。
  SKILL_PRECONDITION_FAILED: "STALE_WORLD",
  SKILL_PRECONDITION_EVALUATION_FAILED: "CONTRACT_BUG",

  // —— 距离：先走近 ——
  // 背包装不下：形态规则也认得 "_FULL"，这里显式登记是因为它是最常见的一个，
  // 不该依赖兜底层——显式表出问题时兜底会静默改判，而这条必须稳定。
  INVENTORY_FULL: "INVENTORY_FULL",
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
  // 背包里没有任何东西能收获该方块（空手也不行）。缺的是工具，不是世界状态，
  // 所以重新观察毫无意义——得先去合成/取得工具。这条闸门同时是防 OOM 的：
  // 放进 collectblock 就会触发 mineflayer-tool equipForBlock 的无界递归
  // （详见 mineflayer-client.ts canHarvestWithInventory 的实测注释）。
  COLLECT_TOOL_MISSING: "MISSING_RESOURCE",
  // 熔炼在开炉前就查原料与燃料，两者都能靠补齐子计划解决（燃料同样是可规划物品）。
  SMELT_INPUT_INSUFFICIENT: "MISSING_RESOURCE",
  SMELT_FUEL_INSUFFICIENT: "MISSING_RESOURCE",

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
  // pathfinder 抛错常是一次性的（区块没加载、目标瞬时被占）：先原样重试。
  PATHFINDER_GOTO_FAILED: "TRANSIENT",
  // 思考预算用尽（pathfinder 的 `Timeout`）。它**没有**证明目标不可达：实测
  // 在 runtime 的 tickTimeout 下，一个 700ms 就判得出 noPath 的搜索会被切片到
  // 5010ms 后报 "Took to long to decide path to goal!"。所以只能按偶发处置——
  // 区块加载完、附近实体散开后再搜一次是有意义的第一步；TRANSIENT 的阶梯
  // 第二级本来就是 REOBSERVE，两次都不成会自然收敛到 ABORT。
  COLLECT_PATH_SEARCH_EXHAUSTED: "TRANSIENT",
  // collectblock 既不 resolve 也不 reject，被本层的界掐断。触发条件是掉落物
  // 捡拾没有收尾（collectAll 的 Entity 分支两条无界 await，详见
  // mineflayer-client.ts COLLECT_SETTLE_BUDGET_MS 的实测注释）——方块很可能
  // 已经挖掉了，只是物品还在地上。所以这是世界状态而不是契约缺陷：重新观察
  // 后再试是对的，原样重投则会对着已经消失的方块再搜一次。
  COLLECT_PICKUP_NOT_SETTLED: "STALE_WORLD",

  // A non-idempotent operation returned an outcome that cannot be proved safe
  // to replay. Never route this through a retry rung.
  NON_IDEMPOTENT_RESULT_UNCERTAIN: "CONTRACT_BUG",

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
  POLICY_ROUTE_SEGMENT_LIMIT: "POLICY_BLOCKED",
  POLICY_STRAIGHT_DOWN_FORBIDDEN: "POLICY_BLOCKED",
  POLICY_PARKOUR_FORBIDDEN: "POLICY_BLOCKED",
  POLICY_SPRINT_JUMP_FORBIDDEN: "POLICY_BLOCKED",
  POLICY_AIR_STRAFE_FORBIDDEN: "POLICY_BLOCKED",
  POLICY_FALL_TOO_FAR: "POLICY_BLOCKED",

  TRADE_DISABLED: "STALE_WORLD",
  // A price ceiling is a caller-supplied business constraint. Retrying the
  // same villager does not change that offer, so the caller must choose
  // another villager or a different budget.
  TRADE_PRICE_UNACCEPTABLE: "UNSUPPORTED",
  TRADE_ITEM_NOT_IN_INVENTORY: "MISSING_RESOURCE",
  VILLAGER_NOT_FOUND: "STALE_WORLD",
  VILLAGER_OUT_OF_REACH: "OUT_OF_REACH",
  TRADE_OFFER_NOT_FOUND: "STALE_WORLD",

  MINE_LAVA_ADJACENT: "SAFETY_INTERRUPT",
  MINE_VOID_RISK: "SAFETY_INTERRUPT",
  MINE_NO_TARGET: "STALE_WORLD",
  MINE_PLAN_MISMATCH: "CONTRACT_BUG",
  MINE_DIG_FAILED: "TRANSIENT",
  MINE_BLOCK_NOT_CONFIRMED: "STALE_WORLD",
  MINE_TARGET_OUT_OF_REACH: "OUT_OF_REACH",
  MINE_BACKFILL_MATERIAL_MISSING: "MISSING_RESOURCE",
  MINE_BACKFILL_FAILED: "TRANSIENT",
  MINE_PATH_FAILED: "TRANSIENT",
  BLUEPRINT_STEP_BLOCKED: "STALE_WORLD",
  BLUEPRINT_ANCHOR_INVALID: "CONTRACT_BUG",
  BLUEPRINT_MATERIAL_INSUFFICIENT: "MISSING_RESOURCE",
  ALL_CELLS_OUT_OF_REACH: "OUT_OF_REACH",
  RETREAT_IN_PROGRESS: "SAFETY_INTERRUPT",
  ALL_SORT_TARGETS_OUT_OF_REACH: "OUT_OF_REACH",
  SHULKER_OUT_OF_REACH: "OUT_OF_REACH",
  SITE_FACTS_INCOMPLETE: "STALE_WORLD",
  SITE_HARD_RULE_REJECTED: "UNSUPPORTED",
  SHELTER_RUNTIME_NOT_WIRED: "CONTRACT_BUG",
  SHELTER_RUNTIME_FAILED: "TRANSIENT",
  SHELTER_STEP_BLOCKED: "STALE_WORLD",

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
  // "装不下"必须排在 MISSING_RESOURCE 之前，卡点是 "INSUFFICIENT_SPACE"：
  // 缺料规则认裸 "INSUFFICIENT"，所以 SHULKER_INSUFFICIENT_SPACE 这类码顺序一颠倒
  // 就会被判成缺料，让 bot 背着装不下的东西再去采更多。空间不足与材料不足语义相反，
  // 必须由这条更具体的规则先认领。
  //
  // 只认容器语义的 FULL/SPACE/SLOT，不认裸 "_FULL"——AI_QUEUE_FULL
  // （ai-router 调度队列溢出）与背包无关，不该套用腾空间的阶梯。
  {
    when: (code) =>
      has(
        code,
        "INVENTORY_FULL",
        "CONTAINER_FULL",
        "NO_SPACE",
        "INSUFFICIENT_SPACE",
        "NO_FREE_SLOT",
      ),
    category: "INVENTORY_FULL",
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

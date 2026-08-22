/**
 * PacketMineController —— 反射级（R，≤50ms）并发破壳裁决。零 AI。
 *
 * 用途很窄：**在敌人周围的黑曜石/方块上挑最多两块同时开挖**，把对方的壳破开，
 * 让近战与水晶有落点（tactics §4 surround 的反制面）。挖哪一块、挖不挖，全部
 * 由确定性算术决定；AI 只能调策略阈值，不能指定方块。
 *
 * 四条纪律：
 *   1. **最多同时两块，且占用双手**。`MAX_CONCURRENT_MINE` 是运行时边界而不是
 *      默认值——策略给 3 直接拒绝构造。两块分别落在主手与副手，因此开挖等于
 *      **副手离手**。
 *   2. **副手冲突一律让图腾赢**。保命立场（preserve-life）交战期间副手永远属于
 *      图腾——哪怕此刻是空的，TotemManager 下一帧就要补上去（它是反射层最高
 *      抢占项）。这种局面直接拒绝开挖，不做"先挖一下再让回去"。被显式配置成
 *      `expendable` 的 bot 才允许把副手拿去挖；即便如此，只要调用方报出
 *      TotemManager 正在抢占，本模块同样立即让位。
 *   3. **不承诺任何"加速倍率"**。并发只把两块的墙钟从「相加」变成「取大」，这是
 *      纯算术；真实包速收益必须实测才算数（AGENTS.md §0.6，时序未实测不算数）。
 *      本模块既不内置硬度表也不估算破坏时间，`estimatedBreakMs` 由调用方按当前
 *      手持工具给出。
 *   4. **reach 从策略读，不写死常量**。`maximumReachDistance` 必须由调用方从当前
 *      生效的 ServerPolicy 注入；换了策略档位，行为随之改变。
 *
 * **反检测诚实声明**（AGENTS.md §0.4 / tactics §7）：按包节奏挖掘本身就是一个
 * 与人类操作不同的可观测模式。本模块只提供节流位（`minimumReplanIntervalMs`，
 * 建议再经 DeterministicJitter 抖动），**不声称规避任何检测**，残余封号风险由
 * 使用者承担。
 */

import {
  CombatReflexNotClearedError,
  type CombatReflexDecision,
} from "./reflex-clearance.js";
import {
  DEFAULT_SURVIVAL_STANCE,
  totemAbsenceForcesRetreat,
  validateSurvivalStance,
  type CombatSurvivalStance,
} from "./survival-stance.js";
import type { CombatVector3 } from "./threat-analyzer.js";

/** 用户给的硬上限：最高同时挖两个。策略越过这个数直接拒绝构造。 */
export const MAX_CONCURRENT_MINE = 2;

export type CombatMineCandidate = Readonly<{
  position: CombatVector3;
  /** 调用方按当前手持工具估算的破坏耗时（毫秒）。本模块不自己算硬度。 */
  estimatedBreakMs: number;
  /** 基岩一类挖不动的方块。 */
  unbreakable: boolean;
  /** 是否有对应工具。黑曜石没钻镐是"挖不动"，不是"慢"。 */
  hasMatchingTool: boolean;
  /** 该方块到目标的距离（格）。越贴身越先破——先开壳才有落点。 */
  distanceToTarget: number;
}>;

export type CombatMineSnapshot = Readonly<{
  evaluatedAtMs: number;
  selfPosition: CombatVector3;
  /** 是否正在交战。决定副手是否被图腾预留。 */
  engaged: boolean;
  /** RetreatController 要求压制进攻时不得开挖（§4：撤退优先级更高）。 */
  suppressOffense: boolean;
  /** TotemManager 本帧是否在抢占（直接传它的 `preempts`）。 */
  totemPreempting: boolean;
  candidates: readonly CombatMineCandidate[];
}>;

export type CombatMinePolicy = Readonly<{
  /** 并发块数，[1, MAX_CONCURRENT_MINE]。 */
  maximumConcurrent: number;
  /** 从当前生效的 ServerPolicy 注入的 reach（格），不得写死。 */
  maximumReachDistance: number;
  /** 两次开挖之间的最小间隔（毫秒）。0 表示不节流。 */
  minimumReplanIntervalMs: number;
  /** 存活立场。`expendable` 才允许把副手从图腾上拿走去挖。 */
  stance: CombatSurvivalStance;
  /** 是否排除没有对应工具的方块。false 时空手啃黑曜石也算候选。 */
  requireToolMatch: boolean;
}>;

export const DEFAULT_MINE_POLICY: CombatMinePolicy = {
  maximumConcurrent: MAX_CONCURRENT_MINE,
  // 4.5 不是本模块的常量，而是一个必须被 ServerPolicy 覆盖的保守占位值。
  maximumReachDistance: 4.5,
  // 一个 tick：同帧重复事件不该触发两次开挖。
  minimumReplanIntervalMs: 50,
  stance: DEFAULT_SURVIVAL_STANCE,
  requireToolMatch: true,
};

export type CombatMineRefusalCode =
  | "TOTEM_REEQUIP_PREEMPTS"
  | "RETREAT_IN_PROGRESS"
  | "TOTEM_OFFHAND_RESERVED"
  | "THROTTLED"
  | "NO_CANDIDATE"
  | "ALL_CANDIDATES_EXCLUDED";

export type CombatMineExclusionCode =
  | "UNBREAKABLE"
  | "OUT_OF_REACH"
  | "NO_MATCHING_TOOL"
  | "CONCURRENCY_CAP";

export type CombatMineExclusion = Readonly<{
  position: CombatVector3;
  reason: CombatMineExclusionCode;
}>;

export type CombatMineHand = "main" | "off";

export type CombatMineAssignment = Readonly<{
  position: CombatVector3;
  /** 第一块给主手，第二块给副手——这就是"占用双手"的具体形态。 */
  hand: CombatMineHand;
  estimatedBreakMs: number;
}>;

export type CombatMinePlan = Readonly<{
  evaluatedAtMs: number;
  /** 本帧要挖的方块，长度 ≤ 策略并发数；拒绝时为空。 */
  assignments: readonly CombatMineAssignment[];
  /** 未开挖的确定性原因；开挖时为 null。 */
  refusal: CombatMineRefusalCode | null;
  /** 是否双手都被占住。有 assignment 时必然 true。 */
  handsOccupied: boolean;
  /** 并发墙钟估算：取各块最大值。纯算术，不含任何包速加成。 */
  concurrentEstimateMs: number;
  /** 同样几块顺序挖的估算：求和。两者并列给出便于遥测比对。 */
  sequentialEstimateMs: number;
  /** 被排除的候选与原因，按候选原序。 */
  excluded: readonly CombatMineExclusion[];
}>;

export class PacketMineController {
  private readonly policy: CombatMinePolicy;
  private lastPlanAtMs: number | null = null;

  constructor(policy: CombatMinePolicy = DEFAULT_MINE_POLICY) {
    if (
      !Number.isInteger(policy.maximumConcurrent) ||
      policy.maximumConcurrent < 1 ||
      policy.maximumConcurrent > MAX_CONCURRENT_MINE ||

      !Number.isFinite(policy.maximumReachDistance) ||
      policy.maximumReachDistance <= 0 ||
      !Number.isFinite(policy.minimumReplanIntervalMs) ||
      policy.minimumReplanIntervalMs < 0 ||
      typeof policy.requireToolMatch !== "boolean"
    ) {
      throw new TypeError("挖掘策略越界，拒绝使用该策略。");
    }
    validateSurvivalStance(policy.stance);
    this.policy = policy;
  }

  /** 换服或重连后必须清掉节流记忆，否则拿上一场的时间戳压制开挖。 */
  reset(): void {
    this.lastPlanAtMs = null;
  }

  /**
   * 纯判定，探针之前即可调用与单测。**不足以授权真实对抗**——真实对抗走
   * `planForLiveCombat`。
   */
  plan(snapshot: CombatMineSnapshot): CombatMinePlan {
    validateMineSnapshot(snapshot);

    const refuse = (refusal: CombatMineRefusalCode): CombatMinePlan => ({
      evaluatedAtMs: snapshot.evaluatedAtMs,
      assignments: [],
      refusal,
      handsOccupied: false,
      concurrentEstimateMs: 0,
      sequentialEstimateMs: 0,
      excluded: [],
    });

    // 让位顺序是固定的：图腾 → 撤退 → 副手预留 → 节流。全部先于候选筛选，
    // 因为它们与挖什么无关，早退能省掉整轮几何计算。
    if (snapshot.totemPreempting) return refuse("TOTEM_REEQUIP_PREEMPTS");
    if (snapshot.suppressOffense) return refuse("RETREAT_IN_PROGRESS");
    // 保命立场交战期间副手属于图腾，占用双手的动作一律不批。
    if (snapshot.engaged && totemAbsenceForcesRetreat(this.policy.stance)) {
      return refuse("TOTEM_OFFHAND_RESERVED");
    }
    if (this.throttled(snapshot.evaluatedAtMs)) return refuse("THROTTLED");
    if (snapshot.candidates.length === 0) return refuse("NO_CANDIDATE");

    const excluded: CombatMineExclusion[] = [];
    const eligible: CombatMineCandidate[] = [];
    for (const candidate of snapshot.candidates) {
      const reason = this.exclusionFor(candidate, snapshot.selfPosition);
      if (reason === null) eligible.push(candidate);
      else excluded.push({ position: candidate.position, reason });
    }
    if (eligible.length === 0) {
      return {
        ...refuse("ALL_CANDIDATES_EXCLUDED"),
        excluded,
      };
    }

    // 排序：先破贴身的（开壳才有落点），同距取快的，再按坐标定序去掉平局歧义。
    const ordered = [...eligible].sort(
      (left, right) =>
        left.distanceToTarget - right.distanceToTarget ||
        left.estimatedBreakMs - right.estimatedBreakMs ||
        compareByPosition(left.position, right.position),
    );
    const taken = ordered.slice(0, this.policy.maximumConcurrent);
    for (const candidate of ordered.slice(this.policy.maximumConcurrent)) {
      excluded.push({ position: candidate.position, reason: "CONCURRENCY_CAP" });
    }

    const assignments: CombatMineAssignment[] = taken.map(
      (candidate, index) => ({
        position: candidate.position,
        hand: index === 0 ? "main" : "off",
        estimatedBreakMs: candidate.estimatedBreakMs,
      }),
    );

    return {
      evaluatedAtMs: snapshot.evaluatedAtMs,
      assignments,
      refusal: null,
      // 只要开挖就占双手：单块也占，因为副手必须空出来准备接第二块。
      handsOccupied: true,
      concurrentEstimateMs: Math.max(
        ...assignments.map(({ estimatedBreakMs }) => estimatedBreakMs),
      ),
      sequentialEstimateMs: assignments.reduce(
        (total, { estimatedBreakMs }) => total + estimatedBreakMs,
        0,
      ),
      excluded,
    };
  }

  /**
   * 真实对抗入口：时序未放行直接抛，不返回一个"看起来可用"的计划。
   * 这是 AGENTS.md §0.6 那道闸门在本模块的落点。
   */
  planForLiveCombat(
    snapshot: CombatMineSnapshot,
    clearance: CombatReflexDecision,
  ): CombatMinePlan {
    if (!clearance.cleared) {
      throw new CombatReflexNotClearedError(clearance.denial ?? "NO_PROBE_DATA");
    }
    return this.plan(snapshot);
  }

  /** 记录一次实际开挖。只有真的挖了才调用，否则节流记账会失真。 */
  recordPlanExecuted(nowMs: number): void {
    if (!Number.isFinite(nowMs)) {
      throw new TypeError("nowMs 必须是有限数。");
    }
    if (this.lastPlanAtMs !== null && nowMs < this.lastPlanAtMs) {
      // 时间倒流意味着调用方混用了两个时钟源，拒绝记账而不是静默接受。
      throw new RangeError("开挖时间早于上一次开挖，拒绝记账。");
    }
    this.lastPlanAtMs = nowMs;
  }

  private exclusionFor(
    candidate: CombatMineCandidate,
    selfPosition: CombatVector3,
  ): CombatMineExclusionCode | null {
    if (candidate.unbreakable) return "UNBREAKABLE";
    if (distanceBetween(selfPosition, candidate.position) >
      this.policy.maximumReachDistance) {
      return "OUT_OF_REACH";
    }
    if (this.policy.requireToolMatch && !candidate.hasMatchingTool) {
      return "NO_MATCHING_TOOL";
    }
    return null;
  }

  private throttled(nowMs: number): boolean {
    if (this.lastPlanAtMs === null) return false;
    if (this.policy.minimumReplanIntervalMs === 0) return false;
    return nowMs - this.lastPlanAtMs < this.policy.minimumReplanIntervalMs;
  }
}

function compareByPosition(left: CombatVector3, right: CombatVector3): number {
  return left.x - right.x || left.y - right.y || left.z - right.z;
}

function distanceBetween(from: CombatVector3, to: CombatVector3): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
}

function validateMineSnapshot(snapshot: CombatMineSnapshot): void {
  if (!Number.isFinite(snapshot.evaluatedAtMs)) {
    throw new TypeError("evaluatedAtMs 必须是有限数。");
  }
  validatePosition(snapshot.selfPosition, "selfPosition");
  for (const candidate of snapshot.candidates) {
    validatePosition(candidate.position, "candidate.position");
    if (
      !Number.isFinite(candidate.estimatedBreakMs) ||
      candidate.estimatedBreakMs < 0
    ) {
      throw new TypeError("estimatedBreakMs 必须是非负有限数。");
    }
    if (
      !Number.isFinite(candidate.distanceToTarget) ||
      candidate.distanceToTarget < 0
    ) {
      throw new TypeError("distanceToTarget 必须是非负有限数。");
    }
  }
}

function validatePosition(position: CombatVector3, label: string): void {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new TypeError(`${label} 必须是有限坐标。`);
  }
}

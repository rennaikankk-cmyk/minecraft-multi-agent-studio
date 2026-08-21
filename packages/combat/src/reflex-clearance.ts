/**
 * ReflexClearance —— 反射级（R，≤50ms）模块的准入闸门。**fail-closed**。
 *
 * AGENTS.md §0.6 / tactics §0：Mineflayer 无头环境能否稳定达到真实 PvP 需要的
 * <50ms 时序**是未验证假设**。所以 TotemManager、CrystalEngine、`manage.armor`
 * 这三个反射级模块**允许实现和单测，但不得在未过时序探针的情况下上真实对抗**。
 *
 * 这个类型就是那道闸门的代码形态，三条设计取舍：
 *   1. **默认拒绝**。没有实测数据 = 不放行，不是"先放行再观察"。缺字段、字段
 *      不是有限数、探针没跑过 —— 一律 denied。
 *   2. **只认实测数据**。放行需要真实采样的 p99 事件循环延迟与样本数；版本号、
 *      硬件型号、"应该够快"都不构成放行理由（对齐 capability `unknown`
 *      fail-closed 的既有纪律）。
 *   3. **决策与执行分离**。`decide()` 是纯函数，不缓存、不记时钟；调用方每次
 *      要真实对抗前都必须重新问一次，避免拿一次陈旧的放行跑一整晚。
 *
 * 判读顺序在 tactics §0 已经写死：探针不达标时**先复核负载假设 → 定位阻塞源 →
 * 移出主线程 → 最后才评估换栈**，不得提前拍板换栈。本模块只回答"能不能上"，
 * 不建议换栈。
 */

export type CombatReflexProbeReport = Readonly<{
  /** 探针实测的事件循环单帧抖动 p99（毫秒）。 */
  p99LoopDelayMs: number;
  /** 采样数；样本太少的"达标"没有意义。 */
  samples: number;
  /** 采样是否在多 bot + 寻路 + 扫描的并发负载下取得。 */
  underRepresentativeLoad: boolean;
  /** 采样所属的 ServerProfile；跨服数据不可平移（tactics §9）。 */
  serverProfileId: string;
}>;

export type CombatReflexDenialCode =
  | "NO_PROBE_DATA"
  | "P99_ABOVE_BUDGET"
  | "INSUFFICIENT_SAMPLES"
  | "LOAD_NOT_REPRESENTATIVE"
  | "SERVER_PROFILE_MISMATCH"
  | "MALFORMED_PROBE_DATA";

export type CombatReflexDecision = Readonly<{
  /** true 才允许反射级模块上真实对抗。 */
  cleared: boolean;
  /** 放行时为 null；拒绝时给确定性原因码。 */
  denial: CombatReflexDenialCode | null;
  /** 实际比对的预算值，便于日志与遥测。 */
  budgetMs: number;
}>;

/** 一个 Minecraft tick = 50ms，这是游戏机制决定的硬预算，不是可调偏好。 */
export const REFLEX_BUDGET_MS = 50;

/** 少于这个样本数的达标结论不可信。 */
const MINIMUM_PROBE_SAMPLES = 1_000;

/**
 * 纯函数。`report` 为 null 表示探针根本没跑过 —— 拒绝，而不是假设没问题。
 * `serverProfileId` 是当前连接的事实，与采样服号不符一律拒绝。
 */
export function decideReflexClearance(
  report: CombatReflexProbeReport | null,
  serverProfileId: string,
): CombatReflexDecision {
  const deny = (denial: CombatReflexDenialCode): CombatReflexDecision => ({
    cleared: false,
    denial,
    budgetMs: REFLEX_BUDGET_MS,
  });

  if (report === null) return deny("NO_PROBE_DATA");
  if (
    !Number.isFinite(report.p99LoopDelayMs) ||
    report.p99LoopDelayMs < 0 ||
    !Number.isInteger(report.samples) ||
    report.samples < 0 ||
    report.serverProfileId.trim().length === 0 ||
    serverProfileId.trim().length === 0
  ) {
    return deny("MALFORMED_PROBE_DATA");
  }
  if (report.serverProfileId !== serverProfileId) {
    return deny("SERVER_PROFILE_MISMATCH");
  }
  if (report.samples < MINIMUM_PROBE_SAMPLES) {
    return deny("INSUFFICIENT_SAMPLES");
  }
  if (!report.underRepresentativeLoad) {
    return deny("LOAD_NOT_REPRESENTATIVE");
  }
  if (report.p99LoopDelayMs > REFLEX_BUDGET_MS) {
    return deny("P99_ABOVE_BUDGET");
  }
  return { cleared: true, denial: null, budgetMs: REFLEX_BUDGET_MS };
}

/** 反射级模块拒绝在未放行状态下产出真实动作时抛出。 */
export class CombatReflexNotClearedError extends Error {
  readonly denial: CombatReflexDenialCode;

  constructor(denial: CombatReflexDenialCode) {
    super(`反射级时序未放行（${denial}），拒绝上真实对抗。`);
    this.name = "CombatReflexNotClearedError";
    this.denial = denial;
  }
}

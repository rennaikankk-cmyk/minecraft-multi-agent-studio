// ---------------------------------------------------------------------------
// CombatReactionLoopProbe —— 反射级时序探针的生产供给端。
//
// 之前没有任何宿主注入 `dependencies.combatReflexProbe`，反射级路径
// （TotemManager.decideForLiveCombat 等）一律以 NO_PROBE_DATA 拒绝——fail-closed
// 是对的，但"没测过"和"测过、确实不达标"在遥测上不可区分。
//
// 这个探针测量的是战斗反应循环自身的步长（每步 observation→engage→log 的
// 真实耗时，monotonic 时钟）：事件循环若被物理 tick/寻路/扫描挤占，步长
// 直接反映出来。刻意不做独立打点循环——多一个定时器本身就会改变被测负载。
//
// 诚实边界（对齐 packages/combat/src/reflex-clearance.ts 的契约）：
//   - 无样本 → report() 返回 null（NO_PROBE_DATA，fail-closed）；
//   - underRepresentativeLoad 恒 false：单 runtime 进程无法自证采样发生在
//     "多 bot + 寻路 + 扫描"的代表性并发负载下（wiring-pending：跨进程负载
//     关联）。因此该探针**不会**单凭自己的数据放行反射级模块——它把拒绝
//     原因从 NO_PROBE_DATA 升级为可解释的实测拒绝（INSUFFICIENT_SAMPLES /
//     LOAD_NOT_REPRESENTATIVE / P99_ABOVE_BUDGET），放行仍需操作员在代表性
//     负载下的实测报告。
// ---------------------------------------------------------------------------

import type { CombatReflexProbeReport } from "@minecraft-studio/combat";

/** 有界样本环：够算 p99（>1000 才可能过样本闸），又不无界吃内存。 */
const MAX_PROBE_SAMPLES = 2_048;

/** 供 runtime 依赖注入的探针源（报告读取 + 步长回填）。 */
export type CombatReflexProbeSource = Readonly<{
  report(serverProfileId: string): CombatReflexProbeReport | null;
  recordStepDurationMs(elapsedMs: number): void;
}>;

export class CombatReactionLoopProbe implements CombatReflexProbeSource {
  private readonly samples: number[] = [];
  private readonly maxSamples: number;

  constructor(options: Readonly<{ maxSamples?: number }> = {}) {
    this.maxSamples = options.maxSamples ?? MAX_PROBE_SAMPLES;
  }

  /** 战斗反应循环每步调用一次（monotonic 差值）；非法值丢弃不臆断。 */
  recordStepDurationMs(elapsedMs: number): void {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return;
    this.samples.push(elapsedMs);
    while (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  /**
   * 当前实测报告；零样本返回 null（fail-closed）。p99 取最近样本的经验分位。
   */
  report(serverProfileId: string): CombatReflexProbeReport | null {
    if (this.samples.length === 0 || serverProfileId.trim().length === 0) {
      return null;
    }
    const sorted = [...this.samples].sort((left, right) => left - right);
    const rank = Math.min(
      sorted.length,
      Math.max(1, Math.ceil(0.99 * sorted.length)),
    );
    const p99 = sorted[rank - 1] as number;
    return {
      p99LoopDelayMs: p99,
      samples: sorted.length,
      // 见文件头：代表性负载需跨进程证据，单 runtime 不自证——恒 false。
      underRepresentativeLoad: false,
      serverProfileId,
    };
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

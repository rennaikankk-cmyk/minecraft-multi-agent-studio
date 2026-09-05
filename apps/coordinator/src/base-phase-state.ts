// 基地阶段真值（Implementation Prompt V1 · Phase 1）：
// 自治生存 → 村庄 → 交易大厅流水线的 7 个阶段门。director 用它决定
// "钻套之后该干什么"；需求评估（survival-needs）只消费结构化布尔，
// 不再读自然语言状态。
//
// Production reads current evidence from the shared BaseRegistry. This class
// keeps historical milestones separately and exposes a boolean compatibility
// view. The in-memory fallback is for callers without an injected registry.

import type { SurvivalNeedKey } from "./survival-needs.js";

/** 7 个阶段门（顺序即流水线顺序）。 */
export const BASE_PHASE_KEYS = Object.freeze([
  "SHELTER_MINIMAL_READY",
  "BASE_SITE_RESERVED",
  "STARTER_BASE_ACTIVE",
  "FOOD_FACILITY_ACTIVE",
  "COBBLE_FACILITY_ACTIVE",
  "VILLAGE_SOURCE_VERIFIED",
  "TRADING_HALL_ACTIVE",
] as const);

export type BasePhaseKey = (typeof BASE_PHASE_KEYS)[number];

/** 阶段门快照：全布尔，可 JSON 序列化进日志/dashboard。 */
export type BasePhaseSnapshot = Readonly<Record<BasePhaseKey, boolean>>;

/** needKey 完成 → 阶段门的映射（唯一写入通道之一）。 */
const NEED_COMPLETION_PHASE: Readonly<Partial<Record<SurvivalNeedKey, BasePhaseKey>>> = Object.freeze({
  SHELTER: "SHELTER_MINIMAL_READY",
  BASE_SITE_SELECTION: "BASE_SITE_RESERVED",
  BASE_MAIN_CONSTRUCTION: "STARTER_BASE_ACTIVE",
  BASE_FACILITY_FARM: "FOOD_FACILITY_ACTIVE",
  BASE_FACILITY_COBBLE: "COBBLE_FACILITY_ACTIVE",
});

/** 全 false 的空快照（能力未接线的保守缺省）。 */
export function emptyBasePhaseSnapshot(): Record<BasePhaseKey, boolean> {
  return {
    SHELTER_MINIMAL_READY: false,
    BASE_SITE_RESERVED: false,
    STARTER_BASE_ACTIVE: false,
    FOOD_FACILITY_ACTIVE: false,
    COBBLE_FACILITY_ACTIVE: false,
    VILLAGE_SOURCE_VERIFIED: false,
    TRADING_HALL_ACTIVE: false,
  };
}

/** Explicit external true/false evidence overrides the compatibility cache. */
export type BasePhaseExternalSource = (botId: string) => Partial<BasePhaseSnapshot>;

export class BasePhaseTracker {
  private readonly completed = new Map<string, Set<BasePhaseKey>>();
  private readonly available = new Map<string, Set<BasePhaseKey>>();

  constructor(private readonly externalSource?: BasePhaseExternalSource) {}

  /** director 任务完成回调：needKey → 阶段门置位（幂等）。 */
  recordNeedCompletion(botId: string, needKey: SurvivalNeedKey): BasePhaseKey | null {
    const phase = NEED_COMPLETION_PHASE[needKey];
    if (!phase) return null;
    const set = this.completed.get(botId) ?? new Set<BasePhaseKey>();
    set.add(phase);
    this.completed.set(botId, set);
    // A completed construction task is a historical milestone. Production
    // availability comes from the injected registry's domain evidence.
    if (!this.externalSource && phase !== "FOOD_FACILITY_ACTIVE" && phase !== "COBBLE_FACILITY_ACTIVE") {
      this.forcePhase(botId, phase, true);
    }
    return phase;
  }

  /** 进程内直接置位（预置/回放测试用；幂等）。 */
  forcePhase(botId: string, phase: BasePhaseKey, value = true): void {
    const set = this.available.get(botId) ?? new Set<BasePhaseKey>();
    if (value) set.add(phase);
    else set.delete(phase);
    this.available.set(botId, set);
    if (value) {
      const history = this.completed.get(botId) ?? new Set<BasePhaseKey>();
      history.add(phase);
      this.completed.set(botId, history);
    }
  }

  /** Boolean compatibility view derived from current external evidence. */
  snapshotFor(botId: string): BasePhaseSnapshot {
    const snapshot: Record<BasePhaseKey, boolean> = emptyBasePhaseSnapshot();
    for (const key of this.available.get(botId) ?? []) snapshot[key] = true;
    if (this.externalSource) {
      const external = this.externalSource(botId);
      for (const key of BASE_PHASE_KEYS) {
        if (external[key] !== undefined) snapshot[key] = external[key] === true;
      }
    }
    return snapshot;
  }
}

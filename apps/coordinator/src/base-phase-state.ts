// 基地阶段真值（Implementation Prompt V1 · Phase 1）：
// 自治生存 → 村庄 → 交易大厅流水线的 7 个阶段门。director 用它决定
// "钻套之后该干什么"；需求评估（survival-needs）只消费结构化布尔，
// 不再读自然语言状态。
//
// 真值来源分两层，后者优先（世界真值 > 进程记忆）：
//   1. 进程内 needKey 完成态（SHELTER→shelterBuilt 的既有先例）：
//      重启后丢失 = 安全侧失败（重来一遍，不会跳阶段）。
//   2. 外部快照提供者（可选注入）：未来由 BaseRegistry/FacilityRegistry/
//      WorldMemory 持久化真值覆盖。当前构建流程尚未写入这些注册表
//      （BaseRegistry 无调用方），注入空真值会制造反向幽灵（永远"没基地"），
//      所以 Phase 1 只留接口、不在 main.ts 接线。

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

/** 外部世界真值提供者：返回的已置位门覆盖进程记忆，永不反向清除。 */
export type BasePhaseExternalSource = (botId: string) => Partial<BasePhaseSnapshot>;

export class BasePhaseTracker {
  private readonly completed = new Map<string, Set<BasePhaseKey>>();

  constructor(private readonly externalSource?: BasePhaseExternalSource) {}

  /** director 任务完成回调：needKey → 阶段门置位（幂等）。 */
  recordNeedCompletion(botId: string, needKey: SurvivalNeedKey): BasePhaseKey | null {
    const phase = NEED_COMPLETION_PHASE[needKey];
    if (!phase) return null;
    const set = this.completed.get(botId) ?? new Set<BasePhaseKey>();
    set.add(phase);
    this.completed.set(botId, set);
    return phase;
  }

  /** 进程内直接置位（预置/回放测试用；幂等）。 */
  forcePhase(botId: string, phase: BasePhaseKey, value = true): void {
    if (!value) return;
    const set = this.completed.get(botId) ?? new Set<BasePhaseKey>();
    set.add(phase);
    this.completed.set(botId, set);
  }

  /** 当前快照：进程记忆 ∪ 外部真值（外部只做并集，不清洗）。 */
  snapshotFor(botId: string): BasePhaseSnapshot {
    const snapshot: Record<BasePhaseKey, boolean> = emptyBasePhaseSnapshot();
    for (const key of this.completed.get(botId) ?? []) snapshot[key] = true;
    if (this.externalSource) {
      const external = this.externalSource(botId);
      for (const key of BASE_PHASE_KEYS) {
        if (external[key]) snapshot[key] = true;
      }
    }
    return snapshot;
  }
}

// ---------------------------------------------------------------------------
// tactics/snapshot.ts —— CombatSnapshot：一次战术裁决的全部输入（全字段带龄）。
//
// 快照是不可变纯数据：同一快照 + 同一 profile 必须得出同一裁决（可回放/可测试）。
// 风险预算（研究 §13）在这里推导，不进 utility——它调制权重而不是参与比较。
// ---------------------------------------------------------------------------

import type { EnemyBeliefState } from "./belief.js";
import type { RiskBudgetMode, TacticsProfile } from "./profile.js";

export type InventoryValueBand = "LOW" | "NORMAL" | "CRITICAL";

export type EscapeRoute = Readonly<{
  direction: Readonly<{ x: number; y: number; z: number }>;
  clearanceBlocks: number;
  blocked: boolean;
}>;

export type OurCombatState = Readonly<{
  health: number;
  absorption: number;
  food: number;
  /** 自身药水效果（客户端全知）。 */
  effects: readonly { id: string; amplifier: number; remainingMs: number }[];
  armor: Readonly<{ points: number; toughness: number; durabilityCritical: boolean }>;
  weapon: Readonly<{ id: string; cooldownProgress: number }>; // p∈[0,1]
  offhand: Readonly<{ item: string | null; totemReady: boolean }>;
  totemsAvailable: number;
  consumables: Readonly<{ goldenApples: number; healingPotions: number; shieldDurabilityOk: boolean }>;
  crystalMaterials: Readonly<{ crystals: number; obsidian: number; glowstone: number }>;
  onGround: boolean;
  inWater: boolean;
  position: Readonly<{ x: number; y: number; z: number }>;
  nearestCover: Readonly<{ distanceBlocks: number | null }>;
  escapeRoutes: readonly EscapeRoute[];
  pingMs: number;
  rttEstimateMs: number;
  recentSetbacks: number;
  /** 当前任务上下文（死亡成本输入）。 */
  goal: Readonly<{ criticalInventory: boolean; migrating: boolean }>;
  inventoryValueBand: InventoryValueBand;
  deathRecoveryFeasible: boolean;
  stance: "preserve-life" | "expendable" | "aggressive";
}>;

export type AllyObservation = Readonly<{
  entityId: number;
  username: string;
  distanceBlocks: number;
  /** 支援 ETA 估计（ms，保守上界）。 */
  etaMs: number | null;
  engagedWithTargetId: number | null;
}>;

export type CombatWorldFacts = Readonly<{
  dimension: "overworld" | "nether" | "end";
  /** 周边可用水晶位（枚举已由 crystal-engine 做过红线过滤）。 */
  crystalPlacementsAvailable: number;
  /** 敌方已放置的水晶/锚（威胁面）。 */
  enemyCrystalThreat: boolean;
  enemyAnchorThreat: boolean;
  hostileCount: number;
  /** 第二敌人接近的估计（研究反例 5）。 */
  reinforcementEtaMs: number | null;
}>;

export type PolicyContext = Readonly<{
  gameplayProfile: "anarchy_first" | "standard";
  /** compat 生效模式与门（Round 7 兼容层）。 */
  compatMode: string;
  explosiveCrystalGateOpen: boolean;
  respawnAnchorGateOpen: boolean;
  /** 服务器近窗拒绝/回拉信号数（uncertainty 惩罚输入）。 */
  serverRejectionSignals: number;
}>;

export type CombatSnapshot = Readonly<{
  nowMonotonicMs: number;
  stepMs: number;
  self: OurCombatState;
  target: EnemyBeliefState | null;
  otherEnemies: readonly EnemyBeliefState[];
  allies: readonly AllyObservation[];
  world: CombatWorldFacts;
  policy: PolicyContext;
}>;

/**
 * 动态风险预算（研究 §13.2）。规则：
 *  - DESPERATION 只由谓词触发（逃生路线全堵 + 低血），不允许 operator 常开；
 *  - PRESERVATION 由关键物资/迁移/不可回收死亡触发；
 *  - AGGRESSIVE 只在 operator 显式 aggressive 立场（或 anarchy+授权）下；
 *  - 默认 BALANCED——anarchy_first 允许高强度 ≠ 风险偏好永远最大。
 */
export function deriveRiskBudget(input: {
  self: OurCombatState;
  world: CombatWorldFacts;
  allies: readonly AllyObservation[];
  operatorAggressive: boolean;
}): RiskBudgetMode {
  const { self } = input;
  const escapeBlocked = self.escapeRoutes.length > 0 && self.escapeRoutes.every((route) => route.blocked);
  const lowHealth = self.health + self.absorption <= 6;
  if (escapeBlocked && lowHealth && input.world.hostileCount > 0) {
    return "DESPERATION";
  }
  if (self.goal.criticalInventory || self.goal.migrating || self.inventoryValueBand === "CRITICAL") {
    return "PRESERVATION";
  }
  if (input.operatorAggressive || self.stance === "aggressive") {
    return "AGGRESSIVE";
  }
  return "BALANCED";
}

/** 快照核心字段的新鲜度检查（selector 用它拦不可逆动作）。 */
export function snapshotStalenessMs(snapshot: CombatSnapshot): number {
  if (snapshot.target === null) return 0;
  return snapshot.nowMonotonicMs - snapshot.target.lastObservedAtMs;
}

export function escapeProbability(input: {
  self: OurCombatState;
  target: EnemyBeliefState | null;
}): number {
  const routes = input.self.escapeRoutes;
  if (routes.length === 0 || routes.every((route) => route.blocked)) return 0.05;
  const open = routes.filter((route) => !route.blocked);
  // 最优路线的净空决定基础概率；贴脸（<reach+1）打折——转身会吃背身刀。
  const best = Math.max(...open.map((route) => route.clearanceBlocks));
  const base = Math.min(0.9, 0.25 + best / 16);
  const distance = input.target !== null
    ? Math.hypot(
        input.target.position.x - input.self.position.x,
        input.target.position.y - input.self.position.y,
        input.target.position.z - input.self.position.z,
      )
    : Number.POSITIVE_INFINITY;
  const closeIn = distance < 4 ? 0.6 : 1;
  return base * closeIn;
}

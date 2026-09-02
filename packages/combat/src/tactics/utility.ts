// ---------------------------------------------------------------------------
// tactics/utility.ts —— 有界 Utility 战术评分器（研究 §11，纯函数）。
//
// 顺序即纪律：硬约束（§11.2）先于任何效用计算；效用项全部归一 [0,1]；
// 未校准权重来自 profile（tactics-v0-uncalibrated）——分数只用于**排序**，
// 绝不直接当概率输出。
// ---------------------------------------------------------------------------

import {
  applyDecay,
  probabilityHealthBelow,
  type EnemyBeliefState,
} from "./belief.js";
import {
  ATTACK_SPEED,
  BASE_DAMAGE,
  CRIT_MULTIPLIER,
  MAX_PROTECTION_REDUCTION,
  PLAYER_REACH_BLOCKS,
  TICK_MS,
  armorReduction,
  cooldownDamageMultiplier,
} from "./mechanics.js";
import type { TacticalActionId, TacticsProfile, RiskBudgetMode } from "./profile.js";
import {
  deriveRiskBudget,
  escapeProbability,
  snapshotStalenessMs,
  type CombatSnapshot,
  type OurCombatState,
} from "./snapshot.js";

export type HardBlockReason =
  | "NO_TARGET"
  | "POLICY_GATE"
  | "STALE_STATE"
  | "RED_LINE"
  | "PRECONDITION"
  /** 该动作由 Reflex 层独占拥有（如副手图腾换装），战术层只建议不裁决。 */
  | "REFLEX_OWNED";

export type ActionScore = Readonly<{
  action: TacticalActionId;
  utility: number;
  breakdown: Readonly<Record<string, number>>;
  hardBlockedBy: HardBlockReason | null;
}>;

export type UtilityVerdict = Readonly<{
  scores: readonly ActionScore[];
  /** 排除 hard-block 后的最高分动作。 */
  best: ActionScore | null;
  riskBudget: RiskBudgetMode;
  /** 供 Decision Evidence 的派生量。 */
  derived: Readonly<{
    ourTtkMs: Readonly<{ best: number; worst: number }> | null;
    ourTtdMs: Readonly<{ best: number; worst: number }>;
    enemyPDeadByNextHit: number;
    escapeP: number;
    killSecureGate: Readonly<{ open: boolean; failedChecks: readonly string[] }>;
  }>;
}>;

// ---------------------------------------------------------------------------
// 伤害/TTK/TTD 区间
// ---------------------------------------------------------------------------

function weaponRawDamageInterval(self: OurCombatState): Readonly<{ lo: number; hi: number }> {
  const base = BASE_DAMAGE.netheriteSword; // 宿主按 weapon.id 映射；缺省按剑
  const p = Math.min(1, Math.max(0, self.weapon.cooldownProgress));
  const multiplier = cooldownDamageMultiplier(p);
  const lo = base * multiplier;
  const hi = base * CRIT_MULTIPLIER * multiplier; // 暴击上界
  return { lo, hi };
}

/** 敌方减伤区间：armor 材质可见（points 确定），Protection 未知 → [armor-only, armor+80%]。 */
function enemyMitigationInterval(belief: EnemyBeliefState): Readonly<{ lo: number; hi: number }> {
  const armorPoints = armorPointsFor(belief);
  const toughness = 4 * Math.max(1, armorPiecesCount(belief));
  const mid = 7; // 代表性单发伤害（区间中值近似）
  const armorOnly = armorReduction(armorPoints, toughness, mid);
  return { lo: armorOnly, hi: Math.min(MAX_PROTECTION_REDUCTION, armorOnly + 0.64) };
}

function armorPointsFor(belief: EnemyBeliefState): number {
  // 材质→点值（wiki Armor）：无甲 0 /铁 15 /钻 20 /下界 20。剥 components 时按可见材质。
  const pieces = belief.equipment.armorPieces.filter((piece): piece is string => piece !== null);
  let points = 0;
  for (const piece of pieces) {
    if (piece.includes("netherite") || piece.includes("diamond")) points += 5;
    else if (piece.includes("iron") || piece.includes("chainmail")) points += 4;
    else if (piece.includes("leather") || piece.includes("gold")) points += 2;
  }
  return Math.min(20, points);
}

function armorPiecesCount(belief: EnemyBeliefState): number {
  return belief.equipment.armorPieces.filter((piece) => piece !== null).length;
}

export function netDamageInterval(
  self: OurCombatState,
  belief: EnemyBeliefState,
): Readonly<{ lo: number; hi: number }> {
  const raw = weaponRawDamageInterval(self);
  const mitigation = enemyMitigationInterval(belief);
  return {
    lo: raw.lo * (1 - mitigation.hi), // 保守：最大减伤
    hi: raw.hi * (1 - mitigation.lo), // 乐观：仅护甲
  };
}

/** 我方 TTK（击杀当前 belief 目标所需时间区间，ms）。 */
export function ourTtkMs(
  self: OurCombatState,
  belief: EnemyBeliefState,
): Readonly<{ best: number; worst: number }> | null {
  const net = netDamageInterval(self, belief);
  const lethalHi = belief.health.intervalHp.hi + belief.health.absorption.certainHp;
  const lethalLo = belief.health.intervalHp.lo + belief.health.absorption.certainHp;
  const hitsBest = Math.max(1, Math.ceil(lethalLo / Math.max(0.5, net.hi)));
  const hitsWorst = Math.max(1, Math.ceil(lethalHi / Math.max(0.5, net.lo)));
  const intervalMs = (1 / ATTACK_SPEED.sword) * 1000;
  return {
    best: hitsBest * intervalMs,
    worst: hitsWorst * intervalMs,
  };
}

/** 我方 TTD（被当前目标打死的估计区间，ms）——敌武器可见+我方护甲已知（点值）。 */
export function ourTtdMs(
  self: OurCombatState,
  belief: EnemyBeliefState,
): Readonly<{ best: number; worst: number }> {
  const enemyBase = belief.equipment.heldItem?.includes("axe") ? BASE_DAMAGE.netheriteAxe : BASE_DAMAGE.netheriteSword;
  const mitigation = armorReduction(self.armor.points, self.armor.toughness, enemyBase);
  const perHit = Math.max(0.5, enemyBase * CRIT_MULTIPLIER * (1 - mitigation));
  const hits = Math.max(1, Math.ceil((self.health + self.absorption) / perHit));
  const cadence = belief.attackCadence.meanIntervalMs ?? (1 / ATTACK_SPEED.sword) * 1000;
  const ourHpNow = self.health + self.absorption;
  if (ourHpNow <= 0) return { best: 0, worst: 0 };
  return {
    best: Math.max(TICK_MS, hits * cadence * 0.8),
    worst: hits * cadence * 1.4,
  };
}

// ---------------------------------------------------------------------------
// KILL_SECURE 候选谓词（研究 §11.3）
// ---------------------------------------------------------------------------

export function evaluateKillSecureGate(input: {
  snapshot: CombatSnapshot;
  profile: TacticsProfile;
  pDeadByNextHit: number;
  actionTimeToEffectMs: Readonly<{ lo: number; hi: number }>;
  escapeP: number;
}): Readonly<{ open: boolean; failedChecks: readonly string[] }> {
  const { snapshot, profile } = input;
  const failed: string[] = [];
  const belief = snapshot.target;
  if (belief === null) return { open: false, failedChecks: ["NO_TARGET"] };

  if (input.pDeadByNextHit < profile.killSecure.pKillThreshold) {
    failed.push(`P_KILL(${input.pDeadByNextHit.toFixed(2)}<${profile.killSecure.pKillThreshold})`);
  }
  const ttd = ourTtdMs(snapshot.self, belief);
  if (ttd.best - input.actionTimeToEffectMs.hi < profile.killSecure.ttdMarginMs) {
    failed.push(`TTD_MARGIN(${ttd.best - input.actionTimeToEffectMs.hi}ms<${profile.killSecure.ttdMarginMs}ms)`);
  }
  // 敌方高概率即疗/图腾：offhand 图腾在场、进食中、pop 窗口内。
  const totemLikely =
    belief.equipment.offhandItem?.includes("totem") === true ||
    belief.usingItem.kind === "EATING" ||
    belief.observedTotemPops > 0;
  if (totemLikely) failed.push("ENEMY_TOTEM_OR_HEAL_LIKELY");
  if (input.escapeP > profile.killSecure.escapePThreshold) {
    failed.push(`ESCAPE_SUPERIOR(${input.escapeP.toFixed(2)}>${profile.killSecure.escapePThreshold})`);
  }
  if (belief.confidence < profile.killSecure.confidenceThreshold) {
    failed.push(`CONFIDENCE(${belief.confidence.toFixed(2)}<${profile.killSecure.confidenceThreshold})`);
  }
  return { open: failed.length === 0, failedChecks: failed };
}

// ---------------------------------------------------------------------------
// 主评分器
// ---------------------------------------------------------------------------

export function scoreTacticalActions(
  snapshot: CombatSnapshot,
  profile: TacticsProfile,
): UtilityVerdict {
  const beliefRaw = snapshot.target;
  const belief =
    beliefRaw !== null ? applyDecay(beliefRaw, { nowMonotonicMs: snapshot.nowMonotonicMs, profile }) : null;
  const self = snapshot.self;
  const riskBudget = deriveRiskBudget({
    self,
    world: snapshot.world,
    allies: snapshot.allies,
    operatorAggressive: snapshot.policy.gameplayProfile === "anarchy_first" && self.stance === "aggressive",
  });
  const w = profile.weights;
  const deathCost = profile.deathCostMultiplier[riskBudget];

  const net = belief !== null ? netDamageInterval(self, belief) : { lo: 0, hi: 0 };
  const pDeadByNextHit = belief !== null
    ? probabilityHealthBelow(belief, net.hi + belief.health.absorption.certainHp)
    : 0;
  const ttd = belief !== null ? ourTtdMs(self, belief) : { best: 1e9, worst: 1e9 };
  const ttk = belief !== null ? ourTtkMs(self, belief) : null;
  const escapeP = escapeProbability({ self, target: belief });
  const staleness = snapshotStalenessMs(snapshot);
  const stale = staleness > profile.selector.staleSnapshotMs;
  const distance = belief !== null
    ? Math.hypot(
        belief.position.x - self.position.x,
        belief.position.y - self.position.y,
        belief.position.z - self.position.z,
      )
    : Number.POSITIVE_INFINITY;
  const inReach = distance <= PLAYER_REACH_BLOCKS;

  const killSecureGate = evaluateKillSecureGate({
    snapshot,
    profile,
    pDeadByNextHit,
    actionTimeToEffectMs: { lo: 180, hi: 300 },
    escapeP,
  });

  const pKillOverall = belief !== null
    ? Math.min(1, pDeadByNextHit * (ttk !== null ? Math.min(1, 2_000 / Math.max(500, ttk.best)) : 0))
    : 0;
  const uncertainty = belief !== null ? 1 - belief.confidence : 1;
  const serverPenalty = Math.min(1, snapshot.policy.serverRejectionSignals / 4 + self.recentSetbacks / 4);
  const pingPenalty = Math.min(1, Math.max(0, (self.rttEstimateMs - 150) / 600));

  const results: ActionScore[] = [];

  const push = (
    action: TacticalActionId,
    utility: number,
    breakdown: Record<string, number>,
    hardBlockedBy: HardBlockReason | null = null,
  ) => {
    results.push(Object.freeze({ action, utility, breakdown: Object.freeze(breakdown), hardBlockedBy }));
  };

  // —— 无目标：只有非敌对动作有意义 ——
  if (belief === null) {
    const healValue = self.health < 16 && self.consumables.goldenApples > 0 ? 0.7 : 0.2;
    push("HEAL", healValue, { pSurvive: 0.6, pKill: 0 });
    push("RECOVER_DROPS", 0.4, { objective: 0.4 });
    push("PROTECT_OBJECTIVE", self.goal.migrating ? 0.5 : 0.1, { objective: 0.5 });
    push("HOLD", 0.3, { pSurvive: 0.3 });
    push("PRESS", 0, { noTarget: 1 }, "NO_TARGET");
    push("DISENGAGE", 0.2, { pSurvive: 0.2 });
    return finish(results, { riskBudget, derived: { ourTtkMs: null, ourTtdMs: ttd, enemyPDeadByNextHit: 0, escapeP, killSecureGate } });
  }

  const common = {
    pKill: pKillOverall,
    uncertainty,
    escapeP,
    serverPenalty,
  };

  // —— PRESS：持续压制（可逆）——
  const pressBase =
    w.kill * pKillOverall * 0.8 +
    w.survive * (1 - 1 / ttd.best * 400) * 0.3; // TTD 越短压制价值越低
  push("PRESS", Math.max(0, pressBase - w.uncertainty * uncertainty * 0.3 - w.death * (1 / ttd.best) * deathCost * 200), {
    ...common,
    ttdBestMs: ttd.best,
  });

  // —— KILL_SECURE：不可逆冲刺；快照超龄使门评估本身失效（STALE 优先于门）——
  const ksBlock = stale
    ? "STALE_STATE"
    : killSecureGate.open ? null : "PRECONDITION";
  push(
    "KILL_SECURE",
    killSecureGate.open
      ? w.kill * pDeadByNextHit + w.survive * 0.4 - w.death * (1 - Math.min(1, ttd.best / 800)) * deathCost * 0.6 - w.uncertainty * uncertainty * 0.5
      : 0,
    { pKill: pDeadByNextHit, ttdBestMs: ttd.best, actionTteMs: 240, escapeP, gate: killSecureGate.open ? 1 : 0 },
    ksBlock,
  );

  // —— TRADE：接受换血（风险预算允许时）——
  const tradeRatio = ttk !== null ? Math.min(2, ttd.best / Math.max(300, ttk.best)) : 0;
  push("TRADE", riskBudget === "PRESERVATION"
    ? 0
    : w.kill * pKillOverall * 0.7 + tradeRatio * 0.4 - w.death * (1 / Math.max(400, ttd.best)) * deathCost * 300, {
    ...common,
    tradeRatio,
  }, riskBudget === "PRESERVATION" ? "PRECONDITION" : null);

  // —— RESET / REPOSITION / TAKE_COVER / HEAL：中庸族 ——
  push("RESET_DISTANCE", 0.35 + w.survive * escapeP * 0.5 + w.uncertainty * uncertainty * 0.2, { ...common });
  push("REPOSITION", self.nearestCover.distanceBlocks !== null && self.nearestCover.distanceBlocks < 10 ? 0.45 : 0.2, { ...common });
  push("TAKE_COVER", self.nearestCover.distanceBlocks !== null ? 0.3 + (1 - escapeP) * 0.3 : 0.05, { ...common });
  const healWindow = belief.usingItem.kind !== null || !inReach || escapeP > 0.5;
  push("HEAL",
    self.consumables.goldenApples > 0 && self.health <= 12
      ? (healWindow ? 0.75 : 0.25) * w.survive
      : 0.05,
    { ...common, healWindow: healWindow ? 1 : 0 });

  // —— 装备/武器/副手 ——
  push("SWITCH_WEAPON", belief.blockingWithShield && self.weapon.id.includes("sword") ? 0.6 : 0.15, { ...common });
  push("SWITCH_OFFHAND", self.totemsAvailable > 0 && !self.offhand.totemReady ? 0.9 : 0.1, { ...common }, "REFLEX_OWNED");
  // ↑ SWITCH_OFFHAND 由 Reflex 层硬规则拥有（TotemManager 抢占最高），战术层恒
  //   hard-block 防双头决策；分数仅供证据解释。

  // —— 暴击/WTAP 时序（ping 敏感）——
  push("CRIT_CHAIN", inReach && self.onGround && self.weapon.cooldownProgress > 0.85 ? 0.55 * (1 - pingPenalty) : 0.1, { ...common, pingPenalty });
  push("W_TAP_PRESSURE", inReach && self.onGround && self.weapon.cooldownProgress > 0.85 ? 0.5 * (1 - pingPenalty) : 0.1, { ...common, pingPenalty });

  // —— 水晶/锚：feature gate + 材料 + 红线（红线细节由 crystal-engine 枚举层把守）——
  const crystalFeasible =
    snapshot.policy.explosiveCrystalGateOpen &&
    snapshot.world.crystalPlacementsAvailable > 0 &&
    self.crystalMaterials.crystals > 0;
  push("CRYSTAL_ATTACK", crystalFeasible
    ? w.kill * probabilityHealthBelow(belief, 85 * 0.3) * 0.8 - w.damageTaken * 0.4 - w.uncertainty * uncertainty * 0.5
    : 0, { ...common }, crystalFeasible ? null : "POLICY_GATE");
  const anchorFeasible =
    snapshot.policy.respawnAnchorGateOpen &&
    snapshot.world.dimension !== "nether" &&
    self.crystalMaterials.glowstone > 0;
  push("ANCHOR_ATTACK", anchorFeasible
    ? w.kill * probabilityHealthBelow(belief, 49 * 0.3) * 0.8 - w.damageTaken * 0.4
    : 0, { ...common }, anchorFeasible ? null : "POLICY_GATE");

  // —— PACKETMINE：拆壳开路 ——
  push("PACKETMINE_ACTION", belief.blockingWithShield || distance > PLAYER_REACH_BLOCKS && distance < 8 ? 0.3 : 0.05, { ...common });

  // —— CHASE：双截断 + 距离衰减（P(catch) 随距离降）+ 地形惩罚（反例 14）——
  const chaseable = distance > PLAYER_REACH_BLOCKS && distance < 16 && belief.tracking === "IN_RANGE";
  const chaseDistanceFactor = chaseable ? Math.max(0.3, 1 - (distance - PLAYER_REACH_BLOCKS) / 20) : 0;
  push("CHASE", chaseable
    ? w.kill * pKillOverall * 0.6 * chaseDistanceFactor * (1 - pingPenalty) * (1 - serverPenalty) - 0.1
    : 0.05, { ...common, pingPenalty, serverPenalty, chaseDistanceFactor });

  // —— DISENGAGE ——
  push("DISENGAGE", w.survive * escapeP + w.death * deathCost * 0.15 * (1 - escapeP) - w.exposure * (self.goal.migrating ? 0.1 : 0), { ...common });

  // —— CALL_SUPPORT / PROTECT_OBJECTIVE ——
  const allyNear = snapshot.allies.some((ally) => ally.etaMs !== null && ally.etaMs < 8_000);
  push("CALL_SUPPORT", snapshot.allies.length > 0 && allyNear ? 0.5 : 0.05, { ...common });
  push("PROTECT_OBJECTIVE", self.goal.criticalInventory || self.goal.migrating ? 0.55 + w.objective * 0.3 : 0.05, { ...common });
  push("RECOVER_DROPS", self.health > 12 && distance > 12 ? 0.3 : 0.05, { ...common });
  push("HOLD", 0.1, { ...common });

  return finish(results, {
    riskBudget,
    derived: {
      ourTtkMs: ttk,
      ourTtdMs: ttd,
      enemyPDeadByNextHit: pDeadByNextHit,
      escapeP,
      killSecureGate,
    },
  });
}

function finish(
  results: readonly ActionScore[],
  rest: Omit<UtilityVerdict, "scores" | "best">,
): UtilityVerdict {
  const eligible = results.filter((score) => score.hardBlockedBy === null);
  const best = eligible.length > 0
    ? eligible.reduce((a, b) => (b.utility > a.utility ? b : a))
    : null;
  return Object.freeze({
    scores: Object.freeze(results),
    best,
    ...rest,
  });
}

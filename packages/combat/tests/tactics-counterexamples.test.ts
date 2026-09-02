// ---------------------------------------------------------------------------
// 15 个低血补刀 vs 撤退反例（docs/research/PVP_SYSTEM_RESEARCH.md §12）的判别式
// 固化。断言**排序判别**（must-not / must-beat / must-block），不锁绝对分数——
// 绝对值属于校准域（研究 §19），测试不预支未校准参数。
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";
import { scoreTacticalActions, type UtilityVerdict } from "../src/tactics/utility.js";
import { applyConfirmedHit, applyTotemPop } from "../src/tactics/belief.js";
import { DEFAULT_TACTICS_PROFILE } from "../src/tactics/profile.js";
import { beliefFixture as fx, selfFixture, snapshotFixture } from "./tactics-fixtures.js";
import type { EnemyBeliefState } from "../src/tactics/belief.js";
import type { OurCombatState } from "../src/tactics/snapshot.js";

function score(self: Partial<OurCombatState>, belief: EnemyBeliefState | null, extra: Parameters<typeof snapshotFixture>[0] = {}): UtilityVerdict {
  return scoreTacticalActions(
    snapshotFixture({ self: selfFixture(self), target: belief, ...extra }),
    DEFAULT_TACTICS_PROFILE,
  );
}

function s(v: UtilityVerdict, action: string) {
  const found = v.scores.find((x) => x.action === action);
  expect(found, action).toBeDefined();
  return found!;
}

/** 反例 1 前提：连续确认命中把 belief 压窄、置信度推高。 */
function batteredEnemy(lo: number, hi: number, confidence: number): EnemyBeliefState {
  let b = fx({ health: { ...fx().health, intervalHp: { lo: 18, hi: 20 } } });
  for (let i = 0; i < 6; i += 1) {
    b = applyConfirmedHit(b, { netDamage: { lo: 3, hi: 3 }, inIframeWindow: false, previousHitDamage: null, evidenceRef: `hit@${i}` });
  }
  return { ...b, health: { ...b.health, intervalHp: { lo, hi } }, confidence };
}

describe("研究 §12 十五个反例的判别", () => {
  it("1. 我4血敌[1,4]我ready在range → KILL_SECURE 胜过 DISENGAGE（低血≠撤退）", () => {
    const enemy = batteredEnemy(1, 4, 0.85);
    const v = score(
      { health: 4, escapeRoutes: [{ direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 0, blocked: true }] },
      { ...enemy, position: { x: 2, y: 64, z: 0 }, lastObservedAtMs: 10_000 },
    );
    expect(s(v, "KILL_SECURE").hardBlockedBy).toBeNull();
    expect(s(v, "KILL_SECURE").utility).toBeGreaterThan(s(v, "DISENGAGE").utility);
    expect(v.derived.killSecureGate.open).toBe(true);
  });

  it("2. 我4血敌完全未知 → KILL_SECURE 被 PRECONDITION 拦，reset 族胜过 PRESS", () => {
    const v = score(
      { health: 4, escapeRoutes: [{ direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 8, blocked: false }] },
      { ...fx({ confidence: 0.3, attackCadence: { samples: 5, meanIntervalMs: 625 } }), position: { x: 2.5, y: 64, z: 0 } },
    );
    expect(s(v, "KILL_SECURE").hardBlockedBy).toBe("PRECONDITION");
    const resetFamily = Math.max(s(v, "DISENGAGE").utility, s(v, "RESET_DISTANCE").utility, s(v, "TAKE_COVER").utility);
    expect(resetFamily).toBeGreaterThan(s(v, "PRESS").utility);
  });

  it("3. 我6血无图腾敌刚pop → KILL_SECURE 关（二次pop预算），DISENGAGE 不强制称王", () => {
    const enemy = applyTotemPop(fx(), { nowMonotonicMs: 9_800, evidenceRef: "pop@9800" });
    const v = score(
      { health: 6, totemsAvailable: 0 },
      { ...enemy, lastObservedAtMs: 10_000 },
    );
    expect(s(v, "KILL_SECURE").hardBlockedBy).toBe("PRECONDITION");
    expect(v.derived.killSecureGate.failedChecks).toContain("ENEMY_TOTEM_OR_HEAL_LIKELY");
  });

  it("4. 我低血敌逃跑无反击角度（超出reach+背身） → CHASE 不占优，HEAL/RECOVER 抬升", () => {
    const fleeing = { ...fx({ position: { x: 14, y: 64, z: 0 }, velocityInterval: { min: { x: 5, y: 0, z: 0 }, max: { x: 7.2, y: 0, z: 0 } } }) };
    const v = score(
      { health: 5, consumables: { goldenApples: 3, healingPotions: 0, shieldDurabilityOk: true }, escapeRoutes: [{ direction: { x: -1, y: 0, z: 0 }, clearanceBlocks: 10, blocked: false }] },
      fleeing,
    );
    expect(s(v, "CHASE").utility).toBeLessThan(s(v, "HEAL").utility);
    expect(v.best!.action).not.toBe("KILL_SECURE");
  });

  it("5. 我高血但 2v1 增援将至 → 敌变多改变裁决输入（hostileCount=2 进快照）", () => {
    const one = score({ health: 18 }, fx(), { world: { hostileCount: 1 } });
    const two = score({ health: 18 }, fx(), { world: { hostileCount: 2, reinforcementEtaMs: 3_000 } });
    // 增援在场时换血与追击的吸引力必须下降（death 项经 TTD/风险预算传导）。
    expect(s(two, "TRADE").utility).toBeLessThanOrEqual(s(one, "TRADE").utility);
    expect(two.riskBudget).not.toBe("AGGRESSIVE");
  });

  it("6. 我低血有掩体+治疗窗口 → HEAL 显著高于无窗口场景", () => {
    const far = { ...fx({ position: { x: 30, y: 64, z: 0 }, tracking: "EDGE" as const }) };
    const withWindow = score({ health: 4, nearestCover: { distanceBlocks: 3 } }, far, {});
    const noWindow = score({ health: 4, nearestCover: { distanceBlocks: null } }, { ...fx({ position: { x: 2, y: 64, z: 0 } }) });
    expect(s(withWindow, "HEAL").utility).toBeGreaterThan(s(noWindow, "HEAL").utility);
    expect(withWindow.best!.action).toBe("HEAL");
  });

  it("7. 我低血撤退路线被堵 → DESPERATION + DISENGAGE 优势崩塌，TRADE 反超", () => {
    const blocked = score(
      { health: 4, escapeRoutes: [{ direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 0, blocked: true }] },
      fx(),
    );
    expect(blocked.riskBudget).toBe("DESPERATION");
    expect(s(blocked, "TRADE").utility).toBeGreaterThan(s(blocked, "DISENGAGE").utility);
  });

  it("8. 携带关键物资 → PRESERVATION：KILL_SECURE 即便门开也受死亡成本压制", () => {
    const normal = score({ health: 6, goal: { criticalInventory: false, migrating: false } }, batteredEnemy(1, 4, 0.85));
    const cargo = score({ health: 6, goal: { criticalInventory: true, migrating: false }, inventoryValueBand: "CRITICAL" }, batteredEnemy(1, 4, 0.85));
    expect(cargo.riskBudget).toBe("PRESERVATION");
    // 同样门开的 KILL_SECURE，携货时优势幅度必须缩小（deathCost 乘 3）。
    const normalMargin = s(normal, "KILL_SECURE").utility - s(normal, "DISENGAGE").utility;
    const cargoMargin = s(cargo, "KILL_SECURE").utility - s(cargo, "DISENGAGE").utility;
    expect(cargoMargin).toBeLessThan(normalMargin);
  });

  it("9. 多Bot：队友ETA短 → CALL_SUPPORT 分数高于无队友场景", () => {
    const solo = score({ health: 4 }, fx(), { allies: [] });
    const supported = score({ health: 4 }, fx(), { allies: [{ entityId: 7, username: "Ally", distanceBlocks: 20, etaMs: 3_000, engagedWithTargetId: null }] });
    expect(s(supported, "CALL_SUPPORT").utility).toBeGreaterThan(s(solo, "CALL_SUPPORT").utility);
  });

  it("10. 敌低血但 offhand 图腾可见 → 门因即疗/图腾关闭", () => {
    const totemEnemy = fx({
      health: { ...fx().health, intervalHp: { lo: 1, hi: 4 } },
      equipment: { heldItem: "minecraft:netherite_sword", offhandItem: "minecraft:totem_of_undying", armorPieces: [], componentsStripped: false },
      confidence: 0.9,
    });
    const v = score({ health: 16 }, totemEnemy);
    expect(v.derived.killSecureGate.failedChecks).toContain("ENEMY_TOTEM_OR_HEAL_LIKELY");
    expect(s(v, "KILL_SECURE").hardBlockedBy).toBe("PRECONDITION");
  });

  it("11. 水晶可补刀但无图腾：门开时 CRYSTAL_ATTACK 可选，自伤由引擎红线把守（战术层只受 damageTaken 惩罚）", () => {
    const v = score(
      { health: 4, totemsAvailable: 0, crystalMaterials: { crystals: 4, obsidian: 8, glowstone: 0 } },
      batteredEnemy(1, 4, 0.85),
      { policy: { explosiveCrystalGateOpen: true }, world: { crystalPlacementsAvailable: 2 } },
    );
    expect(s(v, "CRYSTAL_ATTACK").hardBlockedBy).toBeNull();
    // 有自伤预期时 damageTaken 权重已在分数里；红线本体在 crystal-engine（既有测试覆盖）。
    expect(s(v, "CRYSTAL_ATTACK").utility).toBeGreaterThan(0);
  });

  it("12. ping 升高 → W_TAP/CRIT_CHAIN/CHASE 全部降权，TAKE_COVER 相对上升", () => {
    const good = score({ health: 14, rttEstimateMs: 80 }, fx());
    const bad = score({ health: 14, rttEstimateMs: 700 }, fx());
    expect(s(bad, "W_TAP_PRESSURE").utility).toBeLessThan(s(good, "W_TAP_PRESSURE").utility);
    expect(s(bad, "CRIT_CHAIN").utility).toBeLessThan(s(good, "CRIT_CHAIN").utility);
  });

  it("13. 连续 setback → CHASE 受 serverPenalty 压制", () => {
    const calm = score({ health: 14, recentSetbacks: 0, rttEstimateMs: 80 }, fx({ position: { x: 8, y: 64, z: 0 } }), { policy: { serverRejectionSignals: 0 } });
    const storm = score({ health: 14, recentSetbacks: 4, rttEstimateMs: 80 }, fx({ position: { x: 8, y: 64, z: 0 } }), { policy: { serverRejectionSignals: 4 } });
    expect(s(storm, "CHASE").utility).toBeLessThan(s(calm, "CHASE").utility);
  });

  it("14. 假撤退：目标超出reach+1但仍在追击带 → CHASE 分数低于贴身场景（截断惩罚的方向）", () => {
    const close = score({ health: 14 }, fx({ position: { x: 4, y: 64, z: 0 } }));
    const luring = score({ health: 14 }, fx({ position: { x: 15, y: 64, z: 0 } }));
    expect(s(luring, "CHASE").utility).toBeLessThan(s(close, "CHASE").utility);
    // 超出 16 格 → CHASE 不可选。
    const gone = score({ health: 14 }, fx({ position: { x: 30, y: 64, z: 0 } }));
    expect(s(gone, "CHASE").utility).toBeLessThanOrEqual(0.05);
  });

  it("15. 基地迁移中 → PROTECT_OBJECTIVE 抬升且 DISENGAGE 受 exposure 惩罚", () => {
    const normal = score({ health: 18 }, fx());
    const migrating = score({ health: 18, goal: { criticalInventory: false, migrating: true } }, fx());
    expect(s(migrating, "PROTECT_OBJECTIVE").utility).toBeGreaterThan(s(normal, "PROTECT_OBJECTIVE").utility);
    expect(migrating.riskBudget).toBe("PRESERVATION");
  });
});

describe("研究 §13 NO_TOTEM 常态", () => {
  it("无图腾不是错误：NO_TOTEM 下 PRESS/TRADE/RESET/DISENGAGE 全部仍可选", () => {
    const v = score({ health: 8, totemsAvailable: 0, offhand: { item: null, totemReady: false } }, fx());
    for (const action of ["PRESS", "TRADE", "RESET_DISTANCE", "DISENGAGE"]) {
      expect(s(v, action).hardBlockedBy, action).toBeNull();
    }
  });

  it("有图腾不改变可选集，只改变死亡成本输入（对比不炸）", () => {
    const noTotem = score({ health: 8, totemsAvailable: 0 }, fx());
    const withTotem = score({ health: 8, totemsAvailable: 2, offhand: { item: "minecraft:totem_of_undying", totemReady: true } }, fx());
    expect(noTotem.riskBudget).toBe(withTotem.riskBudget);
  });
});

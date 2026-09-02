// utility 评分器：TTK/TTD、KILL_SECURE 门、硬约束（研究 §11）。
import { describe, expect, it } from "vitest";
import { scoreTacticalActions, ourTtkMs, ourTtdMs, netDamageInterval, evaluateKillSecureGate } from "../src/tactics/utility.js";
import { DEFAULT_TACTICS_PROFILE } from "../src/tactics/profile.js";
import { applyConfirmedHit, beliefFixture } from "../src/tactics/index.js";
import { beliefFixture as fx, selfFixture, snapshotFixture } from "./tactics-fixtures.js";

function scoreOf(verdict: ReturnType<typeof scoreTacticalActions>, action: string) {
  return verdict.scores.find((s) => s.action === action);
}

describe("tactics/utility intervals", () => {
  it("净伤害区间：无甲敌 → 保守下界仍为正、暴击上界更大", () => {
    const net = netDamageInterval(selfFixture(), fx());
    expect(net.lo).toBeGreaterThan(0);
    expect(net.hi).toBeGreaterThan(net.lo);
  });

  it("满甲敌（下界合金四件）→ 净伤害显著缩水", () => {
    const armored = fx({ equipment: { heldItem: "minecraft:netherite_sword", offhandItem: null, armorPieces: ["netherite_helmet", "netherite_chestplate", "netherite_leggings", "netherite_boots"], componentsStripped: false } });
    const bare = fx();
    const netArmored = netDamageInterval(selfFixture(), armored);
    const netBare = netDamageInterval(selfFixture(), bare);
    expect(netArmored.hi).toBeLessThan(netBare.hi);
  });

  it("TTK：belief 越低所需时间越短（区间单调）", () => {
    const low = ourTtkMs(selfFixture(), fx({ health: { ...fx().health, intervalHp: { lo: 2, hi: 4 } } }));
    const high = ourTtkMs(selfFixture(), fx({ health: { ...fx().health, intervalHp: { lo: 16, hi: 20 } } }));
    expect(low!.best).toBeLessThan(high!.best);
    expect(low!.worst).toBeLessThan(high!.worst);
  });

  it("TTD：我方血越少 TTD 越短；无目标不炸", () => {
    const fresh = ourTtdMs(selfFixture({ health: 20 }), fx());
    const hurt = ourTtdMs(selfFixture({ health: 4 }), fx());
    expect(hurt.best).toBeLessThan(fresh.best);
    expect(ourTtdMs(selfFixture({ health: 0 }), fx()).best).toBe(0);
  });
});

describe("tactics/utility hard constraints", () => {
  it("无目标：PRESS hard-block NO_TARGET，非战斗动作可用", () => {
    const v = scoreTacticalActions(snapshotFixture({ target: null }), DEFAULT_TACTICS_PROFILE);
    expect(scoreOf(v, "PRESS")!.hardBlockedBy).toBe("NO_TARGET");
    expect(v.best).not.toBeNull();
    expect(["HEAL", "RECOVER_DROPS", "PROTECT_OBJECTIVE", "HOLD", "DISENGAGE"]).toContain(v.best!.action);
  });

  it("SWITCH_OFFHAND 恒 REFLEX_OWNED（防双头决策）", () => {
    const v = scoreTacticalActions(snapshotFixture(), DEFAULT_TACTICS_PROFILE);
    expect(scoreOf(v, "SWITCH_OFFHAND")!.hardBlockedBy).toBe("REFLEX_OWNED");
  });

  it("水晶/锚门关 → POLICY_GATE；门开+材料 → 可选", () => {
    const closed = scoreTacticalActions(snapshotFixture(), DEFAULT_TACTICS_PROFILE);
    expect(scoreOf(closed, "CRYSTAL_ATTACK")!.hardBlockedBy).toBe("POLICY_GATE");
    expect(scoreOf(closed, "ANCHOR_ATTACK")!.hardBlockedBy).toBe("POLICY_GATE");
    const open = scoreTacticalActions(
      snapshotFixture({
        policy: { explosiveCrystalGateOpen: true, respawnAnchorGateOpen: true },
        world: { crystalPlacementsAvailable: 2 },
        self: { crystalMaterials: { crystals: 4, obsidian: 8, glowstone: 4 } },
      }),
      DEFAULT_TACTICS_PROFILE,
    );
    expect(scoreOf(open, "CRYSTAL_ATTACK")!.hardBlockedBy).toBeNull();
    expect(scoreOf(open, "ANCHOR_ATTACK")!.hardBlockedBy).toBeNull();
  });

  it("锚在下界不可用作进攻（充能维度）", () => {
    const v = scoreTacticalActions(
      snapshotFixture({
        policy: { respawnAnchorGateOpen: true },
        world: { dimension: "nether" },
        self: { crystalMaterials: { crystals: 0, obsidian: 0, glowstone: 4 } },
      }),
      DEFAULT_TACTICS_PROFILE,
    );
    expect(scoreOf(v, "ANCHOR_ATTACK")!.hardBlockedBy).toBe("POLICY_GATE");
  });

  it("belief 超龄 → KILL_SECURE 被 STALE_STATE 拦", () => {
    const v = scoreTacticalActions(
      snapshotFixture({ nowMonotonicMs: 10_500, target: fx({ lastObservedAtMs: 9_000 }) }),
      DEFAULT_TACTICS_PROFILE,
    );
    expect(scoreOf(v, "KILL_SECURE")!.hardBlockedBy).toBe("STALE_STATE");
  });
});

describe("tactics/utility kill-secure gate", () => {
  function gateFor(opts: {
    pKill: number;
    ttdBest: number;
    escapeP: number;
    confidence: number;
    totemOffhand?: boolean;
  }) {
    const snapshot = snapshotFixture({
      target: fx({ confidence: opts.confidence, equipment: { heldItem: "minecraft:netherite_sword", offhandItem: opts.totemOffhand ? "minecraft:totem_of_undying" : null, armorPieces: [], componentsStripped: false } }),
    });
    return evaluateKillSecureGate({
      snapshot,
      profile: DEFAULT_TACTICS_PROFILE,
      pDeadByNextHit: opts.pKill,
      actionTimeToEffectMs: { lo: 180, hi: 300 },
      escapeP: opts.escapeP,
    });
  }

  it("全条件满足 → 门开", () => {
    const gate = gateFor({ pKill: 0.9, ttdBest: 800, escapeP: 0.1, confidence: 0.9 });
    expect(gate.open).toBe(true);
  });

  it("P(kill) 不足 → 关，并给出失败项", () => {
    const gate = gateFor({ pKill: 0.3, ttdBest: 800, escapeP: 0.1, confidence: 0.9 });
    expect(gate.open).toBe(false);
    expect(gate.failedChecks.join(" ")).toContain("P_KILL");
  });

  it("置信度不足 → 关（研究反例 2 的核心：未知血量不押换命）", () => {
    const gate = gateFor({ pKill: 0.9, ttdBest: 800, escapeP: 0.1, confidence: 0.4 });
    expect(gate.open).toBe(false);
    expect(gate.failedChecks.join(" ")).toContain("CONFIDENCE");
  });

  it("敌 offhand 图腾可见 → 关（反例 10）", () => {
    const gate = gateFor({ pKill: 0.9, ttdBest: 800, escapeP: 0.1, confidence: 0.9, totemOffhand: true });
    expect(gate.open).toBe(false);
    expect(gate.failedChecks).toContain("ENEMY_TOTEM_OR_HEAL_LIKELY");
  });

  it("逃生路线优良 → 关（撤退优于换命）", () => {
    const gate = gateFor({ pKill: 0.9, ttdBest: 800, escapeP: 0.9, confidence: 0.9 });
    expect(gate.open).toBe(false);
    expect(gate.failedChecks.join(" ")).toContain("ESCAPE_SUPERIOR");
  });
});

describe("tactics/utility behavioral", () => {
  it("低血+无逃生 → DISENGAGE 分数不占优（反例 7 的方向）", () => {
    const cornered = scoreTacticalActions(
      snapshotFixture({
        self: selfFixture({ health: 4, escapeRoutes: [{ direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 0, blocked: true }] }),
        target: fx(),
      }),
      DEFAULT_TACTICS_PROFILE,
    );
    const roomy = scoreTacticalActions(
      snapshotFixture({
        self: selfFixture({ health: 4, escapeRoutes: [{ direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 12, blocked: false }] }),
        target: fx(),
      }),
      DEFAULT_TACTICS_PROFILE,
    );
    expect(scoreOf(roomy, "DISENGAGE")!.utility).toBeGreaterThan(scoreOf(cornered, "DISENGAGE")!.utility);
    // 被堵时风险预算进 DESPERATION。
    expect(roomy.riskBudget).not.toBe("DESPERATION");
    expect(cornered.riskBudget).toBe("DESPERATION");
  });

  it("关键物资 → PRESERVATION（反例 8）且 TRADE 被拦", () => {
    const v = scoreTacticalActions(
      snapshotFixture({ self: selfFixture({ goal: { criticalInventory: true, migrating: false } }) }),
      DEFAULT_TACTICS_PROFILE,
    );
    expect(v.riskBudget).toBe("PRESERVATION");
    expect(scoreOf(v, "TRADE")!.hardBlockedBy).toBe("PRECONDITION");
  });

  it("ping 恶化 → 时序类动作（W_TAP/CRIT/CHASE）降权", () => {
    // W_TAP/CRIT 需在 reach 内（≤3 格）；CHASE 需在 reach 外（>3 格）。
    const closeTarget = fx({ position: { x: 2, y: 64, z: 0 } });
    const chaseTarget = fx({ position: { x: 5, y: 64, z: 0 } });
    const goodClose = scoreTacticalActions(snapshotFixture({ self: selfFixture({ rttEstimateMs: 80 }), target: closeTarget }), DEFAULT_TACTICS_PROFILE);
    const badClose = scoreTacticalActions(snapshotFixture({ self: selfFixture({ rttEstimateMs: 700 }), target: closeTarget }), DEFAULT_TACTICS_PROFILE);
    const goodChase = scoreTacticalActions(snapshotFixture({ self: selfFixture({ rttEstimateMs: 80 }), target: chaseTarget }), DEFAULT_TACTICS_PROFILE);
    const badChase = scoreTacticalActions(snapshotFixture({ self: selfFixture({ rttEstimateMs: 700 }), target: chaseTarget }), DEFAULT_TACTICS_PROFILE);
    expect(scoreOf(badClose, "W_TAP_PRESSURE")!.utility).toBeLessThan(scoreOf(goodClose, "W_TAP_PRESSURE")!.utility);
    expect(scoreOf(badClose, "CRIT_CHAIN")!.utility).toBeLessThan(scoreOf(goodClose, "CRIT_CHAIN")!.utility);
    expect(scoreOf(badChase, "CHASE")!.utility).toBeLessThan(scoreOf(goodChase, "CHASE")!.utility);
  });

  it("服务器拒绝信号 → 追击/压制受损（反例 13 方向）", () => {
    const chaseTarget2 = fx({ position: { x: 5, y: 64, z: 0 } });
    const calm = scoreTacticalActions(snapshotFixture({ target: chaseTarget2 }), DEFAULT_TACTICS_PROFILE);
    const storm = scoreTacticalActions(
      snapshotFixture({ policy: { serverRejectionSignals: 4 }, self: selfFixture({ recentSetbacks: 4 }), target: chaseTarget2 }),
      DEFAULT_TACTICS_PROFILE,
    );
    expect(scoreOf(storm, "CHASE")!.utility).toBeLessThan(scoreOf(calm, "CHASE")!.utility);
  });

  it("确定性：同快照同 profile 字节级同输出", () => {
    const snapshot = snapshotFixture();
    const a = JSON.stringify(scoreTacticalActions(snapshot, DEFAULT_TACTICS_PROFILE));
    const b = JSON.stringify(scoreTacticalActions(snapshot, DEFAULT_TACTICS_PROFILE));
    expect(a).toBe(b);
  });
});

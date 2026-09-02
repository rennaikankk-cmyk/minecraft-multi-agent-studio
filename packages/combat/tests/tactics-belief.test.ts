// belief 更新规则（研究 §8.2 的铁律全部表驱动验证）。
import { describe, expect, it } from "vitest";
import {
  applyConfirmedHit,
  applyDecay,
  applyObservedHeal,
  applyTotemPop,
  applyTrustedScoreboardHealth,
  initialEnemyBelief,
  lethalDamageThreshold,
  popWindowActive,
  probabilityHealthBelow,
} from "../src/tactics/belief.js";
import { DEFAULT_TACTICS_PROFILE } from "../src/tactics/profile.js";
import { beliefFixture } from "./tactics-fixtures.js";

describe("tactics/belief initial prior", () => {
  it("新目标是 [8,20] 均匀分布、低置信、无吸收", () => {
    const b = initialEnemyBelief({ entityId: 1, uuid: null, username: "a", classification: "HOSTILE", nowMonotonicMs: 0, position: { x: 0, y: 0, z: 0 } });
    expect(b.health.intervalHp).toEqual({ lo: 8, hi: 20 });
    expect(b.health.distribution).toBe("UNIFORM");
    expect(b.confidence).toBeLessThan(0.5);
    expect(b.health.absorption.certainHp).toBe(0);
  });

  it("不假装知道：先验绝不是点值", () => {
    const b = initialEnemyBelief({ entityId: 1, uuid: null, username: "a", classification: "UNKNOWN", nowMonotonicMs: 0, position: { x: 0, y: 0, z: 0 } });
    expect(b.health.distribution).not.toBe("POINT");
    expect(b.health.pointSource.kind).toBeNull();
  });
});

describe("tactics/belief confirmed hits", () => {
  it("确认命中按区间扣减：hi 用 dmg.lo、lo 用 dmg.hi（保守向）", () => {
    const b = beliefFixture({ health: { ...beliefFixture().health, intervalHp: { lo: 16, hi: 20 } } });
    const next = applyConfirmedHit(b, { netDamage: { lo: 4, hi: 9 }, inIframeWindow: false, previousHitDamage: null, evidenceRef: "hit@10000" });
    expect(next.health.intervalHp).toEqual({ lo: 16 - 9, hi: 20 - 4 });
  });

  it("连续确认命中可以把 belief 压到 [1,4]（反例 1 的前提）", () => {
    let b = beliefFixture({ health: { ...beliefFixture().health, intervalHp: { lo: 18, hi: 20 } } });
    for (let i = 0; i < 4; i += 1) {
      b = applyConfirmedHit(b, { netDamage: { lo: 4, hi: 6 }, inIframeWindow: false, previousHitDamage: null, evidenceRef: `hit@${10000 + i}` });
    }
    expect(b.health.intervalHp.lo).toBeLessThanOrEqual(4);
    expect(b.health.intervalHp.hi).toBeGreaterThanOrEqual(0);
  });

  it("铁律 1：未确认命中没有入口——库不提供 whiff 扣减 API", () => {
    // whiff/格挡路径根本不存在扣减函数；确认命中必须显式传区间。
    const b = beliefFixture();
    const next = applyConfirmedHit(b, { netDamage: { lo: 0, hi: 0 }, inIframeWindow: false, previousHitDamage: null, evidenceRef: "hit@1" });
    expect(next.health.intervalHp).toEqual({ lo: 8, hi: 20 });
  });

  it("铁律 2：i-frame 窗口内且上一击未知 → 只记证据不扣减", () => {
    const b = beliefFixture();
    const next = applyConfirmedHit(b, { netDamage: { lo: 5, hi: 8 }, inIframeWindow: true, previousHitDamage: null, evidenceRef: "hit@2" });
    expect(next.health.intervalHp).toEqual({ lo: 8, hi: 20 });
    expect(next.evidenceRefs).toContain("hit@2");
  });

  it("i-frame 差值规则：上一击已知 → 只结算超出部分", () => {
    const b = beliefFixture();
    const next = applyConfirmedHit(b, { netDamage: { lo: 9, hi: 12 }, inIframeWindow: true, previousHitDamage: { lo: 5, hi: 7 }, evidenceRef: "hit@3" });
    // 区间差值：lo = max(0, 9-7)=2, hi = max(0, 12-5)=7
    expect(next.health.intervalHp).toEqual({ lo: 8 - 7, hi: 20 - 2 });
  });

  it("扣减后 confidence 单调不降", () => {
    const b = beliefFixture({ confidence: 0.3 });
    const next = applyConfirmedHit(b, { netDamage: { lo: 4, hi: 6 }, inIframeWindow: false, previousHitDamage: null, evidenceRef: "hit@4" });
    expect(next.confidence).toBeGreaterThan(b.confidence);
  });
});

describe("tactics/belief healing / totem / trusted source", () => {
  it("金苹果治疗：上界扩张、lo 不动、吸收标记 possible", () => {
    const b = beliefFixture({ health: { ...beliefFixture().health, intervalHp: { lo: 4, hi: 8 } } });
    const next = applyObservedHeal(b, { kind: "GOLDEN_APPLE", completedAtMs: 10_000, evidenceRef: "heal@1" });
    expect(next.health.intervalHp.lo).toBe(4);
    expect(next.health.intervalHp.hi).toBe(8 + 8); // regen 4 + absorption 4
    expect(next.health.absorption.possible).toBe(true);
  });

  it("药水治疗：上界 +8（Instant Health II）", () => {
    const b = beliefFixture({ health: { ...beliefFixture().health, intervalHp: { lo: 4, hi: 6 } } });
    const next = applyObservedHeal(b, { kind: "HEALING_POTION", completedAtMs: 10_000, evidenceRef: "heal@2" });
    expect(next.health.intervalHp.hi).toBe(14);
  });

  it("图腾 pop：重置 [1,5]、确定吸收 4、pop 计数 +1、窗口开启", () => {
    const b = beliefFixture({ health: { ...beliefFixture().health, intervalHp: { lo: 10, hi: 20 } } });
    const next = applyTotemPop(b, { nowMonotonicMs: 12_000, evidenceRef: "pop@12000" });
    expect(next.health.intervalHp).toEqual({ lo: 1, hi: 5 });
    expect(next.health.absorption.certainHp).toBe(4);
    expect(next.observedTotemPops).toBe(1);
    expect(popWindowActive(next, 13_000)).toBe(true);
    expect(popWindowActive(next, 20_000)).toBe(false);
  });

  it("信任源：操作员信任服记分板 → POINT；未信任服调用直接抛", () => {
    const b = beliefFixture();
    expect(() => applyTrustedScoreboardHealth(b, { hp: 7, trustedServer: false as unknown as true, evidenceRef: "sb@1" })).toThrow();
    const next = applyTrustedScoreboardHealth(b, { hp: 7, trustedServer: true, evidenceRef: "sb@2" });
    expect(next.health.distribution).toBe("POINT");
    expect(next.health.intervalHp).toEqual({ lo: 7, hi: 7 });
  });
});

describe("tactics/belief decay & probability", () => {
  it("无证据超时：区间向全宽扩张、confidence 下降", () => {
    const b = beliefFixture({ lastObservedAtMs: 0, confidence: 0.8, health: { ...beliefFixture().health, intervalHp: { lo: 2, hi: 6 } } });
    const next = applyDecay(b, { nowMonotonicMs: 5_000, profile: DEFAULT_TACTICS_PROFILE });
    expect(next.health.intervalHp.lo).toBeLessThan(2);
    expect(next.health.intervalHp.hi).toBeGreaterThan(6);
    expect(next.confidence).toBeLessThan(0.8);
  });

  it("新鲜观察不衰减", () => {
    const b = beliefFixture({ lastObservedAtMs: 9_500 });
    const next = applyDecay(b, { nowMonotonicMs: 10_000, profile: DEFAULT_TACTICS_PROFILE });
    expect(next).toBe(b);
  });

  it("概率单调：P(hp≤x) 随 x 递增且端点为 0/1", () => {
    const b = beliefFixture();
    expect(probabilityHealthBelow(b, 0)).toBe(0);
    expect(probabilityHealthBelow(b, 8)).toBe(0);
    expect(probabilityHealthBelow(b, 20)).toBe(1);
    const mid = probabilityHealthBelow(b, 14);
    expect(mid).toBeGreaterThan(probabilityHealthBelow(b, 10));
    expect(mid).toBeLessThan(probabilityHealthBelow(b, 18));
  });

  it("三角分布向低端集中（pop 后）", () => {
    const uniform = beliefFixture();
    const tri = beliefFixture({ health: { ...beliefFixture().health, distribution: "TRIANGULAR_PEAK_LO", intervalHp: { lo: 1, hi: 5 } } });
    const pUniform = probabilityHealthBelow(uniform, 14);
    const pTri = probabilityHealthBelow(tri, 3);
    expect(pTri).toBeGreaterThan(pUniform * 0.8); // 低端概率显著
    expect(probabilityHealthBelow(tri, 5)).toBe(1);
  });

  it("击穿预算 = 区间上界 + 确定吸收", () => {
    const b = applyTotemPop(beliefFixture(), { nowMonotonicMs: 1, evidenceRef: "pop@1" });
    expect(lethalDamageThreshold(b)).toBe(5 + 4);
  });
});

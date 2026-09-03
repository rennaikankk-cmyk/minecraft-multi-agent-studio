// 死亡恢复测试：价值判断、连续死亡惩罚、recovery goal 生成。
import { describe, expect, it } from "vitest";
import {
  DeathStreakTracker,
  assessDropRecovery,
  buildDropRecoveryGoal,
} from "../src/death-recovery.js";

describe("assessDropRecovery", () => {
  const base = {
    drops: [{ itemId: "diamond", count: 5 }],
    diedAtMs: 10_000,
    nowMs: 20_000,
    distanceBlocks: 50,
    deathStreak: 1,
    sameDimension: true,
  };

  it("高价值近距离 → shouldRecover", () => {
    const result = assessDropRecovery(base);
    expect(result.shouldRecover).toBe(true);
    expect(result.totalValue).toBe(500);
  });

  it("跨维度 → 不恢复", () => {
    const result = assessDropRecovery({ ...base, sameDimension: false });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("dimension");
  });

  it("超时 → 不恢复", () => {
    const result = assessDropRecovery({ ...base, nowMs: 400_000 });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("despawn");
  });

  it("连续死亡 3 次 → 停止送装备", () => {
    const result = assessDropRecovery({ ...base, deathStreak: 3 });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("streak 3");
  });

  it("连续死亡 2 次 + 低价值 → 不值得冒险", () => {
    const result = assessDropRecovery({ ...base, deathStreak: 2, drops: [{ itemId: "cobblestone", count: 10 }] });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("streak 2");
  });

  it("低价值远距离 → 不恢复", () => {
    const result = assessDropRecovery({ ...base, drops: [{ itemId: "dirt", count: 5 }], distanceBlocks: 100 });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("low value");
  });

  it("走不到就消失 → 不恢复", () => {
    const result = assessDropRecovery({ ...base, distanceBlocks: 2500 });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("despawn");
  });

  it("高风险 + 低价值 + 已死过 → 不恢复", () => {
    const result = assessDropRecovery({ ...base, distanceBlocks: 300, drops: [{ itemId: "iron_ingot", count: 3 }], deathStreak: 1 });
    expect(result.shouldRecover).toBe(false);
    expect(result.reason).toContain("risk");
  });

  it("中价值近距离 → 恢复", () => {
    const result = assessDropRecovery({ ...base, drops: [{ itemId: "iron_ingot", count: 10 }] });
    expect(result.shouldRecover).toBe(true);
    expect(result.totalValue).toBe(100);
  });
});

describe("DeathStreakTracker", () => {
  it("递增计数", () => {
    const t = new DeathStreakTracker({ now: () => 1_000 });
    expect(t.recordDeath()).toBe(1);
    expect(t.recordDeath()).toBe(2);
    expect(t.recordDeath()).toBe(3);
    expect(t.streak).toBe(3);
  });

  it("reset 清零", () => {
    const t = new DeathStreakTracker({ now: () => 1_000 });
    t.recordDeath();
    t.recordDeath();
    t.reset();
    expect(t.streak).toBe(0);
  });

  it("超窗自动清除", () => {
    let time = 1_000;
    const t = new DeathStreakTracker({ now: () => time, resetWindowMs: 5_000 });
    t.recordDeath(); // t=1000
    time = 3_000;
    t.recordDeath(); // t=3000
    expect(t.streak).toBe(2);
    time = 7_999; // 7999-3000=4999 < 5000 → 保留；7999-1000=6999 > 5000 → 清除
    expect(t.streak).toBe(1);
    time = 8_001; // 8001-3000=5001 > 5000 → 全清
    expect(t.streak).toBe(0);
  });
});

describe("buildDropRecoveryGoal", () => {
  it("生成确定性 goal 文本", () => {
    const goal = buildDropRecoveryGoal({ deathX: 100, deathY: 64, deathZ: -200 });
    expect(goal).toContain("x=100");
    expect(goal).toContain("y=64");
    expect(goal).toContain("z=-200");
    expect(goal).toContain("回收死亡掉落物");
  });
});

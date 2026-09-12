import { describe, expect, it } from "vitest";

import {
  assessAdjacentFluids,
  assessBedUse,
  assessDepth,
  assessFall,
  assessOverhead,
  assessSafetyFlags,
  assessStraightDown,
  dimensionHazardProfiles,
  fallDamagePoints,
  hazardProfileFor,
  isRefusalHazard,
  mostSevereVerdict,
  SAFE_FALL_BLOCKS,
  unknownDimensionHazardProfile,
} from "../src/commons/index.js";

// ---------------------------------------------------------------------------
// commons/hazards 的知识断言。这些数字（-64 / 31 / 0..4 / 3 格）是**事实**，
// 测试的作用是钉死它们：谁改实现就得先改测试，而改测试必须给出处。
// ---------------------------------------------------------------------------

describe("commons/hazards — 逐维度危险面", () => {
  it("记住主世界世界下界 y=-64、规划地板 y=-48", () => {
    const overworld = hazardProfileFor("minecraft:overworld");
    expect(overworld.hardFloor).toBe(-64);
    expect(overworld.planningFloor).toBe(-48);
    expect(overworld.lavaSeaLevel).toBeNull();
    expect(overworld.bedExplodes).toBe(false);
  });

  it("记住下界岩浆海 y=31、基岩地板 y=0，且有基岩顶", () => {
    const nether = hazardProfileFor("minecraft:the_nether");
    expect(nether.lavaSeaLevel).toBe(31);
    expect(nether.hardFloor).toBe(0);
    expect(nether.bedrockCeiling).toBe(true);
    expect(nether.bedExplodes).toBe(true);
  });

  it("记住末地 y=0 以下即虚空，且床会爆炸", () => {
    const end = hazardProfileFor("minecraft:the_end");
    expect(end.hardFloor).toBe(0);
    expect(end.bedExplodes).toBe(true);
  });

  it("未知维度按最保守档处理（fail-closed），不抛错", () => {
    expect(hazardProfileFor("minecraft:a_modded_dimension")).toBe(unknownDimensionHazardProfile);
    expect(unknownDimensionHazardProfile.bedExplodes).toBe(true);
  });
});

describe("commons/hazards — 高度裁决", () => {
  it.each([
    ["minecraft:overworld", -65, "VOID_FLOOR"],
    ["minecraft:overworld", -64, "VOID_FLOOR"],
    ["minecraft:overworld", -50, "DEEP_DANGER_ZONE"],
    ["minecraft:overworld", 64, null],
    ["minecraft:the_nether", 0, "VOID_FLOOR"],
    ["minecraft:the_nether", -1, "VOID_FLOOR"],
    ["minecraft:the_nether", 31, "LAVA_SEA"],
    ["minecraft:the_nether", 30, "LAVA_SEA"],
    ["minecraft:the_nether", 32, "DEEP_DANGER_ZONE"],
    ["minecraft:the_nether", 64, null],
    ["minecraft:the_nether", 127, "BEDROCK_CEILING"],
    ["minecraft:the_end", 0, "VOID_FLOOR"],
    ["minecraft:the_end", 64, null],
  ] as const)("%s y=%s → %s", (dimension, y, expected) => {
    const codes = assessDepth(y, dimension);
    if (expected === null) {
      expect(codes).toEqual([]);
    } else {
      expect(codes).toContain(expected);
    }
  });

  it("下界岩浆海只在硬地板之上判定，虚空优先", () => {
    expect(assessDepth(-3, "minecraft:the_nether")).toEqual(["VOID_FLOOR"]);
  });
});

describe("commons/hazards — 坠落伤害阈值（3 格）", () => {
  it.each([
    [0, 0],
    [1, 0],
    [2, 0],
    [3, 0],
    [4, 1],
    [5, 2],
    [23, 20],
  ])("%s 格下落 → %s 点伤害", (blocks, damage) => {
    expect(fallDamagePoints(blocks)).toBe(damage);
  });

  it("恰好 3 格安全，4 格起必须拒绝", () => {
    expect(SAFE_FALL_BLOCKS).toBe(3);
    expect(assessFall(3, 8)).toMatchObject({ allowed: true, damagePoints: 0 });
    expect(assessFall(4, 8)).toMatchObject({ allowed: false, code: "FALL_DAMAGE", damagePoints: 1 });
  });

  it("未超过原版阈值但超过策略上限时，报的是策略码", () => {
    expect(assessFall(3, 2)).toMatchObject({ allowed: false, code: "FALL_BEYOND_POLICY", damagePoints: 0 });
    expect(assessFall(2, 2)).toMatchObject({ allowed: true });
  });
});

describe("commons/hazards — 挖矿/流体/睡觉", () => {
  it("垂直下挖永远是拒绝级", () => {
    expect(assessStraightDown()).toEqual(["DIG_STRAIGHT_DOWN"]);
    expect(isRefusalHazard("DIG_STRAIGHT_DOWN")).toBe(true);
  });

  it("掏头顶：破块即提醒，上方有流体/重力方块时加重", () => {
    expect(assessOverhead({ breaking: false })).toEqual([]);
    expect(assessOverhead({ breaking: true })).toEqual(["HOLLOW_OVERHEAD"]);
    expect(assessOverhead({ breaking: true, fluidAbove: true })).toContain("DIG_INTO_LAVA");
    expect(assessOverhead({ breaking: true, gravityBlockAbove: true })).toContain("FALL_DAMAGE");
  });

  it("贴着岩浆挖 = 拒绝级；贴着水挖 = 提醒级", () => {
    expect(assessAdjacentFluids({ lavaAdjacent: true, waterAdjacent: false })).toEqual([
      "LAVA_ADJACENT",
      "DIG_INTO_LAVA",
    ]);
    expect(isRefusalHazard("LAVA_ADJACENT")).toBe(true);
    expect(isRefusalHazard("WATER_ADJACENT")).toBe(false);
  });

  it("安全位：voidRisk 是拒绝级，waterAdjacent 单独出现只是提醒", () => {
    expect(assessSafetyFlags({ lavaAdjacent: false, waterAdjacent: true, voidRisk: false })).toEqual(["WATER_ADJACENT"]);
    expect(assessSafetyFlags({ lavaAdjacent: false, waterAdjacent: false, voidRisk: true })).toEqual(["VOID_RISK"]);
    expect(isRefusalHazard("VOID_RISK")).toBe(true);
  });

  it("床在下界与末地会爆炸，在主世界安全", () => {
    expect(assessBedUse("minecraft:the_nether")).toMatchObject({ allowed: false, codes: ["BED_EXPLODES"] });
    expect(assessBedUse("minecraft:the_end")).toMatchObject({ allowed: false, codes: ["BED_EXPLODES"] });
    expect(assessBedUse("minecraft:overworld")).toMatchObject({ allowed: true, codes: [] });
    expect(assessBedUse("minecraft:the_nether").dimensions).toEqual(["minecraft:the_nether", "minecraft:the_end"]);
  });

  it("代表码取最严重的一个，顺序稳定", () => {
    expect(mostSevereVerdict(["WATER_ADJACENT", "VOID_RISK", "LAVA_SEA"])).toBe("LAVA_SEA");
    expect(mostSevereVerdict([])).toBe("SAFE");
  });

  it("每个维度的危险面都带全部字段（表本身不会漂移）", () => {
    for (const profile of dimensionHazardProfiles) {
      expect(profile.planningFloor).toBeGreaterThanOrEqual(profile.hardFloor);
      expect(profile.dimension).toMatch(/^minecraft:[a-z_]+$/u);
    }
  });
});

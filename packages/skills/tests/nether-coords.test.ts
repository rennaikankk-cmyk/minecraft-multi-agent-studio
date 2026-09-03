// nether-coords 测试：1:8 换算单源、floor 语义、候选区。
import { describe, expect, it } from "vitest";
import {
  NETHER_COORDINATE_RATIO,
  NETHER_ROOF_STAND_Y,
  isNetherDimension,
  netherToOverworld,
  overworldCandidateRegion,
  overworldToNether,
  regionContains,
} from "../src/nether-coords.js";

describe("netherToOverworld / overworldToNether", () => {
  it("下界→主世界水平 1:8，y 原样", () => {
    const result = netherToOverworld({ x: 100, y: 70, z: -50 });
    expect(result).toEqual({ x: 800, y: 70, z: -400 });
  });

  it("主世界→下界用 floor（负坐标 -1/8 落 -1 而非 0）", () => {
    expect(overworldToNether({ x: -1, y: 64, z: 7 })).toEqual({ x: -1, y: 64, z: 0 });
    expect(overworldToNether({ x: -8, y: 64, z: 64 })).toEqual({ x: -1, y: 64, z: 8 });
  });

  it("往返一致（floor 后再乘 8 回到块对齐点）", () => {
    const overworld = { x: 12_345, y: 64, z: -6_789 };
    const nether = overworldToNether(overworld);
    const back = netherToOverworld(nether);
    expect(Math.abs(back.x - overworld.x)).toBeLessThan(NETHER_COORDINATE_RATIO);
    expect(Math.abs(back.z - overworld.z)).toBeLessThan(NETHER_COORDINATE_RATIO);
    expect(back.y).toBe(overworld.y);
  });
});

describe("overworldCandidateRegion", () => {
  it("中心=理想落点，半径=搜索半径+余量", () => {
    const region = overworldCandidateRegion({ x: 10, y: 70, z: -20 }, 128, 32);
    expect(region.centerX).toBe(80);
    expect(region.centerZ).toBe(-160);
    expect(region.radiusBlocks).toBe(160);
  });

  it("regionContains 水平判定（含边界）", () => {
    const region = overworldCandidateRegion({ x: 0, y: 70, z: 0 }, 100, 0);
    expect(regionContains(region, { x: 100, z: 0 })).toBe(true);
    expect(regionContains(region, { x: 101, z: 0 })).toBe(false);
  });
});

describe("常量", () => {
  it("roof 站立面与基岩顶一致（128=127 上表面）", () => {
    expect(NETHER_ROOF_STAND_Y).toBe(128);
    expect(isNetherDimension("minecraft:the_nether")).toBe(true);
    expect(isNetherDimension("minecraft:overworld")).toBe(false);
  });
});

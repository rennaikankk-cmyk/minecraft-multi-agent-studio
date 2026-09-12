import { describe, expect, it } from "vitest";

import {
  blockReachDistance,
  CRAFTING_TABLE_GRID_SIZE,
  FARMLAND_HYDRATION_RADIUS,
  FARMLAND_TILES_PER_WATER,
  HOSTILE_SPAWN_BLOCK_LIGHT,
  INVENTORY_GRID_SIZE,
  isHydrated,
  MAX_TORCH_SPACING,
  maxTorchSpacingFor,
  requiresCraftingTable,
  stationRequirements,
  TORCH_LIGHT_LEVEL,
  torchOffsets,
  VANILLA_BLOCK_REACH,
  withinVanillaReach,
} from "../src/commons/index.js";
import { stationPlanSkill } from "../src/builtin/station-plan.js";

// ---------------------------------------------------------------------------
// 触及距离 / 火把间距 / 农田水化 / 站点摆放要求。
// 这些数字是"动手之前必须先算一遍"的硬约束，测试把它们钉死。
// ---------------------------------------------------------------------------

const scope = { serverProfileId: "isolated-local", dimension: "minecraft:overworld" };
const state = {
  online: true,
  normalActionsAllowed: true,
  retreatInProgress: false,
  serverProfileId: "isolated-local",
  position: { x: 0.5, y: 64, z: 0.5, dimension: "minecraft:overworld", serverProfileId: "isolated-local" },
};

describe("commons/placement — 触及距离", () => {
  it("原版上限 4.5 格，量的是到方块**中心**的距离", () => {
    expect(VANILLA_BLOCK_REACH).toBe(4.5);
    // 站在 (0.5, 64, 0.5)，方块 (0,64,0) 的中心是 (0.5,64.5,0.5) → 距离 0.5。
    expect(blockReachDistance({ x: 0, y: 64, z: 0 }, { x: 0.5, y: 64, z: 0.5 })).toBeCloseTo(0.5, 5);
    expect(withinVanillaReach({ x: 0, y: 64, z: 0 }, { x: 0.5, y: 64, z: 0.5 })).toBe(true);
    // 水平 5 格 → 够不着。
    expect(withinVanillaReach({ x: 5, y: 64, z: 0 }, { x: 0.5, y: 64, z: 0.5 })).toBe(false);
    // 4 格整 → 4.0 < 4.5 够得着；4.5 格刚好贴边也算够得着。
    expect(withinVanillaReach({ x: 4, y: 64, z: 0 }, { x: 0.5, y: 64, z: 0.5 })).toBe(true);
    expect(withinVanillaReach({ x: 5, y: 64, z: 0 }, { x: 0.5, y: 64, z: 0.5 })).toBe(false);
  });

  it("背包 2×2 与工作台 3×3 的分界：超过 2×2 就必须有工作台", () => {
    expect(INVENTORY_GRID_SIZE).toBe(2);
    expect(CRAFTING_TABLE_GRID_SIZE).toBe(3);
    expect(requiresCraftingTable(1)).toBe(false);
    expect(requiresCraftingTable(2)).toBe(false);
    expect(requiresCraftingTable(3)).toBe(true);
  });
});

describe("commons/placement — 火把与光照", () => {
  it("火把光照 14，敌对生物需要方块光照 0 才会刷", () => {
    expect(TORCH_LIGHT_LEVEL).toBe(14);
    expect(HOSTILE_SPAWN_BLOCK_LIGHT).toBe(0);
  });

  it("中点光照 = 14 − floor(d/2)；间距 28 时中点掉到 0（会刷怪）", () => {
    const midpointLight = (distance: number): number => TORCH_LIGHT_LEVEL - Math.floor(distance / 2);
    expect(midpointLight(MAX_TORCH_SPACING)).toBeGreaterThan(HOSTILE_SPAWN_BLOCK_LIGHT);
    expect(midpointLight(28)).toBe(HOSTILE_SPAWN_BLOCK_LIGHT);
    // 26 格间距（本表的取值）留了 1 格余量：中点光照 1。
    expect(MAX_TORCH_SPACING).toBe(26);
    expect(midpointLight(26)).toBe(1);
  });

  it("给定最低光照算最大间距：光照 1 → 27，光照 7 → 15", () => {
    expect(maxTorchSpacingFor(1)).toBe(27);
    expect(maxTorchSpacingFor(7)).toBe(15);
    expect(maxTorchSpacingFor(0)).toBe(29);
    // 超过火把本身的光照等级就无解，返回 0 而不是负数。
    expect(maxTorchSpacingFor(15)).toBe(0);
  });

  it("铺点：26 格一支，起点永远有火把", () => {
    expect(torchOffsets(0)).toEqual([0]);
    expect(torchOffsets(26)).toEqual([0, 26]);
    expect(torchOffsets(53)).toEqual([0, 26, 52]);
    expect(torchOffsets(100)).toEqual([0, 26, 52, 78]);
  });
});

describe("commons/placement — 农田水化", () => {
  it("水源四周各 4 格 → 9×9 的方形水化区（切比雪夫距离，不是圆形）", () => {
    expect(FARMLAND_HYDRATION_RADIUS).toBe(4);
    expect(FARMLAND_TILES_PER_WATER).toBe(80);
    const water = { x: 0, z: 0 };
    expect(isHydrated({ x: 4, z: 4 }, water)).toBe(true);
    expect(isHydrated({ x: 4, z: 5 }, water)).toBe(false);
    expect(isHydrated({ x: 5, z: 0 }, water)).toBe(false);
    expect(isHydrated({ x: -4, z: -4 }, water)).toBe(true);
  });
});

describe("commons/placement — 站点摆放要求", () => {
  it("床要 2 格净空与实心地板、占 1×2；工作台/熔炉/箱子只要 1 格净空", () => {
    expect(stationRequirements.bed).toMatchObject({ headroomBlocks: 2, needsSolidFloor: true, footprint: { width: 1, depth: 2 } });
    expect(stationRequirements.crafting_table).toMatchObject({ headroomBlocks: 1, needsSolidFloor: true, footprint: { width: 1, depth: 1 } });
    expect(stationRequirements.furnace).toMatchObject({ headroomBlocks: 1, needsSolidFloor: true });
    expect(stationRequirements.chest).toMatchObject({ headroomBlocks: 1, needsSolidFloor: true });
    // 火把可以贴墙，所以不要求地板。
    expect(stationRequirements.torch).toMatchObject({ needsSolidFloor: false, placementSurface: "wall-or-floor" });
  });
});

describe("station.plan — 就地放还是去找", () => {
  it("现有站点够得着 → USE_EXISTING，并给出真实距离", async () => {
    const output = await stationPlanSkill.execute(
      {} as never,
      { station: "crafting_table", existing: { x: 2, y: 64, z: 0 }, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "USE_EXISTING", code: "USE_EXISTING" });
    // 站点中心 (2.5, 64.5, 0.5) 到 bot (0.5, 64, 0.5) = √(2² + 0.5²) ≈ 2.06 格。
    expect(output.existingDistance).toBeCloseTo(Math.hypot(2, 0.5), 5);
  });

  it("现有站点超出 4.5 格 → STATION_OUT_OF_REACH", async () => {
    const output = await stationPlanSkill.execute(
      {} as never,
      { station: "furnace", existing: { x: 8, y: 64, z: 0 }, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "MUST_FIND", code: "STATION_OUT_OF_REACH" });
    expect(output.existingDistance).toBeGreaterThan(VANILLA_BLOCK_REACH);
  });

  it("没有现成的、落点合法 → PLACE_STATION，并把净空/地板要求一起返回", async () => {
    const output = await stationPlanSkill.execute(
      {} as never,
      { station: "crafting_table", candidate: { x: 1, y: 64, z: 0 }, headroomBlocks: 2, solidFloor: true, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "MUST_PLACE", code: "PLACE_STATION" });
    expect(output.requirement).toMatchObject({ position: { x: 1, y: 64, z: 0 }, headroomBlocks: 1, needsSolidFloor: true });
  });

  it("床的净空不够 → STATION_HEADROOM_MISSING（床要 2 格，1 格不行）", async () => {
    const output = await stationPlanSkill.execute(
      {} as never,
      { station: "bed", candidate: { x: 1, y: 64, z: 0 }, headroomBlocks: 1, solidFloor: true, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "MUST_FIND", code: "STATION_HEADROOM_MISSING" });
    expect(output.requirement.headroomBlocks).toBe(2);
  });

  it("下方不是实心 → STATION_FLOOR_MISSING", async () => {
    const output = await stationPlanSkill.execute(
      {} as never,
      { station: "chest", candidate: { x: 1, y: 64, z: 0 }, headroomBlocks: 1, solidFloor: false, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "MUST_FIND", code: "STATION_FLOOR_MISSING" });
  });

  it("既没有现成的、也没有落点 → REQUIREMENTS_INCOMPLETE，不假装知道放哪", async () => {
    const output = await stationPlanSkill.execute(
      {} as never,
      { station: "furnace", ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "REQUIREMENTS_INCOMPLETE", code: "STATION_PLACEMENT_UNKNOWN", existingDistance: null });
    expect(output.requirement.position).toBeNull();
  });

  it("声明层面：纯技能、幂等、不重试、无 capability", () => {
    expect(stationPlanSkill.requiredCapabilities).toEqual([]);
    expect(stationPlanSkill.idempotent).toBe(true);
    expect(stationPlanSkill.retryPolicy).toMatchObject({ maxAttempts: 1, retryableErrorCodes: [] });
    const codes = stationPlanSkill.preconditions.map(({ failureCode }) => failureCode);
    expect(codes).toContain("BOT_NOT_ONLINE");
    expect(codes).toContain("NORMAL_ACTIONS_PAUSED");
    expect(codes).toContain("TARGET_DIMENSION_MISMATCH");
    expect(codes).toContain("BOT_POSITION_UNAVAILABLE");
  });
});

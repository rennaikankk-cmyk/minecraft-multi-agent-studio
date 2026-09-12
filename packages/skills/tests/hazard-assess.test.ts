import { describe, expect, it } from "vitest";

import { hazardAssessSkill, hazardCodesForAction } from "../src/builtin/hazard-assess.js";

// ---------------------------------------------------------------------------
// hazard.assess 作为**别的规划器的安全前置闸**：输入是动作事实 + 运行时状态，
// 输出是确定性的裁决与稳定的危险码。
// ---------------------------------------------------------------------------

const scope = { serverProfileId: "isolated-local" };
const overworld = { dimension: "minecraft:overworld", y: 64 };
const nether = { dimension: "minecraft:the_nether", y: 64 };

function stateAt(position: { x: number; y: number; z: number; dimension: string }, safety = { lavaAdjacent: false, waterAdjacent: false, voidRisk: false }) {
  return {
    online: true,
    normalActionsAllowed: true,
    serverProfileId: "isolated-local",
    isolatedTestServer: true,
    policyLimits: { allowSprint: true, allowSprintJumpCombo: true, allowAirStrafe: false, maxFallBlocks: 3 },
    safety,
    position: { ...position, serverProfileId: "isolated-local" },
  };
}

describe("hazard.assess — 高度面", () => {
  it("主世界 y=-64 判 REFUSE 并给出 VOID_FLOOR", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, y: -64, dimension: "minecraft:overworld", ...scope },
      stateAt({ x: 0, y: -64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(output.verdict).toBe("REFUSE");
    expect(output.refusalCode).toBe("VOID_FLOOR");
    expect(output.safeToProceed).toBe(false);
    expect(output.hazards.map((hazard) => hazard.code)).toContain("VOID_FLOOR");
  });

  it("下界 y=31 判 REFUSE 并给出 LAVA_SEA", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-horizontal", depthBlocks: 4 }, y: 31, dimension: "minecraft:the_nether", ...scope },
      stateAt({ x: 0, y: 31, z: 0, dimension: "minecraft:the_nether" }),
    );
    expect(output.verdict).toBe("REFUSE");
    expect(output.refusalCode).toBe("LAVA_SEA");
    expect(output.dimensionLabel).toBe("下界");
  });

  it("末地 y=0 以下判 VOID_FLOOR（末地岛外即虚空）", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, y: 0, dimension: "minecraft:the_end", ...scope },
      stateAt({ x: 0, y: 0, z: 0, dimension: "minecraft:the_end" }),
    );
    expect(output.verdict).toBe("REFUSE");
    expect(output.hazards.map((hazard) => hazard.code)).toContain("VOID_FLOOR");
  });

  it("主世界 y=64 的普通移动 → ALLOW、SAFE、可以继续", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(output).toMatchObject({ verdict: "ALLOW", refusalCode: "SAFE", safeToProceed: true, hazards: [] });
  });

  it("省略 y/dimension 时取 state.position 的高度与维度", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, ...scope },
      stateAt({ x: 3, y: -60, z: 7, dimension: "minecraft:overworld" }),
    );
    expect(output.y).toBe(-60);
    expect(output.dimension).toBe("minecraft:overworld");
    // -60 已越过规划地板（-48）但还没到硬地板（-64）：提醒级，不是立即致命。
    expect(output).toMatchObject({ verdict: "WARN", refusalCode: "DEEP_DANGER_ZONE" });
  });
});

describe("hazard.assess — 动作面", () => {
  it("垂直下挖永远是 REFUSE（DIG_STRAIGHT_DOWN 优先于深度）", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-straight-down", depthBlocks: 3 }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(output.verdict).toBe("REFUSE");
    expect(output.refusalCode).toBe("DIG_STRAIGHT_DOWN");
  });

  it("掏头顶只提醒（HOLLOW_OVERHEAD），上方有水就升级为拒绝", async () => {
    const warned = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-overhead", depthBlocks: 1 }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(warned.verdict).toBe("WARN");
    expect(warned.safeToProceed).toBe(true);

    const refused = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-overhead", depthBlocks: 1, fluidAbove: true }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(refused.verdict).toBe("REFUSE");
    expect(refused.hazards.map((hazard) => hazard.code)).toContain("DIG_INTO_LAVA");
  });

  it("挖贴着岩浆的方块 → REFUSE；贴着水 → WARN", async () => {
    const lava = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-target", target: { x: 1, y: 64, z: 0 }, adjacentLava: true }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(lava).toMatchObject({ verdict: "REFUSE", refusalCode: "DIG_INTO_LAVA" });
    expect(lava.hazards.map((hazard) => hazard.code)).toEqual(expect.arrayContaining(["LAVA_ADJACENT", "DIG_INTO_LAVA"]));

    const water = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-target", target: { x: 1, y: 64, z: 0 }, adjacentWater: true }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(water.verdict).toBe("WARN");
    expect(water.hazards.map((hazard) => hazard.code)).toContain("WATER_ADJACENT");
  });

  it("床在下界/末地判 BED_EXPLODES，在主世界放行", async () => {
    const inNether = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "use-bed" }, ...nether, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:the_nether" }),
    );
    expect(inNether).toMatchObject({ verdict: "REFUSE", refusalCode: "BED_EXPLODES" });
    expect(inNether.hazards.find((hazard) => hazard.code === "BED_EXPLODES")?.detail).toContain("下界");

    const inEnd = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "use-bed" }, y: 64, dimension: "minecraft:the_end", ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:the_end" }),
    );
    expect(inEnd.verdict).toBe("REFUSE");

    const inOverworld = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "use-bed" }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(inOverworld).toMatchObject({ verdict: "ALLOW", hazards: [] });
  });

  it("坠落：3 格放行、4 格 REFUSE（FALL_DAMAGE）、超策略上限报策略码", async () => {
    const safe = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "fall", fallBlocks: 3 }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(safe.verdict).toBe("ALLOW");

    const damaged = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "fall", fallBlocks: 4 }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(damaged).toMatchObject({ verdict: "REFUSE", refusalCode: "FALL_DAMAGE" });

    // 策略上限 2 格时，3 格虽然不扣血也超过策略。
    const overPolicy = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "fall", fallBlocks: 3 }, ...overworld, ...scope },
      {
        ...stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
        policyLimits: { allowSprint: false, allowSprintJumpCombo: false, allowAirStrafe: false, maxFallBlocks: 2 },
      },
    );
    expect(overPolicy).toMatchObject({ verdict: "REFUSE", refusalCode: "FALL_BEYOND_POLICY" });
  });

  it("顶层 fallBlocks 与 fall 动作一样生效", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, fallBlocks: 5, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }),
    );
    expect(output).toMatchObject({ verdict: "REFUSE", refusalCode: "FALL_DAMAGE" });
  });
});

describe("hazard.assess — 运行时安全位", () => {
  it("voidRisk 观测为真 → REFUSE，即使高度正常", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }, { lavaAdjacent: false, waterAdjacent: false, voidRisk: true }),
    );
    expect(output).toMatchObject({ verdict: "REFUSE", refusalCode: "VOID_RISK" });
  });

  it("身边有水只是提醒，不拦", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "move-to" }, ...overworld, ...scope },
      stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }, { lavaAdjacent: false, waterAdjacent: true, voidRisk: false }),
    );
    expect(output.verdict).toBe("WARN");
    expect(output.safeToProceed).toBe(true);
  });

  it("代表码取最严重的一个：同一组码永远给同一个 refusalCode", async () => {
    const output = await hazardAssessSkill.execute(
      {} as never,
      { action: { kind: "dig-straight-down", depthBlocks: 1 }, y: 31, dimension: "minecraft:the_nether", ...scope },
      stateAt({ x: 0, y: 31, z: 0, dimension: "minecraft:the_nether" }),
    );
    // 虚空 > 岩浆海 > 垂直下挖，下界 31 同时命中 LAVA_SEA 与 DIG_STRAIGHT_DOWN。
    expect(output.hazards.map((hazard) => hazard.code)).toEqual(expect.arrayContaining(["LAVA_SEA", "DIG_STRAIGHT_DOWN"]));
    expect(output.refusalCode).toBe("LAVA_SEA");
  });

  it("hazardCodesForAction 是纯函数，不含高度/维度判定", () => {
    expect(hazardCodesForAction({ kind: "dig-straight-down", depthBlocks: 2 })).toEqual(["DIG_STRAIGHT_DOWN"]);
    expect(hazardCodesForAction({ kind: "move-to" })).toEqual([]);
    expect(hazardCodesForAction({ kind: "dig-target", target: { x: 0, y: 0, z: 0 } })).toEqual([]);
  });

  it("确定性的：同输入两次给出完全一样的裁决", async () => {
    const input = { action: { kind: "dig-target", target: { x: 1, y: 64, z: 0 }, adjacentLava: true }, ...overworld, ...scope } as const;
    const snapshot = stateAt({ x: 0, y: 64, z: 0, dimension: "minecraft:overworld" });
    const first = await hazardAssessSkill.execute({} as never, input, snapshot);
    const second = await hazardAssessSkill.execute({} as never, input, snapshot);
    expect(first).toEqual(second);
  });

  it("声明层面：纯技能、幂等、不重试、无 capability", () => {
    expect(hazardAssessSkill.requiredCapabilities).toEqual([]);
    expect(hazardAssessSkill.idempotent).toBe(true);
    expect(hazardAssessSkill.retryPolicy).toMatchObject({ maxAttempts: 1, retryableErrorCodes: [] });
    const codes = hazardAssessSkill.preconditions.map(({ failureCode }) => failureCode);
    expect(codes).toContain("BOT_NOT_ONLINE");
    expect(codes).toContain("NORMAL_ACTIONS_PAUSED");
    expect(codes).toContain("BOT_POSITION_UNAVAILABLE");
    expect(codes).toContain("TARGET_DIMENSION_MISMATCH");
  });
});

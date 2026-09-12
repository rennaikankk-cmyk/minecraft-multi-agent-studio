import { describe, expect, it, vi } from "vitest";

import { MAX_TORCH_SPACING, maxTorchSpacingFor } from "../src/commons/placement.js";
import {
  LIGHT_PLACE_MAX_PLACEMENTS,
  lightPlaceSkill,
  plannedTorchPositions,
  type LightPlaceInput,
} from "../src/builtin/light-place.js";

// ---------------------------------------------------------------------------
// light.place：照明布光的**执行**面。
//
// 三条最要紧的断言：
//   1. 间距来自 commons 的常识规则，且保守方向永远是"更密"。
//   2. 火把放在地面方块**上面**（参照方块 = 地面，face = +y）——这条契约写错就会
//      往墙里/空中放，而单测之外看不出来。
//   3. 能力失败**向上传播**（带稳定码），部分完成用 nextIndex 表达——与本仓
//      多步技能（planning/stock-levels.ts）的既有约定一致。
// ---------------------------------------------------------------------------

const DIMENSION = "minecraft:overworld";
const SERVER = "isolated-local";

function input(overrides: Partial<LightPlaceInput> = {}): LightPlaceInput {
  return {
    itemName: "torch",
    axis: "x",
    origin: { x: 0, z: 0 },
    floorY: 63,
    length: 60,
    maxPlacements: 4,
    dimension: DIMENSION,
    serverProfileId: SERVER,
    ...overrides,
  } as LightPlaceInput;
}

const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: SERVER,
  position: { x: 0, y: 64, z: 0, dimension: DIMENSION, serverProfileId: SERVER },
};

function contextWith(
  callCapability: (capability: string, operation: string, value: unknown) => Promise<unknown>,
  signal: AbortSignal = new AbortController().signal,
) {
  return {
    invocationId: "inv-1",
    traceId: "trace-1",
    taskId: "task-1",
    botId: "bot-1",
    signal,
    deadlineMs: Date.now() + 60_000,
    compatibility: {
      minecraftVersion: null,
      protocolVersion: null,
      variantId: "portable",
      verification: "unverified" as const,
    },
    callCapability,
  } as unknown as Parameters<typeof lightPlaceSkill.execute>[0];
}

/** 放置能力成功时的最小诚实回执形状。 */
function placementReceipt(value: unknown) {
  const referenceBlock = (value as { referenceBlock: { x: number; y: number; z: number } }).referenceBlock;
  return {
    placed: true as const,
    placedBlockName: "torch",
    position: { x: referenceBlock.x, y: referenceBlock.y + 1, z: referenceBlock.z },
  };
}

describe("light.place 间距与布点（纯算术）", () => {
  it("默认光照 1 时取保守上限 26（公式给 27，留 1 格余量）", () => {
    expect(maxTorchSpacingFor(1)).toBe(27);
    const { spacingBlocks } = plannedTorchPositions(input({ length: 100 }));
    expect(spacingBlocks).toBe(MAX_TORCH_SPACING);
    expect(spacingBlocks).toBe(26);
  });

  it("更高的最低光照要求 → 间距更密（绝不更稀）", () => {
    expect(plannedTorchPositions(input({ length: 100, minimumBlockLight: 13 })).spacingBlocks).toBe(3);
    // level 0 的公式值 29 比保守上限宽，仍取 26：保守方向是更密。
    expect(plannedTorchPositions(input({ length: 100, minimumBlockLight: 0 })).spacingBlocks).toBe(
      MAX_TORCH_SPACING,
    );
  });

  it("沿 x 铺：偏移只落在 x 上，y 恒为地面高度", () => {
    const { positions } = plannedTorchPositions(input({ length: 60, maxPlacements: 4 }));
    expect(positions).toEqual([
      { x: 0, y: 63, z: 0 },
      { x: 26, y: 63, z: 0 },
      { x: 52, y: 63, z: 0 },
    ]);
  });

  it("沿 z 铺：偏移只落在 z 上", () => {
    const { positions } = plannedTorchPositions(
      input({ axis: "z", origin: { x: 5, z: -10 }, length: 30 }),
    );
    expect(positions).toEqual([
      { x: 5, y: 63, z: -10 },
      { x: 5, y: 63, z: 16 },
    ]);
  });

  it("maxPlacements 截断计划；length=0 只放起点一支", () => {
    const capped = plannedTorchPositions(input({ length: 200, maxPlacements: 2 }));
    expect(capped.positions).toHaveLength(2);
    expect(capped.positions[1]).toEqual({ x: 26, y: 63, z: 0 });

    expect(plannedTorchPositions(input({ length: 0 })).positions).toEqual([{ x: 0, y: 63, z: 0 }]);
  });
});

describe("light.place 执行：每支都走已校验的放置能力", () => {
  it("全部成功 → nextIndex 走到底、completed=true、placed 逐支如实", async () => {
    const calls: Array<{ capability: string; operation: string }> = [];
    const callCapability = vi.fn(async (capability: string, operation: string, value: unknown) => {
      calls.push({ capability, operation });
      return placementReceipt(value);
    });

    const result = await lightPlaceSkill.execute(contextWith(callCapability), input(), state);

    expect(result.startIndex).toBe(0);
    expect(result.nextIndex).toBe(3);
    expect(result.totalPlacements).toBe(3);
    expect(result.completed).toBe(true);
    expect(result.spacingBlocks).toBe(26);
    expect(result.placed).toEqual([
      { x: 0, y: 63, z: 0 },
      { x: 26, y: 63, z: 0 },
      { x: 52, y: 63, z: 0 },
    ]);
    // 全部经由既有的放置能力，没有自造第二条放置路径。
    expect(
      calls.every((call) => call.capability === "world.interact" && call.operation === "block.place-safe"),
    ).toBe(true);
  });

  it("放在地面方块**上面**：参照方块是地面、face 是 +y", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const callCapability = vi.fn(async (_c: string, _o: string, value: unknown) => {
      seen.push(value as Record<string, unknown>);
      return placementReceipt(value);
    });

    await lightPlaceSkill.execute(contextWith(callCapability), input({ length: 0 }), state);

    expect(seen).toHaveLength(1);
    expect(seen[0].referenceBlock).toEqual({ x: 0, y: 63, z: 0 });
    expect(seen[0].face).toEqual({ x: 0, y: 1, z: 0 });
    expect(seen[0].itemName).toBe("torch");
    expect(seen[0].dimension).toBe(DIMENSION);
    expect(seen[0].serverProfileId).toBe(SERVER);
  });

  it("startIndex 续做：跳过已放好的那些，不重复消耗火把", async () => {
    const callCapability = vi.fn(async (_c: string, _o: string, value: unknown) => placementReceipt(value));
    const result = await lightPlaceSkill.execute(
      contextWith(callCapability),
      input({ startIndex: 2 }),
      state,
    );

    expect(callCapability).toHaveBeenCalledTimes(1);
    expect(result.startIndex).toBe(2);
    expect(result.nextIndex).toBe(3);
    expect(result.placed).toEqual([{ x: 52, y: 63, z: 0 }]);
    expect(result.completed).toBe(true);
  });

  it("能力失败带稳定码向上传播，不吞、不假装完成", async () => {
    let call = 0;
    const callCapability = vi.fn(async (_c: string, _o: string, value: unknown) => {
      call += 1;
      if (call === 2) throw new Error("RUNTIME_PLACE_REJECTED");
      return placementReceipt(value);
    });

    await expect(
      lightPlaceSkill.execute(contextWith(callCapability), input({ length: 60 }), state),
    ).rejects.toThrow("RUNTIME_PLACE_REJECTED");
    // 失败后不再继续消耗火把。
    expect(callCapability).toHaveBeenCalledTimes(2);
  });

  it("回执没有确认放置 → SKILL_VERIFY_FAILED（不按「我发过请求」计）", async () => {
    const callCapability = vi.fn(async () => ({ placed: false, placedBlockName: "air", position: { x: 0, y: 63, z: 0 } }));
    // 稳定码在 error.code 上（SkillFault 的 message 是通用占位符，不承载诊断信息）。
    await expect(
      lightPlaceSkill.execute(contextWith(callCapability), input({ length: 0 }), state),
    ).rejects.toMatchObject({ code: "SKILL_VERIFY_FAILED" });
  });

  it("已取消的信号 → SKILL_CANCELLED，且一次都不放置", async () => {
    const controller = new AbortController();
    controller.abort();
    const callCapability = vi.fn(async (_c: string, _o: string, value: unknown) => placementReceipt(value));

    await expect(
      lightPlaceSkill.execute(contextWith(callCapability, controller.signal), input({ length: 0 }), state),
    ).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
    expect(callCapability).not.toHaveBeenCalled();
  });
});

describe("light.place 声明与前置条件", () => {
  it("非幂等、不自动重试、只声明 world.interact", () => {
    expect(lightPlaceSkill.id).toBe("light.place");
    expect(lightPlaceSkill.idempotent).toBe(false);
    expect(lightPlaceSkill.retryPolicy.maxAttempts).toBe(1);
    expect([...lightPlaceSkill.requiredCapabilities]).toEqual(["world.interact"]);
    expect(LIGHT_PLACE_MAX_PLACEMENTS).toBe(16);
  });

  it("L0 暂停 / 离线 / 维度不符 / 档案不符各自被前置条件拦住", () => {
    const precondition = (id: string) => {
      const found = lightPlaceSkill.preconditions.find((entry) => entry.id === id);
      expect(found, `precondition ${id} 不存在`).toBeDefined();
      return found!;
    };

    expect(precondition("bot.online").check(input(), { ...state, online: false })).toBe(false);
    expect(
      precondition("l0.normal-actions-allowed").check(input(), { ...state, normalActionsAllowed: false }),
    ).toBe(false);
    expect(
      precondition("target.dimension-matches").check(input({ dimension: "minecraft:the_nether" }), state),
    ).toBe(false);
    expect(
      precondition("target.server-profile-matches").check(input({ serverProfileId: "other-server" }), state),
    ).toBe(false);
    // 位置未知时维度无法核对 → fail-closed
    expect(precondition("target.dimension-matches").check(input(), { ...state, position: null })).toBe(
      false,
    );
    expect(precondition("bot.online").check(input(), state)).toBe(true);
  });
});

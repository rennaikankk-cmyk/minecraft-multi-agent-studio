import { describe, expect, it } from "vitest";

import { parseBlueprintGoal } from "../src/deterministic-goals.js";

// ---------------------------------------------------------------------------
// Round 6.5 —— 确定性蓝图行模板（免模型转写）解析测试
// ---------------------------------------------------------------------------

describe("parseBlueprintGoal", () => {
  it("parses a full row spec with batching and resume start", () => {
    const parsed = parseBlueprintGoal(
      "施工蓝图行：锚点 x=4 y=70 z=8，沿 +x 放置 8 个 oak_log，每批最多 4 格，从第 4 格开始",
    );
    expect(parsed).toEqual({
      kind: "build-blueprint-row",
      anchor: { x: 4, y: 70, z: 8 },
      direction: "+x",
      count: 8,
      itemName: "oak_log",
      maxPlacements: 4,
      startIndex: 4,
    });
  });

  it("defaults to full-batch from cell 0 when optional segments are absent", () => {
    const parsed = parseBlueprintGoal(
      "施工蓝图行：锚点 x=0 y=64 z=0，沿 -z 放置 12 个 cobblestone",
    );
    expect(parsed).toMatchObject({
      kind: "build-blueprint-row",
      direction: "-z",
      count: 12,
      itemName: "cobblestone",
      maxPlacements: null,
      startIndex: 0,
    });
  });

  it("rejects free-text directions (only the four controlled enums)", () => {
    expect(
      parseBlueprintGoal("施工蓝图行：锚点 x=0 y=64 z=0，沿 东北 放置 4 个 dirt"),
    ).toBeNull();
  });

  it("rejects non-registry item names", () => {
    expect(
      parseBlueprintGoal("施工蓝图行：锚点 x=0 y=64 z=0，沿 +x 放置 4 个 My Item!"),
    ).toBeNull();
  });

  it("rejects out-of-bound counts (>64)", () => {
    expect(
      parseBlueprintGoal("施工蓝图行：锚点 x=0 y=64 z=0，沿 +x 放置 99 个 dirt"),
    ).toBeNull();
  });

  it("requires the template keyword (free text goes to the model branch)", () => {
    expect(parseBlueprintGoal("随便建一行东西")).toBeNull();
    expect(parseBlueprintGoal("使用蓝图施工技能放置一个 oak_log：锚点 x=1 y=2 z=3")).toBeNull();
  });

  it("supports all four directions", () => {
    for (const direction of ["+x", "-x", "+z", "-z"] as const) {
      const parsed = parseBlueprintGoal(
        `施工蓝图行：锚点 x=1 y=2 z=3，沿 ${direction} 放置 2 个 dirt`,
      );
      expect(parsed?.direction).toBe(direction);
    }
  });
});

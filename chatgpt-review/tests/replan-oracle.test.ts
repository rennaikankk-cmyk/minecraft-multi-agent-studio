import { describe, expect, it, vi } from "vitest";

import {
  askReplanOracle,
  buildReplanPrompt,
  sanitizeReplanDecision,
  substitutionAllowlist,
} from "../src/replan-oracle.js";

describe("replan oracle", () => {
  it("builds a compact prompt without coordinates or server identity", () => {
    const prompt = buildReplanPrompt({
      needKey: "COAL_RESERVE",
      reason: "coal reserve 0 < minimum 8",
      failures: 3,
      safeFoodCount: 6,
      pickaxeTier: "stone_pickaxe",
      substitutes: ["coal", "charcoal"],
    });
    const parsed = JSON.parse(prompt) as Record<string, unknown>;
    expect(parsed.need).toBe("COAL_RESERVE");
    expect(parsed.allowedSubstitutes).toEqual(["coal", "charcoal"]);
    expect(prompt).not.toMatch(/x=\d+/u);
    expect(prompt).not.toContain("serverProfile");
    expect(prompt).not.toContain("isolated");
  });

  it("keeps substitute choices inside the per-need allowlist", () => {
    expect(
      sanitizeReplanDecision(
        { strategy: "substitute-resource", substituteItem: "diamond", magnitude: null },
        "COAL_RESERVE",
      ),
    ).toEqual({ strategy: "rotate-sector", substituteItem: null, magnitude: null, stance: null });

    expect(
      sanitizeReplanDecision(
        { strategy: "substitute-resource", substituteItem: "charcoal", magnitude: "large" },
        "COAL_RESERVE",
      ),
    ).toEqual({ strategy: "substitute-resource", substituteItem: "charcoal", magnitude: null, stance: null });
  });

  it("strips substitute parameters from non-substitute strategies", () => {
    expect(
      sanitizeReplanDecision(
        { strategy: "widen-exploration", substituteItem: "coal", magnitude: "large" },
        "COAL_RESERVE",
      ),
    ).toEqual({ strategy: "widen-exploration", substituteItem: null, magnitude: "large", stance: null });
  });

  it("exposes no substitutions for needs without safe alternates", () => {
    expect(substitutionAllowlist("SHELTER")).toEqual([]);
    expect(substitutionAllowlist("TOOL_PROGRESSION")).toEqual([]);
  });

  it("returns null on model failure so autonomy stays deterministic", async () => {
    const generate = vi.fn(async () => {
      throw new Error("spark down");
    });
    const decision = await askReplanOracle({
      ai: { generate },
      requestId: "00000000-0000-4000-8000-000000000001",
      botId: "studio-bot-01",
      traceId: "00000000-0000-4000-8000-000000000001",
      prompt: buildReplanPrompt({
        needKey: "COAL_RESERVE",
        reason: "coal reserve 0 < minimum 8",
        failures: 3,
        safeFoodCount: 0,
        pickaxeTier: "none",
        substitutes: ["coal", "charcoal"],
      }),
    });
    expect(decision).toBeNull();
  });

  it("rejects off-menu or malformed model output", async () => {
    for (const content of [
      "not json at all",
      JSON.stringify({ strategy: "dig-straight-down" }),
      JSON.stringify({ strategy: "widen-exploration", magnitude: "huge" }),
      JSON.stringify({ strategy: "rotate-sector", extraField: true }),
    ]) {
      const generate = vi.fn(async () => ({
        requestId: "r",
        botId: "b",
        priority: 5,
        value: { content, usage: { promptTokens: 1, completionTokens: 1 } },
        attempts: 1,
        enqueuedAt: "",
        startedAt: "",
        completedAt: "",
        queueTimeMs: 0,
        executionTimeMs: 1,
        totalTimeMs: 1,
      }));
      const decision = await askReplanOracle({
        ai: { generate },
        requestId: "00000000-0000-4000-8000-000000000002",
        botId: "studio-bot-01",
        traceId: "00000000-0000-4000-8000-000000000002",
        prompt: "{}",
      });
      expect(decision).toBeNull();
    }
  });
});


import {
  askStrategyReview,
  buildStrategyReviewPrompt,
  sanitizeStrategyReviewDecision,
  FOCUS_NEED_BOOSTS,
} from "../src/strategy-review.js";

describe("strategy review", () => {
  it("builds a prompt with situation facts but no coordinates or identity", () => {
    const prompt = buildStrategyReviewPrompt({
      botId: "studio-bot-01",
      focusWindowMinutes: 5,
      safeFoodCount: 4,
      pickaxeTier: "stone_pickaxe",
      hasSword: false,
      armorPoints: 0,
      woodUnits: 3,
      coalUnits: 0,
      ironUnits: 0,
      recentNeeds: ["FOOD_SECURITY", "TOOL_PROGRESSION"],
      recentFailures: ["WOOD_RESERVE"],
      deaths: 1,
    });
    const parsed = JSON.parse(prompt);
    expect(parsed.bot.bestPickaxe).toBe("stone_pickaxe");
    expect(parsed.menu).toContain("defense");
    expect(prompt).not.toMatch(/x=d+/u);
    expect(prompt).not.toContain("serverProfile");
  });

  it("sanitizes off-menu exploration blocks", () => {
    expect(
      sanitizeStrategyReviewDecision({
        focus: "exploration",
        explorationBlock: "bedrock",
        stance: null,
        rationale: null,
      }),
    ).toMatchObject({ focus: "exploration", explorationBlock: null });
    // 非探索重心时方块参数被丢弃
    expect(
      sanitizeStrategyReviewDecision({
        focus: "defense",
        explorationBlock: "diamond_ore",
        stance: null,
        rationale: null,
      }),
    ).toMatchObject({ focus: "defense", explorationBlock: null });
  });

  it("returns null when the model is down", async () => {
    const generate = vi.fn(async () => {
      throw new Error("spark down");
    });
    const decision = await askStrategyReview({
      ai: { generate },
      requestId: "00000000-0000-4000-8000-000000000003",
      botId: "studio-bot-01",
      traceId: "t",
      prompt: "{}",
    });
    expect(decision).toBeNull();
  });

  it("keeps focus boosts additive and capped", () => {
    // EXPLORATION 基线 5 分 +25 加权后也不超过 95
    expect(5 + (FOCUS_NEED_BOOSTS.exploration.EXPLORATION ?? 0)).toBeLessThanOrEqual(95);
    // 防御重心不加持食物（模型改不了硬性生存优先级）
    expect(FOCUS_NEED_BOOSTS.defense.FOOD_SECURITY).toBeUndefined();
  });
});

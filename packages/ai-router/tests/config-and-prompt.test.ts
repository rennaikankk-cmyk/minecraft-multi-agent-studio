import { describe, expect, it } from "vitest";

import {
  buildPrefixCachePrompt,
  compactBotContextSchema,
  loadAISchedulerConfig,
} from "../src/index.js";

const context = {
  botId: "bot-1",
  currentTask: "collect wood",
  health: 20,
  food: 18,
  position: { x: 1, y: 64, z: 2 },
  dimension: "overworld",
  importantInventory: [{ item: "oak_log", count: 3 }],
  equipment: ["wooden_axe"],
  nearbyThreats: [],
  nearbyEntities: ["cow"],
  relevantMemory: ["chest at safe base"],
  relevantSkills: ["collect_block"],
  recentFailures: [],
  teamState: ["bot-2 mining stone"],
};

describe("AI config", () => {
  it("requires benchmark-selected max concurrency", () => {
    expect(() => loadAISchedulerConfig({})).toThrow(/AI_MAX_CONCURRENCY/u);
  });

  it("loads portable scheduler settings without embedding a Spark address", () => {
    expect(loadAISchedulerConfig({ AI_MAX_CONCURRENCY: "4" })).toEqual({
      maxConcurrency: 4,
      maxQueue: 64,
      perBotConcurrency: 1,
      staleAfterMs: 30_000,
      maxRetries: 1,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 2_000,
    });
  });
});

describe("CompactBotContext and prefix-cache prompt", () => {
  it("bounds compact context arrays", () => {
    expect(compactBotContextSchema.parse(context)).toEqual(context);
    expect(compactBotContextSchema.safeParse({
      ...context,
      recentFailures: Array.from({ length: 17 }, () => "failure"),
    }).success).toBe(false);
  });

  it("places stable policy/catalog/schema before changing Bot context", () => {
    const built = buildPrefixCachePrompt({
      systemPrompt: "system",
      minecraftRules: "rules",
      skillCatalog: "skills",
      outputSchema: "schema",
      context,
      task: "collect wood",
    });
    expect(built.systemPrompt).toContain("system\n<minecraft_rules>");
    expect(built.systemPrompt.indexOf("skills")).toBeLessThan(
      built.systemPrompt.indexOf("schema"),
    );
    expect(built.prompt).toContain("<compact_bot_context>");
    expect(built.systemPrompt).not.toContain("collect wood");
  });
});

import { describe, expect, it } from "vitest";

import { compactBotContextSchema } from "../src/compact-context.js";

const baseContext = {
  botId: "bot-1",
  currentTask: null,
  health: 20,
  food: 18,
  position: { x: 1, y: 64, z: -3, dimension: "minecraft:overworld" },
  importantInventory: [{ item: "minecraft:bread", count: 12 }],
  equipment: ["minecraft:iron_sword"],
  nearbyThreats: [],
  nearbyEntities: [],
  relevantMemory: [],
  relevantSkills: ["sleep"],
  recentFailures: [],
  teamState: [],
};

describe("compactBotContextSchema", () => {
  it("accepts a bounded context", () => {
    expect(compactBotContextSchema.parse(baseContext)).toEqual(baseContext);
  });

  it("requires a namespaced dimension", () => {
    expect(
      compactBotContextSchema.safeParse({
        ...baseContext,
        position: { ...baseContext.position, dimension: "overworld" },
      }).success,
    ).toBe(false);
  });

  it("rejects non-finite coordinates", () => {
    expect(
      compactBotContextSchema.safeParse({
        ...baseContext,
        position: { ...baseContext.position, y: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });

  it("rejects unknown top-level keys", () => {
    expect(
      compactBotContextSchema.safeParse({ ...baseContext, extra: 1 }).success,
    ).toBe(false);
  });

  it("caps relevantMemory arity to keep the prompt budget bounded", () => {
    const overflow = Array.from({ length: 33 }, (_, index) => `memory-${index}`);
    expect(
      compactBotContextSchema.safeParse({
        ...baseContext,
        relevantMemory: overflow,
      }).success,
    ).toBe(false);
  });

  it("caps individual memory entry length", () => {
    expect(
      compactBotContextSchema.safeParse({
        ...baseContext,
        relevantMemory: ["x".repeat(1_025)],
      }).success,
    ).toBe(false);
  });

  it("rejects skill ids that violate the protocol identifier shape", () => {
    expect(
      compactBotContextSchema.safeParse({
        ...baseContext,
        relevantSkills: ["not a valid id"],
      }).success,
    ).toBe(false);
  });

  it("rejects food above the vanilla ceiling", () => {
    expect(
      compactBotContextSchema.safeParse({ ...baseContext, food: 21 }).success,
    ).toBe(false);
  });

  it("allows a stated current task", () => {
    const parsed = compactBotContextSchema.parse({
      ...baseContext,
      currentTask: "gather wood",
    });
    expect(parsed.currentTask).toBe("gather wood");
  });
});

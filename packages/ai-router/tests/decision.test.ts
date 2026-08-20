import { describe, expect, it } from "vitest";

import {
  aiSkillDecisionJsonSchema,
  aiSkillDecisionSchema,
} from "../src/index.js";

describe("aiSkillDecisionSchema", () => {
  it("accepts only bounded skill proposals and wait decisions", () => {
    expect(aiSkillDecisionSchema.parse({
      action: "execute_skill",
      skill: "movement.goto",
      arguments: { x: 1, nested: { safe: true } },
      reason: "Move to the assigned work site.",
      confidence: 0.8,
    })).toMatchObject({ skill: "movement.goto" });
    expect(aiSkillDecisionSchema.parse({
      action: "wait",
      reason: "No safe compatible skill is available.",
      confidence: 1,
    })).toMatchObject({ action: "wait" });
  });

  it("rejects arbitrary action kinds and non-JSON arguments", () => {
    expect(aiSkillDecisionSchema.safeParse({
      action: "shell",
      command: "anything",
      reason: "unsafe",
      confidence: 1,
    }).success).toBe(false);
    expect(aiSkillDecisionSchema.safeParse({
      action: "execute_skill",
      skill: "movement.goto",
      arguments: { invalid: undefined },
      reason: "Invalid JSON value.",
      confidence: 0.5,
    }).success).toBe(false);
  });

  it("publishes the same two-action contract for provider structured output", () => {
    expect(aiSkillDecisionJsonSchema.oneOf).toHaveLength(2);
  });
});

import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  AIError,
  AIRouter,
  MockAIProvider,
  parseStructuredOutput,
} from "../src/index.js";
import { request, response } from "./helpers.js";

const actionSchema = z.object({
  action: z.literal("execute_skill"),
  skill: z.string().min(1),
  arguments: z.record(z.unknown()),
}).strict();

describe("AIRouter", () => {
  it("rejects duplicate provider names", () => {
    const router = new AIRouter();
    router.register(new MockAIProvider("mock", () => response()));
    expect(() => router.register(new MockAIProvider("mock", () => response())))
      .toThrowError(AIError);
  });

  it("prefers the requested provider without binding callers to an implementation", async () => {
    const router = new AIRouter();
    router.register(new MockAIProvider("fallback", () => response("fallback")));
    router.register(new MockAIProvider("spark", () => response("spark")));
    const result = await router.route(request({ preferredProvider: "spark" }));
    expect(result.provider).toBe("spark");
    expect(result.content).toBe("spark");
  });

  it("falls back when a provider is unavailable", async () => {
    const router = new AIRouter();
    router.register(new MockAIProvider("offline", () => response(), false));
    router.register(new MockAIProvider("healthy", () => response("healthy")));
    await expect(router.route(request())).resolves.toMatchObject({
      provider: "healthy",
      content: "healthy",
    });
  });

  it("repairs fenced structured output and validates it", async () => {
    const router = new AIRouter();
    router.register(new MockAIProvider("mock", () => response(
      '```json\n{"action":"execute_skill","skill":"collect_block","arguments":{}}\n```',
    )));
    const result = await router.route(request({
      output: { name: "skill_action", schema: actionSchema },
    }));
    expect(result.validated).toEqual({
      action: "execute_skill",
      skill: "collect_block",
      arguments: {},
    });
  });

  it("uses another provider when structured output remains invalid", async () => {
    const router = new AIRouter();
    router.register(new MockAIProvider("invalid", () => response("not-json")));
    router.register(new MockAIProvider("valid", () => response(
      '{"action":"execute_skill","skill":"movement_goto","arguments":{}}',
    )));
    const result = await router.route(request({
      output: { name: "skill_action", schema: actionSchema },
    }));
    expect(result.provider).toBe("valid");
  });

  it("fails closed when no provider is registered", async () => {
    await expect(new AIRouter().route(request())).rejects.toMatchObject({
      code: "AI_NO_PROVIDER",
    });
  });
});

describe("parseStructuredOutput", () => {
  it("extracts one balanced JSON object without evaluating surrounding text", () => {
    expect(parseStructuredOutput(
      'prose {"action":"execute_skill","skill":"craft_item","arguments":{"count":1}} trailing',
      { name: "skill_action", schema: actionSchema },
    )).toMatchObject({ skill: "craft_item" });
  });

  it("rejects schema-invalid JSON", () => {
    expect(() => parseStructuredOutput(
      '{"action":"shell","skill":"rm","arguments":{}}',
      { name: "skill_action", schema: actionSchema },
    )).toThrowError(AIError);
  });
});

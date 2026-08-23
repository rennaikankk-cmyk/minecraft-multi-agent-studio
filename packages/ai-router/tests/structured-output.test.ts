import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AIError } from "../src/errors.js";
import {
  parseStructuredOutput,
  type AIOutputContract,
} from "../src/structured-output.js";

const decisionContract: AIOutputContract<{ skillId: string; count: number }> = {
  name: "test-decision",
  schema: z
    .object({ skillId: z.string().min(1), count: z.number().int() })
    .strict(),
};

describe("parseStructuredOutput", () => {
  it("accepts bare JSON", () => {
    expect(
      parseStructuredOutput('{"skillId":"sleep","count":1}', decisionContract),
    ).toEqual({ skillId: "sleep", count: 1 });
  });

  it("recovers JSON from a fenced block", () => {
    const content = '```json\n{"skillId":"sleep","count":1}\n```';
    expect(parseStructuredOutput(content, decisionContract)).toEqual({
      skillId: "sleep",
      count: 1,
    });
  });

  it("recovers JSON wrapped in prose", () => {
    const content = 'Here is my plan: {"skillId":"sleep","count":1} — done.';
    expect(parseStructuredOutput(content, decisionContract)).toEqual({
      skillId: "sleep",
      count: 1,
    });
  });

  it("does not let braces inside strings unbalance extraction", () => {
    const contract: AIOutputContract<{ note: string }> = {
      name: "note",
      schema: z.object({ note: z.string() }).strict(),
    };
    const content = 'prefix {"note":"a } b { c"} suffix';
    expect(parseStructuredOutput(content, contract)).toEqual({
      note: "a } b { c",
    });
  });

  it("does not let escaped quotes terminate string tracking", () => {
    const contract: AIOutputContract<{ note: string }> = {
      name: "note",
      schema: z.object({ note: z.string() }).strict(),
    };
    const content = 'x {"note":"say \\"} hi\\" ok"} y';
    expect(parseStructuredOutput(content, contract)).toEqual({
      note: 'say "} hi" ok',
    });
  });

  it("rejects JSON that parses but violates the schema", () => {
    expect(() =>
      parseStructuredOutput('{"skillId":"sleep"}', decisionContract),
    ).toThrow(AIError);
  });

  it("rejects unknown keys rather than accepting them partially", () => {
    expect(() =>
      parseStructuredOutput(
        '{"skillId":"sleep","count":1,"extra":true}',
        decisionContract,
      ),
    ).toThrow(AIError);
  });

  it("reports the contract name and stays retryable on failure", () => {
    try {
      parseStructuredOutput("not json at all", decisionContract);
      expect.unreachable("expected AIError");
    } catch (error) {
      expect(error).toBeInstanceOf(AIError);
      const aiError = error as AIError;
      expect(aiError.code).toBe("AI_OUTPUT_INVALID");
      expect(aiError.retryable).toBe(true);
      expect(aiError.message).toContain("test-decision");
    }
  });

  it("does not evaluate model text", () => {
    expect(() =>
      parseStructuredOutput(
        '{"skillId":(()=>{throw new Error("evaluated")})(),"count":1}',
        decisionContract,
      ),
    ).toThrow(AIError);
  });

  it("accepts a top-level array contract", () => {
    const contract: AIOutputContract<readonly string[]> = {
      name: "list",
      schema: z.array(z.string()).readonly(),
    };
    expect(parseStructuredOutput('text ["a","b"] tail', contract)).toEqual([
      "a",
      "b",
    ]);
  });
});

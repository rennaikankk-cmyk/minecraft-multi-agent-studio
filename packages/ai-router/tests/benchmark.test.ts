import { describe, expect, it } from "vitest";

import {
  AIError,
  MockAIProvider,
  runAIConcurrencyBenchmark,
} from "../src/index.js";

describe("runAIConcurrencyBenchmark", () => {
  it("measures bounded levels and recommends a healthy concurrency", async () => {
    let id = 0;
    const result = await runAIConcurrencyBenchmark({
      provider: new MockAIProvider("mock", () => ({
        content: "ok",
        model: "mock",
        usage: { promptTokens: 5, completionTokens: 10 },
      })),
      concurrencyLevels: [2, 1, 2],
      requestsPerLevel: (concurrency) => concurrency * 2,
      randomId: () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, "0")}`,
    });

    expect(result.concurrencyLevels.map(({ concurrency }) => concurrency)).toEqual([1, 2]);
    expect(result.concurrencyLevels.every(({ failed }) => failed === 0)).toBe(true);
    expect(result.recommendedMaxConcurrency).not.toBeNull();
  });

  it("does not recommend levels above the allowed error rate", async () => {
    let id = 0;
    const result = await runAIConcurrencyBenchmark({
      provider: new MockAIProvider("failing", () => {
        throw new AIError("AI_PROVIDER_FAILED", "failed", { retryable: false });
      }),
      concurrencyLevels: [1],
      requestsPerLevel: 2,
      randomId: () => `00000000-0000-4000-8000-${(++id).toString(16).padStart(12, "0")}`,
    });

    expect(result.concurrencyLevels[0]).toMatchObject({
      failed: 2,
      errorRate: 1,
      errors: { AI_PROVIDER_FAILED: 2 },
    });
    expect(result.recommendedMaxConcurrency).toBeNull();
  });
});

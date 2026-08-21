import { describe, expect, it } from "vitest";

import {
  LocalAIConfigError,
  loadLocalAIConfig,
} from "../src/local-ai-config.js";

describe("loadLocalAIConfig", () => {
  it("keeps Local AI disabled when no endpoint or model is configured", () => {
    expect(loadLocalAIConfig({})).toEqual({
      enabled: false,
      baseUrl: null,
      model: null,
      maxConcurrency: 4,
      maxQueue: 64,
      perBotConcurrency: 1,
      requestTimeoutMs: 30_000,
    });
  });

  it("loads an explicit Spark origin and bounded scheduler settings", () => {
    expect(
      loadLocalAIConfig({
        LOCAL_AI_HUB_URL: "http://192.168.100.2:8000",
        LOCAL_AI_MODEL: "Qwen/Qwen3.8-27B-NVFP4",
        AI_MAX_CONCURRENCY: "4",
        AI_MAX_QUEUE: "64",
        AI_PER_BOT_CONCURRENCY: "1",
        AI_REQUEST_TIMEOUT_MS: "45000",
      }),
    ).toEqual({
      enabled: true,
      baseUrl: "http://192.168.100.2:8000",
      model: "Qwen/Qwen3.8-27B-NVFP4",
      maxConcurrency: 4,
      maxQueue: 64,
      perBotConcurrency: 1,
      requestTimeoutMs: 45_000,
    });
  });

  it.each([
    { LOCAL_AI_HUB_URL: "http://192.168.100.2:8000" },
    { LOCAL_AI_MODEL: "model-only" },
    {
      LOCAL_AI_HUB_URL: "http://user:secret@192.168.100.2:8000/v1",
      LOCAL_AI_MODEL: "model",
    },
    {
      LOCAL_AI_HUB_URL: "http://192.168.100.2:8000",
      LOCAL_AI_MODEL: "model",
      AI_MAX_CONCURRENCY: "0",
    },
  ])("rejects incomplete, secret-bearing, or unbounded config", (env) => {
    expect(() => loadLocalAIConfig(env)).toThrow(LocalAIConfigError);
  });
});

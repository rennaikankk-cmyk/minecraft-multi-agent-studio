import { describe, expect, it } from "vitest";

import {
  LocalAIConfigError,
  loadLocalAIConfig,
} from "../src/local-ai-config.js";

describe("loadLocalAIConfig", () => {
  it("accepts an external API path and backend credential reference without local hardware or model discovery", () => {
    expect(loadLocalAIConfig({ AI_BASE_URL: "https://provider.example.invalid/openai/v1/", AI_MODEL: "configured-model",
      AI_API_KEY_ENV: "TEST_PROVIDER_KEY", TEST_PROVIDER_KEY: "fixture-key", AI_STRUCTURED_OUTPUT: "tool", AI_MAX_OUTPUT_TOKENS: "2048", AI_MAX_ATTEMPTS: "3" })).toMatchObject({
      enabled: true, provider: "openai-compatible", baseUrl: "https://provider.example.invalid/openai/v1", model: "configured-model",
      apiKey: "fixture-key", apiKeyRef: "TEST_PROVIDER_KEY", structuredOutput: "tool", maxOutputTokens: 2048, maxAttempts: 3,
    });
  });

  it("preserves explicit cloud selection with legacy backend key configuration", () => {
    expect(loadLocalAIConfig({ LOCAL_AI_PROVIDER: "openai-compatible", LOCAL_AI_HUB_URL: "https://provider.example.invalid/v1",
      LOCAL_AI_MODEL: "configured-model", LOCAL_AI_API_KEY: "fixture-key" })).toMatchObject({ provider: "openai-compatible", maxAttempts: 2 });
  });

  it("gives the new API endpoint precedence without silently exporting a legacy local key", () => {
    const env = { AI_BASE_URL: "https://provider.example.invalid/v1", AI_MODEL: "cloud-model",
      LOCAL_AI_PROVIDER: "vllm", LOCAL_AI_HUB_URL: "http://127.0.0.1:8000", LOCAL_AI_API_KEY: "local-only-key" };
    expect(() => loadLocalAIConfig(env)).toThrow(LocalAIConfigError);
    expect(loadLocalAIConfig({ ...env, AI_API_KEY: "cloud-key" })).toMatchObject({ provider: "openai-compatible", apiKey: "cloud-key" });
  });

  it.each([
    { AI_BASE_URL: "https://provider.example.invalid/v1", AI_MODEL: "model" },
    { AI_BASE_URL: "https://provider.example.invalid/v1", AI_API_KEY: "fixture-key" },
    { AI_BASE_URL: "http://provider.example.invalid/v1", AI_MODEL: "model", AI_API_KEY: "fixture-key" },
    { AI_BASE_URL: "https://provider.example.invalid/v1", AI_MODEL: "model", AI_API_KEY: "fixture-key", AI_MAX_ATTEMPTS: "6" },
    { AI_BASE_URL: "https://provider.example.invalid/v1", AI_MODEL: "model", AI_API_KEY_ENV: "missing-key" },
    { AI_BASE_URL: "https://provider.example.invalid/v1", AI_MODEL: "model", AI_API_KEY: "fixture-key", AI_STRUCTURED_OUTPUT: "unverified" },
  ])("rejects incomplete or invalid external provider contracts", (env) => {
    expect(() => loadLocalAIConfig(env)).toThrow(LocalAIConfigError);
  });

  it("keeps Local AI disabled when no endpoint or model is configured", () => {
    expect(loadLocalAIConfig({})).toEqual({
      enabled: false,
      provider: "vllm",
      baseUrl: null,
      model: null,
      apiKey: null,
      maxConcurrency: 2,
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
        LOCAL_AI_PROVIDER: "ollama",
        LOCAL_AI_API_KEY: "test-api-key",
        AI_MAX_CONCURRENCY: "12",
        AI_MAX_QUEUE: "64",
        AI_PER_BOT_CONCURRENCY: "1",
        AI_REQUEST_TIMEOUT_MS: "45000",
      }),
    ).toEqual({
      enabled: true,
      provider: "ollama",
      baseUrl: "http://192.168.100.2:8000",
      model: "Qwen/Qwen3.8-27B-NVFP4",
      apiKey: "test-api-key",
      maxConcurrency: 12,
      maxQueue: 64,
      perBotConcurrency: 1,
      requestTimeoutMs: 45_000,
    });
  });

  it.each([
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
    {
      LOCAL_AI_HUB_URL: "http://192.168.100.2:8000",
      LOCAL_AI_MODEL: "model",
      LOCAL_AI_PROVIDER: "unsupported",
    },
  ])("rejects incomplete, secret-bearing, or unbounded config", (env) => {
    expect(() => loadLocalAIConfig(env)).toThrow(LocalAIConfigError);
  });
});

import { describe, expect, it } from "vitest";

import {
  CoordinatorAIConfigError,
  loadCoordinatorAIServiceConfig,
} from "../src/index.js";

const valid = {
  COORDINATOR_AI_ENABLED: "true",
  AI_PROVIDER_NAME: "spark-vllm",
  AI_BASE_URL: "http://192.168.50.2:8000/v1",
  AI_MODEL: "qwen3.8-27b-nvfp4",
  AI_API_KEY: "a-secure-runtime-key",
  AI_MAX_CONCURRENCY: "2",
} satisfies NodeJS.ProcessEnv;

describe("loadCoordinatorAIServiceConfig", () => {
  it("defaults disabled without requiring inference secrets", () => {
    expect(loadCoordinatorAIServiceConfig({})).toEqual({ enabled: false });
  });

  it("loads a bounded private-network provider profile", () => {
    expect(loadCoordinatorAIServiceConfig(valid)).toMatchObject({
      enabled: true,
      providerName: "spark-vllm",
      baseUrl: "http://192.168.50.2:8000/v1",
      model: "qwen3.8-27b-nvfp4",
      scheduler: { maxConcurrency: 2, perBotConcurrency: 1 },
      maxTokens: 512,
      temperature: 0.2,
      timeoutMs: 30_000,
    });
  });

  it("requires benchmark-selected concurrency and a runtime API key", () => {
    expect(() => loadCoordinatorAIServiceConfig({
      ...valid,
      AI_MAX_CONCURRENCY: "",
    })).toThrowError(CoordinatorAIConfigError);
    expect(() => loadCoordinatorAIServiceConfig({
      ...valid,
      AI_API_KEY: "short",
    })).toThrowError(CoordinatorAIConfigError);
    expect(() => loadCoordinatorAIServiceConfig({
      ...valid,
      AI_PROVIDER: "direct-bot-model",
    })).toThrowError(/openai-compatible/u);
  });

  it("rejects plaintext public endpoints and credentials embedded in URLs", () => {
    expect(() => loadCoordinatorAIServiceConfig({
      ...valid,
      AI_BASE_URL: "http://8.8.8.8:8000/v1",
    })).toThrowError(/Plain HTTP/u);
    expect(() => loadCoordinatorAIServiceConfig({
      ...valid,
      AI_BASE_URL: "https://user:password@example.com/v1",
    })).toThrowError(/unsupported URL components/u);
  });

  it("allows an authenticated HTTPS endpoint outside the private subnet", () => {
    expect(loadCoordinatorAIServiceConfig({
      ...valid,
      AI_BASE_URL: "https://inference.example.com/v1",
    })).toMatchObject({ enabled: true, baseUrl: "https://inference.example.com/v1" });
  });
});

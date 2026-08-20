import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { ControlApiConfigError, loadControlApiConfig } from "../src/index.js";

const TOKEN = "control-api-test-token-00000000000001";
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");

describe("Control API configuration", () => {
  it("loads a strict loopback configuration containing only token hashes", () => {
    const config = loadControlApiConfig({
      CONTROL_API_HOST: "127.0.0.1",
      CONTROL_API_PORT: "3210",
      CONTROL_API_AUTH_JSON: JSON.stringify([
        {
          subject: "viewer-01",
          tokenSha256: TOKEN_HASH,
          permissions: ["bot.read"],
        },
      ]),
    });

    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3210,
      principals: [{ subject: "viewer-01", tokenSha256: TOKEN_HASH }],
    });
  });

  it("rejects missing authentication and non-loopback binding", () => {
    expect(() => loadControlApiConfig({})).toThrowError(ControlApiConfigError);
    expect(() =>
      loadControlApiConfig({
        CONTROL_API_HOST: "0.0.0.0",
        CONTROL_API_AUTH_JSON: "[]",
      }),
    ).toThrowError(expect.objectContaining({ code: "CONTROL_API_CONFIG_INVALID" }));
  });

  it("rejects plaintext token fields and unknown permissions", () => {
    expect(() =>
      loadControlApiConfig({
        CONTROL_API_AUTH_JSON: JSON.stringify([
          {
            subject: "viewer-01",
            token: TOKEN,
            tokenSha256: TOKEN_HASH,
            permissions: ["bot.read"],
          },
        ]),
      }),
    ).toThrowError(ControlApiConfigError);
    expect(() =>
      loadControlApiConfig({
        CONTROL_API_AUTH_JSON: JSON.stringify([
          {
            subject: "viewer-01",
            tokenSha256: TOKEN_HASH,
            permissions: ["bot.admin"],
          },
        ]),
      }),
    ).toThrowError(ControlApiConfigError);
  });

  it("loads optional Spark metrics without exposing it by default", () => {
    const base = {
      CONTROL_API_AUTH_JSON: JSON.stringify([
        {
          subject: "ai-viewer-01",
          tokenSha256: TOKEN_HASH,
          permissions: ["ai.metrics.read"],
        },
      ]),
    };
    expect(loadControlApiConfig(base).sparkMetrics).toBeNull();
    expect(
      loadControlApiConfig({
        ...base,
        SPARK_AI_BASE_URL: "http://192.168.50.2:8000/v1",
        SPARK_AI_NODE_NAME: "MSI DGX Spark",
        SPARK_AI_BACKEND: "vllm",
        SPARK_AI_QUANTIZATION: "modelopt_fp4",
        SPARK_AI_API_KEY: "spark-test-api-key-0000000001",
        SPARK_METRICS_TIMEOUT_MS: "3000",
        AI_MAX_CONCURRENCY: "10",
      }).sparkMetrics,
    ).toEqual({
      baseUrl: "http://192.168.50.2:8000/v1",
      nodeName: "MSI DGX Spark",
      backend: "vllm",
      quantization: "modelopt_fp4",
      apiKey: "spark-test-api-key-0000000001",
      timeoutMs: 3_000,
      maxConcurrency: 10,
    });
    expect(() =>
      loadControlApiConfig({ ...base, SPARK_AI_BASE_URL: "file:///etc/passwd" }),
    ).toThrowError(ControlApiConfigError);
    expect(() =>
      loadControlApiConfig({
        ...base,
        SPARK_AI_BASE_URL: "http://192.168.50.2:8000/v1",
        SPARK_AI_API_KEY: "",
      }),
    ).toThrowError(ControlApiConfigError);
    expect(
      loadControlApiConfig({
        ...base,
        SPARK_AI_BASE_URL: "http://127.0.0.1:8000/v1",
        SPARK_AI_API_KEY: "",
      }).sparkMetrics,
    ).toMatchObject({ baseUrl: "http://127.0.0.1:8000/v1" });
  });
});

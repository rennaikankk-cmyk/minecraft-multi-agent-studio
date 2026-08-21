import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OllamaAdapter } from "../src/adapters/ollama-adapter.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaAdapter", () => {
  it("uses native model discovery and requires the configured model", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ models: [{ name: "qwen-fast:latest" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OllamaAdapter("http://127.0.0.1:11435", "qwen-fast:latest");

    await expect(adapter.health()).resolves.toMatchObject({ available: true });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("http://127.0.0.1:11435/api/tags");
  });

  it("fails closed when the configured model is absent or the model list is malformed", async () => {
    const missingModel = new OllamaAdapter("http://127.0.0.1:11435", "qwen-fast:latest");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ models: [{ name: "other-model" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(missingModel.health()).resolves.toMatchObject({
      available: false,
      error: "Model qwen-fast:latest is not advertised.",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ models: [{ id: "qwen-fast:latest" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    await expect(missingModel.health()).resolves.toMatchObject({ available: false });
  });

  it("disables thinking and requests native JSON Schema output", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          message: { content: '{"action":"noop"}' },
          prompt_eval_count: 12,
          eval_count: 5,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const adapter = new OllamaAdapter("http://127.0.0.1:11435", "qwen-fast:latest");

    await expect(
      adapter.generate({
        prompt: "plan",
        maxTokens: 64,
        temperature: 0,
        timeoutMs: 5_000,
        traceId: "trace-ollama",
        schema: z.object({ action: z.literal("noop") }).strict(),
      }),
    ).resolves.toEqual({
      content: '{"action":"noop"}',
      usage: { promptTokens: 12, completionTokens: 5 },
    });

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("http://127.0.0.1:11435/api/chat");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: "qwen-fast:latest",
      stream: false,
      think: false,
      options: { temperature: 0, num_predict: 64 },
      format: { type: "object" },
    });
  });
});

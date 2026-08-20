import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAICompatibleProvider } from "../src/index.js";
import { request } from "./helpers.js";

afterEach(() => vi.unstubAllGlobals());

describe("OpenAICompatibleProvider", () => {
  it("accepts a base URL already ending in /v1 and sends auth only when configured", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        model: "served-model",
        choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 7, completion_tokens: 1 },
      }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      name: "spark",
      baseUrl: "http://192.0.2.2:8000/v1",
      model: "qwen-target",
      apiKey: "test-key",
    });
    await expect(provider.health()).resolves.toMatchObject({ available: true });
    await expect(provider.generate(request(), new AbortController().signal))
      .resolves.toMatchObject({ model: "served-model", content: "ok" });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "http://192.0.2.2:8000/health",
      "http://192.0.2.2:8000/v1/models",
      "http://192.0.2.2:8000/v1/chat/completions",
    ]);
    expect(fetchMock.mock.calls[2]![1]?.headers).toMatchObject({
      Authorization: "Bearer test-key",
    });
  });

  it("requests JSON schema output when a transport schema is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new OpenAICompatibleProvider({
      name: "spark",
      baseUrl: "http://localhost:8000",
      model: "model",
    });
    await provider.generate(request({
      output: {
        name: "decision",
        schema: { safeParse: () => ({ success: true, data: {} }) } as never,
        jsonSchema: { type: "object", additionalProperties: false },
      },
    }), new AbortController().signal);
    const body = JSON.parse(String(fetchMock.mock.calls[0]![1]?.body));
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "decision",
        strict: true,
        schema: { type: "object", additionalProperties: false },
      },
    });
  });
});

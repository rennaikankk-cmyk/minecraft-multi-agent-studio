import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { OllamaAdapter } from "../src/adapters/ollama-adapter.js";
import { AIError } from "../src/errors.js";
import { AIRequestScheduler, type AISchedulerError } from "../src/scheduler.js";
import type { GenerateOptions } from "../src/types/adapter.js";

const baseUrl = "http://127.0.0.1:11435";
const request: GenerateOptions = {
  prompt: "plan",
  maxTokens: 64,
  temperature: 0,
  timeoutMs: 5_000,
  traceId: "trace-ollama-errors",
};
const adapter = () => new OllamaAdapter(baseUrl, "qwen-fast:latest");
const completion = () =>
  new Response(
    JSON.stringify({
      message: { content: '{"action":"noop"}' },
      prompt_eval_count: 12,
      eval_count: 5,
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

/** Mirrors the retry policy the coordinator declares for its AI scheduler. */
const coordinatorRetry = {
  maxAttempts: 2,
  baseDelayMs: 1,
  maxDelayMs: 1_000,
  jitterRatio: 0,
  retryable: (error: unknown) => error instanceof AIError && error.retryable,
};

/**
 * Transport stand-in for the abort paths. It rejects with whatever the abort
 * surfaced on the signal, which is what undici does for an aborted fetch, and
 * also covers a transport that ignores the abort reason entirely.
 */
const abortableTransport = (failure: (init: RequestInit) => unknown) =>
  vi.fn<typeof fetch>(async (_url, init) => {
    const signal = init?.signal;
    if (!signal) throw new Error("expected an abort signal");
    if (signal.aborted) return Promise.reject(failure(init!));
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(failure(init!)), { once: true });
    });
  });

const catchError = (promise: Promise<unknown>): Promise<unknown> =>
  promise.catch((cause: unknown) => cause);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaAdapter failure classification", () => {
  it.each([
    [400, "AI_CONFIG_INVALID", false],
    [401, "AI_AUTH_FAILED", false],
    [403, "AI_AUTH_FAILED", false],
    [404, "AI_CONFIG_INVALID", false],
    [418, "AI_CONFIG_INVALID", false],
    [429, "AI_RATE_LIMITED", true],
    [500, "AI_PROVIDER_UNAVAILABLE", true],
    [502, "AI_PROVIDER_UNAVAILABLE", true],
    [503, "AI_PROVIDER_UNAVAILABLE", true],
  ] as const)("classifies HTTP %s as %s (retryable=%s)", async (status, code, retryable) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("private-fixture-body", {
            status,
            statusText: "Upstream Detail",
          }),
      ),
    );

    const error = await catchError(adapter().generate(request));

    expect(error).toBeInstanceOf(AIError);
    expect(error).toMatchObject({ code, retryable, provider: "ollama", statusCode: status });
    // The classification must ride the declared retry policy, and upstream text
    // must never leak through the classified error.
    expect(coordinatorRetry.retryable(error)).toBe(retryable);
    expect(String(error)).not.toContain("private-fixture-body");
    expect(String(error)).not.toContain("Upstream Detail");
  });

  it.each([
    ["a body that is not JSON", () => new Response("not-json", { status: 200 })],
    [
      "a response without a message",
      () =>
        new Response(JSON.stringify({ prompt_eval_count: 1, eval_count: 1 }), { status: 200 }),
    ],
    [
      "an empty completion content",
      () =>
        new Response(
          JSON.stringify({
            message: { content: "" },
            prompt_eval_count: 1,
            eval_count: 1,
          }),
          { status: 200 },
        ),
    ],
    [
      "a non-string completion content",
      () =>
        new Response(
          JSON.stringify({
            message: { content: 42 },
            prompt_eval_count: 1,
            eval_count: 1,
          }),
          { status: 200 },
        ),
    ],
    [
      "missing token counters",
      () => new Response(JSON.stringify({ message: { content: "ready" } }), { status: 200 }),
    ],
  ])("classifies %s as a non-retryable AI_OUTPUT_INVALID", async (_label, body) => {
    vi.stubGlobal("fetch", vi.fn(async () => body()));

    const error = await catchError(adapter().generate(request));

    expect(error).toMatchObject({ code: "AI_OUTPUT_INVALID", retryable: false, provider: "ollama" });
    expect(coordinatorRetry.retryable(error)).toBe(false);
  });

  it("classifies an inexpressible request schema as a non-retryable AI_CONFIG_INVALID without calling the provider", async () => {
    const fetcher = vi.fn(async () => completion());
    vi.stubGlobal("fetch", fetcher);

    const error = await catchError(
      adapter().generate({ ...request, schema: z.object({ when: z.date() }) }),
    );

    expect(error).toMatchObject({ code: "AI_CONFIG_INVALID", retryable: false, provider: "ollama" });
    expect(coordinatorRetry.retryable(error)).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("classifies its own timeout as a retryable AI_PROVIDER_TIMEOUT when the transport rethrows the abort reason", async () => {
    vi.stubGlobal("fetch", abortableTransport((init) => init.signal?.reason));

    const error = await catchError(adapter().generate({ ...request, timeoutMs: 5 }));

    expect(error).toMatchObject({ code: "AI_PROVIDER_TIMEOUT", retryable: true, provider: "ollama" });
    expect(coordinatorRetry.retryable(error)).toBe(true);
  });

  it("classifies its own timeout even when the transport drops the abort reason", async () => {
    vi.stubGlobal(
      "fetch",
      abortableTransport(() => new DOMException("aborted", "AbortError")),
    );

    const error = await catchError(adapter().generate({ ...request, timeoutMs: 5 }));

    expect(error).toMatchObject({ code: "AI_PROVIDER_TIMEOUT", retryable: true, provider: "ollama" });
    expect(coordinatorRetry.retryable(error)).toBe(true);
  });

  it("classifies caller cancellation as a non-retryable AI_CANCELLED", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      abortableTransport(() => new Error("transport cancelled")),
    );

    const pending = adapter().generate({ ...request, signal: controller.signal });
    controller.abort();
    const error = await catchError(pending);

    expect(error).toMatchObject({ code: "AI_CANCELLED", retryable: false, provider: "ollama" });
    expect(coordinatorRetry.retryable(error)).toBe(false);
  });

  it("classifies an already-cancelled caller signal as AI_CANCELLED", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal("fetch", abortableTransport((init) => init.signal?.reason));

    await expect(
      adapter().generate({ ...request, signal: controller.signal }),
    ).rejects.toMatchObject({ code: "AI_CANCELLED", retryable: false });
  });

  it("normalises a genuinely unknown transport throw with asAIError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );

    const error = await catchError(adapter().generate(request));

    expect(error).toMatchObject({ code: "AI_PROVIDER_FAILED", retryable: true, provider: "ollama" });
  });

  it("does not mask an already classified AIError", async () => {
    const classified = new AIError("AI_RATE_LIMITED", "fixture", {
      provider: "ollama",
      retryable: true,
      statusCode: 429,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw classified;
      }),
    );

    await expect(adapter().generate(request)).rejects.toBe(classified);
  });
});

describe("OllamaAdapter failure classification through the scheduler", () => {
  it("retries a transient 5xx through the declared coordinator retry policy", async () => {
    let chatCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        chatCalls += 1;
        return chatCalls === 1 ? new Response("", { status: 503 }) : completion();
      }),
    );
    const scheduler = new AIRequestScheduler({ defaultRetry: coordinatorRetry });

    const scheduled = scheduler.schedule({
      requestId: "request-5xx",
      botId: "BotOne",
      priority: 30,
      timeoutMs: 5_000,
      execute: () => adapter().generate(request),
    });

    await expect(scheduled).resolves.toMatchObject({ attempts: 2 });
    expect(chatCalls).toBe(2);
  });

  it("retries its own timeout through the declared coordinator retry policy", async () => {
    let chatCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (_url, init) => {
        chatCalls += 1;
        if (chatCalls > 1) return completion();
        const signal = init?.signal;
        if (!signal) throw new Error("expected an abort signal");
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }),
    );
    const scheduler = new AIRequestScheduler({ defaultRetry: coordinatorRetry });

    const scheduled = scheduler.schedule({
      requestId: "request-timeout",
      botId: "BotTwo",
      priority: 30,
      timeoutMs: 5_000,
      // The adapter owns a 20ms per-attempt budget and the scheduler deadline
      // stays above it, so this exercises the adapter's own timeout path.
      execute: () => adapter().generate({ ...request, timeoutMs: 20 }),
    });

    await expect(scheduled).resolves.toMatchObject({ attempts: 2 });
    expect(chatCalls).toBe(2);
  });

  it("never retries a 4xx configuration failure and keeps the classified cause", async () => {
    let chatCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        chatCalls += 1;
        return new Response("", { status: 400 });
      }),
    );
    const scheduler = new AIRequestScheduler({ defaultRetry: coordinatorRetry });

    const scheduled = scheduler.schedule({
      requestId: "request-4xx",
      botId: "BotOne",
      priority: 30,
      timeoutMs: 5_000,
      execute: () => adapter().generate(request),
    });

    const failure = (await catchError(scheduled)) as AISchedulerError;
    expect(failure).toMatchObject({ code: "AI_REQUEST_FAILED" });
    expect(failure.cause).toMatchObject({ code: "AI_CONFIG_INVALID", retryable: false });
    expect(chatCalls).toBe(1);
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  AIError,
  AIRouter,
  AIRequestScheduler,
  MockAIProvider,
  type AIProviderResponse,
  type AISchedulerConfig,
} from "../src/index.js";
import { deferred, request, response } from "./helpers.js";

const baseConfig: AISchedulerConfig = {
  maxConcurrency: 2,
  maxQueue: 64,
  perBotConcurrency: 1,
  staleAfterMs: 10_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 2,
};

function schedulerWith(
  responder: ConstructorParameters<typeof MockAIProvider>[1],
  config: Partial<AISchedulerConfig> = {},
) {
  const router = new AIRouter();
  router.register(new MockAIProvider("mock", responder));
  return new AIRequestScheduler(router, { ...baseConfig, ...config });
}

describe("AIRequestScheduler", () => {
  it("keeps planning inflight at one per Bot", async () => {
    const gates = [deferred<AIProviderResponse>(), deferred<AIProviderResponse>()];
    let calls = 0;
    const scheduler = schedulerWith(() => gates[calls++]!.promise, {
      maxConcurrency: 4,
      perBotConcurrency: 1,
    });
    const first = scheduler.submit(request({ botId: "same-bot" }));
    const second = scheduler.submit(request({ botId: "same-bot" }));
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(scheduler.snapshot()).toMatchObject({ running: 1, waiting: 1 });
    gates[0]!.resolve(response("first"));
    await vi.waitFor(() => expect(calls).toBe(2));
    gates[1]!.resolve(response("second"));
    await expect(Promise.all([first.promise, second.promise])).resolves.toHaveLength(2);
  });

  it("runs different Bots concurrently up to the configured limit", async () => {
    const gates = Array.from({ length: 10 }, () => deferred<AIProviderResponse>());
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    const scheduler = schedulerWith(async (_request, signal) => {
      const index = calls++;
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        return await Promise.race([
          gates[index]!.promise,
          new Promise<never>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
          ),
        ]);
      } finally {
        active -= 1;
      }
    }, { maxConcurrency: 4 });
    const handles = Array.from({ length: 10 }, (_, index) =>
      scheduler.submit(request({ botId: `bot-${index}` })),
    );
    await vi.waitFor(() => expect(calls).toBe(4));
    expect(maximumActive).toBe(4);
    for (let index = 0; index < gates.length; index += 1) {
      gates[index]!.resolve(response(`bot-${index}`));
      if (index < 6) await vi.waitFor(() => expect(calls).toBe(index + 5));
    }
    await expect(Promise.all(handles.map((handle) => handle.promise)))
      .resolves.toHaveLength(10);
  });

  it.each([1, 2, 5, 10])("supports %i simulated Bots through one provider", async (count) => {
    const scheduler = schedulerWith(() => response());
    const results = await Promise.all(
      Array.from({ length: count }, (_, index) =>
        scheduler.submit(request({ botId: `bot-${index}` })).promise,
      ),
    );
    expect(results).toHaveLength(count);
    expect(scheduler.snapshot().completed).toBe(count);
  });

  it("prioritizes planning ahead of queued chat so chat cannot starve it", async () => {
    const firstGate = deferred<AIProviderResponse>();
    const executionOrder: string[] = [];
    let calls = 0;
    const scheduler = schedulerWith(async (item) => {
      executionOrder.push(item.traceId);
      if (calls++ === 0) return firstGate.promise;
      return response(item.traceId);
    }, { maxConcurrency: 1 });
    const running = scheduler.submit(request({ botId: "blocker", traceId: "running" }));
    await vi.waitFor(() => expect(calls).toBe(1));
    const chat1 = scheduler.submit(request({ botId: "chat-1", traceId: "chat-1", taskType: "chat", priority: 80 }));
    const chat2 = scheduler.submit(request({ botId: "chat-2", traceId: "chat-2", taskType: "chat", priority: 80 }));
    const planner = scheduler.submit(request({ botId: "planner", traceId: "planner", taskType: "planner", priority: 30 }));
    firstGate.resolve(response("running"));
    await Promise.all([running.promise, chat1.promise, chat2.promise, planner.promise]);
    expect(executionOrder).toEqual(["running", "planner", "chat-1", "chat-2"]);
  });

  it("rejects new work with explicit backpressure when the queue is full", async () => {
    const gate = deferred<AIProviderResponse>();
    const scheduler = schedulerWith(() => gate.promise, {
      maxConcurrency: 1,
      maxQueue: 1,
    });
    const running = scheduler.submit(request({ botId: "running" }));
    const queued = scheduler.submit(request({ botId: "queued" }));
    const rejected = scheduler.submit(request({ botId: "rejected" }));
    await expect(rejected.promise).rejects.toMatchObject({ code: "AI_QUEUE_FULL" });
    gate.resolve(response());
    await running.promise;
    scheduler.close();
    await expect(queued.promise).rejects.toMatchObject({ code: "AI_CANCELLED" });
  });

  it("cancels an old inflight decision when Bot state advances", async () => {
    const started = deferred<void>();
    const scheduler = schedulerWith(async (_item, signal) => {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const old = scheduler.submit(request({ botId: "bot-stale", stateVersion: 1 }));
    await started.promise;
    expect(scheduler.invalidateBot("bot-stale", 2, 1)).toBe(1);
    await expect(old.promise).rejects.toMatchObject({ code: "AI_REQUEST_STALE" });
  });

  it("rejects an already obsolete request before provider execution", async () => {
    let calls = 0;
    const scheduler = schedulerWith(() => {
      calls += 1;
      return response();
    });
    scheduler.invalidateBot("bot-stale", 5, 3);
    const stale = scheduler.submit(request({
      botId: "bot-stale",
      stateVersion: 4,
      taskVersion: 3,
    }));
    await expect(stale.promise).rejects.toMatchObject({ code: "AI_REQUEST_STALE" });
    expect(calls).toBe(0);
  });

  it("supports explicit cancellation", async () => {
    const started = deferred<void>();
    const scheduler = schedulerWith(async (_item, signal) => {
      started.resolve();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const handle = scheduler.submit(request());
    await started.promise;
    expect(handle.cancel("user_stop")).toBe(true);
    await expect(handle.promise).rejects.toMatchObject({ code: "AI_CANCELLED" });
  });

  it("times out a provider that honors cancellation", async () => {
    const scheduler = schedulerWith(async (_item, signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      ),
    );
    const handle = scheduler.submit(request({ timeoutMs: 10 }));
    await expect(handle.promise).rejects.toMatchObject({ code: "AI_REQUEST_TIMEOUT" });
  });

  it("retries bounded transient provider failures", async () => {
    let attempts = 0;
    const scheduler = schedulerWith(() => {
      attempts += 1;
      if (attempts === 1) {
        throw new AIError("AI_PROVIDER_FAILED", "transient", { retryable: true });
      }
      return response("recovered");
    }, { maxRetries: 1 });
    await expect(scheduler.submit(request()).promise).resolves.toMatchObject({
      content: "recovered",
      attempts: 2,
    });
  });

  it("preserves and validates a structured output contract through the queue", async () => {
    const scheduler = schedulerWith(() => response('{"skill":"collect_block"}'));
    const result = await scheduler.submit(request({
      output: {
        name: "decision",
        schema: z.object({ skill: z.string() }).strict(),
      },
    })).promise;
    expect(result.validated).toEqual({ skill: "collect_block" });
  });

  it("rejects an AbortSignal that was already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const scheduler = schedulerWith(() => response());
    await expect(scheduler.submit(request(), { signal: controller.signal }).promise)
      .rejects.toMatchObject({ code: "AI_CANCELLED" });
    expect(scheduler.snapshot()).toMatchObject({ running: 0, waiting: 0 });
  });
});

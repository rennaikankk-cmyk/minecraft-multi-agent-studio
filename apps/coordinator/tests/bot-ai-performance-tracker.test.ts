import type { BotAiPerformanceV1 } from "@minecraft-studio/protocol";
import { describe, expect, it, vi } from "vitest";

import { BotAiPerformanceTracker } from "../src/index.js";

const observation: BotAiPerformanceV1 = {
  state: "completed",
  observedAt: "2026-08-20T03:00:00.000Z",
  botId: "worker-01",
  requestId: "11111111-1111-4111-8111-111111111111",
  taskId: "task-01",
  taskType: "planner",
  provider: "spark-local",
  model: "qwen-model",
  queueTimeMs: 4,
  providerQueueTimeMs: 2,
  totalLatencyMs: 92,
  timeToFirstTokenMs: 40,
  generationTimeMs: 50,
  meanInterTokenLatencyMs: 5,
  generationTokensPerSecond: 20,
  promptTokens: 100,
  outputTokens: 10,
  errorCode: null,
};

describe("BotAiPerformanceTracker", () => {
  it("retains and publishes the latest validated observation per Bot", () => {
    const tracker = new BotAiPerformanceTracker();
    const listener = vi.fn();
    const unsubscribe = tracker.subscribe(listener);

    tracker.record(observation);

    expect(tracker.get("worker-01")).toEqual(observation);
    expect(listener).toHaveBeenCalledWith(observation);
    unsubscribe();
    tracker.record({ ...observation, state: "waiting" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(tracker.get("missing")).toBeNull();
  });

  it("rejects malformed telemetry instead of publishing it", () => {
    const tracker = new BotAiPerformanceTracker();
    expect(() => tracker.record({ ...observation, totalLatencyMs: -1 }))
      .toThrow();
    expect(tracker.get("worker-01")).toBeNull();
  });
});

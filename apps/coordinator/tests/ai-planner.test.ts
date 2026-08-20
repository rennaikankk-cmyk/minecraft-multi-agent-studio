import {
  AIRouter,
  AIRequestScheduler,
  MockAIProvider,
  type AIProviderResponse,
  type AISchedulerConfig,
} from "@minecraft-studio/ai-router";
import { describe, expect, it } from "vitest";
import type { BotAiPerformanceV1 } from "@minecraft-studio/protocol";

import {
  BotRegistry,
  CoordinatorAIPlanner,
  CoordinatorAIPlanningError,
  type CoordinatorRelevantMemoryProvider,
} from "../src/index.js";

const NOW = new Date("2026-08-20T03:00:00.000Z");
const schedulerConfig: AISchedulerConfig = {
  maxConcurrency: 2,
  maxQueue: 16,
  perBotConcurrency: 1,
  staleAfterMs: 10_000,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  retryMaxDelayMs: 2,
};

function messageId(sequence: number): string {
  return `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`;
}

function status(sequence: number) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(sequence),
    traceId: "trace-ai-planner",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime" as const, instanceId: "runtime-a" },
    botId: "worker-01",
    type: "bot.status.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-a",
      sequence,
      observedAt: NOW.toISOString(),
      connectionState: "online" as const,
      health: { current: 20, maximum: 20 },
      food: { level: 18, saturation: 5 },
      armorPoints: 0,
      position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
    },
  };
}

function skillCatalog(sequence: number) {
  return {
    schemaVersion: "1.0" as const,
    messageId: messageId(sequence),
    traceId: "trace-ai-planner",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime" as const, instanceId: "runtime-a" },
    botId: "worker-01",
    type: "bot.skill-catalog.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-a",
      sequence,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [
        {
          skillId: "movement.goto",
          skillVersion: "1.0.0",
          availability: "available" as const,
          verification: "unverified" as const,
          selectedVariantId: "portable",
          unavailableReasons: [],
        },
        {
          skillId: "combat.attack",
          skillVersion: "1.0.0",
          availability: "unavailable" as const,
          verification: "unverified" as const,
          selectedVariantId: null,
          unavailableReasons: [
            {
              variantId: "portable",
              code: "FEATURE_MISSING" as const,
              subject: "combat",
            },
          ],
        },
      ],
    },
  };
}

function readyRegistry(): BotRegistry {
  const registry = new BotRegistry({ staleAfterMs: 30_000, now: () => NOW });
  registry.ingest(status(1), NOW);
  registry.ingest(skillCatalog(2), NOW);
  return registry;
}

function response(content: string): AIProviderResponse {
  return {
    content,
    model: "mock-model",
    usage: { promptTokens: 20, completionTokens: 10 },
    metrics: {
      timeToFirstTokenMs: 40,
      generationTimeMs: 75,
      queueTimeMs: 5,
      meanInterTokenLatencyMs: 7.5,
      tokensPerSecond: 133.3,
    },
  };
}

function createPlanner(
  registry: BotRegistry,
  responder: ConstructorParameters<typeof MockAIProvider>[1],
  onObservation?: (observation: BotAiPerformanceV1) => void,
  relevantMemoryProvider?: CoordinatorRelevantMemoryProvider,
) {
  const router = new AIRouter();
  router.register(new MockAIProvider("spark-mock", responder));
  const scheduler = new AIRequestScheduler(router, schedulerConfig, () => NOW.getTime());
  const planner = new CoordinatorAIPlanner({
    registry,
    scheduler,
    now: () => NOW,
    randomId: () => "11111111-1111-4111-8111-111111111111",
    ...(onObservation === undefined ? {} : { onObservation }),
    ...(relevantMemoryProvider === undefined
      ? {}
      : { relevantMemoryProvider }),
  });
  return { planner, scheduler };
}

describe("CoordinatorAIPlanner", () => {
  it("retrieves memory only for the Bot's current server, dimension, and position", async () => {
    const registry = readyRegistry();
    let providerPrompt = "";
    let memoryRequest: Parameters<CoordinatorRelevantMemoryProvider>[0] | null = null;
    const { planner } = createPlanner(
      registry,
      (request) => {
        providerPrompt = `${request.systemPrompt ?? ""}\n${request.prompt}`;
        return response(JSON.stringify({
          action: "wait",
          reason: "Use the verified safe route.",
          confidence: 0.8,
        }));
      },
      undefined,
      async (request) => {
        memoryRequest = request;
        return ["[hazard; confidence=0.90] Lava blocks the eastern tunnel."];
      },
    );

    await expect(
      planner.requestPlan({
        botId: "worker-01",
        task: "Find a safe route",
        taskVersion: 1,
      }).promise,
    ).resolves.toMatchObject({ action: "wait" });
    expect(memoryRequest).toMatchObject({
      botId: "worker-01",
      serverProfileId: "isolated-test",
      dimension: "minecraft:overworld",
      position: { x: 1, y: 64, z: 2 },
      taskVersion: 1,
    });
    expect(providerPrompt).toContain("Lava blocks the eastern tunnel");
    planner.close();
  });

  it("fails closed before contacting AI when memory retrieval fails", async () => {
    const registry = readyRegistry();
    let providerCalled = false;
    const { planner } = createPlanner(
      registry,
      () => {
        providerCalled = true;
        return response(JSON.stringify({
          action: "wait",
          reason: "must not run",
          confidence: 1,
        }));
      },
      undefined,
      async () => {
        throw new Error("database unavailable");
      },
    );
    await expect(
      planner.requestPlan({
        botId: "worker-01",
        task: "Plan with authoritative memory",
        taskVersion: 1,
      }).promise,
    ).rejects.toMatchObject({ code: "MEMORY_LOOKUP_FAILED" });
    expect(providerCalled).toBe(false);
    planner.close();
  });

  it("cancels an unscheduled memory lookup when Bot state advances", async () => {
    const registry = readyRegistry();
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const { planner } = createPlanner(
      registry,
      () => response(JSON.stringify({
        action: "wait",
        reason: "must not run",
        confidence: 1,
      })),
      undefined,
      async ({ signal }) => {
        markStarted?.();
        return await new Promise<readonly string[]>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
      },
    );
    const handle = planner.requestPlan({
      botId: "worker-01",
      task: "Slow memory lookup",
      taskVersion: 1,
    });
    await started;
    registry.ingest(status(3), NOW);
    await expect(handle.promise).rejects.toMatchObject({ code: "AI_CANCELLED" });
    planner.close();
  });

  it("returns a catalog-bound proposal without creating execution authorization", async () => {
    const registry = readyRegistry();
    let providerPrompt = "";
    const observations: BotAiPerformanceV1[] = [];
    const { planner } = createPlanner(registry, (request) => {
      providerPrompt = request.systemPrompt ?? "";
      return response(JSON.stringify({
        action: "execute_skill",
        skill: "movement.goto",
        arguments: { x: 10, y: 64, z: 10 },
        reason: "Move to the assigned site.",
        confidence: 0.9,
      }));
    }, (observation) => observations.push(observation));

    const proposal = await planner.requestPlan({
      botId: "worker-01",
      task: "Move to the work site",
      taskId: "task-01",
      taskVersion: 1,
    }).promise;

    expect(proposal).toMatchObject({
      action: "execute_skill",
      skillId: "movement.goto",
      skillVersion: "1.0.0",
      selectedVariantId: "portable",
      arguments: { x: 10, y: 64, z: 10 },
      stateVersion: 1,
      taskVersion: 1,
    });
    expect(proposal).not.toHaveProperty("authorization");
    expect(providerPrompt).toContain("movement.goto");
    expect(providerPrompt).not.toContain("combat.attack");
    expect(observations).toEqual([
      expect.objectContaining({ state: "queued", botId: "worker-01" }),
      expect.objectContaining({
        state: "completed",
        botId: "worker-01",
        providerQueueTimeMs: 5,
        timeToFirstTokenMs: 40,
        generationTokensPerSecond: 133.3,
        promptTokens: 20,
        outputTokens: 10,
      }),
    ]);
    planner.close();
  });

  it("allows an explicit wait decision", async () => {
    const { planner } = createPlanner(readyRegistry(), () => response(JSON.stringify({
      action: "wait",
      reason: "The current state is insufficient.",
      confidence: 0.7,
    })));
    await expect(planner.requestPlan({
      botId: "worker-01",
      task: "Assess the area",
      taskVersion: 1,
    }).promise).resolves.toMatchObject({ action: "wait" });
    planner.close();
  });

  it("rejects model-invented or incompatible skills", async () => {
    const { planner } = createPlanner(readyRegistry(), () => response(JSON.stringify({
      action: "execute_skill",
      skill: "combat.attack",
      arguments: {},
      reason: "This skill is unavailable.",
      confidence: 0.5,
    })));
    await expect(planner.requestPlan({
      botId: "worker-01",
      task: "Fight",
      taskVersion: 1,
    }).promise).rejects.toMatchObject({ code: "SKILL_NOT_AVAILABLE" });
    planner.close();
  });

  it("cancels an inflight plan when a newer status arrives", async () => {
    const registry = readyRegistry();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const { planner } = createPlanner(registry, (_request, signal) => {
      started();
      return new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
      );
    });
    const handle = planner.requestPlan({
      botId: "worker-01",
      task: "Long planning request",
      taskVersion: 1,
    });
    await startedPromise;
    registry.ingest(status(3), NOW);
    await expect(handle.promise).rejects.toMatchObject({ code: "AI_REQUEST_STALE" });
    planner.close();
  });

  it("fails closed without live status/catalog and rejects older task versions", async () => {
    const empty = new BotRegistry({ staleAfterMs: 30_000, now: () => NOW });
    const { planner: emptyPlanner } = createPlanner(empty, () => response("{}"));
    expect(() => emptyPlanner.requestPlan({
      botId: "worker-01",
      task: "Anything",
      taskVersion: 1,
    })).toThrowError(expect.objectContaining({ code: "BOT_NOT_FOUND" }));
    emptyPlanner.close();

    const { planner } = createPlanner(readyRegistry(), () => response(JSON.stringify({
      action: "wait",
      reason: "Wait.",
      confidence: 1,
    })));
    await planner.requestPlan({
      botId: "worker-01",
      task: "New task",
      taskVersion: 2,
    }).promise;
    expect(() => planner.requestPlan({
      botId: "worker-01",
      task: "Old task",
      taskVersion: 1,
    })).toThrowError(CoordinatorAIPlanningError);
    planner.close();
  });
});

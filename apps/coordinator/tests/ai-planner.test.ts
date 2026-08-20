import {
  AIRouter,
  AIRequestScheduler,
  MockAIProvider,
  type AIProviderResponse,
  type AISchedulerConfig,
} from "@minecraft-studio/ai-router";
import { describe, expect, it } from "vitest";

import {
  BotRegistry,
  CoordinatorAIPlanner,
  CoordinatorAIPlanningError,
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
  };
}

function createPlanner(
  registry: BotRegistry,
  responder: ConstructorParameters<typeof MockAIProvider>[1],
) {
  const router = new AIRouter();
  router.register(new MockAIProvider("spark-mock", responder));
  const scheduler = new AIRequestScheduler(router, schedulerConfig, () => NOW.getTime());
  const planner = new CoordinatorAIPlanner({
    registry,
    scheduler,
    now: () => NOW,
    randomId: () => "11111111-1111-4111-8111-111111111111",
  });
  return { planner, scheduler };
}

describe("CoordinatorAIPlanner", () => {
  it("returns a catalog-bound proposal without creating execution authorization", async () => {
    const registry = readyRegistry();
    let providerPrompt = "";
    const { planner } = createPlanner(registry, (request) => {
      providerPrompt = request.systemPrompt ?? "";
      return response(JSON.stringify({
        action: "execute_skill",
        skill: "movement.goto",
        arguments: { x: 10, y: 64, z: 10 },
        reason: "Move to the assigned site.",
        confidence: 0.9,
      }));
    });

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

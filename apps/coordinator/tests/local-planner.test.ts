import type {
  AIScheduledResult,
  GenerateResult,
} from "@minecraft-studio/ai-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { BotRegistry } from "../src/bot-registry.js";
import {
  CoordinatorLocalPlanner,
  LocalPlannerError,
  type LocalPlanRequest,
  type SkillInvocationTransport,
} from "../src/local-planner.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-01";
let registry: BotRegistry;

describe("CoordinatorLocalPlanner", () => {
  beforeEach(() => {
    registry = readyRegistry();
  });

  it("dispatches only a catalog skill and omits exact position/server identity from the prompt", async () => {
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify({
          action: "invoke_skill",
          botId: BOT_ID,
          taskId: "task-01",
          skillId: "movement.goto",
          skillVersion: "1.0.0",
          input: {
            target: {
              x: 10,
              y: 64,
              z: 10,
              dimension: "minecraft:overworld",
              serverProfileId: "isolated-test",
            },
            radius: 2,
          },
          reasonCode: "ADVANCE_TASK",
        }),
        options.requestId,
      ),
    );
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => ({
      schemaVersion: "1.0",
      messageId: uuid(90),
      traceId: invocation.traceId,
      timestamp: NOW.toISOString(),
      source: { service: "bot-runtime", instanceId: RUNTIME_ID },
      botId: invocation.botId,
      taskId: invocation.taskId,
      type: "skill.result.v1",
      payload: {
        invocationId: invocation.payload.invocationId,
        skillId: invocation.payload.skillId,
        skillVersion: invocation.payload.skillVersion,
        completedAt: NOW.toISOString(),
        outcome: "completed",
        attempts: 1,
        output: { reached: true },
      },
    }));
    const planner = plannerWith(generate, { sendSkillInvocation });

    const result = await planner.planAndDispatch(planRequest());

    expect(result).toMatchObject({
      action: "skill_result",
      reasonCode: "ADVANCE_TASK",
      result: { payload: { outcome: "completed" } },
    });
    const options = generate.mock.calls[0]![0];
    expect(options.prompt).not.toContain('"position"');
    expect(options.prompt).not.toContain("isolated-test");
    expect(options.prompt).toContain('"health":20');
    expect(options.temperature).toBe(0);
    expect(options.schema).toBeDefined();
    expect(sendSkillInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: BOT_ID,
        taskId: "task-01",
        type: "skill.invoke.v1",
      }),
      RUNTIME_ID,
      expect.any(AbortSignal),
    );
  });

  it("rejects prose, identity changes, and skills absent from the Runtime catalog", async () => {
    const invalidOutputs = [
      "I would move forward",
      JSON.stringify({
        action: "noop",
        botId: "other-bot",
        taskId: "task-01",
        reasonCode: "NO_ACTION",
      }),
      JSON.stringify({
        action: "invoke_skill",
        botId: BOT_ID,
        taskId: "task-01",
        skillId: "combat.raw_attack",
        skillVersion: "1.0.0",
        input: {},
        reasonCode: "ATTACK",
      }),
    ];
    const expectedCodes = [
      "PLANNER_DECISION_INVALID",
      "PLANNER_DECISION_MISMATCH",
      "PLANNER_SKILL_UNAVAILABLE",
    ];

    for (const [index, content] of invalidOutputs.entries()) {
      const planner = plannerWith(async (options) =>
        aiResult(content!, options.requestId),
      );
      await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
        code: expectedCodes[index],
      });
    }
  });

  it("returns a validated noop without dispatching a skill", async () => {
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const planner = plannerWith(
      async (options) =>
        aiResult(
          JSON.stringify({
            action: "noop",
            botId: BOT_ID,
            taskId: "task-01",
            reasonCode: "NO_SAFE_SKILL",
          }),
          options.requestId,
        ),
      { sendSkillInvocation },
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "noop",
      reasonCode: "NO_SAFE_SKILL",
    });
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("fails closed before model use when L0 safety pauses normal actions", async () => {
    const current = registry.get(BOT_ID, NOW)!;
    const pausedRegistry = {
      get: () => ({
        ...current,
        currentStatus: {
          ...current.currentStatus!,
          safety: {
            ...current.currentStatus!.safety,
            normalTasksPaused: true,
          },
        },
      }),
    };
    const generate = vi.fn();
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: pausedRegistry,
      transport: { sendSkillInvocation: vi.fn() },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_SAFETY_PAUSED",
    });
    expect(generate).not.toHaveBeenCalled();
  });
});

function plannerWith(
  generate: (options: any) => Promise<AIScheduledResult<GenerateResult>>,
  transport: SkillInvocationTransport = { sendSkillInvocation: vi.fn() },
): CoordinatorLocalPlanner {
  return new CoordinatorLocalPlanner({
    ai: { generate },
    registry,
    transport,
    coordinatorInstanceId: "coordinator-01",
    now: () => NOW,
    randomId: uuidSequence(),
  });
}

function planRequest(): LocalPlanRequest {
  return {
    requestId: "plan-request-01",
    traceId: "trace-plan-01",
    taskId: "task-01",
    botId: BOT_ID,
    operatorGoal: "Move toward the approved work area.",
    timeoutMs: 30_000,
  };
}

function readyRegistry(): BotRegistry {
  const registry = new BotRegistry({ staleAfterMs: 15_000, now: () => NOW });
  const envelope = (sequence: number, type: string) => ({
    schemaVersion: "1.0",
    messageId: uuid(sequence),
    traceId: "trace-registry",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type,
  });
  registry.ingest({
    ...envelope(1, "bot.status.v1"),
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: 1,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 1234, y: 64, z: -4321, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
      safety: {
        mode: "monitoring",
        activeRisks: [],
        normalTasksPaused: false,
        lastDecisionId: null,
        lastAction: null,
      },
    },
  }, NOW);
  registry.ingest({
    ...envelope(2, "bot.skill-catalog.v1"),
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: 2,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [{
        skillId: "movement.goto",
        skillVersion: "1.0.0",
        availability: "available",
        verification: "unverified",
        selectedVariantId: "portable",
        unavailableReasons: [],
      }],
    },
  }, NOW);
  return registry;
}

function aiResult(
  content: string,
  requestId: string,
): AIScheduledResult<GenerateResult> {
  return {
    requestId,
    botId: BOT_ID,
    priority: 30,
    value: { content, usage: { promptTokens: 10, completionTokens: 10 } },
    attempts: 1,
    enqueuedAt: NOW.toISOString(),
    startedAt: NOW.toISOString(),
    completedAt: NOW.toISOString(),
    queueTimeMs: 0,
    executionTimeMs: 10,
    totalTimeMs: 10,
  };
}

function uuidSequence(): () => string {
  let value = 100;
  return () => uuid(value++);
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

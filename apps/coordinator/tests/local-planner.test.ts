import type {
  AIScheduledResult,
  GenerateResult,
} from "@minecraft-studio/ai-router";
import type {
  SkillExecutionResultV1,
  SkillJsonValue,
} from "@minecraft-studio/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotRegistry } from "../src/bot-registry.js";
import {
  CoordinatorLocalPlanner,
  LocalPlannerError,
  type LocalPlanRequest,
  type SkillInvocationTransport,
} from "../src/local-planner.js";
import {
  LOCAL_PLANNER_PROMPT_VERSION,
  LOCAL_PLANNER_SYSTEM_PROMPT,
} from "../src/planner-prompts.js";

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
              serverProfileId: "$CURRENT_SERVER_PROFILE",
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
    expect(options.prompt).toContain("$CURRENT_SERVER_PROFILE");
    expect(options.prompt).toContain('"health":20');
    expect(options.systemPrompt).toBe(LOCAL_PLANNER_SYSTEM_PROMPT);
    expect(JSON.parse(options.prompt).promptVersion).toBe(LOCAL_PLANNER_PROMPT_VERSION);
    expect(options.temperature).toBe(0);
    expect(options.schema).toBeDefined();
    const generationSchema = z.toJSONSchema(options.schema);
    const invokeSchema = generationSchema.oneOf?.find(
      (branch) => branch.properties?.action?.const === "invoke_skill",
    );
    expect(invokeSchema?.properties?.skillId).toMatchObject({
      enum: ["movement.goto"],
    });
    expect(invokeSchema?.properties?.skillVersion).toMatchObject({
      enum: ["1.0.0"],
    });
    expect(invokeSchema?.properties?.skillVersion).not.toHaveProperty("pattern");
    expect(sendSkillInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: BOT_ID,
        taskId: "task-01",
        type: "skill.invoke.v1",
        payload: expect.objectContaining({
          input: expect.objectContaining({
            target: expect.objectContaining({
              serverProfileId: "isolated-test",
            }),
          }),
        }),
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
        reasonCode: "NO_SAFE_SKILL",
      }),
      JSON.stringify({
        action: "invoke_skill",
        botId: BOT_ID,
        taskId: "task-01",
        skillId: "combat.raw_attack",
        skillVersion: "1.0.0",
        input: {},
        reasonCode: "ADVANCE_TASK",
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

  it("rejects a model-supplied ServerProfile identity", async () => {
    const planner = plannerWith(async (options) =>
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
              serverProfileId: "model-invented-profile",
            },
            radius: 2,
          },
          reasonCode: "ADVANCE_TASK",
        }),
        options.requestId,
      ),
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_DECISION_INVALID",
    });
  });

  it("rejects ungrounded coordinate inputs even when they satisfy the advertised schema", async () => {
    const planner = plannerWith(async (options) =>
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
              serverProfileId: "$CURRENT_SERVER_PROFILE",
            },
            radius: 2,
          },
          reasonCode: "ADVANCE_TASK",
        }),
        options.requestId,
      ),
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Move toward the approved work area.",
      }),
    ).rejects.toMatchObject({ code: "PLANNER_INPUT_UNGROUNDED" });
  });

  it("rejects wrong types and unknown Skill input fields before dispatch", async () => {
    const invalidInputs = [
      {
        target: {
          x: "10",
          y: 64,
          z: 10,
          dimension: "minecraft:overworld",
          serverProfileId: "$CURRENT_SERVER_PROFILE",
        },
        radius: 2,
      },
      {
        target: {
          x: 10,
          y: 64,
          z: 10,
          dimension: "minecraft:overworld",
          serverProfileId: "$CURRENT_SERVER_PROFILE",
        },
        radius: 2,
        extra: true,
      },
    ];
    for (const input of invalidInputs) {
      const planner = plannerWith(async (options) =>
        aiResult(
          JSON.stringify({
            action: "invoke_skill",
            botId: BOT_ID,
            taskId: "task-01",
            skillId: "movement.goto",
            skillVersion: "1.0.0",
            input,
            reasonCode: "ADVANCE_TASK",
          }),
          options.requestId,
        ),
      );
      await expect(
        planner.planAndDispatch({
          ...planRequest(),
          operatorGoal: "Move toward the approved work area at coordinates (10, 64, 10).",
        }),
      ).rejects.toMatchObject({ code: "PLANNER_DECISION_INVALID" });
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

  it("reobserves and safely retries a pre-execution rejection with fresh authorization", async () => {
    const planning = planningRegistry();
    const initial = planning.get(BOT_ID, NOW)!;
    expect(initial).toMatchObject({
      connectionState: "online",
      currentStatus: { safety: { normalTasksPaused: false } },
    });
    let statusSequence = initial.currentStatus!.sequence;
    const calls: string[] = [];
    let rejectedOakPlanks = false;
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      const key = invocation.payload.skillId;
      calls.push(key);
      if (
        key === "craft.item" &&
        inputField(invocation.payload.input, "itemName") === "oak_planks" &&
        !rejectedOakPlanks
      ) {
        rejectedOakPlanks = true;
        return skillResult(
          invocation,
          "rejected",
          "SKILL_PRECONDITION_FAILED",
          0,
        );
      }
      return skillResult(invocation, "completed");
    });
    const requestFreshStatus = vi.fn<
      NonNullable<SkillInvocationTransport["requestFreshStatus"]>
    >(async (_botId, _runtimeInstanceId, afterStatusSequence) => {
      expect(afterStatusSequence).toBe(statusSequence);
      statusSequence += 1;
    });
    const get = vi.fn(() => ({
      ...initial,
      currentStatus: {
        ...initial.currentStatus!,
        sequence: statusSequence,
      },
    }));
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify({
          action: "plan_items",
          botId: BOT_ID,
          taskId: "task-01",
          goals: [{ itemName: "crafting_table", count: 1 }],
          reasonCode: "ADVANCE_TASK",
        }),
        options.requestId,
      ),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get },
      transport: {
        sendSkillInvocation,
        requestFreshStatus,
      },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    const result = await planner.planAndDispatch({
      ...planRequest(),
      operatorGoal: "Craft one crafting_table from nearby resources.",
    });

    expect(result).toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(calls).toEqual([
      "collect.block",
      "craft.item",
      "craft.item",
      "craft.item",
    ]);
    expect(new Set(sendSkillInvocation.mock.calls.map(([invocation]) =>
      invocation.payload.invocationId,
    )).size).toBe(4);
    expect(new Set(sendSkillInvocation.mock.calls.map(([invocation]) =>
      invocation.payload.authorization.decisionId,
    )).size).toBe(4);
    expect(get).toHaveBeenCalledTimes(7);
    expect(requestFreshStatus).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation.mock.calls[0]![0].payload.input).toMatchObject({
      blockName: "oak_log",
      maxCount: 1,
      maxDistance: 16,
      dimension: "minecraft:overworld",
      serverProfileId: "isolated-test",
    });
    expect(sendSkillInvocation.mock.calls[1]![0].payload.input).toMatchObject({
      itemName: "oak_planks",
      count: 1,
      craftingTable: null,
      serverProfileId: "isolated-test",
    });
    const generationSchema = z.toJSONSchema(generate.mock.calls[0]![0].schema);
    expect(generationSchema.oneOf?.some(
      (branch) => branch.properties?.action?.const === "plan_items",
    )).toBe(true);
  });

  it("accepts a grounded Chinese single-item goal without exposing aliases to the model", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const planner = resourcePlanner(planning, { sendSkillInvocation });

    await expect(
      planner.planAndDispatch({
        ...resourcePlanRequest(),
        operatorGoal: "用附近的原木制作一个工作台",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(3);
  });

  it.each([
    [[{ itemName: "crafting_table", count: 32 }]],
    [[
      { itemName: "crafting_table", count: 1 },
      { itemName: "crafting_table", count: 1 },
    ]],
  ] as const)("rejects model-amplified resource goals before dispatch", async (goals) => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const planner = resourcePlanner(
      planning,
      { sendSkillInvocation },
      goals,
    );

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({ code: "PLANNER_DECISION_INVALID" });
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("does not accept a completed collect result that produced no items", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      skillResult(invocation, "completed", undefined, 1, {
        blockName: "oak_log",
        targetsFound: 0,
        itemsCollected: 0,
      }),
    );
    const planner = resourcePlanner(planning, { sendSkillInvocation });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
  });

  it("does not accept a completed craft result with partial output", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      if (
        invocation.payload.skillId === "craft.item" &&
        inputField(invocation.payload.input, "itemName") === "oak_planks"
      ) {
        return skillResult(invocation, "completed", undefined, 1, {
          itemName: "oak_planks",
          requestedCount: 1,
          craftedCount: 1,
          usedCraftingTable: false,
        });
      }
      return skillResult(invocation, "completed");
    });
    const planner = resourcePlanner(planning, { sendSkillInvocation });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["failed", "SKILL_CAPABILITY_FAILED", 1],
    ["timed_out", "SKILL_TIMEOUT", 1],
    ["cancelled", "SKILL_CANCELLED", 1],
    ["rejected", "SKILL_PRECONDITION_FAILED", 1],
  ] as const)(
    "does not replay a non-idempotent %s result after execution may have started",
    async (outcome, errorCode, attempts) => {
      const planning = planningRegistry();
      const sendSkillInvocation = vi.fn<
        SkillInvocationTransport["sendSkillInvocation"]
      >(async (invocation) => {
        if (
          invocation.payload.skillId === "craft.item" &&
          inputField(invocation.payload.input, "itemName") === "oak_planks"
        ) {
          return skillResult(invocation, outcome, errorCode, attempts);
        }
        return skillResult(invocation, "completed");
      });
      const planner = resourcePlanner(planning, { sendSkillInvocation });

      await expect(
        planner.planAndDispatch(resourcePlanRequest()),
      ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });
      expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
    },
  );

  it("fails closed when a non-idempotent transport outcome is unknown", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      if (invocation.payload.skillId === "craft.item") {
        throw new Error("injected_unknown_transport_outcome");
      }
      return skillResult(invocation, "completed");
    });
    const planner = resourcePlanner(planning, { sendSkillInvocation });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
  });

  it("does not turn a non-idempotent dispatch timeout into a fresh invocation", async () => {
    const planning = planningRegistry();
    const current = planning.get(BOT_ID, NOW)!;
    const timeoutRegistry = {
      get: () => ({
        ...current,
        skillCatalog: {
          ...current.skillCatalog!,
          skills: current.skillCatalog!.skills.map((skill) =>
            skill.skillId === "craft.item"
              ? { ...skill, timeoutMs: 10 }
              : skill,
          ),
        },
      }),
    };
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation, _runtimeInstanceId, signal) => {
      if (invocation.payload.skillId !== "craft.item") {
        return skillResult(invocation, "completed");
      }
      await new Promise<void>((_resolve, reject) => {
        const rejectAborted = () => reject(new Error("dispatch_timed_out"));
        if (signal.aborted) {
          rejectAborted();
          return;
        }
        signal.addEventListener("abort", rejectAborted, { once: true });
      });
      throw new Error("unreachable_dispatch_completion");
    });
    const planner = resourcePlanner(timeoutRegistry, { sendSkillInvocation });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
  });

  it("does not report an earlier successful step when a later target cannot be bound", async () => {
    const planning = planningRegistry();
    const initial = planning.get(BOT_ID, NOW)!;
    let statusSequence = initial.currentStatus!.sequence;
    let firstStepCompleted = false;
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      firstStepCompleted = true;
      return skillResult(invocation, "completed");
    });
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) =>
          aiResult(JSON.stringify({
            action: "plan_items",
            botId: BOT_ID,
            taskId: "task-01",
            goals: [{ itemName: "crafting_table", count: 1 }],
            reasonCode: "ADVANCE_TASK",
          }), options.requestId),
      },
      registry: {
        get: () => {
          const current = {
            ...initial,
            currentStatus: {
              ...initial.currentStatus!,
              sequence: statusSequence,
            },
          };
          return firstStepCompleted
            ? {
                ...current,
                currentStatus: {
                  ...current.currentStatus!,
                  position: null,
                },
              }
            : current;
        },
      },
      transport: {
        sendSkillInvocation,
        requestFreshStatus: async (
          _botId,
          _runtimeInstanceId,
          afterStatusSequence,
        ) => {
          expect(afterStatusSequence).toBe(statusSequence);
          statusSequence += 1;
        },
      },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one crafting_table from nearby resources.",
      }),
    ).rejects.toMatchObject({
      code: "STEP_TARGET_NOT_FOUND",
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
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
    const sendSkillInvocation = vi.fn();
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: pausedRegistry,
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_SAFETY_PAUSED",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("fails closed before model use when the bot is offline", async () => {
    const current = registry.get(BOT_ID, NOW)!;
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: {
        get: () => ({
          ...current,
          connectionState: "offline" as const,
        }),
      },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_BOT_UNAVAILABLE",
    });
    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("fails closed before model use when the advertised catalog exceeds the prompt limit", async () => {
    const current = registry.get(BOT_ID, NOW)!;
    const baseSkill = current.skillCatalog!.skills[0]!;
    const oversizedSchema = {
      type: "object",
      properties: {
        note: {
          type: "string",
          enum: Array.from({ length: 8_000 }, (_, index) => `catalog-value-${index}`),
        },
      },
      required: ["note"],
      additionalProperties: false,
    };
    const oversizedRecord = {
      ...current,
      skillCatalog: {
        ...current.skillCatalog!,
        skills: Array.from({ length: 16 }, (_, index) => ({
          ...baseSkill,
          skillId: `movement.goto-${index}`,
          inputSchema: oversizedSchema,
        })),
      },
    };
    const generate = vi.fn();
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => oversizedRecord },
      transport: { sendSkillInvocation: vi.fn() },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_SKILL_CATALOG_UNAVAILABLE",
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

function resourcePlanner(
  planning: Pick<BotRegistry, "get">,
  transport: SkillInvocationTransport,
  goals: readonly Readonly<{ itemName: string; count: number }>[] = [
    { itemName: "crafting_table", count: 1 },
  ],
): CoordinatorLocalPlanner {
  return new CoordinatorLocalPlanner({
    ai: {
      generate: async (options) =>
        aiResult(
          JSON.stringify({
            action: "plan_items",
            botId: BOT_ID,
            taskId: "task-01",
            goals,
            reasonCode: "ADVANCE_TASK",
          }),
          options.requestId,
        ),
    },
    registry: { get: () => planning.get(BOT_ID, NOW) },
    transport,
    coordinatorInstanceId: "coordinator-01",
    now: () => NOW,
    randomId: uuidSequence(),
  });
}

function resourcePlanRequest(): LocalPlanRequest {
  return {
    ...planRequest(),
    operatorGoal: "Craft one crafting_table from nearby resources.",
  };
}

function planRequest(): LocalPlanRequest {
  return {
    requestId: "plan-request-01",
    traceId: "trace-plan-01",
    taskId: "task-01",
    botId: BOT_ID,
      operatorGoal: "Move toward the approved work area at coordinates (10, 64, 10).",
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
        inputSchema: {
          type: "object",
          properties: {
            target: {
              type: "object",
              properties: {
                x: { type: "integer" },
                y: { type: "integer" },
                z: { type: "integer" },
                dimension: { type: "string" },
                serverProfileId: { type: "string" },
              },
              required: ["x", "y", "z", "dimension", "serverProfileId"],
              additionalProperties: false,
            },
            radius: { type: "integer", minimum: 1, maximum: 4 },
          },
          required: ["target", "radius"],
          additionalProperties: false,
        },
        timeoutMs: 20_000,
        idempotent: false,
        selectedVariantId: "portable",
        unavailableReasons: [],
      }],
    },
  }, NOW);
  return registry;
}

function planningRegistry(): BotRegistry {
  const planning = readyRegistry();
  const now = NOW.toISOString();
  planning.ingest({
    schemaVersion: "1.0",
    messageId: uuid(3),
    traceId: "trace-registry",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: 3,
      observedAt: now,
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [
        catalogEntry("collect.block", {
          type: "object",
          properties: {
            blockName: { type: "string" },
            maxCount: { type: "integer", minimum: 1, maximum: 32 },
            maxDistance: { type: "integer", minimum: 2, maximum: 32 },
            dimension: { type: "string" },
            serverProfileId: { type: "string" },
          },
          required: ["blockName", "maxCount", "maxDistance", "dimension", "serverProfileId"],
          additionalProperties: false,
        }),
        catalogEntry("craft.item", {
          type: "object",
          properties: {
            itemName: { type: "string" },
            count: { type: "integer", minimum: 1, maximum: 64 },
            craftingTable: {
              anyOf: [
                { type: "null" },
                {
                  type: "object",
                  properties: {
                    x: { type: "integer" },
                    y: { type: "integer" },
                    z: { type: "integer" },
                  },
                  required: ["x", "y", "z"],
                  additionalProperties: false,
                },
              ],
            },
            dimension: { type: "string" },
            serverProfileId: { type: "string" },
          },
          required: ["itemName", "count", "craftingTable", "dimension", "serverProfileId"],
          additionalProperties: false,
        }),
      ],
    },
  }, NOW);
  return planning;
}

function catalogEntry(skillId: string, inputSchema: Record<string, unknown>) {
  return {
    skillId,
    skillVersion: "1.0.0",
    availability: "available" as const,
    verification: "unverified" as const,
    inputSchema,
    timeoutMs: 20_000,
    idempotent: false,
    selectedVariantId: "portable",
    unavailableReasons: [],
  };
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

function skillResult(
  invocation: {
    traceId: string;
    botId: string;
    taskId: string;
    payload: {
      invocationId: string;
      skillId: string;
      skillVersion: string;
      input?: SkillJsonValue;
    };
  },
  outcome: SkillExecutionResultV1["payload"]["outcome"],
  errorCode = "SKILL_HANDLER_FAILED",
  attempts = outcome === "rejected" ? 0 : 1,
  completedOutput = completedOutputForInvocation(invocation),
): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0" as const,
    messageId: uuid(
      500 +
        ["completed", "rejected", "failed", "cancelled", "timed_out"].indexOf(
          outcome,
        ),
    ),
    traceId: invocation.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime" as const, instanceId: RUNTIME_ID },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1" as const,
    payload:
      outcome === "completed"
        ? {
            invocationId: invocation.payload.invocationId,
            skillId: invocation.payload.skillId,
            skillVersion: invocation.payload.skillVersion,
            completedAt: NOW.toISOString(),
            outcome: "completed" as const,
            attempts,
            output: completedOutput,
          }
        : {
            invocationId: invocation.payload.invocationId,
            skillId: invocation.payload.skillId,
            skillVersion: invocation.payload.skillVersion,
            completedAt: NOW.toISOString(),
            outcome,
            attempts,
            errorCode,
          },
  };
}

function completedOutputForInvocation(
  invocation: Parameters<typeof skillResult>[0],
): SkillJsonValue {
  if (invocation.payload.skillId === "collect.block") {
    const blockName = inputField(invocation.payload.input, "blockName");
    const maxCount = Number(inputField(invocation.payload.input, "maxCount"));
    return {
      blockName: String(blockName),
      targetsFound: maxCount,
      itemsCollected: maxCount,
    };
  }
  if (invocation.payload.skillId === "craft.item") {
    const itemName = String(inputField(invocation.payload.input, "itemName"));
    const requestedCount = Number(inputField(invocation.payload.input, "count"));
    return {
      itemName,
      requestedCount,
      craftedCount:
        itemName === "oak_planks" ? requestedCount * 4 : requestedCount,
      usedCraftingTable:
        inputField(invocation.payload.input, "craftingTable") !== null,
    };
  }
  return {};
}

function inputField(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  return (input as Record<string, unknown>)[key];
}

function uuidSequence(): () => string {
  let value = 100;
  return () => uuid(value++);
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

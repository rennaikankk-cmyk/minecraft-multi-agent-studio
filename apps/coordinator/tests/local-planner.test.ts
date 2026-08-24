import type {
  AIScheduledResult,
  GenerateResult,
} from "@minecraft-studio/ai-router";
import type {
  SkillExecutionResultV1,
  SkillJsonValue,
} from "@minecraft-studio/protocol";
import { vanillaResourceRecipes } from "@minecraft-studio/skills";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotAssignmentService } from "../src/bot-assignment.js";
import { BotRegistry } from "../src/bot-registry.js";
import {
  buildLocalPlannerGenerationSchema,
  buildLocalPlannerPlanItemsRetrySchema,
  CoordinatorLocalPlanner,
  type CoordinatorLocalPlannerOptions,
  localPlannerDecisionSchema,
  LocalPlannerError,
  type LocalPlanRequest,
  plannedAcquisitionGoalItem,
  plannedItemGoalAliasCoverage,
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
    const invokeSchema = generationSchema.anyOf?.find(
      (branch) => branch.properties?.action?.const === "invoke_skill",
    );
    expect(invokeSchema?.properties?.skillId).toMatchObject({
      const: "movement.goto",
    });
    expect(invokeSchema?.properties?.skillVersion).toMatchObject({
      const: "1.0.0",
    });
    expect(invokeSchema?.properties?.skillVersion).not.toHaveProperty("pattern");
    expect(invokeSchema?.properties?.input).toMatchObject({
      type: "object",
      properties: { radius: { type: "integer" } },
    });
    expect(invokeSchema?.properties?.input).not.toHaveProperty("$ref");
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

  it("recovers a decision the model wrapped in a markdown fence", async () => {
    const planner = plannerWith(async (options) =>
      aiResult(
        [
          "```json",
          JSON.stringify({
            action: "noop",
            botId: BOT_ID,
            taskId: "task-01",
            reasonCode: "NO_SAFE_SKILL",
          }),
          "```",
        ].join("\n"),
        options.requestId,
      ),
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "noop",
      reasonCode: "NO_SAFE_SKILL",
    });
  });

  it("re-asks a declined single-item acquisition goal with only the plan_items branch", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify(
          options.requestId.endsWith(":plan-items-retry")
            ? {
                action: "plan_items",
                botId: BOT_ID,
                taskId: "task-01",
                goals: [{ itemName: "crafting_table", count: 1 }],
                reasonCode: "ADVANCE_TASK",
              }
            : {
                action: "noop",
                botId: BOT_ID,
                taskId: "task-01",
                reasonCode: "NO_SAFE_SKILL",
              },
        ),
        options.requestId,
      ),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).resolves.toMatchObject({
      action: "skill_result",
      reasonCode: "ADVANCE_TASK",
      result: { payload: { outcome: "completed" } },
    });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sendSkillInvocation).toHaveBeenCalledTimes(3);
    const retryOptions = generate.mock.calls[1]![0];
    // The retry offers one branch and advertises no skills, so the model cannot
    // restate the noop it just gave; the item is the Coordinator's, not the model's.
    expect(retryOptions.requestId).toBe("plan-request-01:plan-items-retry");
    const retrySchema = z.toJSONSchema(retryOptions.schema);
    expect(retrySchema).not.toHaveProperty("anyOf");
    expect(retrySchema.properties?.action).toMatchObject({ const: "plan_items" });
    expect(JSON.parse(retryOptions.prompt).availableSkills).toEqual([]);
  });

  it("records the narrowed re-ask and the step ladder without leaking the goal or inputs", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    const warn = vi.fn();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify(
          options.requestId.endsWith(":plan-items-retry")
            ? {
                action: "plan_items",
                botId: BOT_ID,
                taskId: "task-01",
                goals: [{ itemName: "crafting_table", count: 1 }],
                reasonCode: "ADVANCE_TASK",
              }
            : {
                action: "noop",
                botId: BOT_ID,
                taskId: "task-01",
                reasonCode: "NO_SAFE_SKILL",
              },
        ),
        options.requestId,
      ),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn, error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).resolves.toMatchObject({ action: "skill_result" });

    expect(info).toHaveBeenCalledWith("coordinator_planner_plan_items_retry", {
      traceId: "trace-plan-01",
      taskId: "task-01",
      botId: BOT_ID,
      itemName: "crafting_table",
      disposition: "accepted",
      retriedAction: "plan_items",
    });
    const supervision = info.mock.calls.find(
      ([event]) => event === "coordinator_planner_goal_supervision",
    );
    expect(supervision?.[1]).toMatchObject({
      taskId: "task-01",
      plannedSteps: 3,
      stepsCompleted: 3,
      failureCode: null,
    });
    // Diagnostics must not become a second, wider disclosure channel than the
    // prompt: the operator goal, Skill inputs, and coordinates stay out.
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("nearby resources");
    expect(logged).not.toContain("isolated-test");
    expect(warn).not.toHaveBeenCalled();
  });

  it("records a discarded re-ask so a retried noop is not mistaken for a first-pass one", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify(
          options.requestId.endsWith(":plan-items-retry")
            ? {
                action: "plan_items",
                botId: "other-bot",
                taskId: "task-01",
                goals: [{ itemName: "crafting_table", count: 1 }],
                reasonCode: "ADVANCE_TASK",
              }
            : {
                action: "noop",
                botId: BOT_ID,
                taskId: "task-01",
                reasonCode: "NO_SAFE_SKILL",
              },
        ),
        options.requestId,
      ),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation: vi.fn() },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).resolves.toMatchObject({ action: "noop" });
    expect(info).toHaveBeenCalledWith("coordinator_planner_plan_items_retry", {
      traceId: "trace-plan-01",
      taskId: "task-01",
      botId: BOT_ID,
      itemName: "crafting_table",
      disposition: "discarded",
      retriedAction: "plan_items",
    });
  });

  it("carries the failing step index and skill on a goal execution failure", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "craft.item" &&
      inputField(invocation.payload.input, "itemName") === "oak_planks"
        ? skillResult(invocation, "failed", "SKILL_CAPABILITY_FAILED", 1)
        : skillResult(invocation, "completed"),
    );
    const planner = resourcePlanner(planning, { sendSkillInvocation });

    // The step index and skill are what triage needs first; the client still
    // only ever sees the coarse code.
    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({
      code: "PLANNER_GOAL_EXECUTION_FAILED",
      // The index is the position in the repaired ladder, not the original
      // plan: the first failure inserted a repair step ahead of this one.
      stepIndex: 2,
      stepSkillId: "craft.item",
    });
  });

  it("still names the failing step when no skill result identifies it", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "collect.block"
        ? skillResult(invocation, "completed", undefined, 1, {
            blockName: "oak_log",
            targetsFound: 0,
            itemsCollected: 0,
          })
        : skillResult(invocation, "completed"),
    );
    const planner = resourcePlanner(planning, { sendSkillInvocation });

    // An empty collect completes, so no result is at fault; the supervisor
    // fails the step that then had nothing to consume. Reporting a skill here
    // would be an invention, so only the index is attached.
    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({
      code: "PLANNER_GOAL_EXECUTION_FAILED",
      stepIndex: 1,
      stepSkillId: undefined,
    });
  });

  it("leaves an honest noop standing when the goal asks for no acquisition", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify({
          action: "noop",
          botId: BOT_ID,
          taskId: "task-01",
          reasonCode: "NO_SAFE_SKILL",
        }),
        options.requestId,
      ),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Equip the best armor already in inventory.",
      }),
    ).resolves.toMatchObject({ action: "noop", reasonCode: "NO_SAFE_SKILL" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("keeps a retried decision under the same grounding and identity checks", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify(
          options.requestId.endsWith(":plan-items-retry")
            ? {
                action: "plan_items",
                botId: "other-bot",
                taskId: "task-01",
                goals: [{ itemName: "crafting_table", count: 1 }],
                reasonCode: "ADVANCE_TASK",
              }
            : {
                action: "noop",
                botId: BOT_ID,
                taskId: "task-01",
                reasonCode: "NO_SAFE_SKILL",
              },
        ),
        options.requestId,
      ),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    // A retry that changes identity is discarded, not dispatched, and the
    // original noop is what the caller sees.
    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).resolves.toMatchObject({ action: "noop", reasonCode: "NO_SAFE_SKILL" });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("holds a deterministic Bot assignment lease only for the execution window", async () => {
    const assignment = new BotAssignmentService({ registry, now: () => NOW });
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      expect(assignment.list(NOW)).toHaveLength(1);
      return skillResult(invocation, "completed");
    });
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) =>
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
      },
      registry,
      assignment,
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(assignment.list(NOW)).toHaveLength(0);
  });

  it("reuses the persisted goal lease instead of acquiring a second memory lease", async () => {
    const acquire = vi.fn<BotAssignmentService["acquire"]>();
    const release = vi.fn<BotAssignmentService["release"]>();
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
      { sendSkillInvocation: vi.fn() },
      { acquire, release },
      async () => true,
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        assignmentLeaseOwner: "goal-persistent-lease",
      }),
    ).resolves.toMatchObject({
      action: "noop",
      reasonCode: "NO_SAFE_SKILL",
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("rejects a free-form lease owner when no durable verifier is configured", async () => {
    const acquire = vi.fn<BotAssignmentService["acquire"]>();
    const release = vi.fn<BotAssignmentService["release"]>();
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
      { sendSkillInvocation: vi.fn() },
      { acquire, release },
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        assignmentLeaseOwner: "forged-lease-owner",
      }),
    ).rejects.toMatchObject({ code: "PLANNER_BOT_UNAVAILABLE" });
    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("requires the durable verifier to approve the exact task, Bot, and owner", async () => {
    const verifyAssignmentLease = vi.fn<
      NonNullable<CoordinatorLocalPlannerOptions["verifyAssignmentLease"]>
    >(async (input) =>
      input.taskId === "task-01" &&
      input.botId === BOT_ID &&
      input.leaseOwner === "goal-persistent-lease",
    );
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) =>
          aiResult(
            JSON.stringify({
              action: "noop",
              botId: BOT_ID,
              taskId: "task-01",
              reasonCode: "NO_SAFE_SKILL",
            }),
            options.requestId,
          ),
      },
      registry,
      transport: { sendSkillInvocation: vi.fn() },
      coordinatorInstanceId: "coordinator-01",
      verifyAssignmentLease,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        assignmentLeaseOwner: "goal-persistent-lease",
      }),
    ).resolves.toMatchObject({ action: "noop" });
    expect(verifyAssignmentLease).toHaveBeenCalledWith({
      taskId: "task-01",
      botId: BOT_ID,
      leaseOwner: "goal-persistent-lease",
    });
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
    expect(generationSchema.anyOf?.some(
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

describe("buildLocalPlannerGenerationSchema", () => {
  const skills = [{ skillId: "movement.goto", skillVersion: "1.0.0" }];

  it("pins botId and taskId to the trusted values on every branch", () => {
    const schema = buildLocalPlannerGenerationSchema(skills, ["oak_log"], {
      botId: BOT_ID,
      taskId: "task-01",
    });
    const noop = {
      action: "noop",
      botId: BOT_ID,
      taskId: "task-01",
      reasonCode: "NO_SAFE_SKILL",
    };
    expect(schema.safeParse(noop).success).toBe(true);
    expect(
      schema.safeParse({ ...noop, botId: "other-worker" }).success,
    ).toBe(false);
    expect(schema.safeParse({ ...noop, taskId: "task-02" }).success).toBe(false);
  });

  it("leaves identity free when no trusted identity is supplied", () => {
    const schema = buildLocalPlannerGenerationSchema(skills, ["oak_log"]);
    expect(
      schema.safeParse({
        action: "noop",
        botId: "any-worker",
        taskId: "any-task",
        reasonCode: "NO_SAFE_SKILL",
      }).success,
    ).toBe(true);
  });

  it("constrains every invoke branch to one skill's advertised input", () => {
    const catalog = [
      {
        skillId: "movement.goto",
        skillVersion: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            radius: { type: "integer", minimum: 1, maximum: 4 },
            serverProfileId: { type: "string" },
          },
          required: ["radius", "serverProfileId"],
          additionalProperties: false,
        },
      },
      {
        skillId: "collect.block",
        skillVersion: "1.0.0",
        inputSchema: {
          type: "object",
          properties: {
            blockName: { type: "string" },
            serverProfileId: { type: "string" },
          },
          required: ["blockName", "serverProfileId"],
          additionalProperties: false,
        },
      },
    ];
    const jsonSchema = z.toJSONSchema(
      buildLocalPlannerGenerationSchema(catalog, ["oak_log"], {
        botId: BOT_ID,
        taskId: "task-01",
      }),
    );
    const invokeBranches = (jsonSchema.anyOf ?? []).filter(
      (branch) => branch.properties?.action?.const === "invoke_skill",
    );
    expect(invokeBranches).toHaveLength(2);
    expect(
      invokeBranches.map((branch) => branch.properties?.skillId?.const),
    ).toEqual(["movement.goto", "collect.block"]);
    // An unconstrained input leaf is the whole defect: it is the only region a
    // grammar-constrained model can wander in, so it must never come back.
    for (const branch of invokeBranches) {
      expect(branch.properties?.input).not.toHaveProperty("$ref");
      expect(branch.properties?.input).toMatchObject({ type: "object" });
    }
    expect(
      invokeBranches[0]!.properties?.input?.properties,
    ).toHaveProperty("radius");
    expect(
      invokeBranches[1]!.properties?.input?.properties,
    ).toHaveProperty("blockName");
  });

  it("rejects an input that belongs to a different catalog skill", () => {
    const schema = buildLocalPlannerGenerationSchema(
      [
        {
          skillId: "movement.goto",
          skillVersion: "1.0.0",
          inputSchema: {
            type: "object",
            properties: { radius: { type: "integer" } },
            required: ["radius"],
            additionalProperties: false,
          },
        },
        {
          skillId: "collect.block",
          skillVersion: "1.0.0",
          inputSchema: {
            type: "object",
            properties: { blockName: { type: "string" } },
            required: ["blockName"],
            additionalProperties: false,
          },
        },
      ],
      ["oak_log"],
      { botId: BOT_ID, taskId: "task-01" },
    );
    const decision = {
      action: "invoke_skill",
      botId: BOT_ID,
      taskId: "task-01",
      skillVersion: "1.0.0",
      reasonCode: "ADVANCE_TASK",
    };
    expect(
      schema.safeParse({
        ...decision,
        skillId: "movement.goto",
        input: { radius: 2 },
      }).success,
    ).toBe(true);
    expect(
      schema.safeParse({
        ...decision,
        skillId: "movement.goto",
        input: { blockName: "oak_log" },
      }).success,
    ).toBe(false);
  });

  it("falls back to a shared branch when no advertised schema compiles", () => {
    const schema = buildLocalPlannerGenerationSchema(skills, ["oak_log"], {
      botId: BOT_ID,
      taskId: "task-01",
    });
    expect(
      schema.safeParse({
        action: "invoke_skill",
        botId: BOT_ID,
        taskId: "task-01",
        skillId: "movement.goto",
        skillVersion: "1.0.0",
        input: { radius: 2 },
        reasonCode: "ADVANCE_TASK",
      }).success,
    ).toBe(true);
  });

  it("keeps the pin out of the shared protocol schema", () => {
    buildLocalPlannerGenerationSchema(skills, ["oak_log"], {
      botId: BOT_ID,
      taskId: "task-01",
    });
    expect(
      localPlannerDecisionSchema.safeParse({
        action: "noop",
        botId: "unrelated-worker",
        taskId: "unrelated-task",
        reasonCode: "NO_SAFE_SKILL",
      }).success,
    ).toBe(true);
  });
});

describe("plannedAcquisitionGoalItem", () => {
  const reachable = ["crafting_table", "oak_log", "stick"];

  it("names the single item an acquisition goal asks for", () => {
    expect(
      plannedAcquisitionGoalItem("Craft one crafting_table from nearby resources.", reachable),
    ).toBe("crafting_table");
    // The spaced spelling and the Chinese verb both reach the same item, because
    // the guard shares one spelling rule with the pre-dispatch grounding check.
    expect(
      plannedAcquisitionGoalItem("Gather a crafting table please.", reachable),
    ).toBe("crafting_table");
    expect(plannedAcquisitionGoalItem("采集 oak_log", reachable)).toBe("oak_log");
  });

  it("declines a goal with no acquisition verb, so an honest noop still stands", () => {
    // "equip the best armor" mentions no planned item and asks for no acquisition;
    // overturning a noop here would invent operator intent.
    expect(
      plannedAcquisitionGoalItem("Equip the best armor already in inventory.", reachable),
    ).toBeNull();
    expect(
      plannedAcquisitionGoalItem("Move to coordinates (10, 64, -7).", reachable),
    ).toBeNull();
  });

  it("declines an ambiguous multi-item goal because plan_items carries exactly one", () => {
    expect(
      plannedAcquisitionGoalItem("Craft a crafting_table and a stick.", reachable),
    ).toBeNull();
  });

  it("declines an item outside the trusted reachable set", () => {
    expect(plannedAcquisitionGoalItem("Craft one beacon.", reachable)).toBeNull();
  });

  it("recognizes Chinese goals for every item the resource graph can reach", () => {
    // 别名表此前只覆盖四个物品，于是"做一个熔炉"这种规划器完全推得出的目标
    // 会被判成"没提到可达物品"而降级成 noop。缺的是这张表，不是规划能力。
    const graphItems = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    for (const itemName of graphItems) {
      expect(
        plannedItemGoalAliasCoverage,
        `${itemName} is reachable but has no goal alias`,
      ).toContain(itemName);
    }
  });

  it("never lists an alias for an item the planner cannot actually reach", () => {
    // 反向那半同样要成立：认得出一个规划器推不出来的名字，只会把目标带到
    // 一次注定失败的派发上，而不是当场如实拒绝。
    const graphItems = new Set(
      vanillaResourceRecipes.map((recipe) => recipe.itemName),
    );
    for (const itemName of plannedItemGoalAliasCoverage) {
      expect(graphItems.has(itemName), `${itemName} has an alias but is unreachable`).toBe(
        true,
      );
    }
  });

  it("resolves a Chinese goal for a newly covered item end to end", () => {
    const reachableGraph = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    expect(plannedAcquisitionGoalItem("做一个熔炉", reachableGraph)).toBe("furnace");
    expect(plannedAcquisitionGoalItem("采集一些圆石", reachableGraph)).toBe(
      "cobblestone",
    );
    expect(plannedAcquisitionGoalItem("合成一把石镐", reachableGraph)).toBe(
      "stone_pickaxe",
    );
    // 可达集合仍然是闸门：别名认得出"钻石剑"，但调用方没把它列为可达时照样拒绝。
    expect(plannedAcquisitionGoalItem("合成一把钻石剑", ["furnace"])).toBeNull();
  });

  it("resolves a tiered item whose name contains a shorter reachable name", () => {
    // "钻石镐"里含着"钻石"，"diamond chestplate"里含着"diamond"，两者都可达。
    // 唯一命中规则会把这句毫不含糊的目标算成两次命中而降级 noop——含糊的不是
    // 操作者，是把包含关系当成了两个独立请求。
    const reachableGraph = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    expect(plannedAcquisitionGoalItem("合成一把钻石镐", reachableGraph)).toBe(
      "diamond_pickaxe",
    );
    expect(
      plannedAcquisitionGoalItem("Craft a diamond chestplate.", reachableGraph),
    ).toBe("diamond_chestplate");
  });

  it("still declines when the shorter name is also asked for on its own", () => {
    // 这一半必须保住："钻石"出现在"钻石镐"覆盖不到的位置，说明操作者真的提了
    // 两样东西，而 plan_items 只带一个目标，替他挑一个就是发明意图。
    const reachableGraph = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    expect(
      plannedAcquisitionGoalItem("挖点钻石，再合成一把钻石镐", reachableGraph),
    ).toBeNull();
    expect(
      plannedAcquisitionGoalItem(
        "Gather diamond, then craft a diamond sword.",
        reachableGraph,
      ),
    ).toBeNull();
  });
});

describe("buildLocalPlannerPlanItemsRetrySchema", () => {
  it("offers exactly one plan_items branch pinned to the trusted item and identity", () => {
    const schema = buildLocalPlannerPlanItemsRetrySchema("crafting_table", {
      botId: BOT_ID,
      taskId: "task-01",
    });
    expect(
      schema.safeParse({
        action: "plan_items",
        botId: BOT_ID,
        taskId: "task-01",
        goals: [{ itemName: "crafting_table", count: 1 }],
        reasonCode: "ADVANCE_TASK",
      }).success,
    ).toBe(true);
    // A different item, a different identity, and noop are all off-grammar, which
    // is precisely why the retry cannot restate the decision it just declined.
    for (const invalid of [
      { itemName: "oak_log", count: 1 },
      { itemName: "crafting_table", count: 2 },
    ]) {
      expect(
        schema.safeParse({
          action: "plan_items",
          botId: BOT_ID,
          taskId: "task-01",
          goals: [invalid],
          reasonCode: "ADVANCE_TASK",
        }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({
        action: "noop",
        botId: BOT_ID,
        taskId: "task-01",
        reasonCode: "NO_SAFE_SKILL",
      }).success,
    ).toBe(false);
    expect(
      schema.safeParse({
        action: "plan_items",
        botId: "other-bot",
        taskId: "task-01",
        goals: [{ itemName: "crafting_table", count: 1 }],
        reasonCode: "ADVANCE_TASK",
      }).success,
    ).toBe(false);
  });

  it("refuses an item outside the trusted planning vocabulary", () => {
    expect(() => buildLocalPlannerPlanItemsRetrySchema("minecraft:crafting_table")).toThrow(
      LocalPlannerError,
    );
  });
});

function plannerWith(
  generate: (options: any) => Promise<AIScheduledResult<GenerateResult>>,
  transport: SkillInvocationTransport = { sendSkillInvocation: vi.fn() },
  assignment?: Pick<BotAssignmentService, "acquire" | "release">,
  verifyAssignmentLease?: CoordinatorLocalPlannerOptions["verifyAssignmentLease"],
): CoordinatorLocalPlanner {
  return new CoordinatorLocalPlanner({
    ai: { generate },
    registry,
    ...(assignment ? { assignment } : {}),
    ...(verifyAssignmentLease ? { verifyAssignmentLease } : {}),
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

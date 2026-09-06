import type {
  AIScheduledResult,
  GenerateResult,
} from "@minecraft-studio/ai-router";
import {
  InMemoryMetricRegistry,
  type MetricRecorder,
} from "@minecraft-studio/observability";
import type {
  SkillExecutionResultV1,
  SkillJsonValue,
} from "@minecraft-studio/protocol";
import {
  PersistentTaskStateMachine,
  type TaskExecutionRecord,
  type TaskExecutionStore,
} from "@minecraft-studio/task-system";
import { vanillaResourceRecipes, buildBlueprintInputSchema, farmMaintainInputSchema, exploreInputSchema } from "@minecraft-studio/skills";
import { ExplorationJournal } from "../src/exploration-journal.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { BotAssignmentService } from "../src/bot-assignment.js";
import { BotRegistry } from "../src/bot-registry.js";
import {
  buildLocalPlannerGenerationSchema,
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

  it("injects scoped exploration history and records the validated runtime receipt", async () => {
    const current = registry.get(BOT_ID, NOW)!;
    const record = { ...current, skillCatalog: { ...current.skillCatalog!, skills: [
      { ...current.skillCatalog!.skills[0]!, skillId: "world.explore", idempotent: true,
        inputSchema: z.toJSONSchema(exploreInputSchema) as Record<string, unknown> },
    ] } };
    const journal = new ExplorationJournal(null, () => NOW.getTime());
    const input = exploreInputSchema.parse({ serverProfileId: record.serverProfileId, dimension: "minecraft:overworld", center: { x: 0, z: 0 }, radiusChunks: 1 });
    await journal.recordReceipt(input, { completed: false, status: "BATCH_LIMIT", visited: [{ x: 0, z: 0 }], newlyObserved: 1, observedAt: new Date(NOW.getTime() - 1000).toISOString() });
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(async (invocation) =>
      skillResult(invocation, "completed", undefined, 1, { completed: false, status: "BATCH_LIMIT", visited: [{ x: 1, z: 0 }], newlyObserved: 1, observedAt: NOW.toISOString() }));
    const planner = new CoordinatorLocalPlanner({ registry: { get: () => record }, transport: { sendSkillInvocation }, explorationJournal: journal,
      coordinatorInstanceId: "coordinator-01", now: () => NOW, randomId: uuidSequence() });
    await planner.planAndDispatch({ ...planRequest(), operatorGoal: "探索区块 x=0 z=0 radius=1" });
    expect(sendSkillInvocation).toHaveBeenCalledOnce();
    expect(sendSkillInvocation.mock.calls[0]![0].payload.input).toMatchObject({ serverProfileId: record.serverProfileId, visited: [{ x: 0, z: 0 }] });
    expect(journal.has(record.serverProfileId, "minecraft:overworld", 1, 0)).toBe(true);
    expect(journal.has("other-server", "minecraft:overworld", 1, 0)).toBe(false);
  });

  it("dispatches a bounded farm goal with the current server identity and no model", async () => {
    const current = registry.get(BOT_ID, NOW)!;
    const record = { ...current, skillCatalog: { ...current.skillCatalog!, skills: [
      { ...current.skillCatalog!.skills[0]!, skillId: "farm.maintain", idempotent: false,
        inputSchema: z.toJSONSchema(farmMaintainInputSchema) as Record<string, unknown> },
    ] } };
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(async (invocation) =>
      skillResult(invocation, "completed", undefined, 1, { status: "WAITING_GROWTH", scannedCells: 98, unknownCells: 0,
        harvested: 0, planted: 0, tilled: 0, bonemealUsed: 0, inventoryDelta: [], observedAt: NOW.toISOString() }));
    const planner = new CoordinatorLocalPlanner({ registry: { get: () => record }, transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01", now: () => NOW, randomId: uuidSequence() });
    await planner.planAndDispatch({ ...planRequest(),
      operatorGoal: "维护农场 carrots min x=1233 y=63 z=-4324 max x=1239 y=64 z=-4318" });
    expect(sendSkillInvocation).toHaveBeenCalledOnce();
    expect(sendSkillInvocation.mock.calls[0]![0].payload).toMatchObject({ skillId: "farm.maintain", input: {
      area: { serverProfileId: "isolated-test", dimension: "minecraft:overworld",
        min: { x: 1233, y: 63, z: -4324 }, max: { x: 1239, y: 64, z: -4318 } },
      crops: ["carrots"], prepareSoil: true, replant: true, seedReserve: 1,
    } });
  });

  it.each([false, true])("gates the blueprint selector on the actual dispatch chain (%s)", async (blueprintWorksetEnabled) => {
    const current = registry.get(BOT_ID, NOW)!;
    const record = { ...current, skillCatalog: { ...current.skillCatalog!, skills: [
      { ...current.skillCatalog!.skills[0]!, skillId: "build.blueprint", idempotent: false,
        inputSchema: z.toJSONSchema(buildBlueprintInputSchema) as Record<string, unknown> },
    ] } };
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(async (invocation) =>
      skillResult(invocation, "completed", undefined, 1, { completed: false, startIndex: 0, nextIndex: 0,
        totalCells: 2, estimatedDurationMs: 0, placements: [] }));
    const planner = new CoordinatorLocalPlanner({ registry: { get: () => record }, transport: { sendSkillInvocation },
      blueprintWorksetEnabled, coordinatorInstanceId: "coordinator-01", now: () => NOW, randomId: uuidSequence() });
    await planner.planAndDispatch({ ...planRequest(),
      operatorGoal: "施工蓝图行：锚点 x=1236 y=64 z=-4321，沿 +x 放置 2 个 stone，每批最多 2 格" });
    expect(sendSkillInvocation).toHaveBeenCalledOnce();
    expect(sendSkillInvocation.mock.calls[0]![0].payload.input).toMatchObject({ strategy: blueprintWorksetEnabled ? "workset" : "linear" });
  });

  it("observes an experimental named blueprint before issuing speculative full-batch material goals", async () => {
    const current = registry.get(BOT_ID, NOW)!;
    const record = { ...current, skillCatalog: { ...current.skillCatalog!, skills: [
      { ...current.skillCatalog!.skills[0]!, skillId: "build.blueprint", idempotent: false,
        inputSchema: z.toJSONSchema(buildBlueprintInputSchema) as Record<string, unknown> },
    ] } };
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(async (invocation) =>
      skillResult(invocation, "completed", undefined, 1, { completed: false, placements: [] }));
    const planner = new CoordinatorLocalPlanner({ registry: { get: () => record }, transport: { sendSkillInvocation },
      blueprintWorksetEnabled: true, coordinatorInstanceId: "coordinator-01", now: () => NOW, randomId: uuidSequence() });
    await planner.planAndDispatch({ ...planRequest(), operatorGoal: "使用蓝图文件 starter-base-v1 施工" });
    expect(sendSkillInvocation).toHaveBeenCalledOnce();
    expect(sendSkillInvocation.mock.calls[0]![0].payload.skillId).toBe("build.blueprint");
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
    expect(JSON.parse(options.prompt).bot.inventory).toEqual([]);
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
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "SUCCESS",
      currentStep: null,
      expectedResult: {
        outcome: "completed",
        skillId: "movement.goto",
        skillVersion: "1.0.0",
      },
      actualResult: {
        outcome: "completed",
        skillId: "movement.goto",
        skillVersion: "1.0.0",
        attempts: 1,
        output: { reached: true },
      },
      recoveryCount: 0,
      revision: 4,
    });
  });

  it("records returned AI usage and counts useful responses only after task success", async () => {
    let currentTime = NOW;
    const metrics = new InMemoryMetricRegistry();
    const taskStateMachine = new PersistentTaskStateMachine({
      now: () => currentTime,
    });
    const planner = plannerWith(
      async (options) => {
        currentTime = new Date(NOW.getTime() + 350);
        const result = movementDecision(options.requestId);
        return {
          ...result,
          value: {
            ...result.value,
            usage: { promptTokens: 23, completionTokens: 7 },
          },
          queueTimeMs: 1.6,
          executionTimeMs: 10.6,
          totalTimeMs: 12.2,
        };
      },
      {
        sendSkillInvocation: async (invocation) =>
          completedSkillResult(invocation),
      },
      taskStateMachine,
      registry,
      metrics,
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });

    const recordedNames = new Set([
      "bot_llm_prompt_tokens_total",
      "bot_llm_completion_tokens_total",
      "bot_llm_queue_time_ms_total",
      "bot_llm_execution_time_ms_total",
      "bot_llm_total_latency_ms_total",
      "bot_llm_useful_responses_total",
      "bot_task_completion_time_ms_total",
    ]);
    expect(
      metrics.snapshot().filter(({ name }) => recordedNames.has(name)),
    ).toEqual([
      {
        name: "bot_llm_completion_tokens_total",
        value: 7,
        labels: { bot_id: BOT_ID },
      },
      {
        name: "bot_llm_execution_time_ms_total",
        value: 11,
        labels: { bot_id: BOT_ID },
      },
      {
        name: "bot_llm_prompt_tokens_total",
        value: 23,
        labels: { bot_id: BOT_ID },
      },
      {
        name: "bot_llm_queue_time_ms_total",
        value: 2,
        labels: { bot_id: BOT_ID },
      },
      {
        name: "bot_llm_total_latency_ms_total",
        value: 12,
        labels: { bot_id: BOT_ID },
      },
      {
        name: "bot_llm_useful_responses_total",
        value: 1,
        labels: { bot_id: BOT_ID },
      },
      {
        name: "bot_task_completion_time_ms_total",
        value: 350,
        labels: { bot_id: BOT_ID, outcome: "success" },
      },
    ]);
  });

  it.each(["failed", "cancelled"] as const)(
    "does not count a terminal %s Skill result as a useful LLM response",
    async (outcome) => {
      const metrics = new InMemoryMetricRegistry();
      const planner = plannerWith(
        async (options) => movementDecision(options.requestId),
        {
          sendSkillInvocation: async (invocation) =>
            unsuccessfulSkillResult(
              invocation,
              outcome,
              outcome === "failed" ? "SKILL_FAILED" : "SKILL_CANCELLED_BY_RUNTIME",
            ),
        },
        undefined,
        registry,
        metrics,
      );

      await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
        action: "skill_result",
        result: { payload: { outcome } },
      });
      expect(
        metrics.snapshot().filter(
          ({ name }) => name === "bot_llm_useful_responses_total",
        ),
      ).toEqual([]);
    },
  );

  it("does not count noop or stale model responses as useful", async () => {
    const noopMetrics = new InMemoryMetricRegistry();
    const noopPlanner = plannerWith(
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
      undefined,
      undefined,
      registry,
      noopMetrics,
    );
    await expect(noopPlanner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "noop",
    });
    expect(
      noopMetrics.snapshot().some(
        ({ name }) => name === "bot_llm_useful_responses_total",
      ),
    ).toBe(false);

    const staleMetrics = new InMemoryMetricRegistry();
    const stalePlanner = plannerWith(
      async (options) => ({
        ...movementDecision(options.requestId),
        requestId: "stale-request",
      }),
      undefined,
      undefined,
      registry,
      staleMetrics,
    );
    await expect(stalePlanner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_STALE_RESPONSE",
    });
    expect(
      staleMetrics.snapshot().some(
        ({ name }) => name === "bot_llm_useful_responses_total",
      ),
    ).toBe(false);
    expect(staleMetrics.snapshot()).toContainEqual({
      name: "bot_llm_prompt_tokens_total",
      value: 10,
      labels: { bot_id: BOT_ID },
    });
  });

  it("records one abort duration for a terminal Skill failure", async () => {
    let currentTime = NOW;
    const metrics = new InMemoryMetricRegistry();
    const taskStateMachine = new PersistentTaskStateMachine({
      now: () => currentTime,
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      {
        sendSkillInvocation: async (invocation) => {
          currentTime = new Date(NOW.getTime() + 125);
          return unsuccessfulSkillResult(invocation, "failed", "SKILL_FAILED");
        },
      },
      taskStateMachine,
      registry,
      metrics,
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "failed" } },
    });
    expect(
      metrics.snapshot().filter(
        ({ name }) => name === "bot_task_completion_time_ms_total",
      ),
    ).toEqual([
      {
        name: "bot_task_completion_time_ms_total",
        value: 125,
        labels: { bot_id: BOT_ID, outcome: "abort" },
      },
    ]);
  });

  it.each(["PLAN", "RECOVER", "REPLAN"] as const)(
    "recovers a persisted %s task through a fresh PLAN after Coordinator restart",
    async (persistedState) => {
      const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
      const persisted = await seedPersistedTask(taskStateMachine, persistedState);
      const metrics = new InMemoryMetricRegistry();
      const generate = vi.fn(async (options) => movementDecision(options.requestId));
      const sendSkillInvocation = vi.fn<
        SkillInvocationTransport["sendSkillInvocation"]
      >(async (invocation) => {
        expect(generate).toHaveBeenCalledTimes(1);
        return completedSkillResult(invocation);
      });
      const planner = plannerWith(
        generate,
        { sendSkillInvocation },
        taskStateMachine,
        registry,
        metrics,
      );

      await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
        action: "skill_result",
        result: { payload: { outcome: "completed" } },
      });

      expect(generate).toHaveBeenCalledTimes(1);
      expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
      await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
        state: "SUCCESS",
        planVersion:
          persisted.planVersion + (persistedState === "REPLAN" ? 0 : 1),
        recoveryCount: persisted.recoveryCount,
      });
      if (persistedState !== "REPLAN") {
        expect(metrics.snapshot()).toContainEqual({
          name: "bot_task_state_transitions_total",
          value: 1,
          labels: {
            bot_id: BOT_ID,
            from: persistedState,
            to: "REPLAN",
          },
        });
      }
      expect(metrics.snapshot()).toContainEqual({
        name: "bot_task_state_transitions_total",
        value: 1,
        labels: { bot_id: BOT_ID, from: "REPLAN", to: "PLAN" },
      });
      expect(metrics.snapshot()).toContainEqual({
        name: "bot_task_success_total",
        value: 1,
        labels: { bot_id: BOT_ID },
      });
    },
  );

  it("uses recovery budget before replanning an interrupted idempotent execution", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    await seedPersistedTask(taskStateMachine, "EXECUTE");
    const metrics = new InMemoryMetricRegistry();
    const generate = vi.fn(async (options) => movementDecision(options.requestId));
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      expect(generate).toHaveBeenCalledTimes(1);
      return completedSkillResult(invocation);
    });
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
      registry,
      metrics,
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "SUCCESS",
      recoveryCount: 1,
      planVersion: 1,
      retryCount: 0,
    });
    for (const [from, to] of [
      ["EXECUTE", "RECOVER"],
      ["RECOVER", "REPLAN"],
      ["REPLAN", "PLAN"],
    ] as const) {
      expect(metrics.snapshot()).toContainEqual({
        name: "bot_task_state_transitions_total",
        value: 1,
        labels: { bot_id: BOT_ID, from, to },
      });
    }
  });

  it.each([
    [
      "non-idempotent",
      "movement.goto",
      "movement.goto",
      "1.0.0",
      false,
      "COORDINATOR_RESTART_EXECUTION_NON_IDEMPOTENT",
    ],
    [
      "unknown",
      "movement.unknown",
      "movement.unknown",
      "1.0.0",
      true,
      "COORDINATOR_RESTART_EXECUTION_SKILL_UNKNOWN",
    ],
  ] as const)(
    "aborts an interrupted %s Skill without model use or replay",
    async (
      _caseName,
      currentStep,
      expectedSkillId,
      expectedSkillVersion,
      catalogSkillIdempotent,
      failureReason,
    ) => {
      const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
      await seedPersistedTask(taskStateMachine, "EXECUTE", {
        currentStep,
        expectedSkillId,
        expectedSkillVersion,
      });
      const metrics = new InMemoryMetricRegistry();
      const generate = vi.fn();
      const sendSkillInvocation = vi.fn();
      const planner = plannerWith(
        generate,
        { sendSkillInvocation },
        taskStateMachine,
        catalogSkillIdempotent
          ? registry
          : registryWithSkillIdempotence(false),
        metrics,
      );

      await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
        code: "PLANNER_RESTART_RECOVERY_UNSAFE",
      });

      expect(generate).not.toHaveBeenCalled();
      expect(sendSkillInvocation).not.toHaveBeenCalled();
      await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
        state: "ABORT",
        currentStep: "restart-recovery-aborted",
        failureReason,
        recoveryCount: 0,
      });
      expect(
        metrics.snapshot().filter(
          ({ name }) => name === "bot_task_abort_total",
        ),
      ).toEqual([
        {
          name: "bot_task_abort_total",
          value: 1,
          labels: { bot_id: BOT_ID, reason: failureReason },
        },
      ]);
    },
  );

  it("aborts interrupted execution when restart recovery budget is exhausted", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({
      now: () => NOW,
      defaultMaxRecoveryCount: 0,
    });
    await seedPersistedTask(taskStateMachine, "EXECUTE");
    const metrics = new InMemoryMetricRegistry();
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
      registry,
      metrics,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_RESTART_RECOVERY_EXHAUSTED",
    });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      failureReason: "RECOVERY_BUDGET_EXHAUSTED",
      recoveryCount: 0,
    });
    expect(
      metrics.snapshot().filter(
        ({ name }) => name === "bot_task_abort_total",
      ),
    ).toEqual([
      {
        name: "bot_task_abort_total",
        value: 1,
        labels: {
          bot_id: BOT_ID,
          reason: "RECOVERY_BUDGET_EXHAUSTED",
        },
      },
    ]);
  });

  it("preserves a newer task revision that wins restart recovery CAS", async () => {
    let stored: TaskExecutionRecord | null = null;
    let recoveryReads = 0;
    let recoveryArmed = false;
    const store: TaskExecutionStore = {
      get: () => {
        if (recoveryArmed) {
          recoveryReads += 1;
          if (recoveryReads === 3 && stored !== null) {
            stored = {
              ...structuredClone(stored),
              currentStep: "newer-plan-winner",
              revision: stored.revision + 1,
            };
          }
        }
        return stored === null ? null : structuredClone(stored);
      },
      save: (record) => {
        stored = structuredClone(record);
      },
    };
    const taskStateMachine = new PersistentTaskStateMachine({
      store,
      now: () => NOW,
    });
    const persisted = await seedPersistedTask(taskStateMachine, "PLAN");
    recoveryArmed = true;
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_RESTART_RECOVERY_STALE",
    });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "PLAN",
      currentStep: "newer-plan-winner",
      revision: persisted.revision + 2,
      failureReason: null,
    });
  });

  it.each([
    ["different", "coordinator-other"],
    ["same", "coordinator-01"],
  ] as const)(
    "rejects an active %s-owner execution lease without mutating the task",
    async (_ownerKind, owner) => {
      const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
      const persisted = await seedPersistedTask(taskStateMachine, "PLAN");
      const claimed = await taskStateMachine.claimExecution(persisted.taskId, {
        owner,
        leaseExpiresAt: new Date(NOW.getTime() + 60_000).toISOString(),
        expectedRevision: persisted.revision,
      });
      const generate = vi.fn();
      const sendSkillInvocation = vi.fn();
      const planner = plannerWith(
        generate,
        { sendSkillInvocation },
        taskStateMachine,
      );

      await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
        code: "PLANNER_EXECUTION_OWNED",
      });

      expect(generate).not.toHaveBeenCalled();
      expect(sendSkillInvocation).not.toHaveBeenCalled();
      await expect(planner.getTaskExecution("task-01")).resolves.toEqual(claimed);
    },
  );

  it("claims an expired execution lease before restart recovery", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    let persisted = await taskStateMachine.create({
      taskId: "task-01",
      botId: BOT_ID,
      goal: planRequest().operatorGoal,
      executionOwner: "coordinator-old",
      executionLeaseExpiresAt: new Date(NOW.getTime() - 1).toISOString(),
      expectedResult: { outcome: "completed" },
    });
    persisted = await taskStateMachine.transition(persisted.taskId, "PLAN", {
      expectedRevision: persisted.revision,
      currentStep: "interrupted-plan",
    });
    const generate = vi.fn(async (options) => movementDecision(options.requestId));
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => completedSkillResult(invocation));
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "SUCCESS",
      executionOwner: null,
      executionLeaseExpiresAt: null,
      planVersion: 1,
    });
  });

  it("preserves the durable winner when execution-claim CAS loses", async () => {
    let stored: TaskExecutionRecord | null = null;
    let claimArmed = false;
    const winnerLease = new Date(NOW.getTime() + 60_000).toISOString();
    const store: TaskExecutionStore = {
      get: () => stored === null ? null : structuredClone(stored),
      save: (record) => {
        if (
          claimArmed &&
          stored !== null &&
          stored.executionOwner === null &&
          record.executionOwner === "coordinator-01"
        ) {
          stored = {
            ...structuredClone(stored),
            executionOwner: "coordinator-winner",
            executionLeaseExpiresAt: winnerLease,
            updatedAt: NOW.toISOString(),
            revision: stored.revision + 1,
          };
          throw new Error("Task execution revision conflicts with another snapshot.");
        }
        stored = structuredClone(record);
      },
    };
    const taskStateMachine = new PersistentTaskStateMachine({
      store,
      now: () => NOW,
    });
    await seedPersistedTask(taskStateMachine, "PLAN");
    claimArmed = true;
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_RESTART_RECOVERY_STALE",
    });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "PLAN",
      executionOwner: "coordinator-winner",
      executionLeaseExpiresAt: winnerLease,
      failureReason: null,
    });
  });

  it("preserves the durable winner when initial task creation races", async () => {
    let stored: TaskExecutionRecord | null = null;
    const winnerLease = new Date(NOW.getTime() + 60_000).toISOString();
    const store: TaskExecutionStore = {
      get: () => stored === null ? null : structuredClone(stored),
      save: (record) => {
        if (stored === null) {
          stored = {
            ...structuredClone(record),
            executionOwner: "coordinator-winner",
            executionLeaseExpiresAt: winnerLease,
          };
          throw new Error("Task execution revision conflicts with another snapshot.");
        }
        stored = structuredClone(record);
      },
    };
    const taskStateMachine = new PersistentTaskStateMachine({
      store,
      now: () => NOW,
    });
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_RESTART_RECOVERY_STALE",
    });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "PRECHECK",
      executionOwner: "coordinator-winner",
      executionLeaseExpiresAt: winnerLease,
      failureReason: null,
      revision: 0,
    });
  });

  it("does not abort a task whose execution owner changes during failure handling", async () => {
    let stored: TaskExecutionRecord | null = null;
    const winnerLease = new Date(NOW.getTime() + 60_000).toISOString();
    const store: TaskExecutionStore = {
      get: () => stored === null ? null : structuredClone(stored),
      save: (record) => {
        stored = structuredClone(record);
      },
    };
    const taskStateMachine = new PersistentTaskStateMachine({
      store,
      now: () => NOW,
    });
    const planner = plannerWith(
      async () => {
        if (stored === null) throw new Error("Missing claimed task.");
        stored = {
          ...structuredClone(stored),
          executionOwner: "coordinator-winner",
          executionLeaseExpiresAt: winnerLease,
          currentStep: "winner-plan",
          revision: stored.revision + 1,
        };
        throw new Error("AI planning failed");
      },
      { sendSkillInvocation: vi.fn() },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toThrow(
      "AI planning failed",
    );
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "PLAN",
      currentStep: "winner-plan",
      executionOwner: "coordinator-winner",
      executionLeaseExpiresAt: winnerLease,
      failureReason: null,
    });
  });

  it("rejects a stale restart request before changing the persisted task", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const persisted = await seedPersistedTask(taskStateMachine, "PLAN");
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        planVersion: persisted.planVersion + 1,
      }),
    ).rejects.toMatchObject({ code: "PLANNER_STALE_RESPONSE" });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toEqual(persisted);
  });

  it("carries a fresh requested world version through restart replanning", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const persisted = await seedPersistedTask(taskStateMachine, "PLAN");
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      {
        sendSkillInvocation: async (invocation) =>
          completedSkillResult(invocation),
      },
      taskStateMachine,
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        planVersion: persisted.planVersion,
        worldStateVersion: 7,
      }),
    ).resolves.toMatchObject({ action: "skill_result" });

    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "SUCCESS",
      planVersion: persisted.planVersion + 1,
      worldStateVersion: 7,
    });
  });

  it("does not mutate a persisted task when restart recovery is already cancelled", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const persisted = await seedPersistedTask(taskStateMachine, "PLAN");
    const controller = new AbortController();
    controller.abort("operator-cancelled");
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(
      planner.planAndDispatch({ ...planRequest(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PLANNER_CANCELLED" });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toEqual(persisted);
  });

  it("aborts an interrupted VERIFY state instead of replaying its Skill", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    await seedPersistedTask(taskStateMachine, "VERIFY");
    const generate = vi.fn();
    const sendSkillInvocation = vi.fn();
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_RESTART_RECOVERY_UNSAFE",
    });

    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      failureReason: "COORDINATOR_RESTART_STATE_UNRECOVERABLE:VERIFY",
    });
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

  it("accepts a slow-but-valid response when only the world version drifted (P0-4 semantic revalidation)", async () => {
    let worldStateVersion = 7;
    const planner = plannerWith(async (options) => {
      // 模型 13s 级延迟期间世界版本前进（inventory/nearby 变化是常态）
      worldStateVersion = 8;
      return aiResult(
        JSON.stringify({
          action: "noop",
          botId: BOT_ID,
          taskId: "task-01",
          reasonCode: "NO_SAFE_SKILL",
        }),
        options.requestId,
      );
    });

    const result = await planner.planAndDispatch({
      ...planRequest(),
      planVersion: 0,
      worldStateVersion: 7,
      currentVersions: () => ({
        planVersion: 0,
        worldStateVersion,
      }),
    });
    expect(result.action).toBe("noop");
    // noop 决策按契约落为 ABORT 终态（区别于被丢弃的过期响应）
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      failureReason: "PLANNER_NOOP:NO_SAFE_SKILL",
    });
  });

  it("still drops the response when the world version rolled back (corruption signal)", async () => {
    const planner = plannerWith(async (options) =>
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

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        planVersion: 0,
        worldStateVersion: 9,
        currentVersions: () => ({
          planVersion: 0,
          worldStateVersion: 7,
        }),
      }),
    ).rejects.toMatchObject({ code: "PLANNER_STALE_RESPONSE" });
  });

  it("drops a stale response when the persistent task is replanned concurrently", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const planner = plannerWith(
      async (options) => {
        await taskStateMachine.transition("task-01", "REPLAN", {
          currentStep: "newer-plan",
        });
        return aiResult(
          JSON.stringify({
            action: "noop",
            botId: BOT_ID,
            taskId: "task-01",
            reasonCode: "NO_SAFE_SKILL",
          }),
          options.requestId,
        );
      },
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_STALE_RESPONSE",
    });
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "REPLAN",
      planVersion: 1,
      failureReason: null,
      revision: 2,
    });
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
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      failureReason: "PLANNER_NOOP:NO_SAFE_SKILL",
      cancellationToken: { cancelled: false },
      revision: 2,
    });
  });

  it("persists a terminal Skill result as ABORT without retrying", async () => {
    const outcome = "failed" as const;
    const errorCode = "SKILL_INPUT_INVALID";
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => unsuccessfulSkillResult(invocation, outcome, errorCode));
    const planner = plannerWith(
      async (options) =>
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
      { sendSkillInvocation },
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome, errorCode } },
    });
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      currentStep: "terminal-skill-failure",
      recoveryCount: 0,
      failureReason: errorCode,
      cancellationToken: { cancelled: false },
      actualResult: {
        outcome,
        errorCode,
        skillId: "movement.goto",
        skillVersion: "1.0.0",
        attempts: 1,
      },
      revision: 3,
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["failed", "NORMAL_ACTIONS_PAUSED"],
    ["failed", "SKILL_EXECUTION_INTERRUPTED"],
    ["cancelled", "SKILL_CANCELLED"],
  ] as const)(
    "recovers a recoverable L0 %s result (%s) without another model call",
    async (outcome, errorCode) => {
      const generate = vi.fn(async (options) => movementDecision(options.requestId));
      let attempt = 0;
      const sendSkillInvocation = vi.fn<
        SkillInvocationTransport["sendSkillInvocation"]
      >(async (invocation) => {
        attempt += 1;
        return attempt === 1
          ? unsuccessfulSkillResult(invocation, outcome, errorCode)
          : completedSkillResult(invocation, 92);
      });
      const planner = plannerWith(generate, { sendSkillInvocation });

      await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
        action: "skill_result",
        result: { payload: { outcome: "completed" } },
      });

      expect(generate).toHaveBeenCalledTimes(1);
      expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
      const firstInvocation = sendSkillInvocation.mock.calls[0]![0];
      const secondInvocation = sendSkillInvocation.mock.calls[1]![0];
      expect(secondInvocation.payload.invocationId).not.toBe(
        firstInvocation.payload.invocationId,
      );
      await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
        state: "SUCCESS",
        currentStep: null,
        recoveryCount: 1,
        retryCount: 1,
        planVersion: 1,
        failureReason: errorCode,
        cancellationToken: { cancelled: false },
        actualResult: {
          outcome: "completed",
          output: { reached: true },
        },
        revision: 7,
      });
    },
  );

  it("does not replay a non-idempotent Skill after a partial L0 interruption", async () => {
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      unsuccessfulSkillResult(
        invocation,
        "failed",
        "SKILL_EXECUTION_INTERRUPTED",
      ),
    );
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
      undefined,
      registryWithSkillIdempotence(false),
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: {
        payload: {
          outcome: "failed",
          errorCode: "SKILL_EXECUTION_INTERRUPTED",
        },
      },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      currentStep: "non-idempotent-recovery-requires-replan",
      recoveryCount: 0,
      failureReason:
        "NON_IDEMPOTENT_L0_RETRY_UNSAFE:SKILL_EXECUTION_INTERRUPTED",
      revision: 3,
    });
  });

  it("can retry a non-idempotent Skill paused before its first mutation", async () => {
    let attempt = 0;
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      attempt += 1;
      return attempt === 1
        ? unsuccessfulSkillResult(
            invocation,
            "failed",
            "NORMAL_ACTIONS_PAUSED",
          )
        : completedSkillResult(invocation, 94);
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
      undefined,
      registryWithSkillIdempotence(false),
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
  });

  it("waits for L0 safety to clear before retrying the Skill", async () => {
    const baseRecord = registry.get(BOT_ID, NOW)!;
    let safetyPaused = false;
    const recoveryRegistry = {
      get: (botId: string) => {
        if (botId !== BOT_ID) return null;
        return {
          ...baseRecord,
          currentStatus: {
            ...baseRecord.currentStatus!,
            safety: {
              ...baseRecord.currentStatus!.safety,
              mode: safetyPaused ? "paused" as const : "monitoring" as const,
              normalTasksPaused: safetyPaused,
            },
          },
        };
      },
    };
    let attempt = 0;
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      attempt += 1;
      if (attempt === 1) {
        safetyPaused = true;
        setTimeout(() => {
          safetyPaused = false;
        }, 2);
        return unsuccessfulSkillResult(
          invocation,
          "failed",
          "NORMAL_ACTIONS_PAUSED",
        );
      }
      expect(safetyPaused).toBe(false);
      return completedSkillResult(invocation, 93);
    });
    const planner = new CoordinatorLocalPlanner({
      ai: { generate: async (options) => movementDecision(options.requestId) },
      registry: recoveryRegistry,
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
      safetyRecoveryPollIntervalMs: 1,
      maxSafetyRecoveryWaitMs: 50,
    });

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
  });

  it("waits when L0 pauses after planning but before the first dispatch", async () => {
    const baseRecord = registry.get(BOT_ID, NOW)!;
    let safetyPaused = false;
    const recoveryRegistry = {
      get: (botId: string) => {
        if (botId !== BOT_ID) return null;
        return {
          ...baseRecord,
          currentStatus: {
            ...baseRecord.currentStatus!,
            safety: {
              ...baseRecord.currentStatus!.safety,
              mode: safetyPaused ? "paused" as const : "monitoring" as const,
              normalTasksPaused: safetyPaused,
            },
          },
        };
      },
    };
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      expect(safetyPaused).toBe(false);
      return completedSkillResult(invocation, 97);
    });
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) => {
          safetyPaused = true;
          setTimeout(() => {
            safetyPaused = false;
          }, 2);
          return movementDecision(options.requestId);
        },
      },
      registry: recoveryRegistry,
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
      safetyRecoveryPollIntervalMs: 1,
      maxSafetyRecoveryWaitMs: 50,
    });

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "SUCCESS",
      recoveryCount: 0,
      retryCount: 0,
      planVersion: 0,
    });
  });

  it("aborts when L0 safety remains paused past the bounded wait", async () => {
    const baseRecord = registry.get(BOT_ID, NOW)!;
    let safetyPaused = false;
    const recoveryRegistry = {
      get: (botId: string) => {
        if (botId !== BOT_ID) return null;
        return {
          ...baseRecord,
          currentStatus: {
            ...baseRecord.currentStatus!,
            safety: {
              ...baseRecord.currentStatus!.safety,
              mode: safetyPaused ? "paused" as const : "monitoring" as const,
              normalTasksPaused: safetyPaused,
            },
          },
        };
      },
    };
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      safetyPaused = true;
      return unsuccessfulSkillResult(
        invocation,
        "failed",
        "NORMAL_ACTIONS_PAUSED",
      );
    });
    const planner = new CoordinatorLocalPlanner({
      ai: { generate: async (options) => movementDecision(options.requestId) },
      registry: recoveryRegistry,
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
      safetyRecoveryPollIntervalMs: 1,
      maxSafetyRecoveryWaitMs: 2,
    });

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_SAFETY_PAUSED",
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      currentStep: "wait-for-safety-clear",
      recoveryCount: 1,
      retryCount: 0,
      failureReason: "PLANNER_SAFETY_PAUSED",
      revision: 4,
    });
  });

  it("aborts after the persistent L0 recovery budget is exhausted", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({
      now: () => NOW,
      defaultMaxRecoveryCount: 1,
    });
    const generate = vi.fn(async (options) => movementDecision(options.requestId));
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      unsuccessfulSkillResult(invocation, "cancelled", "SKILL_CANCELLED"),
    );
    const planner = plannerWith(
      generate,
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: {
        payload: { outcome: "cancelled", errorCode: "SKILL_CANCELLED" },
      },
    });

    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      currentStep: "recovery-budget-exhausted",
      recoveryCount: 1,
      retryCount: 1,
      planVersion: 1,
      failureReason: "RECOVERY_BUDGET_EXHAUSTED",
      cancellationToken: { cancelled: false },
      revision: 6,
    });
  });

  it("does not retry when the persistent recovery budget is zero", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({
      now: () => NOW,
      defaultMaxRecoveryCount: 0,
    });
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      unsuccessfulSkillResult(invocation, "cancelled", "SKILL_CANCELLED"),
    );
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "cancelled" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      recoveryCount: 0,
      retryCount: 0,
      failureReason: "RECOVERY_BUDGET_EXHAUSTED",
      revision: 3,
    });
  });

  it("does not recover a Skill cancellation after the user aborts the task", async () => {
    const controller = new AbortController();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      controller.abort("operator-cancelled");
      return unsuccessfulSkillResult(invocation, "cancelled", "SKILL_CANCELLED");
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
    );

    await expect(
      planner.planAndDispatch({ ...planRequest(), signal: controller.signal }),
    ).rejects.toMatchObject({ code: "PLANNER_CANCELLED" });

    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      recoveryCount: 0,
      failureReason: "PLANNER_CANCELLED",
      cancellationToken: {
        cancelled: true,
        reason: "PLANNER_CANCELLED",
      },
      revision: 3,
    });
  });

  it("does not recover after the persistent cancellation token is set", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      await taskStateMachine.cancel("task-01", "USER_CANCELLED");
      return unsuccessfulSkillResult(invocation, "cancelled", "SKILL_CANCELLED");
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_CANCELLED",
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      recoveryCount: 0,
      failureReason: "USER_CANCELLED",
      cancellationToken: { cancelled: true, reason: "USER_CANCELLED" },
      revision: 3,
    });
  });

  it("drops an old Skill result when a newer replan wins the task revision", async () => {
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      await taskStateMachine.transition("task-01", "REPLAN", {
        currentStep: "newer-replan",
      });
      return unsuccessfulSkillResult(invocation, "cancelled", "SKILL_CANCELLED");
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_STALE_RESPONSE",
    });

    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "REPLAN",
      currentStep: "newer-replan",
      planVersion: 1,
      recoveryCount: 0,
      failureReason: null,
      revision: 3,
    });
  });

  it("preserves a durable replan that wins during the result commit", async () => {
    let stored: TaskExecutionRecord | null = null;
    const store: TaskExecutionStore = {
      get: () => stored === null ? null : structuredClone(stored),
      save: (record) => {
        if (record.state === "VERIFY" && stored?.state === "EXECUTE") {
          stored = {
            ...structuredClone(stored),
            state: "REPLAN",
            currentStep: "durable-winner",
            planVersion: stored.planVersion + 1,
            revision: stored.revision + 1,
          };
          throw new Error("Task execution revision conflicts with another snapshot.");
        }
        stored = structuredClone(record);
      },
    };
    const taskStateMachine = new PersistentTaskStateMachine({
      store,
      now: () => NOW,
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      {
        sendSkillInvocation: async (invocation) =>
          completedSkillResult(invocation, 96),
      },
      taskStateMachine,
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_STALE_RESPONSE",
    });
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "REPLAN",
      currentStep: "durable-winner",
      planVersion: 1,
      failureReason: null,
      revision: 3,
    });
  });

  it("rejects a transport result that does not match the active invocation", async () => {
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      const result = completedSkillResult(invocation, 95);
      return {
        ...result,
        payload: {
          ...result.payload,
          invocationId: uuid(999),
        },
      };
    });
    const planner = plannerWith(
      async (options) => movementDecision(options.requestId),
      { sendSkillInvocation },
    );

    await expect(planner.planAndDispatch(planRequest())).rejects.toMatchObject({
      code: "PLANNER_SKILL_RESULT_INVALID",
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      failureReason: "PLANNER_SKILL_RESULT_INVALID",
      revision: 3,
    });
  });

  it("cancels the persistent task when the external AbortSignal fires", async () => {
    const controller = new AbortController();
    const taskStateMachine = new PersistentTaskStateMachine({ now: () => NOW });
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const planner = plannerWith(
      async (options) => {
        expect(options.signal).toBe(controller.signal);
        controller.abort("operator-cancelled");
        throw new Error("AI request cancelled");
      },
      { sendSkillInvocation },
      taskStateMachine,
    );

    await expect(
      planner.planAndDispatch({ ...planRequest(), signal: controller.signal }),
    ).rejects.toThrow("AI request cancelled");
    expect(sendSkillInvocation).not.toHaveBeenCalled();
    await expect(planner.getTaskExecution("task-01")).resolves.toMatchObject({
      state: "ABORT",
      failureReason: "PLANNER_CANCELLED",
      cancellationToken: {
        cancelled: true,
        reason: "PLANNER_CANCELLED",
        cancelledAt: NOW.toISOString(),
      },
      movementLease: null,
      revision: 2,
    });
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

  it("derives a single-item acquisition goal without a model round-trip", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const generate = vi.fn();
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
      reasonCode: "DETERMINISTIC_ACQUISITION",
      result: { payload: { outcome: "completed" } },
      ai: null,
    });
    // The whole point: the model was measured answering noop/NO_SAFE_SKILL on
    // 6 of 6 of these goals; the branch choice is now derived, not asked.
    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).toHaveBeenCalledTimes(3);
  });

  it("derives a dirt acquisition goal deterministically with a count of one", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const generate = vi.fn();
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
        ...resourcePlanRequest(),
        operatorGoal: "获取 dirt",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation.mock.calls[0]?.[0].payload).toMatchObject({
      skillId: "collect.block",
      input: { blockName: "dirt", maxCount: 1 },
    });
  });

  it("continues from the runtime inventory instead of rebuilding the wooden tool chain", async () => {
    const planning = planningRegistry();
    const current = planning.get(BOT_ID, NOW)!.currentStatus!;
    planning.ingest({
      schemaVersion: "1.0",
      messageId: uuid(40),
      traceId: "trace-registry",
      timestamp: NOW.toISOString(),
      source: { service: "bot-runtime", instanceId: RUNTIME_ID },
      botId: BOT_ID,
      type: "bot.status.v1",
      payload: {
        ...current,
        sequence: 4,
        inventory: [
          { itemName: "oak_log", count: 3 },
          { itemName: "crafting_table", count: 1 },
          { itemName: "wooden_pickaxe", count: 1 },
        ],
      },
    }, NOW);
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const planner = resourcePlanner(
      planning,
      { sendSkillInvocation },
      [{ itemName: "cobblestone", count: 1 }],
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "获取 cobblestone",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation.mock.calls[0]?.[0]).toMatchObject({
      payload: {
        skillId: "collect.block",
        input: expect.objectContaining({ blockName: "stone", maxCount: 1 }),
      },
    });
  });

  it("records the deterministic decision and the step ladder without leaking the goal or inputs", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    const warn = vi.fn();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const generate = vi.fn();
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

    expect(generate).not.toHaveBeenCalled();
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

  /**
   * 屏蔽码本身是对的：非幂等步骤失败后不能让上层以为可以安全重放。但只返回
   * `NON_IDEMPOTENT_RESULT_UNCERTAIN` 会把"到底哪儿坏了"一并丢掉——真实排查时
   * 协调器日志里只有这个屏蔽码，得翻 bot-runtime 日志才能看到
   * `COLLECT_BLOCKS_FAILED`。所以真实码要在屏蔽发生的地方记下来。
   */
  it("logs the real failure code behind the non-idempotent mask", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    const warn = vi.fn();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "collect.block"
        ? skillResult(invocation, "failed", "COLLECT_BLOCKS_FAILED")
        : skillResult(invocation, "completed"),
    );
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
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });

    const masked = warn.mock.calls.find(
      ([event]) => event === "coordinator_planner_step_failure_masked",
    );
    // 两个码同时在场：上报的屏蔽码，和真正解释故障的那个。
    expect(masked?.[1]).toMatchObject({
      traceId: "trace-plan-01",
      taskId: "task-01",
      botId: BOT_ID,
      skillId: "collect.block",
      reportedErrorCode: "NON_IDEMPOTENT_RESULT_UNCERTAIN",
      skillErrorCode: "COLLECT_BLOCKS_FAILED",
    });
    // 屏蔽语义不动：监督链记的仍然是"结果不确定",没被诊断日志改写成可重放。
    const supervision = [...info.mock.calls, ...warn.mock.calls].find(
      ([event]) => event === "coordinator_planner_goal_supervision",
    );
    expect(JSON.stringify(supervision?.[1])).toContain(
      "NON_IDEMPOTENT_RESULT_UNCERTAIN",
    );
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain("nearby resources");
    expect(logged).not.toContain("isolated-test");
  });

  it("does not consult the model for an acquisition goal even when it would decline", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    // The model's measured answer for this goal shape was noop/NO_SAFE_SKILL
    // 6 of 6 times; if the deterministic path ever regresses, this mock makes
    // the regression loud instead of silently slower.
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
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).resolves.toMatchObject({ action: "skill_result" });
    expect(generate).not.toHaveBeenCalled();
    expect(sendSkillInvocation).toHaveBeenCalledTimes(3);
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

  /**
   * A bare `action: "noop"` reads the same whether the model declined a
   * reachable goal or the Coordinator never offered the item at all. That is the
   * same silent-failure shape as a truncated log array: the record looks
   * complete. Real case: a stone-pickaxe goal came back `noop` because every
   * derived plan needs a placed crafting table and this Runtime advertises no
   * placement Skill — invisible from the coordinator log.
   */
  it("records why a declined goal's item was never offered", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    const warn = vi.fn();
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
      logger: { info, warn, error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one stone_pickaxe from nearby resources.",
      }),
    ).resolves.toMatchObject({ action: "noop", reasonCode: "NO_SAFE_SKILL" });

    // The item is excluded, so the narrowed re-ask must not fire: overturning
    // this noop would dispatch a plan the execution gate then refuses.
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation).not.toHaveBeenCalled();

    const bindability = info.mock.calls.find(
      ([event]) => event === "coordinator_planner_goal_bindability",
    );
    expect(bindability?.[1]).toMatchObject({
      taskId: "task-01",
      botId: BOT_ID,
    });
    expect(bindability?.[1].bindableCount).toBeGreaterThan(0);
    expect(bindability?.[1].excludedCount).toBeGreaterThan(0);
    // Aggregated, so one record cannot grow with the resource graph.
    expect(
      bindability?.[1].exclusionReasons["SKILL_NOT_ADVERTISED:world.place-block"],
    ).toBeGreaterThan(0);

    // The one question a noop cannot otherwise answer: was this item offered?
    const named = warn.mock.calls.find(
      ([event]) => event === "coordinator_planner_goal_named_unbindable_item",
    );
    expect(named?.[1]).toMatchObject({
      traceId: "trace-plan-01",
      taskId: "task-01",
      botId: BOT_ID,
      unbindableItems: ["stone_pickaxe=SKILL_NOT_ADVERTISED:world.place-block"],
    });
    // Diagnostics stay narrower than the prompt: no goal text, no server identity.
    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(logged).not.toContain("nearby resources");
    expect(logged).not.toContain("isolated-test");
  });

  /**
   * 木镐以上的全部工具链此前都卡在 `place-station`：协调器填不出
   * `world.place-block` 要的 `referenceBlock`，于是整条链在派发前就被拒。缺的从来
   * 不是技能——`world.scan` 和 `world.place-block` 一直都在上报——缺的是把观测事实
   * 喂给协调器。这条把整条链跑通，并钉住"参考方块必须来自观测"这一点。
   */
  it("observes a placement site and completes a station-backed craft chain", async () => {
    const placement = placementRegistry();
    const dispatched: string[] = [];
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      dispatched.push(invocation.payload.skillId);
      return skillResult(invocation, "completed");
    });
    const planner = resourcePlanner(
      placement,
      { sendSkillInvocation },
      [{ itemName: "wooden_pickaxe", count: 1 }],
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one wooden_pickaxe from nearby resources.",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });

    // The scan comes before the placement, and the station-backed craft comes
    // after it: the order is what makes the reference an observation.
    const scanIndex = dispatched.indexOf("world.scan");
    const placeIndex = dispatched.indexOf("world.place-block");
    expect(scanIndex).toBeGreaterThanOrEqual(0);
    expect(placeIndex).toBeGreaterThan(scanIndex);
    expect(dispatched.lastIndexOf("craft.item")).toBeGreaterThan(placeIndex);

    const scan = sendSkillInvocation.mock.calls.find(
      ([invocation]) =>
        invocation.payload.skillId === "world.scan" &&
        inputField(invocation.payload.input, "blockName") === "grass_block",
    )![0];
    expect(scan.payload.input).toMatchObject({
      blockName: "grass_block",
      maxCount: 16,
      maxDistance: 6,
      dimension: "minecraft:overworld",
      serverProfileId: "isolated-test",
    });

    // The reference is the in-window scanned block, not `position.y - 1`, and
    // the face is the one surface a scanned ground block can be built on.
    const placement_ = sendSkillInvocation.mock.calls.find(
      ([invocation]) => invocation.payload.skillId === "world.place-block",
    )![0];
    expect(placement_.payload.input).toMatchObject({
      itemName: "crafting_table",
      referenceBlock: { x: 1_236, y: 63, z: -4_321 },
      face: { x: 0, y: 1, z: 0 },
      serverProfileId: "isolated-test",
    });

    // The station-backed craft binds to the Runtime's read-back position — one
    // block above the reference — not to a coordinate the coordinator invented.
    const stationCraft = sendSkillInvocation.mock.calls
      .map(([invocation]) => invocation)
      .find(
        (invocation) =>
          invocation.payload.skillId === "craft.item" &&
          inputField(invocation.payload.input, "itemName") === "wooden_pickaxe",
      )!;
    expect(stationCraft.payload.input).toMatchObject({
      itemName: "wooden_pickaxe",
      craftingTable: { x: 1_236, y: 64, z: -4_321 },
    });
  });

  it("places only above a scanned ground block whose target is observed air", async () => {
    const placement = placementRegistry();
    const blockedReference = { x: 1_235, y: 63, z: -4_321, distance: 2 };
    const openReference = { x: 1_236, y: 63, z: -4_321, distance: 3 };
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      if (invocation.payload.skillId !== "world.scan") {
        return skillResult(invocation, "completed");
      }
      const blockName = inputField(invocation.payload.input, "blockName");
      if (blockName === "air") {
        return skillResult(invocation, "completed", undefined, 1, scanOutput(
          invocation,
          [{ x: openReference.x, y: openReference.y + 1, z: openReference.z, distance: 3 }],
        ));
      }
      return skillResult(invocation, "completed", undefined, 1, scanOutput(
        invocation,
        blockName === "grass_block" ? [blockedReference, openReference] : [],
      ));
    });
    const planner = resourcePlanner(
      placement,
      { sendSkillInvocation },
      [{ itemName: "wooden_pickaxe", count: 1 }],
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one wooden_pickaxe from nearby resources.",
      }),
    ).resolves.toMatchObject({ action: "skill_result" });

    const stationPlacement = sendSkillInvocation.mock.calls
      .map(([invocation]) => invocation)
      .find((invocation) => invocation.payload.skillId === "world.place-block")!;
    expect(stationPlacement.payload.input).toMatchObject({
      referenceBlock: { x: openReference.x, y: openReference.y, z: openReference.z },
      face: { x: 0, y: 1, z: 0 },
    });
  });

  it("binds the station craft to the Runtime's read-back, not reference + face", async () => {
    const placement = placementRegistry();
    // The Runtime reports a position the coordinator's own arithmetic would not
    // produce. Trusting the read-back is the whole point: only the Runtime has
    // confirmed a block is really standing there.
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "world.place-block"
        ? skillResult(invocation, "completed", undefined, 1, {
            placed: true,
            placedBlockName: "crafting_table",
            position: { x: 1_240, y: 70, z: -4_300 },
          })
        : skillResult(invocation, "completed"),
    );
    const planner = resourcePlanner(
      placement,
      { sendSkillInvocation },
      [{ itemName: "wooden_pickaxe", count: 1 }],
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one wooden_pickaxe from nearby resources.",
      }),
    ).resolves.toMatchObject({ action: "skill_result" });

    const stationCraft = sendSkillInvocation.mock.calls
      .map(([invocation]) => invocation)
      .find(
        (invocation) =>
          invocation.payload.skillId === "craft.item" &&
          inputField(invocation.payload.input, "itemName") === "wooden_pickaxe",
      )!;
    expect(stationCraft.payload.input).toMatchObject({
      craftingTable: { x: 1_240, y: 70, z: -4_300 },
    });
  });

  it("reports no target when every scanned block falls outside the reach window", async () => {
    const placement = placementRegistry();
    const initial = placement.get(BOT_ID, NOW)!;
    let statusSequence = initial.currentStatus!.sequence;
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "world.scan"
        ? skillResult(invocation, "completed", undefined, 1, {
            blockName: String(inputField(invocation.payload.input, "blockName")),
            dimension: "minecraft:overworld",
            // One under the bot's feet, one past placement reach. Neither is a
            // site, so dispatching a placement would be a guess.
            matches: [
              { x: 1_234, y: 63, z: -4_321, distance: 1 },
              { x: 1_240, y: 63, z: -4_321, distance: 6 },
            ],
            targetsFound: 2,
            complete: true,
          })
        : skillResult(invocation, "completed"),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) =>
          aiResult(
            JSON.stringify({
              action: "plan_items",
              botId: BOT_ID,
              taskId: "task-01",
              goals: [{ itemName: "wooden_pickaxe", count: 1 }],
              reasonCode: "ADVANCE_TASK",
            }),
            options.requestId,
          ),
      },
      registry: {
        get: () => ({
          ...initial,
          currentStatus: {
            ...initial.currentStatus!,
            sequence: statusSequence,
          },
        }),
      },
      // A missing site is repairable, so the supervisor re-observes before it
      // gives up. Without a reobserve transport the failure would surface as
      // PLAN_STEP_DISPATCH_UNAVAILABLE and hide the real reason.
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
        operatorGoal: "Craft one wooden_pickaxe from nearby resources.",
      }),
    ).rejects.toMatchObject({ code: "STEP_TARGET_NOT_FOUND" });
    // Every ground-block candidate was tried before reporting no site: giving up
    // after the first name would report "no site" for a world that has one.
    const scanned = new Set(
      sendSkillInvocation.mock.calls
        .filter(([invocation]) => invocation.payload.skillId === "world.scan")
        .map(([invocation]) => inputField(invocation.payload.input, "blockName")),
    );
    expect(scanned.size).toBe(9);
    expect(
      sendSkillInvocation.mock.calls.some(
        ([invocation]) => invocation.payload.skillId === "world.place-block",
      ),
    ).toBe(false);
  });

  it("does not accept a placement whose read-back names a different block", async () => {
    const placement = placementRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "world.place-block"
        ? skillResult(invocation, "completed", undefined, 1, {
            placed: true,
            placedBlockName: "dirt",
            position: { x: 1_236, y: 64, z: -4_321 },
          })
        : skillResult(invocation, "completed"),
    );
    const planner = resourcePlanner(
      placement,
      { sendSkillInvocation },
      [{ itemName: "wooden_pickaxe", count: 1 }],
    );

    // `placed: true` is only the Runtime's word that it tried. The station the
    // next craft needs is proven by the read-back name, so a mismatch fails.
    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one wooden_pickaxe from nearby resources.",
      }),
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });
    expect(
      sendSkillInvocation.mock.calls.some(
        ([invocation]) =>
          invocation.payload.skillId === "craft.item" &&
          inputField(invocation.payload.input, "itemName") === "wooden_pickaxe",
      ),
    ).toBe(false);
  });

  it("refuses smelting when the Runtime does not advertise smelt.item", async () => {
    const placement = placementRegistry();
    const info = vi.fn();
    const warn = vi.fn();
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
      registry: { get: () => placement.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn, error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    // Furnace placement is supported, but this Runtime catalog still lacks the
    // non-idempotent smelt skill itself, so the derived plan stays unavailable.
    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one iron_ingot from nearby resources.",
      }),
    ).resolves.toMatchObject({ action: "noop" });
    expect(generate).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation).not.toHaveBeenCalled();

    const bindability = info.mock.calls.find(
      ([event]) => event === "coordinator_planner_goal_bindability",
    );
    // The skill advertisement gate is shared by bindability reporting and the
    // execution gate, so the missing skill is the actionable reason.
    expect(
      bindability?.[1].exclusionReasons["SKILL_NOT_ADVERTISED:smelt.item"],
    ).toBeGreaterThan(0);
    const named = warn.mock.calls.find(
      ([event]) => event === "coordinator_planner_goal_named_unbindable_item",
    );
    expect(named?.[1]).toMatchObject({
      unbindableItems: ["iron_ingot=SKILL_NOT_ADVERTISED:smelt.item"],
    });
  });

  it("observes a furnace placement and executes the smelt step", async () => {
    const smelting = smeltingRegistry();
    const dispatched: string[] = [];
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => {
      dispatched.push(invocation.payload.skillId);
      return skillResult(invocation, "completed");
    });
    const planner = resourcePlanner(
      smelting,
      { sendSkillInvocation },
      [{ itemName: "iron_ingot", count: 1 }],
    );

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Smelt one iron_ingot from nearby resources.",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "completed" } },
    });

    const scanIndex = dispatched.indexOf("world.scan");
    const placeIndexes = dispatched
      .map((skillId, index) => (skillId === "world.place-block" ? index : -1))
      .filter((index) => index >= 0);
    const smeltIndex = dispatched.lastIndexOf("smelt.item");
    expect(scanIndex).toBeGreaterThanOrEqual(0);
    expect(placeIndexes.length).toBe(2);
    expect(smeltIndex).toBeGreaterThan(Math.max(...placeIndexes));

    const furnacePlacement = sendSkillInvocation.mock.calls
      .map(([invocation]) => invocation)
      .find(
        (invocation) =>
          invocation.payload.skillId === "world.place-block" &&
          inputField(invocation.payload.input, "itemName") === "furnace",
      )!;
    expect(furnacePlacement.payload.input).toMatchObject({
      itemName: "furnace",
      referenceBlock: { x: 1_236, y: 63, z: -4_321 },
      face: { x: 0, y: 1, z: 0 },
      serverProfileId: "isolated-test",
    });

    const smelt = sendSkillInvocation.mock.calls
      .map(([invocation]) => invocation)
      .find((invocation) => invocation.payload.skillId === "smelt.item")!;
    expect(smelt.payload.input).toMatchObject({
      inputItemName: "raw_iron",
      fuelItemName: "oak_planks",
      fuelCount: 1,
      count: 1,
      furnace: { x: 1_236, y: 64, z: -4_321 },
      serverProfileId: "isolated-test",
    });
  });

  /**
   * 熔炉这一项本身现在是可达的：它的工作站是工作台，而工作台已经能放置了。
   * 这条把"新可达"钉住，免得下次有人为了让 iron_ingot 的排除更简单，
   * 顺手把整个 furnace 也划到不可达里去。
   */
  it("offers the furnace item itself once placement is advertised", async () => {
    const placement = placementRegistry();
    const info = vi.fn();
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
      registry: { get: () => placement.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation: vi.fn() },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await planner.planAndDispatch({
      ...planRequest(),
      operatorGoal: "Equip the best armor already in inventory.",
    });

    const bindability = info.mock.calls.find(
      ([event]) => event === "coordinator_planner_goal_bindability",
    );
    // The station-backed tool tier is what placement unlocked, so the bindable
    // count has to have grown past the four items the planning catalog reached.
    expect(bindability?.[1].bindableCount).toBeGreaterThan(4);
    expect(
      bindability?.[1].exclusionReasons["SKILL_NOT_ADVERTISED:world.place-block"],
    ).toBeUndefined();
  });

  it("records the reference block name but never the placement coordinate", async () => {
    const placement = placementRegistry();
    const info = vi.fn();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) => skillResult(invocation, "completed"));
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) =>
          aiResult(
            JSON.stringify({
              action: "plan_items",
              botId: BOT_ID,
              taskId: "task-01",
              goals: [{ itemName: "wooden_pickaxe", count: 1 }],
              reasonCode: "ADVANCE_TASK",
            }),
            options.requestId,
          ),
      },
      registry: { get: () => placement.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Craft one wooden_pickaxe from nearby resources.",
      }),
    ).resolves.toMatchObject({ action: "skill_result" });

    const site = info.mock.calls.find(
      ([event]) => event === "coordinator_planner_placement_site_observed",
    );
    expect(site?.[1]).toMatchObject({
      traceId: "trace-plan-01",
      taskId: "task-01",
      botId: BOT_ID,
      referenceBlockName: "grass_block",
    });
    // A station coordinate is a base coordinate. Diagnostics stay narrower than
    // the prompt, so the position is absent even though the planner holds it.
    const logged = JSON.stringify(info.mock.calls);
    expect(logged).not.toContain("1236");
    expect(logged).not.toContain("isolated-test");
  });

  it("keeps a model decision under the same grounding and identity checks", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >();
    const generate = vi.fn(async (options) =>
      aiResult(
        JSON.stringify({
          action: "plan_items",
          botId: "other-bot",
          taskId: "task-01",
          goals: [{ itemName: "crafting_table", count: 1 }],
          reasonCode: "ADVANCE_TASK",
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

    // A model decision that changes identity is rejected outright, never
    // dispatched. The goal is deliberately not deterministic-parseable so the
    // model branch is the one under test.
    await expect(
      planner.planAndDispatch({
        ...planRequest(),
        operatorGoal: "Equip the best armor already in inventory.",
      }),
    ).rejects.toMatchObject({ code: "PLANNER_DECISION_MISMATCH" });
    expect(generate).toHaveBeenCalledTimes(1);
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
    const generate = vi.fn();
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
    expect(generate).not.toHaveBeenCalled();
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
    expect(get).toHaveBeenCalledTimes(12);
    expect(requestFreshStatus).toHaveBeenCalledTimes(1);
    expect(sendSkillInvocation.mock.calls[0]![0].payload.input).toMatchObject({
      blockName: "oak_log",
      maxCount: 1,
      maxDistance: 64,
      dimension: "minecraft:overworld",
      serverProfileId: "isolated-test",
    });
    expect(sendSkillInvocation.mock.calls[1]![0].payload.input).toMatchObject({
      itemName: "oak_planks",
      count: 1,
      craftingTable: null,
      serverProfileId: "isolated-test",
    });
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
    const generate = vi.fn(async (options) =>
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
    );
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      now: () => NOW,
      randomId: uuidSequence(),
    });

    // The movement goal keeps this on the model branch; the schema then rejects
    // the amplified goals before anything is dispatched.
    await expect(
      planner.planAndDispatch(planRequest()),
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

  /**
   * 线上真实形态：模型给一个 `collect.block` 直投去满足需要整条链的目标，
   * Runtime 诚实报 completed 且 `itemsCollected:0`。旧代码把这个原样当成功返回，
   * 运维侧看到的响应与真采满了一模一样。
   */
  it("keeps an empty one-shot dispatch standing instead of re-planning", async () => {
    const planning = planningRegistry();
    const warn = vi.fn();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      skillResult(invocation, "completed", undefined, 1, {
        blockName: String(inputField(invocation.payload.input, "blockName")),
        targetsFound: 0,
        itemsCollected: 0,
      }),
    );
    const generate = vi.fn(emptyDispatchGenerate());
    const planner = new CoordinatorLocalPlanner({
      ai: { generate },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      logger: { info: vi.fn(), warn, error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    // Non-acquisition goal: the model branch handles it, the dispatch completes
    // with nothing produced, and the result stands as-is — the caller sees
    // "completed with zero production" and re-assesses on its own.
    await expect(
      planner.planAndDispatch({
        ...resourcePlanRequest(),
        operatorGoal: "Equip the best armor already in inventory.",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      reasonCode: "ADVANCE_TASK",
      result: { payload: { outcome: "completed" } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "coordinator_planner_empty_dispatch_replanned",
      {
        traceId: "trace-plan-01",
        taskId: "task-01",
        botId: BOT_ID,
        emptySkillId: "collect.block",
      },
    );
  });

  /**
   * 三个都必须**不**触发重规划。"看不出来"和"说了它什么都没干"不能同一种拼法，
   * 而 `targetsFound` 是观测、不是产出——把它的 0 读成"什么都没干"正好把判据反过来。
   */
  it.each([
    ["no production count at all", { blockName: "oak_log" }],
    ["only a measurement count", { blockName: "oak_log", targetsFound: 0 }],
  ] as const)(
    "keeps a completed dispatch that published %s",
    async (_label, output) => {
      const planning = planningRegistry();
      const sendSkillInvocation = vi.fn<
        SkillInvocationTransport["sendSkillInvocation"]
      >(async (invocation) =>
        skillResult(invocation, "completed", undefined, 1, output),
      );
      const generate = vi.fn(emptyDispatchGenerate());
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
          ...resourcePlanRequest(),
          operatorGoal: "Equip the best armor already in inventory.",
        }),
      ).resolves.toMatchObject({
        action: "skill_result",
        result: { payload: { output } },
      });
      expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
      expect(generate).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps an unsuccessful dispatch instead of re-planning around its error", async () => {
    const planning = planningRegistry();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      skillResult(invocation, "failed", "COLLECT_BLOCKS_FAILED"),
    );
    const generate = vi.fn(emptyDispatchGenerate());
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
        ...resourcePlanRequest(),
        operatorGoal: "Equip the best armor already in inventory.",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { outcome: "failed", errorCode: "COLLECT_BLOCKS_FAILED" } },
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("keeps an empty dispatch standing when the goal is not a single-item acquisition", async () => {
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
    const generate = vi.fn(emptyDispatchGenerate());
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
        ...resourcePlanRequest(),
        operatorGoal: "Equip the best armor already in inventory.",
      }),
    ).resolves.toMatchObject({
      action: "skill_result",
      result: { payload: { output: { itemsCollected: 0 } } },
    });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledTimes(1);
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

  /**
   * 这三个出口都**可能**已经动过世界：处理器跑起来之后才失败/超时/被取消，
   * 适配器有没有落下副作用无从判断。非幂等步骤只能屏蔽成结果不确定。
   *
   * `rejected` 刻意不在这张表里——它是"证明什么都没改动"的断言，见下一条。
   */
  it.each([
    ["failed", "SKILL_CAPABILITY_FAILED", 1],
    ["timed_out", "SKILL_TIMEOUT", 1],
    ["cancelled", "SKILL_CANCELLED", 1],
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

  /**
   * `rejected` 在协议里一直只有一个意思：这次调用被谢绝，世界没被碰过。
   * executor 的八个 rejected 出口全是派发前的前置检查，而 SkillRefusal 让
   * 处理器**内部**也能作出同一个断言（背包只被读过、寻路只搜不走）。
   *
   * 所以屏蔽不能再看 `attempts`：处理器一进去 attempts 就是 1，这个数字分不出
   * "谢绝"和"跑了一半"。以前多加的 `attempts === 0` 一条，把缺工具、目标都到不了
   * 这类**本该自己补齐**的失败一律改判成 CONTRACT_BUG → 人工工单：实测
   * COLLECT_TARGET_UNREACHABLE 被写成 NON_IDEMPOTENT_RESULT_UNCERTAIN，
   * repairStepsInserted=0，第一次失败就放弃整个目标。
   *
   * 这里钉的就是那条改动：真实码必须活着走到恢复阶梯，而且不许重放。
   */
  it("keeps the real code on a rejected non-idempotent result instead of masking it", async () => {
    const planning = planningRegistry();
    const info = vi.fn();
    const warn = vi.fn();
    const sendSkillInvocation = vi.fn<
      SkillInvocationTransport["sendSkillInvocation"]
    >(async (invocation) =>
      invocation.payload.skillId === "collect.block"
        ? // attempts=1：确实派发过一次，谢绝不会把这个事实抹成 0。
          skillResult(invocation, "rejected", "SKILL_INPUT_INVALID", 1)
        : skillResult(invocation, "completed"),
    );
    const planner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (options) =>
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
      },
      registry: { get: () => planning.get(BOT_ID, NOW) },
      transport: { sendSkillInvocation },
      coordinatorInstanceId: "coordinator-01",
      logger: { info, warn, error: vi.fn(), debug: vi.fn() } as never,
      now: () => NOW,
      randomId: uuidSequence(),
    });

    await expect(
      planner.planAndDispatch(resourcePlanRequest()),
    ).rejects.toMatchObject({ code: "PLANNER_GOAL_EXECUTION_FAILED" });

    // 屏蔽没有发生：既没有那条诊断，监督链里也不该出现屏蔽码。
    expect(
      warn.mock.calls.find(
        ([event]) => event === "coordinator_planner_step_failure_masked",
      ),
    ).toBeUndefined();
    const supervision = [...info.mock.calls, ...warn.mock.calls].find(
      ([event]) => event === "coordinator_planner_goal_supervision",
    );
    expect(supervision?.[1]).toMatchObject({
      failureCode: "SKILL_INPUT_INVALID",
    });
    expect(JSON.stringify(supervision?.[1])).not.toContain(
      "NON_IDEMPOTENT_RESULT_UNCERTAIN",
    );
    // 不屏蔽 ≠ 可以重放：谢绝的那一步只许派发一次。
    expect(
      sendSkillInvocation.mock.calls.filter(
        ([invocation]) => invocation.payload.skillId === "collect.block",
      ),
    ).toHaveLength(1);
  });

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
    // 握手余量测试旋钮置 0：本用例把 craft.item 超时钉 10ms 并依赖真定时器，
    // 默认 10s 余量会让等待窗超 vitest 上限（生产语义不受影响——余量只加在
    // 协调器等待窗，executor 本地硬停不变）。
    const previousGrace = process.env.STUDIO_SKILL_DISPATCH_GRACE_MS;
    process.env.STUDIO_SKILL_DISPATCH_GRACE_MS = "0";
    try {
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
    } finally {
      if (previousGrace === undefined) delete process.env.STUDIO_SKILL_DISPATCH_GRACE_MS;
      else process.env.STUDIO_SKILL_DISPATCH_GRACE_MS = previousGrace;
    }
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

  it("registers the colloquial acquisition verbs a live goal actually used", () => {
    // 2026-08-26 实测：一条 live 目标"获得一把木镐"走到 noop/NO_SAFE_SKILL，
    // 根因只是"获得"没登记（同一句换"获取"立刻解析）。下面每一行当时都返回
    // null，全部是这次登记要覆盖的。
    const reachableGraph = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    for (const goal of [
      "获得一把木镐",
      "得到一把木镐",
      "拿到一把木镐",
      "帮我弄一把木镐",
      "搞一把木镐",
      "我要一把木镐",
      "想要一把木镐",
      "需要一把木镐",
      "给我一把木镐",
      "get a wooden pickaxe",
      "I need a wooden pickaxe",
      "I want a wooden pickaxe",
    ]) {
      expect(
        plannedAcquisitionGoalItem(goal, reachableGraph),
        `${goal} should resolve to wooden_pickaxe`,
      ).toBe("wooden_pickaxe");
    }
  });

  it("keeps a Latin verb from matching inside an unrelated word", () => {
    // 拉丁一侧只有前置 \b：get 吃得下 getting，但 forget/target 里的 get 不算。
    // 这一半是收紧，不是放宽——没有它，"别忘了"这类句子会被读成取得请求。
    const reachableGraph = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    expect(
      plannedAcquisitionGoalItem("Determine whether cobblestone is nearby.", reachableGraph),
    ).toBeNull();
    expect(
      plannedAcquisitionGoalItem("Forget the cobblestone for now.", reachableGraph),
    ).toBeNull();
    // 后缀仍要吃得下，否则登记等于没登记。
    expect(
      plannedAcquisitionGoalItem("Getting one crafting_table would help.", reachableGraph),
    ).toBe("crafting_table");
  });

  it("still declines a multi-item goal phrased with a newly registered verb", () => {
    // 放宽的只是"这句话是不是在要东西"。唯一命中那一半必须原样保住，
    // 否则新动词就成了替操作者挑一样东西的入口。
    const reachableGraph = vanillaResourceRecipes.map((recipe) => recipe.itemName);
    expect(
      plannedAcquisitionGoalItem("获得一把木镐和一些圆石", reachableGraph),
    ).toBeNull();
    expect(plannedAcquisitionGoalItem("我要一个熔炉和一把石镐", reachableGraph)).toBeNull();
    // 可达集合也仍然是闸门。
    expect(plannedAcquisitionGoalItem("获得一把木镐", ["furnace"])).toBeNull();
  });
});


function plannerWith(
  generate: (options: any) => Promise<AIScheduledResult<GenerateResult>>,
  transport: SkillInvocationTransport = { sendSkillInvocation: vi.fn() },
  taskStateMachineOrAssignment?:
    | PersistentTaskStateMachine
    | Pick<BotAssignmentService, "acquire" | "release">,
  plannerRegistryOrVerifier:
    | Pick<BotRegistry, "get">
    | CoordinatorLocalPlannerOptions["verifyAssignmentLease"] = registry,
  metrics?: MetricRecorder,
): CoordinatorLocalPlanner {
  const usesLegacyArguments =
    (taskStateMachineOrAssignment !== undefined &&
      !(taskStateMachineOrAssignment instanceof PersistentTaskStateMachine)) ||
    typeof plannerRegistryOrVerifier === "function";
  const taskStateMachine = !usesLegacyArguments &&
      taskStateMachineOrAssignment instanceof PersistentTaskStateMachine
    ? taskStateMachineOrAssignment
    : undefined;
  const assignment = usesLegacyArguments &&
      taskStateMachineOrAssignment !== undefined
    ? taskStateMachineOrAssignment
    : undefined;
  const plannerRegistry = !usesLegacyArguments &&
      typeof plannerRegistryOrVerifier !== "function"
    ? plannerRegistryOrVerifier
    : registry;
  const verifyAssignmentLease = usesLegacyArguments &&
      typeof plannerRegistryOrVerifier === "function"
    ? plannerRegistryOrVerifier
    : undefined;
  return new CoordinatorLocalPlanner({
    ai: { generate },
    registry: plannerRegistry,
    ...(assignment ? { assignment } : {}),
    ...(verifyAssignmentLease ? { verifyAssignmentLease } : {}),
    transport,
    coordinatorInstanceId: "coordinator-01",
    now: () => NOW,
    randomId: uuidSequence(),
    ...(taskStateMachine ? { taskStateMachine } : {}),
    ...(metrics ? { metrics } : {}),
  });
}

function registryWithSkillIdempotence(
  idempotent: boolean,
): Pick<BotRegistry, "get"> {
  const current = registry.get(BOT_ID, NOW)!;
  return {
    get: (botId: string) =>
      botId === BOT_ID
        ? {
            ...current,
            skillCatalog: {
              ...current.skillCatalog!,
              skills: current.skillCatalog!.skills.map((skill) => ({
                ...skill,
                idempotent,
              })),
            },
          }
        : null,
  };
}

function movementDecision(
  requestId: string,
): AIScheduledResult<GenerateResult> {
  return aiResult(
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
    requestId,
  );
}

function completedSkillResult(
  invocation: Parameters<SkillInvocationTransport["sendSkillInvocation"]>[0],
  sequence = 90,
): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: uuid(sequence),
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
  };
}

function unsuccessfulSkillResult(
  invocation: Parameters<SkillInvocationTransport["sendSkillInvocation"]>[0],
  outcome: "failed" | "cancelled",
  errorCode: string,
): SkillExecutionResultV1 {
  const result = {
    schemaVersion: "1.0" as const,
    messageId: uuid(91),
    traceId: invocation.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime" as const, instanceId: RUNTIME_ID },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1" as const,
    payload: {
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      completedAt: NOW.toISOString(),
      attempts: 1,
      errorCode,
    },
  };
  return outcome === "failed"
    ? { ...result, payload: { ...result.payload, outcome: "failed" } }
    : { ...result, payload: { ...result.payload, outcome: "cancelled" } };
}

async function seedPersistedTask(
  taskStateMachine: PersistentTaskStateMachine,
  state: "PLAN" | "EXECUTE" | "RECOVER" | "REPLAN" | "VERIFY",
  options: Readonly<{
    currentStep?: string;
    expectedSkillId?: string;
    expectedSkillVersion?: string;
  }> = {},
): Promise<TaskExecutionRecord> {
  const request = planRequest();
  let task = await taskStateMachine.create({
    taskId: request.taskId,
    botId: request.botId,
    goal: request.operatorGoal,
    worldStateVersion: 0,
    expectedResult: { outcome: "completed" },
  });
  task = await taskStateMachine.transition(task.taskId, "PLAN", {
    expectedRevision: task.revision,
    currentStep: "slow-cognitive-loop",
  });
  if (state === "PLAN") return task;
  if (state === "REPLAN") {
    return taskStateMachine.transition(task.taskId, "REPLAN", {
      expectedRevision: task.revision,
      currentStep: "persisted-replan",
    });
  }
  const currentStep = options.currentStep ?? "movement.goto";
  task = await taskStateMachine.transition(task.taskId, "EXECUTE", {
    expectedRevision: task.revision,
    currentStep,
    expectedResult: {
      outcome: "completed",
      skillId: options.expectedSkillId ?? currentStep,
      skillVersion: options.expectedSkillVersion ?? "1.0.0",
    },
  });
  if (state === "EXECUTE") return task;
  if (state === "VERIFY") {
    return taskStateMachine.transition(task.taskId, "VERIFY", {
      expectedRevision: task.revision,
      currentStep: "persisted-verify",
      actualResult: { outcome: "completed" },
    });
  }
  return taskStateMachine.transition(task.taskId, "RECOVER", {
    expectedRevision: task.revision,
    currentStep: "persisted-recover",
    failureReason: "PERSISTED_INTERRUPTION",
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

/**
 * 第一遍给 `collect.block` 直投,重问那遍给 plan_items —— 线上那次失败的形状。
 * 直投的是 `oak_log`:目标里确实提到它(via 木头/原木 别名之外的英文拼写),
 * 而重问只可能落到协调器自己挑的那个物品上。
 */
function emptyDispatchGenerate(): (
  options: any,
) => Promise<AIScheduledResult<GenerateResult>> {
  return async (options) =>
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
              action: "invoke_skill",
              botId: BOT_ID,
              taskId: "task-01",
              skillId: "collect.block",
              skillVersion: "1.0.0",
              input: {
                blockName: "oak_log",
                maxCount: 4,
                maxDistance: 64,
                dimension: "minecraft:overworld",
                serverProfileId: "$CURRENT_SERVER_PROFILE",
              },
              reasonCode: "ADVANCE_TASK",
            },
      ),
      options.requestId,
    );
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
        idempotent: true,
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
            maxCount: { type: "integer", minimum: 1, maximum: 64 },
            maxDistance: { type: "integer", minimum: 2, maximum: 64 },
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

function catalogEntry(
  skillId: string,
  inputSchema: Record<string, unknown>,
  idempotent = false,
) {
  return {
    skillId,
    skillVersion: "1.0.0",
    availability: "available" as const,
    verification: "unverified" as const,
    inputSchema,
    timeoutMs: 20_000,
    idempotent,
    selectedVariantId: "portable",
    unavailableReasons: [],
  };
}

/**
 * The planning catalog plus the two placement Skills, advertised with the same
 * bounds the Runtime really advertises (`world.scan` maxCount 1..16, maxDistance
 * 2..64; `world.place-block` face components ∈ {-1,0,1}). Advertising looser
 * bounds here would let a test pass on an input the live Runtime rejects.
 */
function placementRegistry(): BotRegistry {
  const planning = planningRegistry();
  const now = NOW.toISOString();
  const existing = planning.get(BOT_ID, NOW)!.skillCatalog!.skills;
  planning.ingest({
    schemaVersion: "1.0",
    messageId: uuid(4),
    traceId: "trace-registry",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: 4,
      observedAt: now,
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [
        ...existing,
        catalogEntry(
          "world.scan",
          {
            type: "object",
            properties: {
              blockName: { type: "string", minLength: 1, maxLength: 64 },
              maxCount: { type: "integer", minimum: 1, maximum: 16 },
              maxDistance: { type: "integer", minimum: 2, maximum: 64 },
              dimension: { type: "string", minLength: 3, maxLength: 128 },
              serverProfileId: { type: "string", minLength: 1, maxLength: 128 },
            },
            required: [
              "blockName",
              "maxCount",
              "maxDistance",
              "dimension",
              "serverProfileId",
            ],
            additionalProperties: false,
          },
          true,
        ),
        catalogEntry("world.place-block", {
          type: "object",
          properties: {
            itemName: { type: "string", minLength: 1, maxLength: 64 },
            referenceBlock: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
                y: { type: "integer", minimum: -2_048, maximum: 2_048 },
                z: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
            face: {
              type: "object",
              properties: {
                x: { enum: [-1, 0, 1] },
                y: { enum: [-1, 0, 1] },
                z: { enum: [-1, 0, 1] },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
            dimension: { type: "string", minLength: 3, maxLength: 128 },
            serverProfileId: { type: "string", minLength: 1, maxLength: 128 },
          },
          required: [
            "itemName",
            "referenceBlock",
            "face",
            "dimension",
            "serverProfileId",
          ],
          additionalProperties: false,
        }),
      ],
    },
  }, NOW);
  return planning;
}

/** The planning catalog plus the observed placement skills and smelt.item. */
function smeltingRegistry(): BotRegistry {
  const planning = placementRegistry();
  const now = NOW.toISOString();
  const existing = planning.get(BOT_ID, NOW)!.skillCatalog!.skills;
  planning.ingest({
    schemaVersion: "1.0",
    messageId: uuid(5),
    traceId: "trace-registry",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: 5,
      observedAt: now,
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [
        ...existing,
        catalogEntry("smelt.item", {
          type: "object",
          properties: {
            inputItemName: { type: "string", minLength: 1, maxLength: 64 },
            fuelItemName: { type: "string", minLength: 1, maxLength: 64 },
            fuelCount: { type: "integer", minimum: 1, maximum: 5 },
            count: { type: "integer", minimum: 1, maximum: 5 },
            furnace: {
              type: "object",
              properties: {
                x: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
                y: { type: "integer", minimum: -2_048, maximum: 2_048 },
                z: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
              },
              required: ["x", "y", "z"],
              additionalProperties: false,
            },
            dimension: { type: "string", minLength: 3, maxLength: 128 },
            serverProfileId: { type: "string", minLength: 1, maxLength: 128 },
          },
          required: [
            "inputItemName",
            "fuelItemName",
            "fuelCount",
            "count",
            "furnace",
            "dimension",
            "serverProfileId",
          ],
          additionalProperties: false,
        }),
      ],
    },
  }, NOW);
  return planning;
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
      craftedCount: requestedCount * craftYield(itemName),
      usedCraftingTable:
        inputField(invocation.payload.input, "craftingTable") !== null,
    };
  }
  if (invocation.payload.skillId === "smelt.item") {
    const inputItemName = String(
      inputField(invocation.payload.input, "inputItemName"),
    );
    const fuelItemName = String(
      inputField(invocation.payload.input, "fuelItemName"),
    );
    const requestedCount = Number(
      inputField(invocation.payload.input, "count"),
    );
    const fuelCount = Number(
      inputField(invocation.payload.input, "fuelCount"),
    );
    return {
      inputItemName,
      fuelItemName,
      outputItemName: "iron_ingot",
      requestedCount,
      insertedFuelCount: fuelCount,
      smeltedCount: requestedCount,
    };
  }
  if (invocation.payload.skillId === "world.scan") {
    const blockName = inputField(invocation.payload.input, "blockName");
    return scanOutput(
      invocation,
      blockName === "air"
        ? [
            { ...TOO_CLOSE_MATCH, y: TOO_CLOSE_MATCH.y + 1 },
            { ...IN_WINDOW_MATCH, y: IN_WINDOW_MATCH.y + 1 },
          ]
        : [TOO_CLOSE_MATCH, IN_WINDOW_MATCH],
    );
  }
  if (invocation.payload.skillId === "world.place-block") {
    return placeBlockOutput(invocation);
  }
  return {};
}

/**
 * One craft run's output count, taken from the same recipe table the planner
 * derives `producedCount` from. A flat "one run makes one item" fixture is not a
 * simplification but a wrong Runtime: a `stick` run really yields 4, and a
 * fixture that reports 1 makes the supervisor fail a step the world satisfied.
 */
function craftYield(itemName: string): number {
  const recipe = vanillaResourceRecipes.find(
    (candidate) => candidate.itemName === itemName,
  );
  return recipe?.yield ?? 1;
}

/**
 * A scanned block under the bot's own feet. Building on it would place the
 * station inside the bot, so the coordinator must skip it even though the scan
 * legitimately reports it.
 */
const TOO_CLOSE_MATCH = Object.freeze({
  x: 1_234,
  y: 63,
  z: -4_321,
  distance: 1,
});
/** A solid block inside the placement window. */
const IN_WINDOW_MATCH = Object.freeze({
  x: 1_236,
  y: 63,
  z: -4_321,
  distance: 3,
});

function scanOutput(
  invocation: Parameters<typeof skillResult>[0],
  matches: readonly Readonly<{
    x: number;
    y: number;
    z: number;
    distance: number;
  }>[],
): SkillJsonValue {
  return {
    blockName: String(inputField(invocation.payload.input, "blockName")),
    dimension: String(inputField(invocation.payload.input, "dimension")),
    matches: matches.map((match) => ({ ...match })),
    targetsFound: matches.length,
    complete: true,
  };
}

/**
 * The Runtime's read-back after a placement: reference + face, which is where
 * the block physically lands. A test that wants to prove the coordinator uses
 * this field rather than its own arithmetic overrides it.
 */
function placeBlockOutput(
  invocation: Parameters<typeof skillResult>[0],
): SkillJsonValue {
  const reference = inputField(invocation.payload.input, "referenceBlock") as
    | Record<string, number>
    | undefined;
  const face = inputField(invocation.payload.input, "face") as
    | Record<string, number>
    | undefined;
  return {
    placed: true,
    placedBlockName: String(inputField(invocation.payload.input, "itemName")),
    position: {
      x: (reference?.x ?? 0) + (face?.x ?? 0),
      y: (reference?.y ?? 0) + (face?.y ?? 0),
      z: (reference?.z ?? 0) + (face?.z ?? 0),
    },
  };
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

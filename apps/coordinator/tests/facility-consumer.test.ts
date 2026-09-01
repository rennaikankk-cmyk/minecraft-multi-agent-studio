import { describe, expect, it, vi } from "vitest";

import {
  InMemoryWorkstationRegistry,
  type SkillExecutionResultV1,
  type SkillJsonValue,
} from "@minecraft-studio/skills";
import type {
  AIScheduledResult,
  GenerateResult,
} from "@minecraft-studio/ai-router";

import { BotRegistry } from "../src/bot-registry.js";
import { CoordinatorLocalPlanner } from "../src/local-planner.js";
import type { LocalPlanRequest } from "../src/local-planner.js";
import type { SkillInvocationTransport } from "../src/runtime-link-server.js";

// ---------------------------------------------------------------------------
// Round 6.2 真实 Facility 消费方：共享熔炉租约（smelt 直派）+ scan 注册
// 自含 fixtures（与 local-planner.test.ts 同形状，避免跨测试文件导出）。
// ---------------------------------------------------------------------------

const NOW = new Date("2026-08-21T12:00:00.000Z");
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-01";

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}
function uuidSequence(): () => string {
  let value = 100;
  return () => uuid(value++);
}

function aiResult(content: string, requestId: string): AIScheduledResult<GenerateResult> {
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

function baseRegistry(): BotRegistry {
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
  registry.ingest(
    {
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
    },
    NOW,
  );
  registry.ingest(
    {
      ...envelope(2, "bot.skill-catalog.v1"),
      payload: {
        serverProfileId: "isolated-test",
        runtimeInstanceId: RUNTIME_ID,
        sequence: 2,
        observedAt: NOW.toISOString(),
        minecraftVersion: "1.21.11",
        protocolVersion: 774,
        skills: [
          catalogEntry("movement.goto", {
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
          }, true),
          catalogEntry("smelt.item", {
            type: "object",
            properties: {
              inputItemName: { type: "string", minLength: 1, maxLength: 64 },
              fuelItemName: { type: "string", minLength: 1, maxLength: 64 },
              fuelCount: { type: "integer", minimum: 1, maximum: 5 },
              count: { type: "integer", minimum: 1, maximum: 5 },
              furnace: {
                anyOf: [
                  {
                    type: "object",
                    properties: {
                      x: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
                      y: { type: "integer", minimum: -2_048, maximum: 2_048 },
                      z: { type: "integer", minimum: -30_000_000, maximum: 30_000_000 },
                    },
                    required: ["x", "y", "z"],
                    additionalProperties: false,
                  },
                  { type: "null" },
                ],
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
          catalogEntry("world.scan", {
            type: "object",
            properties: {
              blockName: { type: "string", minLength: 1, maxLength: 64 },
              maxCount: { type: "integer", minimum: 1, maximum: 16 },
              maxDistance: { type: "integer", minimum: 2, maximum: 64 },
              dimension: { type: "string", minLength: 3, maxLength: 128 },
              serverProfileId: { type: "string", minLength: 1, maxLength: 128 },
            },
            required: ["blockName", "maxCount", "maxDistance", "dimension", "serverProfileId"],
            additionalProperties: false,
          }, true),
        ],
      },
    },
    NOW,
  );
  return registry;
}

function skillResult(
  invocation: {
    traceId: string;
    botId: string;
    taskId: string;
    payload: { invocationId: string; skillId: string; skillVersion: string };
  },
  output: SkillJsonValue,
): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: uuid(500),
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
      output,
    },
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

function smeltDecision(furnace: unknown): AIScheduledResult<GenerateResult> {
  return aiResult(
    JSON.stringify({
      action: "invoke_skill",
      botId: BOT_ID,
      taskId: "task-01",
      skillId: "smelt.item",
      skillVersion: "1.0.0",
      input: {
        inputItemName: "raw_iron",
        fuelItemName: "oak_planks",
        fuelCount: 1,
        count: 1,
        furnace,
        dimension: "minecraft:overworld",
        serverProfileId: "$CURRENT_SERVER_PROFILE",
      },
      reasonCode: "ADVANCE_TASK",
    }),
    "req-smelt",
  );
}

function facilityPlanner(
  generate: (options: any) => Promise<AIScheduledResult<GenerateResult>>,
  workstationRegistry: InMemoryWorkstationRegistry,
  sendSkillInvocation: SkillInvocationTransport["sendSkillInvocation"],
): CoordinatorLocalPlanner {
  return new CoordinatorLocalPlanner({
    ai: { generate },
    registry: baseRegistry(),
    workstationRegistry,
    transport: { sendSkillInvocation },
    coordinatorInstanceId: "coordinator-01",
    now: () => NOW,
    randomId: uuidSequence(),
  });
}

describe("Round 6.2 facility consumer (shared furnace lease)", () => {
  it("fills furnace from a shared-registry lease and releases it after dispatch", async () => {
    const workstationRegistry = new InMemoryWorkstationRegistry();
    workstationRegistry.register("isolated-test", "minecraft:overworld", "furnace", {
      x: 1235,
      y: 64,
      z: -4320,
    });
    const generate = vi.fn(async () => smeltDecision(null));
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(
      async (invocation) => skillResult(invocation, {}),
    );
    const planner = facilityPlanner(generate, workstationRegistry, sendSkillInvocation);

    const result = await planner.planAndDispatch({
      ...planRequest(),
      requestId: "req-smelt",
      operatorGoal: "Use the shared furnace to smelt the raw iron.",
    });
    expect(result).toMatchObject({ action: "skill_result" });

    const invocation = sendSkillInvocation.mock.calls[0]![0];
    expect(invocation.payload.input).toMatchObject({
      furnace: { x: 1235, y: 64, z: -4320 },
      serverProfileId: "isolated-test",
    });
    const entry = workstationRegistry.get("isolated-test", "minecraft:overworld", {
      x: 1235,
      y: 64,
      z: -4320,
    });
    expect(entry).not.toBeNull();
    expect(entry?.lease).toBeNull();
  });

  it("leaves furnace null when the registry has no furnace (runtime places its own)", async () => {
    const workstationRegistry = new InMemoryWorkstationRegistry();
    const generate = vi.fn(async () => smeltDecision(null));
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(
      async (invocation) => skillResult(invocation, {}),
    );
    const planner = facilityPlanner(generate, workstationRegistry, sendSkillInvocation);

    await planner.planAndDispatch({
      ...planRequest(),
      requestId: "req-smelt",
      operatorGoal: "Use the shared furnace to smelt the raw iron.",
    });
    const invocation = sendSkillInvocation.mock.calls[0]![0];
    expect((invocation.payload.input as { furnace: unknown }).furnace).toBeNull();
  });

  it("leaves furnace null when the shared furnace is busy (contention is not an error)", async () => {
    const workstationRegistry = new InMemoryWorkstationRegistry();
    workstationRegistry.register("isolated-test", "minecraft:overworld", "furnace", {
      x: 1235,
      y: 64,
      z: -4320,
    });
    expect(
      workstationRegistry.claim(
        "isolated-test",
        "minecraft:overworld",
        { x: 1235, y: 64, z: -4320 },
        "bot-other",
        60_000,
      ),
    ).toBe(true);
    const generate = vi.fn(async () => smeltDecision(null));
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(
      async (invocation) => skillResult(invocation, {}),
    );
    const planner = facilityPlanner(generate, workstationRegistry, sendSkillInvocation);

    await planner.planAndDispatch({
      ...planRequest(),
      requestId: "req-smelt",
      operatorGoal: "Use the shared furnace to smelt the raw iron.",
    });
    const invocation = sendSkillInvocation.mock.calls[0]![0];
    expect((invocation.payload.input as { furnace: unknown }).furnace).toBeNull();
  });

  it("registers furnace positions from a completed world.scan", async () => {
    const workstationRegistry = new InMemoryWorkstationRegistry();
    const generate = vi.fn(async () =>
      aiResult(
        JSON.stringify({
          action: "invoke_skill",
          botId: BOT_ID,
          taskId: "task-01",
          skillId: "world.scan",
          skillVersion: "1.0.0",
          input: {
            blockName: "furnace",
            maxCount: 4,
            maxDistance: 32,
            dimension: "minecraft:overworld",
            serverProfileId: "$CURRENT_SERVER_PROFILE",
          },
          reasonCode: "ADVANCE_TASK",
        }),
        "req-scan",
      ),
    );
    const sendSkillInvocation = vi.fn<SkillInvocationTransport["sendSkillInvocation"]>(
      async (invocation) =>
        skillResult(invocation, {
          blockName: "furnace",
          dimension: "minecraft:overworld",
          complete: true,
          matches: [
            { x: 1236, y: 64, z: -4320, distance: 2.2 },
            { x: 1238, y: 64, z: -4318, distance: 5.1 },
          ],
          totalFound: 2,
        }),
    );
    const planner = facilityPlanner(generate, workstationRegistry, sendSkillInvocation);

    await planner.planAndDispatch({
      ...planRequest(),
      requestId: "req-scan",
      operatorGoal: "Look around for usable stations nearby.",
    });
    expect(
      workstationRegistry.get("isolated-test", "minecraft:overworld", {
        x: 1236,
        y: 64,
        z: -4320,
      }),
    ).not.toBeNull();
    expect(
      workstationRegistry.get("isolated-test", "minecraft:overworld", {
        x: 1238,
        y: 64,
        z: -4318,
      }),
    ).not.toBeNull();
  });
});

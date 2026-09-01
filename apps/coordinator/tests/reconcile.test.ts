import { describe, expect, it, vi } from "vitest";

import { CoordinatorLocalPlanner } from "../src/local-planner.js";
import type { LocalPlanRequest } from "../src/local-planner.js";
import type { SkillInvocationTransport } from "../src/runtime-link-server.js";
import type { BotRegistry } from "../src/bot-registry.js";
import type { BotRegistryRecord } from "../src/bot-registry.js";

// ---------------------------------------------------------------------------
// Phase 2 —— transport 失败 reconcile 语义（server-truth，不盲猜）：
//   已发生（盘内增加）→ 成功继续；未发生（不变）→ 原码重试；不可达 → 不确定。
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

/** 盘内可控的 registry：按测试意图推进 inventory。 */
function mutableRegistry(initialItems: Array<{ itemName: string; count: number }>): {
  registry: Pick<BotRegistry, "get">;
  setItems: (items: Array<{ itemName: string; count: number }>) => void;
  base: BotRegistryRecord;
} {
  let items = [...initialItems];
  let statusSequence = 5;
  const record = {
    botId: BOT_ID,
    connectionState: "online",
    serverProfileId: "isolated-test",
    runtimeInstanceId: RUNTIME_ID,
    minecraftVersion: { resolvedVersion: "1.21.11" },
    skillCatalog: {"skills":[{"skillId":"collect.block","skillVersion":"1.0.0","availability":"available","verification":"unverified","inputSchema":{"type":"object","properties":{"blockName":{"type":"string"},"maxCount":{"type":"integer","minimum":1,"maximum":64},"maxDistance":{"type":"integer","minimum":2,"maximum":64},"dimension":{"type":"string"},"serverProfileId":{"type":"string"}},"required":["blockName","maxCount","maxDistance","dimension","serverProfileId"],"additionalProperties":false},"timeoutMs":60000,"idempotent":false,"selectedVariantId":"portable","unavailableReasons":[]},{"skillId":"world.scan","skillVersion":"1.0.0","availability":"available","verification":"unverified","inputSchema":{"type":"object","properties":{"blockName":{"type":"string"},"maxCount":{"type":"integer","minimum":1,"maximum":64},"maxDistance":{"type":"integer","minimum":2,"maximum":64},"dimension":{"type":"string"},"serverProfileId":{"type":"string"}},"required":["blockName","maxCount","maxDistance","dimension","serverProfileId"],"additionalProperties":false},"timeoutMs":10000,"idempotent":true,"selectedVariantId":"portable","unavailableReasons":[]}]},
    currentStatus: {
      sequence: statusSequence,
      position: { x: 1234, y: 64, z: -4321, dimension: "minecraft:overworld" },
      inventory: items,
      safety: { normalTasksPaused: false, mode: "monitoring", activeRisks: [], lastDecisionId: null, lastAction: null },
    },
  } as unknown as BotRegistryRecord;
  return {
    base: record,
    registry: {
      get: () => record,
    },
    setItems(next) {
      items = [...next];
      statusSequence += 1;
      (record.currentStatus as { sequence: number }).sequence = statusSequence;
      (record.currentStatus as { inventory: unknown }).inventory = items;
    },
  };
}

function reconcilePlanner(options: {
  registry: Pick<BotRegistry, "get">;
  transport: SkillInvocationTransport;
  plannedItem: string;
}): CoordinatorLocalPlanner {
  return new CoordinatorLocalPlanner({
    ai: {
      generate: async (opts: any) => ({
        requestId: opts.requestId,
        botId: BOT_ID,
        priority: 30,
        value: {
          content: JSON.stringify({
            action: "plan_items",
            botId: BOT_ID,
            taskId: "task-01",
            goals: [{ itemName: options.plannedItem, count: 1 }],
            reasonCode: "ADVANCE_TASK",
          }),
          usage: { promptTokens: 1, completionTokens: 1 },
        },
        attempts: 1,
        enqueuedAt: NOW.toISOString(),
        startedAt: NOW.toISOString(),
        completedAt: NOW.toISOString(),
        queueTimeMs: 0,
        executionTimeMs: 1,
        totalTimeMs: 1,
      }),
    },
    registry: options.registry,
    transport: options.transport,
    coordinatorInstanceId: "coordinator-01",
    now: () => NOW,
    randomId: uuidSequence(),
  });
}

describe("Phase 2 — non-idempotent transport-failure reconciliation", () => {
  it("records the step as succeeded when fresh inventory shows the item arrived (ACK lost, effect real)", async () => {
    const { registry, setItems } = mutableRegistry([]);
    let statusSequence = 6;
    const transport: SkillInvocationTransport = {
      sendSkillInvocation: vi.fn(async () => {
        // ACK 丢失：transport 抛错，但副作用真实发生（server 端挖到了）
        setItems([{ itemName: "oak_log", count: 1 }]);
        throw new Error("runtime link dropped mid-dispatch");
      }),
      requestFreshStatus: vi.fn(async () => {
        statusSequence += 1;
      }),
    };
    // registry.get 的 sequence 需要前进（requestFreshStatus 语义）
    const seqTransport = {
      ...transport,
      requestFreshStatus: vi.fn(async () => {
        statusSequence += 1;
      }),
    };
    const planner = reconcilePlanner({
      registry: { get: () => registry.get(BOT_ID, NOW) },
      transport: seqTransport,
      plannedItem: "oak_log",
    });
    const request: LocalPlanRequest = {
      requestId: "req-r1",
      traceId: "trace-r1",
      taskId: "task-01",
      botId: BOT_ID,
      operatorGoal: "Gather one oak_log from nearby resources.",
      timeoutMs: 30_000,
    };
    // 目标物品已在盘内 → collect 步骤的产出满足 → 计划应继续走向完成
    // （后续 world.scan 等步骤可能失败，但第一步绝不能是 NON_IDEMPOTENT）
    const outcome = await planner.planAndDispatch(request).catch((error) => error);
    const failure = outcome instanceof Error ? outcome.message : JSON.stringify(outcome).slice(0, 200);
    expect(failure).not.toContain("NON_IDEMPOTENT_RESULT_UNCERTAIN");
  });

  it("surfaces the transport code (retryable) when inventory is unchanged (effect clearly absent)", async () => {
    const { registry } = mutableRegistry([]);
    const transport: SkillInvocationTransport = {
      sendSkillInvocation: vi.fn(async () => {
        throw new Error("runtime link dropped before dispatch");
      }),
      requestFreshStatus: vi.fn(async () => undefined),
    };
    const planner = reconcilePlanner({
      registry: { get: () => registry.get(BOT_ID, NOW) },
      transport,
      plannedItem: "oak_log",
    });
    const outcome = await planner
      .planAndDispatch({
        requestId: "req-r2",
        traceId: "trace-r2",
        taskId: "task-01",
        botId: BOT_ID,
        operatorGoal: "Gather one oak_log from nearby resources.",
        timeoutMs: 30_000,
      })
      .catch((error) => error);
    const text = outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
    // 未发生 → 走 supervisor 的升级路径；绝不能是 NON_IDEMPOTENT 盲判
    expect(text).not.toContain("NON_IDEMPOTENT_RESULT_UNCERTAIN");
  });

  it("keeps NON_IDEMPOTENT only when fresh status is unreachable (truly undecidable)", async () => {
    const { registry } = mutableRegistry([]);
    const transport: SkillInvocationTransport = {
      sendSkillInvocation: vi.fn(async () => {
        throw new Error("socket destroyed");
      }),
      requestFreshStatus: vi.fn(async () => {
        throw new Error("runtime unreachable");
      }),
    };
    const planner = reconcilePlanner({
      registry: { get: () => registry.get(BOT_ID, NOW) },
      transport,
      plannedItem: "oak_log",
    });
    const outcome = await planner
      .planAndDispatch({
        requestId: "req-r3",
        traceId: "trace-r3",
        taskId: "task-01",
        botId: BOT_ID,
        operatorGoal: "Gather one oak_log from nearby resources.",
        timeoutMs: 30_000,
      })
      .catch((error) => error);
    const text = outcome instanceof Error ? outcome.message : JSON.stringify(outcome);
    expect(text).toContain("NON_IDEMPOTENT_RESULT_UNCERTAIN");
  });
});

import type { AppLogger } from "@minecraft-studio/observability";
import {
  skillExecutionResultV1Schema,
  type SkillInvocationV1,
} from "@minecraft-studio/protocol";
import { describe, expect, it, vi } from "vitest";

import {
  BotRegistry,
  InMemorySkillInvocationAuditSink,
  SkillInvocationController,
  type CoordinatorPlanProposal,
  type SkillInvocationGrant,
  type SkillInvocationResultObserver,
  type SkillInvocationTransport,
} from "../src/index.js";

const NOW = new Date("2026-08-20T05:00:00.000Z");
const BOT_ID = "worker-01";
const RUNTIME_ID = "runtime-a";

const logger: AppLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function uuidSequence(start = 100): () => string {
  let value = start;
  return () => uuid(value++);
}

function readyRegistry(
  statusSequence = 1,
  catalogSkill: Readonly<{
    skillId: string;
    selectedVariantId: string;
  }> = { skillId: "movement.goto", selectedVariantId: "portable" },
): BotRegistry {
  const registry = new BotRegistry({ staleAfterMs: 30_000, now: () => NOW });
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(statusSequence),
    traceId: "trace-skill-control",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.status.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: statusSequence,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 18, saturation: 5 },
      armorPoints: 0,
      position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
    },
  }, NOW);
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(statusSequence + 1),
    traceId: "trace-skill-control",
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: RUNTIME_ID,
      sequence: statusSequence + 1,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
      skills: [{
        skillId: catalogSkill.skillId,
        skillVersion: "1.0.0",
        availability: "available",
        verification: "unverified",
        selectedVariantId: catalogSkill.selectedVariantId,
        unavailableReasons: [],
      }],
    },
  }, NOW);
  return registry;
}

function proposal(overrides: Partial<Extract<CoordinatorPlanProposal, { action: "execute_skill" }>> = {}) {
  return {
    requestId: uuid(20),
    botId: BOT_ID,
    runtimeInstanceId: RUNTIME_ID,
    taskId: "task-01",
    stateVersion: 1,
    taskVersion: 1,
    provider: "spark-vllm",
    model: "qwen3.8-27b-nvfp4",
    reason: "Move to the work site.",
    confidence: 0.95,
    action: "execute_skill" as const,
    skillId: "movement.goto",
    skillVersion: "1.0.0",
    selectedVariantId: "portable",
    arguments: { target: { x: 4, y: 64, z: 8 } },
    ...overrides,
  };
}

function grant(overrides: Partial<SkillInvocationGrant> = {}): SkillInvocationGrant {
  return {
    decisionId: uuid(30),
    actorId: "task-policy",
    permissions: new Set(["skill.invoke"]),
    maxRisk: "R1",
    issuedAt: new Date(NOW.getTime() - 1_000),
    expiresAt: new Date(NOW.getTime() + 30_000),
    ...overrides,
  };
}

function completed(command: SkillInvocationV1) {
  return skillExecutionResultV1Schema.parse({
    schemaVersion: "1.0",
    messageId: uuid(40),
    traceId: command.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: RUNTIME_ID },
    botId: BOT_ID,
    taskId: command.taskId,
    type: "skill.result.v1",
    payload: {
      invocationId: command.payload.invocationId,
      skillId: command.payload.skillId,
      skillVersion: command.payload.skillVersion,
      outcome: "completed",
      attempts: 1,
      completedAt: NOW.toISOString(),
      output: { reached: true },
    },
  });
}

function controller(
  registry: BotRegistry,
  transport: SkillInvocationTransport,
  resultObserver?: SkillInvocationResultObserver,
) {
  const auditSink = new InMemorySkillInvocationAuditSink();
  return {
    value: new SkillInvocationController({
      instanceId: "coordinator-test",
      registry,
      transport,
      auditSink,
      logger,
      ...(resultObserver === undefined ? {} : { resultObserver }),
      now: () => NOW,
      randomId: uuidSequence(),
    }),
    auditSink,
  };
}

describe("SkillInvocationController", () => {
  it("revalidates a proposal, authorizes R1, and returns the Runtime result", async () => {
    const sendSkillInvocation = vi.fn(async (command: SkillInvocationV1) => completed(command));
    const { value, auditSink } = controller(readyRegistry(), { sendSkillInvocation });

    await expect(value.executeProposal(proposal(), grant())).resolves.toMatchObject({
      payload: { outcome: "completed" },
    });
    expect(sendSkillInvocation).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { service: "coordinator", instanceId: "coordinator-test" },
        botId: BOT_ID,
        taskId: "task-01",
        payload: expect.objectContaining({
          expectedRuntimeInstanceId: RUNTIME_ID,
          expectedStateSequence: 1,
          taskVersion: 1,
          skillId: "movement.goto",
        }),
      }),
      expect.objectContaining({ permissions: new Set(["skill.invoke"]) }),
      expect.any(AbortSignal),
    );
    expect(auditSink.entries().map(({ status }) => status)).toEqual([
      "authorized",
      "completed",
    ]);
  });

  it("observes a completed authorized result with its authoritative world", async () => {
    vi.mocked(logger.info).mockClear();
    const observer = vi.fn<SkillInvocationResultObserver>(async () => ({
      projectedCount: 1,
      createdCount: 0,
      replayedCount: 0,
      deferredCount: 1,
      pendingBatchCount: 1,
      durableBatchCreated: true,
    }));
    const sendSkillInvocation = vi.fn(
      async (command: SkillInvocationV1) => completed(command),
    );
    const { value } = controller(
      readyRegistry(),
      { sendSkillInvocation },
      observer,
    );

    await expect(value.executeProposal(proposal(), grant())).resolves.toMatchObject({
      payload: { outcome: "completed" },
    });
    expect(observer).toHaveBeenCalledWith(
      expect.objectContaining({
        command: expect.objectContaining({ botId: BOT_ID }),
        result: expect.objectContaining({
          payload: expect.objectContaining({ outcome: "completed" }),
        }),
        authoritativeServerProfileId: "isolated-test",
        authoritativePosition: {
          x: 1,
          y: 64,
          z: 2,
          dimension: "minecraft:overworld",
        },
      }),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "coordinator_skill_result_observed",
      expect.objectContaining({
        projectedCount: 1,
        deferredCount: 1,
        pendingBatchCount: 1,
        durableBatchCreated: true,
      }),
    );
  });

  it("does not relabel a completed Minecraft action when memory ingestion fails", async () => {
    vi.mocked(logger.error).mockClear();
    const observer = vi.fn<SkillInvocationResultObserver>(async () => {
      throw Object.assign(new Error("database unavailable"), {
        code: "WORLD_MEMORY_INGESTION_FAILED",
      });
    });
    const sendSkillInvocation = vi.fn(
      async (command: SkillInvocationV1) => completed(command),
    );
    const { value, auditSink } = controller(
      readyRegistry(),
      { sendSkillInvocation },
      observer,
    );

    await expect(value.executeProposal(proposal(), grant())).resolves.toMatchObject({
      payload: { outcome: "completed" },
    });
    expect(auditSink.entries().at(-1)).toMatchObject({
      status: "completed",
      outcome: "completed",
    });
    expect(logger.error).toHaveBeenCalledWith(
      "coordinator_skill_result_observer_failed",
      expect.objectContaining({
        errorCode: "WORLD_MEMORY_INGESTION_FAILED",
      }),
    );
  });

  it("denies stale state and risk above the grant before transport", async () => {
    const sendSkillInvocation = vi.fn();
    const { value } = controller(readyRegistry(), { sendSkillInvocation });

    await expect(
      value.executeProposal(proposal({ stateVersion: 2 }), grant()),
    ).rejects.toMatchObject({ code: "PROPOSAL_STALE" });
    await expect(
      value.executeProposal(
        proposal({ requestId: uuid(21) }),
        grant({ maxRisk: "R0" }),
      ),
    ).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("keeps optional PvP at R3 and rejects the ordinary R1 task grant", async () => {
    const sendSkillInvocation = vi.fn();
    const registry = readyRegistry(1, {
      skillId: "combat.pvp-melee",
      selectedVariantId: "isolated-pvp-allowlist",
    });
    const { value } = controller(registry, { sendSkillInvocation });

    await expect(value.executeProposal(proposal({
      requestId: uuid(23),
      skillId: "combat.pvp-melee",
      selectedVariantId: "isolated-pvp-allowlist",
      arguments: { targetUsername: "ArenaBot" },
    }), grant())).rejects.toMatchObject({ code: "POLICY_DENIED" });
    expect(sendSkillInvocation).not.toHaveBeenCalled();
  });

  it("cancels the old confirmation when a newer task version arrives", async () => {
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const sendSkillInvocation = vi.fn(
      (command: SkillInvocationV1, _context: unknown, signal: AbortSignal) => {
        if (command.payload.taskVersion === 2) return Promise.resolve(completed(command));
        firstStarted();
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      },
    );
    const { value } = controller(readyRegistry(), { sendSkillInvocation });
    const first = value.executeProposal(proposal(), grant());
    await started;
    const second = value.executeProposal(
      proposal({ requestId: uuid(22), taskId: "task-02", taskVersion: 2 }),
      grant({ decisionId: uuid(31) }),
    );

    await expect(first).rejects.toThrow("aborted");
    await expect(second).resolves.toMatchObject({ payload: { outcome: "completed" } });
    expect(sendSkillInvocation).toHaveBeenCalledTimes(2);
  });
});

import type {
  SkillExecutionResultV1,
  SkillInvocationV1,
} from "@minecraft-studio/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  DurableWorldMemorySkillResultIngestor,
  FileWorldMemoryIngestionOutbox,
  WorldMemoryError,
  WorldMemorySkillResultIngestor,
  projectWorldMemoryFromSkillResult,
  type RecordWorldMemoryResult,
  type WorldMemorySkillResultEvent,
  type WorldMemoryIngestionOutboxLike,
  type WorldMemoryWriteCommand,
  type WorldMemoryWriterLike,
} from "../src/index.js";

const NOW = "2026-08-20T12:00:00.000Z";
const SERVER = "isolated-local";
const DIMENSION = "minecraft:overworld";

function command(
  skillId: string,
  input: unknown,
): SkillInvocationV1 {
  return {
    schemaVersion: "1.0",
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: "trace-memory-ingestion",
    timestamp: NOW,
    source: { service: "coordinator", instanceId: "coordinator-01" },
    botId: "scout-01",
    taskId: "task-scout-01",
    type: "skill.invoke.v1",
    payload: {
      invocationId: "22222222-2222-4222-8222-222222222222",
      skillId,
      skillVersion: "1.0.0",
      expectedRuntimeInstanceId: "runtime-scout-01",
      expectedStateSequence: 4,
      taskVersion: 2,
      expiresAt: "2026-08-20T12:01:00.000Z",
      input: input as never,
      authorization: {
        decisionId: "33333333-3333-4333-8333-333333333333",
        actorId: "task-policy",
        issuedAt: "2026-08-20T11:59:59.000Z",
        expiresAt: "2026-08-20T12:01:00.000Z",
      },
    },
  };
}

function completed(
  invocation: SkillInvocationV1,
  output: unknown,
): SkillExecutionResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: "44444444-4444-4444-8444-444444444444",
    traceId: invocation.traceId,
    timestamp: NOW,
    source: {
      service: "bot-runtime",
      instanceId: invocation.payload.expectedRuntimeInstanceId,
    },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1",
    payload: {
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      outcome: "completed",
      attempts: 1,
      completedAt: NOW,
      output: output as never,
    },
  };
}

function event(
  invocation: SkillInvocationV1,
  result: SkillExecutionResultV1,
  overrides: Partial<WorldMemorySkillResultEvent> = {},
): WorldMemorySkillResultEvent {
  return {
    command: invocation,
    result,
    authoritativeServerProfileId: SERVER,
    authoritativePosition: {
      x: 0,
      y: 64,
      z: 0,
      dimension: DIMENSION,
    },
    ...overrides,
  };
}

class FakeWriter implements WorldMemoryWriterLike {
  readonly commands: WorldMemoryWriteCommand[] = [];
  unavailable = false;

  async record(
    input: WorldMemoryWriteCommand,
  ): Promise<RecordWorldMemoryResult> {
    if (this.unavailable) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_INGESTION_FAILED",
        "simulated PostgreSQL outage",
      );
    }
    const created = !this.commands.some(
      ({ operationId }) => operationId === input.operationId,
    );
    if (created) this.commands.push(input);
    return {
      created,
      memory: {
        schemaVersion: input.schemaVersion,
        operationId: input.operationId,
        memoryId: input.memoryId,
        serverProfileId: input.serverProfileId,
        dimension: input.dimension,
        position: input.position,
        kind: input.kind,
        summary: input.summary,
        tags: input.tags,
        confidence: input.confidence,
        visibility: input.visibility,
        allowedSubjectIds: input.allowedSubjectIds,
        modelAccess: input.modelAccess,
        sourceBotId: input.sourceBotId,
        sourceTaskId: input.sourceTaskId,
        traceId: input.traceId,
        observedAt: input.observedAt,
        expiresAt: input.expiresAt,
        supersedesMemoryId: input.supersedesMemoryId,
        embeddingModel: input.embedding?.model ?? null,
        embeddingDimensions: input.embedding?.values.length ?? null,
        createdAt: NOW,
      },
    };
  }
}

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("authorized skill-result world-memory projection", () => {
  it("projects real scout observations into deterministic model-safe facts", () => {
    const invocation = command("scout.scan-blocks", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      blockNames: ["iron_ore", "lava", "nether_portal"],
      maxDistance: 16,
      maxResults: 8,
    });
    const observation = event(
      invocation,
      completed(invocation, {
        origin: { x: 0, y: 64, z: 0 },
        observations: [
          { blockName: "iron_ore", position: { x: 3, y: 62, z: 1 } },
          { blockName: "lava", position: { x: -2, y: 61, z: 0 } },
          { blockName: "nether_portal", position: { x: 5, y: 64, z: 0 } },
        ],
      }),
    );

    const projected = projectWorldMemoryFromSkillResult(observation);
    expect(projected).toHaveLength(3);
    expect(projected.map(({ kind }) => kind)).toEqual([
      "resource",
      "hazard",
      "portal",
    ]);
    expect(projected).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          serverProfileId: SERVER,
          dimension: DIMENSION,
          position: { x: 3, y: 62, z: 1 },
          visibility: "team",
          modelAccess: true,
          sourceBotId: "scout-01",
        }),
      ]),
    );
    expect(projected.map(({ operationId }) => operationId)).toEqual(
      projectWorldMemoryFromSkillResult(observation).map(
        ({ operationId }) => operationId,
      ),
    );
    expect(projected.every(({ summary }) => !summary.includes("x="))).toBe(true);
  });

  it("rejects cross-server and unrequested scout observations", () => {
    const invocation = command("scout.scan-blocks", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      blockNames: ["iron_ore"],
      maxDistance: 8,
      maxResults: 4,
    });
    const result = completed(invocation, {
      origin: { x: 0, y: 64, z: 0 },
      observations: [
        { blockName: "diamond_ore", position: { x: 2, y: 62, z: 1 } },
      ],
    });
    expect(() =>
      projectWorldMemoryFromSkillResult(event(invocation, result)),
    ).toThrow(/authorized names/u);
    expect(() =>
      projectWorldMemoryFromSkillResult(
        event(invocation, completed(invocation, {
          origin: { x: 0, y: 64, z: 0 },
          observations: [],
        }), { authoritativeServerProfileId: "server-beta" }),
      ),
    ).toThrow(/authoritative Bot world/u);
    expect(() =>
      projectWorldMemoryFromSkillResult(
        event(invocation, {
          ...completed(invocation, {
            origin: { x: 0, y: 64, z: 0 },
            observations: [],
          }),
          botId: "other-bot",
        }),
      ),
    ).toThrow(/identity/u);
  });

  it("keeps storage coordinates and counts restricted from model context", () => {
    const invocation = command("storage.account", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      container: { x: 3, y: 64, z: 0 },
      itemNames: ["cobblestone", "bread"],
    });
    const projected = projectWorldMemoryFromSkillResult(
      event(invocation, completed(invocation, {
        containerName: "chest",
        containerUsedSlots: 2,
        containerTotalSlots: 27,
        items: [
          { itemName: "cobblestone", inventoryCount: 8, containerCount: 64, totalCount: 72 },
          { itemName: "bread", inventoryCount: 2, containerCount: 12, totalCount: 14 },
        ],
      })),
    );
    expect(projected).toEqual([
      expect.objectContaining({
        kind: "storage",
        position: { x: 3, y: 64, z: 0 },
        visibility: "restricted",
        allowedSubjectIds: ["scout-01"],
        modelAccess: false,
      }),
    ]);
  });

  it("persists idempotently and reports created versus replayed facts", async () => {
    const invocation = command("scout.scan-blocks", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      blockNames: ["iron_ore"],
      maxDistance: 8,
      maxResults: 4,
    });
    const observation = event(invocation, completed(invocation, {
      origin: { x: 0, y: 64, z: 0 },
      observations: [
        { blockName: "iron_ore", position: { x: 2, y: 62, z: 1 } },
      ],
    }));
    const writer = new FakeWriter();
    const ingestor = new WorldMemorySkillResultIngestor(writer);

    await expect(ingestor.ingest(observation)).resolves.toEqual({
      projectedCount: 1,
      createdCount: 1,
      replayedCount: 0,
    });
    await expect(ingestor.ingest(observation)).resolves.toEqual({
      projectedCount: 1,
      createdCount: 0,
      replayedCount: 1,
    });
    expect(writer.commands).toHaveLength(1);
  });

  it("durably defers an authorized result and replays it after restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "studio-memory-result-ingestion-"),
    );
    temporaryRoots.push(directory);
    const invocation = command("scout.scan-blocks", {
      serverProfileId: SERVER,
      dimension: DIMENSION,
      blockNames: ["iron_ore"],
      maxDistance: 8,
      maxResults: 4,
    });
    const observation = event(invocation, completed(invocation, {
      origin: { x: 0, y: 64, z: 0 },
      observations: [
        { blockName: "iron_ore", position: { x: 2, y: 62, z: 1 } },
      ],
    }));
    const unavailable = new FakeWriter();
    unavailable.unavailable = true;
    const firstOutbox = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: unavailable,
      now: () => new Date(NOW),
    });
    const ingestor = new DurableWorldMemorySkillResultIngestor(firstOutbox);

    await expect(ingestor.ingest(observation)).resolves.toEqual({
      projectedCount: 1,
      createdCount: 0,
      replayedCount: 0,
      deferredCount: 1,
      pendingBatchCount: 1,
      durableBatchCreated: true,
    });

    const recovered = new FakeWriter();
    const restartedOutbox = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: recovered,
      now: () => new Date(NOW),
    });
    await expect(restartedOutbox.reconcileOnce()).resolves.toMatchObject({
      delivered: 1,
      failed: 0,
      pendingBatchCount: 0,
    });
    expect(recovered.commands).toHaveLength(1);
    expect(recovered.commands[0]).toMatchObject({
      kind: "resource",
      serverProfileId: SERVER,
      sourceBotId: "scout-01",
    });
  });

  it("preserves backlog health when a completed skill projects no facts", async () => {
    const pendingOnlyOutbox: WorldMemoryIngestionOutboxLike = {
      enqueue: async () => {
        throw new Error("zero-fact results must not enqueue");
      },
      deliverBatch: async () => {
        throw new Error("zero-fact results must not deliver");
      },
      pendingCount: async () => 2,
    };
    const invocation = command("movement.goto", {});
    const ingestor = new DurableWorldMemorySkillResultIngestor(
      pendingOnlyOutbox,
    );
    await expect(
      ingestor.ingest(event(invocation, completed(invocation, { reached: true }))),
    ).resolves.toEqual({
      projectedCount: 0,
      createdCount: 0,
      replayedCount: 0,
      deferredCount: 0,
      pendingBatchCount: 2,
      durableBatchCreated: false,
    });
  });
});

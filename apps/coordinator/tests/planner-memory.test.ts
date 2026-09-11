import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutionRecord } from "@minecraft-studio/task-system";
import { botStatusV1Schema, type BotPersonalMemoryV1 } from "@minecraft-studio/protocol";

import { FilePersonalMemoryStore } from "../src/personal-memory-store.js";
import {
  buildPlannerMemory,
  PLANNER_MEMORY_MAX_BYTES,
  PLANNER_MEMORY_MAX_RECENT_GOALS,
  PLANNER_MEMORY_VERSION,
} from "../src/planner-memory.js";

const NOW_MS = Date.parse("2026-09-11T12:00:00.000Z");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "planner-memory-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function taskRecord(overrides: Partial<TaskExecutionRecord> & { taskId: string; botId?: string }): TaskExecutionRecord {
  return {
    schemaVersion: "1.0",
    botId: overrides.botId ?? "bot-01",
    goal: overrides.goal ?? "collect 8 oak_log",
    parentTask: null,
    childTasks: [],
    state: overrides.state ?? "SUCCESS",
    currentStep: null,
    executionOwner: null,
    executionLeaseExpiresAt: null,
    startTime: "2026-09-11T11:00:00.000Z",
    lastProgressTime: "2026-09-11T11:05:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-09-11T11:05:00.000Z",
    retryCount: 0,
    recoveryCount: 0,
    maxRecoveryCount: 3,
    planVersion: 1,
    worldStateVersion: 1,
    reservedResources: [],
    movementLease: null,
    expectedResult: null,
    actualResult: null,
    failureReason: overrides.failureReason ?? null,
    cancellationToken: { tokenId: "token-1", cancelled: false, cancelledAt: null, reason: null },
    revision: 1,
    ...overrides,
  } as TaskExecutionRecord;
}

function statusMessage(overrides: Partial<{
  botId: string;
  worldId: string | null;
  observedAt: string;
  sequence: number;
  armorPoints: number;
  inventory: unknown;
}> = {}) {
  const observedAt = overrides.observedAt ?? "2026-09-11T11:00:00.000Z";
  return botStatusV1Schema.parse({
    schemaVersion: "1.0",
    messageId: randomUUID(),
    traceId: "planner-memory-test",
    timestamp: observedAt,
    source: { service: "bot-runtime", instanceId: "runtime-planner-memory-test" },
    type: "bot.status.v1",
    botId: overrides.botId ?? "bot-01",
    payload: {
      serverProfileId: "profile-a",
      runtimeInstanceId: "runtime-planner-memory-test",
      sequence: overrides.sequence ?? 1,
      observedAt,
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: overrides.armorPoints ?? 3,
      armorSlots: { head: "iron_helmet", chest: null, legs: null, feet: null },
      inventory: overrides.inventory ?? [{ itemName: "oak_log", count: 12 }],
      position: { x: 10, y: 64, z: -5, dimension: "minecraft:overworld" },
      latencyMs: null,
      currentTask: null,
      personalContext: {
        worldId: overrides.worldId ?? null,
        worldSpawn: { position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" }, observedAt, source: "server_spawn_packet" },
        verifiedRespawn: null,
      },
      lastDeath: {
        x: 10, y: 64, z: -5,
        dimension: "minecraft:overworld",
        diedAt: "2026-09-11T11:50:00.000Z",
        droppedItems: [{ itemId: "diamond_sword", count: 1 }, { itemId: "oak_log", count: 3 }],
      },
    },
  });
}

/** 经真实 store 写入读出，保证 fixture 永远与 schema 同形。 */
function personalMemory(overrides: Parameters<typeof statusMessage>[0] = {}): BotPersonalMemoryV1 {
  const store = new FilePersonalMemoryStore(tempDir());
  store.observeStatus(statusMessage(overrides));
  const memory = store.get({ botId: overrides.botId ?? "bot-01", serverProfileId: "profile-a", worldId: overrides.worldId ?? null });
  expect(memory).not.toBeNull();
  return memory!;
}

describe("buildPlannerMemory", () => {
  it("summarizes terminal goal outcomes with ages and failure reasons", () => {
    const memory = buildPlannerMemory({
      botId: "bot-01",
      serverProfileId: "profile-a",
      now: () => NOW_MS,
      taskRecords: [
        taskRecord({ taskId: "t1", state: "SUCCESS" }),
        taskRecord({ taskId: "t2", state: "ABORT", failureReason: "COLLECT_PICKUP_NOT_SETTLED", updatedAt: "2026-09-11T11:30:00.000Z" }),
        // 非终态与非本 bot 记录都必须被排除。
        taskRecord({ taskId: "t3", state: "EXECUTE" }),
        taskRecord({ taskId: "t4", botId: "bot-02", state: "SUCCESS" }),
      ],
      personalMemory: null,
    });
    expect(memory).not.toBeNull();
    expect(memory!.memoryVersion).toBe(PLANNER_MEMORY_VERSION);
    expect(memory!.recentGoals).toHaveLength(2);
    expect(memory!.recentGoals[0]).toMatchObject({ outcome: "failed", failureReason: "COLLECT_PICKUP_NOT_SETTLED" });
    expect(memory!.recentGoals[1]!.outcome).toBe("completed");
    expect(memory!.recentGoals[0]!.ageMs).toBe(30 * 60 * 1000);
  });

  it("detects repeated identical failures deterministically", () => {
    const memory = buildPlannerMemory({
      botId: "bot-01",
      serverProfileId: "profile-a",
      now: () => NOW_MS,
      taskRecords: [
        taskRecord({ taskId: "t1", state: "ABORT", failureReason: "PATHFINDER_GOTO_FAILED", goal: "go to the mountain base" }),
        taskRecord({ taskId: "t2", state: "ABORT", failureReason: "PATHFINDER_GOTO_FAILED", goal: "go to the mountain base" }),
        taskRecord({ taskId: "t3", state: "ABORT", failureReason: "X", goal: "other goal" }),
      ],
      personalMemory: null,
    });
    expect(memory!.repeatedFailureGoalText).toBe("go to the mountain base");
    expect(memory!.repeatedFailureCount).toBe(2);
  });

  it("redacts secrets in goal text and failure reasons before they reach the prompt", () => {
    const memory = buildPlannerMemory({
      botId: "bot-01",
      serverProfileId: "profile-a",
      now: () => NOW_MS,
      taskRecords: [
        taskRecord({ taskId: "t1", state: "ABORT", failureReason: "api_key=sk-live-abcdef123456", goal: "fetch with api_key=sk-live-abcdef123456" }),
      ],
      personalMemory: null,
    });
    expect(memory).not.toBeNull();
    expect(JSON.stringify(memory)).not.toContain("sk-live-abcdef123456");
    expect(memory!.recentGoals[0]!.goalText).toContain("[REDACTED]");
  });

  it("redacts secret-shaped identifiers in non-goal fields too (inventory itemName)", () => {
    const tokenShaped = `ghp_${"a1b2c3d4e5".repeat(4)}`; // 40 chars, passes the itemName charset
    const memory = buildPlannerMemory({
      botId: "bot-01",
      serverProfileId: "profile-a",
      now: () => NOW_MS,
      taskRecords: [],
      personalMemory: personalMemory({ inventory: [{ itemName: tokenShaped, count: 1 }] }),
    });
    expect(memory).not.toBeNull();
    expect(JSON.stringify(memory)).not.toContain(tokenShaped);
    expect(memory!.lastResourceObservation!.inventoryItems[0]!.itemName).toBe("[REDACTED]");
  });

  it("caps recent goals and trims from the oldest when over the byte budget", () => {
    const many = Array.from({ length: PLANNER_MEMORY_MAX_RECENT_GOALS + 4 }, (_, index) =>
      taskRecord({
        taskId: `t${index}`,
        state: "ABORT",
        failureReason: "R",
        goal: `goal number ${index} with padding text to grow the serialized size`,
        updatedAt: new Date(NOW_MS - index * 60_000).toISOString(),
      }),
    );
    const memory = buildPlannerMemory({
      botId: "bot-01",
      serverProfileId: "profile-a",
      now: () => NOW_MS,
      taskRecords: many,
      personalMemory: null,
    });
    expect(memory).not.toBeNull();
    expect(memory!.recentGoals.length).toBeLessThanOrEqual(PLANNER_MEMORY_MAX_RECENT_GOALS);
    expect(Buffer.byteLength(JSON.stringify(memory), "utf8")).toBeLessThanOrEqual(PLANNER_MEMORY_MAX_BYTES);
  });

  it("returns null with no history and no personal memory (prompt stays memory-free)", () => {
    expect(buildPlannerMemory({ botId: "bot-01", serverProfileId: "profile-a", now: () => NOW_MS, taskRecords: [], personalMemory: null })).toBeNull();
  });

  it("carries last death and last resource observation from personal memory", () => {
    const memory = buildPlannerMemory({
      botId: "bot-01",
      serverProfileId: "profile-a",
      now: () => NOW_MS,
      taskRecords: [],
      personalMemory: personalMemory({ armorPoints: 15 }),
    });
    expect(memory!.lastResourceObservation).toMatchObject({ armorPoints: 15 });
    expect(memory!.lastResourceObservation!.inventoryItems[0]).toEqual({ itemName: "oak_log", count: 12 });
    expect(memory!.lastDeath).toMatchObject({ ageMs: 10 * 60 * 1000, dimension: "minecraft:overworld", droppedItemsCount: 2 });
  });
});

describe("FilePersonalMemoryStore.getLatestForBot", () => {
  it("picks the newest observation across world generations for the same bot+server", () => {
    const store = new FilePersonalMemoryStore(tempDir());
    store.observeStatus(statusMessage({ worldId: "world-1", observedAt: "2026-09-11T10:00:00.000Z", sequence: 1 }));
    store.observeStatus(statusMessage({ worldId: "world-2", observedAt: "2026-09-11T11:00:00.000Z", sequence: 5 }));
    store.observeStatus(statusMessage({ botId: "bot-other", worldId: "world-1", observedAt: "2026-09-11T12:00:00.000Z", sequence: 9 }));
    const latest = store.getLatestForBot!("bot-01", "profile-a");
    expect(latest).not.toBeNull();
    expect(latest!.scope.worldId).toBe("world-2");
    expect(latest!.sequence).toBe(5);
    expect(store.getLatestForBot!("bot-01", "profile-other")).toBeNull();
  });

  it("returns null when the memory directory does not exist", () => {
    const store = new FilePersonalMemoryStore(path.join(tempDir(), "absent"));
    expect(store.getLatestForBot!("bot-01", "profile-a")).toBeNull();
  });

  it("skips corrupt files instead of failing the lookup", () => {
    const dir = tempDir();
    const store = new FilePersonalMemoryStore(dir);
    store.observeStatus(statusMessage({ worldId: "world-1", observedAt: "2026-09-11T10:00:00.000Z", sequence: 1 }));
    writeFileSync(path.join(dir, `${"c".repeat(64)}.json`), "{not-json");
    expect(store.getLatestForBot!("bot-01", "profile-a")).not.toBeNull();
  });
});

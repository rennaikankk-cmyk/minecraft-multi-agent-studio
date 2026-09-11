import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TaskExecutionRecord } from "@minecraft-studio/task-system";
import { SkillGapStore, FileSkillGapStore } from "@minecraft-studio/skills";

import { createSkillGapRecorder, extractFailureCode, extractSkillId } from "../src/skill-gap-recorder.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "gap-recorder-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT = { gitCommit: "abc1234", branch: "main", buildVersion: "test", dirty: false };

function abortedTask(overrides: Partial<TaskExecutionRecord> = {}): TaskExecutionRecord {
  return {
    schemaVersion: "1.0",
    taskId: "task-1",
    botId: "bot-01",
    goal: "build a cobble wall",
    parentTask: null,
    childTasks: [],
    state: "ABORT",
    currentStep: null,
    executionOwner: null,
    executionLeaseExpiresAt: null,
    startTime: "2026-09-11T11:00:00.000Z",
    lastProgressTime: "2026-09-11T11:05:00.000Z",
    updatedAt: "2026-09-11T11:05:00.000Z",
    retryCount: 0,
    recoveryCount: 3,
    maxRecoveryCount: 3,
    planVersion: 1,
    worldStateVersion: 1,
    reservedResources: [],
    movementLease: null,
    expectedResult: null,
    actualResult: null,
    failureReason: "BUILD_MATERIAL_MISSING",
    cancellationToken: { tokenId: "token-1", cancelled: false, cancelledAt: null, reason: null },
    revision: 4,
    ...overrides,
  } as TaskExecutionRecord;
}

function recorderWith(store: SkillGapStore, catalog: string[] = []) {
  const events: string[] = [];
  const record = createSkillGapRecorder({
    store,
    catalogSkillIds: catalog,
    project: PROJECT,
    serverProfileFor: (botId) => (botId === "bot-01" ? "profile-a" : null),
    minecraftVersionFor: () => undefined,
    log: (event) => events.push(event),
  });
  return { record, events };
}

describe("skill gap recorder", () => {
  it("records deterministic-code gaps from aborted tasks", () => {
    const store = new SkillGapStore();
    const { record, events } = recorderWith(store);
    record(abortedTask());
    expect(store.size).toBe(1);
    expect(store.list()[0]!.kind).toBe("blueprint_missing");
    expect(events).toContain("coordinator_skill_gap_recorded");
  });

  it("does not produce a gap when the failure code is non-gap or unparseable", () => {
    const store = new SkillGapStore();
    const { record } = recorderWith(store);
    record(abortedTask({ failureReason: "PATHFINDER_GOTO_FAILED" }));
    record(abortedTask({ failureReason: "recovery budget blown by something odd" }));
    record(abortedTask({ failureReason: "" }));
    expect(store.size).toBe(0);
  });

  it("evidence gate: catalog-dependent kinds without a named skill produce no gap", () => {
    const store = new SkillGapStore();
    const { record } = recorderWith(store);
    // 无点号技能名的 goal → skill_not_advertised 类结论缺证据 → 丢弃。
    record(abortedTask({ failureReason: "PLANNER_SKILL_CATALOG_UNAVAILABLE", goal: "do something new" }));
    expect(store.size).toBe(0);
  });

  it("named-but-missing skill produces skill_not_advertised (real evidence)", () => {
    const store = new SkillGapStore();
    const { record } = recorderWith(store, ["movement.goto"]);
    record(abortedTask({
      failureReason: "PLANNER_SKILL_CATALOG_UNAVAILABLE",
      goal: "use the fluid.pump skill to drain the lake",
    }));
    expect(store.list()[0]!.kind).toBe("skill_not_advertised");
    expect(store.list()[0]!.gap.requestedSkillId).toBe("fluid.pump");
  });

  it("aggregates same-fingerprint aborts and ignores unknown bots", () => {
    const store = new SkillGapStore();
    const { record } = recorderWith(store);
    record(abortedTask());
    record(abortedTask({ taskId: "task-2" }));
    expect(store.list()[0]!.occurrenceCount).toBe(2);
    record(abortedTask({ taskId: "task-3", botId: "bot-unknown" }));
    expect(store.list()[0]!.occurrenceCount).toBe(2);
  });

  it("recorder failures never escape into the planner transition path", () => {
    const store = new SkillGapStore();
    const { record, events } = recorderWith(store);
    // serverProfileFor 抛错等内部异常被吞掉并记日志。
    const throwing = createSkillGapRecorder({
      store,
      catalogSkillIds: [],
      project: PROJECT,
      serverProfileFor: () => {
        throw new Error("registry down");
      },
      minecraftVersionFor: () => undefined,
      log: (event) => events.push(event),
    });
    expect(() => throwing(abortedTask())).not.toThrow();
    expect(events).toContain("coordinator_skill_gap_record_failed");
  });

  it("extract helpers: failure code and dotted skill ids", () => {
    expect(extractFailureCode("BUILD_MATERIAL_MISSING: cobblestone")).toBe("BUILD_MATERIAL_MISSING");
    expect(extractFailureCode("no code here")).toBeNull();
    expect(extractSkillId("use the movement.goto skill")).toBe("movement.goto");
    expect(extractSkillId("plain goal text")).toBeNull();
  });

  it("FileSkillGapStore integration: recorder-written gaps survive restart", () => {
    const dir = tempDir();
    const store = new FileSkillGapStore(dir);
    const { record } = recorderWith(store);
    record(abortedTask());
    const restarted = new FileSkillGapStore(dir);
    expect(restarted.size).toBe(1);
    expect(restarted.list()[0]!.kind).toBe("blueprint_missing");
  });
});

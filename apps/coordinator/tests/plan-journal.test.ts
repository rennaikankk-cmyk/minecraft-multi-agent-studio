import { mkdtemp, rm, readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyStepResult,
  FilePlanJournalStore,
  InMemoryPlanJournalStore,
  JournalWriteError,
  newPlanJournal,
  recordDispatch,
} from "../src/plan-journal.js";

// ---------------------------------------------------------------------------
// Round 6.4 P0c —— durable plan/step journal 语义测试
// ---------------------------------------------------------------------------

const dirs: string[] = [];
afterEach(async () => {
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true });
});

function journal2Step() {
  return newPlanJournal({
    goalId: "goal-1",
    botId: "bot-a",
    serverProfileId: "sp-1",
    correlationId: "corr-1",
    plannerVersion: "v-test",
    steps: [
      {
        skillId: "collect.block",
        actionFamily: "collect",
        sideEffectClass: "NON_IDEMPOTENT",
        expectedPostcondition: { kind: "inventory-delta", botId: "bot-a", itemName: "oak_log", minCount: 1 },
      },
      {
        skillId: "world.place-block",
        actionFamily: "place",
        sideEffectClass: "NON_IDEMPOTENT",
        expectedPostcondition: { kind: "block-state", serverProfileId: "sp-1", dimension: "minecraft:overworld", position: { x: 1, y: 2, z: 3 }, blockName: "oak_log" },
      },
    ],
  });
}

describe("journal state transitions", () => {
  it("two-step success completes the plan", () => {
    let j = journal2Step();
    j = applyStepResult(j, j.steps[0]!.stepId, {
      status: "SUCCEEDED",
      verification: { outcome: "confirmed", evidence: "inventory oak_log 0→1" },
    });
    expect(j.status).toBe("ACTIVE");
    j = applyStepResult(j, j.steps[1]!.stepId, { status: "SUCCEEDED" });
    expect(j.status).toBe("COMPLETED");
  });

  it("duplicate/out-of-order results are idempotent on terminal steps", () => {
    let j = journal2Step();
    j = applyStepResult(j, j.steps[0]!.stepId, { status: "SUCCEEDED" });
    const succeededAt = j.steps[0]!.updatedAt;
    // 迟到的 FAILED 不回退终态
    j = applyStepResult(j, j.steps[0]!.stepId, { status: "FAILED", failureCode: "LATE" });
    expect(j.steps[0]!.status).toBe("SUCCEEDED");
    expect(j.steps[0]!.updatedAt).toBe(succeededAt);
  });

  it("dispatch counting tracks replays (J3 zero-replay criterion)", () => {
    let j = journal2Step();
    expect(j.steps[0]!.dispatchCount).toBe(0);
    j = recordDispatch(j, j.steps[0]!.stepId);
    j = recordDispatch(j, j.steps[0]!.stepId);
    expect(j.steps[0]!.dispatchCount).toBe(2);
    expect(j.steps[0]!.status).toBe("DISPATCHING");
  });

  it("PAUSED steps keep the plan active (retry budget / operator escalation)", () => {
    let j = journal2Step();
    j = applyStepResult(j, j.steps[0]!.stepId, { status: "PAUSED", failureCode: "NON_IDEMPOTENT_RESULT_UNCERTAIN" });
    expect(j.steps[0]!.status).toBe("PAUSED");
    expect(j.status).toBe("ACTIVE");
  });
});

describe("FilePlanJournalStore durability", () => {
  it("save→load round-trip survives a restart (new store instance)", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plan-journal-"));
    dirs.push(dir);
    const store = new FilePlanJournalStore({ dir });
    let j = journal2Step();
    j = applyStepResult(j, j.steps[0]!.stepId, { status: "SUCCEEDED" });
    store.save(j);

    // "restart"：新实例从磁盘恢复
    const revived = new FilePlanJournalStore({ dir });
    const loaded = revived.load();
    expect(loaded.length).toBe(1);
    expect(loaded[0]!.planId).toBe(j.planId);
    expect(loaded[0]!.steps[0]!.status).toBe("SUCCEEDED");
    expect(loaded[0]!.steps[0]!.dispatchCount).toBe(j.steps[0]!.dispatchCount);
  });

  it("corrupt journal file is quarantined, not silently dropped", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plan-journal-corrupt-"));
    dirs.push(dir);
    const store = new FilePlanJournalStore({ dir });
    store.save(journal2Step());
    const file = path.join(dir, readdirSync(dir).find((f) => f.endsWith(".json"))!);
    const { writeFileSync } = await import("node:fs");
    writeFileSync(file, "{ not valid json", "utf8");
    const revived = new FilePlanJournalStore({ dir });
    expect(revived.load().length).toBe(0);
    // quarantine 副本保留
    const leftovers = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    expect(leftovers.length).toBe(1);
  });

  it("writes are atomic (tmp+rename): no .tmp residue on success", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "plan-journal-atomic-"));
    dirs.push(dir);
    const store = new FilePlanJournalStore({ dir });
    store.save(journal2Step());
    const files = readdirSync(dir);
    expect(files.some((f) => f.includes(".tmp-"))).toBe(false);
    expect(files.length).toBe(1);
  });
});

describe("InMemoryPlanJournalStore (explicit non-durable)", () => {
  it("round-trips within the process", () => {
    const store = new InMemoryPlanJournalStore();
    const j = journal2Step();
    store.save(j);
    expect(store.load()[0]!.planId).toBe(j.planId);
    expect(store.retain({ maxCompleted: 0, maxAgeDays: 0 })).toBe(0);
  });
});

describe("typed postconditions", () => {
  it("all seven kinds construct and serialize", () => {
    const j = newPlanJournal({
      goalId: null,
      botId: "b",
      serverProfileId: "s",
      correlationId: "c",
      plannerVersion: "v",
      steps: [
        { skillId: "a", actionFamily: "inv", sideEffectClass: "RECONCILABLE", expectedPostcondition: { kind: "inventory-delta", botId: "b", itemName: "x", minCount: 1 } },
        { skillId: "b", actionFamily: "block", sideEffectClass: "RECONCILABLE", expectedPostcondition: { kind: "block-state", serverProfileId: "s", dimension: "d", position: { x: 0, y: 0, z: 0 }, blockName: "stone" } },
        { skillId: "c", actionFamily: "container", sideEffectClass: "RECONCILABLE", expectedPostcondition: { kind: "container-slot", serverProfileId: "s", containerPosition: { x: 0, y: 0, z: 0 }, slotHint: "input" } },
        { skillId: "d", actionFamily: "smelt", sideEffectClass: "RECONCILABLE", expectedPostcondition: { kind: "smelting-state", serverProfileId: "s", furnacePosition: { x: 0, y: 0, z: 0 }, expect: "output-ready" } },
        { skillId: "e", actionFamily: "facility", sideEffectClass: "RECONCILABLE", expectedPostcondition: { kind: "facility-lease", registryKey: "s|d|furnace|0,0,0", ownerBotId: "b" } },
        { skillId: "f", actionFamily: "build", sideEffectClass: "NON_IDEMPOTENT", expectedPostcondition: { kind: "build-cell", buildId: "build-1", cellIndex: 0, position: { x: 1, y: 1, z: 1 }, blockName: "oak_log" } },
        { skillId: "g", actionFamily: "move", sideEffectClass: "IDEMPOTENT", expectedPostcondition: { kind: "movement-arrival", botId: "b", target: { x: 1, y: 1, z: 1 }, radiusBlocks: 3 } },
      ],
    });
    expect(j.steps.length).toBe(7);
    expect(JSON.parse(JSON.stringify(j)).steps[5]!.expectedPostcondition.kind).toBe("build-cell");
  });
});

void readFile;
void JournalWriteError;

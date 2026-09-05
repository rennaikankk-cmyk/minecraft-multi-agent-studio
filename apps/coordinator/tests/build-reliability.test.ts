import { describe, expect, it } from "vitest";
import { BaseRegistry, buildBlueprintSkill } from "@minecraft-studio/skills";
import { InMemoryPlanJournalStore } from "../src/plan-journal.js";
import { beginBuildBatch, finishBuildBatch, worksetMaterialDeficit } from "../src/build-journal.js";

const blueprint = { serverProfileId: "a", dimension: "minecraft:overworld", anchor: { x: 0, y: 64, z: 0 },
  cells: [0, 1].map((x) => ({ offset: { x, y: 0, z: 0 }, itemName: "stone", blockClass: "structural" as const, order: x })) };
const scope = { goalId: "task", botId: "bot-a", baseId: "base-a", blueprintId: "fixture", skillInput: { blueprint, reconcile: true } };
const execution = { coordinatorInstanceId: "c", runtimeInstanceId: "runtime-a", taskId: "task" };

describe("construction recovery authority", () => {
  it("persists sparse partial evidence with unknown cells without declaring the build complete", () => {
    const store = new InMemoryPlanJournalStore();
    const journal = beginBuildBatch(store, { ...scope, execution });
    const saved = finishBuildBatch(store, journal, { outcome: "completed", output: {
      completed: false, startIndex: 0, nextIndex: 0, totalCells: 2, estimatedDurationMs: 250,
      placements: [{ index: 1, position: { x: 1, y: 64, z: 0 }, itemName: "stone", blockClass: "structural", placed: true }],
      verification: { states: ["unknown", "match"], observedAt: new Date().toISOString() },
      workset: { snapshotId: crypto.randomUUID(), status: "WAITING_OBSERVATION", remainingCells: 1, missingMaterials: [] },
    } });
    expect(saved.build).toMatchObject({ verification: "UNVERIFIED", nextIndex: 0, observedRuntimeInstanceId: "runtime-a" });
    expect(saved.build!.execution).toBeUndefined();
    expect(saved.steps.at(-1)!.observedActual).toMatchObject({ verification: { states: ["unknown", "match"] } });
    expect(beginBuildBatch(store, { ...scope, execution }).build!.buildId).toBe(saved.build!.buildId);
  });

  it("only requests supplies from a fresh, settled receipt of the current Runtime", () => {
    const store = new InMemoryPlanJournalStore();
    const journal = beginBuildBatch(store, { ...scope, execution });
    const now = Date.now();
    const saved = finishBuildBatch(store, journal, { outcome: "completed", output: {
      completed: false, startIndex: 0, nextIndex: 1, totalCells: 2, estimatedDurationMs: 0, placements: [],
      verification: { states: ["match", "different"], observedAt: new Date(now).toISOString() },
      workset: { snapshotId: crypto.randomUUID(), status: "WAITING_MATERIAL", remainingCells: 1, missingMaterials: [{ itemName: "stone", count: 1 }] },
    } });
    expect(worksetMaterialDeficit(saved, "bot-a", "runtime-a", new Map(), now)).toEqual([{ itemName: "stone", count: 1 }]);
    expect(worksetMaterialDeficit(saved, "bot-a", "runtime-a", new Map([["stone", 1]]), now)).toEqual([]);
    expect(worksetMaterialDeficit(saved, "bot-a", "runtime-new", new Map(), now)).toBeNull();
    expect(worksetMaterialDeficit(saved, "bot-b", "runtime-a", new Map(), now)).toBeNull();
    expect(worksetMaterialDeficit(saved, "bot-a", "runtime-a", new Map(), now + 60_001)).toBeNull();
  });
  it("blocks concurrent builders and uncertain same-runtime retries, permitting a replacement runtime", () => {
    const store = new InMemoryPlanJournalStore();
    const first = beginBuildBatch(store, { ...scope, execution });
    expect(() => beginBuildBatch(store, { ...scope, botId: "bot-b", execution: { ...execution, runtimeInstanceId: "runtime-b" } })).toThrow("STOP_UNCONFIRMED");
    const unknown = finishBuildBatch(store, first, undefined);
    const cancelled = finishBuildBatch(store, unknown, { outcome: "cancelled", errorCode: "SKILL_CANCELLED" });
    expect(cancelled.build!.execution).toBeDefined();
    expect(() => beginBuildBatch(store, { ...scope, execution })).toThrow("STOP_UNCONFIRMED");
    const replacement = beginBuildBatch(store, { ...scope, execution: { ...execution, runtimeInstanceId: "runtime-a-new" } });
    expect(replacement.build!.buildId).toBe(first.build!.buildId);
  });

  it("read-only damage verification revokes availability, unknown stays unknown, repair revalidates the same build", async () => {
    let now = Date.now();
    const bases = new BaseRegistry({ now: () => now });
    const base = bases.create({ name: "fixture", ...blueprint, blueprintId: "fixture", createdByBotId: "bot-a" });
    bases.addMember(base.id, "a", blueprint.dimension, "bot-b");
    const store = new InMemoryPlanJournalStore();
    const input = { ...scope, baseId: base.id };
    const world = ["stone", "stone"];
    const effects: number[] = [];
    const context = { signal: new AbortController().signal, callCapability: async (_capability: string, operation: string, args: any) => {
      if (operation === "blueprint.inspect") return { states: world.map((b) => b === "unloaded" ? "unknown" : b === "stone" ? "match" : "different"), observedAt: new Date(now).toISOString() };
      effects.push(args.blueprintIndex); world[args.blueprintIndex] = "stone";
      return { placed: true, placedBlockName: "stone", position: args.target };
    } } as never;
    const run = async (inspectOnly = false) => {
      const journal = beginBuildBatch(store, input);
      try {
        const output = await buildBlueprintSkill.execute(context, { ...scope.skillInput, inspectOnly }, {} as never);
        return finishBuildBatch(store, journal, { outcome: "completed", output });
      } catch (error) { finishBuildBatch(store, journal, undefined); throw error; }
    };
    const done = await run();
    bases.recordPhaseEvidence(base.id, "STARTER_BASE_ACTIVE", "AVAILABLE", done.planId, "cell-readback");
    world[1] = "air";
    const damaged = await run(true);
    expect(damaged.build!.verification).toBe("DAMAGED");
    expect(effects).toEqual([]);
    bases.recordPhaseEvidence(base.id, "STARTER_BASE_ACTIVE", "DAMAGED", damaged.planId, "cell-readback");
    expect(bases.forMember("bot-b", "a", blueprint.dimension)?.phaseFacts!.STARTER_BASE_ACTIVE.availability).toBe("DAMAGED");
    world[1] = "unloaded";
    await expect(run()).rejects.toMatchObject({ code: "BUILD_VERIFY_TIMEOUT" });
    expect(store.load()[0]!.build!.verification).toBe("UNVERIFIED");
    expect(effects).toEqual([]);
    world[1] = "air";
    const repaired = await run();
    expect(repaired.build!.buildId).toBe(done.build!.buildId);
    expect(effects).toEqual([1]);
    bases.recordPhaseEvidence(base.id, "STARTER_BASE_ACTIVE", "AVAILABLE", repaired.planId, "cell-readback");
    expect(bases.currentPhaseFact(base.id, "STARTER_BASE_ACTIVE")?.availability).toBe("AVAILABLE");
    now += 60_001;
    expect(bases.currentPhaseFact(base.id, "STARTER_BASE_ACTIVE")?.availability).toBe("UNVERIFIED");
    expect(bases.currentPhaseFact(base.id, "STARTER_BASE_ACTIVE")?.everCompleted).toBe(true);
  });
});

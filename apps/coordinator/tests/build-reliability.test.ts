import { describe, expect, it } from "vitest";
import { BaseRegistry, buildBlueprintSkill } from "@minecraft-studio/skills";
import { InMemoryPlanJournalStore } from "../src/plan-journal.js";
import { beginBuildBatch, finishBuildBatch } from "../src/build-journal.js";

const blueprint = { serverProfileId: "a", dimension: "minecraft:overworld", anchor: { x: 0, y: 64, z: 0 },
  cells: [0, 1].map((x) => ({ offset: { x, y: 0, z: 0 }, itemName: "stone", blockClass: "structural" as const, order: x })) };
const scope = { goalId: "task", botId: "bot-a", baseId: "base-a", blueprintId: "fixture", skillInput: { blueprint, reconcile: true } };
const execution = { coordinatorInstanceId: "c", runtimeInstanceId: "runtime-a", taskId: "task" };

describe("construction recovery authority", () => {
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

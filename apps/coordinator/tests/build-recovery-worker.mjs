import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { FilePlanJournalStore } from "../dist/plan-journal.js";
import { beginBuildBatch, finishBuildBatch } from "../dist/build-journal.js";
import { BaseRegistry, FacilityRegistry, InMemoryWorkstationRegistry, DurableStateStore,
  durableSnapshotFrom, registriesFromDurableSnapshot, buildBlueprintSkill } from "@minecraft-studio/skills";

const [mode, dir, strategy] = process.argv.slice(2);
const store = new FilePlanJournalStore({ dir: path.join(dir, "journals") });
const state = new DurableStateStore(path.join(dir, "state.json"));
const blueprint = { serverProfileId: "server-a", dimension: "minecraft:overworld", anchor: { x: 10, y: 64, z: 20 },
  cells: [0, 1, 2].map((x) => ({ offset: { x, y: 0, z: 0 }, itemName: "stone", blockClass: "structural", order: x })) };
const skillInput = { blueprint, startIndex: 0, maxPlacements: 2, reconcile: true, ...(strategy ? { strategy } : {}) };
const confirmedIndex = strategy === "workset" ? 1 : 0;
const open = (baseId) => beginBuildBatch(store, { baseId, goalId: "goal", botId: "bot-a", blueprintId: "fixture-v1", skillInput });

if (mode === "write" || mode === "lost-result") {
  const bases = new BaseRegistry();
  const base = bases.create({ name: "fixture", serverProfileId: blueprint.serverProfileId,
    dimension: blueprint.dimension, anchor: blueprint.anchor, blueprintId: "fixture-v1", createdByBotId: "bot-a" });
  bases.addMember(base.id, blueprint.serverProfileId, blueprint.dimension, "bot-b");
  bases.recordPhaseEvidence(base.id, "SHELTER_MINIMAL_READY", "AVAILABLE", "fixture-observation", "fixture-validator");
  state.save(durableSnapshotFrom(new InMemoryWorkstationRegistry(), new FacilityRegistry(), bases));
  const journal = open(base.id);
  writeFileSync(path.join(dir, "world.json"), JSON.stringify([0, 1, 2].map((index) => index === confirmedIndex ? "stone" : "air")));
  if (mode === "write") finishBuildBatch(store, journal, { outcome: "completed", output: {
    startIndex: 0, nextIndex: confirmedIndex === 0 ? 1 : 0, totalCells: 3, completed: false, placements: [{ index: confirmedIndex,
      position: { ...blueprint.anchor, x: blueprint.anchor.x + confirmedIndex }, itemName: "stone", blockClass: "structural", placed: true }], estimatedDurationMs: 250,
    verification: { states: [0, 1, 2].map((index) => index === confirmedIndex ? "match" : "different"), observedAt: new Date().toISOString() },
  } });
  process.stdout.write(journal.build.buildId);
} else {
  const restored = registriesFromDurableSnapshot(state.load());
  const base = restored.bases.forMember("bot-b", "server-a", "minecraft:overworld");
  assert.equal(base.id, restored.bases.forMember("bot-a", "server-a", "minecraft:overworld").id);
  assert.equal(restored.bases.forMember("bot-a", "server-b", "minecraft:overworld"), null);
  assert.equal(restored.bases.forMember("bot-a", "server-a", "minecraft:the_nether"), null);
  assert.equal(base.phaseFacts.SHELTER_MINIMAL_READY.everCompleted, true);
  restored.bases.recordPhaseEvidence(base.id, "SHELTER_MINIMAL_READY", "DAMAGED", "fixture-damage", "fixture-validator");
  assert.equal(base.phaseFacts.SHELTER_MINIMAL_READY.availability, "DAMAGED");
  restored.bases.recordPhaseEvidence(base.id, "SHELTER_MINIMAL_READY", "UNVERIFIED", "fixture-unloaded", "fixture-validator");
  assert.equal(base.phaseFacts.SHELTER_MINIMAL_READY.everCompleted, true);
  const previous = store.load()[0];
  assert.equal(previous.status, "ACTIVE");
  const journal = open(base.id);
  assert.equal(journal.build.buildId, previous.build.buildId);
  assert.deepEqual(journal.build.anchor, blueprint.anchor);
  const world = JSON.parse(readFileSync(path.join(dir, "world.json")));
  const placed = [];
  const output = await buildBlueprintSkill.execute({ signal: new AbortController().signal,
    policy: { serverProfileId: "server-a", checkBlockReach: () => ({ allowed: true }), checkAttackReach: () => ({ allowed: false }) },
    callCapability: async (_capability, operation, input) => {
      if (operation === "blueprint.inspect-workset") return { snapshotId: crypto.randomUUID(), observedAt: new Date().toISOString(),
        playerPosition: { x: 10, y: 64, z: 20 },
        availableMaterials: [{ itemName: "stone", count: 3 }], cells: world.map((name, index) => ({
          state: name === "stone" ? "match" : "different", observedItemName: name === "stone" ? name : null,
          reachable: true, supportUnknown: false, workfaces: [{ referenceBlock: { x: 10 + index, y: 63, z: 20 }, face: { x: 0, y: 1, z: 0 } }],
        })) };
      if (operation === "blueprint.inspect") return { states: world.map((name) => name === "stone" ? "match" : "different"), observedAt: new Date().toISOString() };
      assert.equal(operation, "block.place-safe");
      assert.notEqual(input.blueprintIndex, confirmedIndex, "confirmed cell must not be replayed");
      placed.push(input.blueprintIndex);
      world[input.blueprintIndex] = "stone";
      return { placed: true, placedBlockName: "stone", position: input.target };
    },
  }, skillInput, {});
  const completed = finishBuildBatch(store, journal, { outcome: "completed", output });
  assert.deepEqual(placed, [0, 1, 2].filter((index) => index !== confirmedIndex));
  assert.equal(completed.status, "COMPLETED");
  assert.equal(completed.build.nextIndex, 3);
  process.stdout.write(completed.build.buildId);
}

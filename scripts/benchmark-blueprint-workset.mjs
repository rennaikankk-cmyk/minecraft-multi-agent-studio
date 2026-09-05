// Deterministic in-process fixtures, not Minecraft or P5 acceptance measurements.
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setImmediate as yieldLoop, setTimeout as delay } from "node:timers/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildBlueprintSkill, SkillFault } from "../packages/skills/dist/index.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputArg = process.argv.indexOf("--output");
const outputPath = outputArg < 0 ? null : path.resolve(process.argv[outputArg + 1]);
const repeats = 20;
const scenarios = ["new", "sparse", "missing-material", "lost-result", "unloaded-cancel"];
const samples = [];
const lag = monitorEventLoopDelay({ resolution: 1 });
lag.enable();
await delay(20);
const memoryBefore = process.memoryUsage();
let peakRss = memoryBefore.rss, peakHeap = memoryBefore.heapUsed;

async function trial(scenario, strategy) {
  const blueprint = { anchor: { x: 0, y: 64, z: 0 }, dimension: "minecraft:overworld", serverProfileId: "fixture",
    cells: Array.from({ length: 16 }, (_, x) => ({ offset: { x, y: 0, z: 0 }, itemName: x === 0 && scenario === "missing-material" ? "glass" : "stone",
      blockClass: "structural", order: x })) };
  const world = blueprint.cells.map((cell, index) => scenario === "new" || scenario === "missing-material" ? null
    : scenario === "sparse" ? index === 0 || index === 15 ? null : cell.itemName
    : scenario === "lost-result" ? index === 15 ? null : cell.itemName : index === 0 ? undefined : null);
  const inventory = new Map([["stone", 64]]);
  let batches = 0, observations = 0, effects = 0, duplicates = 0, retries = 0;
  let final = "UNKNOWN", completed = false, abortedAt = null, settledAt = null;
  const controller = new AbortController();
  const snapshot = () => ({ snapshotId: randomUUID(), observedAt: new Date().toISOString(), playerPosition: { x: 0, y: 64, z: 0 },
    cells: blueprint.cells.map((cell, index) => ({ state: world[index] === undefined ? "unknown" : world[index] === cell.itemName ? "match" : "different",
      observedItemName: world[index] ?? null, reachable: true, supportUnknown: false,
      workfaces: [{ referenceBlock: { x: index, y: 63, z: 0 }, face: { x: 0, y: 1, z: 0 } }] })),
    availableMaterials: [...inventory].map(([itemName, count]) => ({ itemName, count })) });
  const context = { signal: controller.signal,
    // The fixture admits its whole line; no game reach or pathfinding performance is modeled.
    policy: { serverProfileId: "fixture", checkBlockReach: () => ({ allowed: true }), checkAttackReach: () => ({ allowed: false }) },
    callCapability: async (_capability, operation, input) => {
      if (operation.startsWith("blueprint.inspect")) {
        observations++;
        const seen = snapshot();
        return operation === "blueprint.inspect-workset" ? seen : { states: seen.cells.map((c) => c.state), observedAt: seen.observedAt };
      }
      if (operation !== "block.place-safe") throw new Error("unexpected fixture operation");
      if ((inventory.get(input.itemName) ?? 0) < 1) throw new SkillFault("BUILD_MATERIAL_MISSING");
      if (world[input.blueprintIndex] === input.itemName) duplicates++;
      world[input.blueprintIndex] = input.itemName;
      inventory.set(input.itemName, inventory.get(input.itemName) - 1);
      effects++;
      return { placed: true, placedBlockName: input.itemName, position: input.target };
    } };
  const started = performance.now();
  for (; batches < 16;) {
    batches++;
    try {
      const result = await buildBlueprintSkill.execute(context, { blueprint, strategy, reconcile: true,
        maxPlacements: scenario === "new" ? 128 : 2 }, {});
      completed = result.completed;
      final = completed ? "COMPLETE" : result.workset?.status ?? "PARTIAL";
      if (completed || final.startsWith("WAITING")) break;
    } catch (error) { final = error.code ?? "ERROR"; break; }
  }
  if (scenario === "unloaded-cancel") {
    abortedAt = performance.now();
    controller.abort();
    const before = effects;
    try { await buildBlueprintSkill.execute(context, { blueprint, strategy, reconcile: true }, {}); }
    catch { /* cancellation or unknown-world refusal; neither is completion */ }
    settledAt = performance.now();
    if (effects !== before) throw new Error("new effect after cancellation");
  }
  if (scenario === "lost-result" && duplicates !== 0) throw new Error("replayed confirmed cell");
  return { scenario, strategy, completed, final, batches, observations, effects, duplicates, retries,
    netVerifiedCells: effects, consumedMaterials: effects, elapsedMs: performance.now() - started,
    cancelToSettledMs: abortedAt === null ? null : settledAt - abortedAt };
}

// Interleave baseline/candidate to reduce ordering bias; retain failed/waiting runs.
for (let repeat = 0; repeat < repeats; repeat++) for (const scenario of scenarios) {
  for (const strategy of repeat % 2 ? ["workset", "linear"] : ["linear", "workset"]) {
    samples.push(await trial(scenario, strategy));
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss); peakHeap = Math.max(peakHeap, memory.heapUsed);
    await yieldLoop();
  }
}
await delay(20);
lag.disable();
const percentile = (values, q) => [...values].sort((a, b) => a - b)[Math.max(0, Math.ceil(values.length * q) - 1)];
const groups = scenarios.flatMap((scenario) => ["linear", "workset"].map((strategy) => {
  const rows = samples.filter((row) => row.scenario === scenario && row.strategy === strategy);
  const average = (field) => rows.reduce((sum, row) => sum + row[field], 0) / rows.length;
  return { scenario, strategy, trials: rows.length, completed: rows.filter((row) => row.completed).length,
    finalStates: [...new Set(rows.map((row) => row.final))], averageBatches: average("batches"), averageObservations: average("observations"),
    averageNetVerifiedCells: average("netVerifiedCells"), averageMaterialConsumption: average("consumedMaterials"),
    duplicateEffects: rows.reduce((sum, row) => sum + row.duplicates, 0), retries: rows.reduce((sum, row) => sum + row.retries, 0),
    elapsedP50Ms: percentile(rows.map((row) => row.elapsedMs), 0.5), elapsedP95Ms: percentile(rows.map((row) => row.elapsedMs), 0.95),
    cancelToSettledP95Ms: scenario === "unloaded-cancel" ? percentile(rows.map((row) => row.cancelToSettledMs), 0.95) : null };
}));
const report = { schemaVersion: "1.0", kind: "simulated-world-algorithm-probe", generatedAt: new Date().toISOString(),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  dirty: !!execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim(),
  node: process.version, repeatsPerScenarioAndStrategy: repeats, groups,
  eventLoop: { scope: "combined fixture harness, not Runtime or L0", p95Ms: lag.percentile(95) / 1e6, p99Ms: lag.percentile(99) / 1e6 },
  memory: { scope: "combined process, no forced GC or 30-minute stability test", before: memoryBefore, after: process.memoryUsage(), peakRss, peakHeap },
  limitations: ["No Minecraft connection, game version, navigation, network latency or physical placement cost is modeled.",
    "Waiting/error trials remain in the denominator; no retry is injected to turn them into success.",
    "Cancellation measures a quiescent fixture, not an in-flight server action or L0 preemption.",
    "The unknown-cell scenario permits independent known cells in workset mode; it is never complete.",
    "No P5, 1/5/10 Bot, or real-world 20% speedup gate is established by this probe."],
};
const json = JSON.stringify(report, null, 2) + "\n";
if (outputPath) { mkdirSync(path.dirname(outputPath), { recursive: true }); writeFileSync(outputPath, json); }
process.stdout.write(json);

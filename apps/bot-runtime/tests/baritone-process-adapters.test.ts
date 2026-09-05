import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { farmMaintainInputSchema, clearAreaInputSchema, navigationGoalInputSchema, followEntityInputSchema,
  exploreInputSchema, elytraInputSchema, type FarmCell } from "@minecraft-studio/skills";
import { maintainFarm, type FarmMaintenancePort } from "../src/farm-maintenance-adapter.js";
import { clearWorkArea } from "../src/clear-area-adapter.js";
import { navigationGoal, runNavigationGoal, followEntity, exploreChunks, type NavigationProcessPort } from "../src/navigation-process-adapter.js";
import { glideToLanding } from "../src/elytra-process-adapter.js";

const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
const position = { x: 0, y: 64, z: 0 };
const area = { ...scope, min: position, max: position };
function farmFixture() {
  let cell: FarmCell = { position, blockName: "wheat", age: 7, belowName: "farmland", aboveName: "air", facing: null };
  const inventory = new Map([["wheat_seeds", 3]]);
  let cancelled = false;
  const port: FarmMaintenancePort = {
    inspect: () => cell, inventory: () => inventory,
    assertActive: () => { if (cancelled) throw new Error("cancelled"); },
    approach: vi.fn(async () => {}),
    harvest: vi.fn(async () => { cell = { ...cell, blockName: "air", age: null }; inventory.set("wheat", 1); }),
    plant: vi.fn(async () => { cell = { ...cell, blockName: "wheat", age: 0 }; inventory.set("wheat_seeds", inventory.get("wheat_seeds")! - 1); }),
    bonemeal: vi.fn(async () => {}), collectDrops: vi.fn(async () => {}), yield: vi.fn(async () => {}),
  };
  return { port, inventory, cancel: () => { cancelled = true; }, setCell: (value: Partial<FarmCell>) => { cell = { ...cell, ...value }; } };
}
describe("bounded farming", () => {
  it("harvests, verifies replanting, and reports measured inventory delta", async () => {
    const f = farmFixture();
    const result = await maintainFarm(f.port, farmMaintainInputSchema.parse({ area, crops: ["wheat"] }));
    expect(result).toMatchObject({ status: "PASS_COMPLETE", harvested: 1, planted: 1,
      inventoryDelta: [{ itemName: "wheat", delta: 1 }, { itemName: "wheat_seeds", delta: -1 }] });
  });
  it("reserves the replant action and seeds before digging", async () => {
    const f = farmFixture();
    expect(await maintainFarm(f.port, farmMaintainInputSchema.parse({ area, crops: ["wheat"], maxActions: 1 }))).toMatchObject({ status: "BATCH_LIMIT", harvested: 0 });
    f.inventory.set("wheat_seeds", 1);
    expect(await maintainFarm(f.port, farmMaintainInputSchema.parse({ area, crops: ["wheat"] }))).toMatchObject({ status: "WAITING_SEEDS", harvested: 0 });
    expect(f.port.harvest).not.toHaveBeenCalled();
  });
  it("reobserves after movement and stops replanting after cancellation", async () => {
    const f = farmFixture();
    f.port.approach = async () => { f.setCell({ age: 0 }); };
    await maintainFarm(f.port, farmMaintainInputSchema.parse({ area, crops: ["wheat"] }));
    expect(f.port.harvest).not.toHaveBeenCalled();
    const second = farmFixture();
    second.port.collectDrops = async () => { second.cancel(); };
    await expect(maintainFarm(second.port, farmMaintainInputSchema.parse({ area, crops: ["wheat"] }))).rejects.toThrow("cancelled");
    expect(second.port.plant).not.toHaveBeenCalled();
  });
  it("yields even when every scanned cell is unknown", async () => {
    const f = farmFixture(); f.setCell({ blockName: null });
    const result = await maintainFarm(f.port, farmMaintainInputSchema.parse({ area: { ...area, max: { ...position, x: 31 } }, crops: ["wheat"] }));
    expect(result).toMatchObject({ status: "WAITING_OBSERVATION", unknownCells: 32 });
    expect(f.port.yield).toHaveBeenCalledTimes(2);
  });
  it("rejects a claimed harvest without a changed world block", async () => {
    const f = farmFixture(); f.port.harvest = async () => {};
    await expect(maintainFarm(f.port, farmMaintainInputSchema.parse({ area, crops: ["wheat"] }))).rejects.toMatchObject({ code: "FARM_READBACK_MISMATCH" });
  });
});

describe("clear area verification", () => {
  it("requires full final inspection; unselected and unknown cells prevent completion", async () => {
    let stone = true;
    const input = clearAreaInputSchema.parse({ area: { ...area, max: { ...position, x: 2 } }, blockNames: ["stone"] });
    const result = await clearWorkArea(input, { assertActive: () => {}, approach: async () => {}, wait: async () => {},
      inspect: (p) => ({ name: p.x === 0 ? stone ? "stone" : "air" : p.x === 1 ? "chest" : null, safe: true }),
      dig: async () => { stone = false; } });
    expect(result).toMatchObject({ completed: false, status: "WAITING_OBSERVATION", broken: 1, remaining: 1, unknown: 1, blocked: 1 });
  });
});

function navigationFixture(): NavigationProcessPort & { advance(ms: number): void } {
  let now = 0;
  const bot = { entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {},
    pathfinder: { setGoal: vi.fn() }, world: { getColumn: () => null } } as unknown as Bot;
  return { bot, assertActive: () => {}, goto: vi.fn(async () => {}), stop: vi.fn(), now: () => now,
    wait: async (ms) => { now += ms; }, advance: (ms) => { now += ms; } };
}
describe("navigation process observations", () => {
  it("uses existing goal predicates for combinations, inversion, and final arrival", async () => {
    const port = navigationFixture();
    const input = navigationGoalInputSchema.parse({ ...scope, combine: "all", clauses: [
      { kind: "y", position }, { kind: "near", position, radius: 2 } ] });
    expect(navigationGoal(input).isEnd({ x: 0, y: 64, z: 0 } as never)).toBe(true);
    expect(await runNavigationGoal(port, input)).toMatchObject({ reached: true });
    const far = navigationGoalInputSchema.parse({ ...scope, clauses: [{ kind: "block", position: { ...position, x: 10 } }] });
    await expect(runNavigationGoal(port, far)).rejects.toMatchObject({ code: "PATH_TARGET_NOT_REACHED" });
  });
  it("treats an entity replacement as loss and releases its own goal", async () => {
    const port = navigationFixture();
    port.bot.entities[3] = { position: new Vec3(1, 64, 0), isValid: true } as never;
    port.wait = async (ms) => { port.advance(ms); port.bot.entities[3] = { position: new Vec3(1, 64, 0) } as never; };
    const result = await followEntity(port, followEntityInputSchema.parse({ ...scope, entityId: 3, durationMs: 1000 }));
    expect(result).toMatchObject({ completed: false, status: "TARGET_LOST" });
    expect(port.stop).toHaveBeenCalledOnce();
  });
  it("does not trust a submitted visited checkpoint for unloaded chunks", async () => {
    const port = navigationFixture();
    const result = await exploreChunks(port, exploreInputSchema.parse({ ...scope, center: { x: 0, z: 0 }, radiusChunks: 0, visited: [{ x: 0, z: 0 }] }));
    expect(result).toMatchObject({ completed: false, status: "WAITING_OBSERVATION", visited: [] });
  });
  it("does not complete a tracking interval when the follower never gets close", async () => {
    const port = navigationFixture();
    port.bot.entities[3] = { position: new Vec3(20, 64, 0), isValid: true } as never;
    const result = await followEntity(port, followEntityInputSchema.parse({ ...scope, entityId: 3, durationMs: 100 }));
    expect(result).toMatchObject({ completed: false, status: "WAITING_PATH", nearTargetMs: 0 });
  });
  it("refuses to start a flight without usable equipment", async () => {
    const port = navigationFixture();
    Object.assign(port.bot, { inventory: { slots: [] }, getEquipmentDestSlot: () => 6 });
    await expect(glideToLanding(port, elytraInputSchema.parse({ ...scope, target: position }))).rejects.toMatchObject({ code: "ELYTRA_NOT_EQUIPPED" });
  });
  it("accepts a glide only after grounded arrival at the validated landing", async () => {
    const port = navigationFixture();
    Object.assign(port.bot, { inventory: { slots: { 6: { name: "elytra", durabilityUsed: 1 } } },
      getEquipmentDestSlot: () => 6, registry: { itemsByName: { elytra: { maxDurability: 432 } } },
      blockAt: (p: Vec3) => ({ name: p.y < 64 ? "stone" : "air", boundingBox: p.y < 64 ? "block" : "empty" }),
      lookAt: vi.fn(async () => {}), elytraFly: vi.fn(async () => {}) });
    Object.assign(port.bot.entity, { position: new Vec3(0.5, 72, 0.5), onGround: false, elytraFlying: true });
    port.wait = async (ms) => { port.advance(ms); Object.assign(port.bot.entity, { position: new Vec3(10.5, 64, 0.5), onGround: true }); };
    expect(await glideToLanding(port, elytraInputSchema.parse({ ...scope, target: { x: 10, y: 64, z: 0 } }))).toMatchObject({ landed: true, reached: true });
  });
});

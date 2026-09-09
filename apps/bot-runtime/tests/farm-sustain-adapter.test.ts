import { describe, expect, it } from "vitest";
import { farmSustainInputSchema, farmSustainOutputSchema, foodFarmLayout } from '@minecraft-studio/skills';
import { type WorkPosition } from '@minecraft-studio/asset-policy';
import { sustainFarm, type FoodFarmPort } from "../src/farm-sustain-adapter.js";

const input = farmSustainInputSchema.parse({ serverProfileId: "isolated", dimension: "minecraft:overworld",
  center: { x: 0, y: 64, z: 0 }, seedReserve: 8, foodReserve: 8, maxActions: 64 });
function fixture() {
  const layout = foodFarmLayout(input.center);
  const names = new Map<string, string>();
  const ages = new Map<string, number>();
  const key = (p: WorkPosition) => `${p.x},${p.y},${p.z}`;
  const bag = new Map<string, number>([["carrot", 64]]);
  let stored = 0, cancelled = false;
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) names.set(key({ x, y: 63, z }), "farmland");
  names.set(key(layout.water), "water");
  for (const p of layout.fences) names.set(key(p), "oak_fence");
  names.set(key(layout.gate), "oak_fence_gate");
  for (const p of layout.lights) names.set(key(p), "torch");
  names.set(key(layout.storage), "barrel");
  const name = (p: WorkPosition) => names.get(key(p)) ?? "air";
  const port: FoodFarmPort = {
    farm: {
      inventory: () => bag, assertActive: () => { if (cancelled) throw new Error("cancelled"); },
      inspect: (p) => ({ position: p, blockName: name(p), age: ages.get(key(p)) ?? (name(p) === "carrots" ? 0 : null),
        belowName: name({ ...p, y: p.y - 1 }), aboveName: name({ ...p, y: p.y + 1 }), facing: null }),
      approach: async () => {},
      harvest: async (cell) => { names.delete(key(cell.position)); bag.set("carrot", bag.get("carrot")! + 3); },
      plant: async (crop, cell) => { names.set(key(cell.position), crop); ages.set(key(cell.position), 0); bag.set("carrot", bag.get("carrot")! - 1); },
      bonemeal: async () => {}, collectDrops: async () => {}, yield: async () => {},
    },
    inspect: (p) => ({ name: name(p), solid: name(p) === "farmland", light: 15, moisture: 7, source: name(p) === "water", open: false }),
    ensure: async (p, n) => { names.set(key(p), n); }, irrigate: async () => { names.set(key(layout.water), "water"); },
    enter: async () => {}, leave: async () => {},
    store: async (retain) => {
      const before = stored, count = bag.get("carrot")!;
      const delta = count > retain ? count - retain : -Math.min(retain - count, stored);
      stored += delta; bag.set("carrot", count - delta);
      return { before, after: stored, deposited: Math.max(0, delta), withdrawn: Math.max(0, -delta), full: false };
    },
  };
  return { port, bag, names, key, stock: () => stored, cancel: () => { cancelled = true; },
    mature: () => { for (const [id, n] of names) if (n === "carrots") ages.set(id, 7); } };
}

describe("food facility lifecycle (simulated growth)", () => {
  it("plants, preserves reserves and deposits actual surplus across repeated harvests and eating", async () => {
    const f = fixture();
    const planted = farmSustainOutputSchema.parse(await sustainFarm(f.port, input));
    expect(planted).toMatchObject({ status: "PASS_COMPLETE", maintenance: { planted: 24 },
      supply: { plantedPlots: 24, hydratedPlots: 24, seedReserved: 8, foodReserved: 8, storageBefore: 0, storageAfter: 24, inventoryFood: 16 } });
    for (let cycle = 0; cycle < 3; cycle++) {
      f.bag.set("carrot", f.bag.get("carrot")! - 4);
      const before = f.stock() + f.bag.get("carrot")!;
      f.mature();
      const result = farmSustainOutputSchema.parse(await sustainFarm(f.port, input));
      expect(result).toMatchObject({ status: "PASS_COMPLETE", maintenance: { harvested: 24, planted: 24 },
        supply: { seedReserved: 8, foodReserved: 8, inventoryFood: 16, deposited: 49, withdrawn: 5 } });
      expect(f.stock() + f.bag.get("carrot")!).toBe(before + 48);
    }
  });
  it("reports missing reserves and never consumes the protected seed and food floor", async () => {
    const f = fixture(); f.bag.set("carrot", 16);
    expect(await sustainFarm(f.port, input)).toMatchObject({ status: "WAITING_SEEDS", maintenance: { planted: 0 }, supply: { deposited: 0, inventoryFood: 16 } });
  });
  it("rechecks enclosure after storage instead of declaring a breached farm ready", async () => {
    const f = fixture(), store = f.port.store;
    f.port.store = async (retain) => { const result = await store(retain); f.names.delete(f.key(foodFarmLayout(input.center).fences[0]!)); return result; };
    expect(await sustainFarm(f.port, input)).toMatchObject({ status: "WAITING_INFRASTRUCTURE", supply: { enclosureReady: false } });
  });
  it("does not perform storage or planting after cancellation", async () => {
    const f = fixture(); f.port.enter = async () => { f.cancel(); };
    await expect(sustainFarm(f.port, input)).rejects.toThrow("cancelled");
    expect(f.stock()).toBe(0);
  });
});

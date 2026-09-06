import { describe, expect, it } from "vitest";
import { farmSustainInputSchema } from "../src/farm-sustain.js";
import { sustainFarm, type FoodFarmPort } from "../../apps/bot-runtime/src/farm-sustain-adapter.js";

describe("food facility lifecycle", () => {
  it("keeps water, lights and enclosure ready while recording harvest and storage", async () => {
    const input = farmSustainInputSchema.parse({ serverProfileId: "isolated", dimension: "minecraft:overworld", center: { x: 0, y: 64, z: 0 }, seedReserve: 1, foodReserve: 4, maxActions: 56 });
    const names = new Map<string, string>();
    const key = (p: { x: number; y: number; z: number }) => `${p.x},${p.y},${p.z}`;
    const layoutNames = new Set(["oak_fence", "oak_fence_gate", "torch"]);
    const inventory = new Map<string, number>([["carrot", 64], ["stone_hoe", 1]]);
    const farm = {
      inventory: () => inventory,
      assertActive: () => undefined,
      inspect: (p: { x: number; y: number; z: number }) => ({ position: p, blockName: names.get(key(p)) ?? "air", age: null, belowName: "farmland", aboveName: "air", facing: null }),
      approach: async () => undefined,
      harvest: async () => undefined,
      plant: async (crop: string, p: { x: number; y: number; z: number }) => { names.set(key(p), crop); },
      bonemeal: async () => undefined,
      collectDrops: async () => undefined,
      yield: async () => undefined,
    };
    const port = {
      farm,
      inspect: (p) => {
        const name = names.get(key(p)) ?? (p.y === 63 ? "farmland" : "air");
        const source = p.x === 0 && p.y === 63 && p.z === 0;
        return { name, solid: name !== "air", light: 15, moisture: 7, source, open: false };
      },
      ensure: async (p, name) => { names.set(key(p), name); },
      irrigate: async () => { names.set("0,63,0", "water"); },
      enter: async () => undefined,
      leave: async () => undefined,
      store: async (_p, retain) => {
        const before = inventory.get("carrot") ?? 0;
        const moved = Math.max(0, before - retain);
        inventory.set("carrot", before - moved);
        return { before, after: before - moved, deposited: moved, withdrawn: 0, full: false };
      },
    } satisfies FoodFarmPort;
    const result = await sustainFarm(port, input);
    expect(["PASS_COMPLETE", "WAITING_SEEDS"]).toContain(result.status);
    expect(result.supply.enclosureReady).toBe(true);
    expect(result.supply.lightingReady).toBe(true);
    expect(result.supply.waterReady).toBe(true);
    expect(result.supply.storageBefore).toBeTypeOf("number");
    expect(result.supply.storageAfter).toBeTypeOf("number");
  });
});

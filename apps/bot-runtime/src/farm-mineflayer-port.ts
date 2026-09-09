import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { setTimeout as delay } from "node:timers/promises";
import { cropRules, SkillFault, type FarmCell, type FarmMaintainInput } from '@minecraft-studio/skills';
import { withinWorkArea, type WorkPosition } from '@minecraft-studio/asset-policy';
import type { FarmMaintenancePort } from "./farm-maintenance-adapter.js";

const vector = (p: WorkPosition) => new Vec3(p.x, p.y, p.z);
const directions = { north: new Vec3(0, 0, -1), south: new Vec3(0, 0, 1), east: new Vec3(1, 0, 0), west: new Vec3(-1, 0, 0) };

export function createFarmPort(bot: Bot, input: FarmMaintainInput, dependencies: {
  signal: AbortSignal;
  assertActive(): void;
  assertEffect(position: WorkPosition, harvest: boolean): Promise<void>;
  approach(position: WorkPosition): Promise<void>;
  approachPickup(position: WorkPosition): Promise<void>;
}): FarmMaintenancePort {
  let pendingHarvest: { position: WorkPosition; itemName: string; before: number } | null = null;
  const inventory = () => {
    const counts = new Map<string, number>();
    for (const item of bot.inventory.items()) counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    return counts;
  };
  const inspect = (position: WorkPosition): FarmCell => {
    const block = bot.blockAt(vector(position));
    const properties = block?.getProperties();
    const facing = properties?.facing;
    // Prismarine exposes some integer block-state enums as decimal strings.
    const rawAge = properties?.age;
    const age = typeof rawAge === "number" ? rawAge
      : typeof rawAge === "string" && /^\d+$/u.test(rawAge) ? Number(rawAge) : NaN;
    return { position, blockName: block?.name ?? null,
      age: Number.isSafeInteger(age) && age >= 0 ? age : null,
      facing: facing === "north" || facing === "south" || facing === "east" || facing === "west" ? facing : null,
      belowName: bot.blockAt(vector(position).offset(0, -1, 0))?.name ?? null,
      aboveName: bot.blockAt(vector(position).offset(0, 1, 0))?.name ?? null };
  };
  const equip = async (name: string) => {
    const item = bot.inventory.items().find((candidate) => candidate.name === name);
    if (!item) throw new SkillFault("FARM_SEEDS_EXHAUSTED");
    dependencies.assertActive();
    await bot.equip(item, "hand");
    dependencies.assertActive();
  };
  const assertEffect = async (position: WorkPosition, harvest = false) => {
    dependencies.assertActive();
    if (!withinWorkArea(input.area, position)) throw new SkillFault("WORK_AREA_VIOLATION");
    if (bot.entity.position.distanceTo(vector(position)) > 5) throw new SkillFault("WORK_TARGET_OUT_OF_REACH");
    await dependencies.assertEffect(position, harvest);
    dependencies.assertActive();
  };
  return {
    inspect, inventory, assertActive: dependencies.assertActive, approach: dependencies.approach,
    till: async (cell) => {
      const soil = { ...cell.position, y: cell.position.y - 1 };
      const hoe = bot.inventory.items().find((item) => item.name.endsWith("_hoe"));
      if (!hoe) throw new SkillFault("FARM_HOE_REQUIRED");
      await equip(hoe.name);
      await assertEffect(soil);
      const block = bot.blockAt(vector(soil));
      const above = bot.blockAt(vector(cell.position));
      if (!block || !["dirt", "grass_block"].includes(block.name) || !above || !["air", "cave_air"].includes(above.name)) {
        throw new SkillFault("FARM_SUBSTRATE_MISMATCH");
      }
      await bot.activateBlock(block, new Vec3(0, 1, 0));
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(50, undefined, { signal: dependencies.signal });
        dependencies.assertActive();
        if (bot.blockAt(vector(soil))?.name === "farmland") return;
      }
      throw new SkillFault("FARM_TILLING_UNCONFIRMED");
    },
    harvest: async (cell) => {
      await assertEffect(cell.position, true);
      const block = bot.blockAt(vector(cell.position));
      if (!block || block.name !== cell.blockName) throw new SkillFault("FARM_READBACK_MISMATCH");
      const rule = cropRules[block.name as keyof typeof cropRules];
      if (!rule) throw new SkillFault("FARM_READBACK_MISMATCH");
      pendingHarvest = { position: cell.position, itemName: rule.itemName, before: inventory().get(rule.itemName) ?? 0 };
      await bot.dig(block);
    },
    plant: async (crop, cell) => {
      const rule = cropRules[crop];
      if (!rule.seedItem) throw new SkillFault("FARM_CROP_NOT_PLANTABLE");
      const face = crop === "cocoa" && cell.facing ? directions[cell.facing].scaled(-1) : new Vec3(0, 1, 0);
      if (crop === "cocoa" && !cell.facing) throw new SkillFault("FARM_OBSERVATION_UNAVAILABLE");
      const reference = bot.blockAt(vector(cell.position).minus(face));
      if (!reference || reference.name !== rule.substrate) throw new SkillFault("FARM_SUBSTRATE_MISMATCH");
      await equip(rule.seedItem);
      await assertEffect(cell.position);
      await bot.placeBlock(reference, face);
    },
    bonemeal: async (cell) => {
      await equip("bone_meal");
      await assertEffect(cell.position);
      const block = bot.blockAt(vector(cell.position));
      if (!block || block.name !== cell.blockName) throw new SkillFault("FARM_READBACK_MISMATCH");
      const before = inventory().get("bone_meal") ?? 0;
      await bot.activateBlock(block);
      for (let attempt = 0; attempt < 20; attempt++) {
        await delay(50, undefined, { signal: dependencies.signal });
        dependencies.assertActive();
        if ((inventory().get("bone_meal") ?? 0) < before && inspect(cell.position).blockName === cell.blockName) return;
      }
      throw new SkillFault("FARM_BONEMEAL_UNCONFIRMED");
    },
    collectDrops: async (position) => {
      dependencies.assertActive();
      const receipt = pendingHarvest;
      if (!receipt || vector(receipt.position).distanceTo(vector(position)) !== 0) throw new SkillFault("FARM_DROPS_UNCONFIRMED");
      const received = () => (inventory().get(receipt.itemName) ?? 0) > receipt.before;
      // Walking stays in the selected farm. Never chase unrelated drops outside the selection.
      if (!received() && withinWorkArea(input.area, position)) await dependencies.approachPickup(position);
      for (let attempt = 0; attempt < 40; attempt++) {
        dependencies.assertActive();
        if (received()) { pendingHarvest = null; return; }
        await delay(50, undefined, { signal: dependencies.signal });
      }
      if (received()) { pendingHarvest = null; return; }
      throw new SkillFault("FARM_DROPS_UNCONFIRMED");
    },
    yield: async () => { await delay(0, undefined, { signal: dependencies.signal }); },
  };
}

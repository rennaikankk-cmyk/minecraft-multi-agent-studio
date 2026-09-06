import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { SkillFault, foodFarmLayout, type FarmSustainInput, type WorkPosition } from "@minecraft-studio/skills";
import type { FarmMaintenancePort } from "./farm-maintenance-adapter.js";
import type { FoodFarmPort } from "./farm-sustain-adapter.js";

const v = (p: WorkPosition) => new Vec3(p.x, p.y, p.z);
const air = (name: string) => ["air", "cave_air", "void_air"].includes(name);

export function createFoodFarmPort(bot: Bot, input: FarmSustainInput, farm: FarmMaintenancePort, dependencies: {
  assertEffect(position: WorkPosition): Promise<void>;
  approach(position: WorkPosition): Promise<void>;
  goto(position: WorkPosition): Promise<void>;
  wait(ms: number): Promise<void>;
  store(position: WorkPosition, retain: number): ReturnType<FoodFarmPort["store"]>;
}): FoodFarmPort {
  const layout = foodFarmLayout(input.center);
  const read = (position: WorkPosition) => bot.blockAt(v(position));
  const inspect: FoodFarmPort["inspect"] = (position) => {
    const b = read(position);
    if (!b) return null;
    const p = b.getProperties();
    return { name: b.name, solid: b.boundingBox === "block", light: b.light, moisture: Number(p.moisture ?? -1),
      source: b.name === "water" && Number(p.level) === 0, open: p.open === true || p.open === "true" };
  };
  const confirm = async (condition: () => boolean) => {
    for (let attempt = 0; attempt < 40; attempt++) {
      farm.assertActive();
      if (condition()) return;
      await dependencies.wait(50);
    }
    throw new SkillFault("FARM_READBACK_MISMATCH");
  };
  const equip = async (name: string) => {
    farm.assertActive();
    const item = bot.inventory.items().find((i) => i.name === name);
    if (!item) throw new SkillFault("FARM_MATERIAL_REQUIRED", `FARM_MATERIAL_REQUIRED:${name}`);
    await bot.equip(item, "hand"); farm.assertActive();
  };
  const effect = async (position: WorkPosition) => {
    farm.assertActive();
    await dependencies.assertEffect(position);
    if (bot.entity.position.distanceTo(v(position)) > 5) throw new SkillFault("WORK_TARGET_OUT_OF_REACH");
    farm.assertActive();
  };
  const setGate = async (open: boolean) => {
    if (inspect(layout.gate)?.open === open) return;
    await dependencies.approach(layout.gate);
    await effect(layout.gate);
    const gate = read(layout.gate);
    if (gate?.name !== "oak_fence_gate") throw new SkillFault("FARM_READBACK_MISMATCH");
    await bot.activateBlock(gate);
    await confirm(() => inspect(layout.gate)?.open === open);
  };
  const cross = async (inside: boolean) => {
    const p = bot.entity.position;
    const alreadyInside = p.x > input.center.x - 3 && p.x < input.center.x + 3 && p.z > input.center.z - 3 && p.z < input.center.z + 3;
    if (alreadyInside !== inside) {
      await setGate(true);
      await dependencies.goto(inside ? layout.inside : layout.outside);
    }
    await setGate(false);
  };
  return { farm, inspect, enter: () => cross(true), leave: () => cross(false),
    ensure: async (position, name) => {
      const cell = read(position);
      if (!cell) throw new SkillFault("FARM_OBSERVATION_UNAVAILABLE");
      if (cell.name === name) return;
      if (!air(cell.name)) throw new SkillFault("FARM_SITE_OCCUPIED");
      const support = read({ ...position, y: position.y - 1 });
      if (!support || support.boundingBox !== "block") {
        // The central slab attaches to the side of the surrounding soil.
        if (name !== "cobblestone_slab") throw new SkillFault("FARM_SITE_UNSUPPORTED");
      }
      await dependencies.approach(support?.boundingBox === "block" ? support.position : { ...position, x: position.x + 1, y: position.y - 1 });
      await equip(name);
      await effect(position);
      if (name === "oak_fence_gate") await bot.look(0, 0, true);
      if (name === "cobblestone_slab" && support?.boundingBox !== "block") {
        // Place on the upper soil face next to the channel only if there is an
        // adjacent solid block at crop height; otherwise use a waterlogged slab.
        const reference = read(layout.water);
        if (!reference || reference.name !== "water") throw new SkillFault("FARM_SITE_UNSUPPORTED");
        await bot.placeBlock(reference, new Vec3(0, 1, 0));
      } else {
        await bot.placeBlock(support!, new Vec3(0, 1, 0));
      }
      await confirm(() => inspect(position)?.name === name);
    },
    irrigate: async () => {
      if (inspect(layout.water)?.source) return;
      if (!bot.inventory.items().some((i) => i.name === "water_bucket")) {
        const source = input.waterSource;
        if (!source || !inspect(source)?.source || !inspect({ ...source, y: source.y - 1 })?.solid ||
          [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].filter((d) => inspect(v(source).plus(d))?.source).length < 2) {
          throw new SkillFault("FARM_WATER_BUCKET_REQUIRED");
        }
        await dependencies.approach({ ...source, y: source.y - 1 });
        await equip("bucket"); await effect(source);
        await bot.lookAt(v(source).offset(0.5, 0.5, 0.5), true);
        bot.activateItem();
        await confirm(() => bot.inventory.items().some((i) => i.name === "water_bucket"));
        bot.deactivateItem();
        await confirm(() => inspect(source)?.source === true);
      }
      const water = read(layout.water);
      if (!water) throw new SkillFault("FARM_OBSERVATION_UNAVAILABLE");
      // A sealed, one-block channel must be confirmed before opening soil.
      for (const delta of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, -1, 0)]) {
        if (!inspect(v(layout.water).plus(delta))?.solid) throw new SkillFault("FARM_WATER_SOURCE_UNSAFE");
      }
      await dependencies.approach(layout.water);
      if (["dirt", "grass_block", "farmland"].includes(water.name)) {
        await effect(layout.water); await bot.dig(water);
      } else if (!air(water.name) && water.name !== "water") throw new SkillFault("FARM_SITE_OCCUPIED");
      await equip("water_bucket"); await effect(layout.water);
      const below = read({ ...layout.water, y: layout.water.y - 1 });
      if (!below) throw new SkillFault("FARM_OBSERVATION_UNAVAILABLE");
      await bot.activateBlock(below, new Vec3(0, 1, 0));
      await confirm(() => inspect(layout.water)?.source === true && !bot.heldItem?.name.startsWith("water_bucket"));
    },
    store: (retain) => dependencies.store(layout.storage, retain),
  };
}

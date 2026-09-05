import { Vec3 } from "vec3";
import { z } from "zod";
import { elytraInputSchema, SkillFault } from "@minecraft-studio/skills";
import { processPosition, type NavigationProcessPort } from "./navigation-process-adapter.js";

const hazardous = new Set(["lava", "water", "fire", "soul_fire", "cactus", "magma_block", "powder_snow", "sweet_berry_bush"]);

/** Straight, loaded descent corridors only. Mineflayer/Prismarine owns all flight physics. */
export async function glideToLanding(port: NavigationProcessPort, input: z.infer<typeof elytraInputSchema>) {
  const bot = port.bot;
  const target = new Vec3(input.target.x + 0.5, input.target.y, input.target.z + 0.5);
  const assertEquipment = () => {
    const item = bot.inventory.slots[bot.getEquipmentDestSlot("torso")];
    if (!item || item.name !== "elytra") throw new SkillFault("ELYTRA_NOT_EQUIPPED");
    const max = bot.registry.itemsByName.elytra?.maxDurability;
    if (!max || typeof item.durabilityUsed !== "number" || max - item.durabilityUsed < input.minimumDurability) {
      throw new SkillFault("ELYTRA_DURABILITY_LOW");
    }
  };
  const empty = (p: Vec3) => {
    const block = bot.blockAt(p.floored());
    if (!block) throw new SkillFault("ELYTRA_CORRIDOR_UNKNOWN");
    if (block.boundingBox !== "empty" || hazardous.has(block.name)) throw new SkillFault("ELYTRA_CORRIDOR_BLOCKED");
  };
  const corridor = (from: Vec3, to: Vec3) => {
    const samples = Math.max(1, Math.ceil(from.distanceTo(to) * 2));
    for (let i = 0; i <= samples; i++) {
      const p = from.plus(to.minus(from).scaled(i / samples));
      for (const dx of [-0.4, 0.4]) for (const dz of [-0.4, 0.4]) {
        empty(p.offset(dx, 0.2, dz)); empty(p.offset(dx, 1.0, dz));
      }
    }
  };
  port.assertActive(); assertEquipment();
  const initial = bot.entity.position.clone();
  const distance = initial.distanceTo(target);
  if (distance > 192 || initial.y - target.y < 4 || initial.y - target.y > 64) throw new SkillFault("ELYTRA_LANDING_OUT_OF_RANGE");
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
    const floor = bot.blockAt(target.offset(dx, -1, dz));
    if (!floor || floor.boundingBox !== "block" || hazardous.has(floor.name)) throw new SkillFault("ELYTRA_LANDING_UNSAFE");
    empty(target.offset(dx, 0, dz)); empty(target.offset(dx, 1, dz));
  }
  corridor(initial, target);
  if (bot.entity.onGround) throw new SkillFault("ELYTRA_AIRBORNE_START_REQUIRED");
  if (!bot.entity.elytraFlying) await bot.elytraFly();
  const started = port.now();
  while (port.now() - started < input.maxFlightMs) {
    port.assertActive(); assertEquipment();
    const position = bot.entity.position;
    if (bot.entity.onGround) {
      if (position.distanceTo(target) > input.radius) throw new SkillFault("ELYTRA_LANDING_MISSED");
      return { landed: true as const, reached: true as const, position: processPosition(bot), observedAt: new Date().toISOString() };
    }
    if (!bot.entity.elytraFlying && port.now() - started > 1000) throw new SkillFault("ELYTRA_FLIGHT_UNCONFIRMED");
    if (position.distanceTo(target) > 200) throw new SkillFault("ELYTRA_LANDING_OUT_OF_RANGE");
    // Reinspect the immediate corridor before changing heading; unloaded blocks never mean air.
    const vector = target.minus(position);
    const ahead = position.plus(vector.scaled(Math.min(8, vector.norm()) / Math.max(0.001, vector.norm())));
    corridor(position, ahead);
    await bot.lookAt(target.offset(0, 0.5, 0), false);
    await port.wait(100);
  }
  throw new SkillFault("ELYTRA_FLIGHT_TIMEOUT");
}

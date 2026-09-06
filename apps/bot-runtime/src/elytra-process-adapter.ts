import { Vec3 } from "vec3";
import { z } from "zod";
import pathfinderModule from "mineflayer-pathfinder";
import { elytraInputSchema, SkillFault } from "@minecraft-studio/skills";
import { processPosition, type NavigationProcessPort } from "./navigation-process-adapter.js";

const hazardous = new Set(["lava", "water", "fire", "soul_fire", "cactus", "magma_block", "powder_snow", "sweet_berry_bush"]);
const fireworksSchema = z.object({ flightDuration: z.number().int().min(1).max(3), explosions: z.array(z.unknown()).max(0) }).strip();

/** Modern Java rockets with known, non-explosive components only. */
export function safeFlightRocket(item: unknown): boolean {
  const parsed = z.object({ name: z.literal("firework_rocket"),
    removedComponents: z.array(z.unknown()).max(0).default([]),
    components: z.array(z.object({ type: z.string(), data: z.unknown() }).strip()) }).strip().safeParse(item);
  if (!parsed.success) return false;
  const fireworks = parsed.data.components.filter((c) => c.type === "fireworks");
  // Modern slots carry a component patch. An unchanged vanilla rocket omits
  // its default fireworks component (duration 1, no explosions).
  return fireworks.length === 0 || fireworks.length === 1 && fireworksSchema.safeParse(fireworks[0]!.data).success;
}

/** Uses Mineflayer's Prismarine flight physics; this loop only selects headings. */
export async function glideToLanding(port: NavigationProcessPort, input: z.infer<typeof elytraInputSchema>) {
  const bot = port.bot, initial = bot.entity.position.clone(), started = port.now();
  const route = [...input.waypoints, input.target].map((p) => new Vec3(p.x + 0.5, p.y, p.z + 0.5));
  const destination = route[route.length - 1]!;
  let previous = initial, routeLength = 0;
  for (const waypoint of route) { routeLength += previous.distanceTo(waypoint); previous = waypoint; }
  if (routeLength > 2048) throw new SkillFault("ELYTRA_LANDING_OUT_OF_RANGE");
  let segment = 0, fireworksUsed = 0, lastRocketAt = -Infinity;
  let emergency: Vec3 | null = null, reason: string | null = null;
  let lastLandingScan = -Infinity, fallback: Vec3 | null = null;
  const items = () => bot.inventory.items?.() ?? [];
  const rocketCount = () => items().filter(safeFlightRocket).reduce((n, item) => n + item.count, 0);
  const assertEquipment = (minimum = input.minimumDurability) => {
    const item = bot.inventory.slots[bot.getEquipmentDestSlot("torso")];
    if (!item || item.name !== "elytra") throw new SkillFault("ELYTRA_NOT_EQUIPPED");
    const max = bot.registry.itemsByName.elytra?.maxDurability;
    if (!max || !Number.isFinite(item.durabilityUsed) || max - item.durabilityUsed < minimum) throw new SkillFault("ELYTRA_DURABILITY_LOW");
  };
  const empty = (p: Vec3) => {
    const block = bot.blockAt(p.floored());
    return !!block && block.boundingBox === "empty" && !hazardous.has(block.name);
  };
  const landingSafe = (target: Vec3) => {
    for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
      const floor = bot.blockAt(target.offset(dx, -1, dz).floored());
      if (!floor || floor.boundingBox !== "block" || hazardous.has(floor.name) || !empty(target.offset(dx, 0, dz)) || !empty(target.offset(dx, 1, dz))) return false;
    }
    return true;
  };
  const corridor = (from: Vec3, to: Vec3) => {
    const samples = Math.max(1, Math.ceil(from.distanceTo(to) * 2));
    if (samples > 80) throw new SkillFault("ELYTRA_CORRIDOR_BUDGET");
    for (let i = 0; i <= samples; i++) {
      const p = from.plus(to.minus(from).scaled(i / samples));
      for (const dx of [-0.4, 0.4]) for (const dz of [-0.4, 0.4]) {
        if (!empty(p.offset(dx, 0.2, dz)) || !empty(p.offset(dx, 1, dz))) return false;
      }
    }
    return true;
  };
  const scanLanding = () => {
    const p = bot.entity.position;
    if (fallback && landingSafe(fallback) && p.distanceTo(fallback) < 96) return;
    fallback = null;
    // Fixed work bound: nine columns, up to 48 blocks of descent.
    for (const [dx, dz] of [[0, 0], [8, 0], [-8, 0], [0, 8], [0, -8], [16, 0], [-16, 0], [0, 16], [0, -16]]) {
      for (let dy = 0; dy <= 48; dy++) {
        const candidate = new Vec3(Math.floor(p.x) + dx! + 0.5, Math.floor(p.y) - dy, Math.floor(p.z) + dz! + 0.5);
        const floor = bot.blockAt(candidate.offset(0, -1, 0).floored());
        if (!floor) break;
        if (floor.boundingBox === "block") {
          if (landingSafe(candidate)) { fallback = candidate; return; }
          break;
        }
      }
    }
  };
  const divert = (code: string) => {
    scanLanding();
    if (!fallback) throw new SkillFault("ELYTRA_EMERGENCY_LANDING_UNAVAILABLE", code);
    emergency = fallback.clone(); reason = code;
  };
  const boost = async () => {
    port.assertActive();
    const before = rocketCount();
    const rocket = items().find(safeFlightRocket);
    if (!rocket || before <= input.rocketReserve || fireworksUsed >= input.maxFireworks) return false;
    await bot.equip(rocket, "hand");
    port.assertActive();
    if (!bot.entity.elytraFlying || !safeFlightRocket(bot.heldItem)) throw new SkillFault("ELYTRA_BOOST_UNSAFE");
    bot.activateItem();
    lastRocketAt = port.now();
    while (port.now() - lastRocketAt < 1500) {
      await port.wait(50);
      const used = before - rocketCount();
      if (used === 1) { fireworksUsed++; bot.deactivateItem(); return true; }
      if (used !== 0) throw new SkillFault("ELYTRA_FIREWORK_READBACK_MISMATCH");
    }
    throw new SkillFault("ELYTRA_FIREWORK_UNCONFIRMED");
  };
  port.assertActive();
  if (input.autoEquip && bot.inventory.slots[bot.getEquipmentDestSlot("torso")]?.name !== "elytra") {
    const elytra = items().find((item) => item.name === "elytra");
    if (elytra) { await bot.equip(elytra, "torso"); port.assertActive(); }
  }
  assertEquipment();
  if (input.useFireworks && rocketCount() < Math.max(input.minimumFireworks, input.rocketReserve + 1)) throw new SkillFault("ELYTRA_FIREWORKS_REQUIRED");
  if (!input.useFireworks && (initial.y - destination.y < 4 || routeLength > 128)) throw new SkillFault("ELYTRA_GLIDE_RANGE_UNSAFE");
  if (bot.entity.onGround) {
    if (!input.useFireworks || !landingSafe(initial)) throw new SkillFault("ELYTRA_TAKEOFF_UNSAFE");
    if (!corridor(initial, initial.offset(0, 6, 0))) throw new SkillFault("ELYTRA_TAKEOFF_BLOCKED");
    await bot.lookAt(route[0]!.offset(0, 24, 0), true);
    port.assertActive();
    bot.setControlState("jump", true);
    while (port.now() - started < 1500 && bot.entity.onGround) await port.wait(50);
    port.assertActive(); bot.setControlState("jump", false);
    if (bot.entity.onGround) throw new SkillFault("ELYTRA_TAKEOFF_FAILED");
  }
  if (!bot.entity.elytraFlying) {
    await bot.elytraFly();
    const requested = port.now();
    while (!bot.entity.elytraFlying && port.now() - requested < 1000 && !bot.entity.onGround) await port.wait(50);
    if (!bot.entity.elytraFlying) throw new SkillFault("ELYTRA_FLIGHT_UNCONFIRMED");
  }
  if (input.useFireworks && bot.entity.position.y < destination.y + 12) await boost();
  const cruiseY = Math.max(initial.y, destination.y + 24);
  while (port.now() - started < input.maxFlightMs + 20_000) {
    port.assertActive();
    const position = bot.entity.position;
    if (bot.entity.onGround) {
      const target = emergency ?? destination;
      const touchdown = processPosition(bot);
      let groundApproachDistance = 0;
      if (!landingSafe(target) || !landingSafe(position)) throw new SkillFault("ELYTRA_LANDING_MISSED");
      if (!emergency && position.distanceTo(target) > input.radius && position.distanceTo(target) <= 24) {
        groundApproachDistance = position.distanceTo(target);
        await port.goto(new pathfinderModule.goals.GoalNear(target.x, target.y, target.z, input.radius - 0.5));
        port.assertActive();
      }
      if (!bot.entity.onGround || bot.entity.position.distanceTo(target) > input.radius) throw new SkillFault("ELYTRA_LANDING_MISSED");
      return { landed: true as const, reached: emergency === null, status: emergency ? "EMERGENCY_LANDED" as const : "TARGET_LANDED" as const,
        reason, touchdown, groundApproachDistance, position: processPosition(bot), segments: segment + 1, distance: initial.distanceTo(bot.entity.position), fireworksUsed, observedAt: new Date().toISOString() };
    }
    if (!bot.entity.elytraFlying) throw new SkillFault("ELYTRA_FLIGHT_LOST");
    assertEquipment(2);
    if (!emergency) {
      try { assertEquipment(); } catch { divert("ELYTRA_DURABILITY_LOW"); }
      if (port.now() - started >= input.maxFlightMs) divert("ELYTRA_FLIGHT_TIMEOUT");
    }
    if (port.now() - lastLandingScan >= 1000) { scanLanding(); lastLandingScan = port.now(); }
    while (!emergency && segment < route.length - 1 && position.distanceTo(route[segment]!) <= 12) segment++;
    let target = emergency ?? route[segment]!;
    const horizontal = Math.hypot(position.x - target.x, position.z - target.z);
    const landing = !!emergency || segment === route.length - 1 && horizontal < 48;
    if (landing && !landingSafe(target) && !emergency) { divert("ELYTRA_LANDING_UNSAFE"); target = emergency!; }
    const aim = landing ? target.offset(0, 0.3, 0) : new Vec3(target.x, Math.max(target.y, cruiseY), target.z);
    const speed = bot.entity.velocity?.norm() ?? 0.5;
    // Limit descent pitch before the target passes underneath. A direct look
    // at the landing block creates a dive and can trigger L0 fall protection.
    aim.y = Math.max(aim.y, position.y - Math.max(1, horizontal) * 0.12);
    if ((bot.entity.velocity?.y ?? 0) < -0.5) aim.y = position.y + Math.max(4, horizontal * 0.25);
    // Flare on approach. The physics engine supplies lift, drag and collisions.
    if (landing && horizontal < 12 && position.y - target.y < 5 && speed > 0.6) aim.y = position.y + 6;
    const vector = aim.minus(position), lookahead = Math.min(32, Math.max(8, speed * 25), vector.norm());
    const ahead = position.plus(vector.scaled(lookahead / Math.max(0.001, vector.norm())));
    if (!corridor(position, ahead)) {
      if (emergency) throw new SkillFault("ELYTRA_EMERGENCY_CORRIDOR_BLOCKED");
      divert("ELYTRA_CORRIDOR_UNSAFE");
      continue;
    }
    await bot.lookAt(aim, false);
    port.assertActive();
    if (!landing && input.useFireworks && port.now() - lastRocketAt >= 3000 && (bot.fireworkRocketDuration ?? 0) === 0 &&
        (speed < 1 || position.y < cruiseY - 8)) {
      if (!await boost()) divert("ELYTRA_FIREWORK_RESERVE");
    }
    await port.wait(100);
  }
  throw new SkillFault("ELYTRA_LANDING_TIMEOUT");
}

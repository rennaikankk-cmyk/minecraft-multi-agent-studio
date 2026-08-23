import type { Bot } from "mineflayer";
import pathfinderModule, { Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { SkillFault } from "@minecraft-studio/skills";

const { goals } = pathfinderModule;

type Position = Readonly<{ x: number; y: number; z: number; dimension: string; serverProfileId: string }>;
type SitePolicy = Readonly<{ minHighwayDistance: number; minPortalLineDistance: number; hazardClearance: number; burialDepthTarget: number }>;
const hazards = new Set(["lava", "fire", "soul_fire", "magma_block", "cactus", "powder_snow"]);
const logs = new Set(["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"]);
function dimension(value: string): string { return value.includes(":") ? value.toLowerCase() : `minecraft:${value.toLowerCase()}`; }
function scope(bot: Bot, profile: string, target: { serverProfileId: string; dimension: string }): void {
  if (target.serverProfileId !== profile) throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
  if (target.dimension !== dimension(String(bot.game.dimension))) throw new SkillFault("TARGET_DIMENSION_MISMATCH");
}
export function observeSite(bot: Bot, profile: string, input: { candidate: Position; policy: SitePolicy }) {
  scope(bot, profile, input.candidate);
  const c = new Vec3(input.candidate.x, input.candidate.y, input.candidate.z);
  let complete = true;
  const samples: { p: Vec3; n: string }[] = [];
  const r = 32;
  for (let x = -r; x <= r; x += 4) for (let z = -r; z <= r; z += 4) {
    const b = bot.blockAt(c.offset(x, 0, z));
    if (!b) complete = false;
    else samples.push({ p: c.offset(x, 0, z), n: b.name });
  }
  const nearest = (pred: (name: string) => boolean): number | null => {
    const distances = samples.filter((sample) => pred(sample.n)).map((sample) => sample.p.distanceTo(c));
    return distances.length ? Math.min(...distances) : r;
  };
  let burial = 0;
  // Burial is protection below the candidate. Sampling upward would measure
  // the roof/sky and could accept an exposed site as deeply buried.
  for (let depth = 1; depth <= Math.ceil(input.policy.burialDepthTarget); depth += 1) {
    const b = bot.blockAt(c.offset(0, -depth, 0));
    if (!b) { complete = false; break; }
    if (b.boundingBox === "empty") break;
    burial += 1;
  }
  const dirs = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
  const escapes = dirs.filter((dir) => {
    const floor = bot.blockAt(c.plus(dir));
    const head = bot.blockAt(c.plus(dir).offset(0, 1, 0));
    if (!floor || !head) { complete = false; return false; }
    return floor.boundingBox === "empty" && head.boundingBox === "empty";
  }).length;
  const entities = Object.values(bot.entities ?? {}) as Array<any>;
  return {
    complete,
    spawnDistance: Math.hypot(c.x, c.z),
    nearestHighwayDistance: Math.min(Math.abs(c.x), Math.abs(c.z)),
    nearestPortalLineDistance: nearest((name) => name === "nether_portal"),
    nearestHazardDistance: nearest((name) => hazards.has(name)),
    resources: {
      wood: Math.min(1, samples.filter((sample) => logs.has(sample.n)).length / 4),
      stone: Math.min(1, samples.filter((sample) => sample.n === "stone" || sample.n === "cobblestone").length / 4),
      water: Math.min(1, samples.filter((sample) => sample.n === "water").length / 4),
      animals: Math.min(1, entities.filter((entity) => ["cow", "pig", "sheep", "chicken"].includes(String(entity.name))).length / 4),
    },
    burialDepth: burial,
    escapeRouteCount: escapes,
    playerTraffic01: Math.min(1, entities.filter((entity) => entity.type === "player" && entity !== bot.entity).length / 4),
  };
}

const directionVector: Readonly<Record<"north" | "east" | "south" | "west", Vec3>> = Object.freeze({
  north: new Vec3(0, 0, -1),
  east: new Vec3(1, 0, 0),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
});

export async function digShelter(
  bot: Bot,
  profile: string,
  input: { direction: "north" | "east" | "south" | "west" | "down"; depth: number; sealItemName: string; dimension: string; serverProfileId: string },
  signal: AbortSignal,
) {
  scope(bot, profile, input);
  if (input.direction === "down") throw new SkillFault("POLICY_STRAIGHT_DOWN_FORBIDDEN");
  if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
  const mutableBot = bot as Bot & {
    canDigBlock?: (block: unknown) => boolean;
    dig?: Bot["dig"];
    placeBlock?: Bot["placeBlock"];
    equip?: Bot["equip"];
    pathfinder?: { goto?: (goal: object) => Promise<void>; stop?: () => void; setMovements?: (movements: Movements) => void };
  };
  if (
    typeof mutableBot.dig !== "function" ||
    typeof mutableBot.placeBlock !== "function" ||
    typeof mutableBot.equip !== "function" ||
    typeof mutableBot.pathfinder?.goto !== "function"
  ) {
    throw new SkillFault("SHELTER_RUNTIME_NOT_WIRED");
  }
  const direction = directionVector[input.direction];
  const origin = bot.entity.position.floored();
  const sealItem = bot.inventory.items().find((item) => item.name === input.sealItemName);
  if (!sealItem) throw new SkillFault("ITEM_NOT_IN_INVENTORY");
  let dugBlocks = 0;
  const shelter = origin.plus(direction.scaled(input.depth));
  try {
    for (let step = 1; step <= input.depth; step += 1) {
      for (const y of [0, 1]) {
        if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const position = origin.plus(direction.scaled(step)).offset(0, y, 0);
        const block = bot.blockAt(position);
        if (!block || block.boundingBox === "empty") continue;
        if (mutableBot.canDigBlock && !mutableBot.canDigBlock(block)) throw new SkillFault("SHELTER_STEP_BLOCKED");
        await mutableBot.dig(block);
        dugBlocks += 1;
      }
    }
    if (typeof mutableBot.pathfinder?.setMovements === "function") {
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowFreeMotion = false;
      movements.allowParkour = false;
      movements.allowSprinting = false;
      movements.maxDropDown = 2;
      mutableBot.pathfinder.setMovements(movements);
    }
    const stopOnAbort = () => mutableBot.pathfinder?.stop?.();
    signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await mutableBot.pathfinder!.goto!(new goals.GoalNear(shelter.x, shelter.y, shelter.z, 0.75));
    } finally {
      signal.removeEventListener("abort", stopOnAbort);
    }
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    if (bot.entity.position.distanceTo(shelter) > 1.5) throw new SkillFault("SHELTER_STEP_BLOCKED");

    const entrance = origin.minus(direction);
    const support = bot.blockAt(entrance.minus(new Vec3(0, 1, 0)));
    if (!support || support.boundingBox === "empty") throw new SkillFault("SHELTER_STEP_BLOCKED");
    await mutableBot.equip(sealItem, "hand");
    await mutableBot.placeBlock(support, new Vec3(0, 1, 0));
  } catch (error) {
    if (error instanceof SkillFault) throw error;
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    throw new SkillFault("SHELTER_RUNTIME_FAILED");
  }
  if (dugBlocks < 2) throw new SkillFault("SHELTER_STEP_BLOCKED");
  return {
    dugBlocks,
    movedInside: true as const,
    sealed: true as const,
    shelterPosition: { x: shelter.x, y: shelter.y, z: shelter.z, dimension: input.dimension, serverProfileId: input.serverProfileId },
  };
}
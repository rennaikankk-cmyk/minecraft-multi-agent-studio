import type { Bot } from "mineflayer";
import pathfinderModule, { Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { SkillFault } from "@minecraft-studio/skills";

const { goals } = pathfinderModule;

type Position = Readonly<{ x: number; y: number; z: number; dimension: string; serverProfileId: string }>;
type SitePolicy = Readonly<{ minHighwayDistance: number; minPortalLineDistance: number; hazardClearance: number; burialDepthTarget: number }>;
const hazards = new Set(["lava", "fire", "soul_fire", "magma_block", "cactus", "powder_snow"]);
const logs = new Set(["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log", "mangrove_log", "cherry_log"]);
const SHELTER_DIG_CONFIRM_TIMEOUT_MS = 2_000;
const SHELTER_ENTRY_PATH_TIMEOUT_MS = 8_000;
const SHELTER_ENTRY_WALK_TIMEOUT_MS = 5_000;
function dimension(value: string): string { return value.includes(":") ? value.toLowerCase() : `minecraft:${value.toLowerCase()}`; }
function scope(bot: Bot, profile: string, target: { serverProfileId: string; dimension: string }): void {
  if (target.serverProfileId !== profile) throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
  if (target.dimension !== dimension(String(bot.game.dimension))) throw new SkillFault("TARGET_DIMENSION_MISMATCH");
}

async function waitForAir(
  bot: Pick<Bot, "blockAt">,
  position: Vec3,
  signal: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + SHELTER_DIG_CONFIRM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    const block = bot.blockAt(position);
    if (block?.boundingBox === "empty") return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new SkillFault("SHELTER_STEP_BLOCKED");
}

function shelterPositionReached(position: Vec3, shelter: Vec3): boolean {
  const floored = position.floored();
  return floored.x === shelter.x && floored.y === shelter.y && floored.z === shelter.z;
}

async function walkIntoShelter(
  bot: Bot,
  shelter: Vec3,
  direction: Vec3,
  signal: AbortSignal,
): Promise<boolean> {
  if (
    typeof bot.look !== "function" ||
    typeof bot.setControlState !== "function" ||
    typeof bot.clearControlStates !== "function"
  ) {
    return false;
  }

  const yaw = Math.atan2(-direction.x, -direction.z);
  const waitForTick = typeof bot.waitForTicks === "function"
    ? () => bot.waitForTicks(1)
    : () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  const deadline = Date.now() + SHELTER_ENTRY_WALK_TIMEOUT_MS;
  try {
    await bot.look(yaw, 0, true);
    bot.clearControlStates();
    bot.setControlState("forward", true);
    while (Date.now() < deadline) {
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      if (shelterPositionReached(bot.entity.position, shelter)) return true;
      await waitForTick();
    }
    return shelterPositionReached(bot.entity.position, shelter);
  } finally {
    bot.clearControlStates();
  }
}

async function enterShelter(
  bot: Bot,
  origin: Vec3,
  shelter: Vec3,
  direction: Vec3,
  signal: AbortSignal,
  pathfinder: {
    goto: (goal: object) => Promise<void>;
    stop?: () => void;
    setGoal?: (goal: object | null) => void;
    setMovements?: (movements: Movements) => void;
  },
  movements: Movements | undefined,
): Promise<void> {
  if (movements !== undefined && typeof pathfinder.setMovements === "function") {
    pathfinder.setMovements(movements);
  }

  const pathResult = await Promise.race([
    pathfinder.goto(new goals.GoalBlock(shelter.x, shelter.y, shelter.z))
      .then(() => "completed" as const, () => "failed" as const),
    new Promise<"timed_out">((resolve) => {
      setTimeout(() => resolve("timed_out"), SHELTER_ENTRY_PATH_TIMEOUT_MS);
    }),
  ]);
  if (pathResult === "completed" && shelterPositionReached(bot.entity.position, shelter)) return;

  if (typeof pathfinder.setGoal === "function") pathfinder.setGoal(null);
  else pathfinder.stop?.();
  bot.clearControlStates();
  if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");

  const walkedInside = await walkIntoShelter(bot, shelter, direction, signal);
  if (!walkedInside) throw new SkillFault("SHELTER_STEP_BLOCKED");
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
  const nearest = (pred: (name: string) => boolean, requiredClearance: number): number | null => {
    const distances = samples.filter((sample) => pred(sample.n)).map((sample) => sample.p.distanceTo(c));
    // Sparse local samples can disprove clearance, never prove an empty wider region.
    if (distances.length) return Math.min(...distances);
    return requiredClearance === 0 ? 0 : null;
  };
  const portalDistance = nearest((name) => name === "nether_portal", input.policy.minPortalLineDistance);
  const hazardDistance = nearest((name) => hazards.has(name), input.policy.hazardClearance);
  if (portalDistance === null || hazardDistance === null) complete = false;
  let overheadCoverDepthBlocks = 0;
  // burialDepth is the consecutive solid overhead cover above the candidate,
  // measured in blocks toward the surface. Air ends the cover; an unavailable
  // block makes the observation incomplete so assessment fails closed.
  for (let depth = 1; depth <= Math.ceil(input.policy.burialDepthTarget); depth += 1) {
    const b = bot.blockAt(c.offset(0, depth, 0));
    if (!b) { complete = false; break; }
    if (b.boundingBox === "empty") break;
    overheadCoverDepthBlocks += 1;
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
    nearestPortalLineDistance: portalDistance,
    nearestHazardDistance: hazardDistance,
    resources: {
      wood: Math.min(1, samples.filter((sample) => logs.has(sample.n)).length / 4),
      stone: Math.min(1, samples.filter((sample) => sample.n === "stone" || sample.n === "cobblestone").length / 4),
      water: Math.min(1, samples.filter((sample) => sample.n === "water").length / 4),
      animals: Math.min(1, entities.filter((entity) => ["cow", "pig", "sheep", "chicken"].includes(String(entity.name))).length / 4),
    },
    burialDepth: overheadCoverDepthBlocks,
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
    pathfinder?: {
      goto?: (goal: object) => Promise<void>;
      stop?: () => void;
      setGoal?: (goal: object | null) => void;
      setMovements?: (movements: Movements) => void;
    };
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
        const harvestableBlock = block as typeof block & {
          canHarvest?: (itemType: number | null) => boolean | null;
        };
        if (typeof harvestableBlock.canHarvest === "function") {
          const tool = bot.inventory.items().find(
            (item) => harvestableBlock.canHarvest(item.type) === true,
          );
          if (!tool && harvestableBlock.canHarvest(null) !== true) {
            throw new SkillFault("SHELTER_STEP_BLOCKED");
          }
          if (tool) await mutableBot.equip(tool, "hand");
        }
        await mutableBot.dig(block, true);
        await waitForAir(bot, position, signal);
        dugBlocks += 1;
      }
    }
    const movements = typeof mutableBot.pathfinder?.setMovements === "function"
      ? new Movements(bot)
      : undefined;
    if (movements !== undefined) {
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.allowFreeMotion = false;
      movements.allowParkour = false;
      movements.allowSprinting = false;
      movements.maxDropDown = 2;
    }
    const stopOnAbort = () => mutableBot.pathfinder?.stop?.();
    signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await enterShelter(
        bot,
        origin,
        shelter,
        direction,
        signal,
        mutableBot.pathfinder! as {
          goto: (goal: object) => Promise<void>;
          stop?: () => void;
          setGoal?: (goal: object | null) => void;
          setMovements?: (movements: Movements) => void;
        },
        movements,
      );
    } finally {
      signal.removeEventListener("abort", stopOnAbort);
    }
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    if (bot.entity.position.distanceTo(shelter) > 1.5) throw new SkillFault("SHELTER_STEP_BLOCKED");

    // The opening is the original standing cell. Placing one block on the
    // outside of it leaves the opening unsealed and can also trap a bot that
    // needs to leave the shelter in the opposite direction.
    const support = bot.blockAt(origin.minus(new Vec3(0, 1, 0)));
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

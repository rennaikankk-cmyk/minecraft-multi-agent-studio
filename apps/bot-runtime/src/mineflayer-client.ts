import { createBot, type Bot } from "mineflayer";
import path from "node:path";
import pathfinderModule, {
  Movements,
  pathfinder,
} from "mineflayer-pathfinder";
import { plugin as collectBlockPlugin } from "mineflayer-collectblock";
import { Vec3 } from "vec3";
import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";
import {
  armorEquipCapabilityInputSchema,
  armorEquipCapabilityOutputSchema,
  armorSnapshotCapabilityInputSchema,
  armorSnapshotCapabilityOutputSchema,
  ACTION_FAMILIES,
  collectBlockCapabilityInputSchema,
  collectBlockCapabilityOutputSchema,
  containerTransferCapabilityInputSchema,
  containerTransferCapabilityOutputSchema,
  craftItemCapabilityInputSchema,
  craftItemCapabilityOutputSchema,
  inventorySnapshotCapabilityInputSchema,
  inventorySnapshotCapabilityOutputSchema,
  placeBlockCapabilityInputSchema,
  placeBlockCapabilityOutputSchema,
  smeltItemCapabilityInputSchema,
  smeltItemCapabilityOutputSchema,
  MOVEMENT_PRIORITIES,
  MovementController,
  ServerBehaviorObserver,
  ProvenanceStore,
  authorizeHarvest,
  type MovementLease,
  SAFE_PATH_MAX_DISTANCE,
  SkillFault,
  SkillRefusal,
  ActionLockError,
  ActionLockManager,
  type ActionLockKind,
  resolveMovementProfile,
  type ServerPolicyLimits,
  safeMovementGotoCapabilityInputSchema,
  safeMovementGotoCapabilityOutputSchema,
  travelRouteCapabilityInputSchema,
  tradeVillagerCapabilityInputSchema,
  tradeVillagerCapabilityOutputSchema,
  ALL_EDIBLE_ITEMS,
  scanBlocksCapabilityInputSchema,
  scanBlocksCapabilityOutputSchema,
  secureFoodCapabilityInputSchema,
  secureFoodCapabilityOutputSchema,
  siteObserveCapabilityInputSchema,
  siteObserveCapabilityOutputSchema,
  shelterDigCapabilityInputSchema,
  shelterDigCapabilityOutputSchema,
  mineBranchCapabilityInputSchema,
  mineBranchCapabilityOutputSchema,
  mineVeinCapabilityInputSchema,
  mineVeinCapabilityOutputSchema,
  buildBlueprintCapabilityInputSchema,
  buildBlueprintCapabilityOutputSchema,
  type BehaviorSignalEvent,
  type FamilyWindowStats,
  type SkillCapabilityRequest,
  type SkillCompatibilityEnvironment,
  type SkillResourceKind,
} from "@minecraft-studio/skills";
import type {
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";
import {
    attachServerAuth,
    AuthCredentialStore,
    resolveServerAuthPassword,
  } from "@minecraft-studio/combat";
import { MineflayerCombatAdapter } from "./combat-mineflayer-adapter.js";
import { observeSite, digShelter } from "./site-shelter-adapter.js";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
  BotRecoveryAction,
  BotRecoveryActionResult,
  CompatSignalsSnapshot,
} from "./client.js";
import {
  attachNoHunger,
  type NoHungerBot,
  type NoHungerController,
} from "./no-hunger.js";
import type { ServerProfile } from "./server-profile.js";
import {
  importantBlockNames,
  WorldStateStore,
  type EntityState,
  type InventoryItemState,
  type NearbyBlockState,
  type WorldPosition,
  type WorldStateSnapshot,
} from "./world-state.js";
import {
  isMineflayerUnsupportedVersionError,
  mineflayerVersionOption,
  resolvedVersionCompatibility,
} from "./version-compatibility.js";

const { goals } = pathfinderModule;

const ACTION_LOCK_TTL_MS = 5 * 60_000;
const MAX_UTILITY_STATION_PATH_ATTEMPTS = 4;

const ARMOR_POINTS: Readonly<Record<string, number>> = {
  leather_helmet: 1,
  leather_chestplate: 3,
  leather_leggings: 2,
  leather_boots: 1,
  golden_helmet: 2,
  golden_chestplate: 5,
  golden_leggings: 3,
  golden_boots: 1,
  chainmail_helmet: 2,
  chainmail_chestplate: 5,
  chainmail_leggings: 4,
  chainmail_boots: 1,
  iron_helmet: 2,
  iron_chestplate: 6,
  iron_leggings: 5,
  iron_boots: 2,
  diamond_helmet: 3,
  diamond_chestplate: 8,
  diamond_leggings: 6,
  diamond_boots: 3,
  netherite_helmet: 3,
  netherite_chestplate: 8,
  netherite_leggings: 6,
  netherite_boots: 3,
  turtle_helmet: 2,
};

/**
 * container.transfer 允许打开的容器方块。刻意不含漏斗/发射器等红石敏感容器，
 * 也不含潜影盒以外任何"打开会改变世界状态"的方块。
 */
const CONTAINER_BLOCK_NAMES = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  ...[
    "shulker_box",
    "white_shulker_box",
    "orange_shulker_box",
    "magenta_shulker_box",
    "light_blue_shulker_box",
    "yellow_shulker_box",
    "lime_shulker_box",
    "pink_shulker_box",
    "gray_shulker_box",
    "light_gray_shulker_box",
    "cyan_shulker_box",
    "purple_shulker_box",
    "blue_shulker_box",
    "brown_shulker_box",
    "green_shulker_box",
    "red_shulker_box",
    "black_shulker_box",
  ],
]);

/** Armor skill slot names paired with Mineflayer equipment destinations. */
const ARMOR_SLOT_DESTINATIONS = [
  { slot: "head", destination: "head" },
  { slot: "torso", destination: "torso" },
  { slot: "legs", destination: "legs" },
  { slot: "feet", destination: "feet" },
] as const satisfies ReadonlyArray<{
  slot: "head" | "torso" | "legs" | "feet";
  destination: "head" | "torso" | "legs" | "feet";
}>;

/**
 * Map each known armor item to the slot it belongs in, derived from the item
 * name suffix. Only names present in ARMOR_POINTS are accepted, so the write
 * primitive can never be tricked into equipping a non-armor item.
 */
const ARMOR_ITEM_SLOT: Readonly<Record<string, "head" | "torso" | "legs" | "feet">> =
  Object.fromEntries(
    Object.keys(ARMOR_POINTS).map((name) => {
      if (name.endsWith("_helmet") || name === "turtle_helmet") {
        return [name, "head"] as const;
      }
      if (name.endsWith("_chestplate")) return [name, "torso"] as const;
      if (name.endsWith("_leggings")) return [name, "legs"] as const;
      return [name, "feet"] as const;
    }),
  );

// P0-A5: 统一从 bot-state-catalog 消费（与 coordinator 的 survival-needs 同源）。
const SAFE_FOOD_NAMES = ALL_EDIBLE_ITEMS;

type MineflayerBlock = NonNullable<
  Awaited<ReturnType<Bot["blockAt"]>>
>;

type UtilityStationPolicy = Readonly<{
  itemName: "crafting_table" | "furnace";
  blockNames: readonly string[];
  scanRadius: number;
  scanCount: number;
  maxOwnedPerArea: number;
}>;

const CRAFTING_TABLE_POLICY: UtilityStationPolicy = Object.freeze({
  itemName: "crafting_table",
  blockNames: Object.freeze(["crafting_table"]),
  scanRadius: 32,
  scanCount: 64,
  maxOwnedPerArea: 1,
});

const FURNACE_POLICY: UtilityStationPolicy = Object.freeze({
  itemName: "furnace",
  // Automatic resolution uses the general-purpose furnace. Blast furnaces
  // and smokers remain valid when the caller supplies an exact coordinate;
  // selecting either generically would require recipe-type compatibility.
  blockNames: Object.freeze(["furnace"]),
  scanRadius: 32,
  scanCount: 64,
  maxOwnedPerArea: 1,
});

const SAFE_FORAGE_ENTITY_NAMES = new Set([
  "cow",
  "pig",
  "rabbit",
  "sheep",
  // 鸡此前缺席：生鸡肉是可靠食物来源，击杀无反击风险。
  "chicken",
]);
const SAFE_FORAGE_BLOCK_NAMES = Object.freeze([
  "sweet_berry_bush",
  "cave_vines",
  "cave_vines_plant",
  "carrots",
  "potatoes",
  "beetroots",
  "melon",
] as const);
const SAFE_FORAGE_EXPLORATION_DIRECTIONS = Object.freeze([
  Object.freeze([1, 0] as const),
  Object.freeze([0, 1] as const),
  Object.freeze([-1, 0] as const),
  Object.freeze([0, -1] as const),
  Object.freeze([1, 1] as const),
  Object.freeze([-1, 1] as const),
  Object.freeze([-1, -1] as const),
  Object.freeze([1, -1] as const),
]);
const SAFE_FORAGE_MAX_DISTANCE = 48;
const SAFE_FORAGE_REACH_DISTANCE = 3.1;
const SAFE_FORAGE_TOTAL_BUDGET_MS = 20_000;
/** food.secure 的总预算：略低于技能超时（120s），给读回与收尾留余量。 */
const SECURE_FOOD_TOTAL_BUDGET_MS = 110_000;
/**
 * 背包满时的确定性丢垃圾表：物品 → 保留阈值。**只丢表内物品、只丢超出
 * 阈值的部分**——工具、食物、矿、装备永不入表，因此这次清理在结构上
 * 不可能丢掉任何生存必需品。腐肉保留 0（有毒食物，占格无益）。
 */
const INVENTORY_TIDY_KEEP_THRESHOLDS: Readonly<Record<string, number>> = Object.freeze({
  dirt: 32,
  coarse_dirt: 16,
  cobblestone: 64,
  granite: 16,
  diorite: 16,
  andesite: 16,
  gravel: 16,
  sand: 16,
  flint: 8,
  stick: 64,
  wheat_seeds: 16,
  beetroot_seeds: 8,
  pumpkin_seeds: 8,
  melon_seeds: 8,
  oak_sapling: 8,
  rotten_flesh: 16,
  bone: 16,
  string: 16,
  spider_eye: 0,
  rotten_flesh_block: 0,
});
const INVENTORY_TIDY_TIMEOUT_MS = 15_000;
const SAFE_FORAGE_PATH_BUDGET_MS = 4_000;
const SAFE_FORAGE_ATTACK_INTERVAL_MS = 650;
const SAFE_FORAGE_PICKUP_BUDGET_MS = 2_500;
const SAFE_FORAGE_EXPLORATION_DISTANCE = 12;
const SAFE_FORAGE_MAX_CANDIDATES = 4;

type SafeForageBlockInteraction = "activate" | "dig";
type SafeForageBlockTarget = Readonly<{
  block: NonNullable<ReturnType<Bot["blockAt"]>>;
  interaction: SafeForageBlockInteraction;
}>;

const COLLECT_INVENTORY_SYNC_TIMEOUT_MS = 1_000;
// Mineflayer emits `diggingCompleted` after its own local prediction — it writes
// the finish packet, then sets the block to air itself, so its promise resolves
// whether or not the server agreed. Collection stays fail-closed until the
// server speaks for itself.
//
// Measured against the live server (1.21.8 / protocol 772), breaking `stone`:
//   8967 diggingCompleted (mineflayer local) / bot.dig() resolved
//   9018 <= acknowledge_player_digging {"sequenceId":0}
// The accepted break produced no `block_change` and no `multi_block_change` at
// the target at all. A block update at the target is therefore the server
// *correcting* a break it refused, which is why the ack is the accept signal and
// a non-air update is the reject signal.
const COLLECT_SERVER_CONFIRM_TIMEOUT_MS = 1_500;
const COLLECT_SERVER_DIG_RETRIES = 1;
// An ack says the server processed the sequence, not that the block broke. A
// refusal arrives immediately after as a correcting block update, so hold the
// ack briefly before trusting it. Measured ack latency above was ~51 ms.
const COLLECT_SERVER_CORRECTION_GRACE_MS = 300;
// `block_dig` status 2 = finish digging; the pre-1.19 positional ack echoes it.
const BLOCK_DIG_STATUS_FINISH = 2;

// Mining uses the same bounded pathfinder contract as collection, but executes
// one planner step at a time so every break can be checked against the live
// world before the next one starts.
const MINE_PATH_THINK_TIMEOUT_MS = 8_000;
const MINE_PATH_TICK_TIMEOUT_MS = 40;
const MINE_TARGET_REACH_DISTANCE = 4.0;
const STONE_STAIRCASE_MAX_DEPTH = 12;
const STONE_STAIRCASE_STEP_PATH_BUDGET_MS = 4_000;
const STONE_STAIRCASE_BREAKABLE = new Set([
  "grass_block",
  "dirt",
  "coarse_dirt",
  "rooted_dirt",
  "podzol",
  "mycelium",
  "stone",
  "andesite",
  "diorite",
  "granite",
  "tuff",
  "deepslate",
  "coal_ore",
  "deepslate_coal_ore",
  "iron_ore",
  "deepslate_iron_ore",
  "copper_ore",
  "deepslate_copper_ore",
  "diamond_ore",
  "deepslate_diamond_ore",
]);
const STONE_STAIRCASE_FALLING_BLOCKS = new Set([
  "sand",
  "red_sand",
  "gravel",
  "suspicious_sand",
  "suspicious_gravel",
]);
const STONE_STAIRCASE_DIRECTIONS = [
  { dx: 1, dz: 0 },
  { dx: -1, dz: 0 },
  { dx: 0, dz: 1 },
  { dx: 0, dz: -1 },
] as const;
const RESOURCE_STAIRCASE_VERTICAL_STEPS = [-1, 1] as const;
const STONE_COLLECTION_ITEMS = ["cobblestone", "stone"] as const;
const STAIRCASE_RESOURCE_DROPS: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    stone: STONE_COLLECTION_ITEMS,
    coal_ore: Object.freeze(["coal"]),
    deepslate_coal_ore: Object.freeze(["coal"]),
    iron_ore: Object.freeze(["raw_iron"]),
    deepslate_iron_ore: Object.freeze(["raw_iron"]),
    copper_ore: Object.freeze(["raw_copper"]),
    deepslate_copper_ore: Object.freeze(["raw_copper"]),
    diamond_ore: Object.freeze(["diamond"]),
    deepslate_diamond_ore: Object.freeze(["diamond"]),
  });
const MINE_BACKFILL_ITEMS = [
  "cobblestone",
  "stone",
  "dirt",
  "andesite",
  "diorite",
  "granite",
  "deepslate",
] as const;

type BlockPosition = Readonly<{ x: number; y: number; z: number }>;

type MineflayerWireClient = {
  on?: (event: string, listener: (packet: unknown) => void) => void;
  off?: (event: string, listener: (packet: unknown) => void) => void;
  removeListener?: (event: string, listener: (packet: unknown) => void) => void;
};

type InventorySyncWaiter = Readonly<{
  promise: Promise<void>;
  cancel: () => void;
}>;

type ResourceStaircasePlan = Readonly<{
  origin: Vec3;
  dx: number;
  dy: -1 | 1;
  dz: number;
  safeDepth: number;
  firstStoneDepth: number;
  stoneBlocks: number;
  closestTargetDistance: number;
}>;

type CollectBlockTargets = Readonly<{
  getClosest?: () => unknown;
  clear?: () => void;
}>;

type DirectCollectionTool = Readonly<{
  equipForBlock: (
    block: NonNullable<ReturnType<Bot["blockAt"]>>,
    options: Readonly<{
      requireHarvest: boolean;
      getFromChest: boolean;
      maxTools: number;
    }>,
  ) => Promise<void>;
}>;

type AuthoritativeBlockUpdate = Readonly<{
  position: BlockPosition;
  stateId: number;
}>;

function blockPositionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBlockChangePacket(packet: unknown): AuthoritativeBlockUpdate | null {
  const record = asRecord(packet);
  const location = asRecord(record?.location);
  const x = finiteNumber(location?.x);
  const y = finiteNumber(location?.y);
  const z = finiteNumber(location?.z);
  const stateId = finiteNumber(record?.type);
  if (x === null || y === null || z === null || stateId === null) return null;
  return { position: { x, y, z }, stateId };
}

/**
 * Decode one packed section record: `blockStateId << 12 | localX << 8 | localZ << 4 | localY`.
 *
 * Division rather than bitwise shifts: a state ID above 524287 pushes the packed
 * value past 2^31, where JavaScript's bitwise operators would truncate to 32
 * bits and silently produce a different block. `varlong` records also decode to
 * a BigInt, which bitwise operators reject outright.
 */
function packedSectionRecord(value: unknown): Readonly<{
  localX: number;
  localY: number;
  localZ: number;
  stateId: number;
}> | null {
  const numeric =
    typeof value === "bigint"
      ? Number(value)
      : typeof value === "string"
        ? Number(value)
        : finiteNumber(value);
  if (
    numeric === null ||
    !Number.isFinite(numeric) ||
    !Number.isInteger(numeric) ||
    numeric < 0
  ) {
    return null;
  }
  const packedPosition = numeric % 4096;
  return {
    localX: Math.floor(packedPosition / 256) % 16,
    localZ: Math.floor(packedPosition / 16) % 16,
    localY: packedPosition % 16,
    stateId: (numeric - packedPosition) / 4096,
  };
}

/**
 * Both wire encodings of `multi_block_change`, because they disagree completely:
 *   - 1.8–1.15 sent one container per record (`horizontalPos`, absolute `y`,
 *     `blockId`) alongside flat `chunkX` / `chunkZ`.
 *   - 1.16+ sends a section-relative packed `varlong`/`varint` per record with a
 *     `chunkCoordinates` bitfield carrying the section Y.
 * Reading the container field names off a packed number yields `undefined` for
 * every field, which dropped every batched update without a trace — the class of
 * silent failure this repo keeps having to dig back out.
 */
function parseMultiBlockChangePackets(packet: unknown): AuthoritativeBlockUpdate[] {
  const record = asRecord(packet);
  const records = Array.isArray(record?.records) ? record.records : [];
  const chunkCoordinates = asRecord(record?.chunkCoordinates);
  const chunkX = finiteNumber(chunkCoordinates?.x ?? record?.chunkX);
  const sectionY = finiteNumber(chunkCoordinates?.y);
  const chunkZ = finiteNumber(chunkCoordinates?.z ?? record?.chunkZ);
  if (chunkX === null || chunkZ === null) return [];

  const updates: AuthoritativeBlockUpdate[] = [];
  for (const entry of records) {
    const change = asRecord(entry);
    if (change) {
      const horizontalPos = finiteNumber(change.horizontalPos);
      const absoluteY = finiteNumber(change.y);
      const stateId = finiteNumber(change.blockId);
      if (horizontalPos === null || absoluteY === null || stateId === null) {
        continue;
      }
      updates.push({
        position: {
          x: chunkX * 16 + (Math.floor(horizontalPos / 16) % 16),
          y: absoluteY,
          z: chunkZ * 16 + (horizontalPos % 16),
        },
        stateId,
      });
      continue;
    }
    const packed = packedSectionRecord(entry);
    if (!packed) continue;
    updates.push({
      position: {
        x: chunkX * 16 + packed.localX,
        y: (sectionY ?? 0) * 16 + packed.localY,
        z: chunkZ * 16 + packed.localZ,
      },
      stateId: packed.stateId,
    });
  }
  return updates;
}

/**
 * `acknowledge_player_digging` also has two shapes. 1.19+ carries only a
 * `sequenceId`, which Mineflayer always writes as 0, so it cannot be matched to
 * a specific dig — it is attributable only by the window it arrives in. 1.16–1.18
 * name the block and say outright whether the action succeeded. Versions before
 * 1.16 have no such packet, so there the confirmation falls back to block
 * updates alone.
 */
type DiggingAck =
  | Readonly<{ kind: "sequence" }>
  | Readonly<{
      kind: "positional";
      position: BlockPosition;
      status: number;
      successful: boolean;
    }>;

function parseDiggingAckPacket(packet: unknown): DiggingAck | null {
  const record = asRecord(packet);
  if (!record) return null;
  const location = asRecord(record.location);
  if (location) {
    const x = finiteNumber(location.x);
    const y = finiteNumber(location.y);
    const z = finiteNumber(location.z);
    const status = finiteNumber(record.status);
    if (x === null || y === null || z === null || status === null) return null;
    return {
      kind: "positional",
      position: { x, y, z },
      status,
      successful: record.successful === true,
    };
  }
  return finiteNumber(record.sequenceId) === null ? null : { kind: "sequence" };
}

type SafetyEntityState = Readonly<{
  isInWater?: unknown;
  isInLava?: unknown;
}>;

type FoodMetadata = Readonly<{
  foodPoints: number;
  effectiveQuality?: number;
}>;

type FoodRegistry = Readonly<{
  foodsByName?: Readonly<Record<string, FoodMetadata>>;
}>;

function safeDetail(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = text?.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function waitForDelay(durationMs: number): Promise<void> {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

function normalizeDimension(value: string): string {
  if (value.includes(":")) return value.toLowerCase();
  const normalized = value.toLowerCase().replace(/[^a-z0-9_./-]/gu, "_");
  return `minecraft:${normalized || "unknown"}`;
}

/**
 * 无规则服导航档：没有反作弊、没有封号风险，强度优先。与 safe 档唯一的
 * 交集是两条**存活安全**约束（dontCreateFlow / dontMineUnderFallingBlock）
 * ——它们防的是把岩浆/水引进家和被沙砾活埋，与反作弊无关。
 */
export function configureAnarchyPathfinderMovements(
  movements: Movements,
  bot: Pick<Bot, "registry">,
): Movements {
  movements.canDig = true;
  movements.canOpenDoors = true;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = true;
  movements.allowFreeMotion = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  const registry = bot.registry as unknown as {
    blocksByName?: Readonly<Record<string, { id: number }>>;
  };
  movements.scafoldingBlocks = ["cobblestone", "dirt", "oak_planks", "netherrack"]
    .map((name) => registry.blocksByName?.[name]?.id)
    .filter((id): id is number => typeof id === "number");
  movements.maxDropDown = 4;
  movements.infiniteLiquidDropdownDistance = false;
  // 元组类型要求至少一个函数；() => 0 即"无额外代价"。
  movements.exclusionAreasBreak = [() => 0];
  movements.exclusionAreasPlace = [() => 0];
  return movements;
}

export function configureNavigationMovements(
  movements: Movements,
  bot: Pick<Bot, "registry">,
  anarchy: boolean,
): Movements {
  return anarchy
    ? configureAnarchyPathfinderMovements(movements, bot)
    : configureSafePathfinderMovements(movements);
}

export function configureSafePathfinderMovements(
  movements: Movements,
): Movements {
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.scafoldingBlocks = [];
  movements.maxDropDown = 2;
  movements.infiniteLiquidDropdownDistance = false;
  movements.exclusionAreasBreak = [() => 100];
  movements.exclusionAreasPlace = [() => 100];
  return movements;
}

// findBlocks 只按距离排序取最近的命中，完全不问那些命中能不能靠近。实测
// 生服出生点：半径 16 内有 12843 个 stone，其中只有 173 个有任何一面贴空气，
// 最近的暴露面在 12.9 格外——所以交给采集器的三个"最近"目标永远是全埋的。
// collectblock 用 GoalLookAtBlock 接近目标，它要求目标有一面能被射线看到，
// 而安全移动配置给所有非目标方块 100 的破除代价，于是路径根本不存在：
//   collect-config timeout=5000 radius=-1 status=noPath visited=9961
// 把 thinkTimeout 抬到 20 秒也一样是 noPath（717ms），可见不是预算不够。
// 同一份探针里最近的**暴露** stone 则 158ms 就搜出路径（visited=2836）。
// 因此候选筛选必须带上"至少一面临空"这一条，否则上层的重试阶梯只是在
// 反复瞄准一个永远到不了的坐标。
const CANDIDATE_FACES: readonly Readonly<[number, number, number]>[] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// 临空的那一面若是液体，靠近就等于往水里/岩浆里挖。mine-planner 已经把
// lava/water 邻接判成 MINE_LAVA_ADJACENT（planning/mine-planner.ts:162），
// 这里沿用同一条立场：液体不算可用的暴露面。上面那组暴露计数是用"只看
// boundingBox 为 empty"测的，所以实际可用候选只会比它少，不会更多。
const CANDIDATE_FACE_LIQUIDS = new Set([
  "water",
  "flowing_water",
  "lava",
  "flowing_lava",
  "bubble_column",
]);

/**
 * 判断一个方块是否至少有一面贴着可通行的非液体空间。
 *
 * 读不到邻居（区块未加载）时那一面不算暴露：fail-closed 比乐观猜测好，
 * 因为猜错的代价是上层拿着一个到不了的目标烧完整条重试阶梯。
 */
export function hasReachableFace(
  bot: Pick<Bot, "blockAt">,
  position: Vec3,
): boolean {
  return CANDIDATE_FACES.some(([dx, dy, dz]) => {
    const neighbor = bot.blockAt(position.offset(dx, dy, dz));
    if (!neighbor || neighbor.boundingBox !== "empty") return false;
    return !CANDIDATE_FACE_LIQUIDS.has(neighbor.name);
  });
}

/**
 * 供 findBlocks 的 useExtraInfo 使用的候选谓词。
 *
 * mineflayer 4.37.1 的 getFullMatchingFunction 在 useExtraInfo 是函数时走
 * `matcher(block) && useExtraInfo(block)`（lib/plugins/blocks.js:145），
 * 而距离排序与 count 截断都在匹配**之后**（同文件 199-206），所以这里过滤
 * 得到的是"最近的可达候选"，而不是"最近若干个里恰好可达的那些"。
 * 段级短路仍然只用基础 matcher，因此加这个谓词不会让扫描退化成全量遍历。
 */
function reachableCandidateFilter(
  bot: Pick<Bot, "blockAt">,
): (block: { position: Vec3 } | null) => boolean {
  return (block) =>
    block !== null && hasReachableFace(bot, block.position);
}

/**
 * 手里/背包里有没有能真正收获该方块的工具。
 *
 * 必须在把目标交给 collectblock **之前**问这一句，否则进程会 OOM 崩掉，这是实测：
 * mineBlock 调 bot.tool.equipForBlock(block, {requireHarvest:true,
 * getFromChest:true, ...})（CollectBlock.js:74）；mineflayer-tool 的
 * equipForBlock 在 requireHarvest 下按 `block.canHarvest(item?.type ?? null)`
 * 过滤（Tool.js:115），列表空了就 `await retrieveTools(...)` 然后**递归调用自己**
 * （Tool.js:121-127）；而 retrieveTools 在 chestLocations 为空时整个 while 循环
 * 一次都不进，直接 resolve 而不是抛错（Inventory.js:48）。我们又把
 * chestLocations 恒置为空（入库是 container.transfer 的职责）。于是列表永远是空的，
 * 递归永远不终止。
 *
 * equip-probe 直接调这一个函数测得：石头 + 空背包 + chestLocations=[] →
 * 2001 层递归只用了 15ms（约 133k 层/秒），每层还留着一份
 * `[...bot.inventory.items()]` 拷贝；对照组把 getFromChest 关掉则 0ms 内以
 * NoItem 拒绝。这解释了两次探针崩溃的完整形态：heap 在寻路阶段平稳在 45-95MB
 * （path_update 停在 13、resets=0），随后 500ms 采样器**整个停止触发**（事件循环
 * 被同步递归占满），而 GC 报到 1.9GB / 5.9GB，最后
 * "Ineffective mark-compacts near heap limit"。
 *
 * 所以这里不是"提前失败更礼貌"，而是唯一能避免 OOM 的位置：一旦进了
 * collectblock，递归发生在库内部，我们既拦不住也没有超时可言。
 */
export function canHarvestWithInventory(
  bot: Pick<Bot, "inventory" | "heldItem">,
  block: { canHarvest: (itemType: number | null) => boolean | null },
): boolean {
  // 空手也可能收获（泥土、沙子），所以 null 是一个必须参与判断的候选，
  // 而不是"没工具"的同义词。
  if (block.canHarvest(null) === true) return true;
  return bot.inventory
    .items()
    .some((item) => block.canHarvest(item.type) === true);
}

// collect 自己的寻路预算，不再继承 invokeMovementGoto 写在 bot.pathfinder 上
// 的全局值。三条实测把这两个数字定死了：
//   1. astar.js:73 比的是**构造以来的墙钟**（`performance.now() - this.startTime
//      > this.timeout`），不是累计计算时间——注释写的 "total compute time" 是错的。
//      而 compute() 每次最多跑 tickTimeout 毫秒，且 monitorMovement 挂在
//      physicsTick 上（index.js:166，约 50ms 一次）。于是占空比 =
//      tickTimeout / 50ms：tickTimeout=20 时 thinkTimeout=5000 只买到约 2.0s
//      的真实计算。reset-probe 实测 ticks=101、path_reset=0、astarTime=5000ms、
//      visited=30511——一个搜索被饿死，不是重启风暴。
//   2. 40 个暴露 stone 从固定原点全占空比排干（tickTimeout == timeout，wall ≈
//      compute）：能解的 33 个 max=527ms min=181ms median=445ms，判不出路的 7 个
//      在 671-678ms 内落定 noPath。所以真实需求是亚秒级。
//   3. tickTimeout=40 是库默认值（index.js:40），把占空比从 40% 抬到约 80%。
// 8000ms 墙钟 × 约 80% 占空比 ≈ 6.4s 计算，是实测最坏 527ms 的十倍余量，留给
// 行进途中 blockUpdate/chunkColumnLoad 触发的 resetPath 重付成本（duty-probe
// 实测 resets=11）。
const COLLECT_PATH_THINK_TIMEOUT_MS = 8_000;
const COLLECT_PATH_TICK_TIMEOUT_MS = 40;

// collectAll 有两条永不落定的 await，都在 Entity 分支（CollectBlock.js:36-52）：
//   1. 第 50 行 `yield waitForPickup` 没有超时，而它订阅 entityGone 是在第 49 行
//      goto **返回之后**（41-48 行建 Promise，49 行才走过去）。掉落物在走过去的
//      途中被顺路捡走时，entityGone 已经发过了，这个 Promise 永远不 resolve。
//   2. 第 49 行 GoalFollow(closest, 0) 对着一个会动/已失效的实体要求距离 0。
//      resetPath 每次都构造新的 AStar 且都能 success，所以 thinkTimeout 永远
//      不触发，机器人就在原地反复重算而不拒绝。
// 两条都不抛错，于是 collect() 既不 resolve 也不 reject——实测就是 live 的
// `dur=60004 SKILL_TIMEOUT` 且没有任何 onFault 行。cobble-earned-probe 复现：
// 第一轮 Timeout 拒绝，第二轮 collect() 静默挂了 224 秒直到探针自己的失效保护。
// 掉落物是 mineBlock 在 collect() 跑动中追加的目标（CollectBlock.js:80-83），
// 前置可达性检查看不到它们，所以这个界只能加在这一层。
// 25000ms：实测四个 oak_log 目标走完整条 collect（含 GoalFollow 捡拾腿）是
// 34458ms，单目标 12974ms，而 stone 单目标 goto 就要 19025ms（候选在脚下
// 12-13 格深）。所以这个界不能小到误伤正常采集，只能用来兜住"永远不落定"：
// 60s 合约减去最坏一次 travel+dig 后仍有余量，且留够时间把真实原因报上去。
const COLLECT_SETTLE_BUDGET_MS = 25_000;
const COLLECT_DIRECT_PATH_BUDGET_MS = 12_000;
const COLLECT_DIRECT_PICKUP_PATH_BUDGET_MS = 6_000;
const COLLECT_DIRECT_PICKUP_WAIT_MS = 2_000;
// Round 6.2：挖后掉落物可能仍在下落（树冠原木落地要 1-3s）。追一个移动中的
// 实体位置必然失败——每轮重读掉落物当前位置，有界重试，事件驱动提前成功。
const COLLECT_PICKUP_ATTEMPTS = 3;
const COLLECT_PICKUP_SETTLE_PROBE_MS = 300;

const COLLECT_PRECHECK_BUDGET_MS = 1_500;

// 候选池必须比需求量大。findBlocks 的 count 截断发生在 useExtraInfo 过滤**之后**
// （blocks.js:199-206），所以 count == maxCount 意味着"最近的 N 个暴露候选"就是
// 全部候选:其中任何一个通不过可达性检查都没有替补。实测就是这么死的——目标
// 只找到 1 个暴露的 oak_log，它不可达，于是整个目标在 step 1 结束，
// stepsCompleted:0。世界里当然还有别的原木，只是不在"最近 1 个"里。
//
// 池子放大到需求量 + 8（仍受 COLLECT_MAX_COUNT 上限约束）。8 不是随手写的：
// 实测 40 个暴露 stone 候选里 7 个是 noPath（约 17.5%），一次多看 8 个能把
// "全军覆没"的概率压到可以忽略，同时最坏成本仍然有界（见下面的总预算）。
const COLLECT_CANDIDATE_POOL_SLACK = 8;

// 逐候选预算 1500ms 乘以放大后的池子会吃掉整个 60s 合约（32 × 1500 = 48s），
// 所以放大池子必须同时给检查本身一个总预算。6000ms 按实测最坏定论耗时 678ms
// 算大约能排完 8 个候选，且给 collect() 自己的 25s 界留足余量。
//
// 这不是"调超时掩盖失败"：预算耗尽时不会假装可达，也不会假装证明了不可达——
// 没检查完的候选让 provenPathless < targets.length 成立，报的就是
// COLLECT_PATH_SEARCH_EXHAUSTED（TRANSIENT，可以原样再试）。
const COLLECT_PRECHECK_TOTAL_BUDGET_MS = 6_000;

// 前置检查是证据，不是保证。实测（task 7bab377b，step 6 oak_log，dur=12588ms）：
// 前置检查证明了一个候选可达——日志里一条 "Examined ... candidates" 都没有——
// 随后 collect() 自己的 goto 在同一个目标上以
// `Timeout: Took to long to decide path to goal!`（goto.js:28，即 path_update
// 报 status=timeout）被拒。两次搜索并不等价：前置检查用
// tickTimeout == timeout 背靠背跑满 1500ms，而实跑的 A* 挂在 physicsTick 上
// 每 ~50ms 只跑 tickTimeout=40ms，且 8000ms 是**墙钟**（astar.js:73），行进途中
// 的 blockUpdate/chunkColumnLoad 还会 resetPath 并从新位置重新付一次全价
// （index.js:401/414）。所以"前置证明可达"之后实跑仍然可能判不出路。
//
// 于是只交一个已证明的目标就复现了 COLLECT_CANDIDATE_POOL_SLACK 当初要修的那个
// 形态——一次坏抽样就沉掉整步——只是晚了一层：候选池有替补，交给 collect() 的
// 批次却没有。多证明一个候选当替补，成本有界（最多一个 1500ms 名额，且仍受
// 6000ms 总预算约束），换来实跑被拒时还有下一个可以试。
//
// 只留 1 个而不是更多：一次替补把最坏成本压在"再一次 goto"，60s 技能合约放得下
// （实测整步 12588ms）；再多就要拿实测数字说话，而那个数字还没测。
const COLLECT_LIVE_PATH_SUBSTITUTES = 1;

/**
 * 前置检查的结论。`provenPathless` 是**证明**了没有路的候选数，不是"没成功"的
 * 候选数：两者差在预算用尽的搜索上，而这个差别决定上层走哪条恢复阶梯。
 */
export type CollectReachability<TBlock> = Readonly<{
  reachable: TBlock[];
  /** Candidates whose search timed out or did not run before the total budget. */
  unproven: TBlock[];
  provenPathless: number;
  /**
   * 实际排过的候选数。它可以远小于 `targets.length`：逐候选 1500ms 配 6000ms
   * 总预算，最多只排得下 4 个。没有这个数，"0 of 9 proven pathless" 读起来像
   * 九个都试过了，运维就会去调那个根本没绑住循环的常量。
   */
  examined: number;
  /** 循环是被总预算截断的（true），还是把候选走完了（false）。 */
  stoppedOnTotalBudget: boolean;
}>;

/**
 * 逐个候选排干一次有界的全占空比搜索，同时记下有多少个是**证明**不可达的。
 *
 * 为什么必须前置：collectblock 的 collectAll 对每个目标各做一次 goto，并把
 * 拒绝直接上抛（CollectBlock.js:31，第 33 行还留着 `// TODO:
 * options.ignoreNoPath`），所以**一个**到不了的目标就会中止整批采集。实测 40 个
 * 暴露候选里有 7 个是 noPath，而选择只按距离排序，撞上纯属运气。
 * tickTimeout == timeout 让切片背靠背跑，wall ≈ compute；1500ms 是实测最坏
 * 定论耗时 678ms 的两倍余量，且仍然有界。
 *
 * 只数 `noPath`，因为 AStar.compute() 只有四个状态（astar.js:66-120）：
 * `partial` 是切片没跑完，`timeout` 是总预算耗尽，`success` 是找到了，
 * `noPath` 是开集排空——**只有最后一个**是"这里确实没有路"的证明。而
 * `timeout` 在本函数这个配置下是真能出现的：tickTimeout == timeout 时第一次
 * compute() 先撞 tick 检查返回 partial，getPathFromTo 再驱动一次
 * （index.js:96-100），这次 `now - startTime > timeout` 已经成立就报 timeout。
 * 把它记成证明会让一个只是没算完的搜索冒充定论，正是
 * failure-classifier.ts:180 明令不许合并的那两件事。未知状态同样不算证明：
 * 拿不准时少声称，而不是多声称。
 */
export function collectReachableTargets<TBlock extends { position: Vec3 }>(
  bot: Pick<Bot, "pathfinder" | "entity" | "world">,
  movements: Movements,
  targets: readonly TBlock[],
  wanted: number = targets.length,
): CollectReachability<TBlock> {
  const reachable: TBlock[] = [];
  const unproven: TBlock[] = [];
  let provenPathless = 0;
  let examined = 0;
  let stoppedOnTotalBudget = false;
  const deadline = Date.now() + COLLECT_PRECHECK_TOTAL_BUDGET_MS;
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index]!;
    // 够数就停：池子放大是为了有替补，不是为了多采。攒到需求量就不再花钱，
    // 也顺手把交给 collect() 的目标数压在请求量之内。
    if (reachable.length >= wanted) break;
    // 总预算是放大池子的必要配套：逐候选 1500ms × 放大后的池子会吃掉整个 60s
    // 合约。剩下没检查的候选因此既不算可达也不算证明不可达，于是
    // provenPathless < targets.length 成立，上层收到的是 EXHAUSTED 而不是
    // 一个冒充定论的 UNREACHABLE。
    if (Date.now() >= deadline) {
      stoppedOnTotalBudget = true;
      unproven.push(...targets.slice(index));
      break;
    }
    examined += 1;
    const generator = bot.pathfinder.getPathFromTo(
      movements,
      bot.entity.position,
      new goals.GoalLookAtBlock(target.position, bot.world),
      {
        timeout: COLLECT_PRECHECK_BUDGET_MS,
        tickTimeout: COLLECT_PRECHECK_BUDGET_MS,
        searchRadius: -1,
      },
    );
    let status: string | undefined;
    for (const step of generator) {
      status = step.result.status;
      if (status !== "partial") break;
    }
    if (status === "success") {
      reachable.push(target);
      continue;
    }
    if (status === "noPath") {
      provenPathless += 1;
    } else {
      // Timeout is not proof that the live pathfinder cannot reach the block.
      // Keep it as a bounded execution candidate instead of turning a 6-second
      // read-only precheck into a permanent no-op loop.
      unproven.push(target);
    }
  }
  return {
    reachable,
    unproven,
    provenPathless,
    examined,
    stoppedOnTotalBudget,
  };
}

export function configurePathfinderMovements(
  movements: Movements,
  profile: "SAFE" | "PARKOUR" = "SAFE",
  policyLimits?: ServerPolicyLimits,
  isolatedTestServer = false,
): Movements {
  if (profile === "SAFE") return configureSafePathfinderMovements(movements);
  if (policyLimits === undefined) throw new SkillFault("POLICY_PARKOUR_FORBIDDEN");
  const decision = resolveMovementProfile(profile, policyLimits, isolatedTestServer);
  if (!decision.allowed) throw new SkillFault(decision.errorCode);
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = decision.config.allowFreeMotion;
  movements.allowParkour = decision.config.allowParkour;
  movements.allowSprinting = decision.config.allowSprinting;
  movements.scafoldingBlocks = [];
  movements.maxDropDown = decision.config.maxDropDown;
  movements.infiniteLiquidDropdownDistance = false;
  movements.exclusionAreasBreak = [() => 100];
  movements.exclusionAreasPlace = [() => 100];
  return movements;
}
function readMaximumHealth(bot: Bot): number | null {
  const entity = bot.entity as typeof bot.entity & {
    attributes?: Record<string, { value?: number }>;
  };
  const attributes = entity.attributes ?? {};
  const entry = Object.entries(attributes).find(([name]) =>
    name.endsWith("max_health"),
  )?.[1];
  const value = entry?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * 工具耐久读数（剩余值）。与 worldStateSnapshot 同一语义：mineflayer 的
 * Item 携带 maxDurability 与 durabilityUsed（已损耗），剩余 = max − used。
 * 非耐久物品返回 null。
 */
function toolDurability(item: {
  maxDurability?: number;
  durabilityUsed?: number;
}): { durability: number; maxDurability: number } | null {
  const maxDurability = item.maxDurability;
  if (
    typeof maxDurability !== "number" ||
    !Number.isFinite(maxDurability) ||
    maxDurability <= 0
  ) {
    return null;
  }
  const used = item.durabilityUsed;
  const durability =
    typeof used === "number" && Number.isFinite(used) && used > 0
      ? Math.max(0, Math.round(maxDurability - used))
      : Math.round(maxDurability);
  return { durability, maxDurability: Math.round(maxDurability) };
}

function readArmorSlots(bot: Bot): { head: string | null; chest: string | null; legs: string | null; feet: string | null } {
  try {
    const destinations = { head: "head", chest: "torso", legs: "legs", feet: "feet" } as const;
    const result: Record<string, string | null> = {};
    for (const [slot, destination] of Object.entries(destinations)) {
      const slotIndex = bot.getEquipmentDestSlot(destination);
      const item = bot.inventory.slots[slotIndex];
      result[slot] = item?.name ?? null;
    }
    return result as { head: string | null; chest: string | null; legs: string | null; feet: string | null };
  } catch {
    return { head: null, chest: null, legs: null, feet: null };
  }
}

function readArmorPoints(bot: Bot): number | null {
  try {
    const destinations = ["head", "torso", "legs", "feet"] as const;
    return destinations.reduce((total, destination) => {
      const slot = bot.getEquipmentDestSlot(destination);
      const item = bot.inventory.slots[slot];
      return total + (item?.name ? (ARMOR_POINTS[item.name] ?? 0) : 0);
    }, 0);
  } catch {
    return null;
  }
}

function mapDisconnectReason(
  requestedStop: boolean,
  versionUnsupported: boolean,
  kickedDetail: string | undefined,
  errorDetail: string | undefined,
  endReason: string,
  kickPhase?: "PRE_LOGIN" | "POST_LOGIN" | "POST_SPAWN",
): BotDisconnectInfo {
  if (requestedStop) {
    return { reason: "requested_stop", expected: true };
  }
  if (versionUnsupported) {
    return {
      reason: "runtime_error",
      expected: false,
      detail: "unsupported_minecraft_version",
    };
  }
  if (kickedDetail) {
    return {
      reason: "kicked",
      expected: false,
      detail: kickedDetail,
      ...(kickPhase !== undefined ? { phase: kickPhase } : {}),
    };
  }
  if (errorDetail) {
    const authentication = /auth|login|token|session/iu.test(errorDetail);
    return {
      reason: authentication ? "authentication_error" : "network_error",
      expected: false,
      detail: errorDetail,
    };
  }
  const detail = safeDetail(endReason);
  return {
    reason: "unknown",
    expected: false,
    ...(detail ? { detail } : {}),
  };
}

/**
 * timeout 判定只认明确语义：Node errno（ETIMEDOUT/ESOCKETTIMEDOUT）或消息
 * 里带 "timed out"/"timeout"。ECONNRESET/证书错误等不算——宁可漏报也不把
 * 别的断线原因臆断成 timeout。
 */
const TIMEOUT_ERRNOS: ReadonlySet<string> = new Set(["ETIMEDOUT", "ESOCKETTIMEDOUT"]);

function isTimeoutLikeError(error: Error): boolean {
  const errno = (error as NodeJS.ErrnoException).code;
  if (typeof errno === "string" && TIMEOUT_ERRNOS.has(errno)) return true;
  return /timed?\s*out|timeout/iu.test(error.message);
}

function isTimeoutLikeReason(reason: unknown): boolean {
  return typeof reason === "string" && /timed?\s*out|timeout/iu.test(reason);
}

export class MineflayerBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  private lastObservedHealth: number | null = null;
  private requestedStop = false;
  private kickedDetail: string | undefined;
  /** kick 阶段证据：login 前后 / spawn 前后（SERVER_KICK 结构化字段）。 */
  private loginSeen = false;
  private spawnSeen = false;
  private kickPhase: "PRE_LOGIN" | "POST_LOGIN" | "POST_SPAWN" | undefined;
  private errorDetail: string | undefined;
  private versionUnsupportedReported = false;
  private inventoryListenerBound = false;
  /** Single owner for Pathfinder, collectblock, combat and recovery motion. */
  private readonly anarchyNavigation: boolean = false;
  /** chat 监听只绑一次（多次 spawn 不重复叠加）。 */
  private chatBound = false;
  /** 服务器认证监听的清理函数（断线/spawn 重建时调用）。 */
  private serverAuthDetach: (() => void) | null = null;
  /** G1 spawn-escape：本连接首个出生点（重触发判定的参照原点）。 */
  private worldSpawnOrigin: { x: number; z: number } | null = null;
  /** spawn-escape 疾跑进行中（防同点重复派发；goto 落定后复位）。 */
  private spawnEscapeActive = false;
  /**
   * Phase 3：Material Provenance——bot.dig 边界 HarvestAuthorization。
   * 2026-09-03 深度审计：此前恒为 null（检查是死代码）。现在按 serverProfile
   * 构造并持久化（runtime-data/provenance/<profile>.json），放置写入、挖掘清除。
   */
  private readonly provenanceStore: ProvenanceStore | null;
  /** 显式拆除/回收授权的位置集合（salvage 通道，带死线）。 */
  private readonly salvageGrants = new Map<string, number>();
  /** 服务器地址（auth store 按 host:port 隔离凭据用）。 */
  private readonly serverAddress: Readonly<{ host: string; port: number }> | null;
  /** 最近一次熔炉掠夺的物品名（诊断留痕，不参与计数）。 */
  private lastFurnaceLoot: string[] = [];
  readonly movementController: MovementController;
  private readonly worldState: WorldStateStore;
  private readonly actionLocks = new ActionLockManager();
  private lastCraftingTableCreatedAt = 0;
  private lastCraftingTablePlacedAt = 0;
  private lastCraftingTablePosition: Vec3 | null = null;
  private lastFurnacePlacedAt = 0;
  private lastFurnacePosition: Vec3 | null = null;
  private lastNearbyBlockScanAt = Number.NEGATIVE_INFINITY;
  private lastNearbyBlockScanContext: string | null = null;
  private nearbyBlockScanCache: readonly NearbyBlockState[] = Object.freeze([]);
  private pathResetCount = 0;
  private currentPathLength: number | null = null;
  private activePathInvocationId: string | null = null;
  private safeForageExplorationCursor = 0;
  private readonly combatAdapter: MineflayerCombatAdapter;
  private readonly noHungerController: NoHungerController;
  /**
   * Round 7 兼容层信号采集：每 client 会话（每条连接）一个 observer，
   * 只在 mineflayer 真实事件上 O(1) append，其余路径零成本。
   * wiring-pending：action-rejected / block-divergence / inventory-divergence
   * 需要服务器侧回包对比（当前 mineflayer 不暴露可判定的拒绝信号），
   * 在有结构化来源之前不伪造这三类信号。
   */
  private readonly compatObserver = new ServerBehaviorObserver();

  /** Facilities are intentionally conservative: a nearby reachable table is
   * always reused, and creation is rate-limited even across separate tasks. */
  readonly craftingTableCreationCooldownMs = 60_000;
  readonly craftingTablePlacementCooldownMs = 20_000;
  readonly maxOwnedCraftingTablesPerArea = CRAFTING_TABLE_POLICY.maxOwnedPerArea;
  readonly craftingTableScanRadius = CRAFTING_TABLE_POLICY.scanRadius;
  readonly furnacePlacementCooldownMs = 20_000;
  readonly maxOwnedFurnacesPerArea = FURNACE_POLICY.maxOwnedPerArea;
  readonly furnaceScanRadius = FURNACE_POLICY.scanRadius;
  /** Expensive findBlocks passes are shared by all state-change events. */
  readonly worldStateBlockScanIntervalMs = 1_000;

  constructor(
    private readonly bot: Bot,
    private readonly configuredVersion: ServerProfile["minecraftVersion"],
    private readonly serverProfileId: string | null = null,
    combatEnabledOrWorldState: boolean | WorldStateStore = false,
    worldState = new WorldStateStore(),
    navigationProfile: ServerProfile["navigation"] = "safe",
    serverAddress: Readonly<{ host: string; port: number }> | null = null,
    noHungerConfig: ServerProfile["noHunger"] = undefined,
  ) {
    /** 无规则服导航档：true = 沿途挖掘/疾跑/跑酷/搭高全部放开。 */
    this.anarchyNavigation = navigationProfile === "anarchy";
    this.serverAddress = serverAddress;
    // Material Provenance：按 serverProfile 持久化（跨重启生效）。
    this.provenanceStore = serverProfileId
      ? new ProvenanceStore({
          persistPath: provenancePersistPath(serverProfileId),
        })
      : null;
    this.noHungerController = attachNoHunger(bot as unknown as NoHungerBot, {
      serverKey: serverAddress
        ? `${serverAddress.host}:${serverAddress.port}`
        : serverProfileId ?? "unknown-server",
      ...(noHungerConfig ? { config: noHungerConfig } : {}),
    });
    const combatEnabled = typeof combatEnabledOrWorldState === "boolean"
      ? combatEnabledOrWorldState
      : false;
    this.worldState = typeof combatEnabledOrWorldState === "boolean"
      ? worldState
      : combatEnabledOrWorldState;
    this.combatAdapter = new MineflayerCombatAdapter(
      bot,
      serverProfileId ?? "",
      combatEnabled,
    );
    // 无规则档放开 PACKET_CRIT（微上移双包暴击）；反作弊档保持物理跳。
    this.combatAdapter.setCriticalPacketAllowed(this.anarchyNavigation);
    this.movementController = new MovementController({
      onPreempt: () => this.stopMovementPrimitives(),
      onRelease: () => this.stopMovementPrimitives(),
    });
    bot.on("login", () => {
      this.loginSeen = true;
    });
    bot.on("spawn", () => {
      this.spawnSeen = true;
      this.lastObservedHealth = finiteNumber(bot.health)
        ? Number(bot.health)
        : null;
      this.bindInventoryEvents();
      // 服务器注册/登录自动认证（AuthMe 等）——全自动，不需要人配任何东西。
      //
      // 密码来源优先级：
      //   1. 环境变量 STUDIO_BOT_AUTH_PASSWORD_<BOT_ID>（运维显式指定）
      //   2. AuthCredentialStore（bot 自管存储：首次自动生成随机密码并
      //      持久化到 ~/.studio-auth/<botId>.json，后续自动读取登录）
      //   3. 都没有 → 生成随机密码（但不持久化，本次连接一次性使用）
      if (this.serverAuthDetach) {
        this.serverAuthDetach();
        this.serverAuthDetach = null;
      }
      const env = process.env as Record<string, string | undefined>;
      const botUsername = (this.bot as { username?: string }).username ?? "";
      const envPassword =
        (botUsername ? resolveServerAuthPassword(botUsername, env) : "") ||
        (this.serverProfileId ? resolveServerAuthPassword(this.serverProfileId, env) : "");
      // bot 自管凭据存储：按 botId 持久化，按服务器 host:port 隔离。
      const store = botUsername ? new AuthCredentialStore(botUsername) : null;
      const serverHost = this.serverAddress?.host ?? "";
      const serverPort = this.serverAddress?.port ?? 25565;
      this.serverAuthDetach = attachServerAuth(
        bot as never,
        {
          // 显式环境变量 > 自管 store
          ...(envPassword ? { password: envPassword } : {}),
          ...(store && serverHost
            ? { store: { getOrCreate: (h, p) => store.getOrCreate(h, p), persist: (h, p, pw) => store.persist(h, p, pw), forget: (h, p) => store.forget(h, p) }, serverHost, serverPort }
            : {}),
          promptTimeoutMs: 10_000,
          confirmTimeoutMs: 8_000,
        },
        (state, detail) => {
          if (state !== "idle") {
            this.handlers?.onStateChanged?.();
          }
        },
      );
      if (!this.chatBound) {
        this.chatBound = true;
        // 只上报玩家聊天（第二参为玩家名时）；服务器广播/系统消息不进指挥通道。
        bot.on("chat", (_username: string, message: string) => {
          if (typeof message !== "string" || message.length === 0) return;
          this.handlers?.onChat?.({
            speaker: _username,
            message: message.slice(0, 512),
          });
        });
      }
      this.handlers?.onSpawn();
    });
    bot.on("health", () => {
      const currentHealth = finiteNumber(bot.health)
        ? Number(bot.health)
        : null;
      const previousHealth = this.lastObservedHealth;
      if (currentHealth !== null) this.lastObservedHealth = currentHealth;
      if (
        currentHealth !== null &&
        previousHealth !== null &&
        currentHealth < previousHealth
      ) {
        this.handlers?.onDamaged?.({
          previousHealth,
          currentHealth,
        });
      }
      this.handlers?.onStateChanged();
    });
    bot.on("breath", () => this.handlers?.onStateChanged());
    bot.on("move", () => this.handlers?.onStateChanged());
    bot.on("physicsTick", () => this.handlers?.onStateChanged());
    // 死亡不是断线：连接保持，但背包清空、位置漂移到重生点。先上报事实
    // （runtime 取消进行中的技能并失效世界状态），再自动写重生包——
    // mineflayer 不会自动 respawn，不写这条包 Bot 会停在死亡屏上直到
    // 服务器踢人。
    bot.on("death", () => {
      const entity = bot.entity as typeof bot.entity & { position?: Vec3 };
      // 门禁 3：当场抓背包快照（盔甲/副手槽都在 inventory.slots 里）+ XP——
      // respawn 后这些就被清空了，事后拿到的只会是空背包。
      const droppedItems = bot.inventory.slots
        .flatMap((item) =>
          item !== null && item.count > 0
            ? [{ itemId: item.name, count: item.count }]
            : [],
        );
      const xpPoints = Number.isFinite(bot.experience?.points)
        ? Math.floor(bot.experience.points)
        : null;
      this.handlers?.onDeath?.({
        position: entity?.position
          ? { x: entity.position.x, y: entity.position.y, z: entity.position.z }
          : null,
        dimension: normalizeDimension(String(this.bot.game?.dimension ?? "minecraft:overworld")),
        droppedItems,
        ...(xpPoints !== null ? { xpPoints } : {}),
      });
      try {
        (bot as unknown as { _client: { write: (channel: string, payload: unknown) => void } })._client.write(
          "client_command",
          { action: "respawn" },
        );
      } catch {
        // 服务器若已断开，"end" 事件路径会接管重连；这里不重复处理。
      }
    });
    bot.on("path_reset", () => {
      this.pathResetCount += 1;
      this.currentPathLength = null;
      this.handlers?.onStateChanged();
    });

    bot.on("spawn", () => {
      // G1 spawn-escape（2026-09-03 luv 实战）：出生点是结构性击杀区
      // （法证：竖井坠落 4.5 伤害 + 井底怪坑；认证后物理放开直接坠落）。
      // anarchy 档第一 tick 沿预设方位疾跑逃离。重触发语义：spawn 事件落在
      // 首个出生点 64 格内（重生/拉回循环）就再逃——床被毁回出生点同样
      // 覆盖；跨维度/远点 spawn（下界门）不触发。env：STUDIO_SPAWN_ESCAPE=0
      // 关闭；_DISTANCE 格数（默认 96）；_BEARING_DEG 方位角（默认 135）。
      this.trySpawnEscape();
    });
    bot.on("path_update", (path) => {
      this.currentPathLength = Number.isSafeInteger(path.path.length)
        ? path.path.length
        : null;
      this.handlers?.onStateChanged();
    });
    bot.on("goal_reached", () => {
      this.currentPathLength = 0;
      this.handlers?.onStateChanged();
    });
    bot.on("path_stop", () => {
      this.currentPathLength = null;
      this.handlers?.onStateChanged();
    });
    bot.on("entityEquip", (entity) => {
      if (entity === bot.entity) this.handlers?.onStateChanged();
    });
    // 服务器强制传送/回拉（rubberband）——反作弊纠正最直接的可观测信号。
    // forcedMove 只在服务器 position 包把 bot 拉到与本地预测不符的位置时发出。
    bot.on("forcedMove", () => {
      const position = bot.entity?.position;
      const detail = position && Number.isFinite(position.x)
        ? `teleported to ${position.x.toFixed(1)} ${position.y.toFixed(1)} ${position.z.toFixed(1)}`
        : undefined;
      this.compatObserver.record({
        kind: "position-correction",
        family: "MOVEMENT",
        ...(detail ? { detail } : {}),
      });
    });
    bot.on("kicked", (reason) => {
      this.kickedDetail = safeDetail(reason);
      this.kickPhase = this.spawnSeen
        ? "POST_SPAWN"
        : this.loginSeen
          ? "POST_LOGIN"
          : "PRE_LOGIN";
      // kick 无法归因到单一动作族（任何族都可能触发）；PACKET_INTENSIVE 是
      // 服务器侧响应的兜底族，仅供窗口统计，不作为族级归因结论。
      this.compatObserver.record({
        kind: "kick",
        family: "PACKET_INTENSIVE",
        ...(this.kickedDetail ? { detail: this.kickedDetail } : {}),
      });
    });
    bot.on("error", (error) => {
      this.errorDetail = safeDetail(error.message);
      // timeout 只在可明确识别时上报（errno/消息），识别不出就不臆断。
      if (isTimeoutLikeError(error)) {
        this.compatObserver.record({
          kind: "timeout",
          family: "PACKET_INTENSIVE",
          ...(this.errorDetail ? { detail: this.errorDetail } : {}),
        });
      }
      if (
        !this.versionUnsupportedReported &&
        isMineflayerUnsupportedVersionError(error)
      ) {
        this.versionUnsupportedReported = true;
        this.handlers?.onVersionUnsupported();
      }
      this.handlers?.onError(error);
    });
    bot.on("end", (reason) => {
      // end 的 reason 串同样只在明确含 timeout 语义时计 timeout。
      if (isTimeoutLikeReason(reason)) {
        const detail = safeDetail(reason);
        this.compatObserver.record({
          kind: "timeout",
          family: "PACKET_INTENSIVE",
          ...(detail ? { detail } : {}),
        });
      }
      // P1（2026-09-03）：部分 Forge 服在 login 期直接断流而非发 kick 包——
      // 裸探针抓到 kick、Runtime 抓到裸 end 的分裂就是这条路径。end 文本含
      // FML/Forge 标记时合成为等价 kick（PRE_LOGIN），保证与裸探针同等捕获。
      let kickedDetail = this.kickedDetail;
      let kickPhase = this.kickPhase;
      if (
        kickedDetail === undefined &&
        typeof reason === "string" &&
        /FML|Forge/iu.test(reason)
      ) {
        kickedDetail = safeDetail(reason);
        kickPhase = this.spawnSeen
          ? "POST_SPAWN"
          : this.loginSeen
            ? "POST_LOGIN"
            : "PRE_LOGIN";
      }
      this.handlers?.onDisconnected(
        mapDisconnectReason(
          this.requestedStop,
          this.versionUnsupportedReported,
          kickedDetail,
          this.errorDetail,
          reason,
          kickPhase,
        ),
      );
    });
  }

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  noHungerSnapshot() {
    return this.noHungerController.snapshot();
  }

  snapshot(): BotClientSnapshot {
    const position = this.bot.entity.position;
    const ping = this.bot.player?.ping;
    const entityState = this.bot.entity as typeof this.bot.entity &
      SafetyEntityState;
    const inventoryStart = this.bot.inventory.inventoryStart;
    const inventoryEnd = this.bot.inventory.inventoryEnd;
    const inventorySlots =
      Number.isInteger(inventoryStart) &&
      Number.isInteger(inventoryEnd) &&
      inventoryEnd >= inventoryStart
        ? this.bot.inventory.slots.slice(inventoryStart, inventoryEnd)
        : [];
    const inventoryCounts = new Map<string, { count: number; durability?: { durability: number; maxDurability: number } }>();
    for (const item of this.bot.inventory.items()) {
      if (
        typeof item.name !== "string" ||
        !Number.isSafeInteger(item.count) ||
        item.count < 1
      ) {
        continue;
      }
      const existing = inventoryCounts.get(item.name);
      // 工具类不堆叠：耐久取该名下任意一件的读数即可。协调器用它在
      // 工具断掉之前提前补替代品，而不是等 COLLECT_TOOL_MISSING。
      const durability = existing?.durability ?? toolDurability(item);
      inventoryCounts.set(item.name, {
        count: (existing?.count ?? 0) + item.count,
        ...(durability ? { durability } : {}),
      });
    }
    return {
      health: {
        current: this.bot.health,
        maximum: readMaximumHealth(this.bot),
      },
      food: {
        level: this.bot.food,
        saturation: this.bot.foodSaturation,
      },
      armorPoints: readArmorPoints(this.bot),
      armorSlots: readArmorSlots(this.bot),
      inventory: [...inventoryCounts.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([itemName, entry]) => ({
          itemName,
          count: entry.count,
          ...(entry.durability
            ? {
                durability: entry.durability.durability,
                maxDurability: entry.durability.maxDurability,
              }
            : {}),
        })),
      position: {
        x: position.x,
        y: position.y,
        z: position.z,
        // mineflayer 用弧度；yaw 与 Minecraft 内部一致（顺时针），Dashboard
        // 直接消费。读不到时省略，前端按"无视角数据"处理。
        ...(Number.isFinite(this.bot.entity.yaw)
          ? { yaw: this.bot.entity.yaw }
          : {}),
        ...(Number.isFinite(this.bot.entity.pitch)
          ? { pitch: this.bot.entity.pitch }
          : {}),
        dimension: normalizeDimension(String(this.bot.game.dimension)),
      },
      latencyMs:
        typeof ping === "number" && Number.isFinite(ping) && ping >= 0
          ? Math.round(ping)
          : null,
      safety: {
        oxygenLevel:
          Number.isInteger(this.bot.oxygenLevel) &&
          this.bot.oxygenLevel >= 0 &&
          this.bot.oxygenLevel <= 20
            ? this.bot.oxygenLevel
            : null,
        inWater: entityState.isInWater === true,
        inLava: entityState.isInLava === true,
        onGround: this.bot.entity.onGround === true,
        velocityY: Number.isFinite(this.bot.entity.velocity.y)
          ? this.bot.entity.velocity.y
          : null,
        inventory: {
          usedSlots: inventorySlots.filter((item) => item !== null).length,
          totalSlots: inventorySlots.length,
        },
        hasSafeFood: this.safeFoodItems().length > 0,
        movementRequested: (["forward", "back", "left", "right"] as const)
          .some((control) => this.bot.getControlState(control)),
      },
    };
  }

  /**
   * Build a bounded, event-friendly world snapshot from Mineflayer facts. The
   * runtime keeps the returned data in its own cache, so callers never need to
   * ask an LLM for inventory or nearby workstation state.
   */
  worldStateSnapshot(): WorldStateSnapshot {
    const current = this.snapshot();
    const serverProfileId = this.serverProfileId ?? "unknown-server";
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const inventory: InventoryItemState[] = this.bot.inventory.items().map((item) => {
      const candidate = item as typeof item & {
        durabilityUsed?: number;
        maxDurability?: number;
      };
      const maxDurability = Number.isFinite(candidate.maxDurability)
        ? candidate.maxDurability!
        : null;
      const durability = maxDurability !== null && Number.isFinite(candidate.durabilityUsed)
        ? Math.max(0, maxDurability - candidate.durabilityUsed!)
        : null;
      return { name: item.name, count: item.count, durability, maxDurability };
    });
    const origin = {
      x: current.position.x,
      y: current.position.y,
      z: current.position.z,
      dimension: current.position.dimension,
      serverProfileId,
    } as const;
    const scanContext = `${serverProfileId}|${current.position.dimension}`;
    if (
      scanContext !== this.lastNearbyBlockScanContext ||
      nowMs < this.lastNearbyBlockScanAt ||
      nowMs - this.lastNearbyBlockScanAt >= this.worldStateBlockScanIntervalMs
    ) {
      const nearbyBlocks: NearbyBlockState[] = [];
      const registry = this.bot.registry as unknown as {
        blocksByName?: Record<string, { id: number } | undefined>;
      };
      for (const name of importantBlockNames) {
        const id = registry.blocksByName?.[name]?.id;
        if (!Number.isSafeInteger(id)) continue;
        let positions: Vec3[] = [];
        try {
          positions = this.bot.findBlocks({
            matching: id!,
            maxDistance: 32,
            count: 8,
          });
        } catch {
          continue;
        }
        for (const position of positions) {
          const block = this.bot.blockAt(position);
          if (!block || block.name !== name) continue;
          const distance = Math.hypot(
            position.x - origin.x,
            position.y - origin.y,
            position.z - origin.z,
          );
          nearbyBlocks.push({
            name,
            position: {
              ...origin,
              x: position.x,
              y: position.y,
              z: position.z,
            },
            lastSeen: now,
            reachable: distance <= 4.5,
            source: "observation",
            confidence: 1,
          });
        }
      }
      this.nearbyBlockScanCache = Object.freeze(nearbyBlocks);
      this.lastNearbyBlockScanAt = nowMs;
      this.lastNearbyBlockScanContext = scanContext;
    }
    const entities: EntityState[] = [];
    const hostileNames = new Set(["zombie", "skeleton", "creeper", "spider", "enderman", "witch", "pillager", "vindicator", "phantom", "blaze", "ghast", "magma_cube", "slime", "warden"]);
    for (const entity of Object.values(this.bot.entities ?? {})) {
      const id = String(entity.id ?? "");
      const position = entity.position;
      if (!id || !position || !Number.isFinite(position.x) || !Number.isFinite(position.y) || !Number.isFinite(position.z)) continue;
      const name = String(entity.name ?? entity.displayName ?? "unknown");
      entities.push({
        entityId: id,
        name,
        position: { ...origin, x: position.x, y: position.y, z: position.z },
        hostile: hostileNames.has(name),
        lastSeen: now,
        confidence: 1,
      });
    }
    const movementLease = this.movementController.currentLease();
    const navigationTarget = this.movementGoalPosition(movementLease?.goal);
    this.worldState.observe({
      observedAt: new Date(now),
      position: origin,
      inventory,
      nearbyBlocks: this.nearbyBlockScanCache,
      replaceNearbyBlocks: true,
      entities,
      navigation: {
        target: navigationTarget,
        movementOwner: movementLease?.owner ?? null,
        pathLength: this.currentPathLength,
        pathResetCount: this.pathResetCount,
      },
    });
    return this.worldState.snapshot();
  }

  private movementGoalPosition(goal: unknown): WorldPosition | null {
    if (typeof goal !== "object" || goal === null || Array.isArray(goal)) {
      return null;
    }
    const candidate = goal as Partial<WorldPosition>;
    if (
      ![candidate.x, candidate.y, candidate.z].every(
        (value) => typeof value === "number" && Number.isFinite(value),
      ) ||
      typeof candidate.dimension !== "string" ||
      candidate.dimension.length === 0 ||
      typeof candidate.serverProfileId !== "string" ||
      candidate.serverProfileId !== this.serverProfileId
    ) {
      return null;
    }
    return {
      x: candidate.x!,
      y: candidate.y!,
      z: candidate.z!,
      dimension: candidate.dimension,
      serverProfileId: candidate.serverProfileId,
    };
  }

  async executeSafetyAction(
    action: L0SafetyAction,
  ): Promise<L0SafetyActionResult> {
    if (this.requestedStop) {
      return { outcome: "skipped", errorCode: "RUNTIME_STOPPING" };
    }
    const movementPriority =
      action.kind === "RETREAT_STEP" || action.kind === "ESCAPE_LAVA"
        ? MOVEMENT_PRIORITIES.ESCAPE
        : MOVEMENT_PRIORITIES.EMERGENCY;
    const movementLease = this.movementController.acquire({
      owner: `safety:${action.kind}`,
      priority: movementPriority,
    });
    if (movementLease === null) {
      return { outcome: "skipped", errorCode: "MOVEMENT_BUSY" };
    }
    try {
      this.interruptNormalActions();
      if (
        action.kind === "PAUSE_NORMAL_TASKS" ||
        action.kind === "HALT_HORIZONTAL_MOVEMENT"
      ) {
        this.bot.clearControlStates();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "CONSUME_SAFE_FOOD") {
        const food = this.safeFoodItems()[0];
        if (!food) return { outcome: "skipped", errorCode: "NO_SAFE_FOOD" };
        this.bot.clearControlStates();
        await this.actionLocks.withLock(
          "inventory",
          {
            owner: `safety:${action.kind}`,
            ttlMs: ACTION_LOCK_TTL_MS,
          },
          async () => {
            await this.bot.equip(food.item, "hand");
            await this.bot.consume();
          },
        );
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "FORAGE_SAFE_FOOD") {
        return await this.forageSafeFood();
      }
      if (action.kind === "RETREAT_STEP") {
        await this.applyBoundedControls(
          action.durationMs,
          ["back", "sprint"],
          movementLease,
        );
        movementLease.assertCurrent();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "ASCEND") {
        await this.applyBoundedControls(
          action.durationMs,
          ["jump"],
          movementLease,
        );
        movementLease.assertCurrent();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "ESCAPE_LAVA") {
        await this.applyBoundedControls(
          action.durationMs,
          ["jump", "forward"],
          movementLease,
        );
        movementLease.assertCurrent();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "UNSTICK") {
        await this.applyBoundedControls(
          action.durationMs,
          ["jump", "back"],
          movementLease,
        );
        movementLease.assertCurrent();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "TIDY_DROP_JUNK") {
        return await this.tidyDropJunk();
      }
      return { outcome: "skipped", errorCode: "RUNTIME_ACTION_REQUIRED" };
    } catch {
      if (movementLease.isCurrent()) this.bot.clearControlStates();
      return { outcome: "failed", errorCode: "SAFETY_ACTION_FAILED" };
    } finally {
      movementLease.release(
        movementLease.signal.aborted ? "cancelled" : "completed",
      );
    }
  }

  async executeRecoveryAction(
    action: BotRecoveryAction,
  ): Promise<BotRecoveryActionResult> {
    if (this.requestedStop) {
      return { outcome: "skipped", errorCode: "RUNTIME_STOPPING" };
    }
    if (
      !Number.isSafeInteger(action.durationMs) ||
      action.durationMs < 100 ||
      action.durationMs > 2_000
    ) {
      return { outcome: "failed", errorCode: "RECOVERY_ACTION_INVALID" };
    }
    const previous = this.movementController.currentLease();
    if (previous === null) {
      return { outcome: "skipped", errorCode: "NO_ACTIVE_MOVEMENT" };
    }
    if (previous.taskId !== undefined && previous.taskId !== action.taskId) {
      return { outcome: "skipped", errorCode: "RECOVERY_TASK_MISMATCH" };
    }
    const lease = this.movementController.acquire({
      owner: `recovery:watchdog:${action.kind}`,
      priority: MOVEMENT_PRIORITIES.RECOVERY,
      taskId: action.taskId,
      goal: previous.goal,
      metadata: { trigger: action.trigger },
    });
    if (lease === null) {
      return { outcome: "skipped", errorCode: "MOVEMENT_BUSY" };
    }
    try {
      lease.assertCurrent();
      this.stopMovementPrimitives();
      const controls = action.kind === "local-unstick"
        ? (["jump", "back"] as const)
        : (["back", "left"] as const);
      await this.applyBoundedControls(action.durationMs, controls, lease);
      lease.assertCurrent();
      return { outcome: "executed", errorCode: null };
    } catch {
      if (lease.isCurrent()) this.bot.clearControlStates();
      return { outcome: "failed", errorCode: "WATCHDOG_RECOVERY_FAILED" };
    } finally {
      lease.release(lease.signal.aborted ? "cancelled" : "completed");
    }

  }

  async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    if (this.requestedStop) {
      throw new SkillFault("RUNTIME_STOPPING");
    }
    if (!this.serverProfileId) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    if (
      request.capability === "bot.move" &&
      request.operation === "travel.route-segment"
    ) {
      const input = travelRouteCapabilityInputSchema.safeParse(request.input);
      if (!input.success) {
        throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
      }
      return this.invokeMovementGoto({
        ...request,
        input: { target: input.data.target, radius: input.data.radius },
      });
    }
    if (
      request.capability === "bot.move" &&
      request.operation === "pathfinder.goto-safe"
    ) {
      return this.invokeMovementGoto(request);
    }
    if (
      request.capability === "inventory.read" &&
      request.operation === "armor.snapshot"
    ) {
      return this.invokeArmorSnapshot(request);
    }
    if (
      request.capability === "inventory.read" &&
      request.operation === "inventory.snapshot"
    ) {
      return this.invokeInventorySnapshot(request);
    }
    if (
      request.capability === "inventory.write" &&
      request.operation === "armor.equip"
    ) {
      return this.withActionLocks(request, ["inventory"], () =>
        this.invokeArmorEquip(request),
      );
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "collect.blocks-safe"
    ) {
      return this.withActionLocks(
        request,
        ["blockInteraction", "inventory"],
        () => this.invokeCollectBlocks(request),
      );
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "craft.item-safe"
    ) {
      return this.withActionLocks(request, ["crafting", "inventory"], () =>
        this.invokeCraftItem(request),
      );
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "smelt.item-safe"
    ) {
      return this.withActionLocks(
        request,
        ["crafting", "container", "inventory"],
        () => this.invokeSmeltItem(request),
      );
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "block.place-safe"
    ) {
      const blueprintInput = buildBlueprintCapabilityInputSchema.safeParse(request.input);
      const invokePlacement = (placementRequest: SkillCapabilityRequest) =>
        this.withActionLocks(
          placementRequest,
          ["blockInteraction", "inventory"],
          () => this.invokePlaceBlock(placementRequest),
        );
      if (blueprintInput.success) {
        const { target, blueprintIndex: _blueprintIndex, ...placement } = blueprintInput.data;
        const expectedTarget = {
          x: placement.referenceBlock.x + placement.face.x,
          y: placement.referenceBlock.y + placement.face.y,
          z: placement.referenceBlock.z + placement.face.z,
        };
        if (
          target.x !== expectedTarget.x ||
          target.y !== expectedTarget.y ||
          target.z !== expectedTarget.z
        ) {
          throw new SkillFault("BLUEPRINT_STEP_BLOCKED");
        }
        return invokePlacement({ ...request, input: placement });
      }
      return invokePlacement(request);
    }
    if (
      request.capability === "container.write" &&
      request.operation === "container.transfer-safe"
    ) {
      return this.withActionLocks(request, ["container", "inventory"], () =>
        this.invokeContainerTransfer(request),
      );
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "trade.villager-safe"
    ) {
      return this.invokeTradeVillager(request);
    }
    if (
      request.capability === "world.read" &&
      request.operation === "site.observe-safe"
    ) {
      return this.invokeSiteObservation(request);
    }
    if (
      request.capability === "world.read" &&
      request.operation === "world.scan-blocks-safe"
    ) {
      return this.invokeScanBlocks(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "shelter.dig-safe"
    ) {
      return this.invokeShelterDig(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "food.forage-safe"
    ) {
      return this.withActionLocks(request, ["blockInteraction", "inventory"], () =>
        this.invokeSecureFood(request),
      );
    }
    if (
      request.capability === "world.interact" &&
      (request.operation === "mine.branch-safe" || request.operation === "mine.vein-safe")
    ) {
      return this.invokeMinePlan(request);
    }
    throw new SkillFault("SKILL_CAPABILITY_UNSUPPORTED");
  }

  /**
   * Acquire a capability's resources in declaration order and release them in
   * reverse order. Station helpers may request a lock already held by the same
   * invocation; that is a re-entrant no-op rather than a self-deadlock.
   */
  private async withActionLocks<T>(
    request: SkillCapabilityRequest,
    kinds: readonly ActionLockKind[],
    work: () => Promise<T>,
  ): Promise<T> {
    const owner = `${request.taskId}:${request.invocationId}`;
    const acquire = async (index: number): Promise<T> => {
      const kind = kinds[index];
      if (kind === undefined) return work();
      if (this.actionLocks.ownerOf(kind) === owner) {
        return acquire(index + 1);
      }
      return this.actionLocks.withLock(
        kind,
        { owner, ttlMs: ACTION_LOCK_TTL_MS, signal: request.signal },
        () => acquire(index + 1),
      );
    };

    try {
      return await acquire(0);
    } catch (error) {
      if (!(error instanceof ActionLockError)) throw error;
      if (error.code === "LOCK_CANCELLED") {
        throw new SkillFault("SKILL_CANCELLED", "Skill action was cancelled.");
      }
      if (error.code === "LOCK_BUSY") {
        throw new SkillFault(
          "ACTION_LOCK_BUSY",
          "Another bot action owns a required resource.",
        );
      }
      throw new SkillFault(
        "ACTION_LOCK_FAILED",
        "The bot action resource lock failed.",
      );
    }
  }

  private async invokeSiteObservation(request: SkillCapabilityRequest): Promise<unknown> {
    const input = siteObserveCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.candidate.serverProfileId);
    this.assertDimensionMatch(input.data.candidate.dimension);
    return siteObserveCapabilityOutputSchema.parse(observeSite(this.bot, this.serverProfileId!, input.data));
  }

  /**
   * 只读方块扫描。与 `invokeCollectBlocks` 共用 registry.blocksByName →
   * findBlocks → blockAt 这条链，但到 blockAt 就停：不设 canDig、不动
   * pathfinder、不碰背包。`complete` 记录的是这条链有没有走完——findBlocks
   * 报了坐标而 blockAt 读不到（区块未加载）时，那一项进不了 matches，
   * 于是 complete 为 false。把它当成"附近没有"会让上层误判。
   *
   * matches 只含**至少一面临空**的方块，和 collect 的候选筛选是同一个谓词。
   * 这不是"少报"：这份结果的用途就是给 collect.block 瞄准，报一个采集器
   * 到不了的坐标比不报更糟。全埋的矿脉因此会显示为 0 命中——那也是诚实的，
   * 因为在当前配置下（非目标方块破除代价 100）它确实取不到。
   */
  private async invokeScanBlocks(request: SkillCapabilityRequest): Promise<unknown> {
    const input = scanBlocksCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id: number } | undefined>;
    };
    const blockType = registry.blocksByName?.[input.data.blockName];
    if (!blockType) throw new SkillFault("BLOCK_NAME_UNKNOWN");
    const origin = this.bot.entity?.position;
    if (!origin) throw new SkillFault("SKILL_CAPABILITY_FAILED");
    // 与 collect 用同一个可达谓词。若扫描把全埋的方块也报成 matches，
    // 上层就会照着这份坐标去派 collect.block，而 collect 已经筛掉了它们——
    // 两侧不一致的后果是规划器一直瞄准采集器根本不会接受的目标。
    const positions = this.bot.findBlocks({
      matching: blockType.id,
      maxDistance: input.data.maxDistance,
      count: input.data.maxCount,
      useExtraInfo: reachableCandidateFilter(this.bot),
    });
    const matches = positions
      .filter((position) => this.bot.blockAt(position) !== null)
      .map((position) => ({
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
        distance: origin.distanceTo(position),
      }))
      .sort((left, right) => left.distance - right.distance);
    return scanBlocksCapabilityOutputSchema.parse({
      blockName: input.data.blockName,
      dimension: input.data.dimension,
      matches,
      targetsFound: positions.length,
      complete: matches.length === positions.length,
    });
  }

  private async invokeShelterDig(request: SkillCapabilityRequest): Promise<unknown> {
    const input = shelterDigCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const restoreServerConfirmedDigging = this.installServerConfirmedDigging(request.signal);
    try {
      const output = await digShelter(this.bot, this.serverProfileId!, input.data, request.signal);
      return shelterDigCapabilityOutputSchema.parse(output);
    } finally {
      restoreServerConfirmedDigging();
    }
  }

  private async invokeMinePlan(request: SkillCapabilityRequest): Promise<unknown> {
    const isBranch = request.operation === "mine.branch-safe";
    const input = (isBranch ? mineBranchCapabilityInputSchema : mineVeinCapabilityInputSchema).safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const plan = input.data.plan;
    if (
      plan.targetItem !== input.data.targetItem ||
      plan.yLevel !== input.data.yLevel ||
      plan.steps.length > input.data.maxBlocks * 2
    ) {
      throw new SkillFault("MINE_PLAN_MISMATCH");
    }

    const restoreServerConfirmedDigging = this.installServerConfirmedDigging(request.signal);
    try {
      for (let stepIndex = 0; stepIndex < plan.steps.length; stepIndex += 1) {
        const step = plan.steps[stepIndex]!;
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        if (step.targetItem !== input.data.targetItem || step.index !== stepIndex) {
          throw new SkillFault("MINE_PLAN_MISMATCH");
        }
        if (step.kind === "return") {
          await this.moveMineToTarget(
            request,
            new Vec3(step.position.x, step.position.y, step.position.z),
            false,
          );
          continue;
        }

        const targetPosition = new Vec3(step.position.x, step.position.y, step.position.z);
        await this.moveMineToTarget(request, targetPosition, true);
        const target = this.bot.blockAt(targetPosition);
        if (
          !target ||
          target.boundingBox === "empty" ||
          !this.matchesBlockName(target.name, input.data.targetItem)
        ) {
          throw new SkillFault("MINE_NO_TARGET");
        }
        if (!hasReachableFace(this.bot, targetPosition)) {
          throw new SkillFault("COLLECT_TARGET_UNREACHABLE");
        }
        if (
          typeof target.canHarvest !== "function" ||
          !canHarvestWithInventory(this.bot, target)
        ) {
          throw new SkillFault("COLLECT_TOOL_MISSING");
        }

        const tool = this.bot.inventory.items().find((item) =>
          target.canHarvest(item.type) === true,
        );
        if (!tool) throw new SkillFault("COLLECT_TOOL_MISSING");
        try {
          await this.bot.equip(tool, "hand");
          await this.bot.dig(target);
        } catch (error) {
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          throw new SkillFault(
            "MINE_DIG_FAILED",
            error instanceof Error && error.message.trim().length > 0
              ? error.message.trim()
              : undefined,
          );
        }

        const broken = this.bot.blockAt(targetPosition);
        if (!broken || broken.boundingBox !== "empty") {
          throw new SkillFault("MINE_BLOCK_NOT_CONFIRMED");
        }
        if (step.backfill) await this.backfillMineStep(request, targetPosition);
      }
    } finally {
      restoreServerConfirmedDigging();
      this.bot.clearControlStates();
      this.stopPathfinder();
    }
    return (isBranch ? mineBranchCapabilityOutputSchema : mineVeinCapabilityOutputSchema).parse(plan);
  }

  private matchesBlockName(actual: string, requested: string): boolean {
    const unqualified = requested.includes(":")
      ? requested.slice(requested.indexOf(":") + 1)
      : requested;
    return actual === requested || actual === unqualified;
  }

  private async moveMineToTarget(
    request: SkillCapabilityRequest,
    target: Vec3,
    lookAtBlock: boolean,
  ): Promise<void> {
    if (!this.bot.pathfinder) throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    if (this.activePathInvocationId !== null) throw new SkillFault("BOT_MOVEMENT_BUSY");
    const current = this.bot.entity.position;
    const distance = current.distanceTo(target);
    if (!Number.isFinite(distance) || distance > SAFE_PATH_MAX_DISTANCE) {
      throw new SkillFault("TARGET_OUT_OF_SAFE_RANGE");
    }
    const movements = configureNavigationMovements(new Movements(this.bot), this.bot, this.anarchyNavigation);
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.thinkTimeout = MINE_PATH_THINK_TIMEOUT_MS;
    this.bot.pathfinder.tickTimeout = MINE_PATH_TICK_TIMEOUT_MS;
    this.activePathInvocationId = request.invocationId;
    const stopOnAbort = () => this.stopPathfinder();
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await this.bot.pathfinder.goto(
        lookAtBlock
          ? new goals.GoalLookAtBlock(target, this.bot.world)
          : new goals.GoalNear(target.x, target.y, target.z, 1),
      );
    } catch (error) {
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      const reason =
        error instanceof Error && error.message.trim().length > 0
          ? `${error.name}: ${error.message.trim()}`
          : undefined;
      throw new SkillFault(
        error instanceof Error && error.name === "NoPath"
          ? "COLLECT_TARGET_UNREACHABLE"
          : "MINE_PATH_FAILED",
        reason,
      );
    } finally {
      request.signal.removeEventListener("abort", stopOnAbort);
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
    }
    const finalDistance = this.bot.entity.position.distanceTo(target);
    const allowedDistance = lookAtBlock ? MINE_TARGET_REACH_DISTANCE : 1.5;
    if (!Number.isFinite(finalDistance) || finalDistance > allowedDistance) {
      throw new SkillFault("MINE_TARGET_OUT_OF_REACH");
    }
  }

  private async backfillMineStep(
    request: SkillCapabilityRequest,
    targetPosition: Vec3,
  ): Promise<void> {
    const target = this.bot.blockAt(targetPosition);
    if (target && target.boundingBox !== "empty") {
      throw new SkillFault("MINE_BLOCK_NOT_CONFIRMED");
    }
    const item = this.bot.inventory.items().find((candidate) =>
      MINE_BACKFILL_ITEMS.includes(
        candidate.name as (typeof MINE_BACKFILL_ITEMS)[number],
      ),
    );
    if (!item) throw new SkillFault("MINE_BACKFILL_MATERIAL_MISSING");
    for (const [dx, dy, dz] of CANDIDATE_FACES) {
      const referencePosition = targetPosition.offset(dx, dy, dz);
      const reference = this.bot.blockAt(referencePosition);
      if (
        !reference ||
        reference.boundingBox === "empty" ||
        CANDIDATE_FACE_LIQUIDS.has(reference.name)
      ) {
        continue;
      }
      try {
        await this.invokePlaceBlock({
          ...request,
          input: {
            itemName: item.name,
            referenceBlock: {
              x: referencePosition.x,
              y: referencePosition.y,
              z: referencePosition.z,
            },
            face: { x: -dx, y: -dy, z: -dz },
            dimension: normalizeDimension(String(this.bot.game.dimension)),
            serverProfileId: this.serverProfileId,
          },
        });
        return;
      } catch (error) {
        if (error instanceof SkillFault && error.code === "PLACE_TARGET_OCCUPIED") {
          continue;
        }
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      }
    }
    throw new SkillFault("MINE_BACKFILL_FAILED");
  }

  private async invokeTradeVillager(request: SkillCapabilityRequest): Promise<unknown> {
    const input = tradeVillagerCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const entities = Object.values(this.bot.entities ?? {}) as Array<any>;
    const villager = entities
      .filter((entity) => String(entity?.name ?? "").toLowerCase() === "villager")
      .filter((entity) => input.data.villagerEntityId === "nearest" || String(entity?.id) === input.data.villagerEntityId)
      .sort((left, right) =>
        this.bot.entity.position.distanceTo(left.position) -
        this.bot.entity.position.distanceTo(right.position),
      )[0];
    if (!villager) throw new SkillFault("VILLAGER_NOT_FOUND");
    const distance = this.bot.entity.position.distanceTo(villager.position);
    if (!Number.isFinite(distance) || distance > 3.8) throw new SkillFault("VILLAGER_OUT_OF_REACH");
    const botWithTrade = this.bot as Bot & {
      openVillager?: (entity: unknown) => Promise<any>;
      trade?: (entity: unknown, index: number, times: number) => Promise<void>;
    };
    if (typeof botWithTrade.openVillager !== "function" || typeof botWithTrade.trade !== "function") {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    let window: any = null;
    try {
      window = await botWithTrade.openVillager(villager);
      const trades = Array.isArray(window?.trades) ? window.trades : [];
      const index = trades.findIndex((trade: any) => String(trade?.outputItem?.name ?? trade?.outputItem?.type) === input.data.wantItem);
      if (index < 0) throw new SkillFault("TRADE_OFFER_NOT_FOUND");
      const trade = trades[index] as any;
      const uses = Number(trade?.nbTradeUses ?? trade?.uses ?? 0);
      const maximum = Number(trade?.maximumNbTradeUses ?? trade?.maxUses ?? 0);
      if (trade?.tradeDisabled === true || (maximum > 0 && uses >= maximum)) throw new SkillFault("TRADE_DISABLED");
      const realPrice = Math.max(0, Number(trade?.realPrice ?? trade?.inputItem1?.count ?? trade?.price ?? 0));
      const specialPrice = Math.max(0, Number(trade?.specialPrice ?? realPrice));
      if (realPrice > input.data.maxUnitPrice || specialPrice > input.data.maxUnitPrice) throw new SkillFault("TRADE_PRICE_UNACCEPTABLE");
      const paymentName = String(trade?.inputItem1?.name ?? trade?.inputItem1?.type ?? "");
      if (!paymentName || this.countInventoryItem(paymentName) < realPrice) throw new SkillFault("TRADE_ITEM_NOT_IN_INVENTORY");
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      const beforeSpent = this.countInventoryItem(paymentName);
      const beforeReceived = this.countInventoryItem(input.data.wantItem);
      const maxAvailable = maximum > 0 ? Math.max(0, maximum - uses) : input.data.maxTrades;
      const times = Math.min(input.data.maxTrades, maxAvailable);
      await botWithTrade.trade(window, index, times);
      // Mineflayer copies merchant-window slots back into the player
      // inventory when the window closes. Read deltas only after that sync;
      // otherwise a successful server-side trade is reported as uncertain.
      window.close?.();
      window = null;
      const spent = Math.max(0, beforeSpent - this.countInventoryItem(paymentName));
      const received = Math.max(0, this.countInventoryItem(input.data.wantItem) - beforeReceived);
      const completedTrades = Math.min(times, received > 0 ? Math.max(1, Math.floor(received / Math.max(1, Number(trade?.outputItem?.count ?? 1)))) : Math.floor(spent / Math.max(1, realPrice)));
      if (completedTrades < 1) throw new SkillFault("NON_IDEMPOTENT_RESULT_UNCERTAIN");
      return tradeVillagerCapabilityOutputSchema.parse({
        villagerEntityId: String(villager.id),
        wantItem: input.data.wantItem,
        requestedTrades: input.data.maxTrades,
        completedTrades,
        receivedCount: received,
        spentCount: spent,
        actualUnitPrice: Math.ceil(spent / completedTrades),
      });
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("SKILL_CAPABILITY_FAILED");
    } finally {
      try { window?.close?.(); } catch { /* close is best effort */ }
    }
  }
  combatObservation(nowMs: number): CombatDriverObservation | null {
    return this.combatAdapter.observation(nowMs);
  }

  /**
   * 兼容层信号快照（最近 60s bounded 事件 + 每 family 窗口统计）。
   * 与 combatObservation 同级的观测边界：只读、无副作用。
   */
  compatSignals(): CompatSignalsSnapshot {
    const familyStats: Record<string, FamilyWindowStats> = {};
    for (const family of ACTION_FAMILIES) {
      familyStats[family] = this.compatObserver.familyStats(family);
    }
    return {
      stats: this.compatObserver.stats,
      events: this.compatObserver.snapshot(60_000),
      familyStats,
    };
  }

  executeCombatAction(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ): Promise<CombatActionAcknowledgement> {
    return this.combatAdapter.execute(action, signal);
  }

  resetCombat(): void {
    this.combatAdapter.reset();
  }

  setCombatClock(clock: () => number): void {
    this.combatAdapter.setClock(clock);
  }

  interruptNormalActions(): void {
    this.releaseCollectBlockTask();
    this.activePathInvocationId = null;
    // 连接失败/半初始化的 bot 没有 clearControlStates（mineflayer 装好后才有）。
    // 断开路径上这里抛 TypeError 会直接杀死进程（Round 6.1 场景 H 实测：
    // 连接撞上暂停的服务器 → protocol fatal → 断开 → 此处崩溃）。
    // 中断动作本来就是 best-effort——bot 都断了，没有可清的控制状态。
    if (typeof this.bot.clearControlStates === "function") {
      this.bot.clearControlStates();
    }
  }

  private async invokeMovementGoto(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    if (!this.bot.pathfinder) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }

    const input = safeMovementGotoCapabilityInputSchema.safeParse(
      request.input,
    );
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    const currentDimension = normalizeDimension(String(this.bot.game.dimension));
    if (input.data.target.serverProfileId !== this.serverProfileId) {
      throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
    }
    if (input.data.target.dimension !== currentDimension) {
      throw new SkillFault("TARGET_DIMENSION_MISMATCH");
    }

    const startingPosition = this.bot.entity.position;
    const startingDistance = Math.hypot(
      input.data.target.x - startingPosition.x,
      input.data.target.y - startingPosition.y,
      input.data.target.z - startingPosition.z,
    );
    if (
      !Number.isFinite(startingDistance) ||
      startingDistance > SAFE_PATH_MAX_DISTANCE
    ) {
      throw new SkillFault("TARGET_OUT_OF_SAFE_RANGE");
    }

    const lease = this.movementController.acquire({
      owner: `skill:${request.skillId}:${request.invocationId}`,
      priority: MOVEMENT_PRIORITIES.TASK_NAVIGATION,
      taskId: request.taskId,
      goal: input.data.target,
      signal: request.signal,
    });
    if (lease === null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
    }

    const movements = configureSafePathfinderMovements(
      new Movements(this.bot),
    );
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.thinkTimeout = 5_000;
    this.bot.pathfinder.tickTimeout = 20;
    this.activePathInvocationId = request.invocationId;
    // GoalNear measures integer path nodes, while the public contract measures
    // the entity position. Reserve half a block for the entity's offset inside
    // its current node so a radius-1 goal cannot resolve one block away and
    // then fail the postcondition at roughly 1.58 blocks.
    const pathfinderRadius = Math.max(0, input.data.radius - 0.5);

    const stopOnAbort = () => this.stopPathfinder();
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal.aborted || lease.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      await this.bot.pathfinder.goto(
        new goals.GoalNear(
          input.data.target.x,
          input.data.target.y,
          input.data.target.z,
          pathfinderRadius,
        ),
      );
      if (!lease.isCurrent()) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      const finalPosition = this.bot.entity.position;
      const distanceToTarget = Math.hypot(
        input.data.target.x - finalPosition.x,
        input.data.target.y - finalPosition.y,
        input.data.target.z - finalPosition.z,
      );
      if (
        !Number.isFinite(distanceToTarget) ||
        distanceToTarget > input.data.radius + 0.5
      ) {
        throw new SkillFault("PATH_TARGET_NOT_REACHED");
      }
      return safeMovementGotoCapabilityOutputSchema.parse({
        reached: true,
        finalPosition: {
          x: finalPosition.x,
          y: finalPosition.y,
          z: finalPosition.z,
          dimension: currentDimension,
          serverProfileId: this.serverProfileId,
        },
        distanceToTarget,
      });
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      if (lease.signal.aborted || !lease.isCurrent()) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      this.stopPathfinder();
      // pathfinder 用 error.name 区分 NoPath / Timeout / GoalChanged /
      // PathStopped（lib/goto.js:26-40），全丢掉就只剩一个"走不过去"，
      // 运维侧再也分不出是没有路还是思考预算不够。屏蔽码保持不变，
      // 原因走 onFault 进宿主日志。
      throw new SkillFault(
        "PATHFINDER_GOTO_FAILED",
        error instanceof Error && error.message.trim().length > 0
          ? `${error.name}: ${error.message.trim()}`
          : "pathfinder rejected without a message.",
      );
    } finally {
      lease.release(lease.signal.aborted ? "cancelled" : "completed");
    }
  }

  private assertServerProfileMatch(requestedProfileId: string): void {
    if (requestedProfileId !== this.serverProfileId) {
      throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
    }
  }

  /** Bounded real inventory readback used by deterministic closed-loop goals. */
  private async invokeInventorySnapshot(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = inventorySnapshotCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }

    const counts = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      if (typeof item.name !== "string" || item.name.length === 0) continue;
      counts.set(item.name, (counts.get(item.name) ?? 0) + item.count);
    }
    const items = [...counts]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, input.data.maxItemTypes)
      .map(([itemName, count]) => ({ itemName, count }));
    const world = this.worldStateSnapshot();
    return inventorySnapshotCapabilityOutputSchema.parse({
      dimension: input.data.dimension,
      serverProfileId: input.data.serverProfileId,
      worldStateVersion: world.version,
      items,
    });
  }

  /**
   * Report, per armor slot, the currently-equipped piece and the wearable
   * candidates the bot already holds. Read-only primitive: it never equips
   * anything or invents items. Decisions are made by the skill, not here.
   */
  private async invokeArmorSnapshot(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = armorSnapshotCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);

    const inventoryItems = this.bot.inventory.items();
    const slots = ARMOR_SLOT_DESTINATIONS.map(({ slot, destination }) => {
      let equipped: string | null = null;
      try {
        const equipmentSlot = this.bot.getEquipmentDestSlot(destination);
        equipped = this.bot.inventory.slots[equipmentSlot]?.name ?? null;
      } catch {
        equipped = null;
      }
      const candidates = inventoryItems
        .map((item) => item.name)
        .filter(
          (name) =>
            typeof name === "string" &&
            ARMOR_ITEM_SLOT[name] === slot &&
            name !== equipped,
        );
      return { slot, equipped, candidates };
    });

    return armorSnapshotCapabilityOutputSchema.parse({
      serverProfileId: this.serverProfileId,
      slots,
    });
  }

  /**
   * Equip one named armor piece the bot already holds into one slot. Write
   * primitive with a hard guard: it refuses any item that is not a real armor
   * piece for the requested slot, and refuses one the bot does not actually own.
   */
  private async invokeArmorEquip(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = armorEquipCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);

    const { slot, itemName } = input.data;
    if (ARMOR_ITEM_SLOT[itemName] !== slot) {
      throw new SkillFault("ARMOR_ITEM_SLOT_MISMATCH");
    }
    const destination = ARMOR_SLOT_DESTINATIONS.find(
      (entry) => entry.slot === slot,
    )?.destination;
    if (!destination) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    const item = this.bot.inventory
      .items()
      .find((candidate) => candidate.name === itemName);
    if (!item) {
      throw new SkillFault("ARMOR_ITEM_NOT_IN_INVENTORY");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    try {
      await this.bot.equip(item, destination);
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
    } catch {
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      throw new SkillFault("ARMOR_EQUIP_FAILED");
    }

    let equipped = false;
    try {
      const equipmentSlot = this.bot.getEquipmentDestSlot(destination);
      equipped = this.bot.inventory.slots[equipmentSlot]?.name === itemName;
    } catch {
      equipped = false;
    }

    return armorEquipCapabilityOutputSchema.parse({
      equipped,
      slot,
      itemName,
    });
  }

  /** 背包内某物品的总数（读回用，遥测不允许估算）。 */
  private countInventoryItem(itemName: string): number {
    return this.bot.inventory
      .items()
      .filter((item) => item.name === itemName)
      .reduce((total, item) => total + item.count, 0);
  }

  /** 背包全部物品总数（采集遥测用总量增量，不假设方块→掉落物映射）。 */
  private countInventoryTotal(): number {
    return this.bot.inventory
      .items()
      .reduce((total, item) => total + item.count, 0);
  }

  private prepareCollectedInventorySync(
    inventoryBefore: number,
    signal: AbortSignal,
  ): InventorySyncWaiter {
    if (this.countInventoryTotal() > inventoryBefore || signal.aborted) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }

    const inventory = this.bot.inventory;
    if (
      typeof inventory.on !== "function" ||
      typeof inventory.off !== "function"
    ) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }

    let cancelWait: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        inventory.off("updateSlot", onUpdate);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      cancelWait = finish;
      const onUpdate = () => {
        if (this.countInventoryTotal() > inventoryBefore) finish();
      };

      inventory.on("updateSlot", onUpdate);
      signal.addEventListener("abort", finish, { once: true });
      timeout = setTimeout(finish, COLLECT_INVENTORY_SYNC_TIMEOUT_MS);
      // Close the listener-registration race if the slot packet arrived just
      // after the initial check but before updateSlot was bound.
      onUpdate();
    });
    return { promise, cancel: () => cancelWait() };
  }

  /**
   * Observe a real inventory increase without imposing a second travel timer.
   * This is raced with collectblock because its dropped-entity GoalFollow can
   * remain pending after the item has already entered the inventory.
   */
  private observeCollectedInventoryIncrease(
    inventoryBefore: number,
    signal: AbortSignal,
  ): InventorySyncWaiter {
    if (this.countInventoryTotal() > inventoryBefore) {
      return { promise: Promise.resolve(), cancel: () => {} };
    }
    const inventory = this.bot.inventory;
    if (
      typeof inventory.on !== "function" ||
      typeof inventory.off !== "function"
    ) {
      return { promise: new Promise<void>(() => {}), cancel: () => {} };
    }

    let cleanup = () => {};
    const promise = new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        inventory.off("updateSlot", onUpdate);
        signal.removeEventListener("abort", cleanup);
        resolve();
      };
      const onUpdate = () => {
        if (this.countInventoryTotal() > inventoryBefore) finish();
      };
      cleanup = () => {
        if (settled) return;
        settled = true;
        inventory.off("updateSlot", onUpdate);
        signal.removeEventListener("abort", cleanup);
      };
      inventory.on("updateSlot", onUpdate);
      signal.addEventListener("abort", cleanup, { once: true });
      onUpdate();
    });
    return { promise, cancel: cleanup };
  }

  /**
   * Releases mineflayer-collectblock without awaiting its cancellation promise.
   * The plugin can be stuck after pickup in GoalFollow(0), and cancelTask then
   * waits for collectBlock_finished forever. Clearing its target queue and
   * replaying the already-observed entity removal lets that loop unwind while
   * keeping cancellation bounded for the Runtime.
   */
  private releaseCollectBlockTask(): void {
    this.stopPathfinder();
    const collectBlock = this.bot.collectBlock;
    if (!collectBlock) return;
    const targets = (collectBlock as unknown as { targets?: CollectBlockTargets })
      .targets;
    try {
      const pending = targets?.getClosest?.();
      if (
        pending !== null &&
        pending !== undefined &&
        (pending as { constructor?: { name?: string } }).constructor?.name === "Entity"
      ) {
        this.bot.emit("entityGone", pending as never);
      }
    } catch {
      // Plugin internals are best-effort cleanup; the pathfinder is already stopped.
    }
    try {
      targets?.clear?.();
    } catch {
      // A plugin version without a mutable target queue still gets bounded cancellation.
    }
    try {
      void collectBlock.cancelTask().catch(() => undefined);
    } catch {
      // Cancellation cannot change the observed inventory result.
    }
  }

  /**
   * Mineflayer's dig promise resolves on a client-side prediction. Wrap it for
   * collectblock so the plugin only advances after a server block-change packet
   * confirms that the target became air. A bounded retry handles a finish packet
   * that arrived just after the server tick boundary; timeout remains fail-closed.
   */
  private installServerConfirmedDigging(signal: AbortSignal): () => void {
    const botWithWire = this.bot as Bot & {
      _client?: MineflayerWireClient;
    };
    const wire = botWithWire._client;
    if (
      !wire ||
      typeof wire.on !== "function" ||
      (typeof wire.off !== "function" && typeof wire.removeListener !== "function")
    ) {
      // Unit doubles and pre-login clients do not expose the wire. The real
      // Mineflayer client always does; preserving the original method here keeps
      // lifecycle tests focused on their own contract.
      return () => {};
    }

    const mutableBot = this.bot as Bot & { dig: Bot["dig"] };
    const originalDig = mutableBot.dig;
    const callOriginalDig = originalDig.bind(this.bot);
    const remove = (
      event: string,
      listener: (packet: unknown) => void,
    ): void => {
      if (typeof wire.off === "function") wire.off(event, listener);
      else wire.removeListener?.(event, listener);
    };

    const waitForServerConfirmation = (position: BlockPosition) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let grace: ReturnType<typeof setTimeout> | null = null;
      let resolvePromise: (confirmed: boolean) => void = () => {};
      const targetKey = blockPositionKey(position);
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        if (grace !== null) clearTimeout(grace);
        remove("block_change", onBlockChange);
        remove("multi_block_change", onMultiBlockChange);
        remove("acknowledge_player_digging", onDiggingAck);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(confirmed);
      };
      // An ack alone means the server processed the sequence. A refusal follows
      // as a correcting block update, so wait out the grace window before
      // treating the ack as proof — but let a real update settle it immediately.
      const acceptAfterGrace = () => {
        if (settled || grace !== null) return;
        grace = setTimeout(() => finish(true), COLLECT_SERVER_CORRECTION_GRACE_MS);
      };
      const applyBlockUpdate = (update: AuthoritativeBlockUpdate) => {
        if (blockPositionKey(update.position) !== targetKey) return;
        // Air is the break; any other authoritative state at the target is the
        // server putting the block back. Let the bounded retry resend the finish.
        finish(update.stateId === 0);
      };
      const onBlockChange = (packet: unknown) => {
        const update = parseBlockChangePacket(packet);
        if (update) applyBlockUpdate(update);
      };
      const onMultiBlockChange = (packet: unknown) => {
        for (const update of parseMultiBlockChangePackets(packet)) {
          applyBlockUpdate(update);
        }
      };
      const onDiggingAck = (packet: unknown) => {
        const ack = parseDiggingAckPacket(packet);
        if (!ack) return;
        if (ack.kind === "sequence") {
          acceptAfterGrace();
          return;
        }
        if (
          blockPositionKey(ack.position) !== targetKey ||
          ack.status !== BLOCK_DIG_STATUS_FINISH
        ) {
          return;
        }
        if (ack.successful) acceptAfterGrace();
        else finish(false);
      };
      const onAbort = () => finish(false);
      const promise = new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
        wire.on?.("block_change", onBlockChange);
        wire.on?.("multi_block_change", onMultiBlockChange);
        wire.on?.("acknowledge_player_digging", onDiggingAck);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return {
        promise,
        armTimeout: () => {
          if (!settled && timeout === null) {
            timeout = setTimeout(
              () => finish(false),
              COLLECT_SERVER_CONFIRM_TIMEOUT_MS,
            );
          }
        },
        cancel: () => finish(false),
      };
    };

    const wrappedDig = (async (...args: Parameters<Bot["dig"]>) => {
      const block = args[0];
      // Phase 3：bot.dig 边界 HarvestAuthorization——own/team/facility 方块
      // 无显式 salvage 授权时拒绝采集。无 provenance 记录=自然方块=放行。
      // pathfinder 的沿途挖掘同样走 bot.dig——这一层就是全部挖掘的边界。
      if (this.provenanceStore !== null) {
        const dimension = this.bot.game?.dimension ?? "minecraft:overworld";
        const record = this.provenanceStore.get(block.position, dimension);
        const grantKey = `${dimension}:${block.position.x},${block.position.y},${block.position.z}`;
        const grantDeadline = this.salvageGrants.get(grantKey) ?? 0;
        const explicitSalvageAuthorized = grantDeadline > Date.now();
        // 空间检查待接入 Base registry 后补（nearOwnBase fail-closed 分支
        // 已有单测覆盖，运行时接入点在此——registry 落地前恒 false）。
        const nearOwnBase = false;
        const decision = authorizeHarvest({
          record,
          explicitSalvageAuthorized,
          nearOwnBase,
        });
        if (!decision.allowed) {
          throw new SkillFault("HARVEST_PROTECTED_ASSET");
        }
        try {
          return await (async () => {
            for (let attempt = 0; attempt <= COLLECT_SERVER_DIG_RETRIES; attempt += 1) {
              if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
              const confirmation = waitForServerConfirmation(block.position);
              try {
                await callOriginalDig(...args);
                confirmation.armTimeout();
                if (await confirmation.promise) {
                  // 服务器确认破坏：清除 provenance（含过期的 salvage grant）。
                  this.salvageGrants.delete(grantKey);
                  this.provenanceStore?.remove(block.position, dimension);
                  return;
                }
              } finally {
                confirmation.cancel();
              }
            }
            throw new Error("Server did not confirm collected block break.");
          })();
        } finally {
          // 兜底清一次可能过期的 grant（决策时未过期但执行期跨过死线）
          if (this.salvageGrants.get(grantKey) !== undefined && this.salvageGrants.get(grantKey)! <= Date.now()) {
            this.salvageGrants.delete(grantKey);
          }
        }
      }
      for (let attempt = 0; attempt <= COLLECT_SERVER_DIG_RETRIES; attempt += 1) {
        if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const confirmation = waitForServerConfirmation(block.position);
        try {
          await originalDig(...args);
          confirmation.armTimeout();
          if (await confirmation.promise) return;
        } finally {
          confirmation.cancel();
        }
      }
      throw new Error("Server did not confirm collected block break.");
    }) as Bot["dig"];

    mutableBot.dig = wrappedDig;

    // Phase 3 补全：placeBlock 包装——服务器确认放置成功后写 provenance
    // （owner=own_bot），下次 dig 该位置会被 HarvestAuthorization 拦截。
    const originalPlaceBlock = mutableBot.placeBlock;
    if (this.provenanceStore !== null && typeof originalPlaceBlock === "function") {
      const callOriginalPlaceBlock = originalPlaceBlock.bind(this.bot);
      const wrappedPlaceBlock = (async (
        ...args: Parameters<Bot["placeBlock"]>
      ) => {
        const [reference, face] = args;
        const result = await callOriginalPlaceBlock(...args);
        const target = {
          x: reference.position.x + face.x,
          y: reference.position.y + face.y,
          z: reference.position.z + face.z,
        };
        const confirmed = this.bot.blockAt(new Vec3(target.x, target.y, target.z));
        if (confirmed && confirmed.boundingBox !== "empty") {
          this.provenanceStore!.record({
            serverProfileId: this.serverProfileId ?? "unknown-server",
            dimension: this.bot.game?.dimension ?? "minecraft:overworld",
            position: target,
            source: "bot_placed",
            owner: "own_bot",
            // 寻路租约期内的放置=垫脚/搭高（navigation，可自拆）；技能建造
            // （build/blueprint 等）在无租约时发生 → structural（受保护）。
            purpose: this.movementController.currentLease() !== null ? "navigation" : "structural",
            serverVerified: true,
          });
        }
        return result;
      }) as Bot["placeBlock"];
      mutableBot.placeBlock = wrappedPlaceBlock;
    }

    return () => {
      if (mutableBot.dig === wrappedDig) mutableBot.dig = originalDig;
    };
  }

  /**
   * 显式拆除/回收授权（salvage 通道）：授权一组位置在死线前可 dig。
   * 拆除/回收类技能（facility destroy 等）在调用 dig 前先 grant；
   * 死线自动过期，grant 不跨会话持久化。
   */
  grantSalvage(
    positions: ReadonlyArray<{
      position: { x: number; y: number; z: number };
      dimension?: string;
    }>,
    ttlMs = 120_000,
  ): void {
    const deadline = Date.now() + ttlMs;
    for (const { position, dimension } of positions) {
      const key = `${dimension ?? this.bot.game?.dimension ?? "minecraft:overworld"}:${position.x},${position.y},${position.z}`;
      this.salvageGrants.set(key, deadline);
    }
    // 有界：授权集合本身不能无限增长
    if (this.salvageGrants.size > 4096) {
      const now = Date.now();
      for (const [key, deadlineAt] of this.salvageGrants) {
        if (deadlineAt <= now) this.salvageGrants.delete(key);
      }
    }
  }

  private directCollectionAvailable(): boolean {
    return (
      typeof this.bot.pathfinder?.goto === "function" &&
      typeof this.bot.pathfinder?.setMovements === "function" &&
      this.directCollectionTool() !== null &&
      typeof this.bot.dig === "function"
    );
  }

  private directCollectionTool(): DirectCollectionTool | null {
    const tool = (this.bot as Bot & { tool?: DirectCollectionTool }).tool;
    return tool && typeof tool.equipForBlock === "function" ? tool : null;
  }

  private staircaseResourceDropNames(blockName: string): readonly string[] | null {
    return STAIRCASE_RESOURCE_DROPS[blockName] ?? null;
  }

  private countStaircaseCollectionItems(blockName: string): number {
    const itemNames = this.staircaseResourceDropNames(blockName);
    if (!itemNames) return 0;
    return itemNames.reduce(
      (total, itemName) => total + this.countInventoryItem(itemName),
      0,
    );
  }

  private stoneStaircaseCarvePositionIsSafe(position: Vec3): boolean {
    const block = this.bot.blockAt(position);
    if (
      !block ||
      CANDIDATE_FACE_LIQUIDS.has(block.name) ||
      STONE_STAIRCASE_FALLING_BLOCKS.has(block.name) ||
      (block.boundingBox !== "empty" &&
        !STONE_STAIRCASE_BREAKABLE.has(block.name))
    ) {
      return false;
    }

    return CANDIDATE_FACES.every(([dx, dy, dz]) => {
      const neighbor = this.bot.blockAt(position.offset(dx, dy, dz));
      return (
        neighbor !== null &&
        !CANDIDATE_FACE_LIQUIDS.has(neighbor.name) &&
        !STONE_STAIRCASE_FALLING_BLOCKS.has(neighbor.name)
      );
    });
  }

  private stoneStaircaseStepIsSafe(
    origin: Vec3,
    dx: number,
    dy: -1 | 1,
    dz: number,
    depth: number,
  ): boolean {
    const foot = origin.offset(dx * depth, dy * depth, dz * depth);
    const carvePositions = this.resourceStaircaseCarvePositions(
      origin,
      dx,
      dy,
      dz,
      depth,
    );
    const support = this.bot.blockAt(foot.offset(0, -1, 0));
    return (
      carvePositions.every((position) =>
        this.stoneStaircaseCarvePositionIsSafe(position)
      ) &&
      support !== null &&
      support.boundingBox !== "empty" &&
      STONE_STAIRCASE_BREAKABLE.has(support.name) &&
      !CANDIDATE_FACE_LIQUIDS.has(support.name) &&
      !STONE_STAIRCASE_FALLING_BLOCKS.has(support.name)
    );
  }

  private resourceStaircaseCarvePositions(
    origin: Vec3,
    dx: number,
    dy: -1 | 1,
    dz: number,
    depth: number,
  ): readonly Vec3[] {
    const foot = origin.offset(dx * depth, dy * depth, dz * depth);
    // A descending diagonal crosses the block two levels above the new foot
    // before the entity drops. Leaving that transition block intact makes the
    // pathfinder correctly report no path even when body and head are clear.
    if (dy < 0) {
      return [foot.offset(0, 2, 0), foot.offset(0, 1, 0), foot];
    }

    // Ascending requires jump clearance over the previous foothold as well as
    // body and head clearance at the destination. These are different columns.
    const previousFoot = origin.offset(
      dx * (depth - 1),
      dy * (depth - 1),
      dz * (depth - 1),
    );
    return [previousFoot.offset(0, 2, 0), foot.offset(0, 1, 0), foot];
  }

  private planResourceStaircase(
    blockName: string,
    maxDistance: number,
    wantedCount: number,
    targetPositions: readonly Vec3[],
  ): ResourceStaircasePlan | null {
    const current = this.bot.entity?.position;
    if (!current || (blockName !== "stone" && targetPositions.length === 0)) {
      return null;
    }
    const origin = new Vec3(
      Math.floor(current.x),
      Math.floor(current.y),
      Math.floor(current.z),
    );
    const maxDepth = Math.min(
      STONE_STAIRCASE_MAX_DEPTH,
      Math.floor(maxDistance / Math.SQRT2),
    );
    if (maxDepth < 1) return null;

    const plans: ResourceStaircasePlan[] = [];
    const verticalSteps: readonly (-1 | 1)[] =
      blockName === "stone" ? [-1] : RESOURCE_STAIRCASE_VERTICAL_STEPS;
    for (const dy of verticalSteps) {
      for (const { dx, dz } of STONE_STAIRCASE_DIRECTIONS) {
        let safeDepth = 0;
        let firstStoneDepth = Number.POSITIVE_INFINITY;
        let stoneBlocks = 0;
        let closestTargetDistance = Number.POSITIVE_INFINITY;
        let closestTargetDepth = 0;
        for (let depth = 1; depth <= maxDepth; depth += 1) {
          if (!this.stoneStaircaseStepIsSafe(origin, dx, dy, dz, depth)) break;
          safeDepth = depth;
          const foot = origin.offset(dx * depth, dy * depth, dz * depth);
          const carvePositions = this.resourceStaircaseCarvePositions(
            origin,
            dx,
            dy,
            dz,
            depth,
          );
          for (const position of carvePositions) {
            const block = this.bot.blockAt(position);
            if (block && this.matchesBlockName(block.name, "stone")) {
              stoneBlocks += 1;
              firstStoneDepth = Math.min(firstStoneDepth, depth);
            }
          }
          for (const target of targetPositions) {
            const distance = Math.min(
              ...carvePositions.map((position) => position.distanceTo(target)),
            );
            if (distance < closestTargetDistance) {
              closestTargetDistance = distance;
              closestTargetDepth = depth;
            }
          }
        }
        const usableForStone = blockName === "stone" && stoneBlocks > 0;
        const usableForTarget = blockName !== "stone" && closestTargetDepth > 0;
        if (usableForStone || usableForTarget) {
          plans.push({
            origin,
            dx,
            dy,
            dz,
            safeDepth: usableForStone ? safeDepth : closestTargetDepth,
            firstStoneDepth,
            stoneBlocks,
            closestTargetDistance,
          });
        }
      }
    }

    if (blockName === "stone") {
      plans.sort((left, right) => {
        const leftEnough = left.stoneBlocks >= wantedCount ? 1 : 0;
        const rightEnough = right.stoneBlocks >= wantedCount ? 1 : 0;
        return (
          rightEnough - leftEnough ||
          left.firstStoneDepth - right.firstStoneDepth ||
          right.safeDepth - left.safeDepth ||
          right.stoneBlocks - left.stoneBlocks
        );
      });
    } else {
      plans.sort((left, right) =>
        left.closestTargetDistance - right.closestTargetDistance ||
        right.safeDepth - left.safeDepth
      );
    }
    return plans[0] ?? null;
  }

  private async waitForStaircaseCollectionAtLeast(
    blockName: string,
    minimum: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.countStaircaseCollectionItems(blockName) >= minimum) return true;
    const inventory = this.bot.inventory;
    if (
      typeof inventory.on !== "function" ||
      typeof inventory.off !== "function"
    ) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        if (typeof timer.unref === "function") timer.unref();
      });
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      return this.countStaircaseCollectionItems(blockName) >= minimum;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        inventory.off("updateSlot", onUpdate);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const onUpdate = () => {
        if (this.countStaircaseCollectionItems(blockName) >= minimum) finish();
      };
      inventory.on("updateSlot", onUpdate);
      signal.addEventListener("abort", finish, { once: true });
      timer = setTimeout(finish, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      onUpdate();
    });
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    return this.countStaircaseCollectionItems(blockName) >= minimum;
  }

  private async digResourceStaircaseBlock(
    block: NonNullable<ReturnType<Bot["blockAt"]>>,
    signal: AbortSignal,
  ): Promise<void> {
    const tool = this.directCollectionTool();
    if (!tool) throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    const requiresHarvest =
      typeof block.canHarvest === "function" &&
      block.canHarvest(null) !== true;
    if (requiresHarvest && !canHarvestWithInventory(this.bot, block)) {
      throw new SkillRefusal(
        "COLLECT_TOOL_MISSING",
        `No inventory item can harvest ${block.name}.`,
      );
    }
    try {
      await tool.equipForBlock(block, {
        requireHarvest: requiresHarvest,
        getFromChest: false,
        maxTools: 2,
      });
      await this.bot.dig(block);
    } catch (error) {
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      if (error instanceof SkillFault) throw error;
      if (error instanceof Error && error.name === "NoItem") {
        throw new SkillRefusal("COLLECT_TOOL_MISSING", error.message);
      }
      throw new SkillFault(
        "COLLECT_BLOCKS_FAILED",
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : undefined,
      );
    }
    const liveBlock = this.bot.blockAt(block.position);
    if (!liveBlock || liveBlock.boundingBox !== "empty") {
      throw new SkillFault(
        "COLLECT_BLOCKS_FAILED",
        `The server did not expose the staircase block at ${blockPositionKey(block.position)}.`,
      );
    }
  }

  private async collectResourceByStaircase(
    request: SkillCapabilityRequest,
    blockName: string,
    targets: readonly NonNullable<ReturnType<Bot["blockAt"]>>[],
    maxCount: number,
    maxDistance: number,
  ): Promise<unknown | null> {
    if (!this.staircaseResourceDropNames(blockName)) return null;
    const plan = this.planResourceStaircase(
      blockName,
      maxDistance,
      maxCount,
      targets.map(({ position }) => position),
    );
    if (!plan) return null;

    const inventoryBefore = this.countStaircaseCollectionItems(blockName);
    let targetBlocksDug = 0;
    const movements = configureNavigationMovements(new Movements(this.bot), this.bot, this.anarchyNavigation);
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.thinkTimeout = COLLECT_PATH_THINK_TIMEOUT_MS;
    this.bot.pathfinder.tickTimeout = COLLECT_PATH_TICK_TIMEOUT_MS;
    this.activePathInvocationId = request.invocationId;
    const restoreServerConfirmedDigging =
      this.installServerConfirmedDigging(request.signal);
    const stopOnAbort = () => this.stopPathfinder();
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      for (let depth = 1; depth <= plan.safeDepth; depth += 1) {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        if (!this.stoneStaircaseStepIsSafe(
          plan.origin,
          plan.dx,
          plan.dy,
          plan.dz,
          depth,
        )) {
          throw new SkillFault(
            "COLLECT_TARGET_UNREACHABLE",
            "The selected staircase became unsafe before the next step.",
          );
        }

        const foot = plan.origin.offset(
          plan.dx * depth,
          plan.dy * depth,
          plan.dz * depth,
        );
        for (const position of this.resourceStaircaseCarvePositions(
          plan.origin,
          plan.dx,
          plan.dy,
          plan.dz,
          depth,
        )) {
          const block = this.bot.blockAt(position);
          if (!block || block.boundingBox === "empty") continue;
          const collectsTarget = this.matchesBlockName(block.name, blockName);
          await this.digResourceStaircaseBlock(block, request.signal);
          if (!collectsTarget) continue;
          targetBlocksDug += 1;
          await this.waitForStaircaseCollectionAtLeast(
            blockName,
            inventoryBefore + Math.min(targetBlocksDug, maxCount),
            request.signal,
            750,
          );
          const itemsCollected = Math.max(
            0,
            this.countStaircaseCollectionItems(blockName) - inventoryBefore,
          );
          if (itemsCollected >= maxCount) {
            return collectBlockCapabilityOutputSchema.parse({
              blockName,
              targetsFound: Math.min(targetBlocksDug, maxCount),
              itemsCollected,
            });
          }
        }

        this.bot.pathfinder.setMovements(movements);
        await this.boundedCollectGoto(
          new goals.GoalNear(foot.x, foot.y, foot.z, 0),
          request.signal,
          STONE_STAIRCASE_STEP_PATH_BUDGET_MS,
        );
        const reached = this.bot.entity.position;
        if (
          !Number.isFinite(reached.x) ||
          !Number.isFinite(reached.y) ||
          !Number.isFinite(reached.z) ||
          Math.floor(reached.x) !== foot.x ||
          Math.floor(reached.y) !== foot.y ||
          Math.floor(reached.z) !== foot.z
        ) {
          throw new SkillFault("COLLECT_TARGET_UNREACHABLE");
        }
        await this.waitForStaircaseCollectionAtLeast(
          blockName,
          inventoryBefore + Math.min(targetBlocksDug, maxCount),
          request.signal,
          COLLECT_DIRECT_PICKUP_WAIT_MS,
        );
        const itemsCollected = Math.max(
          0,
          this.countStaircaseCollectionItems(blockName) - inventoryBefore,
        );
        if (itemsCollected >= maxCount) {
          return collectBlockCapabilityOutputSchema.parse({
            blockName,
            targetsFound: Math.min(targetBlocksDug, maxCount),
            itemsCollected,
          });
        }

        const nearbyTargets = targets
          .map(({ position }) => this.bot.blockAt(position))
          .filter((target): target is NonNullable<typeof target> =>
            target !== null &&
            target.boundingBox !== "empty" &&
            this.matchesBlockName(target.name, blockName) &&
            this.bot.entity.position.distanceTo(target.position) <=
              MINE_TARGET_REACH_DISTANCE + 2
          );
        if (
          nearbyTargets.length > 0 &&
          collectReachableTargets(
            this.bot,
            movements,
            nearbyTargets,
            maxCount,
          ).reachable.length > 0
        ) {
          break;
        }
      }

      const liveTargets = targets
        .map(({ position }) => this.bot.blockAt(position))
        .filter((target): target is NonNullable<typeof target> =>
          target !== null &&
          target.boundingBox !== "empty" &&
          this.matchesBlockName(target.name, blockName)
        );
      const reachableAfterExcavation = collectReachableTargets(
        this.bot,
        movements,
        liveTargets,
        maxCount,
      );
      for (const target of reachableAfterExcavation.reachable) {
        if (targetBlocksDug >= maxCount) break;
        const totalBefore = this.countInventoryTotal();
        const inventoryIncrease = this.observeCollectedInventoryIncrease(
          totalBefore,
          request.signal,
        );
        try {
          await this.collectTargetDirectly(
            target,
            movements,
            totalBefore,
            inventoryIncrease,
            request.signal,
          );
          targetBlocksDug += 1;
        } finally {
          inventoryIncrease.cancel();
        }
      }

      await this.waitForStaircaseCollectionAtLeast(
        blockName,
        inventoryBefore + 1,
        request.signal,
        COLLECT_DIRECT_PICKUP_WAIT_MS,
      );
      const itemsCollected = Math.max(0,
        this.countStaircaseCollectionItems(blockName) - inventoryBefore,
      );
      if (itemsCollected === 0) {
        throw new SkillFault(
          targetBlocksDug > 0
            ? "COLLECT_PICKUP_NOT_SETTLED"
            : "COLLECT_TARGET_UNREACHABLE",
          `The bounded access staircase did not produce a collected ${blockName} item.`,
        );
      }
      return collectBlockCapabilityOutputSchema.parse({
        blockName,
        targetsFound: Math.min(targetBlocksDug, maxCount),
        itemsCollected,
      });
    } finally {
      request.signal.removeEventListener("abort", stopOnAbort);
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
      restoreServerConfirmedDigging();
      this.bot.clearControlStates();
      this.stopPathfinder();
    }
  }

  private async boundedCollectGoto(
    goal: Parameters<Bot["pathfinder"]["goto"]>[0],
    signal: AbortSignal,
    budgetMs: number,
  ): Promise<void> {
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rejectAbort: (error: Error) => void = () => {};
    const abortError = new Error("Collection path was cancelled.");
    abortError.name = "AbortError";
    const timeoutError = new Error(
      `Collection path did not settle within ${budgetMs}ms.`,
    );
    timeoutError.name = "Timeout";
    const onAbort = () => {
      this.stopPathfinder();
      rejectAbort(abortError);
    };
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
      signal.addEventListener("abort", onAbort, { once: true });
    });
    const timedOut = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.stopPathfinder();
        reject(timeoutError);
      }, budgetMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      await Promise.race([
        this.bot.pathfinder.goto(goal),
        aborted,
        timedOut,
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async waitForCollectedInventoryIncrease(
    waiter: InventorySyncWaiter,
    inventoryBefore: number,
    signal: AbortSignal,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.countInventoryTotal() > inventoryBefore) return true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let finishAbort: () => void = () => {};
    const aborted = new Promise<"aborted">((resolve) => {
      finishAbort = () => resolve("aborted");
      signal.addEventListener("abort", finishAbort, { once: true });
    });
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
    });
    try {
      const outcome = await Promise.race([
        waiter.promise.then(() => "inventory" as const),
        aborted,
        timedOut,
      ]);
      if (outcome === "aborted" || signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      return this.countInventoryTotal() > inventoryBefore;
    } finally {
      if (timer !== null) clearTimeout(timer);
      signal.removeEventListener("abort", finishAbort);
    }
  }

  private nearestDroppedItemPosition(target: Vec3): Vec3 | null {
    const drops = Object.values(this.bot.entities ?? {})
      .map((entity) => entity as unknown as {
        name?: unknown;
        displayName?: unknown;
        isValid?: unknown;
        position?: Vec3;
      })
      .filter((entity) => {
        const name = String(entity.name ?? entity.displayName ?? "").toLowerCase();
        return (
          name === "item" &&
          entity.isValid !== false &&
          entity.position !== undefined &&
          typeof entity.position.distanceTo === "function" &&
          entity.position.distanceTo(target) <= 6
        );
      })
      .sort((left, right) =>
        this.bot.entity.position.distanceTo(left.position!) -
        this.bot.entity.position.distanceTo(right.position!),
      );
    return drops[0]?.position ?? null;
  }

  /**
   * Production collection path. The upstream plugin can wait forever after a
   * pickup and can also spend the whole skill budget in a second path search.
   * Keep its target filtering and safety movements, but own the live path,
   * tool selection, server-confirmed dig, and bounded pickup here.
   */
  private async collectTargetDirectly(
    target: NonNullable<ReturnType<Bot["blockAt"]>>,
    movements: Movements,
    inventoryBefore: number,
    inventoryIncrease: InventorySyncWaiter,
    signal: AbortSignal,
  ): Promise<void> {
    this.bot.pathfinder.setMovements(movements);
    await this.boundedCollectGoto(
      new goals.GoalLookAtBlock(target.position, this.bot.world),
      signal,
      COLLECT_DIRECT_PATH_BUDGET_MS,
    );
    const distance = this.bot.entity.position.distanceTo(target.position);
    if (!Number.isFinite(distance) || distance > MINE_TARGET_REACH_DISTANCE) {
      const error = new Error("Pathfinder stopped outside block reach.");
      error.name = "NoPath";
      throw error;
    }

    const liveTarget = this.bot.blockAt(target.position);
    if (
      !liveTarget ||
      liveTarget.type !== target.type ||
      liveTarget.boundingBox === "empty"
    ) {
      throw new SkillFault("COLLECT_TARGET_UNREACHABLE");
    }
    try {
      const tool = this.directCollectionTool();
      if (!tool) throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
      await tool.equipForBlock(liveTarget, {
        requireHarvest: true,
        getFromChest: false,
        maxTools: 2,
      });
      await this.bot.dig(liveTarget);
    } catch (error) {
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      if (error instanceof SkillFault) throw error;
      if (error instanceof Error && error.name === "NoItem") {
        throw new SkillFault("COLLECT_TOOL_MISSING", error.message);
      }
      throw new SkillFault(
        "COLLECT_BLOCKS_FAILED",
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : undefined,
      );
    }

    await this.pickupDugItem(target, inventoryBefore, inventoryIncrease, signal);
  }

  /**
   * 挖后方掉落物拾取（Round 6.2 修复）：
   * - 第 1 拍 750ms 事件驱动等待（近距离挖掘时物品直接入包，多数情况到此为止）
   * - 未入包 → 每轮：短探测等待（掉落实体继续下落/落定）→ **重读当前**掉落物
   *   位置 → GoalNear(0) 走过去 → 再等事件入包
   * - 行走失败不立即判死：下一轮实体位置更准（物品已落定）
   * - 全部轮次耗尽仍无入包证据 → COLLECT_PICKUP_NOT_SETTLED（真实码保留，
   *   上层 supervision 按其"有副作用"语义正确处理）
   */
  private async pickupDugItem(
    target: NonNullable<ReturnType<Bot["blockAt"]>>,
    inventoryBefore: number,
    inventoryIncrease: InventorySyncWaiter,
    signal: AbortSignal,
  ): Promise<void> {
    if (
      await this.waitForCollectedInventoryIncrease(
        inventoryIncrease,
        inventoryBefore,
        signal,
        750,
      )
    ) {
      return;
    }
    let lastWalkError: unknown = null;
    for (let attempt = 0; attempt < COLLECT_PICKUP_ATTEMPTS; attempt += 1) {
      if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      // 掉落实体可能仍在下落：先给一小拍让它落定，再读**当前位置**
      await this.settleProbeDelay(signal);
      const dropPosition = this.nearestDroppedItemPosition(target.position);
      if (dropPosition === null) {
        // 实体消失：可能恰好被吸收（最后一拍确认）或已 despawn
        if (
          await this.waitForCollectedInventoryIncrease(
            inventoryIncrease,
            inventoryBefore,
            signal,
            500,
          )
        ) {
          return;
        }
        continue;
      }
      const pickupBlock = dropPosition.floored();
      const pickupMovements = configureSafePathfinderMovements(
        new Movements(this.bot),
      );
      this.bot.pathfinder.setMovements(pickupMovements);
      try {
        await this.boundedCollectGoto(
          new goals.GoalNear(
            pickupBlock.x,
            pickupBlock.y,
            pickupBlock.z,
            0,
          ),
          signal,
          COLLECT_DIRECT_PICKUP_PATH_BUDGET_MS,
        );
        lastWalkError = null;
      } catch (error) {
        if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        // 走不到不判死：物品可能在行走途中入包，或下一轮位置（落定后）更好
        lastWalkError = error;
      }
      if (
        await this.waitForCollectedInventoryIncrease(
          inventoryIncrease,
          inventoryBefore,
          signal,
          COLLECT_DIRECT_PICKUP_WAIT_MS,
        )
      ) {
        return;
      }
    }
    throw new SkillFault(
      "COLLECT_PICKUP_NOT_SETTLED",
      `No inventory increase after ${COLLECT_PICKUP_ATTEMPTS} pickup attempts at ${target.position.x},${target.position.y},${target.position.z}${lastWalkError instanceof Error ? `; last walk: ${lastWalkError.message}` : ""}.`,
    );
  }

  private async settleProbeDelay(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, COLLECT_PICKUP_SETTLE_PROBE_MS);
      if (typeof timer.unref === "function") timer.unref();
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  private assertDimensionMatch(requestedDimension: string): void {
    const current = normalizeDimension(String(this.bot.game.dimension));
    if (requestedDimension !== current) {
      throw new SkillFault("TARGET_DIMENSION_MISMATCH");
    }
  }

  /**
   * 采集方块：包装 MIT 的 mineflayer-collectblock。查找由本层做（名称→
   * 方块 id 强校验），采集循环交给插件，L0/取消随时可停。
   */
  private async invokeCollectBlocks(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = collectBlockCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    if (!this.bot.collectBlock) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }

    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id: number } | undefined>;
    };
    const blockType = registry.blocksByName?.[input.data.blockName];
    if (!blockType) {
      throw new SkillFault("BLOCK_NAME_UNKNOWN");
    }

    // useExtraInfo 而不是事后 filter：过滤发生在距离排序和 count 截断之前，
    // 所以拿到的是最近的**可达**候选。若改成先取 maxCount 个再筛，全埋区域
    // 里筛完就是空数组，等于把"附近有矿但都埋着"报成"附近没有矿"。
    //
    // count 要的是需求量 + 余量，不是需求量本身：截断在过滤之后发生，所以
    // count == maxCount 时"最近的 maxCount 个暴露候选"就是全部候选，任何一个
    // 通不过可达性检查都没有替补。实测的死法就是这个——只找到 1 个暴露的
    // oak_log，它不可达，整个目标在 step 1 结束。
    const targetPositions = this.bot.findBlocks({
      matching: blockType.id,
      maxDistance: input.data.maxDistance,
      count: input.data.maxCount + COLLECT_CANDIDATE_POOL_SLACK,
      useExtraInfo: reachableCandidateFilter(this.bot),
    });
    const targets = targetPositions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is NonNullable<typeof block> => block !== null);
    if (targets.length === 0) {
      if (
        this.staircaseResourceDropNames(input.data.blockName) !== null &&
        this.directCollectionAvailable()
      ) {
        // The first search deliberately admits only blocks with an exposed
        // face. Ores are commonly fully enclosed, so locate buried candidates
        // separately and let the bounded staircase prove a safe route to one.
        // Stone remains targetless because its staircase is itself the source.
        const buriedTargets = input.data.blockName === "stone"
          ? targets
          : this.bot.findBlocks({
              matching: blockType.id,
              maxDistance: input.data.maxDistance,
              count: input.data.maxCount + COLLECT_CANDIDATE_POOL_SLACK,
            })
              .map((position) => this.bot.blockAt(position))
              .filter((block): block is NonNullable<typeof block> =>
                block !== null &&
                block.boundingBox !== "empty" &&
                this.matchesBlockName(block.name, input.data.blockName)
              );
        const staircaseResult = await this.collectResourceByStaircase(
          request,
          input.data.blockName,
          buriedTargets,
          input.data.maxCount,
          input.data.maxDistance,
        );
        if (staircaseResult !== null) return staircaseResult;
      }
      // No target is a proved no-op: findBlocks/blockAt only read the loaded
      // world, and collectBlock has not started. Report it as a refusal so a
      // multi-step planner can reobserve or explore instead of treating a
      // zero-count `completed` result as an uncertain non-idempotent action.
      throw new SkillRefusal(
        "COLLECT_TARGET_UNREACHABLE",
        `No exposed ${input.data.blockName} target was found within ${input.data.maxDistance} blocks.`,
      );
    }

    const lease = this.movementController.acquire({
      owner: `skill:${request.skillId}:${request.invocationId}`,
      priority: MOVEMENT_PRIORITIES.TASK_NAVIGATION,
      taskId: request.taskId,
      goal: {
        x: targets[0]!.position.x,
        y: targets[0]!.position.y,
        z: targets[0]!.position.z,
        dimension: input.data.dimension,
        serverProfileId: input.data.serverProfileId,
      },
      signal: request.signal,
    });
    if (lease === null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
    }

    // 采集途中不允许插件把物品倒进任何箱子——入库是 container.transfer
    // 的职责，且必须显式授权。
    this.bot.collectBlock.chestLocations = [];
    const movements = configureNavigationMovements(new Movements(this.bot), this.bot, this.anarchyNavigation);
    const targetBlockKeys = new Set(
      targets.map(
        ({ position, type }) =>
          `${type}:${position.x},${position.y},${position.z}`,
      ),
    );
    // 只放行本次已选定的目标坐标。不能直接清空排除区，否则
    // collectblock 使用 Pathfinder 接近目标时也可以随意挖路。
    movements.canDig = true;
    movements.exclusionAreasBreak = [({ position, type }) =>
      targetBlockKeys.has(`${type}:${position.x},${position.y},${position.z}`)
        ? 0
        : 100
    ];
    // collectblock 的 collect() 在开跑前会把这两个标志按回 false 并调
    // setMovements（CollectBlock.js:192-196），也就是插件会替我们关掉"不在下落方块
    // 底下挖"和"不制造液体流动"。这两条是安全配置里唯一被外部改写的项，所以钉住
    // 它们：写入变成静默 no-op，读出恒为 true。用 no-op setter 而不是只读属性，
    // 是因为只读属性在严格模式下会让插件的赋值直接抛错，那等于把安全配置换成崩溃。
    for (const flag of ["dontMineUnderFallingBlock", "dontCreateFlow"] as const) {
      Object.defineProperty(movements, flag, {
        get: () => true,
        set: () => {},
        configurable: true,
        enumerable: true,
      });
    }
    this.bot.collectBlock.movements = movements;

    // 工具闸门必须在交给 collectblock 之前。不是礼貌，是防 OOM：详见
    // canHarvestWithInventory 的注释（equipForBlock 无界递归，实测 15ms 递归
    // 2001 层，堆在几十秒内冲到 6GB 并崩溃）。
    if (!canHarvestWithInventory(this.bot, targets[0]!)) {
      // 同样是"证明什么都没动"的拒绝：闸门就在交给 collectblock 之前，
      // 背包只被读过。缺工具要走 MISSING_RESOURCE 的补齐阶梯，被屏蔽成
      // 结果不确定就等于放弃一个本来能自己补齐的计划。
      throw new SkillRefusal(
        "COLLECT_TOOL_MISSING",
        `No inventory item can harvest ${input.data.blockName}.`,
      );
    }

    // 预算显式写死，不再继承 invokeMovementGoto 最后一次写进去的全局值
    // （thinkTimeout=5000 / tickTimeout=20）。继承意味着 collect 的行为取决于
    // 调用顺序——同一个目标先走过 travel.route 就能成，反之被饿死。
    this.bot.pathfinder.thinkTimeout = COLLECT_PATH_THINK_TIMEOUT_MS;
    this.bot.pathfinder.tickTimeout = COLLECT_PATH_TICK_TIMEOUT_MS;

    // 只把证明得出路径的目标交下去：collectAll 让 goto 的拒绝上抛，一个到不了的
    // 目标会中止整批（实测 40 个暴露候选里 7 个 noPath）。
    // wanted 用请求量而不是池子大小：池子是替补席，攒够请求量就停手，
    // 免得为了一个只要 1 块的步骤把 9 个候选全排一遍。
    // 多证明一个候选留作替补：前置检查的可达是证据不是保证，实测证明可达的目标
    // 仍会在 collect() 自己的 goto 上以 Timeout 被拒（见
    // COLLECT_LIVE_PATH_SUBSTITUTES）。多出来的候选不交给这一轮 collect()，
    // 只在实跑被拒后才用。
    const reachability = collectReachableTargets(
      this.bot,
      movements,
      targets,
      input.data.maxCount + COLLECT_LIVE_PATH_SUBSTITUTES,
    );
    if (
      this.staircaseResourceDropNames(input.data.blockName) !== null &&
      reachability.reachable.length === 0 &&
      this.directCollectionAvailable()
    ) {
      const staircaseResult = await this.collectResourceByStaircase(
        request,
        input.data.blockName,
        targets,
        input.data.maxCount,
        input.data.maxDistance,
      );
      if (staircaseResult !== null) return staircaseResult;
    }
    // A timeout in the read-only precheck is uncertainty, not a reason to keep
    // the bot stationary forever. Prefer proven paths, then spend the bounded
    // live budget on candidates the precheck could not decide. Only a fully
    // exhausted A* open set removes a candidate.
    const liveTargets = [
      ...reachability.reachable,
      ...reachability.unproven,
    ].slice(0, input.data.maxCount + COLLECT_LIVE_PATH_SUBSTITUTES);
    if (liveTargets.length === 0) {
      // 扫描说"有暴露面"，寻路把每一个都排空了开集——这是世界状态，不是缺陷，
      // 所以带着候选数报出去，让上层重新观察而不是原样重试。
      throw new SkillRefusal(
        "COLLECT_TARGET_UNREACHABLE",
        `All ${targets.length} exposed ${input.data.blockName} candidates were proven unreachable by the pre-check.`,
      );
    }

    const inventoryBefore = this.countInventoryTotal();
    // Register before collectBlock starts. The dropped-entity event can arrive
    // before Mineflayer applies the corresponding inventory slot update.
    const inventorySync = this.prepareCollectedInventorySync(
      inventoryBefore,
      request.signal,
    );
    let collectedTargets = 0;
    let collectionSucceeded = false;
    // 实跑失败的 reason 此前只有插件转抛的那一句，读不出替补到底有没有登场。
    // 实测只能靠 durationMs 反推(12588 → 15754ms)，那是推断不是观测。
    let attemptsMade = 0;
    this.activePathInvocationId = request.invocationId;
    const restoreServerConfirmedDigging =
      this.installServerConfirmedDigging(request.signal);
    const stopOnAbort = () => {
      this.releaseCollectBlockTask();
    };
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal.aborted || lease.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // 给 collect() 套一个静默挂死的界。见 COLLECT_SETTLE_BUDGET_MS：
      // collectAll 的 Entity 分支有两条永不落定且永不抛错的 await，命中时
      // collect() 会一直吊着，把整个技能合约烧光，最后报成没有 onFault 行的
      // SKILL_TIMEOUT——上层看到的是 CONTRACT_BUG，而真实情况是掉落物捡拾
      // 没有收尾。超时后必须 cancelTask + 停寻路，否则插件的循环会带着
      // 这次的目标继续跑，污染下一次调用。
      // 超时之后 cancelTask 会让 collect() 那条 Promise 迟到地抛，但不需要额外
      // 接一层：Promise.race 一进来就给每个入参都挂了反应，那次拒绝算已被处理，
      // 不会变成 unhandledRejection。
      // Run one proven target at a time. collectblock can finish the block break
      // and inventory pickup but remain stuck in its entity-follow branch. A
      // per-target boundary lets an observed pickup close that one target and
      // continue with the rest of the requested batch.
      let lastPathFailure: unknown = null;
      for (const target of liveTargets) {
        if (collectedTargets >= input.data.maxCount) break;
        attemptsMade += 1;
        const attemptInventoryBefore = this.countInventoryTotal();
        const inventoryIncrease = this.observeCollectedInventoryIncrease(
          attemptInventoryBefore,
          request.signal,
        );
        let settleTimer: ReturnType<typeof setTimeout> | null = null;
        try {
          if (this.directCollectionAvailable()) {
            await this.collectTargetDirectly(
              target,
              movements,
              attemptInventoryBefore,
              inventoryIncrease,
              request.signal,
            );
            collectedTargets += 1;
            lastPathFailure = null;
            continue;
          }
          const settled = await Promise.race([
            this.bot.collectBlock
              .collect([target], { ignoreNoPath: false })
              .then(() => "resolved" as const),
            inventoryIncrease.promise.then(() => "inventory-increased" as const),
            new Promise<"stalled">((resolve) => {
              settleTimer = setTimeout(
                () => resolve("stalled"),
                COLLECT_SETTLE_BUDGET_MS,
              );
              if (typeof settleTimer.unref === "function") settleTimer.unref();
            }),
          ]);
          if (settled === "inventory-increased") {
            // The inventory packet is stronger completion evidence than the
            // plugin's still-pending GoalFollow. Stop that stale movement before
            // starting the next target.
            this.releaseCollectBlockTask();
          }
          if (settled === "stalled") {
            this.releaseCollectBlockTask();
            if (this.countInventoryTotal() > attemptInventoryBefore) {
              collectedTargets += 1;
              lastPathFailure = null;
              continue;
            }
            throw new SkillFault(
              "COLLECT_PICKUP_NOT_SETTLED",
              `collectBlock neither resolved nor rejected within ${COLLECT_SETTLE_BUDGET_MS}ms for ${input.data.blockName}.`,
            );
          }
          collectedTargets += 1;
          lastPathFailure = null;
        } catch (error) {
          if (error instanceof SkillFault) throw error;
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          const failure = error instanceof Error ? error.name : "";
          if (failure !== "NoPath" && failure !== "Timeout") throw error;
          // 已经挖到东西就不换候选：请求量是上限，换一轮会挖过量。挖到多少用
          // 背包读回判断，不靠插件的返回值猜。
          if (this.countInventoryTotal() > attemptInventoryBefore) throw error;
          lastPathFailure = error;
          // 插件的循环还带着这一批目标，不取消就会污染下一批。
          this.releaseCollectBlockTask();
        } finally {
          if (settleTimer !== null) clearTimeout(settleTimer);
          inventoryIncrease.cancel();
        }
      }
      if (
        lastPathFailure !== null &&
        collectedTargets < input.data.maxCount
      ) {
        throw lastPathFailure;
      }
      collectionSucceeded = true;
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted || lease.signal.aborted || !lease.isCurrent()) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // 扫描已经证明目标在射程内，走到这里说明是"够不到/挖不动"，而不是"没有树"。
      // 两者的处置完全不同，所以底层原因必须带走：屏蔽码留给协议，原因留给日志。
      //
      // 三个码而不是一个：collectblock 直接转抛 pathfinder 的 goto 错误
      // （lib/CollectBlock.js:31 → pathfinder lib/goto.js:26-28），error.name
      // 就是判据。码写成字面量而不是从 helper 返回，是因为分类器测试靠正则扫
      // `new SkillFault("...")` 来发现新码（failure-classifier.test.ts:467）；
      // 藏在 helper 里的码扫不到，就会静默漏收分类。
      const pluginReason =
        error instanceof Error && error.message.trim().length > 0
          ? error.message.trim()
          : "collectBlock rejected without a message.";
      // 带上批次账目。没有它就分不清"替补上过场也照样超时"和"预检查只证明了
      // 一个候选，替补席根本是空的"——两者的下一步完全相反：前者说明这一带
      // 确实走不通，后者说明预检查的总预算没给够替补。实测 15754ms 那次属于
      // 后者，但当时只能靠时长反推。
      const reason = `${pluginReason} (attempted ${attemptsMade} of ${liveTargets.length} live candidate(s))`;
      const failure = error instanceof Error ? error.name : "";
      // A* 搜完了，确实没有路：重新观察，别原样重试。
      if (failure === "NoPath") {
        throw new SkillFault("COLLECT_TARGET_UNREACHABLE", reason);
      }
      // 思考预算用尽，**没有**证明不可达。实测 tickTimeout 切片会把一个 700ms
      // 就判得出 noPath 的搜索拖到 5010ms 报 Timeout，两者绝不能合并。
      if (failure === "Timeout") {
        throw new SkillFault("COLLECT_PATH_SEARCH_EXHAUSTED", reason);
      }
      throw new SkillFault("COLLECT_BLOCKS_FAILED", reason);
    } finally {
      if (!collectionSucceeded) inventorySync.cancel();
      request.signal.removeEventListener("abort", stopOnAbort);
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
      restoreServerConfirmedDigging();
      // 移动租约必须在这里归还：anarchy 实测抓到的泄漏——采集成功或失败
      // 后租约被无限期持有，后续一切移动类技能永远 BOT_MOVEMENT_BUSY。
      // （safe 模式几乎总在"找不到暴露目标"处提前拒绝，没走到拿租约这步，
      // 所以这个洞一直没暴露。）release 的 onRelease 回调会停掉移动原语。
      lease.release(lease.signal.aborted ? "cancelled" : "completed");
    }

    // collectblock resolves when the dropped entity disappears. The waiter was
    // armed before collection so a fast slot packet cannot be missed.
    await inventorySync.promise;

    const itemsCollected = Math.max(
      0,
      this.countInventoryTotal() - inventoryBefore,
    );
    return collectBlockCapabilityOutputSchema.parse({
      blockName: input.data.blockName,
      // 报真正被采集的那一批的数量，而不是扫描命中数，也不是证明可达的总数：
      // 扫到 8 个而只有 1 个走得到时，报 8 会让上层的验收谓词
      // （targetsFound >= runs）过得比世界实际情况宽松。多证明出来的替补同理——
      // 它没被交给成功的那一轮，报它就是虚高。
      targetsFound: collectedTargets,
      itemsCollected,
    });
  }

  /**
   * 合成：mineflayer 原生 recipesFor + craft。craftedCount 是合成后背包
   * 读回的实际增量，不是配方理论产量。
   */
  private async invokeCraftItem(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = craftItemCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id: number } | undefined>;
    };
    const itemType = registry.itemsByName?.[input.data.itemName];
    if (!itemType) {
      throw new SkillFault("ITEM_NAME_UNKNOWN");
    }

    const inventoryBefore = this.countInventoryItem(input.data.itemName);
    if (inventoryBefore >= input.data.count) {
      return craftItemCapabilityOutputSchema.parse({
        itemName: input.data.itemName,
        requestedCount: input.data.count,
        craftedCount: 0,
        usedCraftingTable: false,
      });
    }
    const shortfall = input.data.count - inventoryBefore;

    let craftingTable = null;
    if (input.data.craftingTable) {
      const { x, y, z } = input.data.craftingTable;
      craftingTable = this.bot.blockAt(new Vec3(x, y, z));
      if (!craftingTable || craftingTable.name !== "crafting_table") {
        throw new SkillFault("CRAFTING_TABLE_NOT_FOUND");
      }
      this.lastCraftingTablePosition = new Vec3(input.data.craftingTable.x, input.data.craftingTable.y, input.data.craftingTable.z);
    }

    // recipesFor also returns [] when materials are missing. recipesAll is the
    // inventory-independent check that tells us whether the recipe itself
    // requires a 3x3 station. Confusing those cases was the main source of
    // workbench creation while a task was merely short on ingredients.
    const portableRecipes = this.bot.recipesAll(itemType.id, null, false);
    const stationRecipes = this.bot.recipesAll(itemType.id, null, true);
    if (portableRecipes.length === 0 && stationRecipes.length === 0) {
      throw new SkillFault("RECIPE_UNAVAILABLE");
    }
    const requiresCraftingTable =
      portableRecipes.length === 0 &&
      stationRecipes.some((candidate) => candidate.requiresTable);
    if (!craftingTable && requiresCraftingTable) {
      craftingTable = await this.ensureCraftingTableAccess(request);
    }
    const recipes = this.bot.recipesFor(
      itemType.id,
      null,
      shortfall,
      craftingTable ?? false,
    );
    const recipe = recipes[0];
    if (!recipe) {
      // 区分"没配方"与"材料不够"由上层结合库存判断；这里如实报不可合成。
      throw new SkillFault("RECIPE_UNAVAILABLE");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    const resultPerCraft = Math.max(1, recipe.result.count);
    const craftRuns = Math.ceil(shortfall / resultPerCraft);
    try {
      await this.bot.craft(
        recipe,
        craftRuns,
        craftingTable ?? undefined,
      );
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // craft 抛错时也读回增量——部分成功要如实上报而不是丢弃。
      const partial = Math.max(
        0,
        this.countInventoryItem(input.data.itemName) - inventoryBefore,
      );
      if (partial > 0) {
        return craftItemCapabilityOutputSchema.parse({
          itemName: input.data.itemName,
          requestedCount: input.data.count,
          craftedCount: partial,
          usedCraftingTable: craftingTable !== null,
        });
      }
      throw new SkillFault("CRAFT_FAILED");
    }

    const craftedCount = Math.max(
      0,
      this.countInventoryItem(input.data.itemName) - inventoryBefore,
    );
    return craftItemCapabilityOutputSchema.parse({
      itemName: input.data.itemName,
      requestedCount: input.data.count,
      craftedCount,
      usedCraftingTable: craftingTable !== null,
    });
  }

  /**
   * Single workstation access path used by all table-dependent crafting.
   * The final scan happens immediately before placement/creation, closing the
   * race where another task placed a table after the initial observation.
   */
  private async ensureCraftingTableAccess(
    request: SkillCapabilityRequest,
  ): Promise<MineflayerBlock> {
    return this.withActionLocks(
      request,
      ["crafting"],
      async () => {
        const now = Date.now();
        const table = this.findReusableUtilityStation(CRAFTING_TABLE_POLICY);
        if (table) {
          this.lastCraftingTablePosition = table.position.clone();
          return table;
        }

        const observedTables = this.findUtilityStations(
          CRAFTING_TABLE_POLICY,
        );
        if (observedTables.length > 0) {
          for (const observedTable of observedTables.slice(
            0,
            MAX_UTILITY_STATION_PATH_ATTEMPTS,
          )) {
            const reached = await this.moveToUtilityStation(
              request,
              CRAFTING_TABLE_POLICY,
              observedTable,
            );
            if (reached) {
              this.lastCraftingTablePosition = reached.position.clone();
              return reached;
            }
          }
          throw new SkillFault("CRAFTING_TABLE_UNAVAILABLE");
        }

        // Re-scan after deciding to create/place. A different skill may have
        // changed the world while this invocation was queued for the lock.
        const rescanned = this.findReusableUtilityStation(
          CRAFTING_TABLE_POLICY,
        );
        if (rescanned) {
          this.lastCraftingTablePosition = rescanned.position.clone();
          return rescanned;
        }

        const ownedNearby = this.countUtilityStations(CRAFTING_TABLE_POLICY);
        if (ownedNearby >= this.maxOwnedCraftingTablesPerArea) {
          throw new SkillFault("CRAFTING_TABLE_UNAVAILABLE");
        }

        const tableItem = this.bot.inventory
          .items()
          .find((item) => item.name === "crafting_table");
        if (tableItem) {
          if (
            now - this.lastCraftingTablePlacedAt <
            this.craftingTablePlacementCooldownMs
          ) {
            throw new SkillFault("CRAFTING_TABLE_PLACEMENT_COOLDOWN");
          }
          const placed = await this.placeInventoryUtilityStation({
            request,
            policy: CRAFTING_TABLE_POLICY,
            item: tableItem,
            faults: {
              unavailable: "CRAFTING_TABLE_UNAVAILABLE",
              placementUnavailable: "CRAFTING_TABLE_PLACEMENT_UNAVAILABLE",
              placementFailed: "CRAFTING_TABLE_PLACEMENT_FAILED",
              placementUnconfirmed: "CRAFTING_TABLE_PLACEMENT_UNCONFIRMED",
            },
            onPlacementAttempt: () => {
              this.lastCraftingTablePlacedAt = now;
            },
          });
          this.lastCraftingTablePosition = placed.position.clone();
          return placed;
        }

        if (
          now - this.lastCraftingTableCreatedAt <
          this.craftingTableCreationCooldownMs
        ) {
          throw new SkillFault("CRAFTING_TABLE_CREATION_COOLDOWN");
        }
        // Crafting a table is the only allowed creation path, and uses the
        // portable 2x2 recipe. The caller's original recipe is not retried.
        const registry = this.bot.registry as unknown as {
          itemsByName?: Record<string, { id: number } | undefined>;
        };
        const tableType = registry.itemsByName?.crafting_table;
        if (!tableType) throw new SkillFault("ITEM_NAME_UNKNOWN");
        const tableRecipes = this.bot.recipesFor(tableType.id, null, 1, false);
        const tableRecipe = tableRecipes[0];
        if (!tableRecipe) throw new SkillFault("RECIPE_UNAVAILABLE");
        const before = this.countInventoryItem("crafting_table");
        await this.bot.craft(tableRecipe, 1);
        if (request.signal.aborted) {
          throw new SkillFault("SKILL_CANCELLED");
        }
        if (this.countInventoryItem("crafting_table") <= before) {
          throw new SkillFault("CRAFTING_TABLE_CREATION_UNCONFIRMED");
        }
        this.lastCraftingTableCreatedAt = now;
        const craftedTableItem = this.bot.inventory
          .items()
          .find((item) => item.name === "crafting_table");
        if (!craftedTableItem) {
          throw new SkillFault("CRAFTING_TABLE_NOT_IN_INVENTORY");
        }
        // Placement uses the same final scan as an inventory-resident table.
        // The normal placement cooldown is deliberately bypassed immediately
        // after a newly confirmed local craft.
        const placed = await this.placeInventoryUtilityStation({
          request,
          policy: CRAFTING_TABLE_POLICY,
          item: craftedTableItem,
          faults: {
            unavailable: "CRAFTING_TABLE_UNAVAILABLE",
            placementUnavailable: "CRAFTING_TABLE_PLACEMENT_UNAVAILABLE",
            placementFailed: "CRAFTING_TABLE_PLACEMENT_FAILED",
            placementUnconfirmed: "CRAFTING_TABLE_PLACEMENT_UNCONFIRMED",
          },
          onPlacementAttempt: () => {
            this.lastCraftingTablePlacedAt = now;
          },
        });
        this.lastCraftingTablePosition = placed.position.clone();
        return placed;
      },
    );
  }

  /** Resolve all observed instances of one bounded utility-station policy. */
  private findUtilityStations(
    policy: UtilityStationPolicy,
  ): readonly MineflayerBlock[] {
    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id: number } | undefined>;
    };
    const ids = policy.blockNames
      .map((name) => registry.blocksByName?.[name]?.id)
      .filter((id): id is number => Number.isSafeInteger(id));
    if (ids.length === 0) return [];
    let positions: Vec3[] = [];
    try {
      positions = this.bot.findBlocks({
        matching: ids.length === 1 ? ids[0]! : ids,
        maxDistance: policy.scanRadius,
        count: policy.scanCount,
      });
    } catch {
      return [];
    }
    const names = new Set(policy.blockNames);
    const origin = this.bot.entity.position;
    return positions
      .map((position) => this.bot.blockAt(position))
      .filter(
        (block): block is MineflayerBlock =>
          block !== null && names.has(block.name),
      )
      .sort(
        (left, right) =>
          Math.hypot(
            left.position.x - origin.x,
            left.position.y - origin.y,
            left.position.z - origin.z,
          ) -
          Math.hypot(
            right.position.x - origin.x,
            right.position.y - origin.y,
            right.position.z - origin.z,
          ),
      );
  }

  private findReusableUtilityStation(
    policy: UtilityStationPolicy,
  ): MineflayerBlock | null {
    // A farther station may still be the only one inside interaction reach;
    // filter after sorting rather than rejecting the nearest out-of-reach
    // candidate outright.
    return (
      this.findUtilityStations(policy).find((station) =>
        this.withinInteractionReach(station.position),
      ) ?? null
    );
  }

  private countUtilityStations(policy: UtilityStationPolicy): number {
    return this.findUtilityStations(policy).length;
  }

  private withinInteractionReach(position: Vec3): boolean {
    const origin = this.bot.entity.position;
    return Math.hypot(position.x + 0.5 - origin.x, position.y + 0.5 - origin.y, position.z + 0.5 - origin.z) <= 4.5;
  }

  private async moveToUtilityStation(
    request: SkillCapabilityRequest,
    policy: UtilityStationPolicy,
    station: MineflayerBlock,
  ): Promise<MineflayerBlock | null> {
    if (!this.bot.pathfinder) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    const lease = this.movementController.acquire({
      owner: `skill:${request.skillId}:${request.invocationId}:station`,
      priority: MOVEMENT_PRIORITIES.TASK_NAVIGATION,
      taskId: request.taskId,
      goal: {
        x: station.position.x,
        y: station.position.y,
        z: station.position.z,
        dimension: normalizeDimension(String(this.bot.game.dimension)),
        serverProfileId: this.serverProfileId!,
      },
      signal: request.signal,
    });
    if (lease === null) throw new SkillFault("BOT_MOVEMENT_BUSY");

    const movements = configureNavigationMovements(new Movements(this.bot), this.bot, this.anarchyNavigation);
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.thinkTimeout = 5_000;
    this.bot.pathfinder.tickTimeout = 20;
    try {
      lease.assertCurrent();
      await this.bot.pathfinder.goto(
        new goals.GoalNear(
          station.position.x,
          station.position.y,
          station.position.z,
          3,
        ),
      );
      lease.assertCurrent();
    } catch (error) {
      if (request.signal.aborted || lease.signal.aborted || !lease.isCurrent()) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      return null;
    } finally {
      lease.release(lease.signal.aborted ? "cancelled" : "completed");
    }

    const observed = this.bot.blockAt(station.position);
    return observed !== null &&
      policy.blockNames.includes(observed.name) &&
      this.withinInteractionReach(observed.position)
      ? observed
      : null;
  }

  private findUtilityStationPlacementReference(): {
    reference: MineflayerBlock;
    target: Vec3;
    face: Vec3;
  } | null {
    const origin = this.bot.entity.position.floored();
    const candidates = [
      new Vec3(1, 0, 0),
      new Vec3(-1, 0, 0),
      new Vec3(0, 0, 1),
      new Vec3(0, 0, -1),
    ];
    for (const offset of candidates) {
      // Place on the top face of a floor block beside the bot. Targeting the
      // bot's own occupied cell is rejected by vanilla servers and previously
      // made the table guard appear to work only in permissive test doubles.
      const target = origin.offset(offset.x, offset.y, offset.z);
      const reference = this.bot.blockAt(target.offset(0, -1, 0));
      if (!reference || reference.boundingBox === "empty") continue;
      const face = new Vec3(0, 1, 0);
      const occupant = this.bot.blockAt(target);
      if (occupant && occupant.boundingBox !== "empty") continue;
      if (!this.withinInteractionReach(reference.position)) continue;
      return { reference, target, face };
    }
    return null;
  }

  /**
   * Shared last-mile placement guard for crafting tables and furnaces. It
   * re-scans after equip and marks an attempt before the non-idempotent write,
   * so a failed confirmation cannot immediately produce a duplicate block.
   */
  private async placeInventoryUtilityStation(options: Readonly<{
    request: SkillCapabilityRequest;
    policy: UtilityStationPolicy;
    item: Parameters<Bot["equip"]>[0];
    faults: Readonly<{
      unavailable: string;
      placementUnavailable: string;
      placementFailed: string;
      placementUnconfirmed: string;
    }>;
    onPlacementAttempt: () => void;
  }>): Promise<MineflayerBlock> {
    const placement = this.findUtilityStationPlacementReference();
    if (!placement) {
      throw new SkillFault(options.faults.placementUnavailable);
    }
    try {
      await this.bot.equip(options.item, "hand");
      if (options.request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }

      const reusable = this.findReusableUtilityStation(options.policy);
      if (reusable) return reusable;
      if (
        this.countUtilityStations(options.policy) >=
        options.policy.maxOwnedPerArea
      ) {
        throw new SkillFault(options.faults.unavailable);
      }

      options.onPlacementAttempt();
      await this.bot.placeBlock(placement.reference, placement.face);
      if (options.request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (options.request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      throw new SkillFault(options.faults.placementFailed);
    }
    const placed = this.bot.blockAt(placement.target);
    if (!placed || placed.name !== options.policy.itemName) {
      throw new SkillFault(options.faults.placementUnconfirmed);
    }
    return placed;
  }

  /** Deterministic furnace access for nullable smelt.item station inputs. */
  private async ensureFurnaceAccess(
    request: SkillCapabilityRequest,
  ): Promise<MineflayerBlock> {
    return this.withActionLocks(
      request,
      ["crafting"],
      async () => {
        const furnace = this.findReusableUtilityStation(FURNACE_POLICY);
        if (furnace) {
          this.lastFurnacePosition = furnace.position.clone();
          return furnace;
        }

        const observedFurnaces = this.findUtilityStations(FURNACE_POLICY);
        if (observedFurnaces.length > 0) {
          for (const observedFurnace of observedFurnaces.slice(
            0,
            MAX_UTILITY_STATION_PATH_ATTEMPTS,
          )) {
            const reached = await this.moveToUtilityStation(
              request,
              FURNACE_POLICY,
              observedFurnace,
            );
            if (reached) {
              this.lastFurnacePosition = reached.position.clone();
              return reached;
            }
          }
          throw new SkillFault("FURNACE_UNAVAILABLE");
        }

        const rescanned = this.findReusableUtilityStation(FURNACE_POLICY);
        if (rescanned) {
          this.lastFurnacePosition = rescanned.position.clone();
          return rescanned;
        }
        if (
          this.countUtilityStations(FURNACE_POLICY) >=
          this.maxOwnedFurnacesPerArea
        ) {
          throw new SkillFault("FURNACE_UNAVAILABLE");
        }

        const furnaceItem = this.bot.inventory
          .items()
          .find((item) => item.name === "furnace");
        if (!furnaceItem) {
          // Furnace crafting needs a 3x3 station and a larger dependency loop.
          // Until that loop is supervised here, fail closed instead of
          // fabricating a craft result or attempting repeated placement.
          throw new SkillFault("FURNACE_NOT_IN_INVENTORY");
        }
        const now = Date.now();
        if (
          now - this.lastFurnacePlacedAt <
          this.furnacePlacementCooldownMs
        ) {
          throw new SkillFault("FURNACE_PLACEMENT_COOLDOWN");
        }

        const placed = await this.placeInventoryUtilityStation({
          request,
          policy: FURNACE_POLICY,
          item: furnaceItem,
          faults: {
            unavailable: "FURNACE_UNAVAILABLE",
            placementUnavailable: "FURNACE_PLACEMENT_UNAVAILABLE",
            placementFailed: "FURNACE_PLACEMENT_FAILED",
            placementUnconfirmed: "FURNACE_PLACEMENT_UNCONFIRMED",
          },
          onPlacementAttempt: () => {
            this.lastFurnacePlacedAt = now;
          },
        });
        this.lastFurnacePosition = placed.position.clone();
        return placed;
      },
    );
  }

  /** 熔炼：只使用空熔炉，显式装入原料和燃料，逐次取出并读回真实产物。 */
  private async invokeSmeltItem(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = smeltItemCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id: number } | undefined>;
    };
    const inputType = registry.itemsByName?.[input.data.inputItemName];
    const fuelType = registry.itemsByName?.[input.data.fuelItemName];
    if (!inputType || !fuelType) throw new SkillFault("ITEM_NAME_UNKNOWN");
    if (this.countInventoryItem(input.data.inputItemName) < input.data.count) {
      throw new SkillFault("SMELT_INPUT_INSUFFICIENT");
    }
    if (this.countInventoryItem(input.data.fuelItemName) < input.data.fuelCount) {
      throw new SkillFault("SMELT_FUEL_INSUFFICIENT");
    }

    let block: MineflayerBlock;
    if (input.data.furnace === null) {
      block = await this.ensureFurnaceAccess(request);
    } else {
      const { x, y, z } = input.data.furnace;
      const requestedBlock = this.bot.blockAt(new Vec3(x, y, z));
      if (
        !requestedBlock ||
        !["furnace", "blast_furnace", "smoker"].includes(
          requestedBlock.name,
        )
      ) {
        throw new SkillFault("FURNACE_NOT_FOUND");
      }
      block = requestedBlock;
    }

    let furnace: Awaited<ReturnType<Bot["openFurnace"]>> | null = null;
    let outputItemName: string | null = null;
    let smeltedCount = 0;
    try {
      furnace = await this.bot.openFurnace(block);
      // 无规则立场：别人的炉子先**掠夺**再使用（拿走产物/在烧物/燃料），
      // 而不是拒绝使用。空出来的炉子就是我们的炉子。读回计数只认自己
      // 投入后取出的部分，炉内旧物在 loot 日志里单独留痕。
      const openFurnace = furnace;
      if (openFurnace.outputItem() || openFurnace.inputItem() || openFurnace.fuelItem()) {
        const takeOrder: Array<() => Promise<unknown>> = [
          () => openFurnace.takeOutput(),
          () => openFurnace.takeInput(),
          () => openFurnace.takeFuel(),
        ];
        const lootedNames: string[] = [];
        for (const take of takeOrder) {
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          const taken = await take().catch(() => null);
          if (taken && typeof (taken as { name?: string }).name === "string") {
            lootedNames.push((taken as { name: string }).name);
          }
        }
        this.lastFurnaceLoot = lootedNames;
      }
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await furnace.putInput(inputType.id, null, input.data.count);
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await furnace.putFuel(fuelType.id, null, input.data.fuelCount);
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");

      while (smeltedCount < input.data.count) {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const output = furnace.outputItem();
        if (output) {
          outputItemName ??= output.name;
          if (output.name !== outputItemName) throw new SkillFault("FURNACE_OUTPUT_MISMATCH");
          const taken = await furnace.takeOutput();
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          smeltedCount += taken.count;
          continue;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(finish, 250);
          const onAbort = () => finish(new SkillFault("SKILL_CANCELLED"));
          const onUpdate = () => finish();
          function finish(error?: Error) {
            clearTimeout(timer);
            furnace?.removeListener("update", onUpdate);
            request.signal.removeEventListener("abort", onAbort);
            error ? reject(error) : resolve();
          }
          furnace?.once("update", onUpdate);
          request.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("SMELT_FAILED");
    } finally {
      try { furnace?.close(); } catch { /* closing never fabricates success */ }
    }
    if (!outputItemName || smeltedCount < 1) throw new SkillFault("SMELT_OUTPUT_NOT_CONFIRMED");
    return smeltItemCapabilityOutputSchema.parse({
      inputItemName: input.data.inputItemName,
      fuelItemName: input.data.fuelItemName,
      outputItemName,
      requestedCount: input.data.count,
      insertedFuelCount: input.data.fuelCount,
      smeltedCount,
    });
  }

  /** 放置方块：原生 placeBlock，放置后读回目标位校验，不伪造成功。 */
  private async invokePlaceBlock(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = placeBlockCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const { referenceBlock, face } = input.data;
    const reference = this.bot.blockAt(
      new Vec3(referenceBlock.x, referenceBlock.y, referenceBlock.z),
    );
    if (!reference || reference.name === "air") {
      throw new SkillFault("REFERENCE_BLOCK_NOT_FOUND");
    }
    const targetPosition = new Vec3(
      referenceBlock.x + face.x,
      referenceBlock.y + face.y,
      referenceBlock.z + face.z,
    );
    const occupant = this.bot.blockAt(targetPosition);
    if (occupant && occupant.boundingBox !== "empty") {
      if (occupant.name === input.data.itemName) {
        return placeBlockCapabilityOutputSchema.parse({
          placed: true,
          placedBlockName: occupant.name,
          position: {
            x: targetPosition.x,
            y: targetPosition.y,
            z: targetPosition.z,
          },
        });
      }
      throw new SkillFault("PLACE_TARGET_OCCUPIED");
    }

    const item = this.bot.inventory
      .items()
      .find((candidate) => candidate.name === input.data.itemName);
    if (!item) {
      throw new SkillFault("ITEM_NOT_IN_INVENTORY");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    try {
      await this.bot.equip(item, "hand");
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      await this.bot.placeBlock(reference, new Vec3(face.x, face.y, face.z));
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      throw new SkillFault("PLACE_BLOCK_FAILED");
    }

    const placedBlock = this.bot.blockAt(targetPosition);
    if (!placedBlock || placedBlock.boundingBox === "empty") {
      throw new SkillFault("PLACE_NOT_CONFIRMED");
    }
    return placeBlockCapabilityOutputSchema.parse({
      placed: true,
      placedBlockName: placedBlock.name,
      position: {
        x: targetPosition.x,
        y: targetPosition.y,
        z: targetPosition.z,
      },
    });
  }

  /**
   * 箱子存取：openContainer + deposit/withdraw。movedCount 是操作前后背包
   * 该物品数量差（读回），少于请求量如实上报。
   */
  private async invokeContainerTransfer(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = containerTransferCapabilityInputSchema.safeParse(
      request.input,
    );
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id: number } | undefined>;
    };
    const itemType = registry.itemsByName?.[input.data.itemName];
    if (!itemType) {
      throw new SkillFault("ITEM_NAME_UNKNOWN");
    }

    const { container } = input.data;
    const containerBlock = this.bot.blockAt(
      new Vec3(container.x, container.y, container.z),
    );
    if (!containerBlock || !CONTAINER_BLOCK_NAMES.has(containerBlock.name)) {
      throw new SkillFault("CONTAINER_NOT_FOUND");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    let before: number | null = null;
    let window: Awaited<ReturnType<Bot["openContainer"]>> | null = null;
    try {
      window = await this.bot.openContainer(containerBlock);
      // Opening the window synchronizes pending inventory slot updates from
      // earlier actions. Use that acknowledged state as the transfer baseline.
      before = this.countInventoryItem(input.data.itemName);
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      if (input.data.direction === "deposit") {
        await window.deposit(itemType.id, null, input.data.count);
      } else {
        await window.withdraw(itemType.id, null, input.data.count);
      }
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // deposit/withdraw 在数量不足时抛错——读回增量如实上报部分成功。
      const partial = before === null
        ? 0
        : this.transferredItemCount(
            input.data.direction,
            before,
            this.countInventoryItem(input.data.itemName),
          );
      if (partial > 0) {
        return containerTransferCapabilityOutputSchema.parse({
          direction: input.data.direction,
          itemName: input.data.itemName,
          requestedCount: input.data.count,
          movedCount: partial,
        });
      }
      throw new SkillFault("CONTAINER_TRANSFER_FAILED");
    } finally {
      try {
        window?.close();
      } catch {
        // 关窗失败不掩盖真实结果。
      }
    }

    const movedCount = this.transferredItemCount(
      input.data.direction,
      before ?? this.countInventoryItem(input.data.itemName),
      this.countInventoryItem(input.data.itemName),
    );
    return containerTransferCapabilityOutputSchema.parse({
      direction: input.data.direction,
      itemName: input.data.itemName,
      requestedCount: input.data.count,
      movedCount,
    });
  }

  private transferredItemCount(
    direction: "deposit" | "withdraw",
    before: number,
    after: number,
  ): number {
    return direction === "deposit"
      ? Math.max(0, before - after)
      : Math.max(0, after - before);
  }

  versionCompatibility() {
    // Auto-version sessions only know the concrete protocol after negotiation.
    // Validate the combat explosion schema in the same startup compatibility
    // phase so an unknown shape closes the session before Runtime goes online.
    this.combatAdapter.initializeExplosionProtocol();
    const protocolVersion = Number(this.bot.protocolVersion);
    return resolvedVersionCompatibility(
      this.configuredVersion,
      this.bot.version,
      protocolVersion,
      this.bot.majorVersion,
    );
  }

  skillCompatibilityEnvironment(): SkillCompatibilityEnvironment {
    const registry = this.bot.registry as unknown as {
      supportFeature?: (name: string) => boolean;
      itemsByName?: Record<string, unknown>;
      blocksByName?: Record<string, unknown>;
      entitiesByName?: Record<string, unknown>;
    };
    const resources: Readonly<
      Record<SkillResourceKind, Record<string, unknown> | undefined>
    > = {
      item: registry.itemsByName,
      block: registry.blocksByName,
      entity: registry.entitiesByName,
    };
    const protocolVersion = Number(this.bot.protocolVersion);
    if (
      typeof this.bot.version !== "string" ||
      !Number.isSafeInteger(protocolVersion)
    ) {
      throw new Error("Mineflayer compatibility facts are unavailable.");
    }
    return Object.freeze({
      minecraftVersion: this.bot.version,
      protocolVersion,
      supportsFeature: (name: string): boolean | undefined => {
        if (typeof registry.supportFeature !== "function") return undefined;
        try {
          const supported = registry.supportFeature(name);
          return typeof supported === "boolean" ? supported : undefined;
        } catch {
          return undefined;
        }
      },
      hasResource: (
        kind: SkillResourceKind,
        name: string,
      ): boolean | undefined => {
        const index = resources[kind];
        return index ? index[name] !== undefined : undefined;
      },
      // Server-side plugins and rules can disable mechanics that exist in the
      // negotiated protocol. Those facts stay unknown until an explicit,
      // approved probe records them; version alone must not fabricate support.
      serverCapability: (): undefined => undefined,
    });
  }

  async close(gracePeriodMs: number): Promise<void> {
    if (this.requestedStop) return;
    this.requestedStop = true;
    this.interruptNormalActions();

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.bot.end("studio_safe_stop_timeout");
        finish();
      }, gracePeriodMs);

      this.bot.once("end", finish);
      this.bot.quit("studio_safe_stop");
      if (gracePeriodMs === 0) {
        this.bot.end("studio_safe_stop");
      }
    });
  }

  private safeFoodItems() {
    const registry = this.bot.registry as unknown as FoodRegistry;
    return this.bot.inventory
      .items()
      .filter((item) => SAFE_FOOD_NAMES.has(item.name))
      .map((item) => ({ item, metadata: registry.foodsByName?.[item.name] }))
      .filter(
        (entry): entry is typeof entry & { metadata: FoodMetadata } =>
          entry.metadata !== undefined &&
          Number.isFinite(entry.metadata.foodPoints) &&
          entry.metadata.foodPoints > 0,
      )
      .sort(
        (left, right) =>
          (right.metadata.effectiveQuality ?? right.metadata.foodPoints) -
            (left.metadata.effectiveQuality ?? left.metadata.foodPoints) ||
          left.item.name.localeCompare(right.item.name),
      );
  }

  private async forageSafeFood(): Promise<L0SafetyActionResult> {
    if (this.safeFoodItems().length > 0) {
      return { outcome: "skipped", errorCode: "SAFE_FOOD_ALREADY_AVAILABLE" };
    }
    return this.forageRound();
  }

  private safeFoodCount(): number {
    return this.safeFoodItems().reduce((total, entry) => total + entry.item.count, 0);
  }

  /** food.secure 的能力入口：校验输入 → 复用觅食轮次 → 按输出 schema 读回。 */
  private async invokeSecureFood(request: SkillCapabilityRequest): Promise<unknown> {
    const input = secureFoodCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    const output = await this.secureSafeFood(
      { targetCount: input.data.targetCount },
      request.signal,
    );
    return secureFoodCapabilityOutputSchema.parse(output);
  }

  /**
   * L0 INVENTORY_FULL 的自愈动作：按白名单阈值丢弃多余的低价值物品。
   * 丢成功（背包有新空位）→ executed，下一轮 L0 评估解除风险；无任何
   * 可丢项 → skipped（如实报告"全是必需品"，暂停保持——这是上层该建
   * 箱子存东西的信号，不是这里该硬丢装备的理由）。
   */
  private async tidyDropJunk(): Promise<L0SafetyActionResult> {
    const droppable = this.bot.inventory
      .items()
      .map((item) => ({
        item,
        keep: INVENTORY_TIDY_KEEP_THRESHOLDS[item.name],
      }))
      .filter(
        (entry): entry is typeof entry & { keep: number } =>
          entry.keep !== undefined && entry.item.count > entry.keep,
      )
      .sort((left, right) => right.item.count - left.item.count);
    if (droppable.length === 0) {
      return { outcome: "skipped", errorCode: "INVENTORY_TIDY_NOTHING_DROPPABLE" };
    }
    const deadline = Date.now() + INVENTORY_TIDY_TIMEOUT_MS;
    try {
      await this.actionLocks.withLock(
        "inventory",
        { owner: "safety:TIDY_DROP_JUNK", ttlMs: ACTION_LOCK_TTL_MS },
        async () => {
          for (const { item, keep } of droppable) {
            if (Date.now() >= deadline) break;
            await this.bot.toss(item.type, null, item.count - keep);
          }
        },
      );
    } catch {
      return { outcome: "failed", errorCode: "INVENTORY_TIDY_FAILED" };
    }
    return { outcome: "executed", errorCode: null };
  }

  /**
   * 主动食物储备（food.secure 技能的能力实现）：重复有界觅食轮次直到安全
   * 食物达到 targetCount 或预算耗尽。每轮复用 L0 的同一套确定性机器
   * （掉落物 → 成熟作物 → 被动生物 → 短探索），L0 只要求"任意 1 份"，
   * 这里把水位抬高到储备目标。结果如实读回：未达标不是失败。
   */
  async secureSafeFood(
    input: Readonly<{ targetCount: number }>,
    signal?: AbortSignal,
  ): Promise<{
    safeFoodCount: number;
    targetCount: number;
    targetReached: boolean;
    secured: number;
    reasonCode: "TARGET_REACHED" | "NO_SAFE_FOOD_SOURCE" | "BUDGET_EXHAUSTED";
  }> {
    const target = Math.max(1, Math.min(32, Math.floor(input.targetCount)));
    const before = this.safeFoodCount();
    if (before >= target) {
      return { safeFoodCount: before, targetCount: target, targetReached: true, secured: 0, reasonCode: "TARGET_REACHED" };
    }
    const deadline = Date.now() + SECURE_FOOD_TOTAL_BUDGET_MS;
    let sawSource = false;
    while (this.safeFoodCount() < target && !signal?.aborted && Date.now() < deadline) {
      const result = await this.forageRound();
      if (result.outcome === "executed") {
        sawSource = true;
        continue;
      }
      // skipped：这一轮在掉落物/作物/生物/短探索后仍无进账。NO_SAFE_FOOD_SOURCE
      // 说明附近确实没有食物来源；其余 skipped 码（如受伤中止）同样不再硬转。
      break;
    }
    const after = this.safeFoodCount();
    const targetReached = after >= target;
    return {
      safeFoodCount: after,
      targetCount: target,
      targetReached,
      secured: Math.max(0, after - before),
      reasonCode: targetReached
        ? "TARGET_REACHED"
        : sawSource || after > before
          ? "BUDGET_EXHAUSTED"
          : "NO_SAFE_FOOD_SOURCE",
    };
  }

  /**
   * One bounded forage round: dropped food → mature crops → passive entities →
   * a short exploration hop, all inside the round budget. Shared by the L0
   * reaction (any single food item counts) and the proactive food.secure skill.
   */
  private async forageRound(budgetMs: number = SAFE_FORAGE_TOTAL_BUDGET_MS): Promise<L0SafetyActionResult> {
    if (
      !this.bot.pathfinder ||
      typeof this.bot.pathfinder.goto !== "function" ||
      typeof this.bot.pathfinder.setMovements !== "function"
    ) {
      return { outcome: "skipped", errorCode: "FORAGE_RUNTIME_UNAVAILABLE" };
    }
    const startedHealth = finiteNumber(this.bot.health)
      ? Number(this.bot.health)
      : null;
    const deadline = Date.now() + budgetMs;
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      SAFE_FORAGE_TOTAL_BUDGET_MS,
    );
    timeout.unref?.();
    try {
      const movements = configureSafePathfinderMovements(
        new Movements(this.bot),
      );
      this.bot.pathfinder.setMovements(movements);
      this.bot.pathfinder.thinkTimeout = SAFE_FORAGE_PATH_BUDGET_MS;
      this.bot.pathfinder.tickTimeout = 20;

      let lastSkipped: L0SafetyActionResult = {
        outcome: "skipped",
        errorCode: "NO_SAFE_FOOD_SOURCE",
      };
      for (let pass = 0; pass < 2; pass += 1) {
        const droppedFood = this.nearestSafeFoodDropPosition();
        if (
          droppedFood &&
          await this.pickUpForagedFood(
            droppedFood,
            startedHealth,
            controller.signal,
            deadline,
          )
        ) {
          return { outcome: "executed", errorCode: null };
        }

        for (const blockTarget of this.safeForageBlocks()) {
          const result = await this.harvestSafeForageBlock(
            blockTarget,
            startedHealth,
            controller.signal,
            deadline,
          );
          if (result.outcome !== "skipped") return result;
          lastSkipped = result;
        }

        for (const entityTarget of this.safeForageEntities()) {
          const result = await this.foragePassiveEntity(
            entityTarget,
            startedHealth,
            controller.signal,
            deadline,
          );
          if (result.outcome !== "skipped") return result;
          lastSkipped = result;
        }

        if (pass === 0 && Date.now() < deadline) {
          await this.exploreForSafeFood(controller.signal, deadline);
          if (this.safeFoodItems().length > 0) {
            return { outcome: "executed", errorCode: null };
          }
          continue;
        }
        return lastSkipped;
      }
      return lastSkipped;
    } finally {
      clearTimeout(timeout);
      controller.abort();
      this.stopPathfinder();
      this.bot.clearControlStates();
    }
  }

  private safeForageEntities(): Array<
    NonNullable<ReturnType<Bot["nearestEntity"]>>
  > {
    return Object.values(this.bot.entities ?? {}).filter((entity) => {
      const name = typeof entity.name === "string"
        ? entity.name.toLowerCase().replace(/^minecraft:/u, "")
        : "";
      const distance = this.bot.entity.position.distanceTo(entity.position);
      return (
        entity !== this.bot.entity &&
        entity.isValid !== false &&
        SAFE_FORAGE_ENTITY_NAMES.has(name) &&
        Number.isFinite(distance) &&
        distance <= SAFE_FORAGE_MAX_DISTANCE
      );
    }).sort(
      (left, right) =>
        this.bot.entity.position.distanceTo(left.position) -
        this.bot.entity.position.distanceTo(right.position),
    ).slice(0, SAFE_FORAGE_MAX_CANDIDATES);
  }

  private safeForageBlocks(): SafeForageBlockTarget[] {
    if (typeof this.bot.findBlocks !== "function") return [];
    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id?: unknown }>;
    };
    const matching = SAFE_FORAGE_BLOCK_NAMES
      .map((name) => registry.blocksByName?.[name]?.id)
      .filter((id): id is number => Number.isInteger(id));
    if (matching.length === 0) return [];

    let positions: Vec3[];
    try {
      positions = this.bot.findBlocks({
        matching,
        maxDistance: SAFE_FORAGE_MAX_DISTANCE,
        count: 32,
      });
    } catch {
      return [];
    }
    return positions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is NonNullable<typeof block> => block !== null)
      .map((block) => ({
        block,
        interaction: this.safeForageBlockInteraction(block),
      }))
      .filter(
        (target): target is SafeForageBlockTarget =>
          target.interaction !== null,
      )
      .sort(
        (left, right) =>
          this.bot.entity.position.distanceTo(left.block.position) -
          this.bot.entity.position.distanceTo(right.block.position),
      )
      .slice(0, SAFE_FORAGE_MAX_CANDIDATES);
  }

  private safeForageBlockInteraction(
    block: NonNullable<ReturnType<Bot["blockAt"]>>,
  ): SafeForageBlockInteraction | null {
    let properties: Record<string, unknown> = {};
    try {
      properties = block.getProperties() as Record<string, unknown>;
    } catch {
      // A missing property table is safe only for an always-ripe melon block.
    }
    if (block.name === "melon") return "dig";
    if (block.name === "sweet_berry_bush") {
      return Number(properties.age) >= 3 ? "activate" : null;
    }
    if (block.name === "carrots" || block.name === "potatoes") {
      return Number(properties.age) >= 7 ? "dig" : null;
    }
    if (block.name === "beetroots") {
      return Number(properties.age) >= 3 ? "dig" : null;
    }
    if (block.name === "cave_vines" || block.name === "cave_vines_plant") {
      return properties.berries === true || properties.berries === "true"
        ? "activate"
        : null;
    }
    return null;
  }

  private nearestSafeFoodDropPosition(): Vec3 | null {
    const candidates = Object.values(this.bot.entities ?? {})
      .map((entity) => entity as unknown as {
        name?: unknown;
        displayName?: unknown;
        isValid?: unknown;
        position?: Vec3;
        getDroppedItem?: () => { name?: unknown } | null;
      })
      .filter((entity) => {
        const entityName = String(
          entity.name ?? entity.displayName ?? "",
        ).toLowerCase();
        if (
          entityName !== "item" ||
          entity.isValid === false ||
          entity.position === undefined
        ) {
          return false;
        }
        let itemName = "";
        try {
          itemName = String(entity.getDroppedItem?.()?.name ?? "");
        } catch {
          return false;
        }
        const distance = this.bot.entity.position.distanceTo(entity.position);
        return (
          SAFE_FOOD_NAMES.has(itemName) &&
          Number.isFinite(distance) &&
          distance <= SAFE_FORAGE_MAX_DISTANCE
        );
      })
      .sort(
        (left, right) =>
          this.bot.entity.position.distanceTo(left.position!) -
          this.bot.entity.position.distanceTo(right.position!),
      );
    return candidates[0]?.position ?? null;
  }

  private async harvestSafeForageBlock(
    target: SafeForageBlockTarget,
    startedHealth: number | null,
    signal: AbortSignal,
    deadline: number,
  ): Promise<L0SafetyActionResult> {
    if (this.forageTookDamage(startedHealth)) {
      return { outcome: "failed", errorCode: "FORAGE_ABORTED_ON_DAMAGE" };
    }
    let liveBlock = this.bot.blockAt(target.block.position);
    if (
      liveBlock === null ||
      this.safeForageBlockInteraction(liveBlock) !== target.interaction
    ) {
      return { outcome: "skipped", errorCode: "SAFE_FOOD_SOURCE_STALE" };
    }
    if (
      this.bot.entity.position.distanceTo(liveBlock.position) >
      SAFE_FORAGE_REACH_DISTANCE
    ) {
      const reached = await this.trySafetyGoto(
        new goals.GoalNear(
          liveBlock.position.x,
          liveBlock.position.y,
          liveBlock.position.z,
          2,
        ),
        signal,
        Math.min(
          SAFE_FORAGE_PATH_BUDGET_MS,
          Math.max(100, deadline - Date.now()),
        ),
      );
      if (!reached) {
        return {
          outcome: "skipped",
          errorCode: "SAFE_FOOD_SOURCE_UNREACHABLE",
        };
      }
      liveBlock = this.bot.blockAt(target.block.position);
    }
    if (
      liveBlock === null ||
      this.safeForageBlockInteraction(liveBlock) !== target.interaction ||
      this.bot.entity.position.distanceTo(liveBlock.position) >
        SAFE_FORAGE_REACH_DISTANCE
    ) {
      return { outcome: "skipped", errorCode: "SAFE_FOOD_SOURCE_STALE" };
    }

    this.stopPathfinder();
    await this.bot.lookAt(liveBlock.position.offset(0.5, 0.5, 0.5), true);
    if (this.forageTookDamage(startedHealth)) {
      return { outcome: "failed", errorCode: "FORAGE_ABORTED_ON_DAMAGE" };
    }
    try {
      if (target.interaction === "activate") {
        if (typeof this.bot.activateBlock !== "function") {
          return { outcome: "skipped", errorCode: "FORAGE_RUNTIME_UNAVAILABLE" };
        }
        await this.bot.activateBlock(liveBlock);
      } else {
        if (
          typeof this.bot.dig !== "function" ||
          (typeof this.bot.canDigBlock === "function" &&
            !this.bot.canDigBlock(liveBlock))
        ) {
          return {
            outcome: "skipped",
            errorCode: "SAFE_FOOD_SOURCE_UNREACHABLE",
          };
        }
        await this.bot.dig(liveBlock, true);
      }
    } catch {
      return { outcome: "skipped", errorCode: "SAFE_FOOD_HARVEST_FAILED" };
    }
    if (this.safeFoodItems().length > 0) {
      return { outcome: "executed", errorCode: null };
    }
    const drop = this.nearestSafeFoodDropPosition() ??
      this.nearestDroppedItemPosition(liveBlock.position) ??
      liveBlock.position;
    return await this.pickUpForagedFood(drop, startedHealth, signal, deadline)
      ? { outcome: "executed", errorCode: null }
      : { outcome: "skipped", errorCode: "SAFE_FOOD_PICKUP_NOT_SETTLED" };
  }

  private async exploreForSafeFood(
    signal: AbortSignal,
    deadline: number,
  ): Promise<boolean> {
    const direction = SAFE_FORAGE_EXPLORATION_DIRECTIONS[
      this.safeForageExplorationCursor % SAFE_FORAGE_EXPLORATION_DIRECTIONS.length
    ]!;
    this.safeForageExplorationCursor += 1;
    const origin = this.bot.entity.position;
    return this.trySafetyGoto(
      new goals.GoalNear(
        Math.floor(origin.x + direction[0] * SAFE_FORAGE_EXPLORATION_DISTANCE),
        Math.floor(origin.y),
        Math.floor(origin.z + direction[1] * SAFE_FORAGE_EXPLORATION_DISTANCE),
        2,
      ),
      signal,
      Math.min(
        SAFE_FORAGE_PATH_BUDGET_MS,
        Math.max(100, deadline - Date.now()),
      ),
    );
  }

  private async pickUpForagedFood(
    position: Vec3,
    startedHealth: number | null,
    signal: AbortSignal,
    deadline: number,
  ): Promise<boolean> {
    await this.trySafetyGoto(
      new goals.GoalNear(
        Math.floor(position.x),
        Math.floor(position.y),
        Math.floor(position.z),
        0,
      ),
      signal,
      Math.min(
        SAFE_FORAGE_PATH_BUDGET_MS,
        Math.max(100, deadline - Date.now()),
      ),
    );
    const pickupDeadline = Math.min(
      deadline,
      Date.now() + SAFE_FORAGE_PICKUP_BUDGET_MS,
    );
    while (!signal.aborted && Date.now() < pickupDeadline) {
      if (this.safeFoodItems().length > 0) return true;
      if (this.forageTookDamage(startedHealth)) return false;
      await waitForDelay(100);
    }
    return this.safeFoodItems().length > 0;
  }

  private forageTookDamage(startedHealth: number | null): boolean {
    return (
      startedHealth !== null &&
      finiteNumber(this.bot.health) !== null &&
      Number(this.bot.health) < startedHealth
    );
  }

  private async foragePassiveEntity(
    target: NonNullable<ReturnType<Bot["nearestEntity"]>>,
    startedHealth: number | null,
    signal: AbortSignal,
    deadline: number,
  ): Promise<L0SafetyActionResult> {
    let lastTargetPosition = target.position.clone();
    while (!signal.aborted && Date.now() < deadline) {
        if (this.requestedStop) {
          return { outcome: "skipped", errorCode: "RUNTIME_STOPPING" };
        }
        if (
          startedHealth !== null &&
          finiteNumber(this.bot.health) &&
          Number(this.bot.health) < startedHealth
        ) {
          return { outcome: "failed", errorCode: "FORAGE_ABORTED_ON_DAMAGE" };
        }
        const liveTarget = Object.values(this.bot.entities ?? {}).find(
          (entity) => entity.id === target.id && entity.isValid !== false,
        );
        if (!liveTarget) break;
        lastTargetPosition = liveTarget.position.clone();
        const distance = this.bot.entity.position.distanceTo(
          liveTarget.position,
        );
        if (!Number.isFinite(distance)) {
          return { outcome: "failed", errorCode: "FORAGE_TARGET_INVALID" };
        }
        if (distance > SAFE_FORAGE_REACH_DISTANCE) {
          const pathBudget = Math.min(
            SAFE_FORAGE_PATH_BUDGET_MS,
            Math.max(100, deadline - Date.now()),
          );
          const reached = await this.trySafetyGoto(
            new goals.GoalFollow(liveTarget, 2),
            signal,
            pathBudget,
          );
          if (!reached) {
            return {
              outcome: "skipped",
              errorCode: "SAFE_FOOD_SOURCE_UNREACHABLE",
            };
          }
          continue;
        }

        this.stopPathfinder();
        await this.bot.lookAt(
          liveTarget.position.offset(
            0,
            Math.max(0.5, Math.min(1.5, liveTarget.height ?? 1)),
            0,
          ),
          true,
        );
        await this.bot.attack(liveTarget);
        await waitForDelay(
          Math.min(
            SAFE_FORAGE_ATTACK_INTERVAL_MS,
            Math.max(0, deadline - Date.now()),
          ),
        );
      }

    const targetStillAlive = Object.values(this.bot.entities ?? {}).some(
        (entity) => entity.id === target.id && entity.isValid !== false,
      );
      if (targetStillAlive) {
        return { outcome: "skipped", errorCode: "FORAGE_TARGET_NOT_DEFEATED" };
      }
      if (this.safeFoodItems().length > 0) {
        return { outcome: "executed", errorCode: null };
      }

      await this.trySafetyGoto(
        new goals.GoalNear(
          Math.floor(lastTargetPosition.x),
          Math.floor(lastTargetPosition.y),
          Math.floor(lastTargetPosition.z),
          1,
        ),
        signal,
        Math.min(
          SAFE_FORAGE_PATH_BUDGET_MS,
          Math.max(100, deadline - Date.now()),
        ),
      );
      const pickupDeadline = Math.min(
        deadline,
        Date.now() + SAFE_FORAGE_PICKUP_BUDGET_MS,
      );
      let approachedDrop = false;
      while (!signal.aborted && Date.now() < pickupDeadline) {
        if (this.safeFoodItems().length > 0) {
          return { outcome: "executed", errorCode: null };
        }
        if (!approachedDrop) {
          const drop = this.nearestDroppedItemPosition(lastTargetPosition);
          if (drop) {
            approachedDrop = true;
            await this.trySafetyGoto(
              new goals.GoalNear(
                Math.floor(drop.x),
                Math.floor(drop.y),
                Math.floor(drop.z),
                0,
              ),
              signal,
              Math.min(
                SAFE_FORAGE_PATH_BUDGET_MS,
                Math.max(100, pickupDeadline - Date.now()),
              ),
            );
          }
        }
        await waitForDelay(100);
      }
    return { outcome: "skipped", errorCode: "SAFE_FOOD_PICKUP_NOT_SETTLED" };
  }

  private async trySafetyGoto(
    goal: Parameters<Bot["pathfinder"]["goto"]>[0],
    signal: AbortSignal,
    budgetMs: number,
  ): Promise<boolean> {
    if (signal.aborted || budgetMs < 100) return false;
    try {
      await this.boundedCollectGoto(goal, signal, budgetMs);
      return !signal.aborted;
    } catch {
      return false;
    }
  }

  /**
   * G1 spawn-escape（2026-09-03 luv 实战）：出生点是结构性击杀区——法证
   * 结论为竖井坠落（4.5=7.5 格）+ 井底怪坑，认证后物理放开即坠落。此反射
   * 在 spawn 第一时刻沿预设方位疾跑（默认东南 135°、96 格），确定性执行
   * 不经 planner/LLM；L0 安全层仍在更上层（crit → 断线保号不变）。
   * 重触发：spawn 落在首个出生点 64 格内即再逃（床毁重生/出生拉回循环
   * 都覆盖）；远点/跨维度 spawn 不触发（防下界门误逃）。
   */
  private trySpawnEscape(): void {
    if (!this.anarchyNavigation || this.spawnEscapeActive) return;
    if (process.env.STUDIO_SPAWN_ESCAPE === "0") return;
    const pos = this.bot.entity?.position;
    if (!pos) return;
    if (this.worldSpawnOrigin === null) {
      this.worldSpawnOrigin = { x: pos.x, z: pos.z };
    }
    const dx = pos.x - this.worldSpawnOrigin.x;
    const dz = pos.z - this.worldSpawnOrigin.z;
    if (dx * dx + dz * dz > 64 * 64) return;
    const distance = Number(process.env.STUDIO_SPAWN_ESCAPE_DISTANCE ?? "96");
    const bearingDeg = Number(process.env.STUDIO_SPAWN_ESCAPE_BEARING_DEG ?? "135");
    const rad = (bearingDeg * Math.PI) / 180;
    if (!Number.isFinite(distance) || !Number.isFinite(bearingDeg)) return;
    const targetX = Math.floor(pos.x + Math.cos(rad) * distance);
    const targetZ = Math.floor(pos.z + Math.sin(rad) * distance);
    this.spawnEscapeActive = true;
    // 观测日志：逃逸是反射行为，无 planner 链路——直接写进程日志
    // （bot-<id>.log，manager 捕获 stdout），字段结构与结构化事件对齐。
    const escapeLog = (event: string, extra: Record<string, unknown> = {}) => {
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: "warn",
          service: "bot-runtime",
          event,
          botId: (this.bot as { username?: string }).username ?? null,
          ...extra,
        }),
      );
    };
    escapeLog("bot_runtime_spawn_escape_started", {
      from: `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`,
      target: `${targetX},${targetZ}`,
      distance,
      bearingDeg,
    });
    // v0.1 修复（2026-09-03 实测）：spawn 第一 tick bot 常在半空且 chunk
    // 未加载完——goto 17ms 内即拒绝。拒绝 ≠ 放弃：2s 后重试（等 chunk 追上），
    // 三试仍败才落原始疾跑兜底（此前兜底被 .catch 吞掉永远不跑）。
    const settle = (via: string) => {
      this.spawnEscapeActive = false;
      this.bot.setControlState("sprint", false);
      this.bot.setControlState("jump", false);
      const at = this.bot.entity?.position;
      escapeLog("bot_runtime_spawn_escape_settled", {
        via,
        at: at
          ? `${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}`
          : "unknown",
      });
      this.handlers?.onStateChanged();
    };
    const rawSprint = () => {
      try {
        this.bot.setControlState("sprint", true);
        this.bot.setControlState("forward", true);
        void this.bot
          .look(Math.atan2(-Math.cos(rad), Math.sin(rad)), 0, true)
          .catch(() => undefined);
        setTimeout(() => {
          this.bot.setControlState("forward", false);
          this.bot.setControlState("sprint", false);
          settle("raw_sprint");
        }, 5_000).unref?.();
      } catch {
        settle("raw_sprint_failed");
      }
    };
    const attempt = (n: number): void => {
      if (n > 3) {
        rawSprint();
        return;
      }
      try {
        const movements = configureNavigationMovements(
          new Movements(this.bot),
          this.bot,
          true,
        );
        this.bot.pathfinder.setMovements(movements);
        this.bot.pathfinder.thinkTimeout = 8_000;
        this.bot.pathfinder.tickTimeout = 40;
        this.bot.setControlState("sprint", true);
        this.bot.setControlState("jump", true);
        void this.bot.pathfinder
          .goto(new goals.GoalXZ(targetX, targetZ))
          .then(
            () => settle("pathfinder"),
            () => {
              this.bot.setControlState("sprint", false);
              this.bot.setControlState("jump", false);
              escapeLog("bot_runtime_spawn_escape_retry", { attempt: n });
              setTimeout(() => attempt(n + 1), 2_000).unref?.();
            },
          );
        this.handlers?.onStateChanged();
      } catch {
        escapeLog("bot_runtime_spawn_escape_retry", { attempt: n, sync: true });
        setTimeout(() => attempt(n + 1), 2_000).unref?.();
      }
    };
    attempt(1);
  }

  private bindInventoryEvents(): void {
    if (this.inventoryListenerBound) return;
    const inventory = this.bot.inventory;
    if (!inventory || typeof inventory.on !== "function") return;
    inventory.on("updateSlot", () => this.handlers?.onStateChanged());
    this.inventoryListenerBound = true;
  }

  private async applyBoundedControls(
    durationMs: number | undefined,
    controls: readonly (
      | "forward"
      | "back"
      | "left"
      | "right"
      | "jump"
      | "sprint"
    )[],
    lease: MovementLease,
  ): Promise<void> {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs === undefined ||
      durationMs < 100 ||
      durationMs > 2_000
    ) {
      throw new TypeError("Bounded movement duration is invalid.");
    }
    lease.assertCurrent();
    this.bot.clearControlStates();
    for (const control of controls) this.bot.setControlState(control, true);
    try {
      await waitForDurationOrAbort(durationMs, lease.signal);
      lease.assertCurrent();
    } finally {
      // Preemption cleanup already stopped the old controls synchronously.
      // A late callback must not clear controls installed by the new owner.
      if (lease.isCurrent()) this.bot.clearControlStates();
    }
  }

  private stopPathfinder(): void {
    try {
      this.bot.pathfinder?.stop();
    } catch {
      // Stopping movement is best-effort; callers still clear Mineflayer controls.
    }
  }

  private stopMovementPrimitives(): void {
    try {
      const cancelTask = this.bot.collectBlock?.cancelTask;
      if (typeof cancelTask === "function") {
        void cancelTask.call(this.bot.collectBlock).catch(() => {});
      }
    } catch {
      // collectblock may be absent or already settled during disconnect.
    }
    this.stopPathfinder();
    try {
      this.bot.clearControlStates();
    } catch {
      // Disconnect cleanup is best effort.
    }
  }
}

function waitForDurationOrAbort(
  durationMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, durationMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * 正版凭据的环境变量名：botId 里的非字母数字折成下划线后大写。
 * 例：studio-bot-01 -> STUDIO_BOT_PASSWORD_STUDIO_BOT_01。
 */
export function botPasswordEnvVar(botId: string): string {
  return `STUDIO_BOT_PASSWORD_${botId.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}`;
}

function resolveOnlinePassword(botId: string): string {
  const value = process.env[botPasswordEnvVar(botId)]?.trim() ?? "";
  if (!value) {
    throw new Error(
      `Online auth requires ${botPasswordEnvVar(botId)} in the environment; refusing to silently fall back to offline mode.`,
    );
  }
  return value;
}

/** Provenance 持久化路径：runtime-data/provenance/<serverProfileId>.json。 */
function provenancePersistPath(serverProfileId: string): string {
  const safe = serverProfileId.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 128);
  return path.join(process.cwd(), "runtime-data", "provenance", `${safe}.json`);
}

export function createMineflayerClient(
  profile: ServerProfile,
  worldState = new WorldStateStore(),
): BotClient {
  const base = createMineflayerOptions(profile);
  const bot = createBot(
    profile.auth === "online"
      ? {
          ...base,
          // 我们的 "online" 档映射到 mineflayer 的微软登录；密码只进进程内存。
          auth: "microsoft" as const,
          password: resolveOnlinePassword(profile.botId),
        }
      : base,
  );
  bot.loadPlugin(pathfinder);
  // collectblock 会自动加载它依赖的 mineflayer-tool（两者均 MIT，供应链已锁定）。
  bot.loadPlugin(collectBlockPlugin);
  return new MineflayerBotClient(
    bot,
    profile.minecraftVersion,
    profile.id,
    profile.combat?.enabled === true,
    worldState,
    profile.navigation ?? "safe",
    { host: profile.host, port: profile.port },
    profile.noHunger,
  );
}

export function createMineflayerOptions(profile: ServerProfile) {
  const version = mineflayerVersionOption(profile.minecraftVersion);
  return {
    // host/connectHost 分离（2026-09-03 canary 修正）：TCP 目的地址可被
    // connectHost 覆盖（真 IP 直连），握手 hostname 恒为 profile.host
    // （fakeHost 覆盖 set_protocol.serverHost——按锁定依赖
    // minecraft-protocol@1.66.2 src/client/setProtocol.js:19 核实）。
    host: profile.connectHost ?? profile.host,
    ...(profile.connectHost !== undefined
      ? { fakeHost: profile.host }
      : {}),
    port: profile.port,
    username: profile.username,
    // offline 档直连；online 档的 microsoft 映射与密码注入在
    // createMineflayerClient 里做（密码绝不进入本函数的纯返回值）。
    ...(profile.auth === "offline" ? { auth: "offline" as const } : {}),
    ...(version === false ? {} : { version }),
    hideErrors: true,
    logErrors: false,
  };
}

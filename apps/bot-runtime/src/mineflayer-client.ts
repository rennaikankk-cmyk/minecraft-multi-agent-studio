import { createBot, type Bot } from "mineflayer";
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
  collectBlockCapabilityInputSchema,
  collectBlockCapabilityOutputSchema,
  containerTransferCapabilityInputSchema,
  containerTransferCapabilityOutputSchema,
  craftItemCapabilityInputSchema,
  craftItemCapabilityOutputSchema,
  placeBlockCapabilityInputSchema,
  placeBlockCapabilityOutputSchema,
  smeltItemCapabilityInputSchema,
  smeltItemCapabilityOutputSchema,
  SAFE_PATH_MAX_DISTANCE,
  SkillFault,
  SkillRefusal,
  resolveMovementProfile,
  type ServerPolicyLimits,
  safeMovementGotoCapabilityInputSchema,
  safeMovementGotoCapabilityOutputSchema,
  travelRouteCapabilityInputSchema,
  tradeVillagerCapabilityInputSchema,
  tradeVillagerCapabilityOutputSchema,
  scanBlocksCapabilityInputSchema,
  scanBlocksCapabilityOutputSchema,
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
  storeSortCapabilityInputSchema,
  storeSortCapabilityOutputSchema,  type SkillCapabilityRequest,
  type SkillCompatibilityEnvironment,
  type SkillResourceKind,
} from "@minecraft-studio/skills";
import type {
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";
import { MineflayerCombatAdapter } from "./combat-mineflayer-adapter.js";
import { observeSite, digShelter } from "./site-shelter-adapter.js";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "./client.js";
import type { ServerProfile } from "./server-profile.js";
import {
  isMineflayerUnsupportedVersionError,
  mineflayerVersionOption,
  resolvedVersionCompatibility,
} from "./version-compatibility.js";

const { goals } = pathfinderModule;

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

const SAFE_FOOD_NAMES = new Set([
  "apple",
  "baked_potato",
  "beetroot",
  "beetroot_soup",
  "bread",
  "carrot",
  "cooked_beef",
  "cooked_chicken",
  "cooked_cod",
  "cooked_mutton",
  "cooked_porkchop",
  "cooked_rabbit",
  "cooked_salmon",
  "dried_kelp",
  "glow_berries",
  "melon_slice",
  "mushroom_stew",
  "pumpkin_pie",
  "rabbit_stew",
  "sweet_berries",
]);

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

function normalizeDimension(value: string): string {
  if (value.includes(":")) return value.toLowerCase();
  const normalized = value.toLowerCase().replace(/[^a-z0-9_./-]/gu, "_");
  return `minecraft:${normalized || "unknown"}`;
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
  let provenPathless = 0;
  let examined = 0;
  let stoppedOnTotalBudget = false;
  const deadline = Date.now() + COLLECT_PRECHECK_TOTAL_BUDGET_MS;
  for (const target of targets) {
    // 够数就停：池子放大是为了有替补，不是为了多采。攒到需求量就不再花钱，
    // 也顺手把交给 collect() 的目标数压在请求量之内。
    if (reachable.length >= wanted) break;
    // 总预算是放大池子的必要配套：逐候选 1500ms × 放大后的池子会吃掉整个 60s
    // 合约。剩下没检查的候选因此既不算可达也不算证明不可达，于是
    // provenPathless < targets.length 成立，上层收到的是 EXHAUSTED 而不是
    // 一个冒充定论的 UNREACHABLE。
    if (Date.now() >= deadline) {
      stoppedOnTotalBudget = true;
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
    if (status === "noPath") provenPathless += 1;
  }
  return { reachable, provenPathless, examined, stoppedOnTotalBudget };
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
    return { reason: "kicked", expected: false, detail: kickedDetail };
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

export class MineflayerBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  private requestedStop = false;
  private kickedDetail: string | undefined;
  private errorDetail: string | undefined;
  private versionUnsupportedReported = false;
  private inventoryListenerBound = false;
  private activePathInvocationId: string | null = null;
  private readonly combatAdapter: MineflayerCombatAdapter;

  constructor(
    private readonly bot: Bot,
    private readonly configuredVersion: ServerProfile["minecraftVersion"],
    private readonly serverProfileId: string | null = null,
    combatEnabled = false,
  ) {
    this.combatAdapter = new MineflayerCombatAdapter(
      bot,
      serverProfileId ?? "",
      combatEnabled,
    );
    bot.on("spawn", () => {
      this.bindInventoryEvents();
      this.handlers?.onSpawn();
    });
    bot.on("health", () => this.handlers?.onStateChanged());
    bot.on("breath", () => this.handlers?.onStateChanged());
    bot.on("move", () => this.handlers?.onStateChanged());
    bot.on("physicsTick", () => this.handlers?.onStateChanged());
    bot.on("entityEquip", (entity) => {
      if (entity === bot.entity) this.handlers?.onStateChanged();
    });
    bot.on("kicked", (reason) => {
      this.kickedDetail = safeDetail(reason);
    });
    bot.on("error", (error) => {
      this.errorDetail = safeDetail(error.message);
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
      this.handlers?.onDisconnected(
        mapDisconnectReason(
          this.requestedStop,
          this.versionUnsupportedReported,
          this.kickedDetail,
          this.errorDetail,
          reason,
        ),
      );
    });
  }

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
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
      position: {
        x: position.x,
        y: position.y,
        z: position.z,
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

  async executeSafetyAction(
    action: L0SafetyAction,
  ): Promise<L0SafetyActionResult> {
    if (this.requestedStop) {
      return { outcome: "skipped", errorCode: "RUNTIME_STOPPING" };
    }
    try {
      this.stopPathfinder();
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
        await this.bot.equip(food.item, "hand");
        await this.bot.consume();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "RETREAT_STEP") {
        await this.applyBoundedControls(action.durationMs, ["back", "sprint"]);
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "ASCEND") {
        await this.applyBoundedControls(action.durationMs, ["jump"]);
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "ESCAPE_LAVA") {
        await this.applyBoundedControls(action.durationMs, ["jump", "forward"]);
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "UNSTICK") {
        await this.applyBoundedControls(action.durationMs, ["jump", "back"]);
        return { outcome: "executed", errorCode: null };
      }
      return { outcome: "skipped", errorCode: "RUNTIME_ACTION_REQUIRED" };
    } catch {
      this.bot.clearControlStates();
      return { outcome: "failed", errorCode: "SAFETY_ACTION_FAILED" };
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
      request.capability === "inventory.write" &&
      request.operation === "armor.equip"
    ) {
      return this.invokeArmorEquip(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "collect.blocks-safe"
    ) {
      return this.invokeCollectBlocks(request);
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "craft.item-safe"
    ) {
      return this.invokeCraftItem(request);
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "smelt.item-safe"
    ) {
      return this.invokeSmeltItem(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "block.place-safe"
    ) {
      const blueprintInput = buildBlueprintCapabilityInputSchema.safeParse(request.input);
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
        return this.invokePlaceBlock({ ...request, input: placement });
      }
      return this.invokePlaceBlock(request);
    }
    if (
      request.capability === "container.write" &&
      request.operation === "container.transfer-safe"
    ) {
      return this.invokeContainerTransfer(request);
    }    if (
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
      (request.operation === "mine.branch-safe" || request.operation === "mine.vein-safe")
    ) {
      return this.invokeMinePlan(request);
    }
    throw new SkillFault("SKILL_CAPABILITY_UNSUPPORTED");
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
    const movements = configureSafePathfinderMovements(new Movements(this.bot));
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

  private async invokeMovementGoto(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    if (!this.bot.pathfinder) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    if (this.activePathInvocationId !== null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
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
      if (request.signal.aborted) {
        stopOnAbort();
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
    } catch (error) {
      if (request.signal.aborted) {
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
      request.signal.removeEventListener("abort", stopOnAbort);
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
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
  }

  private assertServerProfileMatch(requestedProfileId: string): void {
    if (requestedProfileId !== this.serverProfileId) {
      throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
    }
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
      for (let attempt = 0; attempt <= COLLECT_SERVER_DIG_RETRIES; attempt += 1) {
        if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const confirmation = waitForServerConfirmation(block.position);
        try {
          await callOriginalDig(...args);
          confirmation.armTimeout();
          if (await confirmation.promise) return;
        } finally {
          confirmation.cancel();
        }
      }
      throw new Error("Server did not confirm collected block break.");
    }) as Bot["dig"];

    mutableBot.dig = wrappedDig;
    return () => {
      if (mutableBot.dig === wrappedDig) mutableBot.dig = originalDig;
    };
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
    if (this.activePathInvocationId !== null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
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
      // No target is a proved no-op: findBlocks/blockAt only read the loaded
      // world, and collectBlock has not started. Report it as a refusal so a
      // multi-step planner can reobserve or explore instead of treating a
      // zero-count `completed` result as an uncertain non-idempotent action.
      throw new SkillRefusal(
        "COLLECT_TARGET_UNREACHABLE",
        `No exposed ${input.data.blockName} target was found within ${input.data.maxDistance} blocks.`,
      );
    }

    // 采集途中不允许插件把物品倒进任何箱子——入库是 container.transfer
    // 的职责，且必须显式授权。
    this.bot.collectBlock.chestLocations = [];
    const movements = configureSafePathfinderMovements(new Movements(this.bot));
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
    const reachableTargets = reachability.reachable;
    if (reachableTargets.length === 0) {
      // 两个码，判据是"有没有证明"。主路径的 catch 已经这么分了（NoPath vs
      // Timeout），前置检查这一层此前把两者合并成不可达，于是一个只是没算完的
      // 搜索被当成定论上报，白丢一级 RETRY_SAME——failure-classifier.ts:180
      // 明令这两件事不能合并：UNREACHABLE 是 STALE_WORLD（重新观察或放弃），
      // SEARCH_EXHAUSTED 是 TRANSIENT（可以原样再试一次）。
      // 码写成字面量而不是从 helper 返回：分类器测试靠正则扫
      // `new SkillRefusal("...")` 发现新码（failure-classifier.test.ts:467）。
      //
      // 两处都是 SkillRefusal 而不是 SkillFault：走到这里一块都没挖、背包没动、
      // collect() 还没被调用，getPathFromTo 只做搜索不移动机器人。这个事实
      // 只有这里知道——同一个码在下面的 NoPath catch 里也会抛，但那时
      // collect() 可能已经挖掉了几块，所以那一处必须留成普通 SkillFault。
      // 协调器的非幂等屏蔽据此放行，这个步骤才能走到它该走的恢复阶梯
      // 而不是被升级成人工工单。
      if (reachability.provenPathless < targets.length) {
        // 报"排了几个"和"是哪个预算截断的"，不只报"证明了几个"。
        // 实测这条 reason 曾是 "Only 0 of 9 ... within the 1500ms pre-check
        // budget."——九个候选里其实最多排得下 4 个（1500ms × 4 ≈ 6000ms 总预算），
        // 而句子里唯一出现的数字是那个没绑住循环的 per-candidate 常量。运维照它
        // 去调 1500ms 只会让能排下的候选更少。两个预算都写出来，再说明是哪一个
        // 先到,这条失败才是可诊断的。
        const boundBy = reachability.stoppedOnTotalBudget
          ? `${COLLECT_PRECHECK_TOTAL_BUDGET_MS}ms total budget`
          : `${COLLECT_PRECHECK_BUDGET_MS}ms per-candidate budget`;
        throw new SkillRefusal(
          "COLLECT_PATH_SEARCH_EXHAUSTED",
          `Examined ${reachability.examined} of ${targets.length} exposed ${input.data.blockName} candidates and proved ${reachability.provenPathless} pathless before the ${boundBy} ran out; none was proven reachable.`,
        );
      }
      // 扫描说"有暴露面"，寻路把每一个都排空了开集——这是世界状态，不是缺陷，
      // 所以带着候选数报出去，让上层重新观察而不是原样重试。
      throw new SkillRefusal(
        "COLLECT_TARGET_UNREACHABLE",
        `All ${targets.length} exposed ${input.data.blockName} candidates were proven unreachable by the pre-check.`,
      );
    }

    // 一轮只交请求量那么多，替补留到下一轮。批次数因此至多
    // 1 + COLLECT_LIVE_PATH_SUBSTITUTES。
    const attemptBatches: Array<typeof reachableTargets> = [];
    for (
      let offset = 0;
      offset < reachableTargets.length;
      offset += input.data.maxCount
    ) {
      attemptBatches.push(
        reachableTargets.slice(offset, offset + input.data.maxCount),
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
      void this.bot.collectBlock.cancelTask().catch(() => {});
      this.stopPathfinder();
    };
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal.aborted) {
        stopOnAbort();
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
      // 实跑被拒就换替补，而不是让一次坏抽样沉掉整步。只有寻路类拒绝
      // （NoPath / Timeout）才换：别的错误换个坐标也一样会犯，换了只是白烧预算。
      let lastPathFailure: unknown = null;
      for (const batch of attemptBatches) {
        attemptsMade += 1;
        try {
          const settled = await Promise.race([
            this.bot.collectBlock
              .collect(batch, { ignoreNoPath: false })
              .then(() => "resolved" as const),
            new Promise<"stalled">((resolve) => {
              const timer = setTimeout(() => resolve("stalled"), COLLECT_SETTLE_BUDGET_MS);
              if (typeof timer.unref === "function") timer.unref();
            }),
          ]);
          if (settled === "stalled") {
            await this.bot.collectBlock.cancelTask().catch(() => {});
            this.stopPathfinder();
            throw new SkillFault(
              "COLLECT_PICKUP_NOT_SETTLED",
              `collectBlock neither resolved nor rejected within ${COLLECT_SETTLE_BUDGET_MS}ms for ${input.data.blockName}.`,
            );
          }
          collectedTargets = batch.length;
          collectionSucceeded = true;
          lastPathFailure = null;
          break;
        } catch (error) {
          if (error instanceof SkillFault) throw error;
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          const failure = error instanceof Error ? error.name : "";
          if (failure !== "NoPath" && failure !== "Timeout") throw error;
          // 已经挖到东西就不换候选：请求量是上限，换一轮会挖过量。挖到多少用
          // 背包读回判断，不靠插件的返回值猜。
          if (this.countInventoryTotal() > inventoryBefore) throw error;
          lastPathFailure = error;
          // 插件的循环还带着这一批目标，不取消就会污染下一批。
          await this.bot.collectBlock.cancelTask().catch(() => {});
          this.stopPathfinder();
        }
      }
      if (lastPathFailure !== null) throw lastPathFailure;
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
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
      const reason = `${pluginReason} (attempted ${attemptsMade} of ${attemptBatches.length} proven-reachable batch(es))`;
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

    let craftingTable = null;
    if (input.data.craftingTable) {
      const { x, y, z } = input.data.craftingTable;
      craftingTable = this.bot.blockAt(new Vec3(x, y, z));
      if (!craftingTable || craftingTable.name !== "crafting_table") {
        throw new SkillFault("CRAFTING_TABLE_NOT_FOUND");
      }
    }

    const recipes = this.bot.recipesFor(
      itemType.id,
      null,
      1,
      craftingTable ?? false,
    );
    const recipe = recipes[0];
    if (!recipe) {
      // 区分"没配方"与"材料不够"由上层结合库存判断；这里如实报不可合成。
      throw new SkillFault("RECIPE_UNAVAILABLE");
    }

    const before = this.countInventoryItem(input.data.itemName);
    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    try {
      await this.bot.craft(
        recipe,
        input.data.count,
        craftingTable ?? undefined,
      );
    } catch {
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // craft 抛错时也读回增量——部分成功要如实上报而不是丢弃。
      const partial = Math.max(
        0,
        this.countInventoryItem(input.data.itemName) - before,
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
      this.countInventoryItem(input.data.itemName) - before,
    );
    return craftItemCapabilityOutputSchema.parse({
      itemName: input.data.itemName,
      requestedCount: input.data.count,
      craftedCount,
      usedCraftingTable: craftingTable !== null,
    });
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

    const { x, y, z } = input.data.furnace;
    const block = this.bot.blockAt(new Vec3(x, y, z));
    if (!block || !["furnace", "blast_furnace", "smoker"].includes(block.name)) {
      throw new SkillFault("FURNACE_NOT_FOUND");
    }

    let furnace: Awaited<ReturnType<Bot["openFurnace"]>> | null = null;
    let outputItemName: string | null = null;
    let smeltedCount = 0;
    try {
      furnace = await this.bot.openFurnace(block);
      if (furnace.inputItem() || furnace.fuelItem() || furnace.outputItem()) {
        throw new SkillFault("FURNACE_NOT_EMPTY");
      }
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await furnace.putInput(inputType.id, null, input.data.count);
      await furnace.putFuel(fuelType.id, null, input.data.fuelCount);

      while (smeltedCount < input.data.count) {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const output = furnace.outputItem();
        if (output) {
          outputItemName ??= output.name;
          if (output.name !== outputItemName) throw new SkillFault("FURNACE_OUTPUT_MISMATCH");
          const taken = await furnace.takeOutput();
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
      await this.bot.placeBlock(reference, new Vec3(face.x, face.y, face.z));
    } catch {
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
    this.stopPathfinder();
    this.bot.clearControlStates();

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

  private bindInventoryEvents(): void {
    if (this.inventoryListenerBound) return;
    const inventory = this.bot.inventory;
    if (!inventory || typeof inventory.on !== "function") return;
    inventory.on("updateSlot", () => this.handlers?.onStateChanged());
    this.inventoryListenerBound = true;
  }

  private async applyBoundedControls(
    durationMs: number | undefined,
    controls: readonly ("forward" | "back" | "jump" | "sprint")[],
  ): Promise<void> {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs === undefined ||
      durationMs < 100 ||
      durationMs > 2_000
    ) {
      throw new TypeError("Safety action duration is invalid.");
    }
    this.bot.clearControlStates();
    for (const control of controls) this.bot.setControlState(control, true);
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    this.bot.clearControlStates();
  }

  private stopPathfinder(): void {
    try {
      this.bot.pathfinder?.stop();
    } catch {
      // Stopping movement is best-effort; callers still clear Mineflayer controls.
    }
  }
}

export function createMineflayerClient(profile: ServerProfile): BotClient {
  const bot = createBot(createMineflayerOptions(profile));
  bot.loadPlugin(pathfinder);
  // collectblock 会自动加载它依赖的 mineflayer-tool（两者均 MIT，供应链已锁定）。
  bot.loadPlugin(collectBlockPlugin);
  return new MineflayerBotClient(
    bot,
    profile.minecraftVersion,
    profile.id,
    profile.combat?.enabled === true,
  );
}

export function createMineflayerOptions(profile: ServerProfile) {
  const version = mineflayerVersionOption(profile.minecraftVersion);
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: profile.auth,
    ...(version === false ? {} : { version }),
    hideErrors: true,
    logErrors: false,
  };
}

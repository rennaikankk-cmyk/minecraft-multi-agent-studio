// rust-pathfinder.ts —— pathfinder-rs 的 bot-runtime 集成层。
//
// 组成：
//   classifyVolume  mineflayer 世界 → 体素分类体（引擎唯一输入形态）
//   rustGoto        分类 → worker 寻路 → 跟随（含挖穿执行/跑酷/卡住重算）
//
// 纪律：STUDIO_RUST_PATHFINDER=1 显式开启（默认走 mineflayer-pathfinder，
// 正确性特性门控）。分类与寻路的耗时计数进 rustPathStats 供 runtime 日志
// 归因（"哪里计算高"的数据面）。
//
// clean-room：引擎只认体素分类，MC 方块知识在本文件——与 Baritone 的
// 边界就是这条接缝。

import { createRequire } from "node:module";
import type { Bot } from "mineflayer";
import { SkillFault } from "@minecraft-studio/skills";

// bot-runtime 的 node_modules 里有 workspace 链接（package.json 已加依赖）。
// 加载失败=构建桥没跑（scripts/build-pathfinder-rs.mjs）——fail-closed 抛错。
// bot-runtime 是 ESM：cjs 依赖（addon/vec3）经 createRequire 加载
// （实测事故 2026-09-04：裸 require 在 ESM 输出里 ReferenceError，被
// 移动兜底 catch 误报成 PATHFINDER_GOTO_FAILED 三连重试）。
const nodeRequire = createRequire(import.meta.url);
let addonLoader: typeof import("@minecraft-studio/pathfinder-rs") | null = null;
function loadAdapter() {
  if (addonLoader === null) {
    addonLoader = nodeRequire("@minecraft-studio/pathfinder-rs") as typeof import("@minecraft-studio/pathfinder-rs");
  }
  return addonLoader;
}

/** 引擎拒绝dig的方块（保护资产/不可挖/慢到不该路径穿过）。 */
const SOLID_NAMES = new Set([
  "bedrock", "barrier", "command_block", "chain_command_block",
  "repeating_command_block", "structure_block", "structure_void",
  "end_portal_frame", "end_portal", "nether_portal", "end_gateway",
  "reinforced_deepslate", "obsidian", "crying_obsidian", "respawn_anchor",
  // 容器与工作站：路径绕行（我们的回收/取物走显式授权通道，不走路径挖掘）
  "chest", "trapped_chest", "barrel", "furnace", "blast_furnace", "smoker",
  "hopper", "dispenser", "dropper", "shulker_box", "ender_chest",
  "crafting_table", "loom", "cartography_table", "smithing_table",
  "stonecutter", "fletching_table", "grindstone", "anvil", "chipped_anvil",
  "damaged_anvil", "enchanting_table", "brewing_stand", "beacon",
  "spawner", "beehive", "bee_nest", "lectern", "bookshelf", "jukebox",
  "note_block", "bell",
]);

/** hazard：液体/火/烫/闷。引擎三格邻域拒入。 */
const HAZARD_NAMES = new Set([
  "water", "flowing_water", "lava", "flowing_lava", "fire", "soul_fire",
  "magma_block", "powder_snow", "campfire", "soul_campfire", "cactus",
  "sweet_berry_bush", "pointed_dripstone",
]);

const CLASS = Object.freeze({
  PASSABLE: 0,
  SOLID: 1,
  DIGGABLE: 2,
  HAZARD: 3,
} as const);

/** 分类单格：hazard > 保护性 SOLID > 空=可通行 > 其余=可挖。
 * （P5-D2 起导出：WorldSyncAdapter 的 registry 表构建复用同一分类器——
 * 寻路体素类与镜像 class mask 的方块知识必须同源，禁止两份分类表。） */
export function classifyBlock(name: string, boundingBox: string): number {
  if (HAZARD_NAMES.has(name)) return CLASS.HAZARD;
  if (SOLID_NAMES.has(name)) return CLASS.SOLID;
  if (boundingBox === "empty") return CLASS.PASSABLE;
  return CLASS.DIGGABLE;
}

export { CLASS as BLOCK_CLASS };

/** 分类体积（体素布局 [(y*sz+z)*sx+x]，origin=体数据(0,0,0)的世界坐标）。 */
export function classifyVolume(
  bot: Pick<Bot, "blockAt">,
  origin: { x: number; y: number; z: number },
  sx: number,
  sy: number,
  sz: number,
): { classes: Buffer } {
  const classes = Buffer.alloc(sx * sy * sz, CLASS.SOLID);
  for (let y = 0; y < sy; y += 1) {
    for (let z = 0; z < sz; z += 1) {
      for (let x = 0; x < sx; x += 1) {
        const block = bot.blockAt(
          newLocalVec3(origin.x + x, origin.y + y, origin.z + z),
        );
        classes[(y * sz + z) * sx + x] =
          block === null
            ? CLASS.SOLID // 未加载区块=未知=fail-closed
            : classifyBlock(block.name, String(block.boundingBox));
      }
    }
  }
  return { classes };
}

// vec3 的构造走最小 shim（类型走 blockAt 的参数位，避免穿透 cjs 边界）。
type BlockAtPosition = Parameters<Bot["blockAt"]>[0];
function newLocalVec3(x: number, y: number, z: number): BlockAtPosition {
  const Vec3Ctor = nodeRequire("vec3") as unknown as
    new (x: number, y: number, z: number) => unknown;
  return new Vec3Ctor(x, y, z) as BlockAtPosition;
}

/**
 * P5-D2c：worker 通道的 mirror 传输面（与寻路共用同一 addon 加载器与
 * 同一 worker——唯一 sender 语义由 WorldSyncAdapter 保证）。灰度门
 * STUDIO_WORLD_MIRROR_SYNC=1 开启时才调用（flag 关=零加载零行为）。
 */
export function mirrorTransport() {
  const adapter = loadAdapter();
  return {
    mirrorCreate: adapter.mirrorCreate.bind(adapter),
    mirrorSubmitEnvelope: adapter.mirrorSubmitEnvelope.bind(adapter),
    mirrorSubmitControl: adapter.mirrorSubmitControl.bind(adapter),
    mirrorHealth: adapter.mirrorHealth.bind(adapter),
    mirrorDispose: adapter.mirrorDispose.bind(adapter),
    mirrorSpatialQuery: adapter.mirrorSpatialQuery.bind(adapter),
  };
}

/** 测试 teardown：回收共享 worker（与 mirrorTransport 同一模块实例——
 * vitest 的 ESM import 与 createRequire 可能加载两份 CJS 实例，混用会
 * 杀错 worker）。 */
export function terminatePathfinderWorker(): Promise<void> {
  return loadAdapter().terminateWorker();
}

/** 每阶段耗时（runtime 日志归因用）。 */
export type RustPathStats = {
  classifyMs: number;
  findMs: number;
  followMs: number;
  volume: { sx: number; sy: number; sz: number };
  pathLen: number;
  success: boolean;
  recomputes: number;
};

const VOLUME_MARGIN = 8;
const VOLUME_HEIGHT = 24;
const FOLLOW_STUCK_MS = 2_500;
const FOLLOW_MAX_RECOMPUTES = 2;
const FOLLOW_TICK_MS = 100;

type Lease = {
  isCurrent: () => boolean;
  assertCurrent: () => void;
  signal: AbortSignal;
};

/**
 * Rust 路由 goto：分类 → worker 寻路 → 跟随。到达 radius 邻域 resolve；
 * 失败抛 SkillFault。跟随语义：挖穿（目标格实心先挖再进）、跑酷跳
 * （水平位移 >1 的路径段=sprint 跳）、卡住有界重算。
 */
export async function rustGoto(options: {
  bot: Bot;
  target: { x: number; y: number; z: number };
  radius: number;
  signal: AbortSignal;
  lease: Lease;
  digTool: () => Promise<void>;
}): Promise<RustPathStats> {
  const { bot, target, radius, signal, lease, digTool } = options;
  const adapter = loadAdapter();
  const began = Date.now();
  let recomputes = 0;
  const statsHolder: { current: RustPathStats | null } = { current: null };

  const plan = async (): Promise<{ path: Array<{ x: number; y: number; z: number }>; origin: { x: number; y: number; z: number } }> => {
    const start = bot.entity.position;
    const minX = Math.floor(Math.min(start.x, target.x)) - VOLUME_MARGIN;
    const minZ = Math.floor(Math.min(start.z, target.z)) - VOLUME_MARGIN;
    const sx = Math.abs(Math.ceil(Math.max(start.x, target.x)) - minX) + VOLUME_MARGIN + 1;
    const sz = Math.abs(Math.ceil(Math.max(start.z, target.z)) - minZ) + VOLUME_MARGIN + 1;
    const minY = Math.max(-64, Math.floor(Math.min(start.y, target.y)) - 8);
    const sy = Math.min(VOLUME_HEIGHT, 320 - minY);
    const origin = { x: minX, y: minY, z: minZ };
    const t0 = Date.now();
    const { classes } = classifyVolume(bot, origin, sx, sy, sz);
    const classifyMs = Date.now() - t0;
    const t1 = Date.now();
    const result = await adapter.findPathAsync({
      world: { sx, sy, sz, classes },
      start: {
        x: Math.floor(start.x) - origin.x,
        y: Math.floor(start.y) - origin.y,
        z: Math.floor(start.z) - origin.z,
      },
      goal: {
        x: Math.floor(target.x) - origin.x,
        y: Math.floor(target.y) - origin.y,
        z: Math.floor(target.z) - origin.z,
      },
      options: {
        timeoutMs: 3000,
        goalKind: "near",
        goalRadius: Math.max(1, Math.round(radius)),
      },
    });
    const findMs = Date.now() - t1;
    statsHolder.current = {
      classifyMs, findMs, followMs: 0,
      volume: { sx, sy, sz },
      pathLen: result.path.length,
      success: result.success,
      recomputes,
    };
    if (!result.success && result.path.length <= 1) {
      throw new SkillFault("RUST_PATH_NOT_FOUND");
    }
    return {
      path: result.path.map((p) => ({
        x: p.x + origin.x,
        y: p.y + origin.y,
        z: p.z + origin.z,
      })),
      origin,
    };
  };

  const waitTick = () =>
    typeof bot.waitForTicks === "function"
      ? bot.waitForTicks(Math.max(1, Math.round(FOLLOW_TICK_MS / 50)))
      : new Promise<void>((resolve) => setTimeout(resolve, FOLLOW_TICK_MS));

  const horizontalDistance = (a: { x: number; z: number }, b: { x: number; z: number }) =>
    Math.hypot(a.x - b.x, a.z - b.z);

  let { path } = await plan();
  const followStart = Date.now();
  let waypointIndex = 1; // 跳过起点
  let lastProgressAt = Date.now();
  let lastProgress = bot.entity.position.clone();

  while (waypointIndex < path.length) {
    if (signal.aborted || lease.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    lease.assertCurrent();
    const pos = bot.entity.position;
    const wp = path[waypointIndex]!;
    const prev = path[waypointIndex - 1]!;

    // 到达当前路点 → 前进
    if (horizontalDistance(pos, wp) < 0.8 && Math.abs(pos.y - wp.y) < 1.6) {
      waypointIndex += 1;
      lastProgressAt = Date.now();
      continue;
    }

    // 卡住检测：位置长期无进展 → 有界重算
    if (pos.distanceTo(lastProgress) > 0.5) {
      lastProgress = pos.clone();
      lastProgressAt = Date.now();
    } else if (Date.now() - lastProgressAt > FOLLOW_STUCK_MS) {
      if (recomputes >= FOLLOW_MAX_RECOMPUTES) {
        throw new SkillFault("RUST_PATH_STUCK");
      }
      recomputes += 1;
      const replanned = await plan();
      path = replanned.path;
      waypointIndex = 1;
      lastProgressAt = Date.now();
      continue;
    }

    // 挖穿执行：目标格脚/头实心（引擎计划挖的格）→ 先挖再进
    const feetBlock = bot.blockAt(newLocalVec3(wp.x, wp.y, wp.z));
    if (feetBlock && String(feetBlock.boundingBox) !== "empty") {
      await digTool();
      try {
        await bot.dig(feetBlock);
      } catch {
        throw new SkillFault("RUST_PATH_DIG_FAILED");
      }
      continue;
    }
    const headBlock = bot.blockAt(newLocalVec3(wp.x, wp.y + 1, wp.z));
    if (headBlock && String(headBlock.boundingBox) !== "empty") {
      await digTool();
      try {
        await bot.dig(headBlock);
      } catch {
        throw new SkillFault("RUST_PATH_DIG_FAILED");
      }
      continue;
    }

    // 移动驱动：跑酷段（水平位移>1）sprint 跳；上台阶跳；其余前进
    const isLeap = Math.abs(wp.x - prev.x) + Math.abs(wp.z - prev.z) > 1;
    const isJumpUp = wp.y > prev.y;
    try {
      await bot.look(Math.atan2(-(wp.x - pos.x), -(wp.z - pos.z)), 0, true);
    } catch { /* look 尽力而为 */ }
    bot.setControlState("forward", true);
    if (isLeap || isJumpUp) {
      bot.setControlState("jump", true);
      if (isLeap) bot.setControlState("sprint", true);
    }
    await waitTick();
    bot.clearControlStates();
  }

  // 终点核验：目标 radius 邻域
  const final = bot.entity.position;
  const arrived =
    Math.hypot(final.x - target.x, final.y - target.y, final.z - target.z) <=
    radius + 1.0;
  const stats = statsHolder.current;
  if (stats !== null) {
    stats.followMs = Date.now() - followStart;
    stats.recomputes = recomputes;
    stats.success = arrived;
  }
  if (!arrived) throw new SkillFault("RUST_PATH_ARRIVAL_MISMATCH");
  if (stats === null) throw new SkillFault("RUST_PATH_NO_STATS");
  return stats;
}

/**
 * Phase 4 shadow 模式（诊断门专用）：以 bot 为中心做一次真实分类+worker
 * 寻路（目标=附近 16 格），**不执行任何移动**。测量主线程分类成本与
 * worker 往返；结果丢弃。仅供 perf-ab gate 的 shadow_rust 模式调用。
 */
export async function rustShadowPlan(bot: Bot): Promise<void> {
  const adapter = loadAdapter();
  const start = bot.entity.position;
  const sx = 33, sy = 16, sz = 33;
  const origin = {
    x: Math.floor(start.x) - 16,
    y: Math.max(-64, Math.floor(start.y) - 8),
    z: Math.floor(start.z) - 16,
  };
  const t0 = Date.now();
  const { classes } = classifyVolume(bot, origin, sx, sy, sz);
  const classifyMs = Date.now() - t0;
  await adapter.findPathAsync({
    world: { sx, sy, sz, classes },
    start: { x: 16, y: 8, z: 16 },
    goal: { x: 24, y: 8, z: 24 },
    options: { timeoutMs: 1000 },
  });
  void classifyMs;
}

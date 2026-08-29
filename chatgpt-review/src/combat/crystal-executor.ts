// ---------------------------------------------------------------------------
// CrystalExecutor —— 末影水晶的放置与引爆执行层（干净室实现）。
//
// 设计来源（思想学习，无代码复制）：
//   - AstraPlus AutoCrystal：候选评分 + 自伤红线 + 同步速爆（放置后
//     在 EntitySpawned 事件里立刻引爆）
//   - 本项目 CrystalEngine 的评分接口（position/hasValidBase/occlusion）
//
// 职责边界：本文件只做"哪些位置可以放/哪些水晶可以爆 + 怎么放/怎么爆"，
// 评分与决策仍在 CrystalEngine（由 CombatDriver 调用）。
// ---------------------------------------------------------------------------

import type { CombatCrystalCandidate } from "./crystal-engine.js";

/** combat 包不依赖 mineflayer：结构化视图（与 critical-engine 同模式）。 */
type Vec3Like = {
  x: number;
  y: number;
  z: number;
  offset: (dx: number, dy: number, dz: number) => Vec3Like;
  distanceTo: (other: Vec3Like) => number;
  plus: (other: Vec3Like) => Vec3Like;
  minus: (other: Vec3Like) => Vec3Like;
  scaled: (t: number) => Vec3Like;
};

type BotBlockView = {
  blockAt: (pos: Vec3Like) => { name: string; boundingBox: string } | null;
  entities?: Readonly<Record<string, { position?: Vec3Like; name?: string }>>;
  entity?: { position?: Vec3Like } | null;
  inventory?: { items: () => readonly Readonly<{ name: string; type: unknown }>[] };
  equip?: (item: unknown, dest: string) => Promise<void>;
  lookAt?: (pos: Vec3Like, force?: boolean) => Promise<void>;
  attack?: (entity: unknown) => Promise<void>;
};

class V implements Vec3Like {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {}
  offset(dx: number, dy: number, dz: number): Vec3Like {
    return new V(this.x + dx, this.y + dy, this.z + dz);
  }
  distanceTo(o: Vec3Like): number {
    return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z);
  }
  plus(o: Vec3Like): Vec3Like {
    return new V(this.x + o.x, this.y + o.y, this.z + o.z);
  }
  minus(o: Vec3Like): Vec3Like {
    return new V(this.x - o.x, this.y - o.y, this.z - o.z);
  }
  scaled(t: number): Vec3Like {
    return new V(this.x * t, this.y * t, this.z * t);
  }
}

/** 合法水晶承载方块。 */
const VALID_BASES = new Set(["obsidian", "bedrock"]);

/** 水晶实体名（1.13+）。 */
const END_CRYSTAL_NAMES = new Set(["end_crystal", "ender_crystal", "EndCrystal"]);

/** 候选枚举半径（围绕目标）。 */
export const CRYSTAL_SEARCH_RADIUS = 6;

/** 引爆时的最大水晶搜索半径。 */
export const DETONATE_RADIUS = 16;

/**
 * 枚举目标周围可放水晶的候选位置（黑曜石/基岩承载 + 上方两格无阻挡）。
 * 这是 crystalCandidates 死信号的真实现——之前的 null 让整个
 * CrystalEngine 的评分永远不被触发。
 */
export function enumerateCrystalCandidates(
  bot: BotBlockView,
  targetPosition: Vec3Like,
  radius = CRYSTAL_SEARCH_RADIUS,
): CombatCrystalCandidate[] {
  const candidates: CombatCrystalCandidate[] = [];
  const floor = (v: number) => Math.floor(v);
  const tx = floor(targetPosition.x);
  const ty = floor(targetPosition.y);
  const tz = floor(targetPosition.z);
  for (let dx = -radius; dx <= radius; dx += 1) {
    for (let dy = -3; dy <= 3; dy += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        const basePos = new V(tx + dx, ty + dy, tz + dz);
        let baseBlock: { name: string; boundingBox: string } | null = null;
        try {
          const block = bot.blockAt(basePos);
          baseBlock = block ? { name: block.name, boundingBox: block.boundingBox } : null;
        } catch {
          continue;
        }
        if (!baseBlock || !VALID_BASES.has(baseBlock.name)) continue;

        // 水晶占 base+1 和 base+2 两格：都要无碰撞。
        let spaceObstructed = false;
        for (const dyOffset of [1, 2]) {
          try {
            const occupant = bot.blockAt(basePos.offset(0, dyOffset, 0));
            if (occupant && occupant.boundingBox !== "empty") {
              spaceObstructed = true;
              break;
            }
          } catch {
            spaceObstructed = true;
            break;
          }
        }
        if (spaceObstructed) continue;

        // 实体阻挡检查（其他玩家/水晶本身占位）。
        const entityBlocking = Object.values(bot.entities ?? {}).some((entity) => {
          const pos = (entity as { position?: Vec3Like }).position;
          if (!pos) return false;
          return (
            Math.abs(pos.x - (basePos.x + 0.5)) < 0.9 &&
            Math.abs(pos.y - (basePos.y + 1)) < 1.8 &&
            Math.abs(pos.z - (basePos.z + 0.5)) < 0.9
          );
        });
        if (entityBlocking) continue;

        const self = bot.entity?.position;
        const selfOcclusion = self ? occlusion(bot, basePos.offset(0, 1, 0), self) : 0;
        candidates.push({
          position: { x: basePos.x + 0.5, y: basePos.y + 1, z: basePos.z + 0.5 },
          hasValidBase: true,
          spaceObstructed: false,
          targetOcclusion: occlusion(bot, basePos.offset(0, 1, 0), targetPosition),
          selfOcclusion,
        });
      }
    }
  }
  return candidates.slice(0, 32); // 评分引擎有上限
}

/** 粗遮挡估计：有实心方块挡住即 1，否则 0（体素 raycast 的简化版）。 */
function occlusion(
  bot: BotBlockView,
  from: Vec3Like,
  to: Vec3Like,
): number {
  const steps = Math.ceil(from.distanceTo(to) * 2);
  for (let i = 1; i < steps; i += 1) {
    const t = i / steps;
    const point = from.plus(to.minus(from).scaled(t));
    try {
      const block = bot.blockAt(new V(Math.floor(point.x), Math.floor(point.y), Math.floor(point.z)));
      if (block && block.boundingBox === "solid") return 1;
    } catch {
      // 区块未加载按无遮挡处理（评分端已有保守约束兜底）。
    }
  }
  return 0;
}

/**
 * 放置一枚末影水晶在指定候选位置（对着承载方块 use）。
 * 返回 true 表示放置包已发（是否被服务器接受由后续实体观测确认）。
 */
export async function placeCrystal(
  bot: BotBlockView,
  position: { x: number; y: number; z: number },
): Promise<boolean> {
  const base = new V(Math.floor(position.x), Math.floor(position.y) - 1, Math.floor(position.z));
  const block = bot.blockAt(base);
  if (!block || !VALID_BASES.has(block.name)) return false;
  // 必须手持水晶。
  const crystal = bot.inventory?.items().find((item) => item.name === "end_crystal");
  if (!crystal) return false;
  const equip = bot.equip;
  const lookAt = bot.lookAt;
  if (equip) await equip(crystal.type, "hand");
  // 先看向放置点（服务器验证视线）再右键承载方块。
  if (lookAt) await lookAt(base.offset(0.5, 1.0, 0.5), true);
  // 水晶放置走 block 交互（use on block）。mineflayer 的 activateItem
  // 只对 use-on-air 生效；对方块放置由 placeBlock 走 use-item-on-block 路径。
  // 但水晶不是"放方块"而是"放置实体"——mineflayer 的 placeEntity 不存在，
  // 唯一可靠路径是 activateItem while looking at the base。
  const activate = (bot as { activateItem?: () => void }).activateItem;
  if (activate) activate();
  return true;
}

/**
 * 引爆范围内全部己方/敌方水晶（打碎即爆）。
 * 返回引爆数量。
 */
export async function detonateCrystals(bot: BotBlockView): Promise<number> {
  const self = bot.entity?.position;
  if (!self) return 0;
  let count = 0;
  for (const entity of Object.values(bot.entities ?? {})) {
    const name = (entity as { name?: string }).name ?? "";
    if (!END_CRYSTAL_NAMES.has(name)) continue;
    const pos = (entity as { position?: Vec3Like }).position;
    if (!pos) continue;
    if (pos.distanceTo(self) > DETONATE_RADIUS) continue;
    try {
      const attack = bot.attack;
      if (attack) await attack.call(bot, entity as never);
      count += 1;
    } catch {
      // 单个失败不阻断后续引爆。
    }
  }
  return count;
}

/**
 * Anchor burst 预放置时机（AstraPlus AutoAnchor.java:915-926 思想重写）：
 *   prePlace = clamp(0.85 − ping×0.0002 − (1−breakTime/1000)×0.05, 0.6, 0.95)
 *   fire when progress ≥ prePlace && remainingMs ≤ ping×0.6+20
 */
export function anchorBurstTiming(
  pingMs: number,
  breakTimeMs: number,
  progress01: number,
): { shouldPrePlace: boolean; prePlaceThreshold: number } {
  const prePlace = Math.max(
    0.6,
    Math.min(0.95, 0.85 - pingMs * 0.0002 - (1 - breakTimeMs / 1000) * 0.05),
  );
  const remainingMs = breakTimeMs * (1 - progress01);
  const fireWindow = Math.max(0, Math.min(300, pingMs * 0.6 + 20));
  return {
    shouldPrePlace: progress01 >= prePlace && remainingMs <= fireWindow,
    prePlaceThreshold: prePlace,
  };
}

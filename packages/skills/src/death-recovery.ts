// ---------------------------------------------------------------------------
// death-recovery.ts —— 死亡恢复最小垂直切片：掉落物价值判断 + 连续死亡惩罚。
//
// 1. dropRecoveryValue: 判断是否值得去取死亡掉落物
// 2. DeathStreakTracker: 连续死亡时递增惩罚，到达阈值停止送装备
// 3. buildRecoveryGoal: 生成确定性 recovery goal 文本（走 movement.goto）
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---------------------------------------------------------------------------
// 掉落物价值评估
// ---------------------------------------------------------------------------

export const dropItemValueSchema = z
  .object({
    itemId: z.string().regex(/^[a-z0-9_]+$/u).max(64),
    count: z.number().int().min(0).max(2304),
  })
  .strict();
export type DropItemValue = z.infer<typeof dropItemValueSchema>;

/** 高价值物品（战斗/进度关键）。 */
const HIGH_VALUE_ITEMS: ReadonlySet<string> = new Set([
  "netherite_ingot", "netherite_scrap", "ancient_debris",
  "diamond", "diamond_sword", "diamond_pickaxe", "diamond_axe",
  "diamond_helmet", "diamond_chestplate", "diamond_leggings", "diamond_boots",
  "netherite_sword", "netherite_pickaxe", "netherite_axe",
  "netherite_helmet", "netherite_chestplate", "netherite_leggings", "netherite_boots",
  "elytra", "totem_of_undying", "nether_star", "beacon",
  "enchanted_golden_apple", "golden_apple",
  "ender_pearl", "blaze_rod", "nether_wart",
]);

/** 中等价值物品（生产材料）。 */
const MEDIUM_VALUE_ITEMS: ReadonlySet<string> = new Set([
  "iron_ingot", "gold_ingot", "copper_ingot",
  "redstone", "lapis_lazuli", "gunpowder", "glowstone_dust",
  "obsidian", "crying_obsidian", "ender_eye",
  "bow", "crossbow", "shield", "fishing_rod",
  "iron_sword", "iron_pickaxe", "iron_axe",
  "iron_helmet", "iron_chestplate", "iron_leggings", "iron_boots",
]);

/** 低价值（大宗可再生）。 */
const LOW_VALUE_ITEMS: ReadonlySet<string> = new Set([
  "cobblestone", "stone", "dirt", "oak_log", "oak_planks", "sand", "gravel",
  "wheat", "carrot", "potato", "apple", "bread",
  "coal", "charcoal", "stick", "string", "feather", "leather",
]);

function itemUnitValue(itemId: string): number {
  if (HIGH_VALUE_ITEMS.has(itemId)) return 100;
  if (MEDIUM_VALUE_ITEMS.has(itemId)) return 10;
  if (LOW_VALUE_ITEMS.has(itemId)) return 1;
  return 5; // 未分类默认中等
}

export interface DropRecoveryAssessment {
  shouldRecover: boolean;
  reason: string;
  totalValue: number;
  estimatedRisk: "low" | "medium" | "high";
  deathAgeMs: number;
}

/**
 * 评估是否值得取回死亡掉落物。
 * 因素：掉落物总价值、距离、经过时间、连续死亡次数、Bot 当前状态。
 */
export function assessDropRecovery(input: {
  drops: readonly DropItemValue[];
  /** 死亡发生时间（epoch ms）。 */
  diedAtMs: number;
  nowMs: number;
  /** 死亡点到 Bot 当前位置的距离（格）。 */
  distanceBlocks: number;
  /** 连续死亡次数（含本次）。 */
  deathStreak: number;
  /** 同维度（跨维度不可直接走）。 */
  sameDimension: boolean;
  /** 掉落物消失窗口（默认 5 分钟 = 300_000ms）。 */
  despawnWindowMs?: number;
}): DropRecoveryAssessment {
  const totalValue = input.drops.reduce((sum, drop) => sum + itemUnitValue(drop.itemId) * drop.count, 0);
  const deathAgeMs = input.nowMs - input.diedAtMs;
  const despawnWindow = input.despawnWindowMs ?? 300_000;
  const remainingMs = despawnWindow - deathAgeMs;

  // 不可恢复的情况
  if (!input.sameDimension) {
    return { shouldRecover: false, reason: "cross-dimension drop unreachable", totalValue, estimatedRisk: "high", deathAgeMs };
  }
  if (remainingMs <= 0) {
    return { shouldRecover: false, reason: "despawn window expired", totalValue, estimatedRisk: "low", deathAgeMs };
  }

  // 连续死亡惩罚
  if (input.deathStreak >= 3) {
    return {
      shouldRecover: false,
      reason: `death streak ${input.deathStreak} — stop sending gear to recover gear`,
      totalValue, estimatedRisk: "high", deathAgeMs,
    };
  }
  if (input.deathStreak === 2 && totalValue < 500) {
    return {
      shouldRecover: false,
      reason: `death streak 2 + low value (${totalValue}) — not worth another death`,
      totalValue, estimatedRisk: "high", deathAgeMs,
    };
  }

  // 价值/风险比
  const travelTimeEstimateMs = input.distanceBlocks * 100; // ~100ms per block walk
  const riskOfDeathOnWay = input.distanceBlocks > 200 ? "high" : input.distanceBlocks > 50 ? "medium" : "low";

  if (totalValue < 20 && input.distanceBlocks > 30) {
    return { shouldRecover: false, reason: `low value (${totalValue}) far away (${input.distanceBlocks} blocks)`, totalValue, estimatedRisk: riskOfDeathOnWay, deathAgeMs };
  }
  if (travelTimeEstimateMs > remainingMs * 0.7) {
    return { shouldRecover: false, reason: "cannot reach before despawn", totalValue, estimatedRisk: riskOfDeathOnWay, deathAgeMs };
  }
  if (riskOfDeathOnWay === "high" && totalValue < 200 && input.deathStreak >= 1) {
    return { shouldRecover: false, reason: "high risk + low value + prior death", totalValue, estimatedRisk: "high", deathAgeMs };
  }

  return { shouldRecover: true, reason: `value=${totalValue}, distance=${input.distanceBlocks}, remaining=${Math.floor(remainingMs / 1000)}s`, totalValue, estimatedRisk: riskOfDeathOnWay, deathAgeMs };
}

// ---------------------------------------------------------------------------
// 连续死亡追踪
// ---------------------------------------------------------------------------

export interface DeathStreakTrackerOptions {
  /** streak 重置窗口（默认 5 分钟）。 */
  resetWindowMs?: number;
  now?: () => number;
}

const DEFAULT_RESET_WINDOW = 300_000;

export class DeathStreakTracker {
  private deaths: number[] = [];
  private readonly resetWindowMs: number;
  private readonly now: () => number;

  constructor(options: DeathStreakTrackerOptions = {}) {
    this.resetWindowMs = options.resetWindowMs ?? DEFAULT_RESET_WINDOW;
    this.now = options.now ?? (() => Date.now());
  }

  /** 记录一次死亡，返回当前 streak。 */
  recordDeath(): number {
    const nowMs = this.now();
    // 清除窗口外的旧死亡
    this.deaths = this.deaths.filter((at) => nowMs - at < this.resetWindowMs);
    this.deaths.push(nowMs);
    return this.deaths.length;
  }

  /** 获取当前 streak（不新增）。 */
  get streak(): number {
    const nowMs = this.now();
    this.deaths = this.deaths.filter((at) => nowMs - at < this.resetWindowMs);
    return this.deaths.length;
  }

  /** 重置（成功存活一段时间后调用）。 */
  reset(): void {
    this.deaths = [];
  }
}

// ---------------------------------------------------------------------------
// 确定性 recovery goal 生成
// ---------------------------------------------------------------------------

/** 生成走 movement.goto 的 recovery goal 文本（确定性模板）。 */
export function buildDropRecoveryGoal(input: {
  deathX: number;
  deathY: number;
  deathZ: number;
}): string {
  return `移动到坐标 x=${input.deathX} y=${input.deathY} z=${input.deathZ} 附近，回收死亡掉落物`;
}

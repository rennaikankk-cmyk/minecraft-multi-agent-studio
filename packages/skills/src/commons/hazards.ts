// ---------------------------------------------------------------------------
// Minecraft 常识：危险面（虚空 / 岩浆 / 坠落 / 睡觉 / 流体）。
//
// 这一层的定位：**纯知识**。没有任何 I/O、时钟、随机数，也不碰 bot 状态——
// 所有事实由调用方作为 INPUT 传进来（运行时的 state 里既没有方块数据，也没有
// 血量/饥饿/时间，见 packages/skills/src/commons 的契约说明）。
//
// 每一条规则都带出处注释，便于人工复核数值；改动数值必须同时改注释，
// 否则这里就退化成"看起来像常识的猜测"。
// ---------------------------------------------------------------------------

import { z } from "zod";

/** 判定结果码。稳定：只增不改，测试与上层规划器按字符串比较。 */
export const hazardCodes = [
  "VOID_FLOOR",
  "DEEP_DANGER_ZONE",
  "LAVA_SEA",
  "BEDROCK_CEILING",
  "DIG_STRAIGHT_DOWN",
  "HOLLOW_OVERHEAD",
  "FALL_DAMAGE",
  "FALL_BEYOND_POLICY",
  "DIG_INTO_LAVA",
  "DIG_INTO_WATER",
  "LAVA_ADJACENT",
  "WATER_ADJACENT",
  "VOID_RISK",
  "BED_EXPLODES",
  "SAFE",
] as const;

export const hazardCodeSchema = z.enum(hazardCodes);
export type HazardCode = (typeof hazardCodes)[number];

export interface DimensionHazardProfile {
  /** 该维度标识（Minecraft 命名空间 id）。 */
  readonly dimension: string;
  /** 中文名，仅用于报告文本。 */
  readonly label: string;
  /**
   * 规划地板：常规作业不应越过的高度。
   * 跨过它不是立刻致命，而是"再往下就是无人区/岩浆湖"，规划器应当停止下挖。
   */
  readonly planningFloor: number;
  /**
   * 硬地板：越过即进入虚空伤害/掉出世界。1.18+ 主世界世界下界为 y=-64
   * （基岩层 y=-64..-60）；下界为 y=0（基岩层 y=0..4，y=0 是虚空平面）；
   * 末地主岛基座在 y≈58，岛外即虚空。
   */
  readonly hardFloor: number;
  /** 岩浆海静水面高度；无岩浆海时为 null。 */
  readonly lavaSeaLevel: number | null;
  /** 是否存在不可穿透的基岩天花板（下界顶 y=127）。 */
  readonly bedrockCeiling: boolean;
  /** 床是否会在该维度爆炸（下界/末地为 true）。 */
  readonly bedExplodes: boolean;
}

/**
 * 逐维度危险面。数值出处：
 *   - 主世界：1.18+ 世界下界 y=-64，基岩层 y=-64..-60；y=0 以下为深板岩层，
 *     熔岩湖与巨型洞穴密集（y≈-54 是熔岩湖常见水面），所以规划地板取 -48。
 *   - 下界：熔岩海静水面 y=31（源头方块在 y=32 或 31，水面在 31），
 *     基岩地板 y=0..4，y=0 之下即虚空；顶部基岩顶 y=127。
 *   - 末地：y=0 以下是虚空，主岛基座 y≈58；末地高地/外岛之外全是虚空。
 */
export const dimensionHazardProfiles: readonly DimensionHazardProfile[] = Object.freeze([
  {
    dimension: "minecraft:overworld",
    label: "主世界",
    planningFloor: -48,
    hardFloor: -64,
    lavaSeaLevel: null,
    bedrockCeiling: false,
    bedExplodes: false,
  },
  {
    dimension: "minecraft:the_nether",
    label: "下界",
    planningFloor: 32,
    hardFloor: 0,
    lavaSeaLevel: 31,
    bedrockCeiling: true,
    bedExplodes: true,
  },
  {
    dimension: "minecraft:the_end",
    label: "末地",
    planningFloor: 0,
    hardFloor: 0,
    lavaSeaLevel: null,
    bedrockCeiling: false,
    bedExplodes: true,
  },
]);

/** 兜底档：维度未知时按最保守解释（AGENTS.md §2 fail-closed，不从缺失数据推出有利结论）。 */
export const unknownDimensionHazardProfile: DimensionHazardProfile = Object.freeze({
  dimension: "unknown",
  label: "未知维度",
  planningFloor: 0,
  hardFloor: 0,
  lavaSeaLevel: null,
  bedrockCeiling: true,
  bedExplodes: true,
});

/** 按维度 id 取危险面；未知维度返回最保守档而不是抛错。 */
export function hazardProfileFor(dimension: string): DimensionHazardProfile {
  return (
    dimensionHazardProfiles.find((profile) => profile.dimension === dimension) ??
    unknownDimensionHazardProfile
  );
}

/**
 * 原版坠落伤害阈值：下落 > 3 格才扣血，伤害 = 下落格数 - 3。
 * 所以 3 格是**安全上限**（等于 3 不掉血），4 格起每多一格多 1 点伤害。
 */
export const SAFE_FALL_BLOCKS = 3;

/** 2 格：SAFE 移动档位在策略上进一步收紧后的默认落差（见 planning/movement-profile.ts）。 */
export const CAUTIOUS_FALL_BLOCKS = 2;

/** 下落 `blocks` 格造成的伤害点数（0 表示不掉血）。负数/非整数按 0 处理，不猜。 */
export function fallDamagePoints(blocks: number): number {
  if (!Number.isFinite(blocks) || blocks <= SAFE_FALL_BLOCKS) return 0;
  return Math.floor(blocks) - SAFE_FALL_BLOCKS;
}

export type FallVerdict =
  | { readonly allowed: true; readonly code: "SAFE"; readonly damagePoints: 0 }
  | {
      readonly allowed: false;
      readonly code: "FALL_DAMAGE" | "FALL_BEYOND_POLICY";
      readonly damagePoints: number;
    };

/**
 * 下落裁决。两个上限**都要**满足：
 *   - 原版机制上限 `SAFE_FALL_BLOCKS`（3 格，4 格起扣血）
 *   - 服务器策略上限 `maxFallBlocks`（来自 state.policyLimits，未知时调用方传保守值）
 * 取两者更小者。策略更严格时报 FALL_BEYOND_POLICY，机制本身就超了报 FALL_DAMAGE。
 */
export function assessFall(blocks: number, maxFallBlocks: number): FallVerdict {
  const damagePoints = fallDamagePoints(blocks);
  if (damagePoints > 0) {
    return { allowed: false, code: "FALL_DAMAGE", damagePoints };
  }
  if (Number.isFinite(blocks) && blocks > maxFallBlocks) {
    return { allowed: false, code: "FALL_BEYOND_POLICY", damagePoints: 0 };
  }
  return { allowed: true, code: "SAFE", damagePoints: 0 };
}

/**
 * 竖直深挖裁决（"不要垂直下挖"）。
 *
 * 依据：垂直下挖看不到落点——落点可能是洞穴、岩浆湖或深坑，掉进去基本无救；
 * 社区通用挖矿纪律是"挖两格宽、留台阶"或"阶梯式下挖"。
 * 该码与高度无关：只要动作是"朝正下方破坏方块"就给，深度另有 assessDepth 负责。
 */
export function assessStraightDown(): readonly HazardCode[] {
  return Object.freeze(["DIG_STRAIGHT_DOWN"] as HazardCode[]);
}

/**
 * 高度裁决：把 y 与该维度的规划地板/硬地板/岩浆海比较。
 *
 * 返回顺序即严重程度（虚空 > 深处 > 岩浆海 > 基岩顶），稳定可断言。
 */
export function assessDepth(y: number, dimension: string): readonly HazardCode[] {
  if (!Number.isFinite(y)) return Object.freeze(["DEEP_DANGER_ZONE"] as HazardCode[]);
  const profile = hazardProfileFor(dimension);
  const codes: HazardCode[] = [];
  if (y <= profile.hardFloor) codes.push("VOID_FLOOR");
  if (profile.lavaSeaLevel !== null && y > profile.hardFloor && y <= profile.lavaSeaLevel) {
    codes.push("LAVA_SEA");
  }
  if (y <= profile.planningFloor && !codes.includes("VOID_FLOOR")) {
    codes.push("DEEP_DANGER_ZONE");
  }
  if (profile.bedrockCeiling && y >= 127) codes.push("BEDROCK_CEILING");
  return Object.freeze(codes);
}

/**
 * 头顶掏空裁决（"不要掏头顶的方块"）。
 *
 * 依据：破坏头顶方块等同于把自己暴露给——重力方块（沙/沙砾）砸落、
 * 上方的水/岩浆顺洞灌入、以及失去掩体后垂直掉落。所以任何"向上破块"的动作
 * 都必须先确认上方没有流体与重力方块。
 */
export function assessOverhead(overhead: {
  readonly breaking: boolean;
  readonly fluidAbove?: boolean | undefined;
  readonly gravityBlockAbove?: boolean | undefined;
}): readonly HazardCode[] {
  if (!overhead.breaking) return Object.freeze([] as HazardCode[]);
  const codes: HazardCode[] = ["HOLLOW_OVERHEAD"];
  if (overhead.fluidAbove === true) codes.push("DIG_INTO_LAVA");
  if (overhead.gravityBlockAbove === true) codes.push("FALL_DAMAGE");
  return Object.freeze(codes);
}

/**
 * 目标方块相邻格裁决。挖掉一块贴着岩浆/水的方块，流体立刻灌进新空位，
 * 这是"挖到岩浆"最常见的真实成因（不是挖穿了岩浆本身）。
 *
 * 依据：水+岩浆相遇——水源挨着岩浆源生成黑曜石；流动水遇到岩浆源生成圆石；
 * 岩浆流进水里生成石头/圆石并可能把水变成石头；无论哪种，身处其中的 bot 都会
 * 受伤或被卡住。所以两个相邻标志都当拒绝级信号。
 */
export function assessAdjacentFluids(adjacent: {
  readonly lavaAdjacent: boolean;
  readonly waterAdjacent: boolean;
}): readonly HazardCode[] {
  const codes: HazardCode[] = [];
  if (adjacent.lavaAdjacent) codes.push("LAVA_ADJACENT", "DIG_INTO_LAVA");
  if (adjacent.waterAdjacent) codes.push("DIG_INTO_WATER", "WATER_ADJACENT");
  return Object.freeze(codes);
}

/**
 * 安全视图里的危险位（state.safety）。
 *
 * 注意 `waterAdjacent` 单独存在时**不是**致命信号（水里最多是溺水/流速冲走），
 * 所以只把它转成提醒码，不单独拒绝；`voidRisk` 来自运行时观测，照抄不放大。
 */
export function assessSafetyFlags(safety: {
  readonly lavaAdjacent: boolean;
  readonly waterAdjacent: boolean;
  readonly voidRisk: boolean;
}): readonly HazardCode[] {
  const codes: HazardCode[] = [];
  if (safety.lavaAdjacent) codes.push("LAVA_ADJACENT");
  if (safety.waterAdjacent) codes.push("WATER_ADJACENT");
  if (safety.voidRisk) codes.push("VOID_RISK");
  return Object.freeze(codes);
}

/**
 * 床裁决。**下界与末地不能睡觉**：床在这两个维度使用时会爆炸并引燃周围方块，
 * 原版设计如此（这是去下界炸床/找远古残骸的常规手段），对 bot 而言等于自杀。
 * 主世界里床是安全的（并把重生点设到床边）。
 */
export function assessBedUse(dimension: string): {
  readonly allowed: boolean;
  readonly codes: readonly HazardCode[];
  readonly dimensions: readonly string[];
} {
  const profile = hazardProfileFor(dimension);
  if (profile.bedExplodes) {
    return Object.freeze({
      allowed: false,
      codes: Object.freeze(["BED_EXPLODES"] as HazardCode[]),
      dimensions: Object.freeze(
        dimensionHazardProfiles.filter((entry) => entry.bedExplodes).map((entry) => entry.dimension),
      ),
    });
  }
  return Object.freeze({
    allowed: true,
    codes: Object.freeze([] as HazardCode[]),
    dimensions: Object.freeze([] as string[]),
  });
}

/** 会被判定为拒绝级的最危险码。其余码是提醒。 */
export const refusalHazardCodes: readonly HazardCode[] = Object.freeze([
  "VOID_FLOOR",
  "LAVA_SEA",
  "DIG_STRAIGHT_DOWN",
  "FALL_DAMAGE",
  "FALL_BEYOND_POLICY",
  "DIG_INTO_LAVA",
  "LAVA_ADJACENT",
  "VOID_RISK",
  "BED_EXPLODES",
] as HazardCode[]);

/** 该码是否属于"必须停下"级别。 */
export function isRefusalHazard(code: HazardCode): boolean {
  return refusalHazardCodes.includes(code);
}

/**
 * 从一串码里取最严重的一个（用于 refusalCode，保证输出稳定：
 * 同一组码永远给出同一个代表码，取 refusalHazardCodes 里的顺序即优先级）。
 */
export function mostSevereVerdict(codes: readonly HazardCode[]): HazardCode {
  for (const candidate of refusalHazardCodes) {
    if (codes.includes(candidate)) return candidate;
  }
  return codes[0] ?? "SAFE";
}

// ---------------------------------------------------------------------------
// nether-travel.ts —— 地狱顶层赶路链（用户 2026-09-11 需求）。
//
// 四个新原子技能，支撑 anarchy 经典玩法：地狱门（1:8 距离比）顶层高速赶路。
//   travel.portal-ignite —— 打火石点燃已建好的黑曜石门框
//   travel.portal-use    —— 走入门内并等待维度切换完成
//   travel.ascend        —— 地狱内柱子搭法垂直上升到基岩层下
//   travel.bridge        —— 顶面/平地逐格搭路前进（sneak 防坠）
//
// 纪律（与 place-block/fluid-place 同源）：
//   1. 一步一验证：点燃读回 nether_portal、传送读回新维度、上升/搭路逐格
//      确认方块真在（服务器真值），不伪造成功。
//   2. 门框建造/材料获取不在此层：build.blueprint（门框 10 格）与
//      craft.item（flint_and_steel）已有；本层只补"点/穿/升/铺"四个原子。
//   3. 基岩阻塞是诚实终态（ASCEND_BEDROCK_BLOCKED），缺口搜索由上层编排
//      （在 bedrockBlocked 结果上换列重试），不在单技能里硬造。
// ---------------------------------------------------------------------------

import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { blockWithinPolicyReach } from "./reach.js";
import { defineSkill } from "../types.js";

export const NETHER_TRAVEL_TIMEOUT_MS = 20_000;
export const PORTAL_USE_TIMEOUT_MS = 30_000;
export const ASCEND_TIMEOUT_MS = 120_000;
export const BRIDGE_TIMEOUT_MS = 120_000;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);

const blockPositionSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2_048).max(2_048),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

const horizontalTargetSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();

const observedPositionSchema = z.object({
  x: z.number().finite().min(-30_000_000).max(30_000_000),
  y: z.number().finite().min(-2_048).max(2_048),
  z: z.number().finite().min(-30_000_000).max(30_000_000),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
  yaw: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
}).strict();

const netherTravelStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
}).strip();

// ---------------------------------------------------------------------------
// travel.portal-ignite
// ---------------------------------------------------------------------------

export const portalIgniteInputSchema = z.object({
  /** 门内空间最底格（点燃目标=其下方的门框底横档顶面）。 */
  interiorPosition: blockPositionSchema,
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const portalIgniteOutputSchema = z.object({
  ignited: z.literal(true),
  portalBlockName: z.literal("nether_portal"),
  position: blockPositionSchema,
}).strict();

export const portalIgniteSkill = defineSkill({
  id: "travel.portal-ignite",
  version: "1.0.0",
  progressContract: "PLACE_AND_VERIFY",
  inputSchema: portalIgniteInputSchema,
  outputSchema: portalIgniteOutputSchema,
  stateSchema: netherTravelStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: NETHER_TRAVEL_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 250, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.serverProfileId === s.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => s.position !== null && i.dimension === s.position.dimension },
    { id: "target.within-reach", failureCode: "TARGET_OUT_OF_REACH", check: (i, s, policy) => s.position !== null && blockWithinPolicyReach(i.interiorPosition, s.position, policy) },
  ],
  execute: async (context, input) =>
    context.callCapability("world.interact", "portal.ignite-safe", portalIgniteInputSchema.parse(input)),
});

// ---------------------------------------------------------------------------
// travel.portal-use
// ---------------------------------------------------------------------------

export const portalUseInputSchema = z.object({
  interiorPosition: blockPositionSchema,
  dimension: dimensionSchema,
  /** 预期到达维度（minecraft:the_nether / minecraft:overworld）。 */
  expectedDimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const portalUseOutputSchema = z.object({
  transported: z.literal(true),
  dimension: dimensionSchema,
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }).strict(),
}).strict();

export const portalUseSkill = defineSkill({
  id: "travel.portal-use",
  version: "1.0.0",
  progressContract: "MOVE_TO_TARGET",
  inputSchema: portalUseInputSchema,
  outputSchema: portalUseOutputSchema,
  stateSchema: netherTravelStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: PORTAL_USE_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 200, maxDelayMs: 1_000, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.serverProfileId === s.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => s.position !== null && i.dimension === s.position.dimension },
  ],
  execute: async (context, input) =>
    context.callCapability("bot.move", "portal.use-safe", portalUseInputSchema.parse(input)),
});

// ---------------------------------------------------------------------------
// travel.ascend —— 柱子搭法垂直上升（地狱顶层赶路的上升段）
// ---------------------------------------------------------------------------

export const ascendInputSchema = z.object({
  targetY: z.number().int().min(-2_048).max(2_048),
  itemName: itemNameSchema,
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const ascendOutputSchema = z.object({
  succeeded: z.literal(true),
  /** 到达高度；若基岩阻塞则如实报 bedrockBlocked，finalY 为当前所达。 */
  bedrockBlocked: z.boolean(),
  finalY: z.number().int(),
}).strict();

export const ascendSkill = defineSkill({
  id: "travel.ascend",
  version: "1.0.0",
  progressContract: "MOVE_TO_TARGET",
  inputSchema: ascendInputSchema,
  outputSchema: ascendOutputSchema,
  stateSchema: netherTravelStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: ASCEND_TIMEOUT_MS,
  // 上升中断可续（已放的柱子是事实进展），重试是安全的。
  idempotent: true,
  retryPolicy: { maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 1_500, retryableErrorCodes: ["ASCEND_TRANSIENT"] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.serverProfileId === s.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => s.position !== null && i.dimension === s.position.dimension },
    { id: "target.above-current", failureCode: "ASCEND_TARGET_BELOW", check: (i, s) => s.position !== null && i.targetY > Math.floor(s.position.y) },
  ],
  execute: async (context, input) =>
    context.callCapability("bot.move", "movement.pillar-safe", ascendInputSchema.parse(input)),
});

// ---------------------------------------------------------------------------
// travel.bridge —— 逐格搭路水平前进（顶面高速路铺设段）
// ---------------------------------------------------------------------------

export const bridgeInputSchema = z.object({
  target: horizontalTargetSchema,
  itemName: itemNameSchema,
  maxSteps: z.number().int().min(1).max(128),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();

export const bridgeOutputSchema = z.object({
  succeeded: z.literal(true),
  stepsPlaced: z.number().int().min(0).max(128),
  position: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  }).strict(),
}).strict();

export const bridgeSkill = defineSkill({
  id: "travel.bridge",
  version: "1.0.0",
  progressContract: "MOVE_TO_TARGET",
  inputSchema: bridgeInputSchema,
  outputSchema: bridgeOutputSchema,
  stateSchema: netherTravelStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: BRIDGE_TIMEOUT_MS,
  // 搭过的格子是事实进展；中断续走安全。
  idempotent: true,
  retryPolicy: { maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 1_500, retryableErrorCodes: ["BRIDGE_TRANSIENT"] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.serverProfileId === s.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => s.position !== null && i.dimension === s.position.dimension },
  ],
  execute: async (context, input) =>
    context.callCapability("bot.move", "movement.bridge-safe", bridgeInputSchema.parse(input)),
});

import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill, type SkillExecutionContext } from "../types.js";
import {
  containerTransferCapabilityInputSchema,
  containerTransferCapabilityOutputSchema,
  TRANSFER_MAX_COUNT,
} from "../builtin/container-transfer.js";
import { blockWithinPolicyReach } from "../builtin/reach.js";

/** Inventory thresholds are deterministic bookkeeping; AI may choose values,
 * but it never decides whether a count is low or at the ceiling. */
export const STORE_SORT_TIMEOUT_MS = 60_000;
export const PACK_SHULKER_TIMEOUT_MS = 60_000;
export const MAX_STORE_TRANSFERS = 64;

const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const positionSchema = z.object({
  x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2_048).max(2_048),
  z: z.number().int().min(-30_000_000).max(30_000_000),
}).strict();
const scopedPositionSchema = positionSchema.extend({ dimension: dimensionSchema, serverProfileId: identifierSchema }).strict();

export const stockLevelSchema = z.object({
  itemName: itemNameSchema,
  low: z.number().int().min(0).max(TRANSFER_MAX_COUNT * 16),
  target: z.number().int().min(0).max(TRANSFER_MAX_COUNT * 16),
  ceiling: z.number().int().min(0).max(TRANSFER_MAX_COUNT * 16),
}).strict().superRefine((level, context) => {
  if (!(level.low <= level.target && level.target <= level.ceiling)) {
    context.addIssue({ code: "custom", path: ["target"], message: "stock thresholds must satisfy low <= target <= ceiling" });
  }
});
export type StockLevel = z.infer<typeof stockLevelSchema>;

export const stockCountSchema = z.object({ itemName: itemNameSchema, count: z.number().int().min(0).max(TRANSFER_MAX_COUNT * 64) }).strict();
export type StockCount = z.infer<typeof stockCountSchema>;
export const stockStates = ["LOW", "TARGET", "BETWEEN", "CEILING", "OVER_CEILING"] as const;
export const stockStateSchema = z.enum(stockStates);
export type StockState = z.infer<typeof stockStateSchema>;
export const stockDecisionSchema = z.object({
  itemName: itemNameSchema,
  count: z.number().int().min(0),
  state: stockStateSchema,
  deficitToTarget: z.number().int().min(0),
  surplusOverCeiling: z.number().int().min(0),
  produce: z.boolean(),
  stopProduction: z.boolean(),
}).strict();
export type StockDecision = z.infer<typeof stockDecisionSchema>;

/** Food is deliberately absent from strategic stock management. */
export const unmanagedFoodItems = new Set([
  "apple", "bread", "carrot", "potato", "baked_potato", "beetroot",
  "cooked_beef", "cooked_chicken", "cooked_cod", "cooked_mutton", "cooked_porkchop",
  "cooked_rabbit", "cooked_salmon", "melon_slice", "sweet_berries",
]);

export function evaluateStockLevel(level: StockLevel, count: number): StockDecision {
  const safeCount = Number.isInteger(count) && count >= 0 ? count : 0;
  const state: StockState = safeCount < level.low
    ? "LOW"
    : safeCount === level.target
      ? "TARGET"
      : safeCount > level.ceiling
        ? "OVER_CEILING"
        : safeCount === level.ceiling
          ? "CEILING"
          : "BETWEEN";
  return stockDecisionSchema.parse({
    itemName: level.itemName,
    count: safeCount,
    state,
    deficitToTarget: Math.max(0, level.target - safeCount),
    surplusOverCeiling: Math.max(0, safeCount - level.ceiling),
    produce: safeCount < level.low,
    stopProduction: safeCount >= level.ceiling,
  });
}

export function evaluateStockLevels(levels: readonly StockLevel[], counts: readonly StockCount[]): readonly StockDecision[] {
  const byItem = new Map(counts.map((entry) => [entry.itemName, entry.count]));
  return Object.freeze(levels.filter((level) => !unmanagedFoodItems.has(level.itemName)).map((level) => evaluateStockLevel(level, byItem.get(level.itemName) ?? 0)));
}

export const stockLevelInputSchema = z.object({ levels: z.array(stockLevelSchema).max(256), counts: z.array(stockCountSchema).max(256) }).strict();
export const stockLevelOutputSchema = z.object({ decisions: z.array(stockDecisionSchema).max(256) }).strict();

const materialRouteSchema = z.object({
  itemName: itemNameSchema,
  count: z.number().int().min(1).max(TRANSFER_MAX_COUNT),
  container: positionSchema,
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
}).strict();
export type MaterialRoute = z.infer<typeof materialRouteSchema>;
export const storeSortInputSchema = z.object({
  routes: z.array(materialRouteSchema).min(1).max(MAX_STORE_TRANSFERS),
  startIndex: z.number().int().min(0).max(MAX_STORE_TRANSFERS),
  maxTransfers: z.number().int().min(1).max(MAX_STORE_TRANSFERS),
}).strict();
export type StoreSortInput = z.infer<typeof storeSortInputSchema>;

const observedPositionSchema = z.object({
  x: z.number().finite().min(-30_000_000).max(30_000_000),
  y: z.number().finite().min(-2_048).max(2_048),
  z: z.number().finite().min(-30_000_000).max(30_000_000),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
  // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
  yaw: z.number().finite().optional(),
  pitch: z.number().finite().optional(),
}).strict();
const storageStateSchema = z.object({
  online: z.boolean(),
  normalActionsAllowed: z.boolean(),
  serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
}).strip();
const transferReceiptSchema = z.object({
  itemName: itemNameSchema,
  requestedCount: z.number().int().min(1).max(TRANSFER_MAX_COUNT),
  movedCount: z.number().int().min(0).max(TRANSFER_MAX_COUNT),
  container: positionSchema,
}).strict();
export const storeSortOutputSchema = z.object({
  startIndex: z.number().int().min(0).max(MAX_STORE_TRANSFERS),
  nextIndex: z.number().int().min(0).max(MAX_STORE_TRANSFERS),
  totalRoutes: z.number().int().min(1).max(MAX_STORE_TRANSFERS),
  moved: z.array(transferReceiptSchema).max(MAX_STORE_TRANSFERS),
}).strict();

export const packShulkerInputSchema = z.object({
  shulker: positionSchema,
  items: z.array(z.object({ itemName: itemNameSchema, count: z.number().int().min(1).max(TRANSFER_MAX_COUNT) }).strict()).min(1).max(27),
  dimension: dimensionSchema,
  serverProfileId: identifierSchema,
  startIndex: z.number().int().min(0).max(27),
  maxTransfers: z.number().int().min(1).max(27),
}).strict();
export type PackShulkerInput = z.infer<typeof packShulkerInputSchema>;
export const packShulkerOutputSchema = z.object({
  startIndex: z.number().int().min(0).max(27),
  nextIndex: z.number().int().min(0).max(27),
  totalItems: z.number().int().min(1).max(27),
  packed: z.array(transferReceiptSchema).max(27),
  completed: z.boolean(),
}).strict();

export const storeSortCapabilityInputSchema = containerTransferCapabilityInputSchema;
export const storeSortCapabilityOutputSchema = containerTransferCapabilityOutputSchema;
export const packShulkerCapabilityInputSchema = containerTransferCapabilityInputSchema;
export const packShulkerCapabilityOutputSchema = containerTransferCapabilityOutputSchema;

function executeStatePreconditions(input: Readonly<{ serverProfileId: string; dimension: string }>, state: z.infer<typeof storageStateSchema>): void {
  if (!state.online) throw new SkillFault("BOT_NOT_ONLINE");
  if (!state.normalActionsAllowed) throw new SkillFault("NORMAL_ACTIONS_PAUSED");
  if (input.serverProfileId !== state.serverProfileId) throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
  if (state.position === null || input.dimension !== state.position.dimension) throw new SkillFault("TARGET_DIMENSION_MISMATCH");
}

export const storeSortSkill = defineSkill({
  id: "store.sort",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: storeSortInputSchema,
  outputSchema: storeSortOutputSchema,
  stateSchema: storageStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["container.write"] as const,
  timeoutMs: STORE_SORT_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (input, state) => state.online && input.routes.every((route) => route.serverProfileId === state.serverProfileId) },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "sort.has-reachable-route", failureCode: "ALL_SORT_TARGETS_OUT_OF_REACH", check: (input, state, policy) => state.position !== null && input.routes.slice(input.startIndex, input.startIndex + input.maxTransfers).some((route) => route.dimension === state.position!.dimension && blockWithinPolicyReach(route.container, state.position!, policy)) },
  ],
  execute: async (context, input, state) => {
    const routes = input.routes.slice(input.startIndex, input.startIndex + input.maxTransfers);
    const moved: z.infer<typeof transferReceiptSchema>[] = [];
    for (const route of routes) {
      executeStatePreconditions(route, state);
      const raw = await context.callCapability("container.write", "container.transfer-safe", storeSortCapabilityInputSchema.parse({ direction: "deposit", itemName: route.itemName, count: route.count, container: route.container, dimension: route.dimension, serverProfileId: route.serverProfileId }));
      const receipt = storeSortCapabilityOutputSchema.parse(raw);
      moved.push({ itemName: route.itemName, requestedCount: receipt.requestedCount, movedCount: receipt.movedCount, container: route.container });
    }
    return storeSortOutputSchema.parse({ startIndex: input.startIndex, nextIndex: input.startIndex + moved.length, totalRoutes: input.routes.length, moved });
  },
});

export const packShulkerSkill = defineSkill({
  id: "pack.shulker",
  version: "1.0.0", progressContract: "INVENTORY_CHANGE",
  inputSchema: packShulkerInputSchema,
  outputSchema: packShulkerOutputSchema,
  stateSchema: storageStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["container.write"] as const,
  timeoutMs: PACK_SHULKER_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (input, state) => state.position !== null && input.dimension === state.position.dimension },
    { id: "shulker.within-reach", failureCode: "SHULKER_OUT_OF_REACH", check: (input, state, policy) => state.position !== null && blockWithinPolicyReach(input.shulker, state.position, policy) },
  ],
  execute: async (context, input, state) => {
    executeStatePreconditions({ serverProfileId: input.serverProfileId, dimension: input.dimension }, state);
    const entries = input.items.slice(input.startIndex, input.startIndex + input.maxTransfers);
    const packed: z.infer<typeof transferReceiptSchema>[] = [];
    for (const entry of entries) {
      if (context.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      const raw = await context.callCapability("container.write", "container.transfer-safe", packShulkerCapabilityInputSchema.parse({ direction: "deposit", itemName: entry.itemName, count: entry.count, container: input.shulker, dimension: input.dimension, serverProfileId: input.serverProfileId }));
      const receipt = packShulkerCapabilityOutputSchema.parse(raw);
      packed.push({ itemName: entry.itemName, requestedCount: receipt.requestedCount, movedCount: receipt.movedCount, container: input.shulker });
    }
    const nextIndex = input.startIndex + packed.length;
    return packShulkerOutputSchema.parse({ startIndex: input.startIndex, nextIndex, totalItems: input.items.length, packed, completed: nextIndex >= input.items.length });
  },
});

export const stockLevelSkill = defineSkill({
  id: "stock.levels",
  version: "1.0.0", progressContract: "INVENTORY_CHANGE",
  inputSchema: stockLevelInputSchema,
  outputSchema: stockLevelOutputSchema,
  stateSchema: z.object({}).strip(),
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: [] as const,
  timeoutMs: 2_000,
  idempotent: true,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 20, retryableErrorCodes: [] },
  preconditions: [],
  execute: async (_context, input) => stockLevelOutputSchema.parse({ decisions: evaluateStockLevels(input.levels, input.counts) }),
});

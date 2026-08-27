import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

export const TRADE_VILLAGER_TIMEOUT_MS = 30_000;
export const TRADE_MAX_TRADES = 64;
export const TRADE_MAX_UNIT_PRICE = 64;

const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
const itemNameSchema = z.string().min(1).max(64).regex(/^[a-z0-9_]+$/u);
const observedPositionSchema = z.object({
  x: z.number().finite().min(-30_000_000).max(30_000_000), y: z.number().finite().min(-2_048).max(2_048), z: z.number().finite().min(-30_000_000).max(30_000_000),
  dimension: dimensionSchema, serverProfileId: identifierSchema,
}).strict();

export const villagerObservationSchema = z.object({
  entityId: identifierSchema, distance: z.number().finite().min(0), offerFound: z.boolean(), tradeDisabled: z.boolean(),
  nbTradeUses: z.number().int().nonnegative(), maximumNbTradeUses: z.number().int().positive(),
  realPrice: z.number().int().nonnegative(), specialPrice: z.number().int().nonnegative(),
  inputItemAvailable: z.boolean(), inventoryHasRoom: z.boolean(),
}).strict();

export const tradeVillagerInputSchema = z.object({
  villagerEntityId: identifierSchema, wantItem: itemNameSchema,
  maxUnitPrice: z.number().int().min(1).max(TRADE_MAX_UNIT_PRICE), maxTrades: z.number().int().min(1).max(TRADE_MAX_TRADES),
  dimension: dimensionSchema, serverProfileId: identifierSchema,
}).strict();
export type TradeVillagerInput = z.infer<typeof tradeVillagerInputSchema>;

export const tradeVillagerStateSchema = z.object({
  online: z.boolean(), normalActionsAllowed: z.boolean(), serverProfileId: identifierSchema,
  position: observedPositionSchema.nullable(),
  // Offers become authoritative only after opening the server-owned merchant
  // window. Runtime capability execution performs that read, so a stale
  // pre-open observation must not block a valid trade.
  villager: villagerObservationSchema.nullable().optional(),
}).strip();
export type TradeVillagerState = z.infer<typeof tradeVillagerStateSchema>;

export const tradeVillagerOutputSchema = z.object({
  villagerEntityId: identifierSchema, wantItem: itemNameSchema,
  requestedTrades: z.number().int().min(1).max(TRADE_MAX_TRADES), completedTrades: z.number().int().nonnegative().max(TRADE_MAX_TRADES),
  receivedCount: z.number().int().nonnegative(), spentCount: z.number().int().nonnegative(), actualUnitPrice: z.number().int().nonnegative(),
}).strict().superRefine((output, context) => {
  if (output.completedTrades > output.requestedTrades) context.addIssue({ code: "custom", path: ["completedTrades"], message: "completedTrades cannot exceed requestedTrades." });
  if (output.completedTrades === 0 && (output.receivedCount !== 0 || output.spentCount !== 0)) context.addIssue({ code: "custom", path: ["completedTrades"], message: "zero trades cannot report deltas." });
  if (output.completedTrades > 0 && output.actualUnitPrice !== Math.ceil(output.spentCount / output.completedTrades)) context.addIssue({ code: "custom", path: ["actualUnitPrice"], message: "actualUnitPrice must reflect observed payment delta." });
});

export const tradeVillagerCapabilityInputSchema = tradeVillagerInputSchema;
export const tradeVillagerCapabilityOutputSchema = tradeVillagerOutputSchema;

export const tradeVillagerSkill = defineSkill({
  id: "trade.villager", version: "1.0.0", inputSchema: tradeVillagerInputSchema, outputSchema: tradeVillagerOutputSchema, stateSchema: tradeVillagerStateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact", "inventory.write"] as const, timeoutMs: TRADE_VILLAGER_TIMEOUT_MS, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 50, maxDelayMs: 250, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_input, state) => state.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (input, state) => input.serverProfileId === state.serverProfileId },
  ],
  execute: async (context, input) => tradeVillagerCapabilityOutputSchema.parse(await context.callCapability("world.interact", "trade.villager-safe", tradeVillagerCapabilityInputSchema.parse(input))),
});

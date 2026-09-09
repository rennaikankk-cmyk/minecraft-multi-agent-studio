import { z } from "zod";
import { botPersonalContextSchema, botPositionSchema, botStatusV1Schema, botIdentitySchema, identifierSchema } from "./bot-messages.js";

const timestamp = z.string().datetime({ offset: true });
const status = botStatusV1Schema.shape.payload.shape;
const observation = <T extends z.ZodType>(value: T) => z.object({
  observedAt: timestamp,
  runtimeInstanceId: identifierSchema,
  value,
}).strict();

/** All three values are required. A missing world generation is an explicit null. */
export const botPersonalMemoryScopeSchema = z.object({
  botId: botIdentitySchema,
  serverProfileId: identifierSchema,
  worldId: identifierSchema.nullable(),
}).strict();

/** Historical observations only; never hydrated into live Bot readiness/state. */
export const botPersonalMemoryV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  scope: botPersonalMemoryScopeSchema,
  lastObservedAt: timestamp,
  runtimeInstanceId: identifierSchema,
  sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  position: observation(botPositionSchema),
  inventory: observation(status.inventory.unwrap()).nullable(),
  equipment: observation(z.object({
    armorPoints: status.armorPoints,
    armorSlots: status.armorSlots.unwrap().nullable(),
  }).strict()),
  lastDeath: observation(status.lastDeath.unwrap()).nullable(),
  worldSpawn: botPersonalContextSchema.shape.worldSpawn,
  verifiedRespawn: botPersonalContextSchema.shape.verifiedRespawn,
}).strict();

export const botPersonalMemoryResponseV1Schema = z.object({
  schemaVersion: z.literal("1.0"),
  durability: z.literal("file"),
  freshness: z.literal("historical"),
  memory: botPersonalMemoryV1Schema.nullable(),
}).strict();

export type BotPersonalContext = z.infer<typeof botPersonalContextSchema>;
export type BotPersonalMemoryScope = z.infer<typeof botPersonalMemoryScopeSchema>;
export type BotPersonalMemoryV1 = z.infer<typeof botPersonalMemoryV1Schema>;
export type BotPersonalMemoryResponseV1 = z.infer<typeof botPersonalMemoryResponseV1Schema>;

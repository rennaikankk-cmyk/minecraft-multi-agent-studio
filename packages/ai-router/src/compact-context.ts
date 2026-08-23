import { botPositionSchema, identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

/**
 * Bounded planner context.
 *
 * Every field is capped in length and arity so a context cannot grow without
 * limit as world memory, team state or failure history accumulates. The budget
 * matters directly: the deployed planner runs against a 120s fail-closed
 * deadline at concurrency 1, and an unbounded prompt is the most likely way to
 * exceed it. Enforcing the ceiling in a schema makes overflow a validation
 * failure at construction rather than a timeout at request time.
 *
 * Position reuses `botPositionSchema` from the protocol so that a context
 * carries the same coordinate-plus-namespaced-dimension shape as authoritative
 * bot state, rather than a parallel looser definition.
 */
export const compactBotContextSchema = z
  .object({
    botId: identifierSchema,
    currentTask: z.string().max(1_024).nullable(),
    health: z.number().min(0).max(2_048),
    food: z.number().min(0).max(20),
    position: botPositionSchema,
    importantInventory: z
      .array(
        z
          .object({
            item: z.string().min(1).max(128),
            count: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .max(64),
    equipment: z.array(z.string().min(1).max(128)).max(16),
    nearbyThreats: z.array(z.string().min(1).max(256)).max(32),
    nearbyEntities: z.array(z.string().min(1).max(256)).max(64),
    relevantMemory: z.array(z.string().min(1).max(1_024)).max(32),
    relevantSkills: z.array(identifierSchema).max(128),
    recentFailures: z.array(z.string().min(1).max(1_024)).max(16),
    teamState: z.array(z.string().min(1).max(512)).max(32),
  })
  .strict();

export type CompactBotContext = z.infer<typeof compactBotContextSchema>;

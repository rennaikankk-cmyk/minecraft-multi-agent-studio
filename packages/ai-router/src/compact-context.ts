import { z } from "zod";

const positionSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
}).strict();

export const compactBotContextSchema = z
  .object({
    botId: z.string().min(1).max(128),
    currentTask: z.string().max(1_024).nullable(),
    health: z.number().min(0).max(2_048),
    food: z.number().min(0).max(20),
    position: positionSchema,
    dimension: z.string().min(1).max(128),
    importantInventory: z
      .array(
        z.object({ item: z.string().min(1).max(128), count: z.number().int().nonnegative() }).strict(),
      )
      .max(64),
    equipment: z.array(z.string().min(1).max(128)).max(16),
    nearbyThreats: z.array(z.string().min(1).max(256)).max(32),
    nearbyEntities: z.array(z.string().min(1).max(256)).max(64),
    relevantMemory: z.array(z.string().min(1).max(1_024)).max(32),
    relevantSkills: z.array(z.string().min(1).max(128)).max(128),
    recentFailures: z.array(z.string().min(1).max(1_024)).max(16),
    teamState: z.array(z.string().min(1).max(512)).max(32),
  })
  .strict();

export type CompactBotContext = z.infer<typeof compactBotContextSchema>;

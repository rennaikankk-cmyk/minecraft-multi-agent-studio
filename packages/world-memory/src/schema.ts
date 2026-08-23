import { z } from "zod";

/**
 * World facts are deliberately scoped by server profile.  A coordinate without
 * a profile is not a partial fact; it is an invalid fact and must be rejected.
 */
export const worldMemoryKindSchema = z.enum([
  "ORE_VEIN",
  "SAFE_SITE",
  "OWN_STASH",
  "OWN_HIDEOUT",
  "VILLAGER",
  "HIGHWAY_NODE",
  "HAZARD",
  "PORTAL_SUSPECT",
  "BLUEPRINT_ANCHOR",
]);

export const worldMemoryFreshnessSchema = z.enum(["fresh", "stale"]);

export const worldMemoryServerProfileIdSchema = z
  .string()
  .min(1)
  .max(128);

export const worldMemoryDimensionSchema = z.string().min(1).max(128);

export const worldMemoryPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

export const worldMemoryTimestampSchema = z
  .string()
  .max(35)
  .datetime({ offset: true });

/** Memory payloads are facts, not executable objects. Keep them JSON-only. */
export const worldMemoryPayloadSchema = z.record(z.string(), z.json());

export const worldMemoryRecordSchema = z
  .object({
    serverProfileId: worldMemoryServerProfileIdSchema,
    dimension: worldMemoryDimensionSchema,
    position: worldMemoryPositionSchema,
    kind: worldMemoryKindSchema,
    observedAt: worldMemoryTimestampSchema,
    confidence: z.number().finite().min(0).max(1),
    staleAfterMs: z.number().int().positive().safe(),
    payload: worldMemoryPayloadSchema,
  })
  .strict();

export const worldMemoryRecordViewSchema = worldMemoryRecordSchema.extend({
  freshness: worldMemoryFreshnessSchema,
  ageMs: z.number().finite(),
});

export type WorldMemoryKind = z.infer<typeof worldMemoryKindSchema>;
export type WorldMemoryFreshness = z.infer<typeof worldMemoryFreshnessSchema>;
export type WorldMemoryPosition = z.infer<typeof worldMemoryPositionSchema>;
export type WorldMemoryRecord = z.infer<typeof worldMemoryRecordSchema>;
export type WorldMemoryRecordView = z.infer<
  typeof worldMemoryRecordViewSchema
>;

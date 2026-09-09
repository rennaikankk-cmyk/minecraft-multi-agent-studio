import { z } from "zod";

const coordinate = z.object({ x: z.number().int().min(-30_000_000).max(30_000_000),
  y: z.number().int().min(-2048).max(2048), z: z.number().int().min(-30_000_000).max(30_000_000) }).strict();
export const residenceScopeSchema = z.object({ serverProfileId: z.string().min(1).max(128),
  worldId: z.string().min(1).max(128), dimension: z.string().min(1).max(128),
  botId: z.string().regex(/^[A-Za-z0-9_]{3,16}$/u) }).strict();
export const bedSiteSchema = z.object({
  siteId: z.string().uuid(), baseId: z.string().min(1).max(128), scope: residenceScopeSchema,
  head: coordinate, foot: coordinate, facing: z.enum(["north", "south", "east", "west"]),
  marker: coordinate, standing: coordinate, revision: z.number().int().positive(),
  policyRevision: z.number().int().positive(), source: z.enum(["operator-assigned", "bot-built"]),
}).strict().superRefine((s, ctx) => {
  const offsets = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0] };
  const [dx, dz] = offsets[s.facing]!;
  if (s.head.x !== s.foot.x + dx! || s.head.z !== s.foot.z + dz! || s.head.y !== s.foot.y)
    ctx.addIssue({ code: "custom", message: "BED_HALVES_INVALID" });
  if (s.scope.dimension !== "minecraft:overworld") ctx.addIssue({ code: "custom", message: "BED_DIMENSION_UNSAFE" });
  const distance = Math.hypot(s.marker.x - s.head.x, s.marker.y - s.head.y, s.marker.z - s.head.z);
  if (distance < 1 || distance > 4 || JSON.stringify(s.marker) === JSON.stringify(s.standing) ||
      JSON.stringify(s.marker) === JSON.stringify(s.foot)) ctx.addIssue({ code: "custom", message: "BED_MARKER_SITE_INVALID" });
});
export type BedSite = z.infer<typeof bedSiteSchema>;
export const residenceCheckInputSchema = z.object({
  schemaVersion: z.literal("1.0"), site: bedSiteSchema,
  operationId: z.string().uuid(), mode: z.enum(["inspect", "bind", "marker"]),
}).strict();
export type ResidenceCheckInput = z.infer<typeof residenceCheckInputSchema>;
export const residenceCheckOutputSchema = z.object({
  schemaVersion: z.literal("1.0"), siteId: z.string().uuid(), siteRevision: z.number().int().positive(),
  operationId: z.string().uuid(), botId: residenceScopeSchema.shape.botId,
  serverProfileId: z.string().min(1), worldId: z.string().min(1), dimension: z.literal("minecraft:overworld"),
  runtimeInstanceId: z.string().min(1),
  bedPresent: z.boolean(), usable: z.boolean(), markerPresent: z.boolean(),
  binding: z.enum(["UNVERIFIED", "SERVER_CONFIRMED", "INVALID"]),
  bindingEvidence: z.object({ type: z.literal("server-translation"), translation: z.literal("block.minecraft.bed.set_spawn"),
    receivedAt: z.iso.datetime(), interactionId: z.string().uuid() }).strict().nullable(),
  marker: z.enum(["UNVERIFIED", "SERVER_CONFIRMED", "INVALID"]), markerText: z.string().max(256).nullable(),
  markerEvidence: z.object({ type: z.literal("server-block-entity"), receivedAt: z.iso.datetime() }).strict().nullable(),
  observedAt: z.iso.datetime(), reason: z.string().max(128).nullable(),
}).strict().superRefine((r, ctx) => {
  if (r.binding === "SERVER_CONFIRMED" && (!r.bedPresent || !r.usable || !r.bindingEvidence))
    ctx.addIssue({ code: "custom", message: "BED_EVIDENCE_REQUIRED" });
  if (r.marker === "SERVER_CONFIRMED" && (!r.markerPresent || !r.markerEvidence ||
      r.markerText?.replace(/\s/gu, "") !== (r.botId + "的复活点")))
    ctx.addIssue({ code: "custom", message: "MARKER_EVIDENCE_REQUIRED" });
});
export type ResidenceCheckOutput = z.infer<typeof residenceCheckOutputSchema>;

export const residenceRecordSchema = z.object({
  site: bedSiteSchema, revision: z.number().int().positive(),
  homeBaseId: z.string().min(1).nullable(), targetHomeBaseId: z.string().min(1).nullable(),
  status: z.enum(["SETTLING", "SETTLED", "RECONCILING", "INVALID"]),
  taskId: z.string().uuid(), operationId: z.string().uuid(),
  bindingReceipt: residenceCheckOutputSchema.nullable(), markerReceipt: residenceCheckOutputSchema.nullable(),
  lastObservedAt: z.iso.datetime().nullable(), lastError: z.string().max(128).nullable(),
}).strict();
export type ResidenceRecord = z.infer<typeof residenceRecordSchema>;

/** A sign is a display only; its text never grants permission or ownership. */
export function respawnMarkerLines(botId: string): string {
  residenceScopeSchema.shape.botId.parse(botId);
  // Minecraft account names fit on two conservative eight-character lines.
  return [botId.slice(0, 8), botId.slice(8), "的复活点"].filter(Boolean).join("\n");
}

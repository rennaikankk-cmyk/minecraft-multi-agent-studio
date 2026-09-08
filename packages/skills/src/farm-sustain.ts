import { z } from "zod";
import { skillJsonValueSchema } from "@minecraft-studio/protocol";
import { defineSkill } from "./types.js";
import { farmMaintainInputSchema, farmMaintainOutputSchema } from "./farm-maintenance.js";
import { workAreaSchema, workPositionSchema, workScopeSchema, withinWorkArea, type WorkPosition } from "./work-area.js";

// A compact, inspectable starter garden: 24 carrots, one water source,
// a continuous fence with a service gate, four lights and one dedicated barrel.
export function foodFarmLayout(center: WorkPosition) {
  const at = (x: number, y: number, z: number) => ({ x: center.x + x, y: center.y + y, z: center.z + z });
  const gate = at(0, 0, 3);
  const fences: WorkPosition[] = [];
  for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) {
    if ((Math.abs(x) === 3 || Math.abs(z) === 3) && !(x === 0 && z === 3)) fences.push(at(x, 0, z));
  }
  return { min: at(-4, -2, -4), max: at(4, 2, 5), gate, fences,
    lights: [at(-3, 1, 0), at(3, 1, 0), at(0, 1, -3), at(1, 1, 3)],
    water: at(0, -1, 0), cover: at(0, 0, 0), storage: at(2, 0, 4),
    inside: at(0, 0, 2), outside: at(0, 0, 4),
    plots: { min: at(-2, -1, -2), max: at(2, 0, 2) } };
}

export const farmSustainInputSchema = workScopeSchema.extend({
  center: workPositionSchema,
  waterSource: workPositionSchema.nullable().default(null),
  seedReserve: z.number().int().min(1).max(64).default(8),
  foodReserve: z.number().int().min(4).max(64).default(8),
  maxActions: z.number().int().min(2).max(64).default(56),
}).strict().superRefine((input, ctx) => {
  const layout = foodFarmLayout(input.center);
  // Validate the derived bounds without passing layout metadata into a strict schema.
  const bounds = workAreaSchema.safeParse({ serverProfileId: input.serverProfileId, dimension: input.dimension, min: layout.min, max: layout.max });
  if (!bounds.success || (input.waterSource && !withinWorkArea(bounds.data!, input.waterSource)) || input.dimension !== "minecraft:overworld") {
    ctx.addIssue({ code: "custom", message: "Food garden requires bounded overworld coordinates and an in-area water source." });
  }
});
export type FarmSustainInput = z.infer<typeof farmSustainInputSchema>;
export const farmSupplyReceiptSchema = z.object({
  waterReady: z.boolean(), lightingReady: z.boolean(), enclosureReady: z.boolean(),
  hydratedPlots: z.number().int().min(0).max(24), plantedPlots: z.number().int().min(0).max(24),
  repairs: z.number().int().min(0).max(64),
  seedReserved: z.number().int().nonnegative(), foodReserved: z.number().int().nonnegative(),
  deposited: z.number().int().nonnegative(), withdrawn: z.number().int().nonnegative(),
  storageBefore: z.number().int().nonnegative().nullable(), storageAfter: z.number().int().nonnegative().nullable(),
  inventoryFood: z.number().int().nonnegative(),
}).strict();
export const farmSustainOutputSchema = z.object({
  status: z.enum(["PASS_COMPLETE", "BATCH_LIMIT", "WAITING_GROWTH", "WAITING_SEEDS", "WAITING_OBSERVATION", "WAITING_INFRASTRUCTURE", "STORAGE_FULL"]),
  reason: z.string().max(128).nullable(),
  maintenance: farmMaintainOutputSchema.nullable(),
  supply: farmSupplyReceiptSchema,
  observedAt: z.string().datetime(),
}).strict();
export type FarmSustainOutput = z.infer<typeof farmSustainOutputSchema>;

export function foodFarmMaintenance(input: FarmSustainInput) {
  return farmMaintainInputSchema.parse({ area: { serverProfileId: input.serverProfileId, dimension: input.dimension, ...foodFarmLayout(input.center).plots },
    crops: ["carrots"], plantEmpty: "carrots", prepareSoil: true, seedReserve: input.seedReserve, maxActions: input.maxActions });
}

export const farmSustainSkill = defineSkill({
  id: "farm.sustain", version: "1.0.0", progressContract: "INVENTORY_CHANGE",
  inputSchema: farmSustainInputSchema, outputSchema: farmSustainOutputSchema,
  stateSchema: z.object({ online: z.boolean(), normalActionsAllowed: z.boolean(), serverProfileId: z.string(),
    position: z.object({ dimension: z.string() }).strip().nullable() }).strip(),
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact", "bot.move", "container.write"] as const,
  timeoutMs: 120_000, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "target.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.serverProfileId === s.serverProfileId },
    { id: "target.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => i.dimension === s.position?.dimension },
  ],
  execute: async (context, input) => farmSustainOutputSchema.parse(await context.callCapability("world.interact", "farm.sustain-safe", skillJsonValueSchema.parse(input))),
});

import { z } from "zod";
import { defineSkill } from "./types.js";
import { workAreaSchema, workPositionSchema, workScopeSchema } from "./work-area.js";

export const farmCropNames = [
  "wheat", "carrots", "potatoes", "beetroots", "nether_wart", "cocoa",
  "sugar_cane", "bamboo", "cactus", "pumpkin", "melon",
] as const;
export type FarmCropName = (typeof farmCropNames)[number];
export type CropRule = Readonly<{
  itemName: string;
  seedItem: string | null;
  substrate: string | null;
  matureAge: number | null;
  preserveBase: boolean;
  bonemeal: boolean;
}>;

// Crop mechanics are data; harvesting still requires current world observations.
export const cropRules: Readonly<Record<FarmCropName, CropRule>> = Object.freeze({
  wheat: { itemName: "wheat", seedItem: "wheat_seeds", substrate: "farmland", matureAge: 7, preserveBase: false, bonemeal: true },
  carrots: { itemName: "carrot", seedItem: "carrot", substrate: "farmland", matureAge: 7, preserveBase: false, bonemeal: true },
  potatoes: { itemName: "potato", seedItem: "potato", substrate: "farmland", matureAge: 7, preserveBase: false, bonemeal: true },
  beetroots: { itemName: "beetroot", seedItem: "beetroot_seeds", substrate: "farmland", matureAge: 3, preserveBase: false, bonemeal: true },
  nether_wart: { itemName: "nether_wart", seedItem: "nether_wart", substrate: "soul_sand", matureAge: 3, preserveBase: false, bonemeal: false },
  cocoa: { itemName: "cocoa_beans", seedItem: "cocoa_beans", substrate: "jungle_log", matureAge: 2, preserveBase: false, bonemeal: true },
  sugar_cane: { itemName: "sugar_cane", seedItem: "sugar_cane", substrate: null, matureAge: null, preserveBase: true, bonemeal: false },
  bamboo: { itemName: "bamboo", seedItem: "bamboo", substrate: null, matureAge: null, preserveBase: true, bonemeal: true },
  cactus: { itemName: "cactus", seedItem: "cactus", substrate: null, matureAge: null, preserveBase: true, bonemeal: false },
  pumpkin: { itemName: "pumpkin", seedItem: null, substrate: null, matureAge: null, preserveBase: false, bonemeal: false },
  melon: { itemName: "melon_slice", seedItem: null, substrate: null, matureAge: null, preserveBase: false, bonemeal: false },
});

export const farmMaintainInputSchema = z.object({
  area: workAreaSchema,
  crops: z.array(z.enum(farmCropNames)).min(1).max(farmCropNames.length),
  replant: z.boolean().default(true),
  plantEmpty: z.enum(farmCropNames).nullable().default(null),
  seedReserve: z.number().int().min(1).max(64).default(1),
  maxActions: z.number().int().min(1).max(64).default(16),
  maxBonemeal: z.number().int().min(0).max(64).default(0),
}).strict().superRefine((input, context) => {
  if (new Set(input.crops).size !== input.crops.length) {
    context.addIssue({ code: "custom", path: ["crops"], message: "Crop selection contains duplicates." });
  }
  if (input.plantEmpty !== null && (!input.crops.includes(input.plantEmpty) || !cropRules[input.plantEmpty].substrate || input.plantEmpty === "cocoa")) {
    context.addIssue({ code: "custom", path: ["plantEmpty"], message: "Empty planting requires a selected ground crop." });
  }
});
export type FarmMaintainInput = z.infer<typeof farmMaintainInputSchema>;

export const farmCellSchema = z.object({
  position: workPositionSchema,
  blockName: z.string().nullable(),
  age: z.number().int().nonnegative().nullable(),
  belowName: z.string().nullable(),
  aboveName: z.string().nullable(),
  facing: z.enum(["north", "south", "east", "west"]).nullable(),
}).strict();
export type FarmCell = z.infer<typeof farmCellSchema>;
export type FarmAction = Readonly<{
  kind: "harvest" | "plant" | "bonemeal";
  crop: FarmCropName;
  cell: FarmCell;
}>;

export function selectFarmAction(
  cell: FarmCell,
  input: FarmMaintainInput,
  inventory: ReadonlyMap<string, number>,
  bonemealUsed: number,
): FarmAction | null {
  if (cell.blockName === null) return null;
  if (["air", "cave_air", "void_air"].includes(cell.blockName)) {
    const crop = input.plantEmpty;
    if (crop === null) return null;
    const rule = cropRules[crop];
    return cell.belowName === rule.substrate && (inventory.get(rule.seedItem!) ?? 0) > input.seedReserve
      ? { kind: "plant", crop, cell } : null;
  }
  if (!input.crops.includes(cell.blockName as FarmCropName)) return null;
  const crop = cell.blockName as FarmCropName;
  const rule = cropRules[crop];
  if (rule.preserveBase) {
    return cell.belowName === crop && cell.aboveName !== null && cell.aboveName !== crop
      ? { kind: "harvest", crop, cell } : null;
  }
  if (rule.matureAge !== null && cell.age === null) return null;
  if (rule.matureAge === null || cell.age! >= rule.matureAge) {
    if (input.replant && rule.seedItem && (inventory.get(rule.seedItem) ?? 0) <= input.seedReserve) return null;
    return { kind: "harvest", crop, cell };
  }
  if (rule.bonemeal && bonemealUsed < input.maxBonemeal && (inventory.get("bone_meal") ?? 0) > 0) {
    return { kind: "bonemeal", crop, cell };
  }
  return null;
}

export const farmMaintainOutputSchema = z.object({
  status: z.enum(["PASS_COMPLETE", "BATCH_LIMIT", "WAITING_OBSERVATION", "WAITING_SEEDS", "WAITING_GROWTH"]),
  scannedCells: z.number().int().min(0).max(4096),
  unknownCells: z.number().int().min(0).max(4096),
  harvested: z.number().int().min(0).max(64),
  planted: z.number().int().min(0).max(64),
  bonemealUsed: z.number().int().min(0).max(64),
  inventoryDelta: z.array(z.object({ itemName: z.string(), delta: z.number().int() }).strict()).max(256),
  observedAt: z.string().datetime(),
}).strict();
export type FarmMaintainOutput = z.infer<typeof farmMaintainOutputSchema>;

const stateSchema = z.object({ online: z.boolean(), normalActionsAllowed: z.boolean(),
  serverProfileId: workScopeSchema.shape.serverProfileId,
  position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
    dimension: workScopeSchema.shape.dimension }).strip().nullable(),
}).strip();
export const farmMaintainSkill = defineSkill({
  id: "farm.maintain", version: "1.0.0", progressContract: "INVENTORY_CHANGE",
  inputSchema: farmMaintainInputSchema, outputSchema: farmMaintainOutputSchema, stateSchema,
  compatibility: { variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }] },
  requiredCapabilities: ["world.interact", "bot.move"] as const,
  timeoutMs: 60_000, idempotent: false,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_i, s) => s.online },
    { id: "l0.normal-actions-allowed", failureCode: "NORMAL_ACTIONS_PAUSED", check: (_i, s) => s.normalActionsAllowed },
    { id: "area.server-profile-matches", failureCode: "TARGET_SERVER_PROFILE_MISMATCH", check: (i, s) => i.area.serverProfileId === s.serverProfileId },
    { id: "area.dimension-matches", failureCode: "TARGET_DIMENSION_MISMATCH", check: (i, s) => i.area.dimension === s.position?.dimension },
  ],
  execute: async (context, input) => farmMaintainOutputSchema.parse(await context.callCapability(
    "world.interact", "farm.maintain-safe", input,
  )),
});

import {
  skillErrorCodeSchema,
  skillIdentifierSchema,
  skillJsonValueSchema,
  skillVersionSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

export const skillScenarioCategories = [
  "success",
  "insufficient-materials",
  "authorization-or-location-rejected",
  "l0-preemption",
  "cancellation",
  "disconnect",
  "partial-readback",
] as const;

export const skillScenarioCategorySchema = z.enum(skillScenarioCategories);

const itemStackSchema = z
  .object({ itemName: skillIdentifierSchema, count: z.number().int().min(1).max(64) })
  .strict();

const blockFixtureSchema = z
  .object({
    blockName: skillIdentifierSchema,
    position: z
      .object({ x: z.number().int(), y: z.number().int(), z: z.number().int() })
      .strict(),
  })
  .strict();

export const skillVerificationScenarioV1Schema = z
  .object({
    scenarioId: skillIdentifierSchema,
    category: skillScenarioCategorySchema,
    initialState: z
      .object({
        inventory: z.array(itemStackSchema).max(36),
        worldBlocks: z.array(blockFixtureSchema).max(64),
        connected: z.boolean(),
        normalActionsAllowed: z.boolean(),
      })
      .strict(),
    input: skillJsonValueSchema,
    expected: z
      .object({
        outcome: z.enum(["completed", "rejected", "failed", "cancelled"]),
        errorCode: skillErrorCodeSchema.optional(),
        inventory: z.array(itemStackSchema).max(36),
        worldBlocks: z.array(blockFixtureSchema).max(64),
        requireActualReadback: z.boolean(),
      })
      .strict(),
    hardTimeoutMs: z.number().int().min(100).max(60_000),
  })
  .strict();

export const skillVerificationManifestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    manifestId: skillIdentifierSchema,
    skillId: skillIdentifierSchema,
    skillVersion: skillVersionSchema,
    minecraftVersions: z.array(z.string().regex(/^\d+\.\d+(?:\.\d+)?$/u)).min(1).max(8),
    scenarios: z.array(skillVerificationScenarioV1Schema).min(skillScenarioCategories.length).max(32),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = manifest.scenarios.map(({ scenarioId }) => scenarioId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: "custom", path: ["scenarios"], message: "Scenario IDs must be unique." });
    }
    for (const category of skillScenarioCategories) {
      if (!manifest.scenarios.some((scenario) => scenario.category === category)) {
        context.addIssue({
          code: "custom",
          path: ["scenarios"],
          message: `Missing required scenario category: ${category}.`,
        });
      }
    }
  });

export type SkillVerificationManifestV1 = z.infer<typeof skillVerificationManifestV1Schema>;

const server = "isolated-local";
const dimension = "minecraft:overworld";
const furnace = { blockName: "furnace", position: { x: 2, y: 64, z: 0 } };

function scenario(
  category: (typeof skillScenarioCategories)[number],
  input: z.infer<typeof skillJsonValueSchema>,
): z.infer<typeof skillVerificationScenarioV1Schema> {
  const completed = category === "success" || category === "partial-readback";
  const errorCodes: Partial<Record<typeof category, string>> = {
    "insufficient-materials": "SKILL_PRECONDITION_FAILED",
    "authorization-or-location-rejected": "SKILL_CAPABILITY_DENIED",
    "l0-preemption": "NORMAL_ACTIONS_PAUSED",
    cancellation: "SKILL_CANCELLED",
    disconnect: "BOT_OFFLINE",
  };
  return {
    scenarioId: category,
    category,
    initialState: {
      inventory: [{ itemName: "cobblestone", count: 8 }],
      worldBlocks: [furnace],
      connected: category !== "disconnect",
      normalActionsAllowed: category !== "l0-preemption",
    },
    input,
    expected: {
      outcome: completed ? "completed" : category === "cancellation" ? "cancelled" : "rejected",
      ...(completed ? {} : { errorCode: errorCodes[category] ?? "SKILL_HANDLER_FAILED" }),
      inventory: [],
      worldBlocks: [furnace],
      requireActualReadback: completed,
    },
    hardTimeoutMs: 60_000,
  };
}

const baseInputs = {
  "movement.goto": { target: { x: 4, y: 64, z: 0, dimension, serverProfileId: server }, radius: 1 },
  "collect.block": { blockName: "oak_log", maxCount: 4, maxDistance: 16, dimension, serverProfileId: server },
  "craft.item": { itemName: "crafting_table", count: 1, craftingTable: null, dimension, serverProfileId: server },
  "world.place-block": { itemName: "cobblestone", referenceBlock: { x: 1, y: 63, z: 0 }, face: { x: 0, y: 1, z: 0 }, dimension, serverProfileId: server },
  "container.transfer": { direction: "deposit", itemName: "cobblestone", count: 4, container: { x: 3, y: 64, z: 0 }, dimension, serverProfileId: server },
  "inventory.equip-armor": { serverProfileId: server },
  "smelt.item": { inputItemName: "raw_iron", fuelItemName: "coal", fuelCount: 1, count: 5, furnace: { x: 2, y: 64, z: 0 }, dimension, serverProfileId: server },
  "survival.consume-food": { maximumFoodLevel: 18, serverProfileId: server },
  "survival.sleep": { bed: { x: 1, y: 64, z: 0 }, dimension, serverProfileId: server },
  "inventory.compact": { maxMoves: 36, serverProfileId: server },
  "movement.recover": { maxAttempts: 3, dimension, serverProfileId: server },
  "combat.pve-melee": { targetTypes: ["zombie", "skeleton"], maxDistance: 4, maxAttackAttempts: 3, retreatHealth: 10, dimension, serverProfileId: server },
  "combat.pvp-melee": { targetUsername: "ArenaBot", maxDistance: 4, maxAttackAttempts: 3, retreatHealth: 10, dimension, serverProfileId: server },
  "storage.account": { container: { x: 3, y: 64, z: 0 }, itemNames: ["cobblestone", "bread"], dimension, serverProfileId: server },
  "collect.drops": { itemNames: ["oak_log"], maxCount: 4, maxDistance: 16, dimension, serverProfileId: server },
  "farm.crop": { cropName: "wheat", maxCount: 4, maxDistance: 16, dimension, serverProfileId: server },
  "gather.fish-once": { dimension, serverProfileId: server },
};

export const builtinSkillVerificationManifestsV1: readonly SkillVerificationManifestV1[] =
  Object.entries(baseInputs).map(([skillId, input]) =>
    skillVerificationManifestV1Schema.parse({
      schemaVersion: "1.0",
      manifestId: `${skillId.replaceAll(".", "-")}-acceptance`,
      skillId,
      skillVersion: "1.0.0",
      minecraftVersions: ["1.21.8"],
      scenarios: skillScenarioCategories.map((category) => scenario(category, input)),
    }),
  );

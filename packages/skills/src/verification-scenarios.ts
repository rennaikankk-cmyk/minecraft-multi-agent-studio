import {
  skillErrorCodeSchema,
  skillIdentifierSchema,
  skillJsonValueSchema,
  skillVersionSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import { builtinSkills } from "./builtin/catalog.js";

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

/**
 * 每个技能的验收基准输入。**键必须是真实注册的技能 id**——下面的组装会拿
 * `builtinSkills` 逐个查表，查不到就抛。此前这里写着 `equipment.equip-armor`，
 * 而注册的是 `inventory.equip-armor`：一份指向不存在技能的验收清单，
 * 静静躺着通过了所有 schema 校验。
 */
const baseInputs: Readonly<Record<string, z.infer<typeof skillJsonValueSchema>>> = {
  "movement.goto": { target: { x: 4, y: 64, z: 0, dimension, serverProfileId: server }, radius: 1 },
  "combat.engage": { serverProfileId: server },
  "combat.disengage": { serverProfileId: server },
  "collect.block": { blockName: "oak_log", maxCount: 4, maxDistance: 16, dimension, serverProfileId: server },
  "craft.item": { itemName: "crafting_table", count: 1, craftingTable: null, dimension, serverProfileId: server },
  "world.place-block": { itemName: "cobblestone", referenceBlock: { x: 1, y: 63, z: 0 }, face: { x: 0, y: 1, z: 0 }, dimension, serverProfileId: server },
  "container.transfer": { direction: "deposit", itemName: "cobblestone", count: 4, container: { x: 3, y: 64, z: 0 }, dimension, serverProfileId: server },
  "inventory.equip-armor": { serverProfileId: server },
  "smelt.item": { inputItemName: "raw_iron", fuelItemName: "coal", fuelCount: 1, count: 5, furnace: { x: 2, y: 64, z: 0 }, dimension, serverProfileId: server },
};

/**
 * 按**注册的技能定义**组装验收清单，而不是按手写的键列表遍历。
 * 技能的 id 与 version 直接取自定义，所以清单不可能指向一个不存在的技能，
 * 也不可能漏掉一个已注册的技能（漏了就抛，不是静默少一份）。
 */
export const builtinSkillVerificationManifestsV1: readonly SkillVerificationManifestV1[] =
  Object.freeze(
    builtinSkills.map((skill) => {
      const input = baseInputs[skill.id];
      if (input === undefined) {
        throw new Error(`Verification base input missing for skill ${skill.id}`);
      }
      return skillVerificationManifestV1Schema.parse({
        schemaVersion: "1.0",
        manifestId: `${skill.id.replaceAll(".", "-")}-acceptance`,
        skillId: skill.id,
        skillVersion: skill.version,
        minecraftVersions: ["1.21.8"],
        scenarios: skillScenarioCategories.map((category) => scenario(category, input)),
      });
    }),
  );

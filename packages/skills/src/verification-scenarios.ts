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
  "travel.route": { destination: { x: 4, y: 64, z: 0 }, dimension, serverProfileId: server, maxSegments: 1, corridorPolicy: "pathfinder" },
  "combat.engage": { serverProfileId: server },
  "combat.disengage": { serverProfileId: server },
  "world.scan": { blockName: "oak_log", maxCount: 8, maxDistance: 32, dimension, serverProfileId: server },
  "collect.block": { blockName: "oak_log", maxCount: 4, maxDistance: 16, dimension, serverProfileId: server },
  "craft.item": { itemName: "crafting_table", count: 1, craftingTable: null, dimension, serverProfileId: server },
  "world.place-block": { itemName: "cobblestone", referenceBlock: { x: 1, y: 63, z: 0 }, face: { x: 0, y: 1, z: 0 }, dimension, serverProfileId: server },
  "container.transfer": { direction: "deposit", itemName: "cobblestone", count: 4, container: { x: 3, y: 64, z: 0 }, dimension, serverProfileId: server },
  "inventory.equip-armor": { serverProfileId: server },
  "base.residence-check": { schemaVersion: "1.0", operationId: "00000000-0000-4000-8000-000000000001", mode: "inspect",
    site: { siteId: "00000000-0000-4000-8000-000000000002", baseId: "fixture-base",
      scope: { serverProfileId: server, worldId: "isolated-world", dimension, botId: "fixture_bot" },
      head: { x: 1, y: 64, z: 1 }, foot: { x: 1, y: 64, z: 0 }, facing: "south",
      marker: { x: 2, y: 64, z: 1 }, standing: { x: 0, y: 64, z: 1 }, revision: 1, policyRevision: 1, source: "operator-assigned" } },
  "combat.stance": { stance: "aggressive", serverProfileId: server },
  "food.secure": { targetCount: 6, dimension, serverProfileId: server },
  "smelt.item": { inputItemName: "raw_iron", fuelItemName: "coal", fuelCount: 1, count: 5, furnace: { x: 2, y: 64, z: 0 }, dimension, serverProfileId: server },

  "build.blueprint": { blueprint: { anchor: { x: 100, y: 64, z: 100 }, dimension, serverProfileId: server, cells: [{ offset: { x: 0, y: 0, z: 0 }, itemName: "cobblestone", blockClass: "foundation", order: 0 }] }, startIndex: 0, maxPlacements: 1, availableMaterials: [{ itemName: "cobblestone", count: 1 }] },
  "stock.levels": { levels: [{ itemName: "obsidian", low: 8, target: 16, ceiling: 32 }], counts: [{ itemName: "obsidian", count: 4 }] },
  "store.sort": { routes: [{ itemName: "cobblestone", count: 1, container: { x: 3, y: 64, z: 0 }, dimension, serverProfileId: server }], startIndex: 0, maxTransfers: 1 },
  "pack.shulker": { shulker: { x: 3, y: 64, z: 0 }, items: [{ itemName: "cobblestone", count: 1 }], dimension, serverProfileId: server, startIndex: 0, maxTransfers: 1 },
  "movement.profile": { profile: "SAFE", serverProfileId: server },
  "farm.maintain": { area: { serverProfileId: server, dimension, min: { x: 0, y: 64, z: 0 }, max: { x: 2, y: 64, z: 2 } }, crops: ["wheat"] },
  "farm.sustain": { serverProfileId: server, dimension, center: { x: 0, y: 64, z: 0 }, seedReserve: 8, foodReserve: 8 },
  "movement.goal": { serverProfileId: server, dimension, clauses: [{ kind: "near", position: { x: 4, y: 64, z: 0 } }] },
  "movement.follow": { serverProfileId: server, dimension, entityId: 10, durationMs: 1000 },
  "movement.get-to-block": { serverProfileId: server, dimension, blockName: "crafting_table" },
  "world.explore": { serverProfileId: server, dimension, center: { x: 0, z: 0 }, radiusChunks: 1 },
  "build.clear-area": { area: { serverProfileId: server, dimension, min: { x: 2, y: 64, z: 0 }, max: { x: 2, y: 65, z: 0 } }, blockNames: ["stone"] },
  "movement.elytra": { serverProfileId: server, dimension, target: { x: 30, y: 64, z: 0 } },
  "trade.villager": { villagerEntityId: "villager-1", wantItem: "emerald", maxUnitPrice: 16, maxTrades: 1, dimension, serverProfileId: server },
  "mine.branch": { targetItem: "minecraft:diamond", yLevel: -50, branchLength: 4, branchSpacing: 2, maxBlocks: 8, origin: { x: 100, y: -50, z: 200 }, dimension, serverProfileId: server, backfill: true, exclusions: ["own-hideout", "blueprint-anchor", "load-bearing", "liquid-adjacent"] },
  "mine.vein": { targetItem: "minecraft:diamond", yLevel: -50, maxBlocks: 8, origin: { x: 100, y: -50, z: 200 }, orePositions: [{ x: 101, y: -50, z: 200 }], dimension, serverProfileId: server, backfill: true, exclusions: ["own-hideout", "blueprint-anchor", "load-bearing", "liquid-adjacent"] },
  "site.assess": { candidate: { x: 12_000, y: 64, z: 13_000, dimension, serverProfileId: server }, ownRecords: [], policy: { minSpawnDistance: 10_000, minAxisDistance: 2_000, minHighwayDistance: 1_000, minPortalLineDistance: 512, coordinateGridSize: 1_000, minCoordinateGridOffset: 96, symmetryTolerance: 64, hazardClearance: 64, hideoutSeparation: 10_000, burialDepthTarget: 24, escapeRouteTarget: 2, acceptanceScore: 0.62, verified: false, verificationNote: "未实测" }, observedAt: "2026-08-23T00:00:00.000Z", staleAfterMs: 60_000 },
  "shelter.dig": { direction: "north", depth: 2, sealItemName: "cobblestone", dimension, serverProfileId: server },
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

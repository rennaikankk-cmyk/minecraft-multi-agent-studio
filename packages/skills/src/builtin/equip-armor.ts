import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// Provenance: the "always wear the best armor available" mechanism is common to
// several GPL-3.0 plugins (@nxg-org/mineflayer-auto-armor, mineflayer-armor-
// manager). Per AGENTS.md §2 / combat-tactics-reference §14 we only reference
// the MECHANISM (rank each piece per slot, equip the best, keep the current one
// on ties). The ranking table and decision code below are original TypeScript;
// no GPL source is copied. The decision lives here (testable, deterministic);
// the runtime capability layer only supplies primitives (what is equipped, what
// candidates exist, perform one equip).
// ---------------------------------------------------------------------------

export const EQUIP_ARMOR_TIMEOUT_MS = 8_000;

export const ARMOR_SLOTS = ["head", "torso", "legs", "feet"] as const;
export type ArmorSlot = (typeof ARMOR_SLOTS)[number];

/**
 * Defense-point ranking, re-authored from public Minecraft armor values. Higher
 * is better. Used only to decide *which of the candidates a bot already owns* is
 * best for a slot — never to fabricate items.
 */
export const ARMOR_SCORE: Readonly<Record<string, number>> = {
  leather_helmet: 1,
  leather_chestplate: 3,
  leather_leggings: 2,
  leather_boots: 1,
  golden_helmet: 2,
  golden_chestplate: 5,
  golden_leggings: 3,
  golden_boots: 1,
  chainmail_helmet: 2,
  chainmail_chestplate: 5,
  chainmail_leggings: 4,
  chainmail_boots: 1,
  iron_helmet: 2,
  iron_chestplate: 6,
  iron_leggings: 5,
  iron_boots: 2,
  turtle_helmet: 2,
  diamond_helmet: 3,
  diamond_chestplate: 8,
  diamond_leggings: 6,
  diamond_boots: 3,
  netherite_helmet: 3,
  netherite_chestplate: 8,
  netherite_leggings: 6,
  netherite_boots: 3,
};

export function armorScore(itemName: string | null): number {
  if (!itemName) return 0;
  return ARMOR_SCORE[itemName] ?? 0;
}

const armorSlotSchema = z.enum(ARMOR_SLOTS);

const armorItemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

// --- skill input / state / output ------------------------------------------

export const equipArmorInputSchema = z
  .object({
    // Server-isolation discipline (AGENTS.md §0.2): every actuated skill carries
    // the ServerProfile it was authorized against, and refuses to run if the bot
    // is connected to a different profile.
    serverProfileId: identifierSchema,
  })
  .strict();

export const equipArmorStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
  })
  // The runtime supplies one shared skill-state object (it also carries the
  // bot position, which this skill does not use). Strip unknown keys instead of
  // strict-rejecting so the shared state validates for every skill.
  .strip();

const slotOutcomeSchema = z
  .object({
    slot: armorSlotSchema,
    before: armorItemNameSchema.nullable(),
    after: armorItemNameSchema.nullable(),
    action: z.enum(["equipped", "kept", "none-available"]),
    beforeScore: z.number().int().min(0).max(16),
    afterScore: z.number().int().min(0).max(16),
  })
  .strict();

export const equipArmorOutputSchema = z
  .object({
    slots: z.array(slotOutcomeSchema).length(ARMOR_SLOTS.length),
    changedCount: z.number().int().min(0).max(ARMOR_SLOTS.length),
    capabilityCallCount: z.number().int().min(1),
    totalScoreBefore: z.number().int().min(0).max(64),
    totalScoreAfter: z.number().int().min(0).max(64),
  })
  .strict();

// --- capability contracts (client-side primitives) --------------------------

const snapshotSlotSchema = z
  .object({
    slot: armorSlotSchema,
    equipped: armorItemNameSchema.nullable(),
    candidates: z.array(armorItemNameSchema).max(128),
  })
  .strict();

export const armorSnapshotCapabilityInputSchema = z
  .object({ serverProfileId: identifierSchema })
  .strict();

export const armorSnapshotCapabilityOutputSchema = z
  .object({
    serverProfileId: identifierSchema,
    slots: z.array(snapshotSlotSchema).length(ARMOR_SLOTS.length),
  })
  .strict();

export const armorEquipCapabilityInputSchema = z
  .object({
    serverProfileId: identifierSchema,
    slot: armorSlotSchema,
    itemName: armorItemNameSchema,
  })
  .strict();

export const armorEquipCapabilityOutputSchema = z
  .object({
    equipped: z.boolean(),
    slot: armorSlotSchema,
    itemName: armorItemNameSchema,
  })
  .strict();

type EquipArmorInput = z.infer<typeof equipArmorInputSchema>;
type ArmorSnapshotOutput = z.infer<typeof armorSnapshotCapabilityOutputSchema>;

/**
 * Pure decision: for one slot, choose the best-scoring item among the equipped
 * piece and the owned candidates. Returns the chosen item name and whether it
 * differs from what is currently equipped (i.e. whether an equip is needed).
 * Ties keep the currently-equipped piece to avoid needless inventory churn.
 */
export function decideSlot(slot: {
  equipped: string | null;
  candidates: readonly string[];
}): { best: string | null; bestScore: number; needsEquip: boolean } {
  const equippedScore = armorScore(slot.equipped);
  let best = slot.equipped;
  let bestScore = equippedScore;
  for (const candidate of slot.candidates) {
    const score = armorScore(candidate);
    // Strictly greater — a tie never displaces what is already worn.
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return {
    best,
    bestScore,
    needsEquip: best !== null && best !== slot.equipped,
  };
}

export const equipArmorSkill = defineSkill({
  id: "inventory.equip-armor",
  version: "1.0.0",
  inputSchema: equipArmorInputSchema,
  outputSchema: equipArmorOutputSchema,
  stateSchema: equipArmorStateSchema,
  requiredCapabilities: ["inventory.read", "inventory.write"] as const,
  timeoutMs: EQUIP_ARMOR_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 50,
    maxDelayMs: 250,
    retryableErrorCodes: [],
  },
  preconditions: [
    {
      id: "bot.online",
      failureCode: "BOT_NOT_ONLINE",
      check: (_input, state) => state.online,
    },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input, state) => state.normalActionsAllowed,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
  ],
  execute: async (context, input: EquipArmorInput) => {
    const snapshotRaw = await context.callCapability(
      "inventory.read",
      "armor.snapshot",
      armorSnapshotCapabilityInputSchema.parse({
        serverProfileId: input.serverProfileId,
      }),
    );
    const snapshot: ArmorSnapshotOutput =
      armorSnapshotCapabilityOutputSchema.parse(snapshotRaw);

    // The client already refused if connected to another profile, but we verify
    // the echoed id too so a mismatched capability layer can never slip through.
    if (snapshot.serverProfileId !== input.serverProfileId) {
      throw new Error("TARGET_SERVER_PROFILE_MISMATCH");
    }

    let capabilityCallCount = 1;
    const outcomes: z.infer<typeof slotOutcomeSchema>[] = [];

    for (const slotName of ARMOR_SLOTS) {
      const slotState =
        snapshot.slots.find((entry) => entry.slot === slotName) ?? {
          slot: slotName,
          equipped: null,
          candidates: [],
        };
      const before = slotState.equipped;
      const beforeScore = armorScore(before);
      const decision = decideSlot(slotState);

      if (!decision.needsEquip) {
        outcomes.push({
          slot: slotName,
          before,
          after: before,
          action: before === null && decision.best === null
            ? "none-available"
            : "kept",
          beforeScore,
          afterScore: beforeScore,
        });
        continue;
      }

      const equipResultRaw = await context.callCapability(
        "inventory.write",
        "armor.equip",
        armorEquipCapabilityInputSchema.parse({
          serverProfileId: input.serverProfileId,
          slot: slotName,
          itemName: decision.best,
        }),
      );
      capabilityCallCount += 1;
      const equipResult =
        armorEquipCapabilityOutputSchema.parse(equipResultRaw);

      const after = equipResult.equipped ? equipResult.itemName : before;
      outcomes.push({
        slot: slotName,
        before,
        after,
        action: equipResult.equipped ? "equipped" : "kept",
        beforeScore,
        afterScore: armorScore(after),
      });
    }

    const changedCount = outcomes.filter(
      (entry) => entry.action === "equipped",
    ).length;
    const totalScoreBefore = outcomes.reduce(
      (sum, entry) => sum + entry.beforeScore,
      0,
    );
    const totalScoreAfter = outcomes.reduce(
      (sum, entry) => sum + entry.afterScore,
      0,
    );

    return equipArmorOutputSchema.parse({
      slots: outcomes,
      changedCount,
      capabilityCallCount,
      totalScoreBefore,
      totalScoreAfter,
    });
  },
});

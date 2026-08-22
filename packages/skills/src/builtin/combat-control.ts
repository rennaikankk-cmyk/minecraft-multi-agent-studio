import {
  identifierSchema,
  skillErrorCodeSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";

export const COMBAT_CONTROL_TIMEOUT_MS = 1_000;

const timestampMsSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const combatControlDispositionSchema = z.enum([
  "executed",
  "clipped",
  "delayed",
  "dropped",
  "modified",
]);

export const combatControlActualActionSchema = z.enum([
  "ENGAGE",
  "DISENGAGE",
  "RETREAT",
  "NONE",
]);

/**
 * The control-plane request deliberately carries no entity, aim, movement, or
 * whitelist field. Target selection and all concrete combat mechanics remain
 * inside the deterministic runtime driver.
 */
export const combatControlInputSchema = z
  .object({
    serverProfileId: identifierSchema,
  })
  .strict();

export const combatControlStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    combatAvailable: z.boolean(),
    combatObservationAvailable: z.boolean(),
  })
  // Runtime passes one shared state snapshot. Unknown sibling-skill fields are
  // stripped so adding another observation cannot invalidate combat control.
  .strip();

const combatActualSchema = z
  .object({
    disposition: combatControlDispositionSchema,
    action: combatControlActualActionSchema,
    executedAtMs: timestampMsSchema.nullable(),
    reasonCode: skillErrorCodeSchema.nullable(),
    targetEntityId: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();

function combatOutputSchemaFor<
  TRequested extends "ENGAGE" | "DISENGAGE",
>(
  requestedAction: TRequested,
  allowedActualActions: ReadonlySet<z.infer<typeof combatControlActualActionSchema>>,
) {
  return z
    .object({
      requested: z
        .object({
          action: z.literal(requestedAction),
          requestedAtMs: timestampMsSchema,
        })
        .strict(),
      actual: combatActualSchema,
    })
    .strict()
    .superRefine((receipt, context) => {
      if (!allowedActualActions.has(receipt.actual.action)) {
        context.addIssue({
          code: "custom",
          path: ["actual", "action"],
          message: "Actual combat action is incompatible with the requested intent.",
        });
      }

      const wasSent = ["executed", "clipped", "modified"].includes(
        receipt.actual.disposition,
      );
      if (wasSent && receipt.actual.executedAtMs === null) {
        context.addIssue({
          code: "custom",
          path: ["actual", "executedAtMs"],
          message: "An executed combat action requires its actual execution time.",
        });
      }
      if (!wasSent && receipt.actual.executedAtMs !== null) {
        context.addIssue({
          code: "custom",
          path: ["actual", "executedAtMs"],
          message: "A delayed or dropped action cannot claim an execution time.",
        });
      }
      if (
        receipt.actual.executedAtMs !== null &&
        receipt.actual.executedAtMs < receipt.requested.requestedAtMs
      ) {
        context.addIssue({
          code: "custom",
          path: ["actual", "executedAtMs"],
          message: "Execution cannot precede the recorded request.",
        });
      }
      if (receipt.actual.disposition === "dropped" && receipt.actual.action !== "NONE") {
        context.addIssue({
          code: "custom",
          path: ["actual", "action"],
          message: "A dropped request must report that no action was executed.",
        });
      }
      if (wasSent && receipt.actual.action === "NONE") {
        context.addIssue({
          code: "custom",
          path: ["actual", "action"],
          message: "An executed disposition must identify the actual action.",
        });
      }
      if (receipt.actual.disposition !== "executed" && receipt.actual.reasonCode === null) {
        context.addIssue({
          code: "custom",
          path: ["actual", "reasonCode"],
          message: "A changed, delayed, or dropped request requires a reason code.",
        });
      }
    });
}

export const combatEngageOutputSchema = combatOutputSchemaFor(
  "ENGAGE",
  new Set(["ENGAGE", "RETREAT", "NONE"]),
);

export const combatDisengageOutputSchema = combatOutputSchemaFor(
  "DISENGAGE",
  new Set(["DISENGAGE", "RETREAT", "NONE"]),
);

export const combatEngageCapabilityInputSchema = combatControlInputSchema;
export const combatDisengageCapabilityInputSchema = combatControlInputSchema;
export const combatEngageCapabilityOutputSchema = combatEngageOutputSchema;
export const combatDisengageCapabilityOutputSchema = combatDisengageOutputSchema;

type CombatControlInput = z.infer<typeof combatControlInputSchema>;

const onlinePrecondition = {
  id: "bot.online",
  failureCode: "BOT_NOT_ONLINE",
  check: (_input: CombatControlInput, state: z.infer<typeof combatControlStateSchema>) =>
    state.online,
} as const;

const normalActionsPrecondition = {
  id: "l0.normal-actions-allowed",
  failureCode: "NORMAL_ACTIONS_PAUSED",
  check: (_input: CombatControlInput, state: z.infer<typeof combatControlStateSchema>) =>
    state.normalActionsAllowed,
} as const;

const serverProfilePrecondition = {
  id: "target.server-profile-matches",
  failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
  check: (input: CombatControlInput, state: z.infer<typeof combatControlStateSchema>) =>
    input.serverProfileId === state.serverProfileId,
} as const;

const combatDriverPrecondition = {
  id: "combat.driver-available",
  failureCode: "COMBAT_DRIVER_UNAVAILABLE",
  check: (_input: CombatControlInput, state: z.infer<typeof combatControlStateSchema>) =>
    state.combatAvailable,
} as const;

const engagePreconditions = [
  onlinePrecondition,
  normalActionsPrecondition,
  serverProfilePrecondition,
  combatDriverPrecondition,
  {
    id: "combat.observation-available",
    failureCode: "COMBAT_OBSERVATION_UNAVAILABLE",
    check: (_input: CombatControlInput, state: z.infer<typeof combatControlStateSchema>) =>
      state.combatObservationAvailable,
  },
] as const;

const disengagePreconditions = [
  onlinePrecondition,
  serverProfilePrecondition,
  combatDriverPrecondition,
] as const;

function parseCombatReceipt<T>(
  schema: z.ZodType<T>,
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SkillFault("COMBAT_EXECUTION_RECEIPT_INVALID");
  }
  return parsed.data;
}

export const combatEngageSkill = defineSkill({
  id: "combat.engage",
  version: "1.0.0",
  inputSchema: combatControlInputSchema,
  outputSchema: combatEngageOutputSchema,
  stateSchema: combatControlStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["combat.control"] as const,
  timeoutMs: COMBAT_CONTROL_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 50,
    maxDelayMs: 250,
    retryableErrorCodes: [],
  },
  preconditions: engagePreconditions,
  execute: async (context, input) => {
    const receipt = await context.callCapability(
      "combat.control",
      "combat.engage",
      combatEngageCapabilityInputSchema.parse(input),
    );
    return parseCombatReceipt(combatEngageCapabilityOutputSchema, receipt);
  },
});

export const combatDisengageSkill = defineSkill({
  id: "combat.disengage",
  version: "1.0.0",
  inputSchema: combatControlInputSchema,
  outputSchema: combatDisengageOutputSchema,
  stateSchema: combatControlStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: ["combat.control"] as const,
  timeoutMs: COMBAT_CONTROL_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 50,
    maxDelayMs: 250,
    retryableErrorCodes: [],
  },
  preconditions: disengagePreconditions,
  execute: async (context, input) => {
    const receipt = await context.callCapability(
      "combat.control",
      "combat.disengage",
      combatDisengageCapabilityInputSchema.parse(input),
    );
    return parseCombatReceipt(combatDisengageCapabilityOutputSchema, receipt);
  },
});

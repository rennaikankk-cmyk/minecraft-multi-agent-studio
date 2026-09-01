import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillAbortError, SkillFault } from "../errors.js";
import {
  GoalPlanner,
  MAX_GOAL_COUNT,
  MAX_PLAN_STEPS,
  type PlannerInventory,
  type PlanStep,
} from "../planning/goal-planner.js";
import {
  MAX_ATTEMPTS_PER_STEP,
  PlanSupervisor,
} from "../recovery/plan-supervisor.js";
import { defineSkill, type SkillExecutionContext } from "../types.js";
import {
  COLLECT_MAX_COUNT,
  collectBlockCapabilityOutputSchema,
} from "./collect-block.js";
import {
  CRAFT_CAPABILITY_MAX_COUNT,
  craftItemCapabilityOutputSchema,
} from "./craft-item.js";
import {
  SMELT_MAX_COUNT,
  smeltItemCapabilityInputSchema,
  smeltItemCapabilityOutputSchema,
} from "./smelt-item.js";

export const ENSURE_ITEM_TIMEOUT_MS = 120_000;
export const INVENTORY_SNAPSHOT_MAX_ITEM_TYPES = 128;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const ensureItemInputSchema = z
  .object({
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(MAX_GOAL_COUNT),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const ensureItemStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const inventorySnapshotCapabilityInputSchema = z
  .object({
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    maxItemTypes: z
      .number()
      .int()
      .min(1)
      .max(INVENTORY_SNAPSHOT_MAX_ITEM_TYPES),
  })
  .strict();

const inventorySnapshotItemSchema = z
  .object({
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const inventorySnapshotCapabilityOutputSchema = z
  .object({
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    worldStateVersion: z.number().int().nonnegative(),
    items: z
      .array(inventorySnapshotItemSchema)
      .max(INVENTORY_SNAPSHOT_MAX_ITEM_TYPES)
      .refine(
        (items) =>
          new Set(items.map(({ itemName }) => itemName)).size === items.length,
        { message: "Inventory snapshot item names must be unique." },
      ),
  })
  .strict();

/**
 * The high-level loop deliberately passes `null`. Furnace discovery, reuse,
 * creation and placement belong to the runtime's single ensure/reuse path.
 */
export const ensureItemSmeltCapabilityInputSchema =
  smeltItemCapabilityInputSchema;

export const closedLoopSkillStatuses = [
  "SUCCESS",
  "RUNNING",
  "RETRY",
  "BLOCKED",
  "FAILED",
  "CANCELLED",
] as const;

export const closedLoopSkillStatusSchema = z.enum(closedLoopSkillStatuses);

const inventoryDeltaEntrySchema = z
  .object({
    itemName: itemNameSchema,
    beforeCount: z.number().int().nonnegative(),
    afterCount: z.number().int().nonnegative(),
    delta: z.number().int(),
  })
  .strict();

const ensureItemStepEvidenceSchema = z
  .object({
    stepIndex: z.number().int().min(0).max(MAX_PLAN_STEPS),
    attempt: z.number().int().min(0).max(MAX_ATTEMPTS_PER_STEP),
    kind: z.enum([
      "precheck",
      "mine",
      "craft",
      "smelt",
      "trade",
      "place-station",
    ]),
    itemName: itemNameSchema,
    action: z.enum([
      "goal-short-circuit",
      "inventory-postcondition",
      "collect.blocks-safe",
      "craft.item-safe",
      "smelt.item-safe",
      "station.ensure-delegated",
    ]),
    beforeCount: z.number().int().nonnegative(),
    expectedMinimumCount: z.number().int().nonnegative(),
    afterCount: z.number().int().nonnegative(),
    worldStateVersionBefore: z.number().int().nonnegative(),
    worldStateVersionAfter: z.number().int().nonnegative(),
    verified: z.boolean(),
  })
  .strict();

export const ensureItemOutputSchema = z
  .object({
    status: z.literal("SUCCESS"),
    reason: z.enum(["GOAL_ALREADY_SATISFIED", "GOAL_POSTCONDITION_VERIFIED"]),
    progress: z
      .object({
        completedSteps: z.number().int().nonnegative(),
        totalSteps: z.number().int().nonnegative(),
        targetCount: z.number().int().min(1).max(MAX_GOAL_COUNT),
        actualCount: z.number().int().nonnegative(),
      })
      .strict(),
    retryable: z.literal(false),
    worldDelta: z
      .object({
        fromVersion: z.number().int().nonnegative(),
        toVersion: z.number().int().nonnegative(),
      })
      .strict(),
    inventoryDelta: z.array(inventoryDeltaEntrySchema).max(INVENTORY_SNAPSHOT_MAX_ITEM_TYPES),
    nextSuggestedAction: z.null(),
    metrics: z
      .object({
        planSteps: z.number().int().nonnegative().max(MAX_PLAN_STEPS),
        stepsCompleted: z.number().int().nonnegative(),
        repairStepsInserted: z.number().int().nonnegative(),
        retries: z.number().int().nonnegative(),
        recoveries: z.number().int().nonnegative(),
        capabilityCalls: z.number().int().nonnegative(),
        actionCalls: z.number().int().nonnegative(),
        inventorySnapshots: z.number().int().positive(),
        stationStepsDelegated: z.number().int().nonnegative(),
        llmRequests: z.literal(0),
      })
      .strict(),
    evidence: z
      .array(ensureItemStepEvidenceSchema)
      .max(MAX_PLAN_STEPS * MAX_ATTEMPTS_PER_STEP),
    verification: z
      .object({
        itemName: itemNameSchema,
        expectedMinimumCount: z.number().int().min(1).max(MAX_GOAL_COUNT),
        actualCount: z.number().int().nonnegative(),
        verified: z.literal(true),
        worldStateVersion: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

type EnsureItemInput = z.infer<typeof ensureItemInputSchema>;
type InventorySnapshot = z.infer<typeof inventorySnapshotCapabilityOutputSchema>;
type StepEvidence = z.infer<typeof ensureItemStepEvidenceSchema>;

const SAFETY_WAIT_POLL_MS = 100;
const MAX_SAFETY_WAIT_POLLS = Math.ceil(
  ENSURE_ITEM_TIMEOUT_MS / SAFETY_WAIT_POLL_MS,
);
const SAFETY_INTERRUPT_CODES = new Set([
  "NORMAL_ACTIONS_PAUSED",
  "SKILL_EXECUTION_INTERRUPTED",
]);

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof SkillAbortError) throw signal.reason;
  throw new SkillAbortError("SKILL_CANCELLED");
}

function abortableDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      try {
        throwIfAborted(signal);
      } catch (error) {
        reject(error);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function countOf(snapshot: InventorySnapshot, itemName: string): number {
  return snapshot.items.find((item) => item.itemName === itemName)?.count ?? 0;
}

function toPlannerInventory(snapshot: InventorySnapshot): PlannerInventory {
  return Object.freeze(
    Object.fromEntries(snapshot.items.map(({ itemName, count }) => [itemName, count])),
  );
}

function inventoryDelta(
  before: InventorySnapshot,
  after: InventorySnapshot,
): readonly z.infer<typeof inventoryDeltaEntrySchema>[] {
  const names = new Set([
    ...before.items.map(({ itemName }) => itemName),
    ...after.items.map(({ itemName }) => itemName),
  ]);
  return Object.freeze(
    [...names]
      .sort()
      .map((itemName) => {
        const beforeCount = countOf(before, itemName);
        const afterCount = countOf(after, itemName);
        return Object.freeze({
          itemName,
          beforeCount,
          afterCount,
          delta: afterCount - beforeCount,
        });
      })
      .filter(({ delta }) => delta !== 0),
  );
}

function missingForStep(
  step: PlanStep,
  snapshot: InventorySnapshot,
  expectedCount: number,
): readonly Readonly<{ itemName: string; count: number }>[] {
  if (step.runs < 1 || step.producedCount < 1) return Object.freeze([]);
  const remainingOutput = Math.max(0, expectedCount - countOf(snapshot, step.itemName));
  const yieldPerRun = step.producedCount / step.runs;
  const remainingRuns = Math.min(
    step.runs,
    Math.ceil(remainingOutput / yieldPerRun),
  );
  return Object.freeze(
    step.consumes
      .map(({ itemName, count }) => {
        const needed = Math.ceil((count / step.runs) * remainingRuns);
        return {
          itemName,
          count: Math.max(0, needed - countOf(snapshot, itemName)),
        };
      })
      .filter(({ count }) => count > 0),
  );
}

function capabilityErrorCode(error: unknown): string {
  if (error instanceof SkillFault) return error.code;
  return "SKILL_HANDLER_FAILED";
}

export const ensureItemSkill = defineSkill({
  id: "goal.ensure-item",
  version: "1.0.0",
  inputSchema: ensureItemInputSchema,
  outputSchema: ensureItemOutputSchema,
  stateSchema: ensureItemStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  requiredCapabilities: [
    "inventory.read",
    "world.interact",
    "craft.execute",
  ] as const,
  timeoutMs: ENSURE_ITEM_TIMEOUT_MS,
  // Every mutation is guarded by a real inventory minimum and every ambiguous
  // failure is read back before retrying.
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
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
  ],
  execute: async (context, input) => {
    const planner = new GoalPlanner();
    const supervisor = new PlanSupervisor(planner);
    const evidence: StepEvidence[] = [];
    const expectedByStep = new Map<PlanStep, number>();
    let inventorySnapshots = 0;
    let capabilityCalls = 0;
    let actionCalls = 0;
    let stationStepsDelegated = 0;
    let goalReached = false;
    let safetyWaitPolls = 0;

    const snapshot = async (): Promise<InventorySnapshot> => {
      for (;;) {
        throwIfAborted(context.signal);
        capabilityCalls += 1;
        inventorySnapshots += 1;
        try {
          const raw = await context.callCapability(
            "inventory.read",
            "inventory.snapshot",
            inventorySnapshotCapabilityInputSchema.parse({
              dimension: input.dimension,
              serverProfileId: input.serverProfileId,
              maxItemTypes: INVENTORY_SNAPSHOT_MAX_ITEM_TYPES,
            }),
          );
          const parsed = inventorySnapshotCapabilityOutputSchema.safeParse(raw);
          if (!parsed.success) throw new SkillFault("INVENTORY_SNAPSHOT_INVALID");
          if (
            parsed.data.serverProfileId !== input.serverProfileId ||
            parsed.data.dimension !== input.dimension
          ) {
            throw new SkillFault("INVENTORY_SNAPSHOT_SCOPE_MISMATCH");
          }
          return parsed.data;
        } catch (error) {
          throwIfAborted(context.signal);
          if (
            !(error instanceof SkillFault) ||
            !SAFETY_INTERRUPT_CODES.has(error.code)
          ) {
            throw error;
          }
          safetyWaitPolls += 1;
          if (safetyWaitPolls > MAX_SAFETY_WAIT_POLLS) throw error;
          await abortableDelay(SAFETY_WAIT_POLL_MS, context.signal);
        }
      }
    };

    const callAction = async <T>(
      capability: "world.interact" | "craft.execute",
      operation: string,
      capabilityInput: Parameters<SkillExecutionContext["callCapability"]>[2],
      outputSchema: z.ZodType<T>,
    ): Promise<T> => {
      throwIfAborted(context.signal);
      capabilityCalls += 1;
      actionCalls += 1;
      const raw = await context.callCapability(capability, operation, capabilityInput);
      const parsed = outputSchema.safeParse(raw);
      if (!parsed.success) throw new SkillFault("SKILL_CAPABILITY_OUTPUT_INVALID");
      return parsed.data;
    };

    const initial = await snapshot();
    const initialCount = countOf(initial, input.itemName);
    if (initialCount >= input.count) {
      evidence.push({
        stepIndex: 0,
        attempt: 0,
        kind: "precheck",
        itemName: input.itemName,
        action: "goal-short-circuit",
        beforeCount: initialCount,
        expectedMinimumCount: input.count,
        afterCount: initialCount,
        worldStateVersionBefore: initial.worldStateVersion,
        worldStateVersionAfter: initial.worldStateVersion,
        verified: true,
      });
      return ensureItemOutputSchema.parse({
        status: "SUCCESS",
        reason: "GOAL_ALREADY_SATISFIED",
        progress: {
          completedSteps: 0,
          totalSteps: 0,
          targetCount: input.count,
          actualCount: initialCount,
        },
        retryable: false,
        worldDelta: {
          fromVersion: initial.worldStateVersion,
          toVersion: initial.worldStateVersion,
        },
        inventoryDelta: [],
        nextSuggestedAction: null,
        metrics: {
          planSteps: 0,
          stepsCompleted: 0,
          repairStepsInserted: 0,
          retries: 0,
          recoveries: 0,
          capabilityCalls,
          actionCalls,
          inventorySnapshots,
          stationStepsDelegated: 0,
          llmRequests: 0,
        },
        evidence,
        verification: {
          itemName: input.itemName,
          expectedMinimumCount: input.count,
          actualCount: initialCount,
          verified: true,
          worldStateVersion: initial.worldStateVersion,
        },
      });
    }

    const plan = planner.plan(
      [{ itemName: input.itemName, count: input.count }],
      toPlannerInventory(initial),
    );
    if (!plan.planned) throw new SkillFault(plan.errorCode);

    // A station preparation pair is an implementation detail of the old
    // linear plan. Placement is delegated to the next safe craft/smelt
    // capability, which owns scanning, reuse and duplicate guards. Only a
    // crafting table may also delegate its craft: the craft capability can
    // create one itself. A furnace must exist in inventory before the smelt
    // capability can safely place or reuse it.
    const delegatedStations = new Set(
      plan.steps
        .filter((step) => step.kind === "place-station")
        .map((step) => step.itemName),
    );

    const executeStep = async (step: PlanStep, attempt: number) => {
      throwIfAborted(context.signal);
      const before = await snapshot();
      const beforeCount = countOf(before, step.itemName);

      if (goalReached || countOf(before, input.itemName) >= input.count) {
        goalReached = true;
        evidence.push({
          stepIndex: step.stepIndex,
          attempt,
          kind: step.kind,
          itemName: step.itemName,
          action: "goal-short-circuit",
          beforeCount,
          expectedMinimumCount: beforeCount,
          afterCount: beforeCount,
          worldStateVersionBefore: before.worldStateVersion,
          worldStateVersionAfter: before.worldStateVersion,
          verified: true,
        });
        return { ok: true } as const;
      }

      if (
        // A station placement is a planning artefact when it prepares a later
        // safe capability. If the user's goal is the table itself, its craft
        // step remains the goal and must execute and be verified.
        step.kind === "place-station" ||
        (step.kind === "craft" &&
          step.itemName === "crafting_table" &&
          delegatedStations.has(step.itemName) &&
          step.itemName !== input.itemName)
      ) {
        const after = await snapshot();
        stationStepsDelegated += 1;
        evidence.push({
          stepIndex: step.stepIndex,
          attempt,
          kind: step.kind,
          itemName: step.itemName,
          action: "station.ensure-delegated",
          beforeCount,
          expectedMinimumCount: 0,
          afterCount: countOf(after, step.itemName),
          worldStateVersionBefore: before.worldStateVersion,
          worldStateVersionAfter: after.worldStateVersion,
          verified: true,
        });
        return { ok: true } as const;
      }

      const expectedCount =
        expectedByStep.get(step) ??
        beforeCount + step.producedCount;
      expectedByStep.set(step, expectedCount);

      if (beforeCount >= expectedCount) {
        evidence.push({
          stepIndex: step.stepIndex,
          attempt,
          kind: step.kind,
          itemName: step.itemName,
          action: "inventory-postcondition",
          beforeCount,
          expectedMinimumCount: expectedCount,
          afterCount: beforeCount,
          worldStateVersionBefore: before.worldStateVersion,
          worldStateVersionAfter: before.worldStateVersion,
          verified: true,
        });
        return { ok: true } as const;
      }

      const missing = missingForStep(step, before, expectedCount);
      if (missing.length > 0) {
        evidence.push({
          stepIndex: step.stepIndex,
          attempt,
          kind: step.kind,
          itemName: step.itemName,
          action: "inventory-postcondition",
          beforeCount,
          expectedMinimumCount: expectedCount,
          afterCount: beforeCount,
          worldStateVersionBefore: before.worldStateVersion,
          worldStateVersionAfter: before.worldStateVersion,
          verified: false,
        });
        return {
          ok: false,
          errorCode: "ITEM_NOT_IN_INVENTORY",
          missing,
        } as const;
      }

      let action: StepEvidence["action"] = "inventory-postcondition";
      try {
        if (step.kind === "mine") {
          action = "collect.blocks-safe";
          const yieldPerRun = step.producedCount / step.runs;
          const maximumCalls = Math.max(
            1,
            Math.ceil(step.runs / COLLECT_MAX_COUNT),
          );
          let observed = before;
          for (let call = 0; call < maximumCalls; call += 1) {
            const remaining = expectedCount - countOf(observed, step.itemName);
            if (remaining <= 0) break;
            const maxCount = Math.max(
              1,
              Math.min(COLLECT_MAX_COUNT, Math.ceil(remaining / yieldPerRun)),
            );
            const output = await callAction(
              "world.interact",
              "collect.blocks-safe",
              {
                blockName: step.targetBlock!,
                maxCount,
                maxDistance: 32,
                dimension: input.dimension,
                serverProfileId: input.serverProfileId,
              },
              collectBlockCapabilityOutputSchema,
            );
            if (output.blockName !== step.targetBlock) {
              throw new SkillFault("COLLECT_OUTPUT_MISMATCH");
            }
            const next = await snapshot();
            if (countOf(next, step.itemName) <= countOf(observed, step.itemName)) {
              observed = next;
              break;
            }
            observed = next;
          }
        } else if (step.kind === "craft") {
          action = "craft.item-safe";
          const output = await callAction(
            "craft.execute",
            "craft.item-safe",
            {
              itemName: step.itemName,
              count: Math.min(CRAFT_CAPABILITY_MAX_COUNT, expectedCount),
              craftingTable: null,
              dimension: input.dimension,
              serverProfileId: input.serverProfileId,
            },
            craftItemCapabilityOutputSchema,
          );
          if (output.itemName !== step.itemName) {
            throw new SkillFault("CRAFT_OUTPUT_MISMATCH");
          }
        } else if (step.kind === "smelt") {
          action = "smelt.item-safe";
          const fuelEntry = step.consumes.find(({ itemName }) =>
            step.fuelCandidates.includes(itemName),
          );
          const inputEntry = step.consumes.find(
            ({ itemName }) => itemName !== fuelEntry?.itemName,
          );
          if (fuelEntry === undefined || inputEntry === undefined) {
            throw new SkillFault("SMELT_PLAN_INPUT_INVALID");
          }
          const yieldPerRun = step.producedCount / step.runs;
          const maximumCalls = Math.max(1, Math.ceil(step.runs / SMELT_MAX_COUNT));
          let observed = before;
          for (let call = 0; call < maximumCalls; call += 1) {
            const remaining = expectedCount - countOf(observed, step.itemName);
            if (remaining <= 0) break;
            const count = Math.max(
              1,
              Math.min(SMELT_MAX_COUNT, Math.ceil(remaining / yieldPerRun)),
            );
            const fuelPerRun = fuelEntry.count / step.runs;
            const output = await callAction(
              "craft.execute",
              "smelt.item-safe",
              ensureItemSmeltCapabilityInputSchema.parse({
                inputItemName: inputEntry.itemName,
                fuelItemName: fuelEntry.itemName,
                fuelCount: Math.max(
                  1,
                  Math.min(SMELT_MAX_COUNT, Math.ceil(fuelPerRun * count)),
                ),
                count,
                furnace: null,
                dimension: input.dimension,
                serverProfileId: input.serverProfileId,
              }),
              smeltItemCapabilityOutputSchema,
            );
            if (output.outputItemName !== step.itemName) {
              throw new SkillFault("SMELT_OUTPUT_MISMATCH");
            }
            const next = await snapshot();
            if (countOf(next, step.itemName) <= countOf(observed, step.itemName)) {
              observed = next;
              break;
            }
            observed = next;
          }
        } else {
          // A deterministic item goal cannot invent a villager identity,
          // select an offer, or choose a price ceiling. Leave trade plans for
          // an explicitly grounded trade workflow.
          throw new SkillFault("TRADE_REQUIRES_GROUNDED_VILLAGER");
        }

        const after = await snapshot();
        const afterCount = countOf(after, step.itemName);
        const verified = afterCount >= expectedCount;
        evidence.push({
          stepIndex: step.stepIndex,
          attempt,
          kind: step.kind,
          itemName: step.itemName,
          action,
          beforeCount,
          expectedMinimumCount: expectedCount,
          afterCount,
          worldStateVersionBefore: before.worldStateVersion,
          worldStateVersionAfter: after.worldStateVersion,
          verified,
        });
        return verified
          ? ({ ok: true } as const)
          : ({
              ok: false,
              errorCode: "STEP_POSTCONDITION_NOT_CONFIRMED",
            } as const);
      } catch (error) {
        throwIfAborted(context.signal);
        // An action may have committed before its transport failed. Read back
        // before selecting recovery so an ambiguous success is never repeated.
        try {
          const after = await snapshot();
          const afterCount = countOf(after, step.itemName);
          const verified = afterCount >= expectedCount;
          evidence.push({
            stepIndex: step.stepIndex,
            attempt,
            kind: step.kind,
            itemName: step.itemName,
            action,
            beforeCount,
            expectedMinimumCount: expectedCount,
            afterCount,
            worldStateVersionBefore: before.worldStateVersion,
            worldStateVersionAfter: after.worldStateVersion,
            verified,
          });
          if (verified) return { ok: true } as const;
        } catch (readbackError) {
          throwIfAborted(context.signal);
          if (!(readbackError instanceof SkillFault)) throw readbackError;
        }
        return {
          ok: false,
          errorCode: capabilityErrorCode(error),
          ...(missing.length > 0 ? { missing } : {}),
        } as const;
      }
    };

    const supervision = await supervisor.run(
      plan.steps,
      executeStep,
      toPlannerInventory(initial),
      {
        // Every execution attempt already observes before acting. This hook
        // makes the supervisor's explicit reobserve rung equally concrete.
        reobserve: async () => {
          await snapshot();
        },
        waitForSafetyClear: async () => {
          await snapshot();
        },
      },
    );
    if (!supervision.completed) {
      throw new SkillFault(
        supervision.failure?.errorCode ?? "GOAL_EXECUTION_ABORTED",
      );
    }

    const final = await snapshot();
    const finalCount = countOf(final, input.itemName);
    if (finalCount < input.count) {
      throw new SkillFault("GOAL_POSTCONDITION_NOT_CONFIRMED");
    }
    const retries = supervision.events.filter(
      (event) =>
        event.kind === "step-started" &&
        (event.attempt > 1 || event.execution > 1),
    ).length;
    const recoveries = supervision.events.filter(
      (event) => event.kind === "recovery-selected",
    ).length;

    return ensureItemOutputSchema.parse({
      status: "SUCCESS",
      reason: "GOAL_POSTCONDITION_VERIFIED",
      progress: {
        completedSteps: supervision.stepsCompleted,
        totalSteps: plan.steps.length + supervision.repairStepsInserted,
        targetCount: input.count,
        actualCount: finalCount,
      },
      retryable: false,
      worldDelta: {
        fromVersion: initial.worldStateVersion,
        toVersion: final.worldStateVersion,
      },
      inventoryDelta: inventoryDelta(initial, final),
      nextSuggestedAction: null,
      metrics: {
        planSteps: plan.steps.length,
        stepsCompleted: supervision.stepsCompleted,
        repairStepsInserted: supervision.repairStepsInserted,
        retries,
        recoveries,
        capabilityCalls,
        actionCalls,
        inventorySnapshots,
        stationStepsDelegated,
        llmRequests: 0,
      },
      evidence,
      verification: {
        itemName: input.itemName,
        expectedMinimumCount: input.count,
        actualCount: finalCount,
        verified: true,
        worldStateVersion: final.worldStateVersion,
      },
    });
  },
});

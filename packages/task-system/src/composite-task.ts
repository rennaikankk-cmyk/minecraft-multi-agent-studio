import { z } from "zod";

export const compositeKindSchema = z.enum([
  "SURVIVAL_RESUPPLY",
  "BLUEPRINT_BUILD",
  "FOOD_FACILITY",
  "RESOURCE_PRODUCTION",
  "VILLAGER_ECONOMY",
  "MULTI_BOT_HANDOFF",
]);
export type CompositeKind = z.infer<typeof compositeKindSchema>;

export const compositeStatusSchema = z.enum(["PENDING", "RUNNING", "WAITING", "RECOVERING", "COMPLETED", "FAILED", "CANCELLED"]);
export type CompositeStatus = z.infer<typeof compositeStatusSchema>;

export const compositeTaskSchema = z.object({
  schemaVersion: z.literal("1.0"),
  taskId: z.string().uuid(),
  kind: compositeKindSchema,
  status: compositeStatusSchema,
  serverProfileId: z.string().min(1),
  dimension: z.string().min(3),
  botIds: z.array(z.string().min(1)).min(1).max(64),
  currentPhase: z.string().min(1).max(64),
  completedPhases: z.array(z.string().min(1).max(64)).max(128),
  checkpoint: z.object({
    revision: z.number().int().nonnegative(),
    cursor: z.number().int().nonnegative().nullable(),
    evidence: z.array(z.string().min(1).max(256)).max(32),
    updatedAtMs: z.number().int().nonnegative(),
  }).strict(),
  dependencies: z.array(z.string().uuid()).max(64),
  leaseOwner: z.string().min(1).nullable(),
  fencingToken: z.number().int().nonnegative().nullable(),
  lastErrorCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/u).nullable(),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();
export type CompositeTask = z.infer<typeof compositeTaskSchema>;

export function advanceCompositeTask(task: CompositeTask, input: Readonly<{
  phase: string;
  status: CompositeStatus;
  nowMs: number;
  cursor?: number | null;
  evidence?: readonly string[];
  errorCode?: string | null;
}>): CompositeTask {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < task.updatedAtMs) throw new RangeError("composite task clock moved backwards");
  if (input.phase.trim().length === 0) throw new TypeError("composite phase is required");
  if (input.status === "COMPLETED" && input.phase !== task.currentPhase && !task.completedPhases.includes(task.currentPhase)) throw new Error("COMPOSITE_PHASE_NOT_CHECKPOINTED");
  const completedPhases = input.status === "COMPLETED"
    ? [...new Set([...task.completedPhases, input.phase])]
    : task.completedPhases;
  return compositeTaskSchema.parse({
    ...task,
    status: input.status,
    currentPhase: input.phase,
    completedPhases,
    checkpoint: {
      revision: task.checkpoint.revision + 1,
      cursor: input.cursor === undefined ? task.checkpoint.cursor : input.cursor,
      evidence: [...new Set([...
        task.checkpoint.evidence,
        ...(input.evidence ?? []),
      ])].slice(-32),
      updatedAtMs: input.nowMs,
    },
    lastErrorCode: input.errorCode ?? (input.status === "FAILED" ? task.lastErrorCode : null),
    updatedAtMs: input.nowMs,
  });
}

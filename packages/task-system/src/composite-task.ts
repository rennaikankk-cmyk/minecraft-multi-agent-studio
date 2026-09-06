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

export type CompositeTaskQuery = (text: string, values?: readonly unknown[]) => Promise<{
  rows: readonly Record<string, unknown>[];
}>;

export interface CompositeTaskStore {
  get(taskId: string): CompositeTask | null | Promise<CompositeTask | null>;
  save(task: CompositeTask, expectedRevision?: number): void | Promise<void>;
}

export class InMemoryCompositeTaskStore implements CompositeTaskStore {
  private readonly tasks = new Map<string, CompositeTask>();
  get(taskId: string): CompositeTask | null {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }
  save(task: CompositeTask, expectedRevision?: number): void {
    const parsed = compositeTaskSchema.parse(task);
    const current = this.tasks.get(parsed.taskId);
    if (expectedRevision !== undefined && (current?.checkpoint.revision ?? -1) !== expectedRevision) throw new Error("COMPOSITE_REVISION_CONFLICT");
    if (current && parsed.checkpoint.revision !== current.checkpoint.revision + 1) throw new Error("COMPOSITE_REVISION_CONFLICT");
    this.tasks.set(parsed.taskId, structuredClone(parsed));
  }
}

export class PostgresCompositeTaskStore implements CompositeTaskStore {
  constructor(private readonly query: CompositeTaskQuery) {}
  async get(taskId: string): Promise<CompositeTask | null> {
    const result = await this.query("SELECT task FROM studio_composite_tasks WHERE task_id = $1", [taskId]);
    const parsed = compositeTaskSchema.safeParse(result.rows[0]?.task);
    return parsed.success ? parsed.data : null;
  }
  async save(task: CompositeTask, expectedRevision = task.checkpoint.revision - 1): Promise<void> {
    const parsed = compositeTaskSchema.parse(task);
    const result = await this.query(
      `INSERT INTO studio_composite_tasks (task_id, task, revision, updated_at_ms)
       VALUES ($1, $2::jsonb, $3, $4)
       ON CONFLICT (task_id) DO UPDATE
         SET task = EXCLUDED.task, revision = EXCLUDED.revision, updated_at_ms = EXCLUDED.updated_at_ms
       WHERE studio_composite_tasks.revision = $5
       RETURNING task_id`,
      [parsed.taskId, JSON.stringify(parsed), parsed.checkpoint.revision, parsed.updatedAtMs, expectedRevision],
    );
    if (result.rows.length !== 1) throw new Error("COMPOSITE_REVISION_CONFLICT");
  }
}

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

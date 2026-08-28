import { randomUUID } from "node:crypto";

import { identifierSchema, skillJsonValueSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

/**
 * The execution FSM is deliberately separate from the durable dispatch
 * status in `model.ts`.  Dispatch answers "where is this task leased?";
 * this state answers "what is the bot doing with the task?".
 */
export const taskExecutionStateSchema = z.enum([
  "PRECHECK",
  "PLAN",
  "EXECUTE",
  "VERIFY",
  "SUCCESS",
  "RECOVER",
  "REPLAN",
  "ABORT",
]);

export type TaskExecutionState = z.infer<typeof taskExecutionStateSchema>;

const timestampSchema = z.string().datetime({ offset: true });
const boundedJsonSchema = skillJsonValueSchema.refine(
  (value) => Buffer.byteLength(JSON.stringify(value), "utf8") <= 32 * 1_024,
  "Task execution data exceeds 32 KiB.",
);

export const taskResourceReservationSchema = z.union([
  identifierSchema,
  z
    .object({
      resourceId: identifierSchema,
      amount: z.number().finite().positive().optional(),
      unit: z.string().min(1).max(32).optional(),
    })
    .strict(),
]);

export type TaskResourceReservation = z.infer<
  typeof taskResourceReservationSchema
>;

/** A movement lease is a value object, not a live lock. It survives restart. */
export const taskMovementLeaseSchema = z
  .object({
    owner: identifierSchema,
    token: identifierSchema.optional(),
    priority: z.number().int().min(0).max(100).optional(),
    acquiredAt: timestampSchema.optional(),
    expiresAt: timestampSchema.nullable().optional(),
  })
  .strict();

export type TaskMovementLease = z.infer<typeof taskMovementLeaseSchema>;

export const taskCancellationTokenSchema = z
  .object({
    tokenId: identifierSchema,
    cancelled: z.boolean(),
    cancelledAt: timestampSchema.nullable(),
    reason: z.string().trim().max(256).nullable(),
  })
  .strict();

export type TaskCancellationToken = z.infer<
  typeof taskCancellationTokenSchema
>;

export const taskExecutionRecordSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    taskId: identifierSchema,
    botId: identifierSchema,
    goal: z.string().trim().min(1).max(2_000),
    /** IDs are persisted, while these names mirror the execution contract. */
    parentTask: identifierSchema.nullable(),
    childTasks: z.array(identifierSchema).max(256),
    state: taskExecutionStateSchema,
    currentStep: z.string().trim().max(512).nullable(),
    executionOwner: identifierSchema.nullable().default(null),
    executionLeaseExpiresAt: timestampSchema.nullable().default(null),
    startTime: timestampSchema,
    lastProgressTime: timestampSchema,
    updatedAt: timestampSchema,
    retryCount: z.number().int().nonnegative().max(1_000),
    recoveryCount: z.number().int().nonnegative().max(1_000),
    maxRecoveryCount: z.number().int().nonnegative().max(1_000),
    planVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    worldStateVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    reservedResources: z.array(taskResourceReservationSchema).max(512),
    movementLease: taskMovementLeaseSchema.nullable(),
    expectedResult: boundedJsonSchema.nullable(),
    actualResult: boundedJsonSchema.nullable(),
    failureReason: z.string().trim().max(512).nullable(),
    cancellationToken: taskCancellationTokenSchema,
    revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      (record.executionOwner === null) !==
      (record.executionLeaseExpiresAt === null)
    ) {
      context.addIssue({
        code: "custom",
        message: "Execution owner and lease expiry must be set or cleared together.",
        path: ["executionOwner"],
      });
    }
  });

export type TaskExecutionRecord = z.infer<typeof taskExecutionRecordSchema>;

export const taskExecutionCreateInputSchema = z
  .object({
    taskId: identifierSchema,
    botId: identifierSchema,
    goal: z.string().trim().min(1).max(2_000),
    parentTask: identifierSchema.nullable().optional(),
    maxRecoveryCount: z.number().int().nonnegative().max(1_000).optional(),
    worldStateVersion: z.number().int().nonnegative().optional(),
    reservedResources: z
      .array(taskResourceReservationSchema)
      .max(512)
      .optional(),
    movementLease: taskMovementLeaseSchema.nullable().optional(),
    expectedResult: boundedJsonSchema.nullable().optional(),
    executionOwner: identifierSchema.nullable().optional(),
    executionLeaseExpiresAt: timestampSchema.nullable().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    const owner = input.executionOwner ?? null;
    const leaseExpiresAt = input.executionLeaseExpiresAt ?? null;
    if ((owner === null) !== (leaseExpiresAt === null)) {
      context.addIssue({
        code: "custom",
        message: "Execution owner and lease expiry must be set or cleared together.",
        path: ["executionOwner"],
      });
    }
  });

export type TaskExecutionCreateInput = z.infer<
  typeof taskExecutionCreateInputSchema
>;

export const taskExecutionTransitionInputSchema = z
  .object({
    taskId: identifierSchema,
    to: taskExecutionStateSchema,
    expectedRevision: z.number().int().nonnegative().optional(),
    currentStep: z.string().trim().max(512).nullable().optional(),
    worldStateVersion: z.number().int().nonnegative().optional(),
    expectedResult: boundedJsonSchema.nullable().optional(),
    actualResult: boundedJsonSchema.nullable().optional(),
    failureReason: z.string().trim().max(512).nullable().optional(),
    movementLease: taskMovementLeaseSchema.nullable().optional(),
    reservedResources: z
      .array(taskResourceReservationSchema)
      .max(512)
      .optional(),
    reason: z.string().trim().max(512).optional(),
  })
  .strict();

export type TaskExecutionTransitionInput = z.infer<
  typeof taskExecutionTransitionInputSchema
>;

export const taskExecutionClaimInputSchema = z
  .object({
    owner: identifierSchema,
    leaseExpiresAt: timestampSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export type TaskExecutionClaimInput = z.infer<
  typeof taskExecutionClaimInputSchema
>;

export class TaskExecutionError extends Error {
  constructor(
    readonly code:
      | "TASK_EXECUTION_NOT_FOUND"
      | "TASK_EXECUTION_EXISTS"
      | "TASK_EXECUTION_INVALID_TRANSITION"
      | "TASK_EXECUTION_REVISION_CONFLICT"
      | "TASK_EXECUTION_CANCELLED"
      | "TASK_EXECUTION_TERMINAL"
      | "TASK_EXECUTION_OWNED"
      | "TASK_EXECUTION_RECOVERY_BUDGET_EXHAUSTED"
      | "TASK_EXECUTION_PARENT_NOT_FOUND"
      | "TASK_EXECUTION_PERSISTENCE_FAILED",
    message: string,
  ) {
    super(message);
    this.name = "TaskExecutionError";
  }
}

export type TaskExecutionStore = Readonly<{
  get(taskId: string): TaskExecutionRecord | null | Promise<TaskExecutionRecord | null>;
  save(record: TaskExecutionRecord): void | Promise<void>;
  list?(): readonly TaskExecutionRecord[] | Promise<readonly TaskExecutionRecord[]>;
}>;

function cloneRecord(record: TaskExecutionRecord): TaskExecutionRecord {
  return structuredClone(record);
}

function nowIso(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) {
    throw new TypeError("Task execution clock returned an invalid date.");
  }
  return value.toISOString();
}

/** Small durable-store substitute useful for tests and local single-process runs. */
export class InMemoryTaskExecutionStore implements TaskExecutionStore {
  private readonly records = new Map<string, TaskExecutionRecord>();

  get(taskId: string): TaskExecutionRecord | null {
    const record = this.records.get(taskId);
    return record === undefined ? null : cloneRecord(record);
  }

  save(record: TaskExecutionRecord): void {
    const parsed = taskExecutionRecordSchema.parse(record);
    const current = this.records.get(parsed.taskId);
    if (current !== undefined) {
      if (current.revision === parsed.revision) {
        if (JSON.stringify(current) === JSON.stringify(parsed)) return;
        throw new Error("Task execution revision conflicts with another snapshot.");
      }
      if (parsed.revision !== current.revision + 1) {
        throw new Error("Task execution revision is not the next durable revision.");
      }
    } else if (parsed.revision !== 0) {
      throw new Error("A new task execution must start at revision zero.");
    }
    this.records.set(parsed.taskId, cloneRecord(parsed));
  }

  list(): readonly TaskExecutionRecord[] {
    return [...this.records.values()].map(cloneRecord);
  }
}

const ALLOWED_EXECUTION_TRANSITIONS: Readonly<
  Record<TaskExecutionState, readonly TaskExecutionState[]>
> = {
  PRECHECK: ["PLAN", "ABORT"],
  PLAN: ["EXECUTE", "RECOVER", "REPLAN", "ABORT"],
  EXECUTE: ["VERIFY", "RECOVER", "REPLAN", "ABORT"],
  VERIFY: ["SUCCESS", "EXECUTE", "RECOVER", "REPLAN", "ABORT"],
  SUCCESS: [],
  RECOVER: ["EXECUTE", "REPLAN", "ABORT"],
  REPLAN: ["PLAN", "EXECUTE", "ABORT"],
  ABORT: [],
};

export function canTransitionTaskExecution(
  from: TaskExecutionState,
  to: TaskExecutionState,
): boolean {
  return from === to || ALLOWED_EXECUTION_TRANSITIONS[from].includes(to);
}

export type PersistentTaskStateMachineOptions = Readonly<{
  store?: TaskExecutionStore;
  now?: () => Date;
  defaultMaxRecoveryCount?: number;
}>;

/**
 * Durable task execution state. Every mutation is persisted before it is
 * returned, so a process restart can resume from the last observed state.
 */
export class PersistentTaskStateMachine {
  private readonly store: TaskExecutionStore;
  private readonly now: () => Date;
  private readonly defaultMaxRecoveryCount: number;

  constructor(options: PersistentTaskStateMachineOptions = {}) {
    this.store = options.store ?? new InMemoryTaskExecutionStore();
    this.now = options.now ?? (() => new Date());
    this.defaultMaxRecoveryCount = options.defaultMaxRecoveryCount ?? 3;
    if (
      !Number.isInteger(this.defaultMaxRecoveryCount) ||
      this.defaultMaxRecoveryCount < 0 ||
      this.defaultMaxRecoveryCount > 1_000
    ) {
      throw new RangeError("defaultMaxRecoveryCount must be between 0 and 1000.");
    }
  }

  async create(input: TaskExecutionCreateInput): Promise<TaskExecutionRecord> {
    const parsed = taskExecutionCreateInputSchema.parse(input);
    const existing = await this.store.get(parsed.taskId);
    if (existing !== null) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_EXISTS",
        "Task execution already exists.",
      );
    }
    if (parsed.parentTask !== null && parsed.parentTask !== undefined) {
      const parent = await this.store.get(parsed.parentTask);
      if (parent === null) {
        throw new TaskExecutionError(
          "TASK_EXECUTION_PARENT_NOT_FOUND",
          "Parent task execution does not exist.",
        );
      }
      if (
        parent.cancellationToken.cancelled ||
        parent.state === "SUCCESS" ||
        parent.state === "ABORT"
      ) {
        throw new TaskExecutionError(
          "TASK_EXECUTION_TERMINAL",
          "A child cannot be attached to a terminal parent task.",
        );
      }
    }
    const timestamp = nowIso(this.now);
    const record = taskExecutionRecordSchema.parse({
      schemaVersion: "1.0",
      taskId: parsed.taskId,
      botId: parsed.botId,
      goal: parsed.goal,
      parentTask: parsed.parentTask ?? null,
      childTasks: [],
      state: "PRECHECK",
      currentStep: null,
      executionOwner: parsed.executionOwner ?? null,
      executionLeaseExpiresAt: parsed.executionLeaseExpiresAt ?? null,
      startTime: timestamp,
      lastProgressTime: timestamp,
      updatedAt: timestamp,
      retryCount: 0,
      recoveryCount: 0,
      maxRecoveryCount:
        parsed.maxRecoveryCount ?? this.defaultMaxRecoveryCount,
      planVersion: 0,
      worldStateVersion: parsed.worldStateVersion ?? 0,
      reservedResources: parsed.reservedResources ?? [],
      movementLease: parsed.movementLease ?? null,
      expectedResult: parsed.expectedResult ?? null,
      actualResult: null,
      failureReason: null,
      cancellationToken: {
        tokenId: randomUUID(),
        cancelled: false,
        cancelledAt: null,
        reason: null,
      },
      revision: 0,
    });
    await this.persist(record);
    if (record.parentTask !== null) {
      const parent = await this.require(record.parentTask);
      const childTasks = parent.childTasks.includes(record.taskId)
        ? parent.childTasks
        : [...parent.childTasks, record.taskId];
      await this.persist(this.touch(parent, timestamp, { childTasks }));
    }
    return cloneRecord(record);
  }

  async get(taskId: string): Promise<TaskExecutionRecord | null> {
    const parsedTaskId = identifierSchema.parse(taskId);
    const record = await this.store.get(parsedTaskId);
    return record === null ? null : taskExecutionRecordSchema.parse(cloneRecord(record));
  }

  /** Restore is an explicit alias that makes restart/resume call sites clear. */
  async restore(taskId: string): Promise<TaskExecutionRecord | null> {
    return this.get(taskId);
  }

  async claimExecution(
    taskId: string,
    input: TaskExecutionClaimInput,
  ): Promise<TaskExecutionRecord> {
    const parsedTaskId = identifierSchema.parse(taskId);
    const parsed = taskExecutionClaimInputSchema.parse(input);
    const current = await this.require(parsedTaskId);
    if (current.revision !== parsed.expectedRevision) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_REVISION_CONFLICT",
        "Task execution revision does not match the expected value.",
      );
    }
    if (current.state === "SUCCESS" || current.state === "ABORT") {
      throw new TaskExecutionError(
        "TASK_EXECUTION_TERMINAL",
        "Terminal task execution cannot be claimed.",
      );
    }
    if (current.cancellationToken.cancelled) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_CANCELLED",
        "Cancelled task execution cannot be claimed.",
      );
    }
    const timestamp = nowIso(this.now);
    const nowMs = Date.parse(timestamp);
    const leaseExpiresMs = Date.parse(parsed.leaseExpiresAt);
    if (leaseExpiresMs <= nowMs) {
      throw new RangeError("Execution lease expiry must be in the future.");
    }
    const currentLeaseExpiresMs = current.executionLeaseExpiresAt === null
      ? Number.NEGATIVE_INFINITY
      : Date.parse(current.executionLeaseExpiresAt);
    if (
      current.executionOwner !== null &&
      currentLeaseExpiresMs > nowMs
    ) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_OWNED",
        "Task execution already has an active lease.",
      );
    }
    const next = taskExecutionRecordSchema.parse({
      ...current,
      executionOwner: parsed.owner,
      executionLeaseExpiresAt: parsed.leaseExpiresAt,
      updatedAt: timestamp,
      revision: current.revision + 1,
    });
    try {
      await this.persist(next);
    } catch (cause) {
      if (
        cause instanceof TaskExecutionError &&
        cause.code === "TASK_EXECUTION_PERSISTENCE_FAILED"
      ) {
        const durable = await this.require(parsedTaskId);
        if (
          durable.revision !== current.revision ||
          durable.executionOwner !== current.executionOwner ||
          durable.executionLeaseExpiresAt !== current.executionLeaseExpiresAt
        ) {
          throw new TaskExecutionError(
            "TASK_EXECUTION_REVISION_CONFLICT",
            "Another execution claim won the durable revision race.",
          );
        }
      }
      throw cause;
    }
    return cloneRecord(next);
  }

  async transition(
    taskIdOrInput: string | TaskExecutionTransitionInput,
    to?: TaskExecutionState,
    patch: Omit<TaskExecutionTransitionInput, "taskId" | "to"> = {},
  ): Promise<TaskExecutionRecord> {
    const input =
      typeof taskIdOrInput === "string"
        ? taskExecutionTransitionInputSchema.parse({
            taskId: taskIdOrInput,
            to,
            ...patch,
          })
        : taskExecutionTransitionInputSchema.parse(taskIdOrInput);
    const current = await this.require(input.taskId);
    if (
      input.expectedRevision !== undefined &&
      current.revision !== input.expectedRevision
    ) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_REVISION_CONFLICT",
        "Task execution revision does not match the expected value.",
      );
    }
    if (current.state === input.to) return cloneRecord(current);
    if (current.cancellationToken.cancelled && input.to !== "ABORT") {
      throw new TaskExecutionError(
        "TASK_EXECUTION_CANCELLED",
        "Cancelled task execution cannot continue.",
      );
    }
    if (current.state === "SUCCESS" || current.state === "ABORT") {
      throw new TaskExecutionError(
        "TASK_EXECUTION_TERMINAL",
        "Terminal task execution cannot change state.",
      );
    }
    if (!canTransitionTaskExecution(current.state, input.to)) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_INVALID_TRANSITION",
        `Cannot transition task execution from ${current.state} to ${input.to}.`,
      );
    }

    const timestamp = nowIso(this.now);
    let nextState = input.to;
    let failureReason = input.failureReason ?? current.failureReason;
    let recoveryCount = current.recoveryCount;
    let retryCount = current.retryCount;
    let planVersion = current.planVersion;
    if (input.to === "RECOVER") {
      if (current.recoveryCount >= current.maxRecoveryCount) {
        nextState = "ABORT";
        failureReason = "RECOVERY_BUDGET_EXHAUSTED";
      } else {
        recoveryCount += 1;
      }
    }
    if (input.to === "REPLAN") planVersion += 1;
    if (
      input.to === "EXECUTE" &&
      (current.state === "RECOVER" || current.state === "REPLAN")
    ) {
      retryCount += 1;
    }
    const next = taskExecutionRecordSchema.parse({
      ...current,
      state: nextState,
      executionOwner:
        nextState === "SUCCESS" || nextState === "ABORT"
          ? null
          : current.executionOwner,
      executionLeaseExpiresAt:
        nextState === "SUCCESS" || nextState === "ABORT"
          ? null
          : current.executionLeaseExpiresAt,
      currentStep:
        input.currentStep === undefined
          ? current.currentStep
          : input.currentStep,
      worldStateVersion:
        input.worldStateVersion === undefined
          ? current.worldStateVersion
          : Math.max(current.worldStateVersion, input.worldStateVersion),
      expectedResult:
        input.expectedResult === undefined
          ? current.expectedResult
          : input.expectedResult,
      actualResult:
        input.actualResult === undefined ? current.actualResult : input.actualResult,
      failureReason,
      movementLease:
        input.movementLease === undefined
          ? current.movementLease
          : input.movementLease,
      reservedResources:
        input.reservedResources === undefined
          ? current.reservedResources
          : input.reservedResources,
      recoveryCount,
      retryCount,
      planVersion,
      lastProgressTime: timestamp,
      updatedAt: timestamp,
      revision: current.revision + 1,
    });
    await this.persist(next);
    return cloneRecord(next);
  }

  async markProgress(
    taskId: string,
    patch: Readonly<{
      currentStep?: string | null;
      worldStateVersion?: number;
      actualResult?: unknown;
      expectedResult?: unknown;
      movementLease?: TaskMovementLease | null;
      reservedResources?: readonly TaskResourceReservation[];
      expectedRevision?: number;
    }> = {},
  ): Promise<TaskExecutionRecord> {
    const current = await this.require(taskId);
    if (current.state === "SUCCESS" || current.state === "ABORT") {
      throw new TaskExecutionError(
        "TASK_EXECUTION_TERMINAL",
        "Terminal task execution cannot make progress.",
      );
    }
    if (
      patch.expectedRevision !== undefined &&
      patch.expectedRevision !== current.revision
    ) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_REVISION_CONFLICT",
        "Task execution revision does not match the expected value.",
      );
    }
    if (current.cancellationToken.cancelled) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_CANCELLED",
        "Cancelled task execution cannot make progress.",
      );
    }
    const timestamp = nowIso(this.now);
    const next = taskExecutionRecordSchema.parse({
      ...current,
      currentStep:
        patch.currentStep === undefined ? current.currentStep : patch.currentStep,
      worldStateVersion:
        patch.worldStateVersion === undefined
          ? current.worldStateVersion
          : Math.max(current.worldStateVersion, patch.worldStateVersion),
      actualResult:
        patch.actualResult === undefined ? current.actualResult : patch.actualResult,
      expectedResult:
        patch.expectedResult === undefined
          ? current.expectedResult
          : patch.expectedResult,
      movementLease:
        patch.movementLease === undefined
          ? current.movementLease
          : patch.movementLease,
      reservedResources:
        patch.reservedResources === undefined
          ? current.reservedResources
          : patch.reservedResources,
      lastProgressTime: timestamp,
      updatedAt: timestamp,
      revision: current.revision + 1,
    });
    await this.persist(next);
    return cloneRecord(next);
  }

  async cancel(
    taskId: string,
    reason = "TASK_CANCELLED",
    expectedRevision?: number,
  ): Promise<TaskExecutionRecord> {
    const root = await this.require(taskId);
    if (
      expectedRevision !== undefined &&
      root.revision !== expectedRevision
    ) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_REVISION_CONFLICT",
        "Task execution revision does not match the expected value.",
      );
    }
    const timestamp = nowIso(this.now);
    const visited = new Set<string>();
    const cancelOne = async (current: TaskExecutionRecord): Promise<TaskExecutionRecord> => {
      if (visited.has(current.taskId)) return current;
      visited.add(current.taskId);
      if (current.state === "SUCCESS") return current;
      if (current.cancellationToken.cancelled) {
        for (const childTaskId of current.childTasks) {
          const child = await this.store.get(childTaskId);
          if (child !== null) await cancelOne(child);
        }
        return current;
      }
      const token: TaskCancellationToken = {
        ...current.cancellationToken,
        cancelled: true,
        cancelledAt: current.cancellationToken.cancelledAt ?? timestamp,
        reason,
      };
      const next = taskExecutionRecordSchema.parse({
        ...current,
        state: "ABORT",
        executionOwner: null,
        executionLeaseExpiresAt: null,
        cancellationToken: token,
        failureReason: reason,
        movementLease: null,
        updatedAt: timestamp,
        lastProgressTime: timestamp,
        revision: current.revision + 1,
      });
      await this.persist(next);
      for (const childTaskId of next.childTasks) {
        const child = await this.store.get(childTaskId);
        if (child !== null) await cancelOne(child);
      }
      return next;
    };
    return cloneRecord(await cancelOne(root));
  }

  async abort(taskId: string, reason: string): Promise<TaskExecutionRecord> {
    return this.transition(taskId, "ABORT", { failureReason: reason });
  }

  private async require(taskId: string): Promise<TaskExecutionRecord> {
    const parsedTaskId = identifierSchema.parse(taskId);
    const record = await this.store.get(parsedTaskId);
    if (record === null) {
      throw new TaskExecutionError(
        "TASK_EXECUTION_NOT_FOUND",
        "Task execution was not found.",
      );
    }
    return taskExecutionRecordSchema.parse(cloneRecord(record));
  }

  private touch(
    record: TaskExecutionRecord,
    timestamp: string,
    patch: Readonly<Partial<TaskExecutionRecord>>,
  ): TaskExecutionRecord {
    return taskExecutionRecordSchema.parse({
      ...record,
      ...patch,
      updatedAt: timestamp,
      revision: record.revision + 1,
    });
  }

  private async persist(record: TaskExecutionRecord): Promise<void> {
    try {
      await this.store.save(taskExecutionRecordSchema.parse(record));
    } catch (error) {
      if (error instanceof TaskExecutionError) throw error;
      throw new TaskExecutionError(
        "TASK_EXECUTION_PERSISTENCE_FAILED",
        error instanceof Error ? error.message : "Task execution persistence failed.",
      );
    }
  }
}

/** Short alias used by runtimes that call this component simply the Task FSM. */
export const TaskFsm = PersistentTaskStateMachine;

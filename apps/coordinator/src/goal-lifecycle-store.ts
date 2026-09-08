import { createHash, randomUUID } from "node:crypto";

import {
  controlLinkGoalErrorCodeSchema,
  goalDispatchTerminalResultV1Schema,
  botIdentitySchema,
  identifierSchema,
  type ControlLinkGoalErrorCode,
  type ControlLinkGoalRequestV1,
  type GoalDispatchTerminalResultV1,
} from "@minecraft-studio/protocol";
import {
  PostgresTaskRepository,
  TaskSystemError,
  type TaskRecord,
  type TaskStatus,
} from "@minecraft-studio/task-system";
import { z } from "zod";

const GOAL_TASK_TYPE = "coordinator.goal";
const GOAL_HANDLER_VERSION = "1.0.0";
const GOAL_IDEMPOTENCY_SCOPE = "control-goal-v1";
const GOAL_LEASE_GRACE_MS = 30_000;
const MAX_GOAL_LEASE_MS = 5 * 60_000;

export const persistedGoalInputSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    kind: z.literal("coordinator.goal.v1"),
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    clientId: identifierSchema,
    actorId: identifierSchema,
    botId: botIdentitySchema,
    operatorGoal: z
      .string()
      .trim()
      .min(1)
      .max(4_096)
      .refine(
        (value) =>
          !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value),
      ),
    timeoutMs: z.number().int().min(1_000).max(120_000),
  })
  .strict();

export type PersistedGoalInput = z.infer<typeof persistedGoalInputSchema>;

export type GoalExecutionLease = Readonly<{
  taskId: string;
  leaseOwner: string;
  revision: number;
}>;

export type GoalLifecycleSnapshot = Readonly<{
  operationId: string;
  taskId: string;
  botId: string;
  fingerprint: string;
  title: string;
  status: TaskStatus;
  startedAt: string | null;
  updatedAt: string;
  result: GoalDispatchTerminalResultV1 | null;
  errorCode: ControlLinkGoalErrorCode | null;
}>;

export type GoalLifecycleBeginResult =
  | Readonly<{
      kind: "execute";
      lease: GoalExecutionLease;
      snapshot: GoalLifecycleSnapshot;
    }>
  | Readonly<{
      kind: "result";
      result: GoalDispatchTerminalResultV1;
      snapshot: GoalLifecycleSnapshot;
    }>
  | Readonly<{
      kind: "error";
      errorCode: ControlLinkGoalErrorCode;
      snapshot: GoalLifecycleSnapshot;
    }>
  | Readonly<{ kind: "busy"; snapshot: GoalLifecycleSnapshot }>;

export interface GoalLifecycleStore {
  initialize(terminalTtlMs: number): Promise<readonly GoalLifecycleSnapshot[]>;
  refresh(terminalTtlMs: number): Promise<readonly GoalLifecycleSnapshot[]>;
  begin(request: ControlLinkGoalRequestV1): Promise<GoalLifecycleBeginResult>;
  recordResult(
    lease: GoalExecutionLease,
    result: GoalDispatchTerminalResultV1,
  ): Promise<GoalLifecycleSnapshot>;
  recordError(
    lease: GoalExecutionLease,
    errorCode: ControlLinkGoalErrorCode,
    status: "failed" | "cancelled" | "expired",
  ): Promise<GoalLifecycleSnapshot>;
}

export interface QueuedGoalLifecycleStore {
  submitQueued(
    request: ControlLinkGoalRequestV1,
  ): Promise<GoalLifecycleSnapshot>;
  waitForQueuedTerminal(
    taskId: string,
    signal: AbortSignal,
  ): Promise<GoalLifecycleSnapshot>;
  requestQueuedCancellation(
    taskId: string,
    reasonCode: "AI_TIMEOUT" | "CONTROL_LINK_STOPPED",
  ): Promise<void>;
}

export class GoalLifecycleStoreError extends Error {
  constructor(
    readonly code: ControlLinkGoalErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GoalLifecycleStoreError";
  }
}

export type PostgresGoalLifecycleStoreOptions = Readonly<{
  repository: PostgresTaskRepository;
  coordinatorInstanceId: string;
  randomId?: () => string;
  /** Resolve the live ServerProfile/dimension for a connected Bot. */
  resolveBotContext?: (
    botId: string,
  ) => Readonly<{
    serverProfileId: string;
    dimension: string;
  }> | null;
}>;

export class PostgresGoalLifecycleStore implements GoalLifecycleStore {
  private readonly randomId: () => string;
  private readonly leaseOwnerPrefix: string;

  constructor(private readonly options: PostgresGoalLifecycleStoreOptions) {
    identifierSchema.parse(options.coordinatorInstanceId);
    this.randomId = options.randomId ?? randomUUID;
    this.leaseOwnerPrefix = `goal-${createHash("sha256")
      .update(options.coordinatorInstanceId, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
  }

  async initialize(
    terminalTtlMs: number,
  ): Promise<readonly GoalLifecycleSnapshot[]> {
    try {
      await this.options.repository.verifyGoalLifecycleSchema();
      return await this.refresh(terminalTtlMs);
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  async refresh(
    terminalTtlMs: number,
  ): Promise<readonly GoalLifecycleSnapshot[]> {
    assertTerminalTtl(terminalTtlMs);
    try {
      const now = await this.options.repository.getDatabaseTime();
      const tasks = await this.options.repository.listTaskLifecycle({
        taskType: GOAL_TASK_TYPE,
        terminalUpdatedAfter: new Date(
          now.getTime() - terminalTtlMs,
        ).toISOString(),
      });
      const snapshots: GoalLifecycleSnapshot[] = [];
      for (const task of tasks) {
        const recovered = await this.recoverIfRequired(task, now);
        snapshots.push(snapshot(recovered.task, recovered.input));
      }
      return snapshots;
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  async begin(
    request: ControlLinkGoalRequestV1,
  ): Promise<GoalLifecycleBeginResult> {
    const input = inputFromRequest(request);
    try {
      const created = await this.options.repository.createTask({
        schemaVersion: "1.0",
        operationId: input.operationId,
        taskId: input.taskId,
        idempotencyScope: GOAL_IDEMPOTENCY_SCOPE,
        idempotencyKey: input.operationId,
        taskType: GOAL_TASK_TYPE,
        handlerVersion: GOAL_HANDLER_VERSION,
        executionIdempotent: false,
        title: "Submitted goal",
        description: "Authenticated operator goal.",
        input,
        priority: 50,
        requiredSkills: [],
        requiredItems: [],
        target: null,
        dependencyIds: [],
        parentTaskId: null,
        deadline: null,
        timeoutMs: input.timeoutMs,
        maxRetries: 0,
        riskLevel: "R1",
        traceId: input.operationId,
        actorId: input.actorId,
      });
      const persisted = validateGoalTask(created.task, input);
      return await this.resume(persisted.task, persisted.input);
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  async submitQueued(
    request: ControlLinkGoalRequestV1,
  ): Promise<GoalLifecycleSnapshot> {
    const input = inputFromRequest(request);
    try {
      const submitted = await this.options.repository.submitTask({
        schemaVersion: "1.0",
        operationId: input.operationId,
        taskId: input.taskId,
        idempotencyScope: GOAL_IDEMPOTENCY_SCOPE,
        idempotencyKey: input.operationId,
        taskType: GOAL_TASK_TYPE,
        handlerVersion: GOAL_HANDLER_VERSION,
        executionIdempotent: false,
        title: "Submitted goal",
        description: "Authenticated operator goal.",
        input,
        priority: 50,
        requiredSkills: [],
        requiredItems: [],
        target: null,
        dependencyIds: [],
        parentTaskId: null,
        deadline: null,
        timeoutMs: input.timeoutMs,
        maxRetries: 0,
        riskLevel: "R1",
        traceId: input.operationId,
        actorId: input.actorId,
        dispatchBotId: input.botId,
      });
      const persisted = validateGoalTask(submitted.task, input);
      if (persisted.task.dispatchBotId !== input.botId) {
        throw new GoalLifecycleStoreError(
          "GOAL_ID_CONFLICT",
          "Persisted goal dispatch target conflicts with the request.",
        );
      }
      return snapshot(persisted.task, persisted.input);
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  async waitForQueuedTerminal(
    taskId: string,
    signal: AbortSignal,
  ): Promise<GoalLifecycleSnapshot> {
    while (!signal.aborted) {
      try {
        const task = await this.options.repository.getTask(taskId);
        if (!task) {
          throw new GoalLifecycleStoreError(
            "CONTROL_LINK_INTERNAL_ERROR",
            "Queued goal disappeared from durable storage.",
          );
        }
        const persisted = validateGoalTask(task);
        const state = snapshot(persisted.task, persisted.input);
        if (isGoalTerminal(persisted.task)) return state;
      } catch (error) {
        throw lifecycleError(error);
      }
      await waitForPoll(signal);
    }
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("goal_wait_aborted");
  }

  async requestQueuedCancellation(
    taskId: string,
    reasonCode: "AI_TIMEOUT" | "CONTROL_LINK_STOPPED",
  ): Promise<void> {
    try {
      await this.options.repository.requestTaskCancellation({
        operationId: this.randomId(),
        taskId,
        actorId: this.options.coordinatorInstanceId,
        reasonCode,
      });
    } catch (error) {
      if (
        error instanceof TaskSystemError &&
        error.code === "TASK_TERMINAL"
      ) {
        return;
      }
      throw lifecycleError(error);
    }
  }

  async recordResult(
    lease: GoalExecutionLease,
    resultInput: GoalDispatchTerminalResultV1,
  ): Promise<GoalLifecycleSnapshot> {
    const result = goalDispatchTerminalResultV1Schema.parse(resultInput);
    const status = goalResultStatus(result);
    try {
      const task = await this.options.repository.transition({
        schemaVersion: "1.0",
        operationId: this.randomId(),
        taskId: lease.taskId,
        expectedRevision: lease.revision,
        actorId: this.options.coordinatorInstanceId,
        to: status,
        reasonCode: "GOAL_RESULT_RECORDED",
        leaseOwner: lease.leaseOwner,
        failureReason: status === "failed" ? "GOAL_RESULT_FAILED" : null,
        result,
        evidence: [],
      });
      const persisted = validateGoalTask(task);
      return snapshot(persisted.task, persisted.input);
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  async recordError(
    lease: GoalExecutionLease,
    errorCodeInput: ControlLinkGoalErrorCode,
    status: "failed" | "cancelled" | "expired",
  ): Promise<GoalLifecycleSnapshot> {
    const errorCode = controlLinkGoalErrorCodeSchema.parse(errorCodeInput);
    try {
      const task = await this.options.repository.transition({
        schemaVersion: "1.0",
        operationId: this.randomId(),
        taskId: lease.taskId,
        expectedRevision: lease.revision,
        actorId: this.options.coordinatorInstanceId,
        to: status,
        reasonCode: errorCode,
        leaseOwner: lease.leaseOwner,
        failureReason: status === "failed" ? errorCode : null,
        result: null,
        evidence: [],
      });
      const persisted = validateGoalTask(task);
      return snapshot(persisted.task, persisted.input);
    } catch (error) {
      throw lifecycleError(error);
    }
  }

  private async resume(
    task: TaskRecord,
    input: PersistedGoalInput,
  ): Promise<GoalLifecycleBeginResult> {
    if (isGoalTerminal(task)) return terminalBeginResult(task, input);
    const now = await this.options.repository.getDatabaseTime();
    const recovered = await this.recoverIfRequired(task, now);
    task = recovered.task;
    input = recovered.input;
    if (isGoalTerminal(task)) return terminalBeginResult(task, input);
    if (task.status === "assigned" || task.status === "running") {
      return { kind: "busy", snapshot: snapshot(task, input) };
    }
    if (task.status !== "queued") {
      throw new GoalLifecycleStoreError(
        "CONTROL_LINK_INTERNAL_ERROR",
        "Persisted goal is in an unsupported non-terminal state.",
      );
    }
    if (Date.parse(task.createdAt) + task.timeoutMs <= now.getTime()) {
      const expired = await this.options.repository.transition({
        schemaVersion: "1.0",
        operationId: this.randomId(),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.coordinatorInstanceId,
        to: "expired",
        reasonCode: "AI_TIMEOUT",
        leaseOwner: null,
        failureReason: null,
        result: null,
        evidence: [],
      });
      return terminalBeginResult(expired, input);
    }
    const leaseOwner = `${this.leaseOwnerPrefix}-${input.operationId.slice(0, 12)}`;
    const leaseDurationMs = Math.min(
      MAX_GOAL_LEASE_MS,
      input.timeoutMs + GOAL_LEASE_GRACE_MS,
    );
    const context = this.options.resolveBotContext?.(input.botId);
    if (this.options.resolveBotContext && context === null) {
      throw new GoalLifecycleStoreError(
        "BOT_UNAVAILABLE",
        "The requested Bot has no current ServerProfile context.",
      );
    }
    const assigned = context
      ? await this.options.repository.acquireSynchronousAssignment({
          schemaVersion: "1.0",
          operationId: this.randomId(),
          taskId: task.taskId,
          expectedRevision: task.revision,
          actorId: this.options.coordinatorInstanceId,
          botId: input.botId,
          leaseOwner,
          leaseDurationMs,
          serverProfileId: context.serverProfileId,
          dimension: context.dimension,
        })
      : await this.options.repository.acquireLease({
          schemaVersion: "1.0",
          operationId: this.randomId(),
          taskId: task.taskId,
          expectedRevision: task.revision,
          actorId: this.options.coordinatorInstanceId,
          botId: input.botId,
          leaseOwner,
          leaseDurationMs,
        });
    const running = await this.options.repository.transition({
      schemaVersion: "1.0",
      operationId: this.randomId(),
      taskId: assigned.taskId,
      expectedRevision: assigned.revision,
      actorId: this.options.coordinatorInstanceId,
      to: "running",
      reasonCode: "GOAL_EXECUTION_STARTED",
      leaseOwner,
      failureReason: null,
      result: null,
      evidence: [],
    });
    return {
      kind: "execute",
      lease: { taskId: running.taskId, leaseOwner, revision: running.revision },
      snapshot: snapshot(running, input),
    };
  }

  private async recoverIfRequired(
    taskInput: TaskRecord,
    now: Date,
  ): Promise<Readonly<{ task: TaskRecord; input: PersistedGoalInput }>> {
    const persisted = validateGoalTask(taskInput);
    const task = persisted.task;
    if (
      (task.status === "assigned" || task.status === "running") &&
      task.leaseExpiresAt !== null &&
      Date.parse(task.leaseExpiresAt) <= now.getTime()
    ) {
      const recovered = await this.options.repository.recoverExpiredLease({
        schemaVersion: "1.0",
        operationId: this.randomId(),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.coordinatorInstanceId,
        reasonCode: "TASK_LEASE_EXPIRED",
      });
      return validateGoalTask(recovered.task, persisted.input);
    }
    if (
      task.status === "queued" &&
      Date.parse(task.createdAt) + task.timeoutMs <= now.getTime()
    ) {
      const expired = await this.options.repository.transition({
        schemaVersion: "1.0",
        operationId: this.randomId(),
        taskId: task.taskId,
        expectedRevision: task.revision,
        actorId: this.options.coordinatorInstanceId,
        to: "expired",
        reasonCode: "AI_TIMEOUT",
        leaseOwner: null,
        failureReason: null,
        result: null,
        evidence: [],
      });
      return validateGoalTask(expired, persisted.input);
    }
    return persisted;
  }
}

export function durableGoalFingerprint(
  request: ControlLinkGoalRequestV1 | PersistedGoalInput,
): string {
  const input =
    "payload" in request
      ? inputFromRequest(request)
      : persistedGoalInputSchema.parse(request);
  // `task_input` is stored as PostgreSQL JSONB, whose object key order is not
  // the order used by the incoming request. Hash the fixed semantic fields as
  // a tuple so a replay after a Coordinator restart has the same identity.
  const canonical = [
    input.schemaVersion,
    input.kind,
    input.operationId,
    input.taskId,
    input.clientId,
    input.actorId,
    input.botId,
    input.operatorGoal,
    input.timeoutMs,
  ] as const;
  return createHash("sha256")
    .update(JSON.stringify(canonical), "utf8")
    .digest("hex");
}

export function safePersistedGoalInput(
  task: TaskRecord,
): PersistedGoalInput | null {
  try {
    return validateGoalTask(task).input;
  } catch {
    return null;
  }
}

function inputFromRequest(request: ControlLinkGoalRequestV1): PersistedGoalInput {
  return persistedGoalInputSchema.parse({
    schemaVersion: "1.0",
    kind: "coordinator.goal.v1",
    operationId: request.payload.operationId,
    taskId: request.payload.taskId,
    clientId: request.payload.clientId,
    actorId: request.payload.actorId,
    botId: request.payload.botId,
    operatorGoal: request.payload.operatorGoal,
    timeoutMs: request.payload.timeoutMs,
  });
}

function validateGoalTask(
  task: TaskRecord,
  expectedInput?: PersistedGoalInput,
): Readonly<{ task: TaskRecord; input: PersistedGoalInput }> {
  if (
    task.idempotencyScope !== GOAL_IDEMPOTENCY_SCOPE ||
    task.taskType !== GOAL_TASK_TYPE ||
    task.handlerVersion !== GOAL_HANDLER_VERSION ||
    task.executionIdempotent ||
    task.maxRetries !== 0 ||
    task.riskLevel !== "R1"
  ) {
    throw new GoalLifecycleStoreError(
      "GOAL_ID_CONFLICT",
      "Persisted task identity conflicts with the goal lifecycle contract.",
    );
  }
  const input = persistedGoalInputSchema.parse(task.input);
  if (
    input.taskId !== task.taskId ||
    input.operationId !== task.idempotencyKey ||
    input.operationId !== task.traceId ||
    input.timeoutMs !== task.timeoutMs ||
    ((task.status === "assigned" || task.status === "running") &&
      task.assignedBotId !== input.botId) ||
    ((task.status === "assigned" || task.status === "running") &&
      task.dispatchBotId !== null &&
      task.dispatchBotId !== input.botId) ||
    (expectedInput !== undefined &&
      durableGoalFingerprint(input) !== durableGoalFingerprint(expectedInput))
  ) {
    throw new GoalLifecycleStoreError(
      "GOAL_ID_CONFLICT",
      "Persisted goal input conflicts with the requested operation.",
    );
  }
  return { task, input };
}

function snapshot(
  task: TaskRecord,
  input: PersistedGoalInput,
): GoalLifecycleSnapshot {
  const result = task.result === null
    ? null
    : goalDispatchTerminalResultV1Schema.parse(task.result);
  if (
    result !== null &&
    (result.taskId !== task.taskId || result.botId !== input.botId)
  ) {
    throw new GoalLifecycleStoreError(
      "CONTROL_LINK_INTERNAL_ERROR",
      "Persisted goal result identity is invalid.",
    );
  }
  return {
    operationId: input.operationId,
    taskId: task.taskId,
    botId: input.botId,
    fingerprint: durableGoalFingerprint(input),
    title: task.title,
    status: task.status,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    result,
    errorCode: result === null && isGoalTerminal(task)
      ? terminalErrorCode(task)
      : null,
  };
}

function terminalBeginResult(
  task: TaskRecord,
  input: PersistedGoalInput,
): GoalLifecycleBeginResult {
  const state = snapshot(task, input);
  if (state.result !== null) {
    return { kind: "result", result: state.result, snapshot: state };
  }
  const errorCode = state.errorCode ?? "CONTROL_LINK_INTERNAL_ERROR";
  return { kind: "error", errorCode, snapshot: state };
}

function isGoalTerminal(task: TaskRecord): boolean {
  return (
    task.status === "completed" ||
    task.status === "cancelled" ||
    task.status === "expired" ||
    (task.status === "failed" && task.retryCount >= task.maxRetries)
  );
}

function terminalErrorCode(task: TaskRecord): ControlLinkGoalErrorCode {
  const parsed = controlLinkGoalErrorCodeSchema.safeParse(task.failureReason);
  if (parsed.success) return parsed.data;
  if (task.status === "expired") return "AI_TIMEOUT";
  if (task.status === "cancelled") return "CONTROL_LINK_STOPPED";
  return "CONTROL_LINK_INTERNAL_ERROR";
}

function goalResultStatus(
  result: GoalDispatchTerminalResultV1,
): "completed" | "failed" | "cancelled" | "expired" {
  if ((result as { action?: string }).action === "waiting_for_bot") {
    // waiting 是回执专用 action，绝不是终态结果——持久层收到即代码 bug。
    // （输入类型已收窄为 terminal；此分支是对越界输入的运行时防御。）
    throw new Error("waiting_for_bot result must never be persisted as terminal.");
  }
  if (result.action === "noop") return "failed";
  if (result.outcome === "completed") return "completed";
  if (result.outcome === "cancelled") return "cancelled";
  if (result.outcome === "timed_out") return "expired";
  return "failed";
}

function lifecycleError(error: unknown): GoalLifecycleStoreError {
  if (error instanceof GoalLifecycleStoreError) return error;
  if (
    error instanceof TaskSystemError &&
    (error.code === "TASK_IDEMPOTENCY_CONFLICT" ||
      error.code === "TASK_OPERATION_CONFLICT")
  ) {
    return new GoalLifecycleStoreError(
      "GOAL_ID_CONFLICT",
      "Goal operation identity conflicts with a persisted task.",
    );
  }
  return new GoalLifecycleStoreError(
    "CONTROL_LINK_INTERNAL_ERROR",
    "Durable goal lifecycle storage is unavailable or invalid.",
  );
}

function assertTerminalTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60_000) {
    throw new TypeError("Goal lifecycle terminal TTL is invalid.");
  }
}

async function waitForPoll(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 100);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

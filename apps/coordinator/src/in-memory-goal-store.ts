import { createHash } from "node:crypto";

import {
  controlLinkGoalErrorCodeSchema,
  goalDispatchResultV1Schema,
  publicTaskDetailV1Schema,
  taskHistoryListPageV1Schema,
  taskHistoryListQueryV1Schema,
  type ControlLinkGoalErrorCode,
  type ControlLinkGoalRequestV1,
  type GoalDispatchResultV1,
  type PublicTaskDetailV1,
  type PublicTaskSummaryV1,
  type TaskHistoryListPageV1,
  type TaskHistoryListQueryV1,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  durableGoalFingerprint,
  GoalLifecycleStoreError,
  persistedGoalInputSchema,
  type GoalExecutionLease,
  type GoalLifecycleBeginResult,
  type GoalLifecycleSnapshot,
  type GoalLifecycleStore,
  type PersistedGoalInput,
} from "./goal-lifecycle-store.js";
import {
  TaskHistoryReaderError,
  type TaskHistoryDetailResult,
  type TaskHistoryReader,
} from "./task-history-reader.js";

const MAX_RECORDS = 1_000;
const GOAL_LEASE_GRACE_MS = 30_000;
const MAX_GOAL_LEASE_MS = 5 * 60_000;

const cursorSchema = z
  .object({
    version: z.literal(1),
    createdAt: z
      .string()
      .datetime({ offset: true })
      .refine((value) => new Date(value).toISOString() === value),
    taskId: z
      .string()
      .uuid()
      .refine((value) => value === value.toLowerCase()),
  })
  .strict();

type MemoryGoalRecord = {
  input: PersistedGoalInput;
  fingerprint: string;
  status: PublicTaskSummaryV1["status"];
  result: GoalDispatchResultV1 | null;
  errorCode: ControlLinkGoalErrorCode | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string;
  finishedAt: string | null;
  revision: number;
  leaseOwner: string;
  leaseExpiresAt: string;
};

export type InMemoryGoalLifecycleStoreOptions = Readonly<{
  now?: () => Date;
}>;

/**
 * Process-local goal storage for the one-click desktop runtime. PostgreSQL
 * remains authoritative whenever it is configured.
 */
export class InMemoryGoalLifecycleStore
  implements GoalLifecycleStore, TaskHistoryReader
{
  private readonly now: () => Date;
  private readonly recordsByOperation = new Map<string, MemoryGoalRecord>();
  private readonly operationByTask = new Map<string, string>();

  constructor(options: InMemoryGoalLifecycleStoreOptions = {}) {
    this.now = options.now ?? (() => new Date());
  }

  async initialize(
    terminalTtlMs: number,
  ): Promise<readonly GoalLifecycleSnapshot[]> {
    return this.refresh(terminalTtlMs);
  }

  async refresh(
    terminalTtlMs: number,
  ): Promise<readonly GoalLifecycleSnapshot[]> {
    assertTerminalTtl(terminalTtlMs);
    this.pruneTerminal(terminalTtlMs);
    return [...this.recordsByOperation.values()].map(snapshot);
  }

  async begin(
    request: ControlLinkGoalRequestV1,
  ): Promise<GoalLifecycleBeginResult> {
    const input = inputFromRequest(request);
    const fingerprint = durableGoalFingerprint(input);
    const existing = this.recordsByOperation.get(input.operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw conflictError();
      }
      if (isTerminal(existing.status)) return terminalResult(existing);
      if (Date.parse(existing.leaseExpiresAt) <= this.validNow().getTime()) {
        this.finish(existing, "expired", null, "AI_TIMEOUT");
        return terminalResult(existing);
      }
      return { kind: "busy", snapshot: snapshot(existing) };
    }

    const taskOwner = this.operationByTask.get(input.taskId);
    if (taskOwner && taskOwner !== input.operationId) throw conflictError();
    this.makeRoom();

    const now = this.validNow();
    const leaseOwner = `local-goal-${createHash("sha256")
      .update(input.operationId, "utf8")
      .digest("hex")
      .slice(0, 32)}`;
    const leaseExpiresAt = new Date(
      now.getTime() +
        Math.min(MAX_GOAL_LEASE_MS, input.timeoutMs + GOAL_LEASE_GRACE_MS),
    ).toISOString();
    const record: MemoryGoalRecord = {
      input,
      fingerprint,
      status: "running",
      result: null,
      errorCode: null,
      failureReason: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      startedAt: now.toISOString(),
      finishedAt: null,
      revision: 1,
      leaseOwner,
      leaseExpiresAt,
    };
    this.recordsByOperation.set(input.operationId, record);
    this.operationByTask.set(input.taskId, input.operationId);
    return {
      kind: "execute",
      lease: {
        taskId: input.taskId,
        leaseOwner,
        revision: record.revision,
      },
      snapshot: snapshot(record),
    };
  }

  async recordResult(
    lease: GoalExecutionLease,
    resultInput: GoalDispatchResultV1,
  ): Promise<GoalLifecycleSnapshot> {
    const result = goalDispatchResultV1Schema.parse(resultInput);
    const record = this.requireLease(lease);
    if (
      result.taskId !== record.input.taskId ||
      result.botId !== record.input.botId
    ) {
      throw new GoalLifecycleStoreError(
        "CONTROL_LINK_INTERNAL_ERROR",
        "Local goal result identity is invalid.",
      );
    }
    const status = resultStatus(result);
    this.finish(
      record,
      status,
      result,
      null,
      status === "failed" ? "GOAL_RESULT_FAILED" : null,
    );
    return snapshot(record);
  }

  async recordError(
    lease: GoalExecutionLease,
    errorCodeInput: ControlLinkGoalErrorCode,
    status: "failed" | "cancelled" | "expired",
  ): Promise<GoalLifecycleSnapshot> {
    const errorCode = controlLinkGoalErrorCodeSchema.parse(errorCodeInput);
    const record = this.requireLease(lease);
    this.finish(
      record,
      status,
      null,
      errorCode,
      status === "failed" ? errorCode : null,
    );
    return snapshot(record);
  }

  isAssignmentLeaseActive(input: Readonly<{
    taskId: string;
    botId: string;
    leaseOwner: string;
  }>): boolean {
    const operationId = this.operationByTask.get(input.taskId);
    const record = operationId
      ? this.recordsByOperation.get(operationId)
      : undefined;
    return Boolean(
      record &&
        record.status === "running" &&
        record.input.botId === input.botId &&
        record.leaseOwner === input.leaseOwner &&
        Date.parse(record.leaseExpiresAt) > this.validNow().getTime(),
    );
  }

  async listTaskHistory(
    queryInput: TaskHistoryListQueryV1,
  ): Promise<TaskHistoryListPageV1> {
    let query: TaskHistoryListQueryV1;
    let before: z.infer<typeof cursorSchema> | null;
    try {
      query = taskHistoryListQueryV1Schema.parse(queryInput);
      before = query.cursor === null ? null : decodeCursor(query.cursor);
    } catch (cause) {
      if (cause instanceof TaskHistoryReaderError) throw cause;
      throw new TaskHistoryReaderError(
        "REQUEST_INVALID",
        "Task history request is invalid.",
      );
    }

    const matching = [...this.recordsByOperation.values()]
      .filter(
        (record) =>
          (query.status === null || record.status === query.status) &&
          (query.botId === null || record.input.botId === query.botId) &&
          (before === null || comesBefore(record, before)),
      )
      .sort(compareRecords);
    const page = matching.slice(0, query.limit);
    const last = page.at(-1);
    return taskHistoryListPageV1Schema.parse({
      generatedAt: this.validNow().toISOString(),
      tasks: page.map(projectSummary),
      nextCursor:
        matching.length > page.length && last
          ? encodeCursor(last.createdAt, last.input.taskId)
          : null,
    });
  }

  async getTaskDetail(
    taskId: string,
  ): Promise<TaskHistoryDetailResult | null> {
    const operationId = this.operationByTask.get(taskId);
    const record = operationId
      ? this.recordsByOperation.get(operationId)
      : undefined;
    if (!record) return null;
    const task: PublicTaskDetailV1 = publicTaskDetailV1Schema.parse({
      ...projectSummary(record),
      operatorGoal: record.input.operatorGoal,
    });
    return { generatedAt: this.validNow().toISOString(), task };
  }

  private requireLease(lease: GoalExecutionLease): MemoryGoalRecord {
    const operationId = this.operationByTask.get(lease.taskId);
    const record = operationId
      ? this.recordsByOperation.get(operationId)
      : undefined;
    if (
      !record ||
      record.status !== "running" ||
      record.leaseOwner !== lease.leaseOwner ||
      record.revision !== lease.revision
    ) {
      throw new GoalLifecycleStoreError(
        "CONTROL_LINK_INTERNAL_ERROR",
        "Local goal lease is no longer authoritative.",
      );
    }
    return record;
  }

  private finish(
    record: MemoryGoalRecord,
    status: "completed" | "failed" | "cancelled" | "expired",
    result: GoalDispatchResultV1 | null,
    errorCode: ControlLinkGoalErrorCode | null,
    failureReason: string | null = null,
  ): void {
    const now = this.validNow().toISOString();
    record.status = status;
    record.result = result === null ? null : structuredClone(result);
    record.errorCode = errorCode;
    record.failureReason = failureReason;
    record.updatedAt = now;
    record.finishedAt = now;
    record.revision += 1;
  }

  private pruneTerminal(terminalTtlMs: number): void {
    const cutoff = this.validNow().getTime() - terminalTtlMs;
    for (const [operationId, record] of this.recordsByOperation) {
      if (!isTerminal(record.status) || Date.parse(record.updatedAt) >= cutoff) {
        continue;
      }
      this.recordsByOperation.delete(operationId);
      this.operationByTask.delete(record.input.taskId);
    }
  }

  private makeRoom(): void {
    if (this.recordsByOperation.size < MAX_RECORDS) return;
    const oldestTerminal = [...this.recordsByOperation.entries()]
      .filter(([, record]) => isTerminal(record.status))
      .sort(([, left], [, right]) =>
        left.updatedAt.localeCompare(right.updatedAt),
      )[0];
    if (!oldestTerminal) {
      throw new GoalLifecycleStoreError(
        "CONTROL_LINK_BACKPRESSURE",
        "Local goal history is full.",
      );
    }
    this.recordsByOperation.delete(oldestTerminal[0]);
    this.operationByTask.delete(oldestTerminal[1].input.taskId);
  }

  private validNow(): Date {
    const now = this.now();
    if (!Number.isFinite(now.getTime())) throw new TypeError("Clock is invalid.");
    return now;
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

function snapshot(record: MemoryGoalRecord): GoalLifecycleSnapshot {
  return {
    operationId: record.input.operationId,
    taskId: record.input.taskId,
    botId: record.input.botId,
    fingerprint: record.fingerprint,
    title: "Submitted goal",
    status: record.status,
    startedAt: record.startedAt,
    updatedAt: record.updatedAt,
    result: record.result === null ? null : structuredClone(record.result),
    errorCode: record.errorCode,
  };
}

function terminalResult(record: MemoryGoalRecord): GoalLifecycleBeginResult {
  const state = snapshot(record);
  if (state.result !== null) {
    return { kind: "result", result: state.result, snapshot: state };
  }
  return {
    kind: "error",
    errorCode: state.errorCode ?? "CONTROL_LINK_INTERNAL_ERROR",
    snapshot: state,
  };
}

function projectSummary(record: MemoryGoalRecord): PublicTaskSummaryV1 {
  return {
    taskId: record.input.taskId,
    taskType: "coordinator.goal",
    title: "Submitted goal",
    status: record.status,
    priority: 50,
    riskLevel: "R1",
    botId: record.input.botId,
    failureReason: record.failureReason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    revision: record.revision,
  };
}

function resultStatus(
  result: GoalDispatchResultV1,
): "completed" | "failed" | "cancelled" | "expired" {
  if (result.action === "noop") return "failed";
  if (result.outcome === "completed") return "completed";
  if (result.outcome === "cancelled") return "cancelled";
  if (result.outcome === "timed_out") return "expired";
  return "failed";
}

function isTerminal(status: PublicTaskSummaryV1["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "expired"
  );
}

function conflictError(): GoalLifecycleStoreError {
  return new GoalLifecycleStoreError(
    "GOAL_ID_CONFLICT",
    "Local goal identity conflicts with an existing operation.",
  );
}

function compareRecords(left: MemoryGoalRecord, right: MemoryGoalRecord): number {
  const byTime = right.createdAt.localeCompare(left.createdAt);
  return byTime || right.input.taskId.localeCompare(left.input.taskId);
}

function comesBefore(
  record: MemoryGoalRecord,
  cursor: z.infer<typeof cursorSchema>,
): boolean {
  return (
    record.createdAt < cursor.createdAt ||
    (record.createdAt === cursor.createdAt && record.input.taskId < cursor.taskId)
  );
}

function encodeCursor(createdAt: string, taskId: string): string {
  return Buffer.from(
    JSON.stringify(cursorSchema.parse({ version: 1, createdAt, taskId })),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): z.infer<typeof cursorSchema> {
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error();
    const parsed = cursorSchema.parse(
      JSON.parse(decoded.toString("utf8")) as unknown,
    );
    if (encodeCursor(parsed.createdAt, parsed.taskId) !== cursor) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new TaskHistoryReaderError(
      "REQUEST_INVALID",
      "Task history cursor is invalid.",
    );
  }
}

function assertTerminalTtl(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1_000 || value > 24 * 60 * 60_000) {
    throw new TypeError("Goal lifecycle terminal TTL is invalid.");
  }
}

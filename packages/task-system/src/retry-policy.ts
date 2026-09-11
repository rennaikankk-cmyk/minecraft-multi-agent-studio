import { createHash } from "node:crypto";

import { reasonCodeSchema, type TaskRecord } from "./model.js";

/**
 * AGENTS.md §5 says a retryable error is retried with bounded exponential
 * backoff and jitter, and that safety, permission and schema errors must never
 * be retried automatically. This module is the single decision point for that
 * policy so the worker only has to wire it.
 *
 * The classification deliberately reuses the error-code vocabulary that
 * already exists in this package instead of inventing a second one:
 *   - `TaskSystemErrorCode` (src/errors.ts:1-21)
 *   - `TaskWorkerError` codes (src/bullmq-worker.ts:176-193)
 *   - the durable `failureReason` reason codes (src/model.ts:26-30)
 * Anything that is not explicitly classified is NOT retryable (fail-closed).
 */

/** First retry delay. Outbox/task retry ceilings already use this order. */
export const TASK_RETRY_BASE_DELAY_MS = 1_000;
/** Upper bound for one scheduled retry delay (outbox-reconciler.ts:12). */
export const TASK_RETRY_MAX_DELAY_MS = 60_000;

/**
 * Platform-declared transient conditions: infrastructure that a bounded
 * re-dispatch can plausibly get past. These are the only codes this package
 * retries without an explicit per-handler declaration, because every other
 * code either describes a decision (safety, policy, permission, contract) or a
 * task state that a retry cannot change.
 */
const PLATFORM_RETRYABLE_REASON_CODES: ReadonlySet<string> = new Set([
  // Worker/queue infrastructure became unavailable (bullmq-worker.ts:191).
  "TASK_WORKER_UNAVAILABLE",
  // A PostgreSQL task operation failed (errors.ts:21).
  "TASK_PERSISTENCE_FAILED",
]);

/**
 * §5 exclusions: safety errors, permission/authorization errors and
 * schema/validation errors remain terminal. The task-system code space is
 * closed and enumerable, so the codes are listed explicitly rather than
 * guessed from their shape.
 */
const NEVER_RETRYABLE_REASON_CODES: ReadonlyMap<
  string,
  TerminalFailureClass
> = new Map<string, TerminalFailureClass>([
  // ---- §5 safety and cancellation: a retry would repeat the hazard ----
  ["TASK_EXECUTION_CANCELLED", "SAFETY"], // bullmq-worker.ts:188
  ["TASK_CANCELLATION_CONFLICT", "SAFETY"], // bullmq-worker.ts:189
  ["TASK_CANCELLATION_UNACKNOWLEDGED", "SAFETY"], // bullmq-worker.ts:190
  ["TASK_WORKER_SHUTDOWN", "SAFETY"], // bullmq-worker.ts:192
  ["TASK_LEASE_LOST", "SAFETY"], // bullmq-worker.ts:187
  // ---- §5 permission / authorization / ownership conflicts ----
  ["TASK_CANCELLATION_PENDING", "PERMISSION"], // errors.ts:16
  ["TASK_RISK_APPROVAL_REQUIRED", "PERMISSION"], // errors.ts:20
  ["TASK_LEASE_REQUIRED", "PERMISSION"], // errors.ts:10
  ["TASK_LEASE_OWNER_MISMATCH", "PERMISSION"], // errors.ts:15
  ["TASK_LEASE_CONFLICT", "PERMISSION"], // errors.ts:11
  ["TASK_LEASE_EXPIRED", "PERMISSION"], // errors.ts:14
  ["TASK_BOT_ASSIGNMENT_CONFLICT", "PERMISSION"], // errors.ts:12
  ["TASK_SERVER_CONTEXT_CONFLICT", "PERMISSION"], // errors.ts:13
  // ---- §5 schema / validation / contract ----
  ["TASK_HANDLER_OUTPUT_INVALID", "SCHEMA"], // bullmq-worker.ts:184
  ["TASK_HANDLER_CONTRACT_MISMATCH", "SCHEMA"], // bullmq-worker.ts:183
  ["TASK_HANDLER_NOT_REGISTERED", "SCHEMA"], // bullmq-worker.ts:182
  ["TASK_HANDLER_ALREADY_REGISTERED", "SCHEMA"], // bullmq-worker.ts:181
  ["TASK_DISPATCH_INVALID", "SCHEMA"], // bullmq-worker.ts:179
  ["TASK_FAILURE_REASON_REQUIRED", "SCHEMA"], // errors.ts:9
  // ---- State that another durable transition already decided ----
  ["TASK_DISPATCH_STALE", "STATE"], // bullmq-worker.ts:180
  ["TASK_RECOVERY_UNSAFE", "STATE"], // bullmq-worker.ts:186
  ["TASK_NOT_FOUND", "STATE"], // errors.ts:2
  ["TASK_TERMINAL", "STATE"], // errors.ts:7
  ["TASK_TRANSITION_INVALID", "STATE"], // errors.ts:6
  ["TASK_REVISION_CONFLICT", "STATE"], // errors.ts:5
  ["TASK_OPERATION_CONFLICT", "STATE"], // errors.ts:4
  ["TASK_IDEMPOTENCY_CONFLICT", "STATE"], // errors.ts:3
  ["TASK_RETRY_EXHAUSTED", "STATE"], // errors.ts:8
  ["TASK_DEPENDENCIES_INCOMPLETE", "STATE"], // errors.ts:17
  ["TASK_DEADLINE_EXPIRED", "STATE"], // errors.ts:18
  // `timeoutMs` is a per-task budget: transitionTask keeps the original
  // startedAt across a requeue (state-machine.ts:226-227) and the worker fails
  // the task again as soon as the budget is gone (bullmq-worker.ts:1216-1223),
  // so retrying a timeout is provably futile and would only burn the budget.
  ["TASK_TIMEOUT_EXPIRED", "STATE"], // errors.ts:19
  ["TASK_OUTBOX_DELIVERY_EXHAUSTED", "STATE"], // postgres-repository.ts:1409
  ["TASK_OUTBOX_TASK_CONTRACT_MISMATCH", "STATE"], // postgres-repository.ts:1202
  ["TASK_OUTBOX_RECORD_INVALID", "STATE"], // postgres-repository.ts:1205
  ["TASK_DISPATCH_SUPERSEDED", "STATE"], // postgres-repository.ts:2326
]);

/**
 * Shape rules for codes introduced by handlers (the reason-code pattern is
 * open, model.ts:26-30). They mirror the classes AGENTS.md §5 forbids
 * retrying, and are checked before any declaration so a handler cannot declare
 * a safety, permission or schema code as retryable.
 */
const NEVER_RETRYABLE_CODE_FRAGMENTS: readonly string[] = [
  "CANCELLED",
  "CANCELED",
  "PAUSED",
  "STOPPING",
  "OFFLINE",
  "NOT_ONLINE",
  "INTERRUPT",
  "SAFETY",
  "EMERGENCY",
  "ABORT",
  "PERMISSION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "DENIED",
  "AUTH",
  "APPROVAL",
  "INVALID",
  "MISMATCH",
  "SCHEMA",
  "CONTRACT",
  "UNSUPPORTED",
  "UNDECLARED",
];

const NEVER_RETRYABLE_CODE_PREFIXES: readonly string[] = [
  "POLICY_",
  "TASK_LEASE_",
  "TASK_CANCELLATION_",
];

export type TaskFailureClass =
  | "RETRYABLE_TRANSIENT"
  | "RETRYABLE_DECLARED"
  | "SAFETY"
  | "PERMISSION"
  | "SCHEMA"
  | "STATE"
  | "UNCLASSIFIED";

/** §5 classes that always stay terminal. */
export type TerminalFailureClass = "SAFETY" | "PERMISSION" | "SCHEMA" | "STATE";

export type TaskFailureClassification = Readonly<{
  /** Normalized code the decision was made on. */
  code: string;
  /** Where the code came from. */
  origin: "failure-reason" | "cause" | "none";
  classification: TaskFailureClass;
  retryable: boolean;
}>;

export type TaskFailureClassificationInput = Readonly<{
  /** The durable reason code persisted with the `failed` status. */
  failureReason: string;
  /** Stable code carried by the thrown handler error, when it has one. */
  causeCode?: string | null | undefined;
  /** Codes the registered handler declares as retryable (§5). */
  retryableErrorCodes?: readonly string[] | undefined;
}>;

export type TaskRetryPlanInput = TaskFailureClassificationInput &
  Readonly<{
    taskId: string;
    executionIdempotent: boolean;
    retryCount: number;
    maxRetries: number;
  }>;

export type TaskRetryPlan = Readonly<{
  /** 1-based attempt number this re-dispatch represents. */
  attempt: number;
  delayMs: number;
  code: string;
  classification: Exclude<
    TaskFailureClass,
    "SAFETY" | "PERMISSION" | "SCHEMA" | "STATE" | "UNCLASSIFIED"
  >;
}>;

export type TaskRetryDelayOptions = Readonly<{
  /**
   * Deterministic jitter seed. Defaults to a hash of the task identity, so a
   * replayed decision schedules the exact same delay.
   */
  seed?: string | undefined;
  /** Injectable jitter source returning [0, 1). Deterministic by default. */
  randomUnit?: ((seed: string) => number) | undefined;
}>;

function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

function matchesFragment(code: string, fragments: readonly string[]): boolean {
  return fragments.some((fragment) => code.includes(fragment));
}

/**
 * Deterministic jitter in [0, 1) derived from the seed. It is replay-stable
 * (no hidden clock or PRNG state), which is what makes a repeated
 * `retryTaskDispatch` call schedule the identical availability timestamp.
 */
export function deterministicJitterUnit(seed: string): number {
  const digest = createHash("sha256").update(seed, "utf8").digest();
  return digest.readUInt32BE(0) / 0x1_0000_0000;
}

/**
 * Bounded exponential backoff with jitter ("equal jitter"): the delay for
 * attempt N is half to full of `base * 2 ** (N - 1)`, never above `maxMs`.
 * `attempt` is 1-based and out-of-range values fail closed to the ceiling
 * instead of producing an unbounded or negative delay.
 */
export function taskRetryDelayMs(
  attempt: number,
  options: TaskRetryDelayOptions &
    Readonly<{ baseMs?: number | undefined; maxMs?: number | undefined }> = {},
): number {
  const baseMs = options.baseMs ?? TASK_RETRY_BASE_DELAY_MS;
  const maxMs = options.maxMs ?? TASK_RETRY_MAX_DELAY_MS;
  const boundedAttempt = Number.isFinite(attempt)
    ? Math.min(Math.max(Math.floor(attempt), 1), 32)
    : 32;
  const ceiling = Math.min(maxMs, baseMs * 2 ** (boundedAttempt - 1));
  const randomUnit = options.randomUnit ?? deterministicJitterUnit;
  const unit = randomUnit(options.seed ?? `attempt:${boundedAttempt}`);
  const fraction = Number.isFinite(unit)
    ? Math.min(Math.max(unit, 0), 1)
    : 1;
  const delayMs = Math.round(ceiling / 2 + (ceiling / 2) * fraction);
  return Math.max(0, Math.min(maxMs, delayMs));
}

/**
 * Pure §5 classifier. Only the two platform-transient infrastructure codes and
 * explicitly declared codes are retryable; §5 exclusions always win over a
 * declaration and an unclassified failure is never retryable.
 */
export function classifyTaskFailure(
  input: TaskFailureClassificationInput,
): TaskFailureClassification {
  const causeCode =
    input.causeCode === undefined || input.causeCode === null
      ? null
      : reasonCodeSchema.safeParse(input.causeCode).success
        ? normalizeCode(input.causeCode)
        : null;
  const reason = normalizeCode(input.failureReason);
  const code = causeCode ?? reason;
  const origin: TaskFailureClassification["origin"] =
    causeCode !== null ? "cause" : reason.length > 0 ? "failure-reason" : "none";

  const classify = (classification: TaskFailureClass): TaskFailureClassification =>
    Object.freeze({
      code,
      origin,
      classification,
      retryable:
        classification === "RETRYABLE_TRANSIENT" ||
        classification === "RETRYABLE_DECLARED",
    });

  // 0. No taxonomy at all: the worker's generic handler-failure reason
  //    (bullmq-worker.ts:1088) when the thrown error carried no code. §5
  //    fail-closed: an unclassified failure is never retried.
  if (code.length === 0 || code === "TASK_HANDLER_FAILED") {
    return classify("UNCLASSIFIED");
  }
  // 1. Platform-declared transient infrastructure. Listed before the shape
  //    rules because these codes are the platform's own retryable set.
  if (PLATFORM_RETRYABLE_REASON_CODES.has(code)) {
    return classify("RETRYABLE_TRANSIENT");
  }
  // 2. §5 exclusions, by exact code and by shape.
  const exact = NEVER_RETRYABLE_REASON_CODES.get(code);
  if (exact !== undefined) {
    return classify(exact);
  }
  if (code.length > 0 && matchesFragment(code, NEVER_RETRYABLE_CODE_FRAGMENTS)) {
    return classify(classifyNeverRetryable(code));
  }
  if (
    code.length > 0 &&
    NEVER_RETRYABLE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
  ) {
    return classify(classifyNeverRetryable(code));
  }
  // 3. Declared per-handler retryable error set (§5). Reached only for codes
  //    that are not excluded above, so the exclusions cannot be overridden.
  if (
    code.length > 0 &&
    (input.retryableErrorCodes ?? []).some(
      (declared) => normalizeCode(declared) === code,
    )
  ) {
    return classify("RETRYABLE_DECLARED");
  }
  // 4. Fail-closed default.
  return classify("UNCLASSIFIED");
}

const SAFETY_CODE_FRAGMENTS: readonly string[] = [
  "CANCELLED",
  "CANCELED",
  "PAUSED",
  "STOPPING",
  "OFFLINE",
  "NOT_ONLINE",
  "INTERRUPT",
  "SAFETY",
  "EMERGENCY",
  "ABORT",
];

const PERMISSION_CODE_FRAGMENTS: readonly string[] = [
  "PERMISSION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "DENIED",
  "AUTH",
  "APPROVAL",
];

const SCHEMA_CODE_FRAGMENTS: readonly string[] = [
  "INVALID",
  "MISMATCH",
  "SCHEMA",
  "CONTRACT",
  "UNSUPPORTED",
  "UNDECLARED",
];

function classifyNeverRetryable(code: string): TaskFailureClass {
  // A policy gate is a refusal by the platform, not a defect to re-drive.
  if (code.startsWith("POLICY_")) {
    return "SCHEMA";
  }
  if (matchesFragment(code, SAFETY_CODE_FRAGMENTS)) {
    return "SAFETY";
  }
  if (
    code.startsWith("TASK_LEASE_") ||
    code.startsWith("TASK_CANCELLATION_") ||
    matchesFragment(code, PERMISSION_CODE_FRAGMENTS)
  ) {
    return "PERMISSION";
  }
  if (matchesFragment(code, SCHEMA_CODE_FRAGMENTS)) {
    return "SCHEMA";
  }
  return "STATE";
}

/**
 * The whole retry budget decision: retryable failure + idempotent execution
 * contract + remaining budget. Returns `null` when the failed task must stay
 * terminal. This never exceeds `maxRetries`: `retryCount` is only incremented
 * by the `failed -> queued` transition (state-machine.ts:229-232), which
 * refuses to run once the budget is gone (state-machine.ts:202-209).
 */
export function planTaskRetry(
  input: TaskRetryPlanInput,
  options: TaskRetryDelayOptions = {},
): TaskRetryPlan | null {
  // Reuses the existing stalled-recovery gate (bullmq-worker.ts:855-858):
  // a non-idempotent task is never automatically re-dispatched.
  if (!input.executionIdempotent) return null;
  if (input.retryCount >= input.maxRetries) return null;
  const classification = classifyTaskFailure(input);
  if (!classification.retryable) return null;
  const attempt = input.retryCount + 1;
  return Object.freeze({
    attempt,
    delayMs: taskRetryDelayMs(attempt, {
      ...options,
      seed:
        options.seed ??
        `${input.taskId}\u0000${classification.code}\u0000${attempt}`,
    }),
    code: classification.code,
    classification:
      classification.classification === "RETRYABLE_DECLARED"
        ? "RETRYABLE_DECLARED"
        : "RETRYABLE_TRANSIENT",
  });
}

/**
 * Extracts the stable error code a thrown handler error carries, so the
 * classification can use the handler's own taxonomy. Errors without a
 * reason-code-shaped `code` deliberately return `null` (fail-closed).
 */
export function taskFailureCauseCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const value = (error as { code?: unknown }).code;
  if (typeof value !== "string") return null;
  const parsed = reasonCodeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Reason code persisted with an automatic retry requeue. */
export const TASK_RETRY_SCHEDULED_REASON_CODE = "TASK_RETRYABLE_FAILURE_REQUEUED";

/** Narrowing helper for callers that hold a durable task record. */
export function planTaskRecordRetry(
  task: Pick<
    TaskRecord,
    | "taskId"
    | "executionIdempotent"
    | "retryCount"
    | "maxRetries"
    | "failureReason"
  >,
  input: Readonly<{
    causeCode?: string | null | undefined;
    retryableErrorCodes?: readonly string[] | undefined;
  }> = {},
  options: TaskRetryDelayOptions = {},
): TaskRetryPlan | null {
  if (task.failureReason === null) return null;
  return planTaskRetry(
    {
      taskId: task.taskId,
      executionIdempotent: task.executionIdempotent,
      retryCount: task.retryCount,
      maxRetries: task.maxRetries,
      failureReason: task.failureReason,
      causeCode: input.causeCode ?? null,
      retryableErrorCodes: input.retryableErrorCodes,
    },
    options,
  );
}

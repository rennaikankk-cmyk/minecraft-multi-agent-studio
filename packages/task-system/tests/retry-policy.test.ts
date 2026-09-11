import { describe, expect, it } from "vitest";

import { TaskSystemError } from "../src/errors.js";
import { TaskWorkerError } from "../src/bullmq-worker.js";
import {
  TASK_RETRY_BASE_DELAY_MS,
  TASK_RETRY_MAX_DELAY_MS,
  classifyTaskFailure,
  deterministicJitterUnit,
  planTaskRecordRetry,
  planTaskRetry,
  taskFailureCauseCode,
  taskRetryDelayMs,
} from "../src/retry-policy.js";

const TASK_ID = "2a7f5a33-05c7-4336-a037-27c196256978";

function planInput(
  overrides: Partial<Parameters<typeof planTaskRetry>[0]> = {},
): Parameters<typeof planTaskRetry>[0] {
  return {
    taskId: TASK_ID,
    executionIdempotent: true,
    retryCount: 0,
    maxRetries: 3,
    failureReason: "TASK_HANDLER_FAILED",
    ...overrides,
  };
}

describe("task retry policy classification", () => {
  it.each([
    ["TASK_WORKER_UNAVAILABLE", "RETRYABLE_TRANSIENT"],
    ["TASK_PERSISTENCE_FAILED", "RETRYABLE_TRANSIENT"],
  ] as const)(
    "retries the platform transient infrastructure code %s",
    (code, classification) => {
      expect(
        classifyTaskFailure({ failureReason: code }),
      ).toMatchObject({ code, classification, retryable: true });
    },
  );

  it.each([
    // §5 safety and cancellation: never retried.
    ["TASK_EXECUTION_CANCELLED", "SAFETY"],
    ["TASK_CANCELLATION_PENDING", "PERMISSION"],
    ["TASK_WORKER_SHUTDOWN", "SAFETY"],
    ["SKILL_ABORTED", "SAFETY"],
    ["NORMAL_ACTIONS_PAUSED", "SAFETY"],
    ["BOT_OFFLINE", "SAFETY"],
    ["POLICY_STRAIGHT_DOWN_FORBIDDEN", "SCHEMA"],
    // §5 permission/authorization: never retried.
    ["TASK_LEASE_OWNER_MISMATCH", "PERMISSION"],
    ["TASK_RISK_APPROVAL_REQUIRED", "PERMISSION"],
    ["SKILL_CAPABILITY_DENIED", "PERMISSION"],
    ["SKILL_AUTH_MISMATCH", "PERMISSION"],
    // §5 schema/validation/contract: never retried.
    ["TASK_HANDLER_OUTPUT_INVALID", "SCHEMA"],
    ["TASK_DISPATCH_INVALID", "SCHEMA"],
    ["TASK_HANDLER_CONTRACT_MISMATCH", "SCHEMA"],
    ["SKILL_INPUT_INVALID", "SCHEMA"],
    ["TARGET_SERVER_PROFILE_MISMATCH", "SCHEMA"],
    // Durable state another transition already decided.
    ["TASK_REVISION_CONFLICT", "STATE"],
    ["TASK_TERMINAL", "STATE"],
    ["TASK_TRANSITION_INVALID", "STATE"],
    ["TASK_RETRY_EXHAUSTED", "STATE"],
    ["TASK_TIMEOUT_EXPIRED", "STATE"],
    ["TASK_DEADLINE_EXPIRED", "STATE"],
    ["TASK_OUTBOX_DELIVERY_EXHAUSTED", "STATE"],
    // No taxonomy: fail-closed.
    ["TASK_HANDLER_FAILED", "UNCLASSIFIED"],
    ["SOMETHING_NEVER_SEEN_BEFORE", "UNCLASSIFIED"],
  ] as const)(
    "keeps the non-retryable failure %s terminal (%s)",
    (code, classification) => {
      expect(
        classifyTaskFailure({ failureReason: code }),
      ).toMatchObject({ code, classification, retryable: false });
    },
  );

  it("classifies the thrown handler error cause instead of the generic reason", () => {
    expect(
      classifyTaskFailure({
        failureReason: "TASK_HANDLER_FAILED",
        causeCode: "TASK_WORKER_UNAVAILABLE",
      }),
    ).toMatchObject({
      code: "TASK_WORKER_UNAVAILABLE",
      origin: "cause",
      classification: "RETRYABLE_TRANSIENT",
      retryable: true,
    });
  });

  it("ignores a cause code that is not a stable reason code", () => {
    expect(
      classifyTaskFailure({
        failureReason: "TASK_HANDLER_FAILED",
        causeCode: "redis connection reset",
      }),
    ).toMatchObject({
      origin: "failure-reason",
      classification: "UNCLASSIFIED",
      retryable: false,
    });
  });

  it("retries only declared codes that are not §5 exclusions", () => {
    expect(
      classifyTaskFailure({
        failureReason: "PATHFINDER_GOTO_FAILED",
        retryableErrorCodes: ["PATHFINDER_GOTO_FAILED"],
      }),
    ).toMatchObject({ classification: "RETRYABLE_DECLARED", retryable: true });

    expect(
      classifyTaskFailure({
        failureReason: "SKILL_INPUT_INVALID",
        retryableErrorCodes: ["SKILL_INPUT_INVALID"],
      }),
    ).toMatchObject({ classification: "SCHEMA", retryable: false });

    expect(
      classifyTaskFailure({
        failureReason: "NORMAL_ACTIONS_PAUSED",
        retryableErrorCodes: ["NORMAL_ACTIONS_PAUSED"],
      }),
    ).toMatchObject({ classification: "SAFETY", retryable: false });

    expect(
      classifyTaskFailure({
        failureReason: "SKILL_CAPABILITY_DENIED",
        retryableErrorCodes: ["SKILL_CAPABILITY_DENIED"],
      }),
    ).toMatchObject({ classification: "PERMISSION", retryable: false });
  });
});

describe("task retry budget", () => {
  it("plans a retry while the budget allows", () => {
    const plan = planTaskRetry(
      planInput({
        failureReason: "TASK_WORKER_UNAVAILABLE",
        retryCount: 1,
        maxRetries: 3,
      }),
      { seed: "budget-seed" },
    );
    expect(plan).toMatchObject({
      attempt: 2,
      code: "TASK_WORKER_UNAVAILABLE",
      classification: "RETRYABLE_TRANSIENT",
    });
    expect(plan?.delayMs).toBeGreaterThan(0);
  });

  it("does not retry at the budget boundary", () => {
    const retryable = { failureReason: "TASK_WORKER_UNAVAILABLE" } as const;
    expect(
      planTaskRetry(
        planInput({ ...retryable, retryCount: 2, maxRetries: 3 }),
        { seed: "boundary" },
      ),
    ).not.toBeNull();
    expect(
      planTaskRetry(
        planInput({ ...retryable, retryCount: 3, maxRetries: 3 }),
        { seed: "boundary" },
      ),
    ).toBeNull();
    expect(
      planTaskRetry(
        planInput({ ...retryable, retryCount: 0, maxRetries: 0 }),
        { seed: "boundary" },
      ),
    ).toBeNull();
  });

  it("never re-dispatches a non-idempotent task", () => {
    expect(
      planTaskRetry(
        planInput({
          failureReason: "TASK_WORKER_UNAVAILABLE",
          executionIdempotent: false,
        }),
      ),
    ).toBeNull();
  });

  it("returns no plan for a non-retryable failure", () => {
    expect(
      planTaskRetry(
        planInput({
          failureReason: "TASK_HANDLER_FAILED",
          causeCode: "TASK_HANDLER_OUTPUT_INVALID",
        }),
      ),
    ).toBeNull();
  });

  it("plans from a durable task record including its declared codes", () => {
    const task = {
      taskId: TASK_ID,
      executionIdempotent: true,
      retryCount: 0,
      maxRetries: 2,
      failureReason: "SKILL_CAPABILITY_FAILED",
    };
    expect(
      planTaskRecordRetry(task, {
        retryableErrorCodes: ["SKILL_CAPABILITY_FAILED"],
      }),
    ).toMatchObject({ attempt: 1, code: "SKILL_CAPABILITY_FAILED" });
    expect(planTaskRecordRetry(task)).toBeNull();
    expect(
      planTaskRecordRetry({ ...task, failureReason: null }),
    ).toBeNull();
  });
});

describe("bounded exponential backoff with jitter", () => {
  it("grows exponentially and stays inside the jittered half-open band", () => {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const ceiling = Math.min(
        TASK_RETRY_MAX_DELAY_MS,
        TASK_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
      for (const unit of [0, 0.25, 0.5, 0.99, 1]) {
        const delayMs = taskRetryDelayMs(attempt, {
          seed: `band-${attempt}`,
          randomUnit: () => unit,
        });
        expect(delayMs).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
        expect(delayMs).toBeLessThanOrEqual(ceiling);
        expect(delayMs).toBeLessThanOrEqual(TASK_RETRY_MAX_DELAY_MS);
      }
    }
  });

  it("is monotonic in the attempt for a fixed jitter source", () => {
    const delayFor = (attempt: number) =>
      taskRetryDelayMs(attempt, { randomUnit: () => 0.5 });
    const delays = [1, 2, 3, 4, 5].map(delayFor);
    for (let index = 1; index < delays.length; index += 1) {
      expect(delays[index]!).toBeGreaterThan(delays[index - 1]!);
    }
  });

  it("caps the ceiling at the configured maximum", () => {
    expect(taskRetryDelayMs(40, { randomUnit: () => 1 })).toBe(
      TASK_RETRY_MAX_DELAY_MS,
    );
    expect(
      taskRetryDelayMs(40, { randomUnit: () => 0, baseMs: 10, maxMs: 100 }),
    ).toBe(50);
  });

  it("is deterministic per seed and spread across seeds", () => {
    const seedDelay = (seed: string) => taskRetryDelayMs(3, { seed });
    expect(seedDelay("task-a")).toBe(seedDelay("task-a"));
    const samples = new Set(
      Array.from({ length: 64 }, (_value, index) => seedDelay(`task-${index}`)),
    );
    expect(samples.size).toBeGreaterThan(1);
    expect(deterministicJitterUnit("task-a")).toBe(
      deterministicJitterUnit("task-a"),
    );
    expect(deterministicJitterUnit("task-a")).toBeGreaterThanOrEqual(0);
    expect(deterministicJitterUnit("task-a")).toBeLessThan(1);
  });

  it("uses distinct delays for equal budgets of different tasks", () => {
    const delayFor = (taskId: string) =>
      planTaskRetry(
        planInput({
          taskId,
          failureReason: "TASK_WORKER_UNAVAILABLE",
        }),
      )?.delayMs;
    const first = delayFor("2a7f5a33-05c7-4336-a037-27c196256978");
    const second = delayFor("3b8f6a44-16d8-4447-b148-38d207367a89");
    expect(first).toBe(
      delayFor("2a7f5a33-05c7-4336-a037-27c196256978"),
    );
    expect(first).not.toBe(second);
  });

  it("fails closed to the ceiling for a non-finite attempt", () => {
    expect(taskRetryDelayMs(Number.NaN, { randomUnit: () => 1 })).toBe(
      TASK_RETRY_MAX_DELAY_MS,
    );
  });
});

describe("cause code extraction", () => {
  it("reads stable codes from thrown errors only", () => {
    expect(
      taskFailureCauseCode(
        new TaskSystemError("TASK_WORKER_UNAVAILABLE", "unavailable"),
      ),
    ).toBe("TASK_WORKER_UNAVAILABLE");
    expect(
      taskFailureCauseCode(
        new TaskWorkerError("TASK_HANDLER_FAILED", "handler failed"),
      ),
    ).toBe("TASK_HANDLER_FAILED");
    expect(taskFailureCauseCode({ code: "PATHFINDER_GOTO_FAILED" })).toBe(
      "PATHFINDER_GOTO_FAILED",
    );
    expect(taskFailureCauseCode(new Error("bridge returned 503"))).toBeNull();
    expect(taskFailureCauseCode({ code: "lowercase" })).toBeNull();
    expect(taskFailureCauseCode({ code: 42 })).toBeNull();
    expect(taskFailureCauseCode(undefined)).toBeNull();
    expect(taskFailureCauseCode(null)).toBeNull();
    expect(taskFailureCauseCode("TASK_WORKER_UNAVAILABLE")).toBeNull();
  });
});

import type { SkillExecutionResultV1 } from "@minecraft-studio/protocol";
import type {
  PlanStep,
  SkillExecutionAuthorization,
  SupervisorEvent,
} from "@minecraft-studio/skills";
import { describe, expect, it } from "vitest";

import {
  categorizeStepFailure,
  GoalExecutor,
  STEP_DISPATCH_UNAVAILABLE,
  STEP_INVOCATION_INVALID,
  STEP_TARGET_NOT_FOUND,
  stepOutcomeFromResult,
  type DispatchableStep,
} from "../src/goal-execution.js";

// ---------------------------------------------------------------------------
// §4 接线的验证。重点不是"跑通了"，而是三件容易被糊过去的事：
//   1. rejected / timed_out / cancelled 不能被当成功——前置条件被拒不是做完了。
//   2. 缺 dispatcher 要 fail closed，不能静默跳过当成功。
//   3. 三个新错误码的**分类**必须落在意图的阶梯上（命名是载荷，不是装饰）。
// ---------------------------------------------------------------------------

const AUTHORIZATION = {
  decisionId: "decision-1",
  actorId: "actor-1",
  sourceInstanceId: "coordinator-1",
  traceId: "trace-1",
  taskId: "task-1",
  botId: "bot-1",
  invocationId: "invocation-1",
  skillId: "collect.block",
  skillVersion: "1.0.0",
  issuedAt: "2026-01-01T00:00:00.000Z",
  expiresAt: "2026-01-01T00:05:00.000Z",
  allowedCapabilities: new Set(["world.interact" as const]),
} as unknown as SkillExecutionAuthorization;

function resultWith(
  outcome: SkillExecutionResultV1["payload"]["outcome"],
  errorCode?: string,
): SkillExecutionResultV1 {
  return {
    payload: { outcome, ...(errorCode !== undefined ? { errorCode } : {}) },
  } as SkillExecutionResultV1;
}

function dispatchAll(step: PlanStep): DispatchableStep {
  return { invocation: { step: step.stepIndex }, authorization: AUTHORIZATION };
}

describe("stepOutcomeFromResult", () => {
  it("treats completed as success", () => {
    expect(stepOutcomeFromResult(resultWith("completed"))).toEqual({ ok: true });
  });

  // rejected 是"前置条件没过"，把它当成功会让计划带着未满足的前提往下走。
  it.each([
    ["rejected", "BOT_NOT_ONLINE"],
    ["failed", "SKILL_HANDLER_FAILED"],
    ["timed_out", "SKILL_TIMEOUT"],
    ["cancelled", "SKILL_CANCELLED"],
  ] as const)("treats %s as failure carrying its code", (outcome, code) => {
    expect(
      stepOutcomeFromResult(
        resultWith(outcome as SkillExecutionResultV1["payload"]["outcome"], code),
      ),
    ).toEqual({ ok: false, errorCode: code });
  });

  it("falls back to a handler failure when a non-completed result carries no code", () => {
    expect(stepOutcomeFromResult(resultWith("failed"))).toEqual({
      ok: false,
      errorCode: "SKILL_HANDLER_FAILED",
    });
  });
});

describe("categorizeStepFailure", () => {
  // 这三条断言就是命名的理由。改名会让分类漂到别的阶梯，这里会红。
  it("escalates a missing dispatcher instead of retrying it", () => {
    expect(categorizeStepFailure(STEP_DISPATCH_UNAVAILABLE)).toEqual({
      category: "CONTRACT_BUG",
      firstAction: "ESCALATE_TO_OPERATOR",
    });
  });

  it("re-observes an unbindable target rather than calling a human", () => {
    expect(categorizeStepFailure(STEP_TARGET_NOT_FOUND)).toEqual({
      category: "STALE_WORLD",
      firstAction: "REOBSERVE_THEN_RETRY",
    });
  });

  it("does not burn retries on a malformed invocation envelope", () => {
    expect(categorizeStepFailure(STEP_INVOCATION_INVALID)).toEqual({
      category: "CONTRACT_BUG",
      firstAction: "ESCALATE_TO_OPERATOR",
    });
  });
});

describe("GoalExecutor", () => {
  it("drives a plan through the real invoker and reports completion", async () => {
    const invoked: unknown[] = [];
    const executor = new GoalExecutor({
      dispatch: dispatchAll,
      invoke: async (invocation) => {
        invoked.push(invocation);
        return resultWith("completed");
      },
    });

    const outcome = await executor.pursue([
      { itemName: "crafting_table", count: 1 },
    ]);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.supervision.completed).toBe(true);
    expect(outcome.supervision.failure).toBeNull();
    // 真的走到了派发路径：孤岛问题的核心断言。
    expect(invoked.length).toBeGreaterThan(0);
    expect(outcome.supervision.stepsCompleted).toBe(invoked.length);
  });

  it("fails closed when no dispatcher is wired, without inventing success", async () => {
    let invokeCalls = 0;
    const executor = new GoalExecutor({
      invoke: async () => {
        invokeCalls += 1;
        return resultWith("completed");
      },
    });

    const outcome = await executor.pursue([
      { itemName: "crafting_table", count: 1 },
    ]);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.supervision.completed).toBe(false);
    expect(invokeCalls).toBe(0);
    expect(outcome.supervision.failure).toMatchObject({
      errorCode: STEP_DISPATCH_UNAVAILABLE,
      category: "CONTRACT_BUG",
      action: "ESCALATE_TO_OPERATOR",
    });
  });

  it("reports an unplannable goal instead of dispatching anything", async () => {
    let invokeCalls = 0;
    const executor = new GoalExecutor({
      dispatch: dispatchAll,
      invoke: async () => {
        invokeCalls += 1;
        return resultWith("completed");
      },
    });

    const outcome = await executor.pursue([]);

    expect(outcome.planned).toBe(false);
    if (outcome.planned) return;
    expect(outcome.errorCode).toBe("PLAN_GOAL_INVALID");
    expect(invokeCalls).toBe(0);
  });

  it("runs the recovery ladder on a transient failure and retries the same step", async () => {
    const attempts: number[] = [];
    let reobserved = 0;
    const executor = new GoalExecutor({
      dispatch: dispatchAll,
      effects: {
        reobserve: () => {
          reobserved += 1;
        },
      },
      invoke: async () => {
        attempts.push(attempts.length + 1);
        return attempts.length === 1
          ? resultWith("failed", "SKILL_HANDLER_FAILED")
          : resultWith("completed");
      },
    });

    const outcome = await executor.pursue([
      { itemName: "crafting_table", count: 1 },
    ]);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    // 阶梯首级是 RETRY_SAME，所以不该先去 reobserve。
    expect(reobserved).toBe(0);
    expect(attempts.length).toBeGreaterThan(1);
    expect(outcome.supervision.completed).toBe(true);
    const kinds = outcome.supervision.events.map((event) => event.kind);
    expect(kinds).toContain("step-failed");
    expect(kinds).toContain("recovery-selected");
  });

  it("treats a cancelled signal as a safety interrupt rather than a skill fault", async () => {
    const controller = new AbortController();
    controller.abort();
    const events: SupervisorEvent[] = [];
    let invokeCalls = 0;
    const executor = new GoalExecutor({
      dispatch: dispatchAll,
      onEvent: (event) => events.push(event),
      invoke: async () => {
        invokeCalls += 1;
        return resultWith("completed");
      },
    });

    const outcome = await executor.pursue(
      [{ itemName: "crafting_table", count: 1 }],
      {},
      controller.signal,
    );

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(invokeCalls).toBe(0);
    expect(outcome.supervision.failure).toMatchObject({
      errorCode: "SKILL_CANCELLED",
      category: "SAFETY_INTERRUPT",
    });
    expect(events.length).toBeGreaterThan(0);
  });

  it("skips crafting a station the bot already carries", async () => {
    const dispatched: string[] = [];
    const executor = new GoalExecutor({
      dispatch: (step) => {
        dispatched.push(step.itemName);
        return dispatchAll(step);
      },
      invoke: async () => resultWith("completed"),
    });

    const outcome = await executor.pursue(
      [{ itemName: "crafting_table", count: 1 }],
      { crafting_table: 1 },
    );

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.plannedSteps).toBe(0);
    expect(dispatched).toEqual([]);
  });
});

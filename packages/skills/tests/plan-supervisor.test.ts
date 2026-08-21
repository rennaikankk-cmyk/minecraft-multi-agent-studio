import { describe, expect, it } from "vitest";

import {
  GoalPlanner,
  MAX_REPAIRS_PER_STEP,
  MAX_TOTAL_REPAIRS,
  PlanSupervisor,
  recoveryActionNeedsEffect,
  type PlanStep,
  type StepOutcome,
  type SupervisorEvent,
} from "../src/index.js";

function planFor(itemName: string, count = 1): readonly PlanStep[] {
  const result = new GoalPlanner().plan([{ itemName, count }]);
  if (!result.planned) throw new Error(`fixture plan failed: ${result.errorCode}`);
  return result.steps;
}

const ok: StepOutcome = Object.freeze({ ok: true });

function kinds(events: readonly SupervisorEvent[], kind: string): readonly SupervisorEvent[] {
  return events.filter((event) => event.kind === kind);
}

describe("PlanSupervisor happy path", () => {
  it("runs every step once when nothing fails", async () => {
    const steps = planFor("stone_pickaxe");
    const seen: number[] = [];
    const result = await new PlanSupervisor().run(steps, (step) => {
      seen.push(step.stepIndex);
      return ok;
    });

    expect(result.completed).toBe(true);
    expect(result.failure).toBeNull();
    expect(result.stepsCompleted).toBe(steps.length);
    expect(result.repairStepsInserted).toBe(0);
    expect(seen).toEqual(steps.map((step) => step.stepIndex));
  });
});

describe("PlanSupervisor recovery ladder", () => {
  it("retries a transient failure in place and then succeeds", async () => {
    const steps = planFor("oak_planks", 4);
    let calls = 0;
    const result = await new PlanSupervisor().run(steps, (step) => {
      calls += 1;
      if (step.kind === "mine" && calls === 1) {
        return { ok: false, errorCode: "COLLECT_BLOCKS_FAILED" } as const;
      }
      return ok;
    });

    expect(result.completed).toBe(true);
    const selected = kinds(result.events, "recovery-selected");
    expect(selected[0]).toMatchObject({
      category: "TRANSIENT",
      action: "RETRY_SAME",
      attempt: 1,
    });
    // 重试的是同一步，不是从头再来。
    expect(result.stepsCompleted).toBe(steps.length);
  });

  it("walks up the ladder across attempts instead of repeating one action", async () => {
    const steps = planFor("oak_log");
    const actions: string[] = [];
    const result = await new PlanSupervisor().run(
      steps,
      () => ({ ok: false, errorCode: "SKILL_TIMEOUT" }) as const,
      {},
      { reobserve: () => {} },
    );

    for (const event of kinds(result.events, "recovery-selected")) {
      if (event.action !== undefined) actions.push(event.action);
    }
    // TRANSIENT 阶梯：RETRY_SAME → REOBSERVE_THEN_RETRY → ABORT。
    expect(actions).toEqual(["RETRY_SAME", "REOBSERVE_THEN_RETRY", "ABORT"]);
    expect(result.completed).toBe(false);
    expect(result.failure).toMatchObject({
      errorCode: "SKILL_TIMEOUT",
      category: "TRANSIENT",
      action: "ABORT",
    });
  });

  it("calls the matching effect hook for each non-terminal rung", async () => {
    const steps = planFor("oak_log");
    let moved = 0;
    const result = await new PlanSupervisor().run(
      steps,
      (_step, attempt) =>
        attempt <= 1
          ? ({ ok: false, errorCode: "TARGET_OUT_OF_REACH" } as const)
          : ok,
      {},
      { moveCloser: () => { moved += 1; } },
    );

    expect(moved).toBe(1);
    expect(result.completed).toBe(true);
    expect(recoveryActionNeedsEffect("MOVE_CLOSER_THEN_RETRY")).toBe(true);
    expect(recoveryActionNeedsEffect("RETRY_SAME")).toBe(false);
  });

  it("does not pretend a missing hook succeeded", async () => {
    const steps = planFor("oak_log");
    // 没有 moveCloser 钩子的宿主：不能假装走近了。
    const result = await new PlanSupervisor().run(steps, () =>
      ({ ok: false, errorCode: "TARGET_OUT_OF_REACH" }) as const,
    );

    expect(result.completed).toBe(false);
    expect(
      kinds(result.events, "repair-rejected").some(
        (event) => event.reason === "EFFECT_UNAVAILABLE",
      ),
    ).toBe(true);
  });

  it("stops immediately on a safety interrupt rather than retrying", async () => {
    const steps = planFor("oak_log");
    let calls = 0;
    const result = await new PlanSupervisor().run(steps, () => {
      calls += 1;
      return { ok: false, errorCode: "NORMAL_ACTIONS_PAUSED" } as const;
    });

    expect(result.failure).toMatchObject({ category: "SAFETY_INTERRUPT" });
    // 首级是等待安全解除；钩子缺失 → 第二级 ABORT。绝不能变成一路重试。
    expect(calls).toBeLessThanOrEqual(2);
  });

  it("escalates a contract bug on the first failure without retrying", async () => {
    const steps = planFor("oak_log");
    let calls = 0;
    const result = await new PlanSupervisor().run(steps, () => {
      calls += 1;
      return { ok: false, errorCode: "SKILL_INPUT_INVALID" } as const;
    });

    expect(calls).toBe(1);
    expect(result.failure).toMatchObject({
      category: "CONTRACT_BUG",
      action: "ESCALATE_TO_OPERATOR",
    });
  });
});

/**
 * 这一组是本模块存在的理由：缺料时自动派生子任务，补完**回到原来那一步继续**。
 * 断言不只看"最后成功了"，还要看执行顺序真的是"插入 → 原步骤 → 后续步骤"，
 * 并且已完成的步骤没有重跑。
 */
describe("PlanSupervisor auto-generates subtasks for missing resources", () => {
  it("inserts a repair subplan and resumes the original step", async () => {
    const steps = planFor("crafting_table");
    const order: string[] = [];
    let starved = false;
    const result = await new PlanSupervisor().run(steps, (step) => {
      order.push(`${step.kind}:${step.itemName}`);
      // 第一次做工作台时假装木板被人拿走了，并如实报出缺什么。
      if (step.itemName === "crafting_table" && !starved) {
        starved = true;
        return {
          ok: false,
          errorCode: "ITEM_NOT_IN_INVENTORY",
          missing: [{ itemName: "oak_planks", count: 4 }],
        } as const;
      }
      return ok;
    });

    expect(result.completed).toBe(true);
    const planned = kinds(result.events, "repair-planned");
    expect(planned).toHaveLength(1);
    expect(planned[0]?.insertedSteps).toBeGreaterThan(0);
    expect(result.repairStepsInserted).toBe(planned[0]?.insertedSteps);

    // 顺序必须是：失败的工作台 → 补齐木板的步骤 → 再回到工作台 → 结束。
    const first = order.indexOf("craft:crafting_table");
    const last = order.lastIndexOf("craft:crafting_table");
    expect(last).toBeGreaterThan(first);
    const between = order.slice(first + 1, last);
    expect(between.some((entry) => entry.includes("oak_planks"))).toBe(true);
    // 原步骤只重试一次，不是整份计划重跑。
    expect(order.filter((entry) => entry === "craft:crafting_table")).toHaveLength(2);
  });

  it("derives the shortfall from the step itself when none is reported", async () => {
    const steps = planFor("crafting_table");
    let starved = false;
    const result = await new PlanSupervisor().run(steps, (step) => {
      if (step.itemName === "crafting_table" && !starved) {
        starved = true;
        // 不带 missing：应当退回用这一步声明的 consumes 派生目标。
        return { ok: false, errorCode: "INSUFFICIENT_MATERIALS" } as const;
      }
      return ok;
    });

    expect(result.completed).toBe(true);
    expect(kinds(result.events, "repair-planned")).toHaveLength(1);
  });

  it("refuses to guess when there is nothing to derive a goal from", async () => {
    // place-station 步骤的 consumes 只有站点本身；这里报一个缺料码但既无 missing
    // 也无可用 consumes 的情形由 mine 步骤代表——mine 不消耗任何东西。
    const steps = planFor("oak_log");
    const result = await new PlanSupervisor().run(steps, () =>
      ({ ok: false, errorCode: "ITEM_NOT_IN_INVENTORY" }) as const,
    );

    expect(result.completed).toBe(false);
    expect(
      kinds(result.events, "repair-rejected").some(
        (event) => event.reason === "NO_SHORTFALL_REPORTED",
      ),
    ).toBe(true);
  });

  it("reports honestly when the shortfall cannot be planned at all", async () => {
    const steps = planFor("oak_log");
    const result = await new PlanSupervisor().run(steps, () =>
      ({
        ok: false,
        errorCode: "ITEM_NOT_IN_INVENTORY",
        missing: [{ itemName: "netherite_ingot", count: 1 }],
      }) as const,
    );

    expect(result.completed).toBe(false);
    // 补不出来就上报，且分类是"当前知识不支持"而非接线缺陷。
    expect(result.failure).toMatchObject({
      errorCode: "PLAN_ITEM_UNOBTAINABLE",
      category: "UNSUPPORTED",
      itemName: "netherite_ingot",
    });
  });

  it("bounds repairs per step so an exhausted vein cannot loop forever", async () => {
    const steps = planFor("crafting_table");
    const result = await new PlanSupervisor().run(steps, (step) => {
      // 工作台永远缺料：补齐必须收敛，不能无限插子计划。
      if (step.itemName === "crafting_table") {
        return {
          ok: false,
          errorCode: "ITEM_NOT_IN_INVENTORY",
          missing: [{ itemName: "oak_planks", count: 4 }],
        } as const;
      }
      return ok;
    });

    expect(result.completed).toBe(false);
    expect(kinds(result.events, "repair-planned").length).toBeLessThanOrEqual(
      MAX_REPAIRS_PER_STEP,
    );
    expect(
      kinds(result.events, "repair-rejected").some(
        (event) => event.reason === "STEP_REPAIR_LIMIT_REACHED",
      ),
    ).toBe(true);
    expect(MAX_TOTAL_REPAIRS).toBeGreaterThanOrEqual(MAX_REPAIRS_PER_STEP);
  });

  it("counts a post-repair retry as a second execution even though attempt resets", async () => {
    const steps = planFor("crafting_table");
    let starved = false;
    const result = await new PlanSupervisor().run(steps, (step) => {
      if (step.itemName === "crafting_table" && !starved) {
        starved = true;
        return {
          ok: false,
          errorCode: "ITEM_NOT_IN_INVENTORY",
          missing: [{ itemName: "oak_planks", count: 4 }],
        } as const;
      }
      return ok;
    });

    expect(result.completed).toBe(true);
    const tableStarts = kinds(result.events, "step-started").filter(
      (event) => event.itemName === "crafting_table",
    );
    expect(tableStarts).toHaveLength(2);
    // 补齐后游标回到原步骤，attempt 从 1 重新数——单看 attempt 两次执行完全同形，
    // 于是"补齐完回来重试"会被读成"第一次执行"。execution 跨补齐轮次累计，是唯一
    // 能把两者分开的字段。
    expect(tableStarts.map((event) => event.attempt)).toEqual([1, 1]);
    expect(tableStarts.map((event) => event.execution)).toEqual([1, 2]);

    // 补齐插入的步骤按对象身份独立计数，不会因为 stepIndex 与原计划撞号而被并进去。
    for (const event of kinds(result.events, "step-started")) {
      if (event.itemName !== "crafting_table") expect(event.execution).toBe(1);
    }
  });

  it("does not re-run steps that already completed", async () => {
    const steps = planFor("furnace");
    // 按对象身份计数，不按 stepIndex——补齐子计划自己从 1 开始编号，会和原计划
    // 撞号，用编号统计会把两个不同步骤记成"同一步跑了两次"。
    const runCount = new Map<PlanStep, number>();
    let starved = false;
    const result = await new PlanSupervisor().run(steps, (step) => {
      runCount.set(step, (runCount.get(step) ?? 0) + 1);
      if (step.itemName === "furnace" && !starved) {
        starved = true;
        return {
          ok: false,
          errorCode: "INSUFFICIENT_MATERIALS",
          missing: [{ itemName: "cobblestone", count: 8 }],
        } as const;
      }
      return ok;
    });

    expect(result.completed).toBe(true);
    // 只有失败重试的那一步会被跑两次；其余每一步恰好一次。
    const repeated = [...runCount.entries()].filter(([, count]) => count > 1);
    expect(repeated).toHaveLength(1);
    expect(repeated[0]?.[0].itemName).toBe("furnace");
    expect(repeated[0]?.[1]).toBe(2);
    // 原计划里 furnace 之前的每一步都只跑一次，补齐不会把它们重放。
    for (const step of steps.slice(0, -1)) {
      expect(runCount.get(step)).toBe(1);
    }
  });
});


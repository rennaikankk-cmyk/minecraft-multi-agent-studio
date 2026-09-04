import {
  classifyFailure,
  isTerminalRecoveryAction,
  planRecovery,
  type FailureCategory,
  type RecoveryAction,
} from "./failure-classifier.js";
import {
  GoalPlanner,
  type PlannerInventory,
  type PlanStep,
} from "../planning/goal-planner.js";

// ---------------------------------------------------------------------------
// PlanSupervisor —— 执行一份计划，失败时按恢复阶梯处置；缺料时就地插入补齐子计划，
// 补完**回到原来那一步继续**，而不是从头重来。
//
// 这是 GoalPlanner 与 FailureClassifier 之间缺的那一环。规划器只会在**规划时**
// 按虚拟库存推链路；真实世界里矿脉会挖空、箱子会被人拿走、燃料会烧完，于是
// "计划开始时算得没错"和"执行到第 14 步时仍然没错"是两件事。
//
// 三条设计：
//   1. **缺料不是失败，是新的目标**。MISSING_RESOURCE 的首级动作是
//      ACQUIRE_RESOURCES_THEN_RETRY，这里把它落成实际动作：拿失败那一步缺的东西
//      当作新目标重新规划，把子计划插到当前位置之前，然后重试原步骤。
//   2. **补齐要收敛**。同一步骤的补齐次数、以及整轮补齐的总次数都有硬上限；
//      子计划推不出来（PLAN_ITEM_UNOBTAINABLE）就如实上报，不再往下试。
//      没有上限的"缺了就去补"在矿脉挖空时会变成无限递归。
//   3. **不重排已完成的工作**。子计划插在当前游标前，游标不回退到 0；
//      已经完成的步骤不会因为一次补齐而重跑。
//
// 监督器不碰 Mineflayer、不碰时钟、不做 IO：执行单步的动作由调用方注入，
// 所以同一套恢复逻辑在单测里可完全确定地驱动。
// ---------------------------------------------------------------------------

/** 单步执行结果。由调用方（真实 Skill 派发或测试替身）产出。 */
export type StepOutcome =
  | Readonly<{ ok: true }>
  /**
   * 失败。`errorCode` 走分类器；`missing` 可选，用于把"缺什么"讲清楚——
   * 缺料类失败若不带 missing，就只能退回重新观察，因为没有目标可补。
   */
  | Readonly<{
      ok: false;
      errorCode: string;
      missing?: readonly Readonly<{ itemName: string; count: number }>[];
    }>;

export type StepExecutor = (
  step: PlanStep,
  attempt: number,
) => StepOutcome | Promise<StepOutcome>;

export const MAX_REPAIRS_PER_STEP = 2;
export const MAX_TOTAL_REPAIRS = 8;
/** 单步在阶梯上最多推进几次。阶梯末级恒为终止动作，这里只是第二道闸。 */
export const MAX_ATTEMPTS_PER_STEP = 4;

export type SupervisorEventKind =
  | "step-started"
  | "step-completed"
  | "step-failed"
  | "recovery-selected"
  | "repair-planned"
  | "repair-rejected"
  | "step-abandoned";

export type SupervisorEvent = Readonly<{
  kind: SupervisorEventKind;
  stepIndex: number;
  itemName: string;
  /** 本轮游标停留期间的第几次尝试。补齐后游标重新走到这一步，会从 1 重新数。 */
  attempt: number;
  /**
   * 这一步累计被执行过几次，跨补齐轮次不重置。没有它就无法从事件流里区分
   * "第一次执行"和"补齐完回来重试"——两者的 attempt 都是 1，等于漏报重试。
   */
  execution: number;
  errorCode?: string;
  category?: FailureCategory;
  action?: RecoveryAction;
  /** repair-planned 时：插入了多少步。 */
  insertedSteps?: number;
  /** repair-rejected 时：为什么不能补。 */
  reason?: string;
}>;

export type SupervisionResult = Readonly<{
  completed: boolean;
  /** 实际执行成功的步骤数（含补齐插入的步骤）。 */
  stepsCompleted: number;
  /** 补齐子计划插入的总步数。 */
  repairStepsInserted: number;
  /** 失败收尾时的错误码与分类；completed 为 true 时为 null。 */
  failure:
    | Readonly<{
        errorCode: string;
        category: FailureCategory;
        action: RecoveryAction;
        stepIndex: number;
        itemName: string;
      }>
    | null;
  events: readonly SupervisorEvent[];
}>;

/**
 * 每一级恢复动作对应的副作用钩子。全部可选，因为不同宿主能做的事不一样：
 * 没有移动能力的宿主就是不能 MOVE_CLOSER。
 *
 * **钩子缺失时不假装成功**——那等于把 Stub 当完成。缺失就记 repair-rejected
 * 并在阶梯上继续往下推，最终走到终止级如实上报。
 */
export type RecoveryEffects = Readonly<{
  reobserve?: (step: PlanStep) => void | Promise<void>;
  moveCloser?: (step: PlanStep) => void | Promise<void>;
  slowDown?: (step: PlanStep) => void | Promise<void>;
  waitForSafetyClear?: (step: PlanStep) => void | Promise<void>;
  /** 腾出背包空间（存箱子/丢垃圾）。没有这个能力的宿主不提供即可。 */
  freeInventory?: (step: PlanStep) => void | Promise<void>;
}>;

/** 恢复动作 → 对应钩子名。ACQUIRE 与终止级不走钩子，单独处理。 */
const EFFECT_FOR_ACTION: Readonly<
  Partial<Record<RecoveryAction, keyof RecoveryEffects>>
> = Object.freeze({
  REOBSERVE_THEN_RETRY: "reobserve",
  MOVE_CLOSER_THEN_RETRY: "moveCloser",
  FREE_INVENTORY_THEN_RETRY: "freeInventory",
  SLOW_DOWN_THEN_RETRY: "slowDown",
  WAIT_FOR_SAFETY_CLEAR: "waitForSafetyClear",
});

export class PlanSupervisor {
  constructor(private readonly planner: GoalPlanner = new GoalPlanner()) {}

  /**
   * 执行一份计划。`inventory` 是**开工时的真实库存快照**，用于补齐子计划的重新
   * 规划——补齐时必须知道手上已经有什么，否则会重复采集。
   */
  async run(
    steps: readonly PlanStep[],
    execute: StepExecutor,
    inventory: PlannerInventory = {},
    effects: RecoveryEffects = {},
  ): Promise<SupervisionResult> {
    const queue: PlanStep[] = [...steps];
    const events: SupervisorEvent[] = [];
    const ledger = new Map<string, number>(Object.entries(inventory));
    // 按**对象身份**计数，不按 stepIndex：子计划自己从 1 开始编号，会和原计划
    // 撞号，用编号做键会把两个不同步骤的补齐次数算到一起。
    const repairsByStep = new Map<PlanStep, number>();
    let cursor = 0;
    let stepsCompleted = 0;
    let repairStepsInserted = 0;
    let totalRepairs = 0;

    // 按对象身份累计每一步的真实执行次数。不能按 stepIndex——补齐子计划自己从 1
    // 开始编号，会和原计划撞号，那样统计出来的"执行次数"是两个不同步骤的和。
    const executions = new Map<PlanStep, number>();
    // record 自己补上 execution，避免十来个调用点各写一遍、漏一个就静默错报。
    let recording: PlanStep | null = null;
    const record = (event: Omit<SupervisorEvent, "execution">): void => {
      events.push(
        Object.freeze({
          ...event,
          execution: recording === null ? 0 : (executions.get(recording) ?? 0),
        }),
      );
    };
    const finish = (
      failure: SupervisionResult["failure"],
    ): SupervisionResult =>
      Object.freeze({
        completed: failure === null,
        stepsCompleted,
        repairStepsInserted,
        failure,
        events: Object.freeze([...events]),
      });

    while (cursor < queue.length) {
      const step = queue[cursor]!;
      let attempt = 0;
      let settled = false;

      recording = step;
      while (!settled) {
        attempt += 1;
        executions.set(step, (executions.get(step) ?? 0) + 1);
        record({
          kind: "step-started",
          stepIndex: step.stepIndex,
          itemName: step.itemName,
          attempt,
        });
        const outcome = await execute(step, attempt);
        if (outcome.ok) {
          this.applyToLedger(ledger, step);
          stepsCompleted += 1;
          record({
            kind: "step-completed",
            stepIndex: step.stepIndex,
            itemName: step.itemName,
            attempt,
          });
          settled = true;
          break;
        }

        const decision = planRecovery(outcome.errorCode, attempt);
        record({
          kind: "step-failed",
          stepIndex: step.stepIndex,
          itemName: step.itemName,
          attempt,
          errorCode: decision.errorCode,
          category: decision.category,
        });
        record({
          kind: "recovery-selected",
          stepIndex: step.stepIndex,
          itemName: step.itemName,
          attempt,
          errorCode: decision.errorCode,
          category: decision.category,
          action: decision.action,
        });

        if (decision.terminal || attempt >= MAX_ATTEMPTS_PER_STEP) {
          record({
            kind: "step-abandoned",
            stepIndex: step.stepIndex,
            itemName: step.itemName,
            attempt,
            errorCode: decision.errorCode,
            category: decision.category,
            action: decision.action,
          });
          return finish(
            Object.freeze({
              errorCode: decision.errorCode,
              category: decision.category,
              action: decision.action,
              stepIndex: step.stepIndex,
              itemName: step.itemName,
            }),
          );
        }
        // TRANSIENT 重试退避（闭环轮实测）：RETRY_SAME 此前在同一 tick 立即
        // 重发——上一个技能的移动租约还在 TTL 窗口内正常持有，重试必然再
        // BUSY，4 次用完直接放弃。bot 的移动操作通常 5-30 秒量级；指数退避
        // 500ms→1s→2s 给持有者一个真实的释放窗口（不改变恢复梯语义）。
        if (decision.action === "RETRY_SAME" && !settled) {
          const backoffMs = Math.min(2_000, 500 * 2 ** (attempt - 1));
          await new Promise<void>((resolve) => setTimeout(resolve, backoffMs));
        }
        if (decision.action === "ACQUIRE_RESOURCES_THEN_RETRY") {
          const reject = (reason: string): void => {
            record({
              kind: "repair-rejected",
              stepIndex: step.stepIndex,
              itemName: step.itemName,
              attempt,
              errorCode: decision.errorCode,
              reason,
            });
          };
          const shortfall = this.shortfallFor(step, outcome.missing);
          const usedForStep = repairsByStep.get(step) ?? 0;
          if (shortfall.length === 0) {
            // 缺什么都不知道就没有目标可补。退回重新观察，而不是猜。
            reject("NO_SHORTFALL_REPORTED");
          } else if (usedForStep >= MAX_REPAIRS_PER_STEP) {
            reject("STEP_REPAIR_LIMIT_REACHED");
          } else if (totalRepairs >= MAX_TOTAL_REPAIRS) {
            reject("TOTAL_REPAIR_LIMIT_REACHED");
          } else {
            // 补齐规划要**信执行方而不信账本**：账本按计划推演，认为这些东西还在，
            // 但执行方刚刚报了缺。拿原账本去规划会推出一份空计划——"你已经有了"——
            // 于是重试必然以同样的方式再失败。所以先把报缺的项从快照里清掉。
            const subplan = this.planner.plan(
              shortfall,
              this.snapshotWithout(ledger, shortfall),
            );
            if (!subplan.planned) {
              // 补不出来就如实上报，不再往下试——这正是 PLAN_ITEM_UNOBTAINABLE
              // 被归为 UNSUPPORTED 而非 CONTRACT_BUG 的用处。
              reject(subplan.errorCode);
              const classification = classifyFailure(subplan.errorCode);
              record({
                kind: "step-abandoned",
                stepIndex: step.stepIndex,
                itemName: step.itemName,
                attempt,
                errorCode: subplan.errorCode,
                category: classification.category,
              });
              return finish(
                Object.freeze({
                  errorCode: subplan.errorCode,
                  category: classification.category,
                  action: "ESCALATE_TO_OPERATOR" as const,
                  stepIndex: step.stepIndex,
                  itemName: subplan.blockedOn || step.itemName,
                }),
              );
            }
            if (subplan.steps.length === 0) {
              // 空子计划意味着"按知识你不缺"，但执行方说缺。插 0 步再重试只会
              // 原地打转，而且会把游标推过这一步——等于把失败的步骤悄悄跳过。
              reject("REPAIR_PLAN_EMPTY");
              if (effects.reobserve !== undefined) await effects.reobserve(step);
              continue;
            }
            repairsByStep.set(step, usedForStep + 1);
            totalRepairs += 1;
            repairStepsInserted += subplan.steps.length;
            // 插在游标处，游标**不动**：下一轮就从补齐段的第一步开始，
            // 跑完后游标自然落回原步骤重试。已完成的步骤都在游标之前，不会重跑。
            queue.splice(cursor, 0, ...subplan.steps);
            record({
              kind: "repair-planned",
              stepIndex: step.stepIndex,
              itemName: step.itemName,
              attempt,
              errorCode: decision.errorCode,
              insertedSteps: subplan.steps.length,
            });
            // 跳出内层循环去跑补齐步骤；外层 while 会先走到插入的那些步，
            // 跑完后游标自然回到原步骤上继续。
            settled = true;
            break;
          }
        }

        const effectName = EFFECT_FOR_ACTION[decision.action];
        if (effectName !== undefined) {
          const hook = effects[effectName];
          if (hook === undefined) {
            record({
              kind: "repair-rejected",
              stepIndex: step.stepIndex,
              itemName: step.itemName,
              attempt,
              errorCode: decision.errorCode,
              action: decision.action,
              reason: "EFFECT_UNAVAILABLE",
            });
          } else {
            await hook(step);
          }
        }
      }

      // 只有游标还指着刚做完的那一步才前进。补齐分支在游标处插了新步骤，
      // 此时游标指向补齐段的第一步，不能跳过它。按对象身份比较，避免撞号。
      if (queue[cursor] === step) cursor += 1;
    }

    return finish(null);
  }

  /**
   * 这一步到底缺什么。优先用执行方报的 `missing`——它看得见真实背包；
   * 报不出来时退回用计划里这一步声明的消耗，因为那是唯一可信的派生来源。
   * 两者都没有就返回空，调用方据此拒绝补齐（不猜）。
   */
  private shortfallFor(
    step: PlanStep,
    reported: readonly Readonly<{ itemName: string; count: number }>[] | undefined,
  ): readonly Readonly<{ itemName: string; count: number }>[] {
    const source = reported !== undefined && reported.length > 0 ? reported : step.consumes;
    const merged = new Map<string, number>();
    for (const entry of source) {
      if (!Number.isInteger(entry.count) || entry.count < 1) continue;
      merged.set(entry.itemName, Math.max(merged.get(entry.itemName) ?? 0, entry.count));
    }
    return Object.freeze(
      [...merged]
        .map(([itemName, count]) => Object.freeze({ itemName, count }))
        .sort((left, right) => left.itemName.localeCompare(right.itemName)),
    );
  }

  /** 步骤成功后更新账本，让后续补齐规划知道手上已经有什么。 */
  private applyToLedger(ledger: Map<string, number>, step: PlanStep): void {
    for (const consumed of step.consumes) {
      const held = ledger.get(consumed.itemName) ?? 0;
      ledger.set(consumed.itemName, Math.max(0, held - consumed.count));
    }
    if (step.kind !== "place-station") {
      ledger.set(step.itemName, (ledger.get(step.itemName) ?? 0) + step.producedCount);
    }
  }

  /**
   * 账本快照，但把报缺的物品清零。执行方对"手上有什么"的判断优先于账本推演——
   * 账本只是计划的影子，真实背包才是事实。
   */
  private snapshotWithout(
    ledger: Map<string, number>,
    missing: readonly Readonly<{ itemName: string; count: number }>[],
  ): PlannerInventory {
    const excluded = new Set(missing.map((entry) => entry.itemName));
    const out: Record<string, number> = {};
    for (const [itemName, count] of ledger) {
      if (count > 0 && !excluded.has(itemName)) out[itemName] = count;
    }
    return Object.freeze(out);
  }
}

/** 恢复动作是否需要宿主提供副作用钩子。用于宿主自检"我支持哪几级恢复"。 */
export function recoveryActionNeedsEffect(action: RecoveryAction): boolean {
  return EFFECT_FOR_ACTION[action] !== undefined;
}

/** 该动作是否会改写计划本身（而不只是重试）。 */
export function recoveryActionRewritesPlan(action: RecoveryAction): boolean {
  return action === "ACQUIRE_RESOURCES_THEN_RETRY" && !isTerminalRecoveryAction(action);
}


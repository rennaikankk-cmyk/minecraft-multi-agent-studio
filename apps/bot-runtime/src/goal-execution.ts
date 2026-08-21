import type { SkillExecutionResultV1 } from "@minecraft-studio/protocol";
import {
  classifyFailure,
  GoalPlanner,
  PlanSupervisor,
  type FailureCategory,
  type GoalRequest,
  type PlannerInventory,
  type PlanStep,
  type RecoveryAction,
  type RecoveryEffects,
  type StepOutcome,
  type SupervisionResult,
  type SupervisorEvent,
} from "@minecraft-studio/skills";
import type { SkillExecutionAuthorization } from "@minecraft-studio/skills";

// ---------------------------------------------------------------------------
// §4 的接线点：把 GoalPlanner / PlanSupervisor / classifyFailure 接到 bot-runtime
// 真实的技能派发路径上。在此之前这三者在 packages/skills 之外零引用——目标分解
// 和恢复阶梯是一座孤岛，真实 bot 跑任务时走不到。
//
// 这里**不自己造授权**。protocol 把 skill.invoke.v1 的 source.service 钉死为
// "coordinator"，且授权引用要与 skillId / skillVersion / invocationId 逐字段
// 对上（executor.validateAuthorization）。一个"合成铁镐"的目标会展开成十几步
// 不同技能，一张授权覆盖不了，bot-runtime 也无权自签。
//
// 同理这里**不编造坐标**。PlanStep 只说"挖 3 个 stone"，挖哪一格、用哪个工作台
// 是世界状态问题，规划器不知道。所以"PlanStep → 完整调用信封"由调用方注入：
// 运行时负责监督、分类、遥测，绑定世界坐标与授权是调用方的事。
//
// 拿不到 dispatcher 就 fail closed（PLAN_STEP_DISPATCH_UNAVAILABLE），
// 不假装成功、不静默跳过。
// ---------------------------------------------------------------------------

/** 一步计划绑定成真实调用所需的一切。由调用方（coordinator 侧）产出。 */
export type DispatchableStep = Readonly<{
  /** 完整的 skill.invoke.v1 信封，未经校验——executor 会做严格校验。 */
  invocation: unknown;
  authorization: SkillExecutionAuthorization;
}>;

/**
 * 把一步计划绑定到具体世界目标与授权。
 *
 * 返回 null 表示这一步现在绑不出来（没有已知的目标方块、拿不到授权）。
 * 那不是"成功"，会被当作一次失败并进入恢复阶梯。
 */
export type StepDispatcher = (
  step: PlanStep,
  attempt: number,
) => DispatchableStep | null | Promise<DispatchableStep | null>;

/** 执行一个已绑定的调用。实参就是 runtime.handleSkillInvocation。 */
export type StepInvoker = (
  invocation: unknown,
  authorization: SkillExecutionAuthorization,
  signal?: AbortSignal,
) => Promise<SkillExecutionResultV1>;

export type GoalExecutionLogger = Readonly<{
  info(event: string, fields: Readonly<Record<string, unknown>>): void;
  warn(event: string, fields: Readonly<Record<string, unknown>>): void;
}>;

export type GoalExecutionDependencies = Readonly<{
  invoke: StepInvoker;
  dispatch?: StepDispatcher;
  effects?: RecoveryEffects;
  logger?: GoalExecutionLogger;
  onEvent?: (event: SupervisorEvent) => void;
  planner?: GoalPlanner;
  supervisor?: PlanSupervisor;
}>;

export type GoalExecutionOutcome =
  | Readonly<{
      planned: true;
      supervision: SupervisionResult;
      /** 计划展开出的原始步数（不含补齐插入的）。 */
      plannedSteps: number;
    }>
  | Readonly<{
      planned: false;
      errorCode: string;
      blockedOn: string;
    }>;

// 下面三个错误码的**命名是刻意的**：classifyFailure 的形态规则只认结构，
// 所以名字直接决定走哪条恢复阶梯。选名时对着规则表验过，不是随手起的。
//
//   PLAN_ 前缀        → CONTRACT_BUG   → ESCALATE_TO_OPERATOR（终止级）
//   ..._NOT_FOUND     → STALE_WORLD    → REOBSERVE_THEN_RETRY
//   ..._INVALID       → CONTRACT_BUG   → ESCALATE_TO_OPERATOR（终止级）

/** 压根没注入 dispatcher：接线问题，重试多少次都一样，直接升级人工。 */
export const STEP_DISPATCH_UNAVAILABLE = "PLAN_STEP_DISPATCH_UNAVAILABLE";
/**
 * 这一步现在绑不出世界目标（没有已知的目标方块/工作台）。
 *
 * 走 STALE_WORLD 而不是 CONTRACT_BUG：世界模型还没看到合适的目标是"再看一眼"
 * 能解决的，不该叫人来修代码。所以名字用 _NOT_FOUND 而不是 PLAN_ 前缀——
 * 后者会被前缀规则判成 CONTRACT_BUG 并立刻终止。
 */
export const STEP_TARGET_NOT_FOUND = "STEP_TARGET_NOT_FOUND";
/**
 * 信封没过协议校验等派发期异常：构造调用的代码有问题。
 *
 * 用 _INVALID 而不是 _FAILED：后者会被形态规则判成 TRANSIENT，
 * 于是一个坏信封要白重试三次才放弃。
 */
export const STEP_INVOCATION_INVALID = "SKILL_INVOCATION_INVALID";

/**
 * 技能结果 → 监督器单步结果。
 *
 * `completed` 之外**一律算失败**，包括 rejected / cancelled / timed_out：
 * 前置条件被拒不是"做完了"，把它当成功会让计划带着未满足的前提往下走。
 */
export function stepOutcomeFromResult(
  result: SkillExecutionResultV1,
): StepOutcome {
  if (result.payload.outcome === "completed") return { ok: true };
  const errorCode =
    "errorCode" in result.payload && typeof result.payload.errorCode === "string"
      ? result.payload.errorCode
      : "SKILL_HANDLER_FAILED";
  return { ok: false, errorCode };
}

/**
 * 目标执行器：规划 → 监督执行 → 失败分类，一条链接到真实派发。
 *
 * 自己不持有 Mineflayer、不读时钟：可执行的东西全部注入，所以同一套逻辑在
 * 单测里能被完全确定地驱动。
 */
export class GoalExecutor {
  private readonly planner: GoalPlanner;
  private readonly supervisor: PlanSupervisor;

  constructor(private readonly dependencies: GoalExecutionDependencies) {
    this.planner = dependencies.planner ?? new GoalPlanner();
    this.supervisor =
      dependencies.supervisor ?? new PlanSupervisor(this.planner);
  }

  /**
   * 执行一个物品目标。`inventory` 是开工时的真实库存快照——补齐子计划要靠它
   * 才知道手上已经有什么，否则会重复采集。
   */
  async pursue(
    goals: readonly GoalRequest[],
    inventory: PlannerInventory = {},
    signal?: AbortSignal,
  ): Promise<GoalExecutionOutcome> {
    const plan = this.planner.plan(goals, inventory);
    if (!plan.planned) {
      this.dependencies.logger?.warn("bot_runtime_goal_plan_failed", {
        errorCode: plan.errorCode,
        blockedOn: plan.blockedOn,
        goals: goals.map((goal) => `${goal.itemName}x${goal.count}`),
      });
      return {
        planned: false,
        errorCode: plan.errorCode,
        blockedOn: plan.blockedOn,
      };
    }

    const supervision = await this.supervisor.run(
      plan.steps,
      (step, attempt) => this.runStep(step, attempt, signal),
      inventory,
      this.dependencies.effects ?? {},
    );

    for (const event of supervision.events) {
      this.dependencies.onEvent?.(event);
      this.logEvent(event);
    }

    if (supervision.failure) {
      this.dependencies.logger?.warn("bot_runtime_goal_failed", {
        errorCode: supervision.failure.errorCode,
        category: supervision.failure.category,
        action: supervision.failure.action,
        stepIndex: supervision.failure.stepIndex,
        itemName: supervision.failure.itemName,
        stepsCompleted: supervision.stepsCompleted,
        repairStepsInserted: supervision.repairStepsInserted,
      });
    } else {
      this.dependencies.logger?.info("bot_runtime_goal_completed", {
        stepsCompleted: supervision.stepsCompleted,
        repairStepsInserted: supervision.repairStepsInserted,
      });
    }

    return { planned: true, supervision, plannedSteps: plan.steps.length };
  }

  /**
   * 跑一步：绑定 → 派发 → 归一化为监督器认识的结果。
   *
   * 没有 dispatcher、或这一步绑不出来，都如实返回失败码交给恢复阶梯，
   * 不当成功。取消信号在这里也算一次失败（SKILL_CANCELLED 归 SAFETY_INTERRUPT，
   * 阶梯会等恢复而不是把它当技能故障刷重试）。
   */
  private async runStep(
    step: PlanStep,
    attempt: number,
    signal?: AbortSignal,
  ): Promise<StepOutcome> {
    if (signal?.aborted) return { ok: false, errorCode: "SKILL_CANCELLED" };
    const dispatch = this.dependencies.dispatch;
    if (!dispatch) {
      return { ok: false, errorCode: STEP_DISPATCH_UNAVAILABLE };
    }
    let bound: DispatchableStep | null;
    try {
      bound = await dispatch(step, attempt);
    } catch {
      return { ok: false, errorCode: STEP_TARGET_NOT_FOUND };
    }
    if (!bound) return { ok: false, errorCode: STEP_TARGET_NOT_FOUND };

    try {
      const result = await this.dependencies.invoke(
        bound.invocation,
        bound.authorization,
        signal,
      );
      return stepOutcomeFromResult(result);
    } catch {
      // 派发本身抛异常（信封没过协议校验等）是接线问题，不是世界状态问题。
      return { ok: false, errorCode: STEP_INVOCATION_INVALID };
    }
  }

  private logEvent(event: SupervisorEvent): void {
    const logger = this.dependencies.logger;
    if (!logger) return;
    const fields = {
      kind: event.kind,
      stepIndex: event.stepIndex,
      itemName: event.itemName,
      attempt: event.attempt,
      execution: event.execution,
      ...(event.errorCode !== undefined ? { errorCode: event.errorCode } : {}),
      ...(event.category !== undefined ? { category: event.category } : {}),
      ...(event.action !== undefined ? { action: event.action } : {}),
      ...(event.insertedSteps !== undefined
        ? { insertedSteps: event.insertedSteps }
        : {}),
      ...(event.reason !== undefined ? { reason: event.reason } : {}),
    };
    if (
      event.kind === "step-failed" ||
      event.kind === "repair-rejected" ||
      event.kind === "step-abandoned"
    ) {
      logger.warn("bot_runtime_goal_step", fields);
      return;
    }
    logger.info("bot_runtime_goal_step", fields);
  }
}

/**
 * 把一个错误码归类。导出是为了让调用方（以及 Dashboard 侧）能对同一个错误码
 * 得到与监督器完全一致的判断——分类只有一处实现，不许各写一份。
 */
export function categorizeStepFailure(errorCode: string): Readonly<{
  category: FailureCategory;
  firstAction: RecoveryAction;
}> {
  const classification = classifyFailure(errorCode);
  return Object.freeze({
    category: classification.category,
    firstAction: classification.ladder[0]!,
  });
}

import { randomUUID } from "node:crypto";

import type { ScheduledAIRouter } from "@minecraft-studio/ai-router";
import type { AppLogger } from "@minecraft-studio/observability";
import {
  identifierSchema,
  type PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import { scanBlocksOutputSchema, siteAssessOutputSchema, plannedBlueprintAnchor, farmMaintainInputSchema, farmSustainInputSchema, cropRules, readFarmProduction, registerCropProduction, registerFoodProduction, farmProductionReady,
  recordFarmProduction, type FacilityRegistry, type BaseRegistry } from "@minecraft-studio/skills";
import type { PlanJournalStore } from "./plan-journal.js";
import { ExplorationJournal } from "./exploration-journal.js";

import type {
  BotRegistry,
  BotRegistryRecord,
} from "./bot-registry.js";
import {
  CoordinatorLocalPlanner,
  LocalPlannerError,
} from "./local-planner.js";
import {
  askReplanOracle,
  buildReplanPrompt,
  sanitizeReplanDecision,
  substitutionAllowlist,
} from "./replan-oracle.js";
import {
  askStrategyReview,
  buildStrategyReviewPrompt,
  FOCUS_NEED_BOOSTS,
  sanitizeStrategyReviewDecision,
  STRATEGY_REVIEW_INTERVAL_MS,
  strategyReviewRequestId,
  type StrategyFocus,
} from "./strategy-review.js";
import {
  assessSurvivalNeeds,
  SurvivalRecoveryMemory,
  SAFE_FOOD_ITEM_NAMES,
  type SurvivalNeed,
  type SurvivalNeedKey,
} from "./survival-needs.js";
import { BasePhaseTracker, BASE_PHASE_KEYS, emptyBasePhaseSnapshot, type BasePhaseKey } from "./base-phase-state.js";
import {
  askSiteVerdict,
  buildSiteVerdictPrompt,
  SITE_VERDICT_REJECT_LIMIT,
  SITE_VERDICT_TIMEOUT_MS,
  type SiteFactDimension,
  type SiteFacts,
  type SiteVerdict,
} from "./site-verdict.js";

type PublicTask = NonNullable<PublicBotDetailV1["currentTask"]>;
type TaskStatus = PublicTask["status"];

const ACTIVE_TASK_STATUSES = new Set<TaskStatus>([
  "queued",
  "assigned",
  "running",
  "blocked",
  "waiting",
  "paused",
]);

export type AutonomousTaskView = PublicTask;

export type AutonomousTaskListener = (botId: string) => void;

export type AutonomousTaskSource = Readonly<{
  getCurrentTask: (botId: string, at?: Date) => AutonomousTaskView | null;
  subscribe: (listener: AutonomousTaskListener) => () => void;
  requestManualControl?: (botId: string) => Promise<boolean>;
}>;

export type AutonomousDirectorOptions = Readonly<{
  registry: Pick<BotRegistry, "list" | "get" | "subscribe">;
  planner: Pick<CoordinatorLocalPlanner, "planAndDispatch">;
  intervalMs: number;
  goalTimeoutMs: number;
  failureCooldownMs: number;
  terminalRetentionMs: number;
  logger?: AppLogger;
  now?: () => Date;
  randomId?: () => string;
  /**
   * 重规划神谕（可选）：需求连续失败被抑制时咨询一次。未注入时自主生存
   * 完全确定性运转。模型只能从白名单菜单选择，见 replan-oracle.ts。
   */
  replanAI?: { generate: ScheduledAIRouter["generate"] };
  /**
   * 基地选址评审（可选，Spark）：选址 goal 完成后采集候选点事实快照
   * （村庄标记/水/岩浆/木材的相对距离），模型做 accept/reject 裁决。
   * 确定性选址必须先通过；模型缺位或超时只能省略可选评审，不能
   * 补足缺失的世界证据。见 site-verdict.ts。
   */
  siteAI?: { generate: ScheduledAIRouter["generate"] };
  /**
   * 游戏内聊天指挥入口：白名单玩家的话由 runtime 上报、registry 分发到
   * 这里。返回 true 表示被接单。未注入时聊天指挥不可用（生存不受影响）。
   */
  onChatGoal?: (botId: string, speaker: string, message: string) => boolean;
  baseRegistry?: BaseRegistry;
  facilityRegistry?: FacilityRegistry;
  planJournalStore?: PlanJournalStore;
  persistBaseState?: () => void;
  explorationJournal?: ExplorationJournal;
}>;

type InternalTask = PublicTask & {
  needKey: SurvivalNeedKey;
  goal: string;
  reason: string;
  terminalExpiresAtMs: number | null;
};

/** 进行中的蓝图施工（批间链）：锚点+进度，从 skill 派发的可信载荷提取。 */
type BaseBuildProgress = Readonly<{
  blueprintName: string;
  anchor: Readonly<{ x: number; y: number; z: number }>;
  nextIndex: number;
  totalCells: number;
}>;

/** 多批蓝图施工型需求：完成语义=全部格放完（非单批 skill 成功）。 */
const BASE_BUILD_NEED_KEYS: ReadonlySet<SurvivalNeedKey> = new Set([
  "BASE_MAIN_CONSTRUCTION",
  "BASE_FACILITY_COBBLE",
  "BASE_FACILITY_FARM",
]);

/** goal 文本里的蓝图名提取（与 deterministic-goals 的解析器同格式）。 */
const BLUEPRINT_GOAL_NAME = /使用蓝图文件\s+([a-z0-9][a-z0-9-]{0,63})\s*施工/u;

type ActiveRun = Readonly<{
  taskId: string;
  controller: AbortController;
  promise: Promise<void>;
}>;

type AutonomousPlanResult = Awaited<
  ReturnType<CoordinatorLocalPlanner["planAndDispatch"]>
>;

/**
 * 沿矿脉继续开掘比换区更优的源方块（与 collect.block 的楼梯回退配合）：
 * 地下矿脉目标换一个水平探索点等于丢掉已有的开掘进度。
 */
const DIRECTIONAL_SOURCE_BLOCKS = new Set([
  "iron_ore",
  "coal_ore",
  "diamond_ore",
]);

/**
 * These are failures where the deterministic Runtime has searched the local
 * area but did not prove a usable target. Repeating the same plan without
 * changing the Bot's observation or position is guaranteed to be noisy, so
 * autonomy gets one bounded scan/explore pass before trying the goal again.
 */
const RESOURCE_RECOVERY_FAILURE_CODES = new Set([
  "COLLECT_PATH_SEARCH_EXHAUSTED",
  "COLLECT_TARGET_UNREACHABLE",
  "COLLECT_BLOCKS_FAILED",
  "COLLECT_PICKUP_NOT_SETTLED",
]);

const AUTONOMOUS_SCAN_MAX_DISTANCE = 64;
const AUTONOMOUS_MAX_RESOURCE_CANDIDATES = 4;
const AUTONOMOUS_RECOVERY_TIMEOUT_MS = 30_000;
const AUTONOMOUS_EXPLORATION_COOLDOWN_MS = 60_000;
/** 探索半径逐次放大；坐标永远来自 Bot 真实位置的确定性偏移。 */
const AUTONOMOUS_EXPLORATION_RADII = Object.freeze([32, 48, 56, 64]);
const AUTONOMOUS_SHELTER_DIRECTIONS = Object.freeze([
  "north",
  "east",
  "south",
  "west",
] as const);
const AUTONOMOUS_SHELTER_MATERIALS = Object.freeze([
  "cobblestone",
  "dirt",
] as const);
/** 同一需求连续失败这么多次后，冷却窗口内不再选中它（livelock 防护）。 */
const AUTONOMOUS_NEED_FAILURE_LIMIT = 3;
/**
 * 中断类失败码：更高优先级（战斗反应/L0 安全/逃逸租约）抢占了运动或动作
 * 资源——任务不是败了，是被打断了。恢复语义=零冷却立即重派（见 finishTask）。
 */
const INTERRUPT_FAILURE_CODES: ReadonlySet<string> = new Set([
  "SKILL_CANCELLED",
  // 移动抢占族（Phase 3 前置）：goal 被替换/我方主动停止=范围中断。
  "MOVEMENT_GOAL_REPLACED",
  "MOVEMENT_PATH_PREEMPTED",
  "NORMAL_ACTIONS_PAUSED",
  "SKILL_EXECUTION_INTERRUPTED",
  "ACTION_LOCK_BUSY",
  "BOT_MOVEMENT_BUSY",
]);
/** 神谕提示词里的镐档描述顺序（仅用于摘要，不参与决策）。 */
const PICKAXE_TIERS_FOR_PROMPT = [
  "wooden_pickaxe",
  "stone_pickaxe",
  "iron_pickaxe",
  "diamond_pickaxe",
] as const;
const AUTONOMOUS_NEED_SUPPRESSION_MS = 120_000;

type ScannedResourcePosition = Readonly<{
  x: number;
  y: number;
  z: number;
  distance: number;
}>;

/**
 * Keeps every idle, healthy Runtime working on its own survival. The director
 * owns no Minecraft primitive: survival-needs turns Bot state into the next
 * need deterministically, and every need is served through the same
 * Coordinator planner used by the Dashboard, so all Skill and L0 gates stay
 * in one execution path. Spark is never in this loop — the needs ladder and
 * its goal templates are fully deterministic.
 */
export class AutonomousDirector implements AutonomousTaskSource {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly listeners = new Set<AutonomousTaskListener>();
  private readonly tasks = new Map<string, InternalTask>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly nextGoalAt = new Map<string, number>();
  private readonly shelterBuilt = new Set<string>();
  /**
   * 基地阶段真值（Implementation Prompt V1 · Phase 1）：7 门快照驱动
   * BASE_* 需求的顺序放行；生产环境从共享注册表的当前证据推导。
   */
  private readonly basePhase: BasePhaseTracker;
  /**
   * 未注入 journal 的兼容调用方使用的进程内批间链：锚点钉死在首批解析结果上，
   * 续派 goal 显式携带锚点+startIndex，避免 auto-anchor 随 bot 移动漂移。
   * completed=true 时清除。
   */
  private readonly baseBuilds = new Map<string, BaseBuildProgress>();
  /**
   * 选址评审（Spark）：连续 reject 计数（达 SITE_VERDICT_REJECT_LIMIT 强制
   * accept）与在途评审（防同 bot 并发评审/需求在评审期间重触发）。
   */
  private readonly siteRejects = new Map<string, number>();
  private readonly siteVerdictInFlight = new Map<string, Promise<void>>();
  private readonly siteVerdictControllers = new Map<string, AbortController>();
  private readonly consecutiveNeedFailures = new Map<string, number>();
  private readonly needSuppressedUntil = new Map<string, number>();
  private readonly explorationCursor = new Map<string, number>();
  private readonly explorationRadiusStep = new Map<string, number>();
  private readonly nextExplorationAt = new Map<string, number>();
  private readonly shelterDirectionCursor = new Map<string, number>();
  /** 战略评审：每 bot 下轮评审时间 / 当前重心 / 近期需求与失败轨迹。 */
  private readonly nextStrategyReviewAt = new Map<string, number>();
  private readonly currentFocus = new Map<string, StrategyFocus>();
  private readonly focusBlocks = new Map<string, string>();
  private readonly recentNeedKeys = new Map<string, string[]>();
  private readonly recentFailureKeys = new Map<string, string[]>();
  /** 聊天指挥队列：一次一条，作为自由目标下发（走模型分支）。 */
  private readonly chatQueue = new Map<string, Readonly<{ speaker: string; message: string; receivedAtMs: number }>>();
  /** 已完成回收的死亡时间戳（diedAt），防止反复回同一个死点。 */
  private readonly recoveredDeaths = new Map<string, Set<string>>();
  private readonly recoveryMemory = new SurvivalRecoveryMemory();
  private readonly productionRuns = new Map<string, string>();
  /** 神谕给出的一次性立场切换，下一次调度前消费（优先于普通需求）。 */
  private readonly pendingStanceSwitches = new Map<string, "preserve-life" | "expendable" | "aggressive">();
  /** 神谕给出的一次性替代资源（needKey → item），用一次即消费。 */
  private readonly pendingSubstitutes = new Map<
    string,
    Readonly<{ needKey: SurvivalNeedKey; itemName: string }>
  >();
  private timer: ReturnType<typeof setInterval> | null = null;
  private strategyTimer: ReturnType<typeof setInterval> | null = null;
  private unsubscribeRegistry: (() => void) | null = null;
  private started = false;
  private readonly baseSessions = new Map<string, string>();
  private readonly explorationJournal: ExplorationJournal;

  constructor(private readonly options: AutonomousDirectorOptions) {
    this.explorationJournal = options.explorationJournal ?? new ExplorationJournal();
    this.basePhase = new BasePhaseTracker(options.baseRegistry ? (botId) => {
      const snapshot = emptyBasePhaseSnapshot();
      const record = options.registry.get(botId);
      const dimension = record?.currentStatus?.position.dimension;
      if (!record || !dimension || record.connectionState !== "online") return snapshot;
      const base = options.baseRegistry!.forMember(botId, record.serverProfileId, dimension);
      const session = `${record.serverProfileId}:${dimension}:${record.runtimeInstanceId}`;
      if (base && this.baseSessions.get(botId) !== session) options.baseRegistry!.markFactsUnverified(base.id);
      this.baseSessions.set(botId, session);
      for (const phase of BASE_PHASE_KEYS) snapshot[phase] = !!base && options.baseRegistry!.currentPhaseFact(base.id, phase)?.availability === "AVAILABLE";
      return snapshot;
    } : undefined);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    positiveInteger(options.intervalMs, "intervalMs");
    positiveInteger(options.goalTimeoutMs, "goalTimeoutMs");
    positiveInteger(options.failureCooldownMs, "failureCooldownMs");
    positiveInteger(options.terminalRetentionMs, "terminalRetentionMs");
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeRegistry = this.options.registry.subscribe((record) => {
      if (record.connectionState === "online") void this.kick(record.botId);
    });
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    this.timer.unref?.();
    // 战略评审节拍：每 bot 每 5 分钟一次；模型未配置时整条路径不激活。
    if (this.options.replanAI) {
      this.strategyTimer = setInterval(
        () => void this.runStrategyReviews(),
        STRATEGY_REVIEW_INTERVAL_MS,
      );
      this.strategyTimer.unref?.();
    }
    void this.tick();
    this.log("info", "coordinator_autonomous_director_started", {
      intervalMs: this.options.intervalMs,
      goalTimeoutMs: this.options.goalTimeoutMs,
    });
  }

  async stop(): Promise<void> {
    if (!this.started && this.active.size === 0 && this.siteVerdictInFlight.size === 0) return;
    this.started = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.strategyTimer) clearInterval(this.strategyTimer);
    this.strategyTimer = null;
    this.unsubscribeRegistry?.();
    this.unsubscribeRegistry = null;
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort(new Error("director_shutdown"));
    for (const controller of this.siteVerdictControllers.values()) controller.abort(new Error("director_shutdown"));
    await Promise.allSettled([...active.map(({ promise }) => promise), ...this.siteVerdictInFlight.values()]);
    this.log("info", "coordinator_autonomous_director_stopped", {});
  }

  subscribe(listener: AutonomousTaskListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Give a Dashboard goal priority over this Bot's internal work. The caller
   * waits for the planner to observe the abort and release its assignment
   * before acquiring the manual goal's lease.
   */
  async requestManualControl(botId: string): Promise<boolean> {
    const run = this.active.get(botId);
    const review = this.siteVerdictInFlight.get(botId);
    if (!run && !review) return false;
    run?.controller.abort(new Error("manual_control_requested"));
    this.siteVerdictControllers.get(botId)?.abort(new Error("manual_control_requested"));
    await Promise.allSettled([...(run ? [run.promise] : []), ...(review ? [review] : [])]);
    return true;
  }

  getCurrentTask(botId: string, at = this.now()): AutonomousTaskView | null {
    const now = validDate(at);
    const task = this.tasks.get(botId);
    if (!task) return null;
    if (
      task.terminalExpiresAtMs !== null &&
      task.terminalExpiresAtMs <= now.getTime()
    ) {
      this.tasks.delete(botId);
      return null;
    }
    return {
      taskId: task.taskId,
      title: task.title,
      status: task.status,
      startedAt: task.startedAt,
    };
  }

  private async tick(): Promise<void> {
    if (!this.started) return;
    let records: readonly BotRegistryRecord[];
    try {
      records = this.options.registry.list(validDate(this.now()));
    } catch (cause) {
      this.log("warn", "coordinator_autonomous_registry_read_failed", {
        error: boundedError(cause),
      });
      return;
    }
    for (const record of records) this.maybeStart(record);
    this.drainChatQueue(records);
  }

  /** 白名单聊天 → 自由目标（模型分支解析意图，确定性层执行）。 */
  handleChatMessage(botId: string, speaker: string, message: string): boolean {
    if (!this.started) return false;
    const clean = message.trim().slice(0, 512);
    if (!clean) return true;
    // 同一 bot 的旧指令被新指令顶替：指挥天然只关心最新意图。
    this.chatQueue.set(botId, {
      speaker: speaker.slice(0, 32),
      message: clean,
      receivedAtMs: validDate(this.now()).getTime(),
    });
    this.log("info", "coordinator_autonomous_chat_command", {
      botId,
      speaker,
      length: clean.length,
    });
    return true;
  }

  private drainChatQueue(records: readonly BotRegistryRecord[]): void {
    if (this.chatQueue.size === 0) return;
    for (const record of records) {
      const chat = this.chatQueue.get(record.botId);
      if (!chat) continue;
      if (this.active.has(record.botId)) continue; // 等当前目标让位
      if (!eligibleForAutonomy(record)) continue;
      this.chatQueue.delete(record.botId);
      this.dispatchSingleGoal(record, {
        needKey: "EQUIP_ARMOR",
        key: "chat-command",
        title: "执行聊天指令",
        operatorGoal: chat.message,
        reason: "chat command from whitelisted operator",
        blockName: null,
        directionalMining: false,
      });
    }
  }

  private async kick(botId: string): Promise<void> {
    if (!this.started) return;
    try {
      const record = this.options.registry.get(botId, validDate(this.now()));
      if (record) this.maybeStart(record);
    } catch (cause) {
      this.log("warn", "coordinator_autonomous_registry_read_failed", {
        botId,
        error: boundedError(cause),
      });
    }
  }

  private maybeStart(record: BotRegistryRecord): void {
    if (!this.started || !eligibleForAutonomy(record)) return;
    if (this.active.has(record.botId)) return;
    // 神谕的立场切换是单目标指令：优先于任何需求评估立即下发。
    const pendingStance = this.pendingStanceSwitches.get(record.botId);
    if (pendingStance !== undefined && !this.tasks.get(record.botId)) {
      this.pendingStanceSwitches.delete(record.botId);
      this.dispatchSingleGoal(record, {
        needKey: "EQUIP_ARMOR",
        key: "stance-switch",
        title: "切换战斗立场",
        operatorGoal: `切换战斗立场为 ${pendingStance}`,
        reason: `replan combat-stance -> ${pendingStance}`,
        blockName: null,
        directionalMining: false,
      });
      return;
    }
    const existing = this.tasks.get(record.botId);
    const nowMs = validDate(this.now()).getTime();
    if (existing && isActiveTask(existing.status)) return;
    if (existing?.terminalExpiresAtMs !== null && existing) {
      if (existing.terminalExpiresAtMs > nowMs) return;
      this.tasks.delete(record.botId);
    }
    if ((this.nextGoalAt.get(record.botId) ?? 0) > nowMs) return;

    const goal = this.selectGoal(record, nowMs);
    if (goal === null) return;
    const taskId = identifierSchema.parse(this.randomId());
    const controller = new AbortController();
    const placeholder: ActiveRun = {
      taskId,
      controller,
      promise: Promise.resolve(),
    };
    this.active.set(record.botId, placeholder);
    const promise = this.runTask(record, taskId, goal, controller);
    this.active.set(record.botId, { taskId, controller, promise });
    void promise
      .finally(() => {
        const current = this.active.get(record.botId);
        if (current?.taskId === taskId) this.active.delete(record.botId);
      })
      .catch(() => undefined);
  }

  /**
   * Pure selection over the needs ladder: score-ordered needs from
   * survival-needs, minus suppressed ones, with exploration coordinates and
   * shelter direction bound from per-Bot cursors. The same Bot state always
   * selects the same need; state changes (task success, inventory delta,
   * respawn) re-assess on the next tick.
   */
  /**
   * 战略评审主循环（战略层=分钟级、大模型）：对每个空闲在线 bot 周期性
   * 咨询一次重心，结果写入 currentFocus（需求加权）与可选立场/探索焦点。
   * 全部 best-effort，任何失败保持既有重心。
   */
  private async runStrategyReviews(): Promise<void> {
    if (!this.started) return;
    const ai = this.options.replanAI;
    if (!ai) return;
    const nowMs = validDate(this.now()).getTime();
    let records: readonly BotRegistryRecord[];
    try {
      records = this.options.registry.list(validDate(this.now()));
    } catch {
      return;
    }
    for (const record of records) {
      if (!eligibleForAutonomy(record)) continue;
      if ((this.nextStrategyReviewAt.get(record.botId) ?? 0) > nowMs) continue;
      if (this.active.has(record.botId)) continue;
      this.nextStrategyReviewAt.set(
        record.botId,
        nowMs + STRATEGY_REVIEW_INTERVAL_MS,
      );
      void this.reviewStrategyFor(record, ai);
    }
  }

  private async reviewStrategyFor(
    record: BotRegistryRecord,
    ai: NonNullable<AutonomousDirectorOptions["replanAI"]>,
  ): Promise<void> {
    if (!this.started) return;
    const inventory = new Map(
      (record.currentStatus?.inventory ?? []).map((item) => [
        item.itemName,
        item.count,
      ] as const),
    );
    let safeFoodCount = 0;
    for (const [name, count] of inventory) {
      if (SAFE_FOOD_ITEM_NAMES.has(name)) safeFoodCount += count;
    }
    const pickaxeTier =
      ["diamond_pickaxe", "iron_pickaxe", "stone_pickaxe", "wooden_pickaxe"].find(
        (name) => (inventory.get(name) ?? 0) > 0,
      ) ?? "none";
    const hasSword = ["diamond_sword", "iron_sword", "stone_sword", "wooden_sword"].some(
      (name) => (inventory.get(name) ?? 0) > 0,
    );
    const decision = await askStrategyReview({
      ai,
      requestId: strategyReviewRequestId(record.botId),
      botId: record.botId,
      traceId: `strategy-${record.botId}`,
      prompt: buildStrategyReviewPrompt({
        botId: record.botId,
        focusWindowMinutes: Math.round(STRATEGY_REVIEW_INTERVAL_MS / 60_000),
        safeFoodCount,
        pickaxeTier,
        hasSword,
        armorPoints: record.currentStatus?.armorPoints ?? 0,
        woodUnits:
          (inventory.get("oak_log") ?? 0) +
          Math.floor((inventory.get("oak_planks") ?? 0) / 4),
        coalUnits:
          (inventory.get("coal") ?? 0) + (inventory.get("charcoal") ?? 0),
        ironUnits:
          (inventory.get("raw_iron") ?? 0) +
          (inventory.get("iron_ingot") ?? 0),
        recentNeeds: this.recentNeedKeys.get(record.botId) ?? [],
        recentFailures: this.recentFailureKeys.get(record.botId) ?? [],
        deaths: 0,
      }),
    });
    if (!this.started || decision === null) return;
    const sanitized = sanitizeStrategyReviewDecision(decision);
    this.currentFocus.set(record.botId, sanitized.focus);
    if (sanitized.explorationBlock) {
      this.focusBlocks.set(record.botId, sanitized.explorationBlock);
    }
    if (sanitized.stance) {
      this.pendingStanceSwitches.set(record.botId, sanitized.stance);
    }
    this.log("info", "coordinator_autonomous_strategy_review", {
      botId: record.botId,
      focus: sanitized.focus,
      explorationBlock: sanitized.explorationBlock,
      stance: sanitized.stance,
      rationale: sanitized.rationale,
    });
  }

  /** 需求/失败轨迹（战略评审提示词的"最近发生了什么"输入）。 */
  private recordNeedTrail(botId: string, needKey: SurvivalNeedKey): void {
    const trail = this.recentNeedKeys.get(botId) ?? [];
    trail.push(needKey);
    if (trail.length > 24) trail.shift();
    this.recentNeedKeys.set(botId, trail);
  }

  private recordFailureTrail(botId: string, needKey: SurvivalNeedKey): void {
    const trail = this.recentFailureKeys.get(botId) ?? [];
    trail.push(needKey);
    if (trail.length > 16) trail.shift();
    this.recentFailureKeys.set(botId, trail);
  }

  private dispatchSingleGoal(
    record: BotRegistryRecord,
    goal: AutonomousGoal,
  ): void {
    const taskId = identifierSchema.parse(this.randomId());
    const controller = new AbortController();
    this.active.set(record.botId, {
      taskId,
      controller,
      promise: Promise.resolve(),
    });
    const promise = this.runTask(record, taskId, goal, controller);
    this.active.set(record.botId, { taskId, controller, promise });
    void promise
      .finally(() => {
        const current = this.active.get(record.botId);
        if (current?.taskId === taskId) this.active.delete(record.botId);
      })
      .catch(() => undefined);
  }

  private selectGoal(
    record: BotRegistryRecord,
    nowMs: number,
  ): AutonomousGoal | null {
    const focus = this.currentFocus.get(record.botId);
    const needs = [...assessSurvivalNeeds({
      record,
      now: new Date(nowMs),
      recoveryMemory: this.recoveryMemory,
      shelterBuilt: this.options.baseRegistry ? this.basePhase.snapshotFor(record.botId).SHELTER_MINIMAL_READY : this.shelterBuilt.has(record.botId),
      // 基地阶段真值（Phase 1）：BASE_* 需求的顺序门。快照恒供给——
      // 门全 false 时 survival-needs 整段静默（语义同未传入）。
      basePhase: this.basePhase.snapshotFor(record.botId),
      recoveredDeaths: [
        ...(this.recoveredDeaths.get(record.botId) ?? []),
      ],
      // 战略评审给出的重心只做加权（score 上限钳到 95，不越过饿肚子级的
      // 硬需求），确保模型最多改变"先做什么"，永远改不掉"必须活着"。
      focusBoosts: focus ? FOCUS_NEED_BOOSTS[focus] : undefined,
    })];
    const build = this.persistedBuild(record.botId, "BASE_MAIN_CONSTRUCTION");
    const base = this.options.baseRegistry?.forMember(record.botId, record.serverProfileId, record.currentStatus!.position.dimension);
    const adopted = base?.source === "operator_adopted";
    if (adopted && base.protectedBounds) {
      const p = record.currentStatus!.position;
      const { min, max } = base.protectedBounds;
      if (p.x < min.x || p.x > max.x || p.y < min.y || p.y > max.y || p.z < min.z || p.z > max.z) {
        needs.push({ key: "BASE_RETURN", score: 56, title: "返回已加入的基地", reason: "operator-assigned base is outside current position",
          operatorGoal: `移动到坐标 x=${base.anchor.x} y=${base.anchor.y} z=${base.anchor.z} 附近，返回基地`, sourceBlock: null });
        needs.sort((a, b) => b.score - a.score);
      }
    }
    const farmBuild = this.persistedBuild(record.botId, "BASE_FACILITY_FARM");
    if (base && !adopted && this.options.baseRegistry && this.options.facilityRegistry && !farmBuild &&
        this.basePhase.snapshotFor(record.botId).STARTER_BASE_ACTIVE) {
      const center = plannedBlueprintAnchor(this.options.baseRegistry.ensureLayout(base.id), "carrot-farm-9x9")!;
      registerFoodProduction(this.options.facilityRegistry, base.id, farmSustainInputSchema.parse({
        serverProfileId: record.serverProfileId, dimension: base.dimension, center,
      }));
      this.options.persistBaseState?.();
    }
    const farm = base ? this.options.facilityRegistry?.findByBase(base.id).filter((facility) => {
      const production = readFarmProduction(facility);
      return production?.enabled && !this.productionRuns.has(facility.id) && production.nextRunAtMs <= nowMs &&
        facility.serverProfileId === record.serverProfileId && facility.dimension === base.dimension;
    }).sort((a, b) => readFarmProduction(a)!.nextRunAtMs - readFarmProduction(b)!.nextRunAtMs || a.id.localeCompare(b.id))[0] : null;
    if (farm && readFarmProduction(farm)?.sustain) {
      const production = readFarmProduction(farm)!;
      const inventory = record.currentStatus?.inventory ?? [];
      const missing = /^FARM_MATERIAL_REQUIRED:(oak_fence|oak_fence_gate|torch|barrel|bucket)$/u.exec(production.reason ?? "")?.[1];
      const materialCount: Record<string, number> = { oak_fence: 24, oak_fence_gate: 1, torch: 4, barrel: 1, bucket: 1 };
      const hasHoe = inventory.some((item) => item.itemName.endsWith("_hoe") && item.count > 0);
      const seedsMissing = production.status === "WAITING_SEEDS" && inventory.filter((i) => i.itemName === "carrot").reduce((n, i) => n + i.count, 0) <= production.sustain!.seedReserve + production.sustain!.foodReserve;
      const materialMissing = missing && inventory.filter((i) => i.itemName === missing).reduce((n, i) => n + i.count, 0) === 0;
      const goal = !hasHoe ? "获取 stone_hoe" : materialMissing ? `获取 ${materialCount[missing!]} 个 ${missing}`
        : seedsMissing ? `获取 ${production.sustain!.seedReserve + production.sustain!.foodReserve + 24} 个 carrot` : `维护食物设施 ${farm.id}`;
      needs.push({ key: "BASE_FARM_MAINTENANCE", score: 75, title: "维持食物设施", reason: production.reason ?? "food production inspection due", operatorGoal: goal, sourceBlock: null });
      needs.sort((a, b) => b.score - a.score);
    } else if (farm) {
      const production = readFarmProduction(farm)!;
      const inventory = record.currentStatus?.inventory ?? [];
      const crop = production.input.plantEmpty;
      if (crop && ["carrots", "potatoes", "wheat", "beetroots"].includes(crop)) {
        const seed = cropRules[crop].seedItem!;
        const hasHoe = inventory.some((item) => item.itemName.endsWith("_hoe") && item.count > 0);
        const hasSeeds = inventory.reduce((sum, item) => sum + (item.itemName === seed ? item.count : 0), 0) > production.input.seedReserve;
        const { min, max } = production.input.area;
        const goal = !hasHoe ? "获取 stone_hoe" : !hasSeeds ? `获取 8 个 ${seed}`
          : `维护农场 ${crop} min x=${min.x} y=${min.y} z=${min.z} max x=${max.x} y=${max.y} z=${max.z}`;
        needs.push({ key: "BASE_FARM_MAINTENANCE", score: 43, title: !hasHoe ? "准备农具" : !hasSeeds ? "补充种子" : "农场收获与补种",
          reason: "registered crop production is due", operatorGoal: goal, sourceBlock: null });
        needs.sort((a, b) => b.score - a.score);
      }
    }
    if (build && base && !this.basePhase.snapshotFor(record.botId).STARTER_BASE_ACTIVE &&
      !needs.some((n) => n.key === "BASE_MAIN_CONSTRUCTION")) {
      needs.push({ key: "BASE_MAIN_CONSTRUCTION", title: "核对并恢复基地", score: 46,
        reason: "base-world-evidence-required", operatorGoal: "使用蓝图文件 starter-base-v1 施工", sourceBlock: null });
      needs.sort((a, b) => b.score - a.score);
    }
    const eligible = needs.filter(
      (need) =>
        !(adopted && (BASE_BUILD_NEED_KEYS.has(need.key) || need.key === "BASE_SITE_SELECTION" || need.key === "SHELTER")) &&
        !(need.key === "BASE_FACILITY_FARM" && base && this.options.facilityRegistry?.findByBase(base.id).some((f) => readFarmProduction(f)?.sustain)) &&
        !(need.key === "SHELTER" && build) &&
        !((need.key === "BASE_FACILITY_COBBLE" || need.key === "BASE_FACILITY_FARM") &&
          this.persistedBuild(record.botId, need.key)?.verification === "VERIFIED") &&
        (this.needSuppressedUntil.get(`${record.botId}:${need.key}`) ?? 0) <=
        nowMs,
    );
    const chosen = eligible[0];
    if (chosen === undefined) return null;
    this.recordNeedTrail(record.botId, chosen.key);
    const bound = this.bindGoal(record, chosen, nowMs);
    if (bound === null) return null;
    if (chosen.key === "BASE_FARM_MAINTENANCE" && farm) return { ...bound, productionFacilityId: farm.id };
    const substitute = this.pendingSubstitutes.get(record.botId);
    if (substitute && substitute.needKey === chosen.key) {
      this.pendingSubstitutes.delete(record.botId);
      return {
        ...bound,
        title: `获取 ${substitute.itemName}`,
        operatorGoal: `获取 ${substitute.itemName}`,
        reason: `replan substitute for ${chosen.key}`,
      };
    }
    return bound;
  }

  /** 把需求意图绑定成可下发的具体目标（方向/封口料/探索坐标）。 */
  private bindGoal(
    record: BotRegistryRecord,
    need: SurvivalNeed,
    nowMs: number,
  ): AutonomousGoal | null {
    if (need.key === "EXPLORATION") {
      if ((this.nextExplorationAt.get(record.botId) ?? 0) > nowMs) return null;
      const target = this.explorationTarget(record);
      if (target === null) return null;
      return {
        needKey: need.key,
        key: "exploration",
        title: `${need.title} (${target.blockName})`,
        operatorGoal: `探索区块 x=${Math.floor(target.x / 16)} z=${Math.floor(target.z / 16)} radius=1`,
        reason: need.reason,
        blockName: target.blockName,
        directionalMining: false,
      };
    }
    if (need.key === "BASE_SITE_SELECTION") {
      // 选址 = 确定性扇区游走的移动目标（修复：原"向外探索新区域"自由
      // 文本不匹配任何模板，确定性-only 部署会落模型分支 AI_UNAVAILABLE
      // 无限失败循环）。走到候选点后由 site-verdict 评审（接线时）。
      const target = this.explorationTarget(record);
      if (target === null) return null;
      return {
        needKey: need.key,
        key: "base-site-selection",
        title: `${need.title} (扇区 x=${target.x} z=${target.z})`,
        operatorGoal: `移动到坐标 x=${target.x} y=${target.y} z=${target.z} 附近，继续观察 ${target.blockName} 方块`,
        reason: need.reason,
        blockName: target.blockName,
        directionalMining: false,
      };
    }
    if (need.key === "SHELTER") {
      const direction = this.nextShelterDirection(record.botId);
      const seal = shelterMaterial(record) ?? "dirt";
      return {
        needKey: need.key,
        key: "shelter",
        title: need.title,
        operatorGoal: `在当前维度向 ${direction} 挖一个 2 格深的安全避难所，并用 ${seal} 封口`,
        reason: need.reason,
        blockName: null,
        directionalMining: false,
      };
    }
    if (need.key === "FOOD_SECURITY") {
      return {
        needKey: need.key,
        key: "food",
        title: need.title,
        operatorGoal: need.operatorGoal,
        reason: need.reason,
        blockName: null,
        directionalMining: false,
      };
    }
    return {
      needKey: need.key,
      key: need.key,
      title: need.title,
      operatorGoal: need.operatorGoal,
      reason: need.reason,
      blockName: need.sourceBlock,
      directionalMining: need.sourceBlock !== null &&
        DIRECTIONAL_SOURCE_BLOCKS.has(need.sourceBlock),
    };
  }

  /** 扇区轮转 + 半径递增的确定性探索；多 Bot 天然错开起始扇区。 */
  private explorationTarget(
    record: BotRegistryRecord,
  ): { x: number; y: number; z: number; blockName: string } | null {
    const position = record.currentStatus?.position;
    if (!position) return null;
    const cursor = this.explorationCursor.get(record.botId) ?? 0;
    const step = this.explorationRadiusStep.get(record.botId) ?? 0;
    const radius = AUTONOMOUS_EXPLORATION_RADII[
      Math.min(step, AUTONOMOUS_EXPLORATION_RADII.length - 1)
    ]!;
    // 基于稳定 botId 哈希的扇区偏移：同批 Bot 各自从不同扇区开始扫。
    const sectorBase = stableSector(record.botId);
    let x = 0, z = 0, offset = 0;
    for (; offset < 8; offset++) {
      const sector = (sectorBase + cursor + offset) % 8;
      const angle = (sector / 8) * Math.PI * 2;
      x = Math.floor(position.x + Math.cos(angle) * radius);
      z = Math.floor(position.z + Math.sin(angle) * radius);
      if (!this.explorationJournal.has(record.serverProfileId, position.dimension, Math.floor(x / 16), Math.floor(z / 16))) break;
    }
    // All local sectors covered: still permit a live revisit to advance the frontier.
    this.explorationCursor.set(record.botId, cursor + Math.min(offset + 1, 8));
    this.explorationRadiusStep.set(
      record.botId,
      Math.min(step + 1, AUTONOMOUS_EXPLORATION_RADII.length - 1),
    );
    return {
      x,
      y: Math.floor(position.y),
      z,
      blockName: explorationFocusBlock(record),
    };
  }

  private nextShelterDirection(botId: string): string {
    const index = this.shelterDirectionCursor.get(botId) ?? 0;
    this.shelterDirectionCursor.set(
      botId,
      (index + 1) % AUTONOMOUS_SHELTER_DIRECTIONS.length,
    );
    return AUTONOMOUS_SHELTER_DIRECTIONS[
      index % AUTONOMOUS_SHELTER_DIRECTIONS.length
    ]!;
  }

  /**
   * 批间链 goal 重写（Phase 1）：BASE_* 施工需求存在进行中进度时，goal
   * 改为显式锚点+startIndex 续派文本（与 deterministic-goals 模板逐字
   * 对齐）。无进度/非蓝图 goal → 原文返回。锚点钉死是正确性前提：
   * auto-anchor=bot 当前位置+2，第二批起 bot 已在工地附近移动，不钉死
   * 就会在漂移位置重建一份残缺结构。
   */
  private blueprintContinuationGoal(
    botId: string,
    needKey: SurvivalNeedKey,
    operatorGoal: string,
  ): string {
    if (!BASE_BUILD_NEED_KEYS.has(needKey)) return operatorGoal;
    const recovered = this.persistedBuild(botId, needKey);
    if (recovered) {
      const startIndex = recovered.nextIndex >= recovered.blueprint.cells.length ? 0 : recovered.nextIndex;
      return `使用蓝图文件 ${recovered.blueprintId} 施工：锚点 x=${recovered.anchor.x} y=${recovered.anchor.y} z=${recovered.anchor.z}，从第 ${startIndex} 格开始`;
    }
    const nameMatch = BLUEPRINT_GOAL_NAME.exec(operatorGoal);
    if (nameMatch === null) return operatorGoal;
    const progress = this.baseBuilds.get(botId);
    if (progress === undefined || progress.blueprintName !== nameMatch[1]) {
      const record = this.options.registry.get(botId);
      const dimension = record?.currentStatus?.position.dimension;
      const base = record && dimension && this.options.baseRegistry?.forMember(botId, record.serverProfileId, dimension);
      if (base && base.source !== "operator_adopted" && this.options.baseRegistry) {
        const anchor = plannedBlueprintAnchor(this.options.baseRegistry.ensureLayout(base.id), nameMatch[1]!);
        if (anchor) {
          this.options.persistBaseState?.();
          return `使用蓝图文件 ${nameMatch[1]} 施工：锚点 x=${anchor.x} y=${anchor.y} z=${anchor.z}，从第 0 格开始`;
        }
      }
      return operatorGoal;
    }
    if (progress.nextIndex <= 0 || progress.nextIndex >= progress.totalCells) {
      return operatorGoal;
    }
    return `使用蓝图文件 ${progress.blueprintName} 施工：锚点 x=${progress.anchor.x} y=${progress.anchor.y} z=${progress.anchor.z}，从第 ${progress.nextIndex} 格开始`;
  }

  /**
   * 从 skill 派发结果提取蓝图施工进度。可信来源：invocation.input 是
   * 协调器自己构造的派发输入（含解析后的锚点），output 是 runtime 逐格
   * 回执的汇总（nextIndex/totalCells/completed）。仅成功批提取（失败批
   * 的部分完成格数不可知，续派从上次已知进度重走——place-safe 对已就位
   * 格幂等）。completed=true 清除进度。
   */
  private updateBaseBuildProgress(
    botId: string,
    needKey: SurvivalNeedKey,
    operatorGoal: string,
    result: AutonomousPlanResult,
  ): void {
    if (this.options.planJournalStore) return;
    if (!BASE_BUILD_NEED_KEYS.has(needKey)) return;
    if (result.action !== "skill_result") return;
    if (result.invocation.payload.skillId !== "build.blueprint") return;
    const payload = (result.result as { payload?: unknown }).payload as
      | {
          outcome?: unknown;
          output?: {
            completed?: unknown;
            nextIndex?: unknown;
            totalCells?: unknown;
          } | null;
        }
      | null
      | undefined;
    if (!payload || payload.outcome !== "completed") return;
    const output = payload.output;
    if (
      output === null ||
      typeof output !== "object" ||
      typeof output.nextIndex !== "number" ||
      typeof output.totalCells !== "number" ||
      !Number.isFinite(output.nextIndex) ||
      !Number.isFinite(output.totalCells)
    ) {
      return;
    }
    const input = result.invocation.payload.input as {
      blueprint?: { anchor?: { x?: unknown; y?: unknown; z?: unknown } };
    } | null;
    const anchor = input?.blueprint?.anchor;
    if (
      !anchor ||
      typeof anchor.x !== "number" ||
      typeof anchor.y !== "number" ||
      typeof anchor.z !== "number"
    ) {
      return;
    }
    const nameMatch = BLUEPRINT_GOAL_NAME.exec(operatorGoal);
    if (nameMatch === null) return;
    if (output.completed === true || output.nextIndex >= output.totalCells) {
      this.baseBuilds.delete(botId);
      this.log("info", "coordinator_autonomous_build_complete", {
        botId,
        needKey,
        blueprint: nameMatch[1],
        totalCells: output.totalCells,
      });
      return;
    }
    const existing = this.baseBuilds.get(botId);
    this.baseBuilds.set(botId, {
      blueprintName: nameMatch[1]!,
      anchor: { x: anchor.x, y: anchor.y, z: anchor.z },
      nextIndex: Math.max(existing?.nextIndex ?? 0, output.nextIndex),
      totalCells: output.totalCells,
    });
    this.log("info", "coordinator_autonomous_build_progress", {
      botId,
      needKey,
      blueprint: nameMatch[1],
      nextIndex: output.nextIndex,
      totalCells: output.totalCells,
    });
  }

  /** 多批蓝图需求是否仍有进行中施工（完成语义门控）。 */
  private hasOngoingBaseBuild(botId: string, needKey: SurvivalNeedKey): boolean {
    if (!BASE_BUILD_NEED_KEYS.has(needKey)) return false;
    if (this.options.planJournalStore) {
      const build = this.persistedBuild(botId, needKey);
      return !build || build.verification !== "VERIFIED";
    }
    return this.baseBuilds.has(botId);
  }

  private persistedBuild(botId: string, needKey: SurvivalNeedKey) {
    const names: Partial<Record<SurvivalNeedKey, string>> = {
      BASE_MAIN_CONSTRUCTION: "starter-base-v1", BASE_FACILITY_COBBLE: "cobble-generator", BASE_FACILITY_FARM: "carrot-farm-9x9",
    };
    const record = this.options.registry.get(botId);
    const dimension = record?.currentStatus?.position.dimension;
    if (!record || !dimension || !names[needKey]) return null;
    const base = this.options.baseRegistry?.forMember(botId, record.serverProfileId, dimension);
    if (!base) return null;
    return this.options.planJournalStore?.load().find((j) => j.serverProfileId === record.serverProfileId &&
      j.build?.dimension === dimension && j.build.baseId === base.id && j.build.blueprintId === names[needKey])?.build ?? null;
  }

  private recordProductionResult(record: BotRegistryRecord, goal: AutonomousGoal, taskId: string, result: AutonomousPlanResult): void {
    if (!goal.productionFacilityId) return;
    const facility = this.options.facilityRegistry?.get(goal.productionFacilityId);
    const latest = this.options.registry.get(record.botId);
    if (!facility || latest?.serverProfileId !== record.serverProfileId || latest.runtimeInstanceId !== record.runtimeInstanceId ||
      latest.currentStatus?.position.dimension !== facility.dimension) return;
    const production = readFarmProduction(facility);
    if (!production) return;
    const nowMs = validDate(this.now()).getTime();
    if (result.action === "skill_result" && ["farm.maintain", "farm.sustain"].includes(result.invocation.payload.skillId)) {
      const invoked = result.invocation, returned = result.result;
      const schema = production.sustain ? farmSustainInputSchema : farmMaintainInputSchema;
      const actual = schema.safeParse(invoked.payload.input);
      const expectedSkill = production.sustain ? "farm.sustain" : "farm.maintain";
      const matches = actual.success && JSON.stringify(actual.data) === JSON.stringify(production.sustain ?? production.input) &&
        invoked.payload.skillId === expectedSkill && returned.payload.skillId === expectedSkill &&
        invoked.botId === record.botId && returned.botId === record.botId && invoked.taskId === taskId && returned.taskId === taskId &&
        returned.source.instanceId === record.runtimeInstanceId && invoked.payload.invocationId === returned.payload.invocationId &&
        invoked.payload.skillVersion === returned.payload.skillVersion;
      recordFarmProduction(facility, taskId, matches && returned.payload.outcome === "completed" ? returned.payload.output : null, nowMs,
        !matches ? "FARM_RECEIPT_SCOPE_MISMATCH" : returned.payload.outcome === "completed" ? undefined : autonomousFailureCode(result) ?? "FARM_MAINTENANCE_FAILED");
      const observed = readFarmProduction(facility)!;
      const producing = farmProductionReady(observed, nowMs);
      if (facility.baseId) this.options.baseRegistry?.recordPhaseEvidence(facility.baseId, "FOOD_FACILITY_ACTIVE",
        producing ? "AVAILABLE" : "UNVERIFIED", producing ? "three positive production cycles across five minutes" : observed.reason ?? observed.status, "farm-production-receipts");
    } else {
      const failure = autonomousFailureCode(result);
      if (failure) recordFarmProduction(facility, taskId, null, nowMs, failure);
      else facility.metadata.production = { ...production, nextRunAtMs: nowMs + 1_000 };
    }
    this.options.persistBaseState?.();
  }

  private recordBaseFact(botId: string, phase: BasePhaseKey): void {
    const record = this.options.registry.get(botId);
    const position = record?.currentStatus?.position;
    if (!record || !position || !this.options.baseRegistry) return;
    const base = this.options.baseRegistry.forMember(botId, record.serverProfileId, position.dimension) ?? this.options.baseRegistry.create({
      name: "autonomous-base", serverProfileId: record.serverProfileId, dimension: position.dimension,
      anchor: { x: Math.floor(position.x) + 2, y: Math.floor(position.y), z: Math.floor(position.z) },
      blueprintId: "starter-base-v1", createdByBotId: botId,
    });
    // Structure completion cannot establish food production or trade replenishment.
    if (phase === "SHELTER_MINIMAL_READY") {
      this.options.baseRegistry.recordPhaseEvidence(base.id, phase, "AVAILABLE", "verified deterministic goal result", "director-goal-result");
      this.options.persistBaseState?.();
    }
  }

  /**
   * 选址评审是否应启动：siteAI 已接线 + 门未翻 + 无在途评审 + 未达
   * reject 上限（达上限后仍需确定性证据，但省略模型调用）。
   */
  private shouldConsultSiteVerdict(botId: string): boolean {
    if (!this.options.siteAI) return false;
    if (this.basePhase.snapshotFor(botId).BASE_SITE_RESERVED) return false;
    if ((this.siteRejects.get(botId) ?? 0) >= SITE_VERDICT_REJECT_LIMIT) {
      return false;
    }
    return true;
  }

  /** 启动一次选址评审：抑制选址+探索需求（扫描期间别把 bot 派走），
   *  预算超时自动解抑（防挂起吞掉需求节拍）。恢复时只回收自己设的闸。 */
  private beginSiteVerdict(botId: string, goal: AutonomousGoal): void {
    if (this.siteVerdictInFlight.has(botId)) return;
    const controller = new AbortController();
    this.siteVerdictControllers.set(botId, controller);
    const timeout = setTimeout(() => controller.abort(new Error("site_review_timeout")), SITE_VERDICT_TIMEOUT_MS * 2);
    const nowMs = validDate(this.now()).getTime();
    const hold = nowMs + SITE_VERDICT_TIMEOUT_MS * 2;
    const prior: Array<[string, number]> = [];
    for (const key of [`${botId}:BASE_SITE_SELECTION`, `${botId}:EXPLORATION`]) {
      prior.push([key, this.needSuppressedUntil.get(key) ?? 0]);
      this.needSuppressedUntil.set(key, hold);
    }
    const promise = this.consultSiteVerdict(botId, goal, controller)
      .catch(() => undefined)
      .finally(() => {
        this.siteVerdictInFlight.delete(botId);
        this.siteVerdictControllers.delete(botId);
        clearTimeout(timeout);
        for (const [key, was] of prior) {
          if ((this.needSuppressedUntil.get(key) ?? 0) !== hold) continue;
          if (was > 0) this.needSuppressedUntil.set(key, was);
          else this.needSuppressedUntil.delete(key);
        }
      });
    this.siteVerdictInFlight.set(botId, promise);
  }

  /**
   * A fresh deterministic assessment is required before optional model review.
   * Model availability cannot override missing world evidence.
   */
  private async consultSiteVerdict(
    botId: string,
    goal: AutonomousGoal,
    controller: AbortController,
  ): Promise<void> {
    const record = this.options.registry.get(botId, validDate(this.now()));
    const position = record?.currentStatus?.position;
    if (!record || record.connectionState !== "online" || !position) return;
    const candidate = { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) };
    const unchanged = () => {
      const latest = this.options.registry.get(botId);
      const p = latest?.currentStatus?.position;
      return !controller.signal.aborted && this.started && latest?.connectionState === "online" && latest.runtimeInstanceId === record.runtimeInstanceId && latest.serverProfileId === record.serverProfileId &&
        p?.dimension === position.dimension && Math.hypot(p.x - candidate.x, p.y - candidate.y, p.z - candidate.z) <= 3;
    };
    const checked = await this.dispatchInternal(botId, `评估基地选址 x=${candidate.x} y=${candidate.y} z=${candidate.z}`, controller);
    const hard = checked.action === "skill_result" && checked.invocation.payload.skillId === "site.assess" && checked.result.payload.outcome === "completed"
      ? siteAssessOutputSchema.safeParse(checked.result.payload.output) : null;
    const evidence = hard?.success ? hard.data.memoryRecord : null;
    const ageMs = evidence ? validDate(this.now()).getTime() - Date.parse(evidence.observedAt) : Infinity;
    if (!hard?.success || hard.data.assessment.verdict !== "ACCEPT" || hard.data.assessment.hardRuleFailures.length ||
        !evidence || evidence.serverProfileId !== record.serverProfileId || evidence.dimension !== position.dimension ||
        evidence.position.x !== candidate.x || evidence.position.y !== candidate.y || evidence.position.z !== candidate.z ||
        ageMs < 0 || ageMs > 60_000 || !unchanged()) {
      this.log("warn", "coordinator_autonomous_site_unverified", { botId, goal: goal.key, reason: "DETERMINISTIC_SITE_EVIDENCE_REQUIRED" });
      return;
    }
    const ai = this.shouldConsultSiteVerdict(botId) ? this.options.siteAI : undefined;
    let verdict: SiteVerdict | null = null;
    if (ai) try {
      const facts = await this.gatherSiteFacts(record, controller);
      if (!unchanged()) return;
      const requestId = identifierSchema.parse(this.randomId());
      verdict = await askSiteVerdict({
        ai,
        requestId,
        botId,
        traceId: requestId,
        prompt: buildSiteVerdictPrompt(facts),
        signal: controller.signal,
      });
    } catch {
      verdict = null;
    }
    if (!unchanged()) return;
    const rejects = this.siteRejects.get(botId) ?? 0;
    if (verdict !== null && verdict.verdict === "reject" && rejects < SITE_VERDICT_REJECT_LIMIT) {
      this.siteRejects.set(botId, rejects + 1);
      this.log("info", "coordinator_autonomous_site_rejected", {
        botId,
        goal: goal.key,
        rejects: rejects + 1,
        limit: SITE_VERDICT_REJECT_LIMIT,
        reasons: verdict.reasons.join(" | "),
      });
      return;
    }
    const fallback = verdict === null;
    const forcedByLimit = verdict !== null && verdict.verdict === "reject";
    if (this.options.baseRegistry) {
      const base = this.options.baseRegistry.create({ name: "autonomous-base", serverProfileId: record.serverProfileId,
        dimension: position.dimension, anchor: candidate, blueprintId: "starter-base-v1" });
      this.options.baseRegistry.assignMember(base.id, record.serverProfileId, position.dimension, botId);
      this.options.baseRegistry.ensureLayout(base.id);
      this.options.baseRegistry.recordPhaseEvidence(base.id, "BASE_SITE_RESERVED", "AVAILABLE", "site.assess accepted current scoped candidate", "site.assess");
      this.options.persistBaseState?.();
    }
    this.siteRejects.set(botId, 0);
    this.basePhase.forcePhase(botId, "BASE_SITE_RESERVED");
    this.log("info", "coordinator_autonomous_site_accepted", {
      botId,
      goal: goal.key,
      fallback,
      forcedByLimit,
      ...(verdict !== null ? { reasons: verdict.reasons.join(" | ") } : {}),
    });
  }

  /**
   * 选址事实快照：4 项只读扫描（村庄干草捆/水/岩浆/橡木），全部转成
   * 相对距离与数量——绝对坐标不出协调器（prompt 保密纪律）。
   */
  private async gatherSiteFacts(
    record: BotRegistryRecord,
    controller: AbortController,
  ): Promise<SiteFacts> {
    const scans: ReadonlyArray<[keyof SiteFacts, string]> = [
      ["village", "hay_block"],
      ["water", "water"],
      ["lava", "lava"],
      ["wood", "oak_log"],
    ];
    const facts: Record<keyof SiteFacts, SiteFactDimension | null> = {
      village: null,
      water: null,
      lava: null,
      wood: null,
    };
    for (const [key, blockName] of scans) {
      if (controller.signal.aborted) break;
      try {
        const result = await this.dispatchInternal(
          record.botId,
          `读取当前区域的 ${blockName} 方块分布并给出扫描结果，只读`,
          controller,
        );
        const positions = scannedResourcePositions(result, blockName);
        if (positions.length > 0) {
          facts[key] = {
            nearestDistance: Math.max(0, Math.round(positions[0]!.distance)),
            count: positions.length,
          };
        }
      } catch {
        // 单项扫描失败 = 该事实缺失（null），评审继续。
      }
    }
    return facts;
  }

  /** 等待所有在途选址评审结束（测试与停机观测用）。 */
  async waitForSiteVerdicts(): Promise<void> {
    while (this.siteVerdictInFlight.size > 0) {
      await Promise.all([...this.siteVerdictInFlight.values()]);
    }
  }

  private async runTask(
    record: BotRegistryRecord,
    taskId: string,
    goal: AutonomousGoal,
    controller: AbortController,
  ): Promise<void> {
    const startedAt = validDate(this.now()).toISOString();
    // 标题带"为什么"：Dashboard 里直接能看到 WOOD_RESERVE 3/16 这种依据，
    // 而不是一行 walking。
    const taskTitle = `自主任务: ${goal.title}（${goal.reason}）`;
    this.setTask(record.botId, {
      taskId,
      title: taskTitle,
      status: "running",
      startedAt,
      needKey: goal.needKey,
      goal: goal.operatorGoal,
      reason: goal.reason,
      terminalExpiresAtMs: null,
    });
    this.log("info", "coordinator_autonomous_need_selected", {
      botId: record.botId,
      taskId,
      needKey: goal.needKey,
      goal: goal.key,
      reason: goal.reason,
    });
    try {
      // 多批蓝图批间链：有进行中的施工时，goal 显式携带钉死锚点+startIndex
      // （auto-anchor 会随 bot 移动漂移，第二批起必须钉住首批锚点）。
      const dispatchGoal = this.blueprintContinuationGoal(
        record.botId,
        goal.needKey,
        goal.operatorGoal,
      );
      if (goal.productionFacilityId) {
        this.productionRuns.set(goal.productionFacilityId, taskId);
        const facility = this.options.facilityRegistry?.get(goal.productionFacilityId);
        const production = facility && readFarmProduction(facility);
        if (facility && production) {
          // A restarted coordinator waits past the previous task's bounded lifetime.
          facility.metadata.production = { ...production, nextRunAtMs: validDate(this.now()).getTime() + this.options.goalTimeoutMs + 60_000 };
          this.options.persistBaseState?.();
        }
      }
      let result = await this.options.planner.planAndDispatch({
        requestId: taskId,
        traceId: taskId,
        taskId,
        botId: record.botId,
        operatorGoal: dispatchGoal,
        timeoutMs: this.options.goalTimeoutMs,
        signal: controller.signal,
      });
      let status = taskStatusFromPlanResult(result, controller.signal);
      if (goal.needKey === "BASE_FARM_MAINTENANCE") this.recordProductionResult(record, goal, taskId, result);
      let keepGoal = false;
      const failureCode = autonomousFailureCode(result);
      if (status === "failed" && failureCode !== null && !controller.signal.aborted) {
        const recovery = await this.recoverResourceGoal(
          record,
          taskId,
          goal,
          taskTitle,
          failureCode,
          controller,
        );
        keepGoal = recovery.keepGoal;
        if (recovery.retry !== null) {
          result = recovery.retry;
          status = taskStatusFromPlanResult(result, controller.signal);
        }
      }
      // 施工进度提取（失败批也提取：失败前已完成的格也是真进度）。
      this.updateBaseBuildProgress(record.botId, goal.needKey, goal.operatorGoal, result);
      this.finishTask(record.botId, taskId, goal, status, keepGoal, failureCode);
      this.log("info", "coordinator_autonomous_goal_finished", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        goal: goal.key,
        outcome: status,
        ...(keepGoal ? { recovery: "retry_same_goal" } : {}),
        ...(result.action === "noop" ? { reasonCode: result.reasonCode } : {}),
      });
    } catch (cause) {
      const status: TaskStatus = controller.signal.aborted ? "cancelled" : "failed";
      const failureCode = autonomousFailureCode(cause);
      if (goal.productionFacilityId) {
        const facility = this.options.facilityRegistry?.get(goal.productionFacilityId);
        if (facility) {
          recordFarmProduction(facility, taskId, null, validDate(this.now()).getTime(), failureCode ?? "FARM_TASK_INTERRUPTED");
          if (facility.baseId) this.options.baseRegistry?.recordPhaseEvidence(facility.baseId, "FOOD_FACILITY_ACTIVE", "UNVERIFIED", "production task interrupted", "farm-production-receipts");
          this.options.persistBaseState?.();
        }
      }
      let keepGoal = false;
      if (failureCode !== null && !controller.signal.aborted) {
        const recovery = await this.recoverResourceGoal(
          record,
          taskId,
          goal,
          taskTitle,
          failureCode,
          controller,
        );
        keepGoal = recovery.keepGoal;
      }
      this.finishTask(record.botId, taskId, goal, status, keepGoal, failureCode);
      this.log("warn", "coordinator_autonomous_goal_failed", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        goal: goal.key,
        code: cause instanceof LocalPlannerError ? cause.code : "DIRECTOR_FAILED",
        error: boundedError(cause),
        // 抢占证据链：planner 包装会吞掉原始 abort 消息，这里直接暴露
        // AbortController 的 reason（manual_control_requested / director_shutdown）。
        ...(controller.signal.aborted
          ? {
              abortReason:
                controller.signal.reason instanceof Error
                  ? controller.signal.reason.message
                  : String(controller.signal.reason ?? "abort"),
            }
          : {}),
        ...(keepGoal ? { recovery: "retry_same_goal" } : {}),
      });
    } finally {
      if (goal.productionFacilityId && this.productionRuns.get(goal.productionFacilityId) === taskId) {
        this.productionRuns.delete(goal.productionFacilityId);
      }
    }
  }

  /**
   * Move a resource goal forward after a local target-search failure. The
   * scan result is a Runtime observation; coordinates are never guessed from
   * the Bot's position. When no target is visible, a sector-rotating move
   * gives the next round a new loaded area while retaining the same need.
   */
  private async recoverResourceGoal(
    record: BotRegistryRecord,
    taskId: string,
    goal: AutonomousGoal,
    taskTitle: string,
    failureCode: string,
    controller: AbortController,
  ): Promise<ResourceRecoveryResult> {
    if (!RESOURCE_RECOVERY_FAILURE_CODES.has(failureCode)) {
      return { retry: null, keepGoal: false };
    }
    // This code means the block may already have been broken while the plugin
    // failed to close its dropped-entity wait. Moving to a new area would add
    // noise and can duplicate collection, so retain the need and let the
    // next inventory-aware plan re-observe it.
    if (failureCode === "COLLECT_PICKUP_NOT_SETTLED") {
      this.setRecoveryTask(record.botId, taskId, "自主恢复: 核对采集结果");
      return { retry: null, keepGoal: true };
    }
    const blockName = goal.blockName;
    if (!blockName || controller.signal.aborted) {
      return { retry: null, keepGoal: true };
    }

    // collect.block opens one bounded staircase toward the observed ore on
    // every attempt. A generic horizontal exploration move abandons that
    // progress and can strand the Bot underground, so keep mining from the
    // current endpoint on the next autonomous round.
    if (
      failureCode === "COLLECT_TARGET_UNREACHABLE" &&
      goal.directionalMining
    ) {
      this.setRecoveryTask(
        record.botId,
        taskId,
        `自主恢复: 继续定向开掘 ${blockName}`,
      );
      this.log("info", "coordinator_autonomous_recovery_mining_continues", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        blockName,
        failureCode,
      });
      return { retry: null, keepGoal: true };
    }

    this.setRecoveryTask(record.botId, taskId, `自主恢复: 搜索 ${blockName}`);
    this.log("info", "coordinator_autonomous_recovery_started", {
      botId: record.botId,
      taskId,
      needKey: goal.needKey,
      blockName,
      failureCode,
    });

    let scan: AutonomousPlanResult;
    try {
      scan = await this.dispatchInternal(
        record.botId,
        `读取当前区域的 ${blockName} 方块分布并给出扫描结果，只读`,
        controller,
      );
    } catch (cause) {
      this.logRecoveryFailure(record.botId, taskId, "scan", cause);
      return { retry: null, keepGoal: true };
    }

    const matches = scannedResourcePositions(scan, blockName);
    for (const match of matches.slice(0, AUTONOMOUS_MAX_RESOURCE_CANDIDATES)) {
      if (controller.signal.aborted) return { retry: null, keepGoal: true };
      const current = this.options.registry.get(
        record.botId,
        validDate(this.now()),
      );
      if (!current?.currentStatus?.position) continue;
      if (distanceTo(current.currentStatus.position, match) > AUTONOMOUS_SCAN_MAX_DISTANCE) {
        continue;
      }
      const moved = await this.dispatchInternal(
        record.botId,
        `移动到坐标 x=${match.x} y=${match.y} z=${match.z} 附近，继续观察 ${blockName} 方块`,
        controller,
      ).catch((cause) => {
        this.logRecoveryFailure(record.botId, taskId, "move-to-resource", cause);
        return null;
      });
      if (!planCompleted(moved)) continue;

      this.setRecoveryTask(record.botId, taskId, taskTitle);
      const retry = await this.dispatchInternal(
        record.botId,
        goal.operatorGoal,
        controller,
      ).catch((cause) => {
        this.logRecoveryFailure(record.botId, taskId, "goal-retry", cause);
        return null;
      });
      if (retry !== null && taskStatusFromPlanResult(retry, controller.signal) === "completed") {
        this.log("info", "coordinator_autonomous_recovery_succeeded", {
          botId: record.botId,
          taskId,
          needKey: goal.needKey,
          blockName,
        });
        return { retry, keepGoal: false };
      }
    }

    const nowMs = validDate(this.now()).getTime();
    const nextExplorationAt = this.nextExplorationAt.get(record.botId) ?? 0;
    if (nextExplorationAt > nowMs) {
      this.setRecoveryTask(record.botId, taskId, "自主恢复: 等待下一次资源扫描");
      this.log("info", "coordinator_autonomous_recovery_exploration_cooldown", {
        botId: record.botId,
        taskId,
        needKey: goal.needKey,
        blockName,
        retryAtMs: nextExplorationAt,
      });
      return { retry: null, keepGoal: true };
    }

    this.nextExplorationAt.set(
      record.botId,
      nowMs + AUTONOMOUS_EXPLORATION_COOLDOWN_MS,
    );
    const target = this.explorationTarget(record);
    const explorationGoal = target === null
      ? `继续观察 ${blockName} 方块所在区域`
      : `移动到坐标 x=${target.x} y=${target.y} z=${target.z} 附近，继续观察 ${blockName} 方块`;
    const moved = await this.dispatchInternal(
      record.botId,
      explorationGoal,
      controller,
    ).catch((cause) => {
      this.logRecoveryFailure(record.botId, taskId, "explore", cause);
      return null;
    });
    this.setRecoveryTask(record.botId, taskId, taskTitle);
    this.log("info", "coordinator_autonomous_recovery_explored", {
      botId: record.botId,
      taskId,
      needKey: goal.needKey,
      blockName,
      moved: planCompleted(moved),
    });
    return { retry: null, keepGoal: true };
  }

  /**
   * 恢复子派发（scan/move/retry）永远用**独立的 taskId**：持久化执行按
   * taskId+goal 做身份匹配，主目标一旦 ABORT，同一个 taskId 就再也带不
   * 上新的 goal 文本（实测在真实服上，恢复 scan 立即被
   * "Goal task identity does not match the persisted execution" 拒绝）。
   * 视图层仍由 setRecoveryTask 显示父任务标题，这里的新 id 只属于执行账本。
   */
  private async dispatchInternal(
    botId: string,
    operatorGoal: string,
    controller: AbortController,
  ): Promise<AutonomousPlanResult> {
    const requestId = identifierSchema.parse(this.randomId());
    return this.options.planner.planAndDispatch({
      requestId,
      traceId: requestId,
      taskId: requestId,
      botId,
      operatorGoal,
      timeoutMs: Math.min(
        this.options.goalTimeoutMs,
        AUTONOMOUS_RECOVERY_TIMEOUT_MS,
      ),
      signal: controller.signal,
    });
  }

  /**
   * 抑制触发时咨询重规划神谕并应用其决策。全部 best-effort：任何失败都
   * 保持既定的确定性策略。应用面收窄到三件事——探索半径档位、抑制窗口
   * 延长、一次性替代资源覆盖。
   */
  private async consultReplanOracle(
    botId: string,
    goal: AutonomousGoal,
    failures: number,
  ): Promise<void> {
    if (!this.started) return;
    const ai = this.options.replanAI;
    if (!ai) return;
    const record = this.options.registry.get(botId, validDate(this.now()));
    const inventory = new Map(
      (record?.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
        itemName,
        count,
      ] as const),
    );
    let safeFoodCount = 0;
    for (const [name, count] of inventory) {
      if (SAFE_FOOD_ITEM_NAMES.has(name)) safeFoodCount += count;
    }
    const pickaxeTier =
      PICKAXE_TIERS_FOR_PROMPT.find((name) => (inventory.get(name) ?? 0) > 0) ??
      "none";
    const substitutes = substitutionAllowlist(goal.needKey);
    const requestId = identifierSchema.parse(this.randomId());
    const decision = await askReplanOracle({
      ai,
      requestId,
      botId,
      traceId: requestId,
      prompt: buildReplanPrompt({
        needKey: goal.needKey,
        reason: goal.reason,
        failures,
        safeFoodCount,
        pickaxeTier,
        substitutes,
      }),
    });
    if (!this.started || decision === null) return;
    const sanitized = sanitizeReplanDecision(decision, goal.needKey);
    const nowMs = validDate(this.now()).getTime();
    const failureKey = `${botId}:${goal.needKey}`;
    switch (sanitized.strategy) {
      case "widen-exploration": {
        const bump = sanitized.magnitude === "large" ? 2 : sanitized.magnitude === "medium" ? 1 : 0;
        const step = Math.min(
          (this.explorationRadiusStep.get(botId) ?? 0) + bump,
          AUTONOMOUS_EXPLORATION_RADII.length - 1,
        );
        this.explorationRadiusStep.set(botId, step);
        break;
      }
      case "defer-longer": {
        const factor = sanitized.magnitude === "large" ? 8 : sanitized.magnitude === "medium" ? 4 : 2;
        this.needSuppressedUntil.set(
          failureKey,
          nowMs + AUTONOMOUS_NEED_SUPPRESSION_MS * factor,
        );
        break;
      }
      case "substitute-resource": {
        if (sanitized.substituteItem) {
          this.pendingSubstitutes.set(botId, {
            needKey: goal.needKey,
            itemName: sanitized.substituteItem,
          });
        }
        break;
      }
      case "combat-stance": {
        if (sanitized.stance) {
          this.pendingStanceSwitches.set(botId, sanitized.stance);
        }
        break;
      }
      case "rotate-sector":
      default:
        break;
    }
    this.log("info", "coordinator_autonomous_replan_applied", {
      botId,
      needKey: goal.needKey,
      strategy: sanitized.strategy,
      substituteItem: sanitized.substituteItem,
      magnitude: sanitized.magnitude,
      stance: sanitized.stance,
    });
  }

  private setRecoveryTask(botId: string, taskId: string, title: string): void {
    const current = this.tasks.get(botId);
    if (!current || current.taskId !== taskId || current.status !== "running") return;
    this.setTask(botId, { ...current, title });
  }

  private logRecoveryFailure(
    botId: string,
    taskId: string,
    phase: string,
    cause: unknown,
  ): void {
    this.log("warn", "coordinator_autonomous_recovery_failed", {
      botId,
      taskId,
      phase,
      error: boundedError(cause),
    });
  }

  private finishTask(
    botId: string,
    taskId: string,
    goal: AutonomousGoal,
    status: TaskStatus,
    keepGoal: boolean,
    failureCode: string | null = null,
  ): void {
    const nowMs = validDate(this.now()).getTime();
    const failureKey = `${botId}:${goal.needKey}`;
    // 中断-恢复语义（用户实测定性 2026-09-04：战斗/L0 抢占把任务打成终态
    // →冷却→重选→重规划，表现为"卡来卡去"）。中断类失败码 = 有更高优先级
    // 抢占了运动/动作（战斗反应、L0 暂停、逃逸租约），不是需求本身失败：
    // 不计数、零冷却、立即重派同一需求——目标从当前位置重规划=恢复。
    if (
      status === "failed" &&
      failureCode !== null &&
      INTERRUPT_FAILURE_CODES.has(failureCode) &&
      !keepGoal
    ) {
      this.nextGoalAt.set(botId, nowMs);
      this.log("info", "coordinator_autonomous_interrupt_resume", {
        botId,
        taskId,
        needKey: goal.needKey,
        failureCode,
      });
      const current0 = this.tasks.get(botId);
      if (current0 && current0.taskId === taskId) {
        // 终态保留期也清零：中断的"failed"只是占位，下一个 tick 立即可派。
        this.setTask(botId, {
          ...current0,
          status,
          terminalExpiresAtMs: nowMs,
        });
      }
      return;
    }
    if (status === "completed") {
      this.consecutiveNeedFailures.set(failureKey, 0);
      if (goal.needKey === "SHELTER") this.shelterBuilt.add(botId);
      // 阶段门置位（Phase 1）：多批蓝图需求只在整图放完（无进行中施工）
      // 时置门——单批 skill 成功 ≠ 建成。批间链由 runTask 的续派 goal 承接。
      // 选址例外（Spark 评审）：siteAI 接线时门不即时翻——评审异步裁决，
      // accept 才 forcePhase；评审期间需求被抑制（防重触发竞态）。
      if (!this.hasOngoingBaseBuild(botId, goal.needKey)) {
        if (
          goal.needKey === "BASE_SITE_SELECTION"
        ) {
          this.beginSiteVerdict(botId, goal);
        } else {
          const gated = this.basePhase.recordNeedCompletion(botId, goal.needKey);
          if (gated !== null) {
            this.recordBaseFact(botId, gated);
            this.log("info", "coordinator_autonomous_base_phase_gate", {
              botId,
              needKey: goal.needKey,
              phase: gated,
            });
          }
        }
      }
      if (goal.needKey === "DEATH_RECOVERY") {
        const record = this.options.registry.get(botId, validDate(this.now()));
        const diedAt = record?.currentStatus?.lastDeath?.diedAt;
        if (diedAt) {
          const set = this.recoveredDeaths.get(botId) ?? new Set<string>();
          set.add(diedAt);
          this.recoveredDeaths.set(botId, set);
        }
      }
    } else if (status === "failed") {
      const failures = (this.consecutiveNeedFailures.get(failureKey) ?? 0) + 1;
      this.consecutiveNeedFailures.set(failureKey, failures);
      this.recordFailureTrail(botId, goal.needKey);
      if (failures >= AUTONOMOUS_NEED_FAILURE_LIMIT) {
        this.needSuppressedUntil.set(
          failureKey,
          nowMs + AUTONOMOUS_NEED_SUPPRESSION_MS,
        );
        this.consecutiveNeedFailures.set(failureKey, 0);
        this.log("warn", "coordinator_autonomous_need_suppressed", {
          botId,
          needKey: goal.needKey,
          failures,
          suppressedUntilMs: nowMs + AUTONOMOUS_NEED_SUPPRESSION_MS,
        });
        // 确定性恢复梯已走完：这是模型（若配置）唯一介入自主生存的时机，
        // 且只能从 replan-oracle 的白名单菜单里挑一个替代策略。无模型/
        // 超时/输出不合法时保持默认扇区轮转，自主性不受影响。
        if (this.options.replanAI) {
          void this.consultReplanOracle(botId, goal, failures);
        }
      }
    }
    // 任务链衔接（用户产品方向 2026-09-04：完成一个立即接下一个，不卡）：
    // 完成态只留 1s 微让步（事件循环/dashboard 换气），不再等整个 interval
    // ——需求重评估是纯函数（零 AI），链间成本可忽略。intervalMs 只管
    // 空闲轮询节奏；失败态仍走 failureCooldown 防打转。防热环：1s 下限。
    const yieldMs =
      status === "completed"
        ? Math.min(1_000, this.options.intervalMs)
        : this.options.failureCooldownMs;
    this.nextGoalAt.set(botId, nowMs + yieldMs);
    const current = this.tasks.get(botId);
    if (!current || current.taskId !== taskId) return;
    this.setTask(botId, {
      ...current,
      status,
      // 完成态的终态保留=链衔接窗（1s）——下一个任务立即顶上；失败/中断
      // 走各自语义（中断分支已提前 return，这里是失败/完成的保留期）。
      terminalExpiresAtMs: nowMs + (status === "completed" ? yieldMs : this.options.terminalRetentionMs),
    });
  }

  private setTask(botId: string, task: InternalTask): void {
    this.tasks.set(botId, task);
    for (const listener of this.listeners) {
      try {
        listener(botId);
      } catch {
        // Presentation subscribers cannot affect autonomous execution.
      }
    }
  }

  private log(
    level: "info" | "warn",
    event: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    try {
      this.options.logger?.[level](event, fields);
    } catch {
      // Diagnostics cannot change task dispatch.
    }
  }
}

type AutonomousGoal = Readonly<{
  productionFacilityId?: string;
  needKey: SurvivalNeedKey;
  key: string;
  title: string;
  operatorGoal: string;
  reason: string;
  blockName: string | null;
  directionalMining: boolean;
}>;

type ResourceRecoveryResult = Readonly<{
  retry: AutonomousPlanResult | null;
  keepGoal: boolean;
}>;

function eligibleForAutonomy(record: BotRegistryRecord): boolean {
  if (record.connectionState !== "online") return false;
  const status = record.currentStatus;
  if (!status || status.connectionState !== "online") return false;
  if (
    !status.safety ||
    status.safety.mode !== "monitoring" ||
    status.safety.normalTasksPaused ||
    status.safety.activeRisks.length > 0
  ) {
    return false;
  }
  // Mineflayer can leave max_health unknown while current health is valid.
  // Do not block all autonomous work on an optional attribute.
  if (status.health.current <= 0 || status.food.level <= 0) {
    return false;
  }
  if (status.currentTask && isActiveTask(status.currentTask.status)) return false;
  return Boolean(
    record.skillCatalog?.skills.some(({ availability }) => availability === "available"),
  );
}

function isActiveTask(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.has(status);
}

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function validDate(value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("Autonomous director clock is invalid.");
  }
  return value;
}

function boundedError(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 300);
}

function autonomousFailureCode(
  value: AutonomousPlanResult | unknown,
): string | null {
  if (isPlanResult(value)) {
    if (value.action !== "skill_result" || value.result.payload.outcome === "completed") {
      return null;
    }
    return value.result.payload.errorCode;
  }
  if (value instanceof LocalPlannerError) {
    for (const code of RESOURCE_RECOVERY_FAILURE_CODES) {
      if (value.message.includes(code)) return code;
    }
  }
  return null;
}

function isPlanResult(value: unknown): value is AutonomousPlanResult {
  return Boolean(
    value &&
      typeof value === "object" &&
      "action" in value &&
      ((value as { action?: unknown }).action === "noop" ||
        (value as { action?: unknown }).action === "skill_result"),
  );
}

function taskStatusFromPlanResult(
  result: AutonomousPlanResult,
  signal: AbortSignal,
): TaskStatus {
  if (signal.aborted) return "cancelled";
  if (result.action === "noop") {
    return result.reasonCode === "ADVANCE_TASK" ? "completed" : "failed";
  }
  return result.result.payload.outcome === "completed"
    ? "completed"
    : result.result.payload.outcome === "cancelled"
      ? "cancelled"
      : result.result.payload.outcome === "timed_out"
        ? "expired"
        : "failed";
}

function planCompleted(result: AutonomousPlanResult | null): boolean {
  return result?.action === "skill_result" && result.result.payload.outcome === "completed";
}

function scannedResourcePositions(
  result: AutonomousPlanResult,
  blockName: string,
): readonly ScannedResourcePosition[] {
  if (
    result.action !== "skill_result" ||
    result.invocation.payload.skillId !== "world.scan" ||
    result.result.payload.outcome !== "completed"
  ) {
    return [];
  }
  const parsed = scanBlocksOutputSchema.safeParse(result.result.payload.output);
  if (!parsed.success || parsed.data.blockName !== blockName) return [];
  return [...parsed.data.matches]
    .filter((match) => Number.isFinite(match.distance))
    .sort((left, right) => left.distance - right.distance);
}

function shelterMaterial(record: BotRegistryRecord): string | null {
  const inventory = new Map(
    (record.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
      itemName,
      count,
    ] as const),
  );
  return AUTONOMOUS_SHELTER_MATERIALS.find(
    (itemName) => (inventory.get(itemName) ?? 0) > 0,
  ) ?? null;
}

/** 探索焦点方块：按进度选最有价值的下一资源，而不是随机看。 */
function explorationFocusBlock(record: BotRegistryRecord): string {
  const inventory = new Map(
    (record.currentStatus?.inventory ?? []).map(({ itemName, count }) => [
      itemName,
      count,
    ] as const),
  );
  // 高档镐蕴含低档能力，按"最高档"判断而不是逐档存在性。
  if ((inventory.get("diamond_pickaxe") ?? 0) > 0) return "diamond_ore";
  if ((inventory.get("iron_pickaxe") ?? 0) > 0) return "diamond_ore";
  if ((inventory.get("stone_pickaxe") ?? 0) > 0) return "iron_ore";
  if ((inventory.get("wooden_pickaxe") ?? 0) > 0) return "stone";
  return "oak_log";
}

function distanceTo(
  position: Readonly<{ x: number; y: number; z: number }>,
  target: Readonly<{ x: number; y: number; z: number }>,
): number {
  return Math.hypot(position.x - target.x, position.y - target.y, position.z - target.z);
}

/** 稳定的扇区基址（0–7）：同号 Bot 每次从同一扇区起步，不同号错开。 */
function stableSector(botId: string): number {
  let hash = 0;
  for (const char of botId) {
    hash = (hash * 31 + char.charCodeAt(0)) % 1_000_003;
  }
  return hash % 8;
}

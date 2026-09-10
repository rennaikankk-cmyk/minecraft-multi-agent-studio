import { probeBooleanKnob, startLoopMonitor, type LoopMonitorStop } from "./loop-monitor.js";
import { PerfSpanTracker, startPerfTelemetry } from "./perf-spans.js";
import { currentPerfAbMode } from "./perf-ab-gate.js";
import { PhysicsCadence } from "./physics-cadence.js";
import type { LoopDelaySample } from "./loop-monitor.js";
import { rustShadowPlan } from "./rust-pathfinder.js";
import { randomUUID } from "node:crypto";

import {
  BOT_WORLD_STATE_MAX_INVENTORY_ITEMS,
  verifyChatIdentity,
  type ChatIdentityEvidence,
  BOT_WORLD_STATE_MAX_UTILITY_BLOCKS,
  botSkillCatalogV1Schema,
  botVersionV1Schema,
  botStopResultV1Schema,
  botDisconnectedV1Schema,
  botHeartbeatV1Schema,
  botStatusV1Schema,
  botWorldStateUtilityBlockNameV1Schema,
  botWorldStateV1Schema,
  parseBotProtocolMessage,
  parseBotTelemetryMessage,
  parseSkillCancellation,
  parseSkillInvocation,
  resolveGameplayPolicy,
  skillJsonValueSchema,
  type BotDisconnectedV1,
  type BotHeartbeatV1,
  type BotSkillCatalogEntryV1,
  type BotSkillCatalogV1,
  type SkillExecutionResultV1,
  type SkillCancellationV1,
  type SkillInvocationV1,
  type BotStopResultV1,
  type BotStatusV1,
  type BotVersionV1,
  type BotWorldStateV1,
  type ControlAuthorizationContext,
  type MinecraftVersionCompatibility,
  type L0SafetyStatus,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";
import {
  InMemoryMetricRegistry,
  type MetricRecorder,
  type MetricSample,
} from "@minecraft-studio/observability";
import {
  L0SafetyController,
  type L0SafetyAction,
  type L0SafetyActionResult,
  type L0SafetyDecision,
} from "@minecraft-studio/safety";
import {
  builtinSkills,
  craftItemCapabilityOutputSchema,
  inventorySnapshotCapabilityOutputSchema,
  ServerPolicyGate,
  ServerPolicyStore,
  SkillExecutor,
  SkillFault,
  SkillRegistry,
  type GoalRequest,
  type PlannerInventory,
  type RecoveryEffects,
  type SkillCapabilityRequest,
  type SkillCompatibilityEnvironment,
  type SkillCompatibilityResolution,
  type SkillExecutionAuthorization,
} from "@minecraft-studio/skills";
import {
  combatControlInputSchema,
  combatStanceCapabilityInputSchema,
  combatStanceCapabilityOutputSchema,
} from "@minecraft-studio/skills";
import { z } from "zod";
import {
  ANARCHY_COMBAT_REACTION_MAX_DURATION_MS,
  ANARCHY_COMBAT_REACTION_MAX_STEPS,
  ANARCHY_COMBAT_REACTION_TICK_MS,
  COMBAT_REACTION_MAX_DURATION_MS,
  COMBAT_REACTION_MAX_STEPS,
  COMBAT_REACTION_TERMINAL_REASONS,
  COMBAT_REACTION_TICK_MS,
  combatIntentForRequest,
  combatReactionShouldStop,
  syntheticCombatReceipt,
  type CombatIntent,
  type CombatReactionOutcome,
} from "./runtime-combat-reaction.js";
import {
  normalizeKickReason,
  sanitizeServerText,
  skillFaultIncidentType,
  statusFailureReason,
} from "./runtime-failure-classification.js";
export { normalizeKickReason, sanitizeServerText };

import {
  GoalExecutor,
  type GoalExecutionOutcome,
  type StepDispatcher,
} from "./goal-execution.js";

import type {
  BotClient,
  BotClientFactory,
  BotClientSnapshot,
  BotDamageInfo,
  BotDisconnectInfo,
  BotRecoveryAction,
  CompatSignalsSnapshot,
} from "./client.js";
import type { ServerProfile } from "./server-profile.js";
import {
  CombatDriver,
  type CombatDriverReceipt,
  type CombatPrimitiveAction,
} from "./combat-driver.js";
import type { CombatReflexProbeReport } from "@minecraft-studio/combat";
import type { CombatReflexProbeSource } from "./combat-reflex-probe.js";
import type {
  BotConnectionState,
  BotMessageSink,
  RuntimeLogger,
} from "./runtime-types.js";
import { unsupportedVersionCompatibility } from "./version-compatibility.js";
import {
  ProgressWatchdog,
  resolveProgressWatchdogConfig,
  resolveWatchdogProfile,
  type ProgressWatchdogEvent,
  type ProgressWatchdogSnapshot,
} from "./progress-watchdog.js";
import { progressContractForAction } from "./progress-watchdog.js";
import { IncidentReporter, watchdogEventToSignal } from "./incident-reporter.js";
import { RuntimeEventBuffer } from "./runtime-event-buffer.js";
import { loadRuntimeIdentity } from "./runtime-identity.js";
import {
  buildTacticsShadowSnapshot,
  emergencySignalFromObservation,
  resolveTacticsCoreEnabled,
} from "./tactics-shadow.js";
import type { TacticalDecision } from "@minecraft-studio/combat";
import {
  DEFAULT_TACTICS_PROFILE,
  buildDecisionEvidence,
  scoreTacticalActions,
  selectTacticalAction,
} from "@minecraft-studio/combat";
import { WorldStateStore, type WorldStateSnapshot } from "./world-state.js";

type TimerHandle = ReturnType<typeof setTimeout>;
type RuntimeCurrentTask = NonNullable<BotStatusV1["payload"]["currentTask"]>;
type ActiveCoordinatorTask = Readonly<{
  task: RuntimeCurrentTask;
  order: number;
}>;


export type RuntimeDependencies = {
  createClient: BotClientFactory;
  messageSink: BotMessageSink;
  logger: RuntimeLogger;
  metrics?: MetricRecorder;
  safetyController?: L0SafetyController;
  skillRegistry?: SkillRegistry;
  /**
   * 服务器策略来源。不注入时用空 store：所有服都解析为 STRICT baseline，
   * 直到 ServerPolicyDetector 实测出更宽的档位并 upsert 进来。
   */
  serverPolicyStore?: ServerPolicyStore;
  /**
   * 把一步计划绑定成完整的 skill.invoke.v1 信封 + 授权。
   *
   * 运行时**不自己造**这两样：protocol 把 source.service 钉死为 "coordinator"，
   * 授权还要与 skillId / skillVersion / invocationId 逐字段对上，bot-runtime
   * 无权自签；挖哪一格、用哪个工作台也是世界状态问题，规划器不知道。
   * 不注入时 pursueGoals 会如实失败（PLAN_STEP_DISPATCH_UNAVAILABLE），
   * 不假装成功。
   */
  goalStepDispatcher?: StepDispatcher;
  /** 恢复阶梯的副作用钩子。缺失的钩子记 repair-rejected，不假装执行过。 */
  goalRecoveryEffects?: RecoveryEffects;
  now?: () => Date;
  /** 单调时钟（watchdog elapsed 计算注入用；缺省 performance.now()）。 */
  monotonicNow?: () => number;
  randomId?: () => string;
  /**
   * 反射级时序探针。两种形态：
   *   - 静态 CombatReflexProbeReport（操作员在代表性负载下的实测报告）；
   *   - CombatReflexProbeSource（live 探针：runtime 的战斗反应循环逐步回填
   *     实测步长，spawn 时读取最新报告）。live 探针在首个样本前 report()
   *     返回 null——仍是 NO_PROBE_DATA fail-closed，不假装测过。
   * 缺省不注入 = 维持 NO_PROBE_DATA（诚实拒绝）。
   */
  combatReflexProbe?: CombatReflexProbeReport | CombatReflexProbeSource | null;
  /**
   * 运行时完整停止后的通知（含停止原因）。宿主用它实现 L0 断线保号的
   * 退避重启：直接重启会被同一群怪再打一次，形成分钟级循环。
   */
  onStopped?: (reason: string) => void;
};

export type RuntimeStopOutcome =
  | { confirmed: true }
  | { confirmed: false; errorCode: "CLIENT_CLOSE_FAILED" };

export type RuntimeControlErrorCode =
  | "CONTROL_MESSAGE_REQUIRED"
  | "COMMAND_ID_CONFLICT"
  | "CONTROL_IDENTITY_MISMATCH";

export class RuntimeControlError extends Error {
  readonly code: RuntimeControlErrorCode;

  constructor(code: RuntimeControlErrorCode, message: string) {
    super(message);
    this.name = "RuntimeControlError";
    this.code = code;
  }
}

/**
 * Build a compact, log-safe digest of a skill result so a single log line makes
 * a server verification run judgeable. We surface only bounded scalar summary
 * fields that skills expose on their validated output (counts, scores, latency
 * signals) — never raw world state, inventory contents, or credentials. Unknown
 * shapes degrade to `null` rather than dumping arbitrary output.
 */
function skillResultTelemetryDigest(
  result: SkillExecutionResultV1,
): Readonly<Record<string, number>> | null {
  if (result.payload.outcome !== "completed") return null;
  const output = result.payload.output;
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return null;
  }
  const record = output as Record<string, unknown>;
  // Allow-list of scalar summary keys skills may publish for verifiability.
  const summaryKeys = [
    "changedCount",
    "capabilityCallCount",
    "totalScoreBefore",
    "totalScoreAfter",
    "distanceToTarget",
    "targetsFound",
    "itemsCollected",
    "requestedCount",
    "craftedCount",
    "movedCount",
    "smeltedCount",
  ] as const;
  const digest: Record<string, number> = {};
  for (const key of summaryKeys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      digest[key] = value;
    }
  }
  return Object.keys(digest).length > 0 ? digest : null;
}

function skillCatalogEntry(
  resolution: SkillCompatibilityResolution,
  registry: SkillRegistry,
): BotSkillCatalogEntryV1 {
  const definition = registry.resolve(resolution.skillId, resolution.skillVersion);
  if (!definition) {
    throw new Error("Skill compatibility catalog references an unknown definition.");
  }
  const unavailableReasons = resolution.availability === "available"
    ? []
    : resolution.variants.flatMap((variant) =>
        variant.unmetRequirements.map((unmet) => {
          const requirement = unmet.requirement;
          let code: BotSkillCatalogEntryV1["unavailableReasons"][number]["code"];
          let subject: string;
          if (requirement.kind === "feature") {
            code = unmet.status === "unknown"
              ? "COMPATIBILITY_ENVIRONMENT_UNAVAILABLE"
              : "FEATURE_MISSING";
            subject = requirement.name;
          } else if (requirement.kind === "resource") {
            code = unmet.status === "unknown"
              ? "COMPATIBILITY_ENVIRONMENT_UNAVAILABLE"
              : "RESOURCE_MISSING";
            subject = `${requirement.resource}:${requirement.match}:${requirement.names.join(",")}`;
          } else {
            code = unmet.status === "unknown"
              ? "SERVER_CAPABILITY_UNKNOWN"
              : "SERVER_CAPABILITY_MISSING";
            subject = requirement.name;
          }
          return {
            variantId: variant.variantId,
            code,
            subject: subject.slice(0, 512),
          };
        }),
      );
  return {
    skillId: resolution.skillId,
    skillVersion: resolution.skillVersion,
    availability: resolution.availability,
    verification: resolution.verification,
    inputSchema: skillJsonValueSchema.parse(z.toJSONSchema(definition.inputSchema, {
      io: "input",
      // Defaults are applied by the authoritative Zod parser, not by the wire schema validator.
      override: ({ jsonSchema }) => { delete jsonSchema.default; },
    })),
    timeoutMs: definition.timeoutMs,
    idempotent: definition.idempotent,
    selectedVariantId: resolution.selectedVariantId,
    unavailableReasons,
  };
}


export class SingleBotRuntime {
  private readonly runtimeInstanceId: string;
  private readonly metrics: MetricRecorder;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly safetyController: L0SafetyController;
  private readonly skillRegistry: SkillRegistry;
  private readonly skillExecutor: SkillExecutor;
  private readonly goalExecutor: GoalExecutor;
  private readonly worldState = new WorldStateStore();
  private readonly progressWatchdog: ProgressWatchdog;
  /** monotonic 时钟（watchdog elapsed 计算用；wall clock 只做展示）。 */
  private readonly monotonicNow: () => number;
  private readonly eventBuffer: RuntimeEventBuffer;
  // P0-3：eventBuffer 的去重/阈值基线（movement owner / pathResets / 距离）
  private lastBufferedMovementOwner: string | null = null;
  private lastBufferedPathResets = 0;
  private lastBufferedDistance: number | null = null;
  private readonly incidentReporter
  private state: BotConnectionState = "offline";
  private client: BotClient | null = null;
  private generation = 0;
  private traceId = "not-connected";
  private sequence = 0;
  private lastStatusSequence: number | null = null;
  private reconnectAttempts = 0;
  private stopping = false;
  private heartbeatTimer: TimerHandle | null = null;
  private statusTimer: TimerHandle | null = null;
  private deferredStatusTimer: TimerHandle | null = null;
  private reconnectTimer: TimerHandle | null = null;
  private lastStatusAt = 0;
  // 本次连接有没有成功发出过一条状态。spawn 之后服务端还没送出第一个 health
  // 包时快照里 health 是 undefined，L0 边界据此拒绝——这是每次启动都会发生的
  // 预期情形，不是缺陷。用它把"第一条还没成"和"已经成过又坏了"分开。
  private statusEmittedForConnection = false;
  private minecraftVersionCompatibility: MinecraftVersionCompatibility | null =
    null;
  private skillCompatibilityEnvironment: SkillCompatibilityEnvironment | null =
    null;
  private skillCompatibilityCatalog: readonly SkillCompatibilityResolution[] =
    [];
  private currentTask: RuntimeCurrentTask | null = null;
  private readonly activeCoordinatorTasks = new Map<string, ActiveCoordinatorTask>();
  private coordinatorTaskOrder = 0;
  private versionUnsupported = false;
  private stopPromise: Promise<RuntimeStopOutcome> | null = null;
  private safetyActionQueue: Promise<void> = Promise.resolve();
  private watchdogRecovery: Promise<void> | null = null;
  private safetyStatus: L0SafetyStatus = {
    mode: "monitoring",
    activeRisks: [],
    normalTasksPaused: false,
    lastDecisionId: null,
    lastAction: null,
  };
  private readonly stopExecutions = new Map<
    string,
    { fingerprint: string; result: Promise<BotStopResultV1> }
  >();
  private readonly activeSkillControllers = new Map<string, AbortController>();
  /** 最近一次死亡事实；由 death 事件写入，随 status 上报供回收决策。 */
  /**
   * P1（2026-09-03）：确定性不兼容（Forge/FML mod loader kick）闩锁——
   * 一旦确认即抑制一切自动重连（重连不可能改变 mod loader 事实），
   * 全生命周期只产生一个 SERVER_KICK Incident，随后进入 BLOCKED 语义
   * （offline + 不再尝试，等待人工换服/换兼容栈）。
   */
  private modLoaderIncompatible = false;
  private lastDeath: {
    x: number;
    y: number;
    z: number;
    dimension: string;
    diedAt: string;
    /** 死亡时刻的背包快照（门禁 3：重生后背包为空，事后无法补抓）。 */
    droppedItems?: ReadonlyArray<Readonly<{ itemId: string; count: number }>>;
    xpPoints?: number;
  } | null = null;
  private readonly activeSkillTasks = new Map<
    string,
    Readonly<{
      taskId: string;
      title: string;
      startedAt: string;
    }>
  >();
  private combatReaction: {
    generation: number;
    client: BotClient;
    taskId: string;
    controller: AbortController;
  } | null = null;
  private nextProactiveCombatAtMs = 0;
  private readonly skillExecutions = new Map<
    string,
    { fingerprint: string; result: Promise<SkillExecutionResultV1> }
  >();
  private readonly serverPolicyStore: ServerPolicyStore;
  private readonly combatDriver: CombatDriver | null;
  /** live 反射探针（有则战斗反应循环逐步回填实测步长）。 */
  private readonly combatReflexProbeSource: CombatReflexProbeSource | null;
  /**
   * 战术核心 advisory shadow（STUDIO_TACTICS_CORE，默认关）。关 = 零行为
   * 变化、零事件；开 = 每步战斗反应额外产出一条 bot_tactics_decision 证据
   * 事件，绝不驱动动作。
   */
  private readonly tacticsCoreEnabled: boolean;
  /** 当前战斗反应 epoch 内上一步的战术裁决（滞回/承诺输入）。 */
  private tacticsShadowPreviousDecision: TacticalDecision | null = null;
  private tacticsShadowLastStepMonotonicMs: number | null = null;

  constructor(
    private readonly profile: ServerProfile,
    private readonly dependencies: RuntimeDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
    const reflexProbeDependency = dependencies.combatReflexProbe ?? null;
    this.combatReflexProbeSource =
      reflexProbeDependency !== null &&
      typeof (reflexProbeDependency as CombatReflexProbeSource).recordStepDurationMs === "function"
        ? (reflexProbeDependency as CombatReflexProbeSource)
        : null;
    const watchdogProfile = resolveWatchdogProfile();
    // 战术核心 shadow 开关在启动时读一次（与 STUDIO_WATCHDOG_PROFILE 同一
    // fail-closed 语义：垃圾值抛错拒绝启动，运行期不再变）。
    this.tacticsCoreEnabled = resolveTacticsCoreEnabled();
    if (this.tacticsCoreEnabled) {
      dependencies.logger?.warn?.(
        "bot_runtime_tactics_core_shadow_enabled",
        this.logFields({
          tacticsProfileVersion: DEFAULT_TACTICS_PROFILE.schemaVersion,
          advisoryOnly: true,
          evidenceQuality: "partial-wiring",
        }),
      );
    }
    this.progressWatchdog = new ProgressWatchdog(resolveProgressWatchdogConfig());
    this.eventBuffer = new RuntimeEventBuffer();
    this.incidentReporter = new IncidentReporter({
      botId: profile.botId,
      endpoint: process.env.STUDIO_INCIDENT_ENDPOINT?.trim() || undefined,
      token: process.env.STUDIO_INCIDENT_TOKEN?.trim() || undefined,
      spoolPath: process.env.STUDIO_INCIDENT_SPOOL_PATH?.trim() || undefined,
      logger: { warn: (message: string) => dependencies.logger?.warn?.(message) ?? console.warn(message) },
      eventSink: (event) => this.eventBuffer.append({
        kind: event.kind,
        source: "reporter",
        detail: event.detail,
        correlationId: event.correlationId,
      }),
    });
    this.randomId = dependencies.randomId ?? randomUUID;
    dependencies.logger?.warn?.(
      "bot_runtime_watchdog_profile",
      { profile: watchdogProfile, note: "production 35s/90s; e2e test-only 8s/20s" },
    );
    this.runtimeInstanceId = `runtime-${this.randomId()}`;
    this.metrics = dependencies.metrics ?? new InMemoryMetricRegistry();
    this.safetyController = dependencies.safetyController ?? new L0SafetyController();
    const skillRegistry = dependencies.skillRegistry ?? new SkillRegistry();
    if (!dependencies.skillRegistry) {
      // 从单一清单注册，不再逐行列举：此前 register 列表、验收场景清单与
      // SKILLS.md 各存一份"有哪些技能"，smelt.item 只漏掉一处就没人发现。
      for (const skill of builtinSkills) skillRegistry.register(skill);
    }
    this.skillRegistry = skillRegistry;
    this.serverPolicyStore =
      // 无规则服：未知服兜底档直接用 ANARCHY（那里没有反作弊，STRICT 的
      // 禁疾跑/6CPS 只会削弱自己）；实测 upsert 的记录仍然优先。
      dependencies.serverPolicyStore ??
      new ServerPolicyStore(
        profile.purpose === "anarchy" ? "ANARCHY" : undefined,
      );
    this.combatDriver = profile.combat?.enabled === true
      ? new CombatDriver({
          serverProfileId: profile.id,
          selfUsername: profile.username,
          stance: profile.combat.stance,
          whitelist: profile.combat.whitelist,
          combatIntensity: profile.purpose === "anarchy" ? "anarchy" : "standard",
          policyGate: new ServerPolicyGate(
            this.serverPolicyStore.resolve(profile.id),
          ),
          policyGateProvider: () =>
            new ServerPolicyGate(this.serverPolicyStore.resolve(profile.id)),
          reflexProbe: this.resolveCombatReflexProbe(),
        })
      : null;
    this.skillExecutor = new SkillExecutor(skillRegistry, {
      runtimeInstanceId: this.runtimeInstanceId,
      capabilityAdapter: {
        invoke: (request) => this.invokeSkillCapability(request),
      },
      now: this.now,
      messageId: this.randomId,
      // 每次调用现取一份闸门：策略可能在 bot 存活期间被 detector 改写，
      // 缓存住就会拿旧档位裁决。闸门本身有频率窗口状态，所以不跨调用复用。
      policyView: (serverProfileId) =>
        new ServerPolicyGate(this.serverPolicyStore.resolve(serverProfileId)),
      // 终态失败的屏蔽码只说"哪一类坏了"，说不出"为什么"。原因留在这条 warn 里，
      // 不进结果消息：协议面向协调器,诊断面向运维,两者的收敛面不该混。
      onFault: (fault) => {
        this.dependencies.logger.warn(
          "bot_runtime_skill_fault",
          this.logFields(
            {
              skillVersion: fault.skillVersion,
              errorCode: fault.errorCode,
              attempts: fault.attempts,
              reason: fault.reason,
            },
            fault.traceId,
            fault.taskId,
            fault.skillId,
          ),
        );
        // 技能终态失败 → Incident：pathfinder 快速失败（如基岩封死瞬时
        // PATHFINDER_GOTO_FAILED）时 watchdog 没有观察窗口，onFault 是这条
        // 失败链的可靠入口。非阻塞：有界队列，失败只计数。
        // 因果模型：fault.errorCode 是根因；SKILL_RECOVERY_EXHAUSTED 是终态
        // Outcome（store 端 R-CAUSAL-1 会按根因层分类，不默认归咎 SKILL）。
        let faultVersionInfo: {
          minecraftVersion?: string | undefined;
          protocolVersion?: number | undefined;
        } = {};
        try {
          const compatibility = this.client?.versionCompatibility();
          if (compatibility) {
            faultVersionInfo = {
              minecraftVersion: compatibility.resolvedVersion ?? undefined,
              protocolVersion: compatibility.protocolVersion ?? undefined,
            };
          }
        } catch {
          // 版本未协商 → 缺省，不伪造
        }
        const identity = loadRuntimeIdentity();
        this.incidentReporter.report({
          failureCode: "SKILL_RECOVERY_EXHAUSTED",
          terminalFailureCode: "SKILL_RECOVERY_EXHAUSTED",
          causedByFailureCodes: [fault.errorCode],
          incidentType: skillFaultIncidentType(fault.errorCode),
          sourceComponent: "skill-executor",
          severity: "ERROR",
          skillId: fault.skillId,
          taskId: fault.taskId,
          sessionId: this.runtimeInstanceId,
          correlationId: fault.traceId,
          serverProfileId: this.profile.id,
          position: this.worldState.snapshot().position ?? undefined,
          dimension: this.worldState.snapshot().position?.dimension ?? undefined,
          gitCommit: identity.gitCommit ?? undefined,
          branch: identity.branch ?? undefined,
          buildVersion: identity.buildVersion ?? undefined,
          dirtyBuild: identity.dirtyBuild ?? undefined,
          runtimeInstanceId: this.runtimeInstanceId,
          ...faultVersionInfo,
          expected: "skill completes or fails with a recoverable code",
          actual: `${fault.errorCode} after ${fault.attempts} attempt(s)${fault.reason ? `: ${fault.reason}` : ""}`,
          normalizedErrorSignature: fault.errorCode,
          actionFamily: "skill",
          snapshots: {},
        });
      },
    });
    // §4 的接线：目标分解与恢复阶梯从此走真实派发路径。invoke 直接绑到
    // handleSkillInvocation——同一条路径、同一套协议校验、同一份遥测，
    // 不给计划步骤开旁路。
    this.goalExecutor = new GoalExecutor({
      invoke: (invocation, authorization, signal) =>
        this.handleSkillInvocation(invocation, authorization, signal),
      ...(dependencies.goalStepDispatcher
        ? { dispatch: dependencies.goalStepDispatcher }
        : {}),
      ...(dependencies.goalRecoveryEffects
        ? { effects: dependencies.goalRecoveryEffects }
        : {}),
      logger: {
        info: (event, fields) =>
          this.dependencies.logger.info(event, this.logFields(fields)),
        warn: (event, fields) =>
          this.dependencies.logger.warn(event, this.logFields(fields)),
      },
    });
  }

  getState(): BotConnectionState {
    return this.state;
  }

  /**
   * 读取当前可用的反射探针报告：live 源现取（零样本 → null），静态报告原样。
   * 构造期调用时 live 探针必然零样本 → NO_PROBE_DATA（fail-closed）。
   */
  private resolveCombatReflexProbe(): CombatReflexProbeReport | null {
    const probe = this.dependencies.combatReflexProbe ?? null;
    if (probe === null) return null;
    if (typeof (probe as CombatReflexProbeSource).recordStepDurationMs === "function") {
      return (probe as CombatReflexProbeSource).report(this.profile.id);
    }
    return probe as CombatReflexProbeReport;
  }

  getRuntimeInstanceId(): string {
    return this.runtimeInstanceId;
  }

  getMetricsSnapshot(): MetricSample[] {
    return this.metrics.snapshot();
  }

  getSafetyStatus(): L0SafetyStatus {
    return structuredClone(this.safetyStatus);
  }

  getWorldStateSnapshot(): WorldStateSnapshot {
    return this.worldState.snapshot();
  }

  getProgressWatchdogSnapshot(): ProgressWatchdogSnapshot {
    return this.progressWatchdog.snapshot();
  }

  getCombatEndToEndProbe() {
    return this.combatReflexProbeSource?.endToEndReport?.() ?? {
      samples: 0,
      p95ThreatToDecisionMs: null,
      p95DecisionToPacketMs: null,
      p95PacketToServerMs: null,
      p95TotalMs: null,
    };
  }

  /**
   * Round 7 兼容层信号快照（本地控制面读取；与 getSafetyStatus 同级）。
   * 协议 bot.status.v1 是 strict schema——把该快照挂上线上状态需要先扩
   * protocol 契约，扩契约前宿主/运维从这里取（wiring-pending：线上状态字段）。
   */
  getCompatSignals(): CompatSignalsSnapshot | null {
    return this.client?.compatSignals?.() ?? null;
  }

  canAcceptNormalActions(): boolean {
    return this.state === "online" && !this.safetyStatus.normalTasksPaused;
  }

  /**
   * Publishes a fresh control-plane snapshot after an authenticated Runtime
   * Link reconnect. Old queued telemetry must not be replayed to make a stale
   * Bot appear live.
   */
  publishCurrentState(): void {
    if (this.minecraftVersionCompatibility) {
      this.emitVersion();
    }
    if (this.skillCompatibilityEnvironment) {
      this.emitSkillCatalog();
    }
    if (this.state === "online" && this.client) {
      this.emitStatus(this.generation);
    }
    this.emitHeartbeat();
  }

  private loopMonitorStop: LoopMonitorStop | null = null;
  private loopDelaySample: LoopDelaySample | null = null;
  private readonly physicsCadence = new PhysicsCadence();
  private shadowTimer: NodeJS.Timeout | null = null;
  /** Phase 4 诊断门：skip_worldstate 模式下 L0 复用的最近快照。 */
  private lastAbSnapshot: BotClientSnapshot | null = null;

  /**
   * P5-B 单一 Snapshot Provider：worldStateSnapshot 构建收口（Phase 4 实锤
   * 双调用点泄漏——requestStatus 与 emitStatus 各自触发 blocks.scan miss，
   * 最坏 2 miss/s）。TTL 内复用同一构建（同 generation）；TTL 过期由首个
   * 消费者重建。这是 B1 形态：旧扫描仍是数据源，Rust WorldMirror 是 B2。
   */
  private worldSnapshotProvider: {
    snapshot: unknown;
    generation: number;
    capturedAtMs: number;
    scopeKey: string;
  } = { snapshot: null, generation: 0, capturedAtMs: 0, scopeKey: "" };
  private static readonly WORLD_SNAPSHOT_TTL_MS = 600;

  /** Phase 3 测量面：分段计时（只观测不改行为；STUDIO_PERF_SPANS=0 关）。 */
  readonly perfSpans = new PerfSpanTracker();
  private perfTelemetryStop: (() => void) | null = null;

  start(): void {
    if (this.state !== "offline" || this.client || this.reconnectTimer) {
      throw new Error("Bot Runtime has already been started.");
    }
    this.stopPromise = null;
    this.stopping = false;
    this.reconnectAttempts = 0;
    this.loopMonitorStop ??= startLoopMonitor(this.dependencies.logger, 30_000, (sample) => { this.loopDelaySample = sample; });
    this.shadowTimer = setInterval(() => {
      if (currentPerfAbMode() !== "shadow_rust") return;
      if (this.state !== "online" || !this.client) return;
      const client = this.client as unknown as { bot?: unknown };
      const bot = (client as { bot?: { entity?: { position: unknown } } }).bot;
      if (!bot || !(bot as { entity?: unknown }).entity) return;
      void this.perfSpans.spanAsync("rust.shadow.plan", () => rustShadowPlan(bot as never));
    }, 1_000);
    this.shadowTimer.unref?.();
    this.perfTelemetryStop ??= startPerfTelemetry({
      logger: this.dependencies.logger,
      tracker: this.perfSpans,
      context: () => ({ runtimeGeneration: this.generation, state: this.state }),
    });
    // 旋钮探针（Phase 2c allowlist）：严格门语义（=1 开，=0/空 关，其他=显式
    // 降级并标 invalid）；只输出非敏感旋钮名与解析结果，绝不输出任何密钥类变量。
    const probeKnob = (name: string) => {
      const probed = probeBooleanKnob(process.env[name]);
      return {
        effective: probed.effective,
        source: probed.source,
        ...(probed.raw !== null ? { raw: probed.raw } : {}),
        ...(probed.invalid ? { invalid: true } : {}),
      };
    };
    this.dependencies.logger.info?.("runtime_env_probe", {
      schemaVersion: "1.0",
      knobs: {
        STUDIO_RUST_PATHFINDER: probeKnob("STUDIO_RUST_PATHFINDER"),
        STUDIO_NO_HUNGER: probeKnob("STUDIO_NO_HUNGER"),
        STUDIO_L0_EMERGENCY_STOP: probeKnob("STUDIO_L0_EMERGENCY_STOP"),
        STUDIO_PURSUIT: probeKnob("STUDIO_PURSUIT"),
        // P5-D2c WorldMirror 同步通道灰度门（默认关；与 Rust Pathfinder 门
        // 分离——两者可独立 AB）。无效值显式降级标 invalid（§20）。
        STUDIO_WORLD_MIRROR_SYNC: probeKnob("STUDIO_WORLD_MIRROR_SYNC"),
      },
      envKeyCount: Object.keys(process.env).length,
    });
    this.connect();

  }

  stop(
    reason = "operator_request",
    operationTraceId = this.traceId,
  ): Promise<RuntimeStopOutcome> {
    if (this.stopPromise) return this.stopPromise;

    const pending = this.performStop(reason, operationTraceId);
    this.stopPromise = pending;
    void pending.then((outcome) => {
      if (!outcome.confirmed && this.stopPromise === pending) {
        this.stopPromise = null;
        this.stopping = false;
      }
    });
    return pending;
  }

  handleStopCommand(
    input: unknown,
    authorizationContext: ControlAuthorizationContext,
  ): Promise<BotStopResultV1> {
    const message = parseBotProtocolMessage(input, authorizationContext);
    if (message.type !== "bot.stop.command.v1") {
      throw new RuntimeControlError(
        "CONTROL_MESSAGE_REQUIRED",
        "Bot Runtime only accepts a validated stop command on this control path.",
      );
    }

    const fingerprint = JSON.stringify(message);
    const existing = this.stopExecutions.get(message.payload.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RuntimeControlError(
          "COMMAND_ID_CONFLICT",
          "The command ID was already used with different stop parameters.",
        );
      }
      return existing.result;
    }

    const result = this.executeStopCommand(message);
    this.stopExecutions.set(message.payload.commandId, { fingerprint, result });
    void result.then(
      () => this.trimStopExecutions(),
      () => this.trimStopExecutions(),
    );
    return result;
  }

  async handleSkillInvocation(
    input: unknown,
    authorization: SkillExecutionAuthorization,
    externalSignal?: AbortSignal,
  ): Promise<SkillExecutionResultV1> {
    const invocation = parseSkillInvocation(input);
    const controller = new AbortController();
    const cancelFromCaller = () => controller.abort();
    externalSignal?.addEventListener("abort", cancelFromCaller, { once: true });
    if (externalSignal?.aborted) cancelFromCaller();
    this.activeSkillControllers.set(invocation.payload.invocationId, controller);
    this.activeSkillTasks.set(invocation.payload.invocationId, {
      taskId: invocation.taskId,
      title: invocation.payload.skillId,
      startedAt: this.now().toISOString(),
    });
    this.requestStatus(this.generation);

    try {
      const startedAtMs = this.now().getTime();
      const result = await this.skillExecutor.execute(
        invocation,
        authorization,
        this.skillState(),
        controller.signal,
        this.skillCompatibilityEnvironment,
      );
      const durationMs = Math.max(0, this.now().getTime() - startedAtMs);
      this.metrics.increment("bot_skill_results_total", {
        bot_id: this.profile.botId,
        outcome: result.payload.outcome,
        skill_id: result.payload.skillId,
      });
      const log =
        result.payload.outcome === "completed"
          ? this.dependencies.logger.info.bind(this.dependencies.logger)
          : this.dependencies.logger.warn.bind(this.dependencies.logger);
      this.eventBuffer.append({
        kind: result.payload.outcome === "completed" ? "skill_result" : "skill_fault",
        source: "skill",
        correlationId: invocation.payload.invocationId,
        taskId: invocation.taskId,
        skillId: invocation.payload.skillId,
        detail: `outcome=${result.payload.outcome}${"errorCode" in result.payload && result.payload.errorCode ? ` code=${result.payload.errorCode}` : ""} attempts=${result.payload.attempts}`,
      });
      log(
        "bot_runtime_skill_result",
        this.logFields(
          {
            skillVersion: result.payload.skillVersion,
            outcome: result.payload.outcome,
            attempts: result.payload.attempts,
            durationMs,
            // A compact, non-sensitive digest of the validated skill output so
            // a single log line reveals whether a verification run actually did
            // useful work. Never contains credentials or raw world state.
            telemetry: skillResultTelemetryDigest(result),
            ...(this.client && "rustPathStats" in this.client && (this.client as { rustPathStats: unknown }).rustPathStats
              ? { rustPath: (this.client as { rustPathStats: Record<string, unknown> }).rustPathStats }
              : {}),
            ...("errorCode" in result.payload
              ? { errorCode: result.payload.errorCode }
              : {}),
          },
          result.traceId,
          result.taskId,
          result.payload.skillId,
        ),
      );
      return result;
    } finally {
      if (this.activeSkillControllers.get(invocation.payload.invocationId) === controller) {
        this.activeSkillControllers.delete(invocation.payload.invocationId);
      }
      this.activeSkillTasks.delete(invocation.payload.invocationId);
      this.requestStatus(this.generation);
      externalSignal?.removeEventListener("abort", cancelFromCaller);
    }
  }

  /**
   * 追一组物品目标：分解成计划、逐步派发、失败按恢复阶梯处理。
   *
   * 这是 §4 智能层唯一的入口。三条 fail-closed 前置：
   *   - bot 不在线或 L0 暂停了普通动作 → 立刻拒，不进规划（BOT_NOT_ONLINE /
   *     NORMAL_ACTIONS_PAUSED 都会被分类成 SAFETY_INTERRUPT，阶梯会等恢复）。
   *   - 没注入 dispatcher → GoalExecutor 自己如实失败并升级人工。
   * `inventory` 由调用方给：运行时读不到可信的库存快照，猜一个会让补齐子计划
   * 重复采集或漏采。给空对象就是"当作什么都没有"，不是"假装够了"。
   */
  pursueGoals(
    goals: readonly GoalRequest[],
    inventory: PlannerInventory = {},
    externalSignal?: AbortSignal,
  ): Promise<GoalExecutionOutcome> {
    if (this.state !== "online") {
      return Promise.resolve({
        planned: false,
        errorCode: "BOT_NOT_ONLINE",
        blockedOn: this.state,
      });
    }
    if (!this.canAcceptNormalActions()) {
      return Promise.resolve({
        planned: false,
        errorCode: "NORMAL_ACTIONS_PAUSED",
        blockedOn: this.safetyStatus.mode,
      });
    }
    return this.goalExecutor.pursue(goals, inventory, externalSignal);
  }

  handleCoordinatorSkillCancellation(
    input: unknown,
    coordinatorInstanceId: string,
  ): boolean {
    const cancellation = parseSkillCancellation(input);
    if (
      cancellation.source.instanceId !== coordinatorInstanceId ||
      cancellation.botId !== this.profile.botId
    ) {
      throw new RuntimeControlError(
        "CONTROL_IDENTITY_MISMATCH",
        "Skill cancellation does not match the authenticated Runtime Link identity.",
      );
    }
    if (this.now().getTime() > Date.parse(cancellation.payload.expiresAt)) return false;
    const controller = this.activeSkillControllers.get(
      cancellation.payload.invocationId,
    );
    if (!controller) return false;
    controller.abort();
    return true;
  }

  handleCoordinatorSkillInvocation(
    input: unknown,
    coordinatorInstanceId: string,
    externalSignal?: AbortSignal,
  ): Promise<SkillExecutionResultV1> {
    const invocation = parseSkillInvocation(input);
    if (
      invocation.source.instanceId !== coordinatorInstanceId ||
      invocation.botId !== this.profile.botId
    ) {
      throw new RuntimeControlError(
        "CONTROL_IDENTITY_MISMATCH",
        "Skill invocation does not match the authenticated Runtime Link identity.",
      );
    }

    const fingerprint = JSON.stringify(invocation);
    const existing = this.skillExecutions.get(invocation.payload.invocationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new RuntimeControlError(
          "COMMAND_ID_CONFLICT",
          "The invocation ID was already used with different skill parameters.",
        );
      }
      return existing.result;
    }

    const definition = this.skillRegistry.resolve(
      invocation.payload.skillId,
      invocation.payload.skillVersion,
    );
    const matchingActiveTask = [...this.activeCoordinatorTasks.values()].find(
      ({ task }) => task.taskId === invocation.taskId,
    )?.task;
    const task: RuntimeCurrentTask = {
      taskId: invocation.taskId,
      title: invocation.payload.skillId,
      status: "running",
      startedAt:
        matchingActiveTask?.startedAt ??
        (this.currentTask?.taskId === invocation.taskId
          ? this.currentTask.startedAt
          : this.now().toISOString()),
    };
    this.coordinatorTaskOrder += 1;
    this.activeCoordinatorTasks.set(invocation.payload.invocationId, {
      task,
      order: this.coordinatorTaskOrder,
    });
    this.eventBuffer.append({
      kind: "skill_started",
      source: "skill",
      correlationId: invocation.payload.invocationId,
      taskId: invocation.taskId,
      skillId: invocation.payload.skillId,
      detail: `skill=${invocation.payload.skillId}@${invocation.payload.skillVersion} taskId=${invocation.taskId}`,
    });
    this.eventBuffer.append({
      kind: "task_started",
      source: "task",
      correlationId: invocation.payload.invocationId,
      taskId: invocation.taskId,
      detail: `title=${invocation.payload.skillId}`,
    });
    this.currentTask = task;
    this.publishCurrentTaskState();
    const authorization: SkillExecutionAuthorization = {
      decisionId: invocation.payload.authorization.decisionId,
      actorId: invocation.payload.authorization.actorId,
      sourceInstanceId: invocation.source.instanceId,
      traceId: invocation.traceId,
      taskId: invocation.taskId,
      botId: invocation.botId,
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      issuedAt: invocation.payload.authorization.issuedAt,
      expiresAt: invocation.payload.authorization.expiresAt,
      allowedCapabilities: new Set(definition?.requiredCapabilities ?? []),
    };
    const result = this.handleSkillInvocation(
      invocation,
      authorization,
      externalSignal,
    );
    this.skillExecutions.set(invocation.payload.invocationId, {
      fingerprint,
      result,
    });
    void result.then(
      (completed) => {
        this.finishCoordinatorInvocation(
          invocation.payload.invocationId,
          completed.payload.outcome === "completed"
            ? "completed"
            : completed.payload.outcome === "cancelled"
              ? "cancelled"
              : completed.payload.outcome === "timed_out"
                ? "expired"
                : "failed",
        );
        this.trimSkillExecutions();
      },
      () => {
        this.finishCoordinatorInvocation(
          invocation.payload.invocationId,
          "failed",
        );
        this.trimSkillExecutions();
      },
    );
    return result;
  }

  private async performStop(
    reason: string,
    operationTraceId: string,
  ): Promise<RuntimeStopOutcome> {
    this.stopping = true;
    this.loopMonitorStop?.();
    this.loopMonitorStop = null;
    this.loopDelaySample = null;
    this.perfTelemetryStop?.();
    this.perfTelemetryStop = null;
    if (this.shadowTimer) clearInterval(this.shadowTimer);
    this.shadowTimer = null;

    this.cancelCombatReaction();
    this.client?.interruptNormalActions?.();
    if (this.cancelRunningCoordinatorTasks()) {
      this.emitStatus(this.generation, false);
    }
    this.cancelActiveSkills();
    this.metrics.increment("bot_stop_requests_total", {
      bot_id: this.profile.botId,
      source: reason.startsWith("coordinator_") ? "coordinator" : "local",
    });
    this.clearTimer("reconnect");
    this.clearTimer("status");
    this.clearTimer("deferredStatus");

    const activeClient = this.client;
    const activeGeneration = this.generation;
    if (!activeClient) {
      this.clearTimer("heartbeat");
      this.state = "offline";
      return { confirmed: true };
    }

    this.state = "stopping";
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_stop_requested", this.logFields({
      reason,
    }, operationTraceId));

    let closeFailed = false;
    try {
      await activeClient.close(this.profile.stopGracePeriodMs);
    } catch {
      closeFailed = true;
      this.dependencies.logger.error(
        "bot_runtime_close_failed",
        this.logFields({}, operationTraceId),
      );
    }

    if (closeFailed && this.client === activeClient) {
      this.state = "error";
      this.emitHeartbeat();
      return { confirmed: false, errorCode: "CLIENT_CLOSE_FAILED" };
    }
    if (this.client === activeClient) {
      this.handleDisconnected(activeGeneration, {
        reason: "requested_stop",
        expected: true,
      });
    }
    this.dependencies.onStopped?.(reason);
    return { confirmed: true };
  }

  private async executeStopCommand(
    command: StopBotCommandV1,
  ): Promise<BotStopResultV1> {
    const expectedRuntimeInstanceId =
      command.payload.expectedRuntimeInstanceId;
    if (
      expectedRuntimeInstanceId !== null &&
      expectedRuntimeInstanceId !== this.runtimeInstanceId
    ) {
      return this.createStopResult(
        command,
        "rejected",
        "RUNTIME_INSTANCE_MISMATCH",
      );
    }

    const outcome = await this.stop(
      `coordinator_${command.payload.mode}_stop`,
      command.traceId,
    );
    return outcome.confirmed
      ? this.createStopResult(command, "completed")
      : this.createStopResult(command, "failed", outcome.errorCode);
  }

  private createStopResult(
    command: StopBotCommandV1,
    outcome: BotStopResultV1["payload"]["outcome"],
    errorCode?: string,
  ): BotStopResultV1 {
    const timestamp = this.now().toISOString();
    const result = botStopResultV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      traceId: command.traceId,
      timestamp,
      source: {
        service: "bot-runtime",
        instanceId: this.runtimeInstanceId,
      },
      botId: this.profile.botId,
      type: "bot.stop.result.v1",
      payload: {
        commandId: command.payload.commandId,
        runtimeInstanceId: this.runtimeInstanceId,
        outcome,
        completedAt: timestamp,
        ...(errorCode ? { errorCode } : {}),
      },
    });
    this.metrics.increment("bot_stop_results_total", {
      bot_id: this.profile.botId,
      outcome,
    });
    const log = outcome === "completed"
      ? this.dependencies.logger.info.bind(this.dependencies.logger)
      : this.dependencies.logger.warn.bind(this.dependencies.logger);
    log("bot_runtime_stop_result", this.logFields({
      commandId: command.payload.commandId,
      outcome,
      ...(errorCode ? { errorCode } : {}),
    }, command.traceId));
    return result;
  }

  private trimStopExecutions(): void {
    while (this.stopExecutions.size > 128) {
      const oldest = this.stopExecutions.keys().next().value as
        | string
        | undefined;
      if (!oldest) return;
      this.stopExecutions.delete(oldest);
    }
  }

  private trimSkillExecutions(): void {
    while (this.skillExecutions.size > 128) {
      const oldest = this.skillExecutions.keys().next().value as
        | string
        | undefined;
      if (!oldest) return;
      this.skillExecutions.delete(oldest);
    }
  }

  private connect(): void {
    this.generation += 1;
    const activeGeneration = this.generation;
    this.combatDriver?.reset();
    this.safetyController.reset();
    this.progressWatchdog.reset();
    this.watchdogRecovery = null;
    this.safetyStatus = {
      mode: "monitoring",
      activeRisks: [],
      normalTasksPaused: false,
      lastDecisionId: null,
      lastAction: null,
    };
    this.traceId = `connection-${this.randomId()}`;
    this.minecraftVersionCompatibility = null;
    this.skillCompatibilityEnvironment = null;
    this.skillCompatibilityCatalog = [];
    this.versionUnsupported = false;
    this.state = "connecting";
    this.metrics.increment("bot_connection_attempts_total", {
      bot_id: this.profile.botId,
    });
    this.startHeartbeatTimer();
    this.emitHeartbeat();
    this.dependencies.logger.info("bot_runtime_connecting", this.logFields({
      serverProfileId: this.profile.id,
      attempt: this.reconnectAttempts,
    }));

    try {
      const client = this.dependencies.createClient(this.profile, this.worldState);
      this.client = client;
      const pursuitAllowed = () => activeGeneration === this.generation && this.client === client &&
        this.state === "online" && this.safetyAllowsDefensiveCombat() &&
        this.combatDriver !== null && this.combatDriver.status().stance !== "retreating";
      client.setPursuitCombat?.({
        canContinue: pursuitAllowed,
        attack: async (targetId, signal) => {
          if (!pursuitAllowed() || signal.aborted) throw new Error("PURSUIT_CANCELLED");
          const receipt = await this.runCombatEngage(this.now().getTime(), client, signal, true, targetId);
          if (!pursuitAllowed() || signal.aborted || receipt.actual.disposition === "dropped") {
            throw new Error("PURSUIT_CANCELLED");
          }
        },
      });
      client.setPerfSpanWrap?.((category, fn) => this.perfSpans.spanSync(category, fn));
      client.setPerfRecorder?.((category, durationMs, detail) => this.perfSpans.record(category, durationMs, detail));
      client.setHandlers({
        onSpawn: () => { if (activeGeneration === this.generation) this.physicsCadence.reset(); this.handleSpawn(activeGeneration); },
        onPhysicsTick: () => { if (activeGeneration === this.generation) this.physicsCadence.record(this.monotonicNow()); },
        onStateChanged: () => this.requestStatus(activeGeneration),
        onDamaged: (info) => this.handleDamaged(activeGeneration, info),
        onDeath: (info) => this.handleDeath(activeGeneration, info),
        onChat: (info) => this.handleChat(activeGeneration, info),
        onDisconnected: (info) =>
          this.handleDisconnected(activeGeneration, info),
        onError: () => {
          this.dependencies.logger.warn(
            "bot_runtime_client_error",
            this.logFields(),
          );
        },
        onVersionUnsupported: () =>
          this.handleVersionUnsupported(activeGeneration),
      });
    } catch {
      this.handleDisconnected(activeGeneration, {
        reason: "runtime_error",
        expected: false,
        detail: "client_factory_failed",
      });
    }
  }

  private handleSpawn(generation: number): void {
    if (generation !== this.generation || this.stopping || !this.client) return;
    this.combatDriver?.reset();
    this.client.resetCombat?.();
    this.client.setCombatClock?.(() => this.now().getTime());
    // A probe report is connection-scoped. Install it only after the new
    // Mineflayer session has spawned; reset() deliberately clears the prior
    // session's clearance so reconnects cannot inherit a stale pass.
    this.combatDriver?.setReflexProbe(this.resolveCombatReflexProbe());
    try {
      const versionCompatibility = this.client.versionCompatibility();
      const compatibilityEnvironment =
        this.client.skillCompatibilityEnvironment();
      if (
        versionCompatibility.resolvedVersion !==
          compatibilityEnvironment.minecraftVersion ||
        versionCompatibility.protocolVersion !==
          compatibilityEnvironment.protocolVersion
      ) {
        throw new Error("Version and skill compatibility facts disagree.");
      }
      this.minecraftVersionCompatibility = versionCompatibility;
      this.skillCompatibilityEnvironment = compatibilityEnvironment;
      this.skillCompatibilityCatalog =
        this.skillRegistry.listCompatibility(compatibilityEnvironment);
    } catch {
      this.handleVersionUnsupported(generation);
      this.dependencies.logger.error(
        "bot_runtime_version_metadata_invalid",
        this.logFields(),
      );
      const incompatibleClient = this.client;
      void incompatibleClient
        .close(this.profile.stopGracePeriodMs)
        .catch(() => {
          this.dependencies.logger.error(
            "bot_runtime_incompatible_close_failed",
            this.logFields(),
          );
        });
      return;
    }
    this.state = "online";
    this.reconnectAttempts = 0;
    // 每条连接各自算一次：重连后同样要等服务端补上第一个 health 包。
    this.statusEmittedForConnection = false;
    this.emitVersion();
    this.emitSkillCatalog();
    this.startStatusTimer(generation);
    this.emitStatus(generation);
    this.emitHeartbeat();

    this.dependencies.logger.info("bot_runtime_online", this.logFields({
      serverProfileId: this.profile.id,
    }));
  }

  private handleVersionUnsupported(generation: number): void {
    if (generation !== this.generation || this.stopping) return;
    if (this.minecraftVersionCompatibility?.supportLevel === "unsupported") {
      return;
    }
    this.minecraftVersionCompatibility = unsupportedVersionCompatibility(
      this.profile.minecraftVersion,
    );
    this.skillCompatibilityEnvironment = null;
    this.skillCompatibilityCatalog = [];
    this.versionUnsupported = true;
    this.emitVersion();
    this.dependencies.logger.warn("bot_runtime_version_unsupported", this.logFields({
      supportedOldest:
        this.minecraftVersionCompatibility.supportedRange.oldest,
      supportedLatest:
        this.minecraftVersionCompatibility.supportedRange.latest,
    }));
  }

  private handleDisconnected(
    generation: number,
    info: BotDisconnectInfo,
  ): void {
    if (generation !== this.generation) return;
    this.cancelCombatReaction();
    this.client?.interruptNormalActions?.();
    if (this.cancelRunningCoordinatorTasks()) {
      this.emitStatus(generation, false);
    }
    this.cancelActiveSkills();
    this.combatDriver?.reset();
    this.client?.resetCombat?.();
    this.client = null;
    this.clearTimer("heartbeat");
    this.clearTimer("status");
    this.clearTimer("deferredStatus");
    this.state = "offline";
    this.emitDisconnected(info);
    this.metrics.increment("bot_disconnects_total", {
      bot_id: this.profile.botId,
      reason: info.reason,
    });

    const isModLoaderIncompatible =
      info.reason === "kicked" &&
      normalizeKickReason(info.detail) === "forge_or_modded_server";
    if (isModLoaderIncompatible) this.modLoaderIncompatible = true;
    const kickIncidentId = this.reportConnectionIncident(info);
    this.dependencies.logger.warn("bot_runtime_disconnected", this.logFields({
      reason: info.reason,
      expected: info.expected,
      ...(isModLoaderIncompatible
        ? { classification: "INCOMPATIBLE_MOD_LOADER" }
        : {}),
      // SERVER_KICK 结构化证据（canary 修正）：脱敏策略不再吞掉 kick 原因。
      ...(info.reason === "kicked"
        ? {
            kick_normalizedReason: normalizeKickReason(info.detail),
            kick_sanitizedRawReason: sanitizeServerText(info.detail),
            kick_phase: info.phase ?? "PRE_LOGIN",
            kick_serverProfileId: this.profile.id,
            kick_authMode: this.profile.auth,
            kick_requestedVersion: this.profile.minecraftVersion,
            kick_connectionHost: this.profile.connectHost ?? this.profile.host,
            kick_handshakeHost: this.profile.host,
            kick_incidentId: kickIncidentId ?? "not_reported",
          }
        : {}),
    }));
    this.eventBuffer.append({
      kind: "connection_event",
      source: "connection",
      detail: `disconnected reason=${info.reason} expected=${info.expected ? "yes" : "no"}`,
    });

    if (!this.stopping && !this.versionUnsupported && !this.modLoaderIncompatible) {
      this.scheduleReconnect();
    } else if (this.modLoaderIncompatible) {
      // 确定性不兼容：重连无意义。单 Incident 已上报；BLOCKED 等人工处置。
      this.dependencies.logger.warn("bot_runtime_reconnect_suppressed", this.logFields({
        code: "INCOMPATIBLE_MOD_LOADER",
        hint: "server requires Forge/FML client mods; switch Server Profile or use a compatible server",
      }));
    } else if (this.versionUnsupported) {
      this.dependencies.logger.warn("bot_runtime_reconnect_suppressed", this.logFields({
        code: "MINECRAFT_VERSION_UNSUPPORTED",
      }));
    }
  }

  /**
   * 连接类 Incident（kick / auth / network / version mismatch；expected 断开不上报）。
   * 2026-09-03 canary 修正：SERVER_KICK 不再因脱敏丢原因——incident 快照与
   * runtime 日志都保存结构化证据（normalizedReason/sanitizedRawReason/phase/
   * host 族/authMode），绝不含凭据。返回 reporterEventId 供日志关联。
   */
  private reportConnectionIncident(info: {
    reason: string;
    expected: boolean;
    detail?: string;
    phase?: "PRE_LOGIN" | "POST_LOGIN" | "POST_SPAWN";
  }): string | null {
    if (info.expected) return null; // requested_stop / server_shutdown 是正常断开
    let failureCode: string | null = null;
    let incidentType = "BOT_DISCONNECT";
    if (info.reason === "kicked") {
      failureCode = "SERVER_KICKED";
      incidentType = "SERVER_KICK";
    } else if (info.reason === "authentication_error") {
      failureCode = "SERVER_PLUGIN_AUTH_FAILED";
    } else if (info.reason === "network_error") {
      failureCode = "NETWORK_DISCONNECTED";
    } else if (info.reason === "runtime_error" && info.detail === "unsupported_minecraft_version") {
      failureCode = "SERVER_VERSION_MISMATCH";
    }
    if (!failureCode) return null; // unknown 等其它原因：等 reconnect 结果再定性
    const identity = loadRuntimeIdentity();
    const reporterEventId = "incident-" + this.randomId();
    const detailSuffix = info.detail ? ": " + String(info.detail).slice(0, 2000) : "";
    this.incidentReporter.report({
      eventWindow: this.eventBuffer.snapshot({ windowMs: 60_000 }).events as Array<{ at: string; kind: string; detail?: string }>,
      failureCode,
      incidentType,
      sourceComponent: "connection",
      severity: "ERROR",
      sessionId: this.runtimeInstanceId,
      runtimeInstanceId: this.runtimeInstanceId,
      serverProfileId: this.profile.id,
      reporterEventId,
      ...(identity.gitCommit ? { gitCommit: identity.gitCommit } : {}),
      ...(identity.branch ? { branch: identity.branch } : {}),
      ...(identity.buildVersion ? { buildVersion: identity.buildVersion } : {}),
      expected: "bot stays connected",
      actual: info.reason + detailSuffix,
      normalizedErrorSignature: info.reason,
      actionFamily: "connection",
      snapshots: info.reason === "kicked"
        ? {
            kick: {
              normalizedReason: normalizeKickReason(info.detail),
              sanitizedRawReason: sanitizeServerText(info.detail),
              phase: info.phase ?? "PRE_LOGIN",
              serverProfileId: this.profile.id,
              authMode: this.profile.auth,
              requestedVersion: this.profile.minecraftVersion,
              connectionHost: this.profile.connectHost ?? this.profile.host,
              handshakeHost: this.profile.host,
            },
          }
        : {},
    });
    return reporterEventId;
  }

  private scheduleReconnect(): void {
    const config = this.profile.reconnect;
    if (!config.enabled || this.reconnectAttempts >= config.maxAttempts) {
      this.dependencies.logger.warn("bot_runtime_reconnect_exhausted", this.logFields({
        attempts: this.reconnectAttempts,
      }));
      // 重连预算耗尽 = reconnect loop 终态 → Incident（expected 断开不进这里）
      if (config.enabled && !this.stopping) {
        const identity = loadRuntimeIdentity();
        this.incidentReporter.report({
          eventWindow: this.eventBuffer.snapshot({ windowMs: 60_000 }).events as Array<{ at: string; kind: string; detail?: string }>,
          failureCode: "SERVER_RECONNECT_LOOP",
          incidentType: "BOT_DISCONNECT",
          sourceComponent: "connection",
          severity: "ERROR",
          sessionId: this.runtimeInstanceId,
          runtimeInstanceId: this.runtimeInstanceId,
          serverProfileId: this.profile.id,
          ...(identity.gitCommit ? { gitCommit: identity.gitCommit } : {}),
          ...(identity.branch ? { branch: identity.branch } : {}),
          expected: "bot reconnects within bounded attempts",
          actual: `reconnect exhausted after ${this.reconnectAttempts} attempt(s)`,
          normalizedErrorSignature: "reconnect-exhausted",
          actionFamily: "connection",
          snapshots: {},
        });
      }
      return;
    }

    const delay = Math.min(
      config.maxDelayMs,
      config.baseDelayMs * 2 ** this.reconnectAttempts,
    );
    this.reconnectAttempts += 1;
    this.metrics.increment("bot_reconnects_scheduled_total", {
      bot_id: this.profile.botId,
    });
    this.dependencies.logger.info("bot_runtime_reconnect_scheduled", this.logFields({
      attempt: this.reconnectAttempts,
      delayMs: delay,
    }));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) this.connect();
    }, delay);
  }

  private requestStatus(generation: number): void {
    if (generation !== this.generation || this.state !== "online") return;
    try {
      if (this.client) {
        // Phase 3 子段：物理拍高频链的三步分别计时（测量面收口——90ms 级
        // 尖峰定位到具体步骤，Phase 4 才做归因/修复）。
        const abSkipWorldState = currentPerfAbMode() === "skip_worldstate";
        if (abSkipWorldState) {
          if (this.lastAbSnapshot !== null) {
            this.evaluateSafetySnapshot(generation, this.lastAbSnapshot);
          }
          return;
        }
        const snapshot = this.perfSpans.spanSync("tick.requestStatus.snapshot", () => this.client!.snapshot());
        this.perfSpans.spanSync("tick.requestStatus.safety", () => this.evaluateSafetySnapshot(generation, snapshot));
        this.maybeStartProactiveCombat(generation, snapshot);
        this.perfSpans.spanSync("tick.requestStatus.worldState", () => this.updateWorldState(snapshot));
        this.lastAbSnapshot = snapshot;
      }
    } catch (cause) {
      // A bare code cannot distinguish a field the server has not sent yet
      // from a real L0 boundary violation. The reason comes from our own
      // safety boundary, which names fields rather than values.
      this.dependencies.logger.error(
        "l0_safety_snapshot_invalid",
        this.logFields({
          code: "SAFETY_SNAPSHOT_INVALID",
          reason: statusFailureReason(cause),
        }),
      );
    }
    const elapsed = this.now().getTime() - this.lastStatusAt;
    if (elapsed >= this.profile.statusIntervalMs) {
      this.emitStatus(generation);
      return;
    }
    if (this.deferredStatusTimer) return;

    this.deferredStatusTimer = setTimeout(() => {
      this.deferredStatusTimer = null;
      this.emitStatus(generation);
    }, Math.max(0, this.profile.statusIntervalMs - elapsed));
  }

  private startHeartbeatTimer(): void {
    this.clearTimer("heartbeat");
    this.heartbeatTimer = setInterval(
      () => this.emitHeartbeat(),
      this.profile.heartbeatIntervalMs,
    );
  }

  private startStatusTimer(generation: number): void {
    this.clearTimer("status");
    this.statusTimer = setInterval(
      () => this.emitStatus(generation),
      this.profile.statusIntervalMs,
    );
  }

  private emitStatus(generation: number, evaluateSafety = true): void {
    if (generation !== this.generation || this.state !== "online" || !this.client) {
      return;
    }
    this.clearTimer("deferredStatus");

    // Phase 4 诊断门（no_telemetry）：跳过序列化+发送；安全评估在
    // requestStatus 链保留。仅本地归因窗口，禁止生产。
    if (currentPerfAbMode() === "no_telemetry") return;

    try {
      const snapshot = this.perfSpans.spanSync("telemetry.snapshot", () => this.client!.snapshot());
      if (evaluateSafety) this.evaluateSafetySnapshot(generation, snapshot);
      this.updateWorldState(snapshot);
      const sequence = this.nextSequence();
      const observedAt = this.now().toISOString();
      const message: BotStatusV1 = this.perfSpans.spanSync("telemetry.serialize", () => botStatusV1Schema.parse({
        ...this.envelope("bot.status.v1"),
        payload: {
          serverProfileId: this.profile.id,
          runtimeInstanceId: this.runtimeInstanceId,
          sequence,
          observedAt,
          connectionState: "online",
          health: snapshot.health,
          food: snapshot.food,
          armorPoints: snapshot.armorPoints,
          armorSlots: snapshot.armorSlots,
          inventory: snapshot.inventory,
          personalContext: {
            worldId: this.profile.worldId ?? null,
            worldSpawn: snapshot.personalContext?.worldSpawn ?? null,
            verifiedRespawn: snapshot.personalContext?.verifiedRespawn ?? null,
          },
          ...(this.lastDeath ? { lastDeath: this.lastDeath } : {}),
          position: snapshot.position,
          latencyMs: snapshot.latencyMs,
          performance: { physics: this.physicsCadence.snapshot(observedAt, this.monotonicNow()), eventLoop: this.loopDelaySample },
          currentTask: this.currentTaskTelemetry(),
          safety: this.safetyStatus,
          ...(this.combatDriver &&
          this.client?.combatObservation &&
          this.client?.executeCombatAction &&
          this.combatObservationAvailable()
            ? { combat: this.combatDriver.status() }
            : {}),
          ...(this.minecraftVersionCompatibility
            ? { minecraftVersion: this.minecraftVersionCompatibility }
            : {}),
        },
      }));
      this.lastStatusSequence = sequence;
      this.lastStatusAt = this.now().getTime();
      this.statusEmittedForConnection = true;
      this.perfSpans.spanSync("telemetry.send", () => {
        this.emit(message);
        this.emitWorldState(generation);
      });
    } catch (cause) {
      // Without the originating reason this event cannot distinguish a
      // transient pre-first-packet field from a real boundary violation or a
      // protocol schema regression. The message comes from our own schemas and
      // safety boundary, which name fields rather than values.
      //
      // 严重级按"这条连接发出过状态没有"分。实测每次启动都会有恰好一条：
      // handleSpawn 在 online 转换里立刻 emitStatus，而服务端的第一个 health
      // 包还没到，快照里 health 是 undefined，L0 边界拒绝（reason:
      // "health is outside the L0 safety boundary."）。把这个预期情形记成
      // error 会训练运维忽略 error 行，而真正的边界违规也长这样——所以降级的
      // 判据不能是"消息里含 health"，只能是"第一条还没发出去过"。已经发出过
      // 之后再坏，说明服务端已经在送状态了，那就是真问题，仍然 error。
      const reason = statusFailureReason(cause);
      const fields = this.logFields({
        reason,
        firstStatusPending: !this.statusEmittedForConnection,
      });
      if (this.statusEmittedForConnection) {
        this.dependencies.logger.error("bot_runtime_status_invalid", fields);
      } else {
        this.dependencies.logger.warn("bot_runtime_status_invalid", fields);
      }
    }
  }

  private emitWorldState(generation: number): void {
    if (generation !== this.generation || this.state !== "online") return;
    try {
      const snapshot = this.worldState.snapshot();
      const inventory = snapshot.inventory
        .filter(({ count }) => Number.isSafeInteger(count) && count > 0)
        .slice(0, BOT_WORLD_STATE_MAX_INVENTORY_ITEMS)
        .map(({ name, count, durability }) => ({ name, count, durability }));
      const nearbyUtilityBlocks = snapshot.nearbyBlocks
        .filter(
          (block) =>
            block.position.serverProfileId === this.profile.id &&
            botWorldStateUtilityBlockNameV1Schema.safeParse(block.name).success,
        )
        .slice(0, BOT_WORLD_STATE_MAX_UTILITY_BLOCKS)
        .map((block) => ({
          name: botWorldStateUtilityBlockNameV1Schema.parse(block.name),
          dimension: block.position.dimension,
          position: {
            x: block.position.x,
            y: block.position.y,
            z: block.position.z,
          },
          reachable: block.reachable,
          source: block.source,
          confidence: block.confidence,
          lastSeen: block.lastSeen,
        }));
      const target =
        snapshot.navigation.target?.serverProfileId === this.profile.id
          ? {
              x: snapshot.navigation.target.x,
              y: snapshot.navigation.target.y,
              z: snapshot.navigation.target.z,
              dimension: snapshot.navigation.target.dimension,
            }
          : null;
      const message: BotWorldStateV1 = botWorldStateV1Schema.parse({
        ...this.envelope("bot.world-state.v1"),
        payload: {
          serverProfileId: this.profile.id,
          runtimeInstanceId: this.runtimeInstanceId,
          sequence: this.nextSequence(),
          observedAt: snapshot.observedAt,
          worldStateVersion: snapshot.version,
          ...(snapshot.worldQuery ? { worldQuery: snapshot.worldQuery } : {}),
          inventory,
          nearbyUtilityBlocks,
          navigation: {
            owner: snapshot.navigation.movementOwner,
            target,
            version: snapshot.version,
          },
        },
      });
      this.emit(message);
    } catch {
      this.dependencies.logger.error(
        "bot_runtime_world_state_invalid",
        this.logFields({ code: "WORLD_STATE_TELEMETRY_INVALID" }),
      );
    }
  }

  private evaluateSafetySnapshot(
    generation: number,
    snapshot: BotClientSnapshot,
  ): void {
    if (generation !== this.generation || this.state !== "online") return;
    const normalTasksWerePaused = this.safetyStatus.normalTasksPaused;
    const decision = this.safetyController.evaluate({
      observedAtMs: this.now().getTime(),
      health: snapshot.health.current,
      foodLevel: snapshot.food.level,
      oxygenLevel: snapshot.safety.oxygenLevel,
      inWater: snapshot.safety.inWater,
      inLava: snapshot.safety.inLava,
      onGround: snapshot.safety.onGround,
      velocityY: snapshot.safety.velocityY,
      position: {
        x: snapshot.position.x,
        y: snapshot.position.y,
        z: snapshot.position.z,
      },
      inventory: snapshot.safety.inventory,
      hasSafeFood: snapshot.safety.hasSafeFood,
      movementRequested: snapshot.safety.movementRequested,
    });
    const emergencyStopping = decision.actions.some(
      ({ kind }) => kind === "EMERGENCY_STOP",
    );
    const defensiveCombatAllowed = decision.activeRisks.every(
      (risk) => risk === "LOW_HEALTH" || risk === "HUNGER",
    );
    this.safetyStatus = {
      mode: emergencyStopping
        ? "emergency_stopping"
        : decision.normalTasksPaused
          ? "paused"
          : decision.activeRisks.length > 0
            ? "intervening"
            : "monitoring",
      activeRisks: [...decision.activeRisks],
      normalTasksPaused: decision.normalTasksPaused,
      lastDecisionId: decision.decisionId ?? this.safetyStatus.lastDecisionId,
      lastAction: this.safetyStatus.lastAction,
    };
    if (decision.normalTasksPaused) {
      if (!defensiveCombatAllowed) this.cancelCombatReaction();
      if (!defensiveCombatAllowed) this.cancelActiveSkills();
      // A damage event is delivered before the matching health snapshot. If
      // that hit crosses the low-health threshold, handleDamaged has already
      // cancelled the ordinary task and started a defensive reaction. Do not
      // immediately stop that reaction again; low health is exactly when its
      // retreat decision matters most. Environmental/critical interventions
      // still own the client and cancel combat above.
      if (
        !defensiveCombatAllowed ||
        (!normalTasksWerePaused && this.combatReaction === null)
      ) {
        this.client?.interruptNormalActions?.();
        // L0 pause is not a new server session; retain the current connection's
        // probe report so combat can resume after safety clears.
        this.combatDriver?.reset(false);
        this.client?.resetCombat?.();
      }
    }

    if (decision.changed || decision.actions.length > 0) {
      this.metrics.increment("bot_safety_decisions_total", {
        bot_id: this.profile.botId,
        severity: decision.severity,
      });
      const log = decision.severity === "critical"
        ? this.dependencies.logger.warn.bind(this.dependencies.logger)
        : this.dependencies.logger.info.bind(this.dependencies.logger);
      log("l0_safety_decision", this.logFields({
        decisionId: decision.decisionId,
        severity: decision.severity,
        riskCodes: decision.activeRisks,
        normalTasksPaused: decision.normalTasksPaused,
        actionKinds: decision.actions.map(({ kind }) => kind),
      }));
    }
    if (decision.actions.length > 0 && decision.decisionId) {
      this.queueSafetyActions(generation, decision);
    }
  }

  private updateWorldState(snapshot: BotClientSnapshot): void {
    const observedAt = this.now();
    if (!Number.isFinite(observedAt.getTime())) return;
    const position = {
      ...snapshot.position,
      serverProfileId: this.profile.id,
    };
    let worldSnapshot: WorldStateSnapshot | null = null;
    try {
      const nowMsForProvider = this.now().getTime();
      const scopeKey = JSON.stringify([this.generation, this.profile.id, position.dimension, this.client?.worldStateSnapshotKey?.() ?? null]);
      if (
        this.worldSnapshotProvider.snapshot !== null &&
        this.worldSnapshotProvider.scopeKey === scopeKey &&
        nowMsForProvider >= this.worldSnapshotProvider.capturedAtMs &&
        nowMsForProvider - this.worldSnapshotProvider.capturedAtMs < SingleBotRuntime.WORLD_SNAPSHOT_TTL_MS
      ) {
        worldSnapshot = this.worldSnapshotProvider.snapshot as NonNullable<typeof worldSnapshot>;
      } else {
        worldSnapshot = this.perfSpans.spanSync("world.snapshot.build", () => this.client?.worldStateSnapshot?.() ?? null);
        if (worldSnapshot !== null) {
          this.worldSnapshotProvider = {
            snapshot: worldSnapshot,
            generation: this.worldSnapshotProvider.generation + 1,
            capturedAtMs: nowMsForProvider,
            scopeKey,
          };
        }
      }
    } catch {
      worldSnapshot = null;
    }
    if (worldSnapshot !== null) {
      this.perfSpans.spanSync("world.state.observe", () => this.worldState.observe({
        observedAt,
        position: worldSnapshot.position,
        inventory: worldSnapshot.inventory,
        nearbyBlocks: worldSnapshot.nearbyBlocks,
        replaceNearbyBlocks: true,
        entities: worldSnapshot.entities,
        navigation: worldSnapshot.navigation,
        worldQuery: worldSnapshot.worldQuery ?? null,
      }));
      const inventoryFingerprint = worldSnapshot.inventory
        .map((item) => `${item.name}:${item.count}:${item.durability ?? ""}`)
        .join("|");
      const activeRuntimeTask = [...this.activeSkillTasks.values()][0];
      // Phase 3：typed progressContract——技能声明的契约优先于 title 子串推断
      const declaredContract = activeRuntimeTask
        ? this.skillRegistry.resolve(activeRuntimeTask.title, "1.0.0")?.progressContract
        : undefined;
      const events = this.progressWatchdog.observe({
        observedAtMs: observedAt.getTime(),
        monotonicMs: this.monotonicNow(),
        position,
        contract: progressContractForAction(
          activeRuntimeTask?.title,
          worldSnapshot.navigation.movementOwner,
          declaredContract,
        ),
        inventoryFingerprint,
        targetDistance: worldSnapshot.navigation.target
          ? Math.hypot(
              worldSnapshot.navigation.target.x - position.x,
              worldSnapshot.navigation.target.y - position.y,
              worldSnapshot.navigation.target.z - position.z,
            )
          : null,
        goalKey: worldSnapshot.navigation.target
          ? `${worldSnapshot.navigation.target.dimension}:${worldSnapshot.navigation.target.x},${worldSnapshot.navigation.target.y},${worldSnapshot.navigation.target.z}`
          : null,
        pathResetCount: worldSnapshot.navigation.pathResetCount,
        active:
          this.activeSkillTasks.size > 0 &&
          worldSnapshot.navigation.movementOwner !== null,
        movementExpected:
          this.activeSkillTasks.size > 0 &&
          worldSnapshot.navigation.movementOwner !== null,
      });
      this.bufferRuntimeSignals(worldSnapshot, position, events);
      for (const event of events) {
        if (event.kind === "stuck" || event.kind === "no-progress" || event.kind === "oscillation" || event.kind === "loop" || event.kind === "deadline-exceeded") {
          // 非阻塞 Incident 上报（有界队列；失败只计数，绝不打断恢复流程）
          const activeTask = [...this.activeSkillTasks.values()][0];
          const telemetryTask = this.currentTaskTelemetry();
          const identity = loadRuntimeIdentity();
          let versionInfo: { minecraftVersion?: string | undefined; protocolVersion?: number | undefined } = {};
          try {
            const compatibility = this.client?.versionCompatibility();
            if (compatibility) {
              versionInfo = {
                minecraftVersion: compatibility.resolvedVersion ?? undefined,
                protocolVersion: compatibility.protocolVersion ?? undefined,
              };
            }
          } catch {
            // 版本协商完成前未知 → 缺省，不伪造
          }
          this.incidentReporter.report(watchdogEventToSignal({
            event,
            position,
            dimension: worldSnapshot.navigation.target?.dimension ?? null,
            replanCount: worldSnapshot.navigation.pathResetCount,
            skillId: activeTask?.title,
            taskId: telemetryTask?.taskId,
            goal: telemetryTask?.title,
            sessionId: this.runtimeInstanceId,
            runtimeInstanceId: this.runtimeInstanceId,
            serverProfileId: this.profile.id,
            gitCommit: identity.gitCommit ?? undefined,
            branch: identity.branch ?? undefined,
            buildVersion: identity.buildVersion ?? undefined,
            dirtyBuild: identity.dirtyBuild ?? undefined,
            ...versionInfo,
            eventWindow: this.eventBuffer.snapshot({ windowMs: 60_000 }).events as Array<{ at: string; kind: string; detail?: string }>,
            expectedProgress: worldSnapshot.navigation.target
              ? `target distance decreasing toward ${worldSnapshot.navigation.target.x},${worldSnapshot.navigation.target.z} (dimension ${worldSnapshot.navigation.target.dimension})`
              : undefined,
            actualProgress: `${event.kind} after ${event.ageMs}ms without material progress; pathResets=${worldSnapshot.navigation.pathResetCount}`,
          }));
        }
        if (event.kind === "stuck") {
          this.metrics.increment("bot_watchdog_stuck_total", { bot_id: this.profile.botId });
          this.dependencies.logger.warn("bot_progress_stuck", this.logFields({ ageMs: event.ageMs, recovery: event.recoverySuggested }));
          this.queueWatchdogRecovery(event);
        } else if (event.kind === "loop") {
          this.metrics.increment("bot_watchdog_loops_total", { bot_id: this.profile.botId });
          this.dependencies.logger.warn("bot_progress_loop", this.logFields({ ageMs: event.ageMs, recovery: event.recoverySuggested }));
          this.queueWatchdogRecovery(event);
        } else if (event.kind === "no-progress") {
          this.dependencies.logger.warn("bot_progress_no_progress", this.logFields({ ageMs: event.ageMs, recovery: event.recoverySuggested }));
          this.queueWatchdogRecovery(event);
        }
      }
      return;
    }
    this.worldState.observe({ observedAt, position });
    this.progressWatchdog.observe({
      observedAtMs: observedAt.getTime(),
      position,
      inventoryFingerprint: `${snapshot.safety.inventory.usedSlots}/${snapshot.safety.inventory.totalSlots}`,
      active:
        this.activeSkillTasks.size > 0 && snapshot.safety.movementRequested,
      movementExpected:
        this.activeSkillTasks.size > 0 && snapshot.safety.movementRequested,
    });
  }

  /**
   * P0-3：把 per-tick 观察折叠进有界事件缓冲（Incident eventWindow 数据源）。
   * - movement_owner 从无到有 → movement_started（仅在技能活跃时）
   * - pathResetCount 递增 → path_recalculated
   * - 目标距离较上次记录改善 ≥1.0 → material_progress（coalesce 吸收高频）
   * - watchdog 事件按语义入 buffer（warning/trigger 分类）
   * 不记录每 tick 全量位置（仅距离数值进 detail，有界 redact）。
   */
  private bufferRuntimeSignals(
    worldSnapshot: WorldStateSnapshot,
    position: { x: number; y: number; z: number },
    events: ReadonlyArray<{ kind: string }>,
  ): void {
    const activeTaskEntry = [...this.activeSkillTasks.values()][0];
    const targetKey = worldSnapshot.navigation.target
      ? `${worldSnapshot.navigation.target.x},${worldSnapshot.navigation.target.z}`
      : "no-target";
    const correlation = `${activeTaskEntry?.title ?? "no-skill"}@${targetKey}`;
    const active = this.activeSkillTasks.size > 0;
    const owner = worldSnapshot.navigation.movementOwner;
    if (active && owner !== null && this.lastBufferedMovementOwner === null) {
      this.eventBuffer.append({
        kind: "movement_started",
        source: "navigation",
        correlationId: correlation,
        detail: `owner=${owner} at ${Math.floor(position.x)},${Math.floor(position.y)},${Math.floor(position.z)}`,
      });
    }
    this.lastBufferedMovementOwner = active ? owner : null;
    if (worldSnapshot.navigation.pathResetCount > this.lastBufferedPathResets) {
      this.eventBuffer.append({
        kind: "path_recalculated",
        source: "navigation",
        correlationId: correlation,
        detail: `pathResets=${worldSnapshot.navigation.pathResetCount}`,
      });
    }
    this.lastBufferedPathResets = worldSnapshot.navigation.pathResetCount;
    const target = worldSnapshot.navigation.target;
    if (target !== null) {
      const distance = Math.hypot(target.x - position.x, target.y - position.y, target.z - position.z);
      if (this.lastBufferedDistance === null || distance <= this.lastBufferedDistance - 1.0) {
        this.eventBuffer.append({
          kind: "material_progress",
          source: "navigation",
          correlationId: correlation,
          detail: `dist=${distance.toFixed(1)}`,
        });
        this.lastBufferedDistance = distance;
      } else if (this.lastBufferedDistance !== null && distance > this.lastBufferedDistance) {
        this.lastBufferedDistance = distance;
      }
    } else {
      this.lastBufferedDistance = null;
    }
    for (const event of events) {
      if (event.kind === "progress") continue;
      this.eventBuffer.append({
        kind:
          event.kind === "no-progress" ? "no_progress_warning"
          : event.kind === "oscillation" ? "oscillation_detected"
          : event.kind === "loop" ? "replan_storm"
          : event.kind === "deadline-exceeded" ? "deadline_exceeded"
          : "watchdog_triggered",
        source: "watchdog",
        correlationId: correlation,
      });
    }
  }

  private queueWatchdogRecovery(event: ProgressWatchdogEvent): void {
    if (this.watchdogRecovery !== null || event.kind === "progress") return;
    const client = this.client;
    const task = this.currentTaskTelemetry();
    if (
      client === null ||
      client.executeRecoveryAction === undefined ||
      task === null ||
      this.state !== "online"
    ) {
      return;
    }
    const generation = this.generation;
    const action: BotRecoveryAction = {
      kind: event.kind === "stuck" ? "local-unstick" : "local-replan",
      trigger: event.kind,
      taskId: task.taskId,
      goalKey: event.goalKey,
      durationMs: event.kind === "stuck" ? 600 : 350,
    };
    this.eventBuffer.append({
      kind: "recover_started",
      source: "watchdog",
      correlationId: event.goalKey ?? undefined,
      detail: `action=${action.kind} trigger=${action.trigger}`,
    });
    const pending = Promise.resolve()
      .then(() => client.executeRecoveryAction!(action))
      .then((result) => {
        if (
          generation !== this.generation ||
          this.client !== client ||
          this.state !== "online"
        ) {
          return;
        }
        this.eventBuffer.append({
          kind: "recover_result",
          source: "watchdog",
          correlationId: event.goalKey ?? undefined,
          detail: `outcome=${result.outcome} action=${action.kind}`,
        });
        if (result.outcome === "executed") {
          this.progressWatchdog.reset();
          this.metrics.increment("bot_watchdog_recoveries_total", {
            action: action.kind,
            bot_id: this.profile.botId,
          });
          this.metrics.increment("bot_movement_preemptions_total", {
            bot_id: this.profile.botId,
            preemptor: "watchdog-recovery",
          });
        }
        const log = result.outcome === "executed"
          ? this.dependencies.logger.info.bind(this.dependencies.logger)
          : this.dependencies.logger.warn.bind(this.dependencies.logger);
        log("bot_watchdog_recovery_result", this.logFields({
          action: action.kind,
          trigger: action.trigger,
          outcome: result.outcome,
          errorCode: result.errorCode,
        }, undefined, task.taskId));
      })
      .catch(() => {
        if (generation !== this.generation || this.client !== client) return;
        this.dependencies.logger.error(
          "bot_watchdog_recovery_failed",
          this.logFields({ action: action.kind, trigger: action.trigger }, undefined, task.taskId),
        );
      })
      .finally(() => {
        if (this.watchdogRecovery === pending) this.watchdogRecovery = null;
      });
    this.watchdogRecovery = pending;
  }

  private queueSafetyActions(
    generation: number,
    decision: L0SafetyDecision,
  ): void {
    const expectedClient = this.client;
    this.safetyActionQueue = this.safetyActionQueue
      .then(async () => {
        for (const action of decision.actions) {
          if (
            generation !== this.generation ||
            !expectedClient ||
            this.client !== expectedClient ||
            this.state !== "online"
          ) {
            return;
          }
          let result: L0SafetyActionResult;
          if (action.kind === "EMERGENCY_STOP") {
            // 断线保号保险丝（STUDIO_L0_EMERGENCY_STOP=0 关闭）：本地测试/
            // 死亡代价可控的场景里，"危急血量+血量在降→断线"会反复打停 bot
            // （卡方块窒息、地形伤等非战斗源），关掉后由受击反应/撤退/吃食物
            // 这些就地反射接手。生产 anarchy 语义（死亡=掉全部）默认保持开启。
            if (process.env.STUDIO_L0_EMERGENCY_STOP === "0") {
              this.dependencies.logger.warn(
                "l0_emergency_stop_suppressed",
                this.logFields({
                  code: "EMERGENCY_STOP_DISABLED_BY_ENV",
                  risk: action.risk,
                }),
              );
              continue;
            }
            const stopOutcome = await this.stop(
              "l0_emergency_stop",
              this.traceId,
            );
            result = stopOutcome.confirmed
              ? { outcome: "executed", errorCode: null }
              : { outcome: "failed", errorCode: stopOutcome.errorCode };
          } else {
            result = await expectedClient.executeSafetyAction(action);
          }
          this.recordSafetyAction(decision, action, result);
          if (action.kind === "EMERGENCY_STOP") return;
        }
        if (this.state === "online" && this.client === expectedClient) {
          this.emitStatus(generation);
        }
      })
      .catch(() => {
        this.dependencies.logger.error(
          "l0_safety_execution_failed",
          this.logFields({
            decisionId: decision.decisionId,
            code: "SAFETY_EXECUTION_FAILED",
          }),
        );
      });
  }

  private recordSafetyAction(
    decision: L0SafetyDecision,
    action: L0SafetyAction,
    result: L0SafetyActionResult,
  ): void {
    const completedAt = this.now().toISOString();
    this.safetyStatus = {
      ...this.safetyStatus,
      lastAction: {
        kind: action.kind,
        outcome: result.outcome,
        completedAt,
        errorCode: result.errorCode,
      },
    };
    this.metrics.increment("bot_safety_actions_total", {
      action: action.kind,
      bot_id: this.profile.botId,
      outcome: result.outcome,
    });
    if (result.outcome === "failed") {
      this.metrics.increment("bot_safety_failures_total", {
        action: action.kind,
        bot_id: this.profile.botId,
      });
    }
    const log = result.outcome === "executed"
      ? this.dependencies.logger.info.bind(this.dependencies.logger)
      : this.dependencies.logger.warn.bind(this.dependencies.logger);
    log("l0_safety_action_result", this.logFields({
      decisionId: decision.decisionId,
      riskCode: action.risk,
      actionKind: action.kind,
      outcome: result.outcome,
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    }));
  }

  private emitVersion(): void {
    if (!this.minecraftVersionCompatibility) return;
    const message: BotVersionV1 = botVersionV1Schema.parse({
      ...this.envelope("bot.version.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt: this.now().toISOString(),
        compatibility: this.minecraftVersionCompatibility,
      },
    });
    this.emit(message);
  }

  private emitSkillCatalog(): void {
    const environment = this.skillCompatibilityEnvironment;
    if (!environment) return;
    const message: BotSkillCatalogV1 = botSkillCatalogV1Schema.parse({
      ...this.envelope("bot.skill-catalog.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt: this.now().toISOString(),
        minecraftVersion: environment.minecraftVersion,
        protocolVersion: environment.protocolVersion,
        skills: this.skillCompatibilityCatalog.map((resolution) =>
          skillCatalogEntry(resolution, this.skillRegistry),
        ),
      },
    });
    this.emit(message);
  }

  private emitHeartbeat(): void {
    const observedAt = this.now().toISOString();
    const message: BotHeartbeatV1 = botHeartbeatV1Schema.parse({
      ...this.envelope("bot.heartbeat.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt,
        connectionState: this.state,
        uptimeMs: Math.max(0, Math.round(process.uptime() * 1000)),
        lastStatusSequence: this.lastStatusSequence,
        currentTaskId: this.currentTaskTelemetry()?.taskId ?? null,
      },
    });
    this.metrics.increment("bot_heartbeats_total", {
      bot_id: this.profile.botId,
    });
    this.emit(message);
  }

  private emitDisconnected(info: BotDisconnectInfo): void {
    const message: BotDisconnectedV1 = botDisconnectedV1Schema.parse({
      ...this.envelope("bot.disconnected.v1"),
      payload: {
        serverProfileId: this.profile.id,
        runtimeInstanceId: this.runtimeInstanceId,
        sequence: this.nextSequence(),
        observedAt: this.now().toISOString(),
        reason: info.reason,
        expected: info.expected,
        lastStatusSequence: this.lastStatusSequence,
        ...(info.detail ? { detail: info.detail.slice(0, 500) } : {}),
      },
    });
    this.emit(message);
  }

  private envelope(type: string) {
    return {
      schemaVersion: "1.0" as const,
      messageId: this.randomId(),
      traceId: this.traceId,
      timestamp: this.now().toISOString(),
      source: {
        service: "bot-runtime" as const,
        instanceId: this.runtimeInstanceId,
      },
      botId: this.profile.botId,
      type,
    };
  }

  private emit(message: Parameters<BotMessageSink>[0]): void {
    const validated = parseBotTelemetryMessage(message);
    void Promise.resolve(this.dependencies.messageSink(validated)).catch(() => {
      this.dependencies.logger.error("bot_runtime_message_sink_failed", this.logFields({
        messageType: validated.type,
      }, validated.traceId));
    });
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private logFields(
    fields: Readonly<Record<string, unknown>> = {},
    traceId = this.traceId,
    taskId: string | null = null,
    skillId: string | null = null,
  ): Readonly<Record<string, unknown>> {
    return {
      traceId,
      taskId,
      botId: this.profile.botId,
      skillId,
      modelName: null,
      ...fields,
    };
  }

  private skillState() {
    let position: (BotClientSnapshot["position"] & {
      serverProfileId: string;
    }) | null = null;
    // 背包占用与 position 同源同帧：分两次读会让"够不着"和"装不下"基于两个
    // 不同时刻的世界状态，前置条件就不再是一致快照的纯判断了。
    let inventory: BotClientSnapshot["safety"]["inventory"] | null = null;
    // Mining skills need an explicit safety fact. Unknown state stays unsafe;
    // only a live client snapshot can clear the flags for this invocation.
    let safety = {
      lavaAdjacent: true,
      waterAdjacent: true,
      voidRisk: true,
    };
    if (this.state === "online" && this.client) {
      try {
        const snapshot = this.client.snapshot();
        position = {
          ...snapshot.position,
          serverProfileId: this.profile.id,
        };
        inventory = snapshot.safety.inventory;
        safety = {
          // Mineflayer exposes current liquid contact at this boundary. The
          // execution adapter still re-checks each target before digging.
          lavaAdjacent: snapshot.safety.inLava,
          waterAdjacent: snapshot.safety.inWater,
          voidRisk: snapshot.position.y <= -58,
        };
      } catch {
        position = null;
        inventory = null;
      }
    }
    const policy = this.serverPolicyStore.resolve(this.profile.id);
    return {
      online: this.state === "online",
      normalActionsAllowed: this.canAcceptNormalActions(),
      serverProfileId: this.profile.id,
      isolatedTestServer: this.profile.purpose === "isolated-test",
      policyLimits: {
        allowSprint: policy.limits.allowSprint,
        allowSprintJumpCombo: policy.limits.allowSprintJumpCombo,
        allowAirStrafe: policy.limits.allowAirStrafe,
        maxFallBlocks: policy.limits.maxFallBlocks,
      },
      safety,
      combatAvailable:
        this.combatDriver !== null &&
        this.client?.combatObservation !== undefined &&
        this.client?.executeCombatAction !== undefined,
      combatObservationAvailable: this.combatObservationAvailable(),
      retreatInProgress: this.combatDriver?.status().stance === "retreating",
      position,
      inventory,
    };
  }

  private currentTaskTelemetry(): RuntimeCurrentTask | null {
    const tasks = [...this.activeSkillTasks.values()];
    if (tasks.length > 0) {
      if (this.currentTask?.status !== "running") {
        const terminalTaskIsStillActive = tasks.some(
          ({ taskId }) => taskId === this.currentTask?.taskId,
        );
        if (terminalTaskIsStillActive) return this.currentTask;
      } else {
        return this.currentTask;
      }
      const task = tasks.find(({ title }) => title === "goal.ensure-item") ?? tasks[0]!;
      return {
        taskId: task.taskId,
        title: task.title,
        status: "running",
        startedAt: task.startedAt,
      };
    }
    return this.currentTask;
  }

  private combatObservationAvailable(): boolean {
    if (
      this.combatDriver === null ||
      this.state !== "online" ||
      !this.client?.combatObservation
    ) {
      return false;
    }
    try {
      const observation = this.client.combatObservation(this.now().getTime());
      return observation !== null &&
        this.combatDriver.observationAvailable(observation);
    } catch {
      return false;
    }
  }

  private async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const activeClient = this.client;
    const combatIntent = combatIntentForRequest(request);
    const isCombatDisengage =
      combatIntent === "DISENGAGE" && request.skillId === "combat.disengage";
    const combatPairValid =
      combatIntent === null ||
      (combatIntent === "ENGAGE" && request.skillId === "combat.engage") ||
      (combatIntent === "DISENGAGE" && request.skillId === "combat.disengage");
    if (!combatPairValid) {
      this.auditCombatAction(
        request,
        syntheticCombatReceipt(
          combatIntent ?? "ENGAGE",
          this.now().getTime(),
          "SKILL_CAPABILITY_DENIED",
        ),
      );
      throw new SkillFault("SKILL_CAPABILITY_DENIED");
    }
    if (
      !activeClient ||
      this.state !== "online" ||
      (this.safetyStatus.normalTasksPaused && !isCombatDisengage)
    ) {
      if (combatIntent !== null) {
        this.auditCombatAction(
          request,
          syntheticCombatReceipt(
            combatIntent,
            this.now().getTime(),
            "NORMAL_ACTIONS_PAUSED",
          ),
        );
      }
      throw new SkillFault("NORMAL_ACTIONS_PAUSED");
    }
    if (
      request.capability === "combat.control" &&
      (request.operation === "combat.engage" ||
        request.operation === "combat.disengage")
    ) {
      return this.invokeCombatControl(request, activeClient, isCombatDisengage);
    }
    if (
      request.capability === "combat.control" &&
      request.operation === "combat.stance-set"
    ) {
      // 立场切换是驱动内参数变更，不经过实体客户端；没有战斗驱动时如实拒绝。
      if (!this.combatDriver) {
        throw new SkillFault("COMBAT_DRIVER_UNAVAILABLE");
      }
      const input = combatStanceCapabilityInputSchema.safeParse(request.input);
      if (!input.success) {
        throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
      }
      const before = this.combatDriver.survivalStance();
      const after = this.combatDriver.setStance(input.data.stance);
      this.dependencies.logger.info("bot_runtime_combat_stance_set", this.logFields({
        from: before,
        to: after,
      }));
      return combatStanceCapabilityOutputSchema.parse({
        stance: after,
        changed: after !== before,
      });
    }
    if (!activeClient.invokeSkillCapability) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    const output = await activeClient.invokeSkillCapability(request);
    if (
      this.client !== activeClient ||
      this.state !== "online" ||
      (this.safetyStatus.normalTasksPaused && !isCombatDisengage)
    ) {
      throw new SkillFault("SKILL_EXECUTION_INTERRUPTED");
    }
    if (
      request.capability === "inventory.read" &&
      request.operation === "inventory.snapshot"
    ) {
      const parsed = inventorySnapshotCapabilityOutputSchema.safeParse(output);
      if (
        !parsed.success ||
        parsed.data.worldStateVersion !== this.worldState.snapshot().version
      ) {
        throw new SkillFault("SKILL_CAPABILITY_OUTPUT_INVALID");
      }
      this.emitWorldState(this.generation);
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "craft.item-safe"
    ) {
      const parsed = craftItemCapabilityOutputSchema.safeParse(output);
      if (parsed.success && parsed.data.craftedCount === 0) {
        this.metrics.increment("bot_duplicate_crafting_prevented_total", {
          bot_id: this.profile.botId,
          guard: "inventory-short-circuit",
        });
      }
    }
    return output;
  }

  private async invokeCombatControl(
    request: SkillCapabilityRequest,
    activeClient: BotClient,
    isDisengage: boolean,
  ): Promise<unknown> {
    const requestedAtMs = this.now().getTime();
    let audited = false;
    try {
      if (
        !this.combatDriver ||
        !activeClient.executeCombatAction ||
        !activeClient.combatObservation
      ) {
        throw new SkillFault("COMBAT_DRIVER_UNAVAILABLE");
      }
      const input = combatControlInputSchema.safeParse(request.input);
      if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
      if (input.data.serverProfileId !== this.profile.id) {
        throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
      }
      const receipt = isDisengage
        ? await this.combatDriver.disengage(
            requestedAtMs,
            (action, signal) => activeClient.executeCombatAction!(action, signal),
            request.signal,
          )
        : await this.runCombatEngage(
            requestedAtMs,
            activeClient,
            request.signal,
          );
      const sessionStillActive =
        this.client === activeClient &&
        this.state === "online" &&
        (!this.safetyStatus.normalTasksPaused || isDisengage);
      const finalReceipt = sessionStillActive
        ? receipt
        : {
            requested: receipt.requested,
            actual: {
              disposition: "dropped" as const,
              action: "NONE" as const,
              primitiveAction: "NONE" as const,
              executedAtMs: null,
              reasonCode: "SKILL_EXECUTION_INTERRUPTED",
              targetEntityId: receipt.actual.targetEntityId,
            },
          };
      this.auditCombatAction(request, finalReceipt);
      audited = true;
      return {
        requested: finalReceipt.requested,
        actual: {
          disposition: finalReceipt.actual.disposition,
          action: finalReceipt.actual.action,
          executedAtMs: finalReceipt.actual.executedAtMs,
          reasonCode: finalReceipt.actual.reasonCode,
          targetEntityId: finalReceipt.actual.targetEntityId,
        },
      };
    } catch (error) {
      if (!audited) {
        this.auditCombatAction(
          request,
          syntheticCombatReceipt(
            isDisengage ? "DISENGAGE" : "ENGAGE",
            requestedAtMs,
            error instanceof SkillFault ? error.code : "SKILL_CAPABILITY_FAILED",
          ),
        );
      }
      throw error;
    }
  }

  private async runCombatEngage(
    requestedAtMs: number,
    activeClient: BotClient,
    signal: AbortSignal,
    retaliation = false,
    pursuitTargetId?: number,
  ): Promise<CombatDriverReceipt> {
    let observation: ReturnType<NonNullable<BotClient["combatObservation"]>>;
    try {
      observation = activeClient.combatObservation!(requestedAtMs);
    } catch {
      this.combatDriver?.recordUnavailable(
        "COMBAT_OBSERVATION_UNAVAILABLE",
        requestedAtMs,
      );
      return syntheticCombatReceipt(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_OBSERVATION_UNAVAILABLE",
      );
    }
    if (!observation || !this.combatDriver?.observationAvailable(observation)) {
      this.combatDriver?.recordUnavailable(
        "COMBAT_OBSERVATION_UNAVAILABLE",
        requestedAtMs,
      );
      return syntheticCombatReceipt(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_OBSERVATION_UNAVAILABLE",
      );
    }
    const execute = (action: CombatPrimitiveAction, actionSignal: AbortSignal) => {
      if (pursuitTargetId !== undefined && "targetEntityId" in action && action.targetEntityId !== pursuitTargetId) {
        return Promise.resolve({ outcome: "failed" as const, reasonCode: "COMBAT_TARGET_CHANGED" });
      }
      const probeTaskId = this.combatReaction?.taskId ?? "combat-control";
      const decisionAtMs = this.now().getTime();
      this.combatReflexProbeSource?.recordDecision?.(probeTaskId, decisionAtMs);
      this.combatReflexProbeSource?.recordPacketDispatch?.(probeTaskId, decisionAtMs);
      return activeClient.executeCombatAction!(action, actionSignal).then((ack) => {
        this.combatReflexProbeSource?.recordServerConfirmation?.(probeTaskId, this.now().getTime());
        return ack;
      });
    };
    return retaliation
      ? this.combatDriver!.retaliate(
          observation,
          requestedAtMs,
          execute,
          signal,
        )
      : this.combatDriver!.engage(
          observation,
          requestedAtMs,
          execute,
          signal,
        );
  }

  /**
   * 死亡 ≠ 断线：连接还在，但一切进行中的工作都建立在已失效的世界状态
   * 上。取消全部活动技能（采集/移动/熔炼对着空背包与旧坐标继续跑只会
   * 产生噪声）、重置 L0 状态机，然后把死亡事实留痕。重生由 client 写
   * client_command 触发，spawn 事件走既有路径重建状态；自主生存的重建
   * 由 director 的需求评估基于（清空的）真实背包自动完成——不需要任何
   * 特判分支。
   */
  /**
   * 游戏内聊天指挥通道：只有战斗白名单里的玩家（运维自己/盟友）的话才
   * 上报协调器进 Spark。陌生人的话永远进不了模型——既省请求也防注入。
   */
  private handleChat(
    generation: number,
    info: import("./client.js").BotChatMessage,
  ): void {
    if (generation !== this.generation || this.stopping || !this.client) return;
    const policy = this.profile.chatTrust;
    const dimension = this.client.snapshot().position?.dimension;
    if (!policy || !info.protocolIdentity || !dimension || policy.authMode !== this.profile.auth) return;
    const identity: ChatIdentityEvidence = {
      ...info.protocolIdentity, schemaVersion: "1.0", source: "protocol-player-chat",
      authMode: this.profile.auth, worldId: this.profile.worldId ?? null, dimension,
      policyRevision: policy.revision,
    };
    const whitelist = this.profile.combat?.whitelist;
    const combatAllowed = whitelist && (whitelist.uuids.length > 0
      ? whitelist.uuids.some((id) => id.replaceAll("-", "").toLowerCase() === identity.senderUuid.replaceAll("-", "").toLowerCase())
      : whitelist.usernames.some((name) => name.toLowerCase() === info.speaker.toLowerCase()));
    const allowed = !!combatAllowed && verifyChatIdentity({ serverProfileId: this.profile.id,
      speaker: info.speaker, evidence: identity, policy });
    if (!allowed) {
      this.dependencies.logger.info("bot_runtime_chat_ignored", this.logFields({
        reason: "speaker_not_whitelisted",
      }));
      return;
    }
    const message = this.emitChatReceived(info.speaker, info.message, identity);
    if (message) {
      this.dependencies.messageSink(message);
    }
  }

  private emitChatReceived(speaker: string, message: string, identity: ChatIdentityEvidence) {
    try {
      return {
        schemaVersion: "1.0" as const,
        messageId: this.randomId(),
        traceId: this.traceId,
        timestamp: this.now().toISOString(),
        source: { service: "bot-runtime" as const, instanceId: this.runtimeInstanceId },
        botId: this.profile.botId,
        type: "bot.chat-received.v1" as const,
        payload: {
          serverProfileId: this.profile.id,
          runtimeInstanceId: this.runtimeInstanceId,
          speaker: speaker.slice(0, 32),
          message: message.slice(0, 512),
          identity,
        },
      };
    } catch {
      return null;
    }
  }

  private handleDeath(
    generation: number,
    info: Readonly<{
      position: Readonly<{ x: number; y: number; z: number }> | null;
      dimension: string | null;
      droppedItems?: ReadonlyArray<Readonly<{ itemId: string; count: number }>>;
      xpPoints?: number;
    }>,
  ): void {
    if (generation !== this.generation || this.stopping) return;
    if (info.position && info.dimension) {
      this.lastDeath = {
        x: Math.floor(info.position.x),
        y: Math.floor(info.position.y),
        z: Math.floor(info.position.z),
        dimension: info.dimension,
        diedAt: this.now().toISOString(),
        ...(info.droppedItems !== undefined && info.droppedItems.length > 0
          ? { droppedItems: info.droppedItems }
          : {}),
        ...(info.xpPoints !== undefined ? { xpPoints: info.xpPoints } : {}),
      };
    }
    this.cancelActiveSkills();
    this.cancelRunningCoordinatorTasks();
    this.safetyController.reset();
    this.safetyStatus = {
      mode: "monitoring",
      activeRisks: [],
      normalTasksPaused: false,
      lastDecisionId: null,
      lastAction: null,
    };
    this.metrics.increment("bot_deaths_total", {
      bot_id: this.profile.botId,
    });
    this.dependencies.logger.warn(
      "bot_runtime_death",
      this.logFields({
        dimension: info.dimension,
        deathPosition: info.position
          ? `x=${Math.floor(info.position.x)} y=${Math.floor(info.position.y)} z=${Math.floor(info.position.z)}`
          : null,
      }),
    );
    this.emitStatus(this.generation, false);
  }

  private maybeStartProactiveCombat(generation: number, snapshot: BotClientSnapshot): void {
    const nowMs = this.now().getTime();
    if (this.profile.purpose !== "anarchy" || !this.combatDriver || this.combatReaction ||
      this.stopping || this.safetyStatus.normalTasksPaused || snapshot.food.level < 12 ||
      nowMs < this.nextProactiveCombatAtMs || snapshot.safety.movementRequested ||
      !resolveGameplayPolicy({ environment: process.env }).proactiveCombat) return;
    this.nextProactiveCombatAtMs = nowMs + 200;
    try {
      const observation = this.client?.combatObservation?.(nowMs);
      if (!observation || !this.combatDriver.shouldEngageProactively(observation, nowMs)) return;
      this.nextProactiveCombatAtMs = nowMs + 3_000;
      this.handleDamaged(generation, { previousHealth: snapshot.health.current, currentHealth: snapshot.health.current }, "proactive");
    } catch {
      this.combatDriver.recordUnavailable("COMBAT_OBSERVATION_UNAVAILABLE", nowMs);
    }
  }

  private handleDamaged(generation: number, info: BotDamageInfo, trigger: "damage" | "proactive" = "damage"): void {
    if (
      generation !== this.generation ||
      this.stopping ||
      this.state !== "online" ||
      !this.client ||
      this.combatReaction
    ) {
      return;
    }
    const activeClient = this.client;
    if (
      !this.combatDriver ||
      !activeClient.combatObservation ||
      !activeClient.executeCombatAction
    ) {
      this.dependencies.logger.info(
        "bot_runtime_damage_reaction_unavailable",
        this.logFields({
          previousHealth: info.previousHealth,
          currentHealth: info.currentHealth,
          reasonCode: "COMBAT_DRIVER_UNAVAILABLE",
        }),
      );
      return;
    }
    if (
      this.safetyStatus.normalTasksPaused &&
      !this.safetyAllowsDefensiveCombat()
    ) {
      this.dependencies.logger.info(
        "bot_runtime_damage_reaction_suppressed",
        this.logFields({
          previousHealth: info.previousHealth,
          currentHealth: info.currentHealth,
          reasonCode: "NORMAL_ACTIONS_PAUSED",
        }),
      );
      return;
    }
    if (!this.combatObservationAvailable()) {
      this.combatDriver.recordUnavailable(
        "COMBAT_OBSERVATION_UNAVAILABLE",
        this.now().getTime(),
      );
      this.dependencies.logger.warn(
        "bot_runtime_damage_reaction_unavailable",
        this.logFields({
          previousHealth: info.previousHealth,
          currentHealth: info.currentHealth,
          reasonCode: "COMBAT_OBSERVATION_UNAVAILABLE",
        }),
      );
      return;
    }

    this.cancelRunningCoordinatorTasks();
    this.cancelActiveSkills();
    activeClient.interruptNormalActions?.();
    // A live damage event starts a fresh deterministic combat epoch. This
    // releases an in-flight movement/attack ACK without carrying stale target
    // or rate-window state into the reaction.
    this.combatDriver.reset(false);
    // 战术 shadow 的滞回/承诺状态同样不跨 epoch：新遭遇从 INITIAL 开始。
    this.tacticsShadowPreviousDecision = null;
    this.tacticsShadowLastStepMonotonicMs = null;

    const taskId = `combat-reaction-${this.randomId()}`;
    this.combatReflexProbeSource?.recordThreatEvent?.(taskId, this.now().getTime());
    const task: RuntimeCurrentTask = {
      taskId,
      title: trigger === "damage" ? "战斗反应: 受到攻击" : "主动交战: 发现敌对玩家",
      status: "running",
      startedAt: this.now().toISOString(),
    };
    const controller = new AbortController();
    this.currentTask = task;
    const placeholder = {
      generation,
      client: activeClient,
      taskId,
      controller,
    };
    this.combatReaction = placeholder;
    const promise = this.runCombatReaction(
      generation,
      activeClient,
      taskId,
      controller,
      trigger === "damage",
    ).catch((error): CombatReactionOutcome => {
      this.dependencies.logger.error(
        "bot_runtime_damage_reaction_failed",
        this.logFields({
          previousHealth: info.previousHealth,
          currentHealth: info.currentHealth,
          error: error instanceof Error ? error.message : String(error),
        }, this.traceId, taskId),
      );
      return "failed";
    });
    this.combatReaction = placeholder;
    this.publishCurrentTaskState();
    void promise.then((outcome) =>
      this.finishCombatReaction(generation, activeClient, taskId, outcome),
    );
    this.dependencies.logger.warn(
      "bot_runtime_damage_reaction_started",
      this.logFields({
        previousHealth: info.previousHealth,
        currentHealth: info.currentHealth,
        trigger,
        maxSteps: COMBAT_REACTION_MAX_STEPS,
        maxDurationMs: COMBAT_REACTION_MAX_DURATION_MS,
      }, this.traceId, taskId),
    );
  }

  private async runCombatReaction(
    generation: number,
    activeClient: BotClient,
    taskId: string,
    controller: AbortController,
    retaliation = true,
  ): Promise<CombatReactionOutcome> {
    const startedAtMs = this.now().getTime();
    const anarchy = this.profile.purpose === "anarchy";
    const maxSteps = anarchy
      ? ANARCHY_COMBAT_REACTION_MAX_STEPS
      : COMBAT_REACTION_MAX_STEPS;
    const maxDurationMs = anarchy
      ? ANARCHY_COMBAT_REACTION_MAX_DURATION_MS
      : COMBAT_REACTION_MAX_DURATION_MS;
    let stepDueAtMonotonicMs = this.monotonicNow();
    for (let step = 0; step < maxSteps; step += 1) {
      if (
        !this.combatReactionIsActive(
          generation,
          activeClient,
          taskId,
          controller.signal,
        )
      ) {
        return "cancelled";
      }
      if (!this.safetyAllowsDefensiveCombat()) return "cancelled";
      if (this.now().getTime() - startedAtMs >= maxDurationMs) {
        return "completed";
      }

      const requestedAtMs = this.now().getTime();
      // Include lateness relative to the scheduled tick, excluding its intentional wait.
      const receipt = await this.runCombatEngage(
        requestedAtMs,
        activeClient,
        controller.signal,
        retaliation,
      );
      this.dependencies.logger.info(
        "bot_runtime_damage_reaction_step",
        this.logFields({
          step: step + 1,
          maxSteps: COMBAT_REACTION_MAX_STEPS,
          requestedAtMs,
          actualAction: receipt.actual.action,
          primitiveAction: receipt.actual.primitiveAction,
          disposition: receipt.actual.disposition,
          reasonCode: receipt.actual.reasonCode,
          targetEntityId: receipt.actual.targetEntityId,
        }, this.traceId, taskId),
      );
      // Advisory-only：默认关（零行为/零事件）；开启时每步一条证据事件。
      if (this.tacticsCoreEnabled) {
        this.runTacticsShadowStep(activeClient, step, taskId, anarchy);
      }
      this.combatReflexProbeSource?.recordStepDurationMs(
        Math.max(0, this.monotonicNow() - stepDueAtMonotonicMs),
      );
      if (controller.signal.aborted) return "cancelled";
      if (combatReactionShouldStop(receipt, anarchy)) return "completed";
      if (
        this.now().getTime() - startedAtMs >= maxDurationMs ||
        step + 1 >= maxSteps
      ) {
        return "completed";
      }
      stepDueAtMonotonicMs = this.monotonicNow() +
        (anarchy ? ANARCHY_COMBAT_REACTION_TICK_MS : COMBAT_REACTION_TICK_MS);
      if (
        !(await this.waitForCombatReactionTick(
          controller.signal,
          anarchy ? ANARCHY_COMBAT_REACTION_TICK_MS : COMBAT_REACTION_TICK_MS,
        ))
      ) {
        return "cancelled";
      }
    }
    return "completed";
  }

  private combatReactionIsActive(
    generation: number,
    activeClient: BotClient,
    taskId: string,
    signal: AbortSignal,
  ): boolean {
    return (
      !signal.aborted &&
      generation === this.generation &&
      this.state === "online" &&
      this.client === activeClient &&
      this.combatReaction?.taskId === taskId
    );
  }

  /**
   * 战术核心 shadow 单步：装配 CombatSnapshot → score → select → evidence，
   * 发一条 `bot_tactics_decision` 事件。绝不执行动作（advisory-only）；
   * 装配或评估异常只降级为 warn，不反向影响反应循环。
   */
  private runTacticsShadowStep(
    activeClient: BotClient,
    step: number,
    taskId: string,
    anarchy: boolean,
  ): void {
    try {
      const nowMonotonicMs = this.monotonicNow();
      const stepMs = this.tacticsShadowLastStepMonotonicMs === null
        ? (anarchy ? ANARCHY_COMBAT_REACTION_TICK_MS : COMBAT_REACTION_TICK_MS)
        : Math.max(1, nowMonotonicMs - this.tacticsShadowLastStepMonotonicMs);
      this.tacticsShadowLastStepMonotonicMs = nowMonotonicMs;
      const observation = activeClient.combatObservation?.(this.now().getTime()) ?? null;
      if (observation === null) return;
      const clientSnapshot = activeClient.snapshot();
      // 近窗服务器拒绝/回拉信号（compat observer）作为 uncertainty 惩罚输入；
      // client 不采集（如测试替身）就按 0，不臆断。
      const compat = this.client === activeClient
        ? (this.getCompatSignals() ?? null)
        : null;
      let serverRejectionSignals = 0;
      if (compat !== null) {
        for (const familyStats of Object.values(compat.familyStats)) {
          serverRejectionSignals += familyStats.corrections + familyStats.rejections;
        }
      }
      const combatSnapshot = buildTacticsShadowSnapshot({
        nowMonotonicMs,
        stepMs,
        observation,
        snapshot: clientSnapshot,
        gameplayProfile: anarchy ? "anarchy_first" : "standard",
        stance: this.profile.combat?.stance ?? "preserve-life",
        compatMode: this.serverPolicyStore.resolve(this.profile.id).profile,
        serverRejectionSignals,
      });
      const verdict = scoreTacticalActions(combatSnapshot, DEFAULT_TACTICS_PROFILE);
      const decision = selectTacticalAction({
        verdict,
        snapshot: combatSnapshot,
        profile: DEFAULT_TACTICS_PROFILE,
        previous: this.tacticsShadowPreviousDecision,
        emergencySignal: emergencySignalFromObservation(observation),
      });
      this.tacticsShadowPreviousDecision = decision;
      const evidence = buildDecisionEvidence({
        snapshot: combatSnapshot,
        profile: DEFAULT_TACTICS_PROFILE,
        verdict,
        decision,
      });
      // Evidence 是确定性数值/动作名（无凭据、无自由文本），不引入秘密面。
      this.dependencies.logger.info(
        "bot_tactics_decision",
        this.logFields({
          advisoryOnly: true,
          evidenceQuality: "partial-wiring",
          step: step + 1,
          decision: decision.action,
          evidence,
        }, this.traceId, taskId),
      );
    } catch (error) {
      this.dependencies.logger.warn(
        "bot_tactics_decision_failed",
        this.logFields({
          error: error instanceof Error ? error.message : String(error),
        }, this.traceId, taskId),
      );
    }
  }

  private safetyAllowsDefensiveCombat(): boolean {
    return this.safetyStatus.activeRisks.every(
      (risk) => risk === "LOW_HEALTH" || risk === "HUNGER",
    );
  }

  private waitForCombatReactionTick(
    signal: AbortSignal,
    intervalMs = COMBAT_REACTION_TICK_MS,
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      let settled = false;
      const finish = (keepGoing: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        resolve(keepGoing);
      };
      const onAbort = () => finish(false);
      const timer = setTimeout(() => finish(!signal.aborted), intervalMs);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
  }

  private cancelCombatReaction(): void {
    const reaction = this.combatReaction;
    if (!reaction) return;
    this.combatReaction = null;
    reaction.controller.abort();
    if (
      this.currentTask?.taskId === reaction.taskId &&
      this.currentTask.status === "running"
    ) {
      this.currentTask = { ...this.currentTask, status: "cancelled" };
      this.publishCurrentTaskState(false);
    }
  }

  private finishCombatReaction(
    generation: number,
    activeClient: BotClient,
    taskId: string,
    outcome: CombatReactionOutcome,
  ): void {
    const isCurrent = this.combatReaction?.taskId === taskId;
    if (isCurrent) {
      this.combatReaction = null;
      this.nextProactiveCombatAtMs = this.now().getTime() + 3_000;
    }
    if (
      !isCurrent ||
      generation !== this.generation ||
      this.client !== activeClient ||
      this.currentTask?.taskId !== taskId
    ) {
      return;
    }
    this.currentTask = {
      ...this.currentTask,
      status: outcome === "failed"
        ? "failed"
        : outcome === "cancelled"
          ? "cancelled"
          : "completed",
    };
    this.publishCurrentTaskState();
    this.dependencies.logger.info(
      "bot_runtime_damage_reaction_finished",
      this.logFields({ outcome }, this.traceId, taskId),
    );
  }

  private auditCombatAction(
    request: SkillCapabilityRequest,
    receipt: CombatDriverReceipt,
  ): void {
    this.dependencies.logger.info(
      "combat_action_audit",
      this.logFields(
        {
          requestedAction: receipt.requested.action,
          requestedAtMs: receipt.requested.requestedAtMs,
          actualAction: receipt.actual.action,
          primitiveAction: receipt.actual.primitiveAction,
          disposition: receipt.actual.disposition,
          executedAtMs: receipt.actual.executedAtMs,
          reasonCode: receipt.actual.reasonCode,
          targetEntityId: receipt.actual.targetEntityId,
        },
        request.traceId,
        request.taskId,
        request.skillId,
      ),
    );
  }

  private cancelActiveSkills(): void {
    for (const controller of this.activeSkillControllers.values()) {
      controller.abort();
    }
  }

  private finishCoordinatorInvocation(
    invocationId: string,
    status: RuntimeCurrentTask["status"],
  ): void {
    const completed = this.activeCoordinatorTasks.get(invocationId);
    if (!completed) return;
    this.activeCoordinatorTasks.delete(invocationId);
    const next = [...this.activeCoordinatorTasks.values()].reduce<
      ActiveCoordinatorTask | null
    >(
      (latest, candidate) =>
        latest === null || candidate.order > latest.order ? candidate : latest,
      null,
    );
    this.currentTask = next?.task ?? { ...completed.task, status };
    this.publishCurrentTaskState();
  }

  private cancelRunningCoordinatorTasks(): boolean {
    this.activeCoordinatorTasks.clear();
    if (this.currentTask?.status !== "running") return false;
    this.currentTask = { ...this.currentTask, status: "cancelled" };
    return true;
  }

  private publishCurrentTaskState(evaluateSafety = true): void {
    this.emitStatus(this.generation, evaluateSafety);
    this.emitHeartbeat();
  }

  private clearTimer(
    timer: "heartbeat" | "status" | "deferredStatus" | "reconnect",
  ): void {
    const key = `${timer}Timer` as const;
    const handle = this[key];
    if (handle) {
      clearTimeout(handle);
      this[key] = null;
    }
  }
}

/**
 * A ZodError carries every issue in `message` as a JSON blob. Take the first
 * issue with its path instead, matching how ServerProfile validation reports
 * failures, and keep the result bounded for the log sink.
 */
/**
 * 技能终态失败的 IncidentType 推导：根因码属于 pathfinder 家族时用
 * PATH_FAILED/UNREACHABLE（快慢两种故障在 type/fingerprint 上必须可区分），
 * 其余保持 SKILL_FAILED。
 */
/** kick 原文的机器可归类摘要（证据字段；不下结论——根因仍看 A/B/C 矩阵）。 */
/** 服务器文本安全转纯文本：去控制字符/折叠空白/限长（保留原文语义，去传输层噪音）。 */
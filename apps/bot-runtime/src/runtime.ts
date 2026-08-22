import { randomUUID } from "node:crypto";

import {
  botSkillCatalogV1Schema,
  botVersionV1Schema,
  botStopResultV1Schema,
  botDisconnectedV1Schema,
  botHeartbeatV1Schema,
  botStatusV1Schema,
  parseBotProtocolMessage,
  parseBotTelemetryMessage,
  parseSkillCancellation,
  parseSkillInvocation,
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
import { z } from "zod";

import {
  GoalExecutor,
  type GoalExecutionOutcome,
  type StepDispatcher,
} from "./goal-execution.js";

import type {
  BotClient,
  BotClientFactory,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "./client.js";
import type { ServerProfile } from "./server-profile.js";
import type {
  BotConnectionState,
  BotMessageSink,
  RuntimeLogger,
} from "./runtime-types.js";
import { unsupportedVersionCompatibility } from "./version-compatibility.js";

type TimerHandle = ReturnType<typeof setTimeout>;

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
  randomId?: () => string;
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
    inputSchema: skillJsonValueSchema.parse(z.toJSONSchema(definition.inputSchema)),
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
  private minecraftVersionCompatibility: MinecraftVersionCompatibility | null =
    null;
  private skillCompatibilityEnvironment: SkillCompatibilityEnvironment | null =
    null;
  private skillCompatibilityCatalog: readonly SkillCompatibilityResolution[] =
    [];
  private versionUnsupported = false;
  private stopPromise: Promise<RuntimeStopOutcome> | null = null;
  private safetyActionQueue: Promise<void> = Promise.resolve();
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
  private readonly skillExecutions = new Map<
    string,
    { fingerprint: string; result: Promise<SkillExecutionResultV1> }
  >();
  private readonly serverPolicyStore: ServerPolicyStore;

  constructor(
    private readonly profile: ServerProfile,
    private readonly dependencies: RuntimeDependencies,
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.randomId = dependencies.randomId ?? randomUUID;
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
      dependencies.serverPolicyStore ?? new ServerPolicyStore();
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

  getRuntimeInstanceId(): string {
    return this.runtimeInstanceId;
  }

  getMetricsSnapshot(): MetricSample[] {
    return this.metrics.snapshot();
  }

  getSafetyStatus(): L0SafetyStatus {
    return structuredClone(this.safetyStatus);
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

  start(): void {
    if (this.state !== "offline" || this.client || this.reconnectTimer) {
      throw new Error("Bot Runtime has already been started.");
    }
    this.stopPromise = null;
    this.stopping = false;
    this.reconnectAttempts = 0;
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
      () => this.trimSkillExecutions(),
      () => this.trimSkillExecutions(),
    );
    return result;
  }

  private async performStop(
    reason: string,
    operationTraceId: string,
  ): Promise<RuntimeStopOutcome> {
    this.stopping = true;

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
    this.safetyController.reset();
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
      const client = this.dependencies.createClient(this.profile);
      this.client = client;
      client.setHandlers({
        onSpawn: () => this.handleSpawn(activeGeneration),
        onStateChanged: () => this.requestStatus(activeGeneration),
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
    this.cancelActiveSkills();
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

    this.dependencies.logger.warn("bot_runtime_disconnected", this.logFields({
      reason: info.reason,
      expected: info.expected,
    }));

    if (!this.stopping && !this.versionUnsupported) {
      this.scheduleReconnect();
    } else if (this.versionUnsupported) {
      this.dependencies.logger.warn("bot_runtime_reconnect_suppressed", this.logFields({
        code: "MINECRAFT_VERSION_UNSUPPORTED",
      }));
    }
  }

  private scheduleReconnect(): void {
    const config = this.profile.reconnect;
    if (!config.enabled || this.reconnectAttempts >= config.maxAttempts) {
      this.dependencies.logger.warn("bot_runtime_reconnect_exhausted", this.logFields({
        attempts: this.reconnectAttempts,
      }));
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
      if (this.client) this.evaluateSafetySnapshot(generation, this.client.snapshot());
    } catch {
      this.dependencies.logger.error(
        "l0_safety_snapshot_invalid",
        this.logFields({ code: "SAFETY_SNAPSHOT_INVALID" }),
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

  private emitStatus(generation: number): void {
    if (generation !== this.generation || this.state !== "online" || !this.client) {
      return;
    }
    this.clearTimer("deferredStatus");

    try {
      const snapshot = this.client.snapshot();
      this.evaluateSafetySnapshot(generation, snapshot);
      const sequence = this.nextSequence();
      const observedAt = this.now().toISOString();
      const message: BotStatusV1 = botStatusV1Schema.parse({
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
          position: snapshot.position,
          latencyMs: snapshot.latencyMs,
          currentTask: null,
          safety: this.safetyStatus,
          ...(this.minecraftVersionCompatibility
            ? { minecraftVersion: this.minecraftVersionCompatibility }
            : {}),
        },
      });
      this.lastStatusSequence = sequence;
      this.lastStatusAt = this.now().getTime();
      this.emit(message);
    } catch {
      this.dependencies.logger.error(
        "bot_runtime_status_invalid",
        this.logFields(),
      );
    }
  }

  private evaluateSafetySnapshot(
    generation: number,
    snapshot: BotClientSnapshot,
  ): void {
    if (generation !== this.generation || this.state !== "online") return;
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
      this.cancelActiveSkills();
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
        currentTaskId: null,
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
    if (this.state === "online" && this.client) {
      try {
        const snapshot = this.client.snapshot();
        position = {
          ...snapshot.position,
          serverProfileId: this.profile.id,
        };
        inventory = snapshot.safety.inventory;
      } catch {
        position = null;
        inventory = null;
      }
    }
    return {
      online: this.state === "online",
      normalActionsAllowed: this.canAcceptNormalActions(),
      serverProfileId: this.profile.id,
      position,
      inventory,
    };
  }

  private async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const activeClient = this.client;
    if (
      !activeClient ||
      this.state !== "online" ||
      this.safetyStatus.normalTasksPaused
    ) {
      throw new SkillFault("NORMAL_ACTIONS_PAUSED");
    }
    if (!activeClient.invokeSkillCapability) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    const output = await activeClient.invokeSkillCapability(request);
    if (
      this.client !== activeClient ||
      this.state !== "online" ||
      this.safetyStatus.normalTasksPaused
    ) {
      throw new SkillFault("SKILL_EXECUTION_INTERRUPTED");
    }
    return output;
  }

  private cancelActiveSkills(): void {
    for (const controller of this.activeSkillControllers.values()) {
      controller.abort();
    }
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

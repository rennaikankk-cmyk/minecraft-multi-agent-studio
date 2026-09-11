import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { loadOperatorBaseAssignments } from "./operator-base-assignments.js";
import path from "node:path";

import {
  AIRouter,
  AIRequestScheduler,
  AISchedulerError,
  ModelSelectionError,
  OllamaAdapter,
  OpenAICompatibleAdapter,
  AIError,
  resolveModel,
  ScheduledAIRouter,
  VLLMAdapter,
} from "@minecraft-studio/ai-router";
import { createStructuredLogger } from "@minecraft-studio/observability";
import {
  BullMqTaskQueue,
  PgTaskPoolAdapter,
  PersistentTaskStateMachine,
  PostgresTaskExecutionStore,
  PostgresTaskRepository,
  TaskOutboxReconciler,
} from "@minecraft-studio/task-system";

import { BotRegistry } from "./bot-registry.js";
import { FilePersonalMemoryStore } from "./personal-memory-store.js";
import { buildPlannerMemory, type PlannerMemorySource } from "./planner-memory.js";
import { createSkillGapRecorder, type SkillGapRecorderProject } from "./skill-gap-recorder.js";
import { FileGoalTemplateProposalStore } from "./goal-template-registry.js";
import { builtinSkills, FileSkillGapStore, suggestComposition, FileSkillReleaseStore, generateGapBundle } from "@minecraft-studio/skills";
import { FileLessonStore } from "./lessons/lesson-store.js";
import { LessonReviewService } from "./lessons/lesson-review-service.js";
import type { ReviewTaskFact } from "./lessons/lesson-card.js";
import { loadChatTrustPolicies } from "./chat-trust-config.js";
import { InvitationChatRouter } from "./invitation-chat.js";
import { InvitationMigrationService } from "./invitation-service.js";
import { RegistryFactReader } from "./spark-strategy-v1/registry-facts.js";
import { TeamProposalObserver, teamObserverEnabled } from "./spark-strategy-v1/observer.js";
import { scheduledRouterModelClient } from "./spark-strategy-v1/model-client.js";
import { BotAssignmentService } from "./bot-assignment.js";
import {
  AutonomousConfigError,
  loadAutonomousConfig,
} from "./autonomous-config.js";
import { AutonomousDirector } from "./autonomous-director.js";
import { ExplorationJournal } from "./exploration-journal.js";
import {
  ControlLinkConfigError,
  loadControlLinkConfig,
} from "./control-link-config.js";
import { ControlLinkServer } from "./control-link-server.js";
import { SharedStateServer, loadSharedStateConfig } from "./shared-state-server.js";
import { InMemoryWorkstationRegistry, FacilityRegistry } from '@minecraft-studio/asset-policy';
import { BaseRegistry, DurableStateStore, durableSnapshotFrom, registriesFromDurableSnapshot, InvitationStore } from '@minecraft-studio/base-management';
import { PostgresFacilityLeaseAuthority } from '@minecraft-studio/skills';
import {
  RuntimeLinkConfigError,
  loadRuntimeLinkConfig,
} from "./runtime-link-config.js";
import { RuntimeLinkServer } from "./runtime-link-server.js";
import { InMemoryStopAuditSink, StopController } from "./stop-controller.js";
import { CONSERVATIVE_DEFAULT_NOTE, LocalAIConfigError, loadLocalAIConfig } from "./local-ai-config.js";
import { CoordinatorLocalPlanner } from "./local-planner.js";
import {
  GoalPersistenceConfigError,
  loadGoalPersistenceConfig,
} from "./goal-persistence-config.js";
import {
  PostgresGoalLifecycleStore,
  type GoalLifecycleStore,
} from "./goal-lifecycle-store.js";
import {
  PostgresTaskHistoryReader,
  type TaskHistoryReader,
} from "./task-history-reader.js";
import { InMemoryGoalLifecycleStore } from "./in-memory-goal-store.js";
import {
  assertGoalStoreWiring,
  GoalStoreWiringError,
  resolveGoalStoreMode,
} from "./goal-store-mode.js";
import { resolveGameplayPolicy } from "@minecraft-studio/protocol";
import { FilePlanJournalStore } from "./plan-journal.js";
import { ExpiredLeaseRecoveryController } from "./expired-lease-recovery.js";
import { CoordinatorGoalExecutionServer } from "./goal-execution-server.js";
import {
  TaskDeliveryConfigError,
  loadTaskDeliveryConfig,
} from "./task-delivery-config.js";

const instanceId = `coordinator-${randomUUID()}`;
const logger = createStructuredLogger({ service: "coordinator", instanceId });

async function main(): Promise<void> {
  const runtimeConfig = loadRuntimeLinkConfig();
  const controlConfig = loadControlLinkConfig();
  const sharedStateConfig = loadSharedStateConfig();
  const localAIConfig = loadLocalAIConfig();
  const autonomousConfig = loadAutonomousConfig();
  const proposalEnabled = teamObserverEnabled();
  const goalPersistenceConfig = loadGoalPersistenceConfig();
  const taskDeliveryConfig = loadTaskDeliveryConfig(
    process.env,
    goalPersistenceConfig,
    instanceId,
  );
  const localMemoryMode =
    process.env.COORDINATOR_LOCAL_MEMORY_MODE?.trim() === "1";
  if (
    localAIConfig.enabled &&
    localAIConfig.baseUrl &&
    localAIConfig.model &&
    !goalPersistenceConfig &&
    !localMemoryMode
  ) {
    throw new GoalPersistenceConfigError(
      "Local goal planning requires PostgreSQL or explicit desktop memory mode.",
    );
  }
  // Round 6.2 Facility 消费方：跨 bot 共享工作站目录——planner 的 smelt 租约
  // 解析与 SharedStateServer 的跨进程控制面共用同一实例。
  const workstationRegistry = new InMemoryWorkstationRegistry();
  const baseRegistry = new BaseRegistry();
  const facilityRegistry = new FacilityRegistry();
  const journalDir = process.env.STUDIO_PLAN_JOURNAL_DIR?.trim() || path.join("runtime-data", "plan-journals");
  const planJournalStore = new FilePlanJournalStore({ dir: journalDir });
  const baseStateStore = new DurableStateStore(process.env.STUDIO_SHARED_STATE_PERSIST_PATH?.trim() ||
    path.join("runtime-data", "shared-state.json"));
  const invitationStore = new InvitationStore(process.env.STUDIO_INVITATIONS_PATH?.trim() ||
    path.join("runtime-data", "invitations.json"));
  invitationStore.load();
  const baseSnapshot = baseStateStore.load();
  if (baseSnapshot) {
    const restored = registriesFromDurableSnapshot(baseSnapshot);
    workstationRegistry.absorb(restored.workstations);
    baseRegistry.absorb(restored.bases);
    facilityRegistry.absorb(restored.facilities);
    baseRegistry.markFactsUnverified();
  }
  const persistBaseState = () => baseStateStore.save(durableSnapshotFrom(workstationRegistry, facilityRegistry, baseRegistry));
  const assignmentsPath = process.env.STUDIO_BASE_ASSIGNMENTS_PATH?.trim();
  if (assignmentsPath) {
    const count = loadOperatorBaseAssignments(assignmentsPath, baseRegistry, facilityRegistry);
    persistBaseState();
    logger.info("coordinator_operator_bases_assigned", { count });
  }
  const personalMemory = new FilePersonalMemoryStore(process.env.STUDIO_PERSONAL_MEMORY_DIR?.trim() ||
    path.join("runtime-data", "personal-memory"));
  logger.info("coordinator_personal_memory_started", { durability: personalMemory.durability, freshness: "historical" });
  const registry = new BotRegistry({
    staleAfterMs: runtimeConfig.botStaleAfterMs,
    personalMemory,
    chatTrustPolicies: loadChatTrustPolicies(process.env.STUDIO_CHAT_TRUST_PATH),
  });
  const invitationChat = new InvitationChatRouter({ store: invitationStore, records: () => registry.list(),
    currentHome: (botId, scope) => baseRegistry.forMember(botId, scope.serverProfileId, scope.dimension, scope.worldId)?.id ?? null });
  let invitationMigrationService: InvitationMigrationService | null = null;
  // 聊天指挥扇入：director 构造完成后才存在，用闭包变量转接。
  let chatGoalHandler: ((botId: string, speaker: string, message: string) => boolean) | null = null;
  // Phase B 复盘服务同样晚构造（依赖 taskStateMachine/aiScheduledRouter）。
  let lessonReviewService: LessonReviewService | null = null;
  registry.subscribe((record, event) => {
    lessonReviewService?.noteConnectionState(record.botId, record.serverProfileId, record.connectionState);
    if (event?.kind === "chat") {
      // Parse trusted invitations before free-text handling. This keeps raw
      // coordinates in the durable, access-controlled business record rather
      // than exposing them to an AI prompt or replacing a migration with chat.
      const invitation = invitationChat.handle(record, event);
      if (invitation.handled) {
        logger.info("coordinator_base_invitation_recorded", {
          botId: record.botId, invitationId: invitation.invitation?.invitationId,
          migrationId: invitation.invitation?.migrationId, status: invitation.reason,
        });
        if (invitation.invitation?.status === "accepted") {
          void invitationMigrationService?.execute(invitation.invitation.invitationId).catch((error) =>
            logger.warn("coordinator_base_invitation_migration_blocked", {
              invitationId: invitation.invitation?.invitationId, reason: error instanceof Error ? error.message : "migration_failed",
            }));
        }
        return;
      }
      chatGoalHandler?.(record.botId, event.speaker, event.message);
    }
  });
  const assignment = new BotAssignmentService({
    registry,
    onEvent: (event) => {
      logger.info("coordinator_bot_assignment", {
        assignmentEvent: event.type,
        leaseId: event.leaseId,
        taskId: event.taskId,
        botId: event.botId,
        runtimeInstanceId: event.runtimeInstanceId,
      });
    },
  });
  // D3 live 证据钩的闭包转接：release store 在 runtimeServer 之后构造。
  let liveReleaseStore: FileSkillReleaseStore | null = null;
  const runtimeServer = new RuntimeLinkServer({
    host: runtimeConfig.host,
    port: runtimeConfig.port,
    instanceId,
    peers: runtimeConfig.peers,
    ...(runtimeConfig.peersPath ? { peersPath: runtimeConfig.peersPath } : {}),
    ...(runtimeConfig.managedKeyIds !== undefined ? { managedKeyIds: runtimeConfig.managedKeyIds } : {}),
    registry,
    logger,
    onSkillResult: (result) => {
      const store = liveReleaseStore;
      if (store === null || result.payload.outcome !== "completed") return;
      const release = store.pipeline.list().find(
        (candidate) => candidate.skillId === result.payload.skillId &&
          (candidate.status === "sandboxed" || candidate.status === "canary"),
      );
      if (release === undefined) return;
      try {
        // canary 期成功只补证据（≤8 条防刷盘）；sandboxed 期成功可推进 verified。
        if (release.status === "canary" && release.evidence.length >= 8) return;
        store.pipeline.recordLiveRun(release.releaseId, {
          serverProfileId: "live",
          passed: true,
          checks: [{ label: `skill ${result.payload.skillId} completed on live server`, passed: true }],
          failures: [],
        });
        store.persist(release.releaseId);
        logger.info("coordinator_skill_release_live_run", {
          releaseId: release.releaseId, skillId: release.skillId, status: store.pipeline.get(release.releaseId)?.status ?? release.status,
        });
      } catch {
        // 证据钩绝不影响 skill result 派发路径。
      }
    },
  });
  const stopController = new StopController({
    instanceId,
    registry,
    transport: runtimeServer,
    auditSink: new InMemoryStopAuditSink(),
    logger,
  });
  let aiScheduler: AIRequestScheduler | null = null;
  let aiRouter: AIRouter | null = null;
  let localPlanner: CoordinatorLocalPlanner | undefined;
  let taskPool: PgTaskPoolAdapter | null = null;
  const facilityLeaseAuthority = goalPersistenceConfig
    ? new PostgresFacilityLeaseAuthority(async (queryText, values) => {
        if (!taskPool) throw new Error("facility lease store is not initialized");
        const client = await taskPool.connect();
        try {
          return await client.query(queryText, values);
        } finally {
          client.release();
        }
      })
    : undefined;
  let taskRepository: PostgresTaskRepository | null = null;
  const memoryGoalStore =
    !goalPersistenceConfig && localMemoryMode
      ? new InMemoryGoalLifecycleStore()
      : null;
  let goalStore: GoalLifecycleStore | undefined = memoryGoalStore ?? undefined;
  let taskHistoryReader: TaskHistoryReader | undefined =
    memoryGoalStore ?? undefined;
  let queuedGoalStore: PostgresGoalLifecycleStore | undefined;
  let leaseRecovery: ExpiredLeaseRecoveryController | null = null;
  let taskQueue: BullMqTaskQueue | null = null;
  let outboxReconciler: TaskOutboxReconciler | null = null;
  let goalExecutionServer: CoordinatorGoalExecutionServer | null = null;
  let sharedStateServer: SharedStateServer | null = null;
  let autonomousDirector: AutonomousDirector | null = null;
  // —— Spark 模型选择（统一规则，启动时执行；绝不 models[0] 静默选择）——
  let resolvedAIModel: string | null = localAIConfig.model;
  if (localAIConfig.enabled && localAIConfig.baseUrl && localAIConfig.provider !== "openai-compatible") {
    try {
      const selection = await resolveModel({
        baseUrl: localAIConfig.baseUrl,
        apiKey: localAIConfig.apiKey,
        configuredModel: localAIConfig.model,
        timeoutMs: 5_000,
      });
      resolvedAIModel = selection.model;
      logger.info("coordinator_local_ai_model_selected", {
        model: selection.model,
        selection: selection.selection,
        source: selection.source,
        advertisedModels: selection.discoveredModels.length,
      });
    } catch (cause) {
      resolvedAIModel = null;
      const code = cause instanceof ModelSelectionError ? cause.code : "AI_MODEL_DISCOVERY_FAILED";
      logger.error("coordinator_local_ai_unavailable", {
        code,
        detail: cause instanceof Error ? cause.message.slice(0, 300) : String(cause),
        note: "planner degrades to deterministic-only (fail closed, no silent fallback)",
      });
    }
  }
  if (localAIConfig.enabled && localAIConfig.baseUrl && resolvedAIModel) {
    aiRouter = new AIRouter();
    aiRouter.register(
      localAIConfig.provider === "openai-compatible"
        ? new OpenAICompatibleAdapter({ baseUrl: localAIConfig.baseUrl, model: resolvedAIModel,
            apiKey: localAIConfig.apiKey!,
            ...(localAIConfig.structuredOutput ? { structuredOutput: localAIConfig.structuredOutput } : {}),
            ...(localAIConfig.maxOutputTokens === undefined ? {} : { maxOutputTokens: localAIConfig.maxOutputTokens }) })
        : localAIConfig.provider === "ollama"
        ? new OllamaAdapter(localAIConfig.baseUrl, resolvedAIModel)
        : new VLLMAdapter(
            localAIConfig.baseUrl,
            resolvedAIModel,
            localAIConfig.apiKey,
          ),
    );
    aiScheduler = new AIRequestScheduler({
      maxConcurrency: localAIConfig.maxConcurrency,
      maxQueue: localAIConfig.maxQueue,
      perBotConcurrency: localAIConfig.perBotConcurrency,
      defaultTimeoutMs: localAIConfig.requestTimeoutMs,
      defaultRetry: {
        maxAttempts: localAIConfig.maxAttempts ?? 2,
        baseDelayMs: 500,
        maxDelayMs: 30_000,
        jitterRatio: 0.2,
        retryable: (error: unknown) => error instanceof AIError && error.retryable,
      },
      onEvent: (event) => {
        logger.info("coordinator_ai_request", {
          requestId: event.requestId,
          botId: event.botId,
          priority: event.priority,
          state: event.type,
          attempt: event.attempt,
          queueTimeMs: event.queueTimeMs,
          errorCode: event.errorCode,
        });
      },
    });
    // P0-5：configured/effective 并发语义在启动日志显式可查
    logger.info("coordinator_ai_concurrency", {
      configuredMaxConcurrency: localAIConfig.maxConcurrency,
      effectiveMaxConcurrency: localAIConfig.maxConcurrency,
      explicitConfig: process.env.AI_MAX_CONCURRENCY?.trim() ? true : false,
      note: process.env.AI_MAX_CONCURRENCY?.trim()
        ? "explicit AI_MAX_CONCURRENCY"
        : CONSERVATIVE_DEFAULT_NOTE,
    });
  }
  // Scheduler+Router+Breaker 共享实例（planner 与健康遥测共用）
  const aiScheduledRouter = aiRouter && aiScheduler ? new ScheduledAIRouter(aiRouter, aiScheduler) : null;
  const proposalReader = proposalEnabled ? new RegistryFactReader({ registry, assignment,
    bases: baseRegistry, facilities: facilityRegistry, workstations: workstationRegistry }) : null;
  const proposalObserver = proposalReader && aiScheduledRouter ? new TeamProposalObserver({
    enabled: true, client: scheduledRouterModelClient(aiScheduledRouter), read: (now) => proposalReader.read(now),
    log: (entry) => logger.info("coordinator_team_proposal", entry),
  }) : null;
  logger.info("coordinator_team_proposal_mode", { enabled: proposalEnabled,
    available: proposalObserver !== null, automaticDispatch: false, cooldownMs: 180_000, maxInFlight: 1 });
  if (aiScheduledRouter) {
    const aiHealthTimer = setInterval(() => {
      const health = aiScheduledRouter.healthSnapshot();
      logger.info("coordinator_ai_health", {
        queued: health.scheduler.queued,
        running: health.scheduler.running,
        maxConcurrency: health.scheduler.maxConcurrency,
        maxQueue: health.scheduler.maxQueue,
        perBotConcurrency: health.scheduler.perBotConcurrency,
        bots: health.scheduler.bots.length,
        breakerState: health.breaker.state,
        breakerConsecutiveFailures: health.breaker.consecutiveFailures,
        breakerRejected: health.breaker.rejectedCount,
      });
    }, 30_000);
    aiHealthTimer.unref?.();
  }
  // 自主生存链的全部目标都走确定性派发，模型只是非模板目标的兜底。所以
  // planner 在没有 Local AI 时也要构造：兜底换成一个永远诚實拒绝的桩
  // （AI_UNAVAILABLE），确定性目标照常 0 次模型调用地运转——这与
  // AGENTS.md §0.4"AI 宕机 fail-closed 到确定性层，而不是停下"一致。
  // 此前整个 AutonomousDirector 被装配在 Spark 配置块里，Spark 不可用
  // 时自主生存完全停摆，而它本来一步都不需要模型。
  const explorationJournal = new ExplorationJournal(process.env.STUDIO_EXPLORATION_CACHE_PATH?.trim() || path.join("runtime-data", "exploration-cache.json"));
  await explorationJournal.initialize();
  logger.info("exploration_cache_loaded", explorationJournal.health());
  // Task execution persistence is required by deterministic goals as well as
  // model backed planning. Construct it once before either planner branch so
  // a restart cannot silently fall back to an in-memory execution record.
  const taskPersistence = await createTaskStateMachine();
  taskPool = taskPersistence.pool;
  const taskStateMachine = taskPersistence.stateMachine;
  // Phase B lesson 复盘：store 全局单例（planner 记忆消费与复盘落盘共享）。
  const lessonStore = new FileLessonStore(process.env.STUDIO_LESSON_DIR?.trim() ||
    path.join("runtime-data", "lessons"));
  const reviewTaskFacts = async (): Promise<readonly ReviewTaskFact[]> => {
    let records: Awaited<ReturnType<typeof taskStateMachine.list>> = [];
    try {
      records = await taskStateMachine.list();
    } catch {
      return [];
    }
    return records
      .filter((record) => record.state === "SUCCESS" || record.state === "ABORT")
      .map((record) => ({
        taskId: record.taskId,
        botId: record.botId,
        goal: record.goal,
        state: record.state as "SUCCESS" | "ABORT",
        failureReason: record.failureReason,
        updatedAt: record.updatedAt,
      }));
  };
  if (aiScheduledRouter) {
    lessonReviewService = new LessonReviewService({
      client: scheduledRouterModelClient(aiScheduledRouter),
      store: lessonStore,
      taskFacts: reviewTaskFacts,
      templateProposals: new FileGoalTemplateProposalStore(
        process.env.STUDIO_GOAL_TEMPLATE_DIR?.trim() || path.join("runtime-data", "goal-templates")),
      logger,
    });
    logger.info("coordinator_lesson_review_started", { durability: "file", trigger: "manual+session-end", dispatch: "none" });
  } else {
    logger.info("coordinator_lesson_review_unavailable", { reason: "ai-router-not-configured" });
  }
  // Phase D1：SkillGap 救活——文件持久化 store + task 失败终态自动入册。
  const skillGapStore = new FileSkillGapStore(
    process.env.STUDIO_SKILL_GAP_DIR?.trim() || path.join("runtime-data", "skill-gaps"));
  const gapProject = loadGapProject();
  const skillGapRecorder = createSkillGapRecorder({
    store: skillGapStore,
    catalogSkillIds: builtinSkills.map((skill) => skill.id),
    project: gapProject,
    serverProfileFor: (botId) => registry.get(botId)?.serverProfileId ?? null,
    minecraftVersionFor: (botId) => registry.get(botId)?.minecraftVersion?.resolvedVersion ?? undefined,
    log: (event, fields) => logger.info(event, fields),
  });
  logger.info("coordinator_skill_gap_started", {
    durability: skillGapStore.durability,
    catalogSize: builtinSkills.length,
    note: "evidence-gated: catalog-dependent kinds require a named skill",
  });
  // Phase D3：release lifecycle 运行时。sandbox_auto 档（用户显式开通）下
  // 验收通过自动连升 canary——bot 边玩边进化，无需隔离服与人工批次。
  const skillDevMode = process.env.STUDIO_SKILL_DEV_MODE?.trim() === "sandbox_auto" ? "sandbox_auto" : "export_only";
  const skillReleaseStore = new FileSkillReleaseStore(
    process.env.STUDIO_SKILL_RELEASE_DIR?.trim() || path.join("runtime-data", "skill-releases"),
    { autoPromoteToCanary: skillDevMode === "sandbox_auto" },
  );
  liveReleaseStore = skillReleaseStore;
  logger.info("coordinator_skill_release_started", {
    devMode: skillDevMode,
    autoPromoteToCanary: skillDevMode === "sandbox_auto",
    liveEvidence: "runtime-link skill results",
    note: skillDevMode === "sandbox_auto"
      ? "verification runs auto-promote to canary; active still requires an operator"
      : "verified parking; canary/active require operator decisions",
  });
  const skillReleases = {
    list: () => skillReleaseStore.list() as ReadonlyArray<Record<string, unknown>>,
    createDraftFromGap: (input: Readonly<{ gapFingerprint: string; skillId?: string }>) => {
      const gap = skillGapStore.get(input.gapFingerprint);
      if (gap === null) return { ok: false as const, error: "gap_not_found" };
      const bundle = generateGapBundle(gap, {
        existingSkills: builtinSkills.map((skill) => ({ skillId: skill.id, capabilities: [] })),
      });
      if (bundle === null) return { ok: false as const, error: "bundle_generation_failed" };
      const skillId = input.skillId ?? gap.gap.requestedSkillId ?? "unset.candidate";
      const release = skillReleaseStore.createDraftRelease({
        skillId,
        gapFingerprint: gap.fingerprint,
        bundleContentHash: bundle.contentHash,
      });
      logger.info("coordinator_skill_release_draft_created", {
        releaseId: release.releaseId, skillId, gapFingerprint: gap.fingerprint,
      });
      return { ok: true as const, releaseId: release.releaseId, implementationPrompt: bundle.implementationPrompt };
    },
    operatorDecision: (input: Readonly<{ releaseId: string; decision: "promote-canary" | "promote-active" | "revoke"; operator: string; note?: string }>) => {
      try {
        const updated = skillReleaseStore.pipeline.operatorDecision(
          input.releaseId, input.decision, input.operator, input.note);
        skillReleaseStore.persist(input.releaseId);
        logger.info("coordinator_skill_release_decision", {
          releaseId: input.releaseId, decision: input.decision, operator: input.operator, status: updated.status,
        });
        return { ok: true as const, status: updated.status };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : "decision_failed" };
      }
    },
    recordLiveRun: (input: Readonly<{ releaseId: string; passed: boolean; label?: string }>) => {
      try {
        const updated = skillReleaseStore.pipeline.recordLiveRun(input.releaseId, {
          serverProfileId: "live",
          passed: input.passed,
          checks: [{ label: input.label ?? "manual live-run record", passed: input.passed }],
          failures: input.passed ? [] : [input.label ?? "manual live-run failure record"],
        });
        skillReleaseStore.persist(input.releaseId);
        return { ok: true as const, status: updated.status };
      } catch (error) {
        return { ok: false as const, error: error instanceof Error ? error.message : "live_run_failed" };
      }
    },
  };
  // Phase A 记忆源：goal 历史（task store）+ personal-memory + lesson 卡。
  // 全部读取失败都降级为 null/[]——记忆是增强，绝不阻塞规划。
  const plannerMemorySource: PlannerMemorySource = async ({ botId, serverProfileId }) => {
    let taskRecords: Awaited<ReturnType<typeof taskStateMachine.list>> = [];
    try {
      taskRecords = await taskStateMachine.list();
    } catch {
      taskRecords = [];
    }
    let memory: ReturnType<FilePersonalMemoryStore["get"]> = null;
    try {
      memory = personalMemory.getLatestForBot?.(botId, serverProfileId) ?? null;
    } catch {
      memory = null;
    }
    let lessons: ReadonlyArray<{ kind: string; goalPattern: string; advice: string; confidence: number; observedAtMs: number }> = [];
    try {
      lessons = lessonStore.listTop(serverProfileId, 4).map((lesson) => ({
        kind: lesson.kind,
        goalPattern: lesson.trigger.goalPattern,
        advice: lesson.advice,
        confidence: lesson.confidence,
        observedAtMs: lesson.observedAtMs,
      }));
    } catch {
      lessons = [];
    }
    return buildPlannerMemory({ botId, serverProfileId, taskRecords, personalMemory: memory, lessons });
  };
  if (localAIConfig.enabled && localAIConfig.baseUrl && resolvedAIModel) {
    localPlanner = new CoordinatorLocalPlanner({
      ai: aiScheduledRouter!,
      registry,
      assignment,
      verifyAssignmentLease: async (lease) => {
        const repository = taskRepository;
        if (!repository) {
          return memoryGoalStore?.isAssignmentLeaseActive(lease) ?? false;
        }
        try {
          return await repository.isTaskAssignmentLeaseActive(lease);
        } catch {
          // Durable lease authority is fail-closed. A persistence outage must
          // never turn a pre-acquired owner string into an execution grant.
          return false;
        }
      },
      transport: runtimeServer,
      coordinatorInstanceId: instanceId,
      workstationRegistry,
      planJournalStore, baseRegistry, facilityRegistry, persistBaseState, explorationJournal, taskStateMachine,
      plannerMemory: plannerMemorySource,
      onTaskAborted: skillGapRecorder,
      logger,
    });
  } else {
    localPlanner = new CoordinatorLocalPlanner({
      ai: {
        generate: async (request) => {
          throw new AISchedulerError(
            "AI_REQUEST_FAILED",
            "No Local AI hub is configured; only deterministic goal templates are served.",
            request.requestId,
          );
        },
      },
      registry,
      assignment,
      verifyAssignmentLease: async (lease) =>
        memoryGoalStore?.isAssignmentLeaseActive(lease) ?? false,
      transport: runtimeServer,
      coordinatorInstanceId: instanceId,
      workstationRegistry,
      planJournalStore, baseRegistry, facilityRegistry, persistBaseState, explorationJournal, taskStateMachine,
      plannerMemory: plannerMemorySource,
      onTaskAborted: skillGapRecorder,
      logger,
    });
    logger.warn("coordinator_planner_deterministic_only", {
      detail: "Local AI is not configured; model fallback will reject with AI_UNAVAILABLE.",
    });
  }
  invitationMigrationService = new InvitationMigrationService({ store: invitationStore, planner: localPlanner, registry });
  if (autonomousConfig.enabled) {
    autonomousDirector = new AutonomousDirector({
      baseRegistry, facilityRegistry, planJournalStore, persistBaseState,
      explorationJournal,
      registry,
      planner: localPlanner,
      intervalMs: autonomousConfig.intervalMs,
      goalTimeoutMs: autonomousConfig.goalTimeoutMs,
      failureCooldownMs: autonomousConfig.failureCooldownMs,
      terminalRetentionMs: autonomousConfig.terminalRetentionMs,
      logger,
      ...(facilityLeaseAuthority ? { facilityLeaseAuthority } : {}),
      // 配置了 Local AI 时把调度路由交给重规划神谕；确定性模式不注入，
      // 神谕路径完全不激活。预算来自已装配的 localAIConfig。
      // 选址评审（site-verdict）与 replan 共用同一 router/scheduler——
      // 并发预算统一受管，模型缺位时两条路径都 fail-open。
      ...(aiScheduledRouter
        ? { replanAI: aiScheduledRouter, siteAI: aiScheduledRouter }
        : {}),
      onChatGoal: (botId, speaker, message) =>
        autonomousDirector?.handleChatMessage(botId, speaker, message) ?? false,
    });
    chatGoalHandler = (botId, speaker, message) =>
      autonomousDirector?.handleChatMessage(botId, speaker, message) ?? false;
  }
  if (goalPersistenceConfig) {
    taskPool = new PgTaskPoolAdapter({
      connectionString: goalPersistenceConfig.postgresUrl,
      options: `-c search_path=${goalPersistenceConfig.schemaName}`,
      application_name: "minecraft-studio-coordinator",
    });
    taskRepository = new PostgresTaskRepository(taskPool, {
      dispatchSourceInstanceId: instanceId,
    });
    queuedGoalStore = new PostgresGoalLifecycleStore({
      repository: taskRepository,
      coordinatorInstanceId: instanceId,
      resolveBotContext: (botId) => {
        const record = registry.get(botId);
        if (
          !record ||
          record.connectionState !== "online" ||
          record.currentStatus === null
        ) {
          return null;
        }
        return {
          serverProfileId: record.serverProfileId,
          dimension: record.currentStatus.position.dimension,
        };
      },
    });
    goalStore = queuedGoalStore;
    taskHistoryReader = new PostgresTaskHistoryReader({
      repository: taskRepository,
    });
    leaseRecovery = new ExpiredLeaseRecoveryController({
      repository: taskRepository,
      actorId: instanceId,
      logger,
    });
    if (taskDeliveryConfig) {
      if (taskDeliveryConfig.purpose === "production" && !localPlanner) {
        throw new TaskDeliveryConfigError(
          "Production task delivery requires a configured Local AI planner.",
        );
      }
      taskQueue = new BullMqTaskQueue({
        redisUrl: taskDeliveryConfig.redisUrl,
        queueName: taskDeliveryConfig.queueName,
        prefix: taskDeliveryConfig.queuePrefix,
      });
      outboxReconciler = new TaskOutboxReconciler({
        repository: taskRepository,
        queue: taskQueue,
        instanceId: taskDeliveryConfig.instanceId,
        batchSize: taskDeliveryConfig.batchSize,
        claimTtlMs: taskDeliveryConfig.claimTtlMs,
        pollIntervalMs: taskDeliveryConfig.pollIntervalMs,
        retryBaseMs: taskDeliveryConfig.retryBaseMs,
        retryMaxMs: taskDeliveryConfig.retryMaxMs,
      });
      if (taskDeliveryConfig.purpose === "production") {
        goalExecutionServer = new CoordinatorGoalExecutionServer({
          ...taskDeliveryConfig.goalExecution,
          repository: taskRepository,
          planner: localPlanner!,
          logger,
        });
      }
    }
  }
  const controlServer = new ControlLinkServer({
    host: controlConfig.host,
    port: controlConfig.port,
    instanceId,
    clients: controlConfig.clients,
    registry,
    stopController,
    assignment,
    ...(localPlanner ? { goalPlanner: localPlanner } : {}),
    ...(goalStore ? { goalStore } : {}),
    ...(taskDeliveryConfig?.purpose === "production" && queuedGoalStore
      ? { queuedGoalStore }
      : {}),
    ...(taskHistoryReader ? { taskHistoryReader } : {}),
    ...(autonomousDirector
      ? { autonomousTaskSource: autonomousDirector }
      : {}),
    logger,
  });
  // planner 装配而无 store → 结构化 fail closed（P1.3 根因：fixture 未声明模式）。
  // 不放宽 ControlLinkServer 的构造守卫；这里只把诊断提前并给出明确修复指引。
  const goalStoreMode = assertGoalStoreWiring({
    mode: resolveGoalStoreMode({
      hasPersistenceConfig: Boolean(goalPersistenceConfig),
      localMemoryMode,
    }),
    hasPlanner: Boolean(localPlanner),
  });
  // Round 8: Gameplay Policy SSOT — resolve once at startup and log it;
  // invalid STUDIO_GAMEPLAY_PROFILE fails closed (refuses to start).
  try {
    const gameplayPolicy = resolveGameplayPolicy({});
    logger.info("coordinator_gameplay_policy", {
      profile: gameplayPolicy.profile,
      unknownPlayerDisposition: gameplayPolicy.unknownPlayerDisposition,
      proactiveCombat: gameplayPolicy.proactiveCombat,
      source: gameplayPolicy.source,
      revision: gameplayPolicy.revision,
    });
  } catch (cause) {
    logger.error("coordinator_start_failed", {
      code: "GAMEPLAY_POLICY_INVALID",
      detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
    });
    process.exitCode = 1;
    return;
  }
  logger.info("coordinator_goal_store_started", {
    mode: goalStoreMode,
    queuedGoals: taskDeliveryConfig?.purpose === "production" ? "durable" : "off",
    localMemoryMode,
  });
  let staleTimer: ReturnType<typeof setInterval> | null = null;

  try {
    await taskPool?.verifyConnection();
    await taskQueue?.verifyConnection();
    await goalExecutionServer?.start();
    if (sharedStateConfig) {
      sharedStateServer = new SharedStateServer({
        workstations: workstationRegistry,
        bases: baseRegistry,
        facilities: facilityRegistry,
        persistState: persistBaseState,
        personalMemory,
        lessonStore,
        ...(lessonReviewService ? { lessonReview: lessonReviewService } : {}),
        skillGaps: {
          list: () => skillGapStore.list() as ReadonlyArray<Record<string, unknown>>,
          compositionSuggestions: () => skillGapStore.list().map((gap) => ({
            fingerprint: gap.fingerprint,
            suggestion: suggestComposition(
              {
                kind: gap.kind,
                actionFamily: gap.gap.actionFamily,
                ...(gap.gap.requestedSkillId !== undefined ? { requestedSkillId: gap.gap.requestedSkillId } : {}),
                ...(gap.gap.requestedCapability !== undefined ? { requestedCapability: gap.gap.requestedCapability } : {}),
              },
              builtinSkills.map((skill) => ({ skillId: skill.id })),
            ),
          })),
        },
        skillReleases,
        provenanceDir: path.join(process.cwd(), "runtime-data", "provenance"),
        host: sharedStateConfig.host,
        port: sharedStateConfig.port,
        ...(sharedStateConfig.token ? { token: sharedStateConfig.token } : {}),
        logger,
      });
      const sharedStateAddress = await sharedStateServer.start();
      logger.info("coordinator_shared_state_started", {
        host: sharedStateAddress.host,
        port: sharedStateAddress.port,
      });
    }
    const runtimeAddress = await runtimeServer.start();
    const controlAddress = await controlServer.start();
    autonomousDirector?.start();
    // PostgreSQL is authoritative for leases. Start bounded recovery only
    // after readiness and both control endpoints are available, so recovered
    // outbox records are not created during a partially started process.
    leaseRecovery?.start();
    await outboxReconciler?.start();
    staleTimer = setInterval(() => {
      try {
        registry.sweepStale();
        assignment.reconcile();
      } catch {
        logger.error("coordinator_registry_stale_sweep_failed", {
          code: "COORDINATOR_CLOCK_INVALID",
        });
      }
    }, 1_000);
    logger.info("coordinator_runtime_link_started", {
      bindScope: "loopback",
      port: runtimeAddress.port,
    });
    logger.info("coordinator_control_link_started", {
      bindScope: "loopback",
      port: controlAddress.port,
    });
    if (taskDeliveryConfig) {
      logger.info("coordinator_task_delivery_started", {
        purpose: taskDeliveryConfig.purpose,
        queueName: taskDeliveryConfig.queueName,
        queuePrefix: taskDeliveryConfig.queuePrefix,
      });
    }
    if (aiRouter) {
      const health = await aiRouter.healthCheck();
      logger.info("coordinator_local_ai_health", {
        available: [...health.values()].some(Boolean),
        adapters: health.size,
      });
    } else {
      logger.info("coordinator_local_ai_disabled", { available: false });
    }
    logger.info("coordinator_autonomy_configured", {
      enabled: autonomousDirector !== null,
      intervalMs: autonomousConfig.intervalMs,
      goalTimeoutMs: autonomousConfig.goalTimeoutMs,
    });
  } catch (cause) {
    if (staleTimer) clearInterval(staleTimer);
    if (autonomousDirector) await Promise.allSettled([autonomousDirector.stop()]);
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop(), sharedStateServer?.stop() ?? Promise.resolve()]);
    if (goalExecutionServer) {
      try {
        await goalExecutionServer.stop();
      } catch {
        logger.error("coordinator_goal_execution_bridge_stop_failed", {
          code: "GOAL_EXECUTION_BRIDGE_STOP_FAILED",
        });
      }
    }
    if (leaseRecovery) await Promise.allSettled([leaseRecovery.stop()]);
    if (outboxReconciler) await Promise.allSettled([outboxReconciler.stop()]);
    if (taskQueue) await Promise.allSettled([taskQueue.close()]);
    if (taskPool) await Promise.allSettled([taskPool.close()]);
    throw cause;
  }

  let stopping = false;
  proposalObserver?.start();
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    if (staleTimer) clearInterval(staleTimer);
    await proposalObserver?.stop();
    if (autonomousDirector) await autonomousDirector.stop();
    aiScheduler?.close("coordinator shutdown");
    logger.info("coordinator_stopping", { signal });
    // Stop accepting new control/runtime work before draining durable delivery
    // and closing PostgreSQL. Existing leases are then recovered or handed off
    // by the bounded controllers without a new request racing shutdown.
    await Promise.allSettled([controlServer.stop(), runtimeServer.stop(), sharedStateServer?.stop() ?? Promise.resolve()]);
    if (goalExecutionServer) {
      try {
        await goalExecutionServer.stop();
      } catch {
        logger.error("coordinator_goal_execution_bridge_stop_failed", {
          code: "GOAL_EXECUTION_BRIDGE_STOP_FAILED",
        });
      }
    }
    if (leaseRecovery) {
      try {
        await leaseRecovery.stop();
      } catch {
        logger.error("coordinator_task_lease_recovery_stop_failed", {
          code: "TASK_LEASE_RECOVERY_STOP_FAILED",
        });
      }
    }
    if (outboxReconciler) {
      try {
        await outboxReconciler.stop();
      } catch {
        logger.error("coordinator_task_outbox_reconciler_stop_failed", {
          code: "TASK_OUTBOX_RECONCILER_STOP_FAILED",
        });
      }
    }
    if (taskQueue) {
      try {
        await taskQueue.close();
      } catch {
        logger.error("coordinator_task_queue_close_failed", {
          code: "TASK_QUEUE_CLOSE_FAILED",
        });
      }
    }
    if (taskPool) {
      try {
        await taskPool.close();
      } catch {
        logger.error("coordinator_task_pool_close_failed", {
          code: "POSTGRES_CLOSE_FAILED",
        });
      }
    }
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

/**
 * gap 元数据用构建身份：monorepo 单树构建，bot-runtime dist 的 manifest 与
 * coordinator 同 commit（构建顺序保证）。读不到时用占位并标 dirty——绝不
 * 阻止 gap 记录（元数据缺失不是丢证据的理由）。
 */
function loadGapProject(): SkillGapRecorderProject {
  try {
    const manifest = JSON.parse(readFileSync(
      path.join(process.cwd(), "apps", "bot-runtime", "dist", "build-manifest.json"), "utf8")) as {
      gitCommit?: unknown; branch?: unknown; dirty?: unknown;
    };
    const gitCommit = typeof manifest.gitCommit === "string" && /^[0-9a-f]{7,40}$/u.test(manifest.gitCommit)
      ? manifest.gitCommit : "0000000";
    return {
      gitCommit,
      branch: typeof manifest.branch === "string" ? manifest.branch.slice(0, 128) : "unknown",
      buildVersion: "coordinator",
      dirty: manifest.dirty !== false,
    };
  } catch {
    return { gitCommit: "0000000", branch: "unknown", buildVersion: "coordinator", dirty: true };
  }
}

async function createTaskStateMachine(): Promise<Readonly<{
  stateMachine: PersistentTaskStateMachine;
  pool: PgTaskPoolAdapter | null;
}>> {
  const connectionString = process.env.COORDINATOR_TASK_POSTGRES_URL?.trim();
  if (!connectionString) {
    logger.warn("coordinator_task_persistence_unavailable", {
      durability: "process-local",
      code: "TASK_POSTGRES_NOT_CONFIGURED",
    });
    return {
      stateMachine: new PersistentTaskStateMachine(),
      pool: null,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new Error("COORDINATOR_TASK_POSTGRES_URL is invalid.");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    parsed.hash.length > 0
  ) {
    throw new Error("COORDINATOR_TASK_POSTGRES_URL is invalid.");
  }
  const schemaName = process.env.COORDINATOR_TASK_POSTGRES_SCHEMA?.trim() || "public";
  if (!/^[a-z_][a-z0-9_]{0,62}$/u.test(schemaName)) {
    throw new Error("COORDINATOR_TASK_POSTGRES_SCHEMA is invalid.");
  }
  const pool = new PgTaskPoolAdapter({
    connectionString,
    options: `-c search_path=${schemaName}`,
  });
  await pool.verifyConnection();
  const client = await pool.connect();
  try {
    await client.query("SELECT 1 FROM studio_task_executions LIMIT 0");
  } finally {
    client.release();
  }
  logger.info("coordinator_task_persistence_ready", {
    durability: "postgresql",
  });
  return {
    stateMachine: new PersistentTaskStateMachine({
      store: new PostgresTaskExecutionStore(pool),
    }),
    pool,
  };
}

void main().catch((cause: unknown) => {
  const code =
    cause instanceof RuntimeLinkConfigError ||
      cause instanceof ControlLinkConfigError ||
      cause instanceof LocalAIConfigError ||
      cause instanceof GoalPersistenceConfigError
      || cause instanceof TaskDeliveryConfigError ||
      cause instanceof AutonomousConfigError ||
      cause instanceof GoalStoreWiringError
      ? cause.code
      : "COORDINATOR_START_FAILED";
  logger.error("coordinator_start_failed", {
    code,
    // 通用失败码此前不带原因，现场只能猜。原始消息有界截断进日志。
    detail: (cause instanceof Error ? cause.message : String(cause)).slice(0, 300),
  });
  process.exitCode = 1;
});

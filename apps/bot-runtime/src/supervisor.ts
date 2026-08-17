import {
  fork,
  type ChildProcess,
  type ForkOptions,
  type Serializable,
} from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  BotState,
  CPUResourceManager,
  type CpuResourceManagerSnapshot,
} from "@minecraft-studio/cpu-resource-manager";
import type { AppLogger } from "@minecraft-studio/observability";
import {
  parseSupervisorChildMessage,
  supervisorIpcChallengeV1Schema,
  supervisorIpcChildProofInput,
  supervisorIpcLifecycleProofInput,
  supervisorIpcParentProofInput,
  supervisorIpcStartV1Schema,
  supervisorIpcStopProofInput,
  supervisorIpcStopV1Schema,
  type SupervisorIpcAuthenticateV1,
  type SupervisorIpcChallengeV1,
} from "@minecraft-studio/protocol";

import type { BotSupervisorConfig } from "./supervisor-config.js";
import {
  BoundedIpcSender,
  deriveIpcHmacKey,
  measureIpcPayload,
  signIpcProof,
  verifyIpcProof,
} from "./supervisor-ipc-channel.js";
import {
  createBotSupervisorPlan,
  RestartBudget,
  type BotProcessGroupPlan,
  type BotSupervisorPlan,
} from "./supervisor-plan.js";

const MAX_CLOCK_SKEW_MS = 30_000;
const DEFAULT_CHILD_ENTRY = fileURLToPath(
  new URL("./supervisor-child.js", import.meta.url),
);

export type SupervisorFork = (
  modulePath: string,
  options: ForkOptions,
) => ChildProcess;

export type BotProcessSupervisorOptions = Readonly<{
  config: BotSupervisorConfig;
  logger: AppLogger;
  childEntryPath?: string;
  forkChild?: SupervisorFork;
  cpuResourceManager?: CPUResourceManager;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
  random?: () => number;
  onGroupRestartExhausted?: (groupId: string) => void;
}>;

export type BotProcessGroupSnapshot = Readonly<{
  id: string;
  deploymentTier: BotProcessGroupPlan["deploymentTier"];
  botIds: readonly string[];
  childId: string | null;
  pid: number | null;
  state:
    | "pending"
    | "authenticating"
    | "starting"
    | "ready"
    | "stopping"
    | "backoff"
    | "failed";
  restartAttempt: number;
  readyAt: string | null;
}>;

export type BotProcessSupervisorSnapshot = Readonly<{
  schemaVersion: "1.0";
  supervisorInstanceId: string;
  capturedAt: string;
  started: boolean;
  stopping: boolean;
  plan: BotSupervisorPlan;
  groups: readonly BotProcessGroupSnapshot[];
  cpu: CpuResourceManagerSnapshot;
}>;

type MutableGroupRuntime = {
  plan: BotProcessGroupPlan;
  budget: RestartBudget;
  child: ChildProcess | null;
  childId: string | null;
  pid: number | null;
  state: BotProcessGroupSnapshot["state"];
  restartAttempt: number;
  restartTimer: ReturnType<typeof setTimeout> | null;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  challenge: SupervisorIpcChallengeV1 | null;
  authenticate: SupervisorIpcAuthenticateV1 | null;
  secret: string | null;
  hmacKey: Buffer | null;
  sender: BoundedIpcSender | null;
  lastSequence: number;
  readyAtMs: number | null;
  cpuRegistered: boolean;
  firstReadySettled: boolean;
  resolveFirstReady: () => void;
  rejectFirstReady: (error: Error) => void;
  firstReady: Promise<void>;
};

export class BotProcessSupervisor {
  readonly plan: BotSupervisorPlan;
  readonly supervisorInstanceId: string;

  private readonly config: BotSupervisorConfig;
  private readonly logger: AppLogger;
  private readonly childEntryPath: string;
  private readonly forkChild: SupervisorFork;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly randomNonce: () => string;
  private readonly random: () => number;
  private readonly onGroupRestartExhausted: (groupId: string) => void;
  private readonly cpuResourceManager: CPUResourceManager;
  private readonly liveChildPids: Set<number>;
  private readonly groups = new Map<string, MutableGroupRuntime>();
  private started = false;
  private stopping = false;

  private constructor(
    options: BotProcessSupervisorOptions,
    cpuResourceManager: CPUResourceManager,
    liveChildPids: Set<number>,
  ) {
    this.config = options.config;
    this.logger = options.logger;
    this.childEntryPath = options.childEntryPath ?? DEFAULT_CHILD_ENTRY;
    this.forkChild = options.forkChild ?? ((modulePath, forkOptions) =>
      fork(modulePath, [], forkOptions));
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.randomNonce =
      options.randomNonce ?? (() => randomBytes(32).toString("base64url"));
    this.random = options.random ?? Math.random;
    this.onGroupRestartExhausted = options.onGroupRestartExhausted ?? (() => undefined);
    this.cpuResourceManager = cpuResourceManager;
    this.liveChildPids = liveChildPids;
    this.plan = createBotSupervisorPlan(options.config, cpuResourceManager.topology);
    this.supervisorInstanceId = `bot-supervisor-${process.pid}-${this.randomId().slice(0, 8)}`;
    for (const group of this.plan.groups) {
      this.groups.set(group.id, createMutableGroup(group, options.config, this.random));
    }
  }

  static async create(
    options: BotProcessSupervisorOptions,
  ): Promise<BotProcessSupervisor> {
    const liveChildPids = new Set<number>();
    const cpuResourceManager = options.cpuResourceManager ??
      await CPUResourceManager.create({
        config: options.config.cpuResourceManager,
        pidAuthorizer: (pid) => liveChildPids.has(pid),
        eventSink: (event) => {
          const log = event.type === "CPU_AFFINITY_FAILURE"
            ? options.logger.warn.bind(options.logger)
            : options.logger.info.bind(options.logger);
          log("bot_supervisor_cpu_event", {
            eventType: event.type,
            workloadId: event.workloadId,
            pid: event.pid,
            priority: event.priority,
            pool: event.pool,
            reason: event.reason,
            errorCode: event.errorCode,
          });
        },
      });
    return new BotProcessSupervisor(
      options,
      cpuResourceManager,
      liveChildPids,
    );
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Bot Process Supervisor 已经启动。");
    this.started = true;
    this.stopping = false;
    this.cpuResourceManager.start();
    for (const warning of this.plan.warnings) {
      this.logger.warn("bot_supervisor_plan_warning", { code: warning });
    }
    for (const runtime of this.groups.values()) this.spawnAttempt(runtime);
    try {
      await Promise.all(
        [...this.groups.values()].map((runtime) => runtime.firstReady),
      );
    } catch (error) {
      if (this.stopping) return;
      await this.stop("initial_start_failed");
      throw error;
    }
  }

  async stop(reason = "supervisor_shutdown"): Promise<void> {
    if (!this.started || this.stopping) return;
    this.stopping = true;
    for (const runtime of this.groups.values()) {
      if (runtime.restartTimer) clearTimeout(runtime.restartTimer);
      runtime.restartTimer = null;
    }
    await Promise.all(
      [...this.groups.values()].map((runtime) => this.stopGroup(runtime, reason)),
    );
    for (const runtime of this.groups.values()) {
      if (runtime.firstReadySettled) continue;
      runtime.firstReadySettled = true;
      runtime.rejectFirstReady(
        new Error(`Bot 进程组 ${runtime.plan.id} 在启动完成前停止。`),
      );
    }
    this.cpuResourceManager.stop();
    this.started = false;
  }

  snapshot(): BotProcessSupervisorSnapshot {
    return Object.freeze({
      schemaVersion: "1.0",
      supervisorInstanceId: this.supervisorInstanceId,
      capturedAt: validNow(this.now).toISOString(),
      started: this.started,
      stopping: this.stopping,
      plan: this.plan,
      groups: Object.freeze(
        [...this.groups.values()].map((runtime) =>
          Object.freeze({
            id: runtime.plan.id,
            deploymentTier: runtime.plan.deploymentTier,
            botIds: Object.freeze(
              runtime.plan.bots.map((bot) => bot.assignment.botId),
            ),
            childId: runtime.childId,
            pid: runtime.pid,
            state: runtime.state,
            restartAttempt: runtime.restartAttempt,
            readyAt:
              runtime.readyAtMs === null
                ? null
                : new Date(runtime.readyAtMs).toISOString(),
          }),
        ),
      ),
      cpu: this.cpuResourceManager.snapshot(),
    });
  }

  private spawnAttempt(runtime: MutableGroupRuntime): void {
    if (this.stopping) return;
    this.resetAttempt(runtime);
    const childId = `child-${runtime.plan.id}-${runtime.restartAttempt}-${this.randomId().slice(0, 8)}`;
    const secret = this.randomNonce();
    const hmacKey = deriveIpcHmacKey(secret);
    const environment = childEnvironment(
      process.env,
      this.supervisorInstanceId,
      childId,
      runtime.plan.id,
      secret,
      this.config,
    );

    let child: ChildProcess;
    try {
      child = this.forkChild(this.childEntryPath, {
        cwd: process.cwd(),
        env: environment,
        execArgv: [],
        serialization: "json",
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
    } catch {
      this.handleAttemptFailure(runtime, "CHILD_FORK_FAILED");
      return;
    }
    const pid = child.pid;
    if (!pid) {
      child.kill("SIGTERM");
      this.handleAttemptFailure(runtime, "CHILD_PID_UNAVAILABLE");
      return;
    }

    runtime.child = child;
    runtime.childId = childId;
    runtime.pid = pid;
    runtime.secret = secret;
    runtime.hmacKey = hmacKey;
    runtime.state = "authenticating";
    this.liveChildPids.add(pid);
    runtime.sender = new BoundedIpcSender(
      (message, callback) => child.send(message as Serializable, callback),
      this.config.ipc,
    );
    child.on("message", (input) => {
      void this.handleChildMessage(runtime, child, input).catch((error: unknown) => {
        this.logger.error("bot_supervisor_ipc_rejected", {
          groupId: runtime.plan.id,
          childId,
          code: errorCode(error),
        });
        child.kill("SIGTERM");
      });
    });
    child.once("error", () => {
      this.logger.warn("bot_supervisor_child_error", {
        groupId: runtime.plan.id,
        childId,
        code: "CHILD_PROCESS_ERROR",
      });
    });
    child.once("close", (code, signal) => {
      void this.handleChildExit(runtime, child, code, signal);
    });

    const challenge = supervisorIpcChallengeV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validNow(this.now).toISOString(),
      type: "supervisor.ipc.challenge.v1",
      payload: {
        supervisorInstanceId: this.supervisorInstanceId,
        childId,
        groupId: runtime.plan.id,
        challengeNonce: this.randomNonce(),
      },
    });
    runtime.challenge = challenge;
    runtime.handshakeTimer = setTimeout(() => {
      this.logger.warn("bot_supervisor_handshake_timeout", {
        groupId: runtime.plan.id,
        childId,
        code: "IPC_HANDSHAKE_TIMEOUT",
      });
      child.kill("SIGTERM");
    }, this.config.ipc.handshakeTimeoutMs);
    void runtime.sender.send(challenge).catch(() => child.kill("SIGTERM"));
  }

  private async handleChildMessage(
    runtime: MutableGroupRuntime,
    child: ChildProcess,
    input: unknown,
  ): Promise<void> {
    if (runtime.child !== child) return;
    measureIpcPayload(input);
    const message = parseSupervisorChildMessage(input);
    if (!timestampWithinSkew(message.timestamp, this.now())) {
      throw new Error("IPC_MESSAGE_EXPIRED");
    }
    if (message.type === "supervisor.ipc.authenticate.v1") {
      if (this.stopping) return;
      await this.acceptAuthentication(runtime, child, message);
      return;
    }
    await this.acceptLifecycle(runtime, child, message);
  }

  private async acceptAuthentication(
    runtime: MutableGroupRuntime,
    child: ChildProcess,
    message: SupervisorIpcAuthenticateV1,
  ): Promise<void> {
    const challenge = runtime.challenge;
    const hmacKey = runtime.hmacKey;
    const pid = runtime.pid;
    if (
      runtime.state !== "authenticating" ||
      runtime.authenticate ||
      !challenge ||
      !hmacKey ||
      !pid ||
      !runtime.childId
    ) {
      throw new Error("IPC_AUTH_UNEXPECTED");
    }
    assertSession(
      message.payload,
      this.supervisorInstanceId,
      runtime.childId,
      runtime.plan.id,
    );
    if (
      message.payload.challengeMessageId !== challenge.messageId ||
      message.payload.challengeNonce !== challenge.payload.challengeNonce ||
      message.payload.childPid !== pid
    ) {
      throw new Error("IPC_AUTH_CONTEXT_MISMATCH");
    }
    const context = {
      supervisorInstanceId: this.supervisorInstanceId,
      childId: runtime.childId,
      groupId: runtime.plan.id,
      challengeMessageId: challenge.messageId,
      challengeNonce: challenge.payload.challengeNonce,
      childNonce: message.payload.childNonce,
      childPid: pid,
    };
    if (
      !verifyIpcProof(
        hmacKey,
        supervisorIpcChildProofInput(context),
        message.payload.childProof,
      )
    ) {
      throw new Error("IPC_CHILD_AUTH_FAILED");
    }
    runtime.authenticate = message;

    try {
      await this.cpuResourceManager.assignProcess({
        id: workloadId(runtime.plan.id),
        pid,
        kind: "minecraft-bot",
        deploymentTier: runtime.plan.deploymentTier,
        state: BotState.IDLE,
      });
      runtime.cpuRegistered = true;
    } catch {
      this.logger.warn("bot_supervisor_cpu_assignment_failed", {
        groupId: runtime.plan.id,
        childId: runtime.childId,
        pid,
        code: "CPU_ASSIGNMENT_CONTINUED_WITHOUT_EXIT",
      });
    }

    const assignments = runtime.plan.bots.map((bot) => bot.assignment);
    const startContext = {
      ...context,
      authenticateMessageId: message.messageId,
      assignments,
    };
    const start = supervisorIpcStartV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.randomId(),
      timestamp: validNow(this.now).toISOString(),
      type: "supervisor.ipc.start.v1",
      payload: {
        supervisorInstanceId: this.supervisorInstanceId,
        childId: runtime.childId,
        groupId: runtime.plan.id,
        challengeMessageId: challenge.messageId,
        authenticateMessageId: message.messageId,
        challengeNonce: challenge.payload.challengeNonce,
        childNonce: message.payload.childNonce,
        assignments,
        parentProof: signIpcProof(
          hmacKey,
          supervisorIpcParentProofInput(startContext),
        ),
      },
    });
    await runtime.sender?.send(start);
  }

  private async acceptLifecycle(
    runtime: MutableGroupRuntime,
    child: ChildProcess,
    message: Extract<
      ReturnType<typeof parseSupervisorChildMessage>,
      { type: "supervisor.ipc.lifecycle.v1" }
    >,
  ): Promise<void> {
    const hmacKey = runtime.hmacKey;
    const pid = runtime.pid;
    if (!runtime.authenticate || !runtime.childId || !hmacKey || !pid) {
      throw new Error("IPC_LIFECYCLE_BEFORE_AUTH");
    }
    assertSession(
      message.payload,
      this.supervisorInstanceId,
      runtime.childId,
      runtime.plan.id,
    );
    const expectedBotIds = runtime.plan.bots.map((bot) => bot.assignment.botId);
    if (
      message.payload.childPid !== pid ||
      message.payload.sequence !== runtime.lastSequence + 1 ||
      JSON.stringify(message.payload.botIds) !== JSON.stringify(expectedBotIds)
    ) {
      throw new Error("IPC_LIFECYCLE_CONTEXT_MISMATCH");
    }
    const proofContext = {
      supervisorInstanceId: this.supervisorInstanceId,
      childId: runtime.childId,
      groupId: runtime.plan.id,
      childPid: pid,
      sequence: message.payload.sequence,
      state: message.payload.state,
      botIds: message.payload.botIds,
      ...(message.payload.code ? { code: message.payload.code } : {}),
    };
    if (
      !verifyIpcProof(
        hmacKey,
        supervisorIpcLifecycleProofInput(proofContext),
        message.payload.proof,
      )
    ) {
      throw new Error("IPC_LIFECYCLE_AUTH_FAILED");
    }
    runtime.lastSequence = message.payload.sequence;

    switch (message.payload.state) {
      case "starting":
        runtime.state = "starting";
        break;
      case "ready":
        runtime.state = "ready";
        runtime.readyAtMs = validNow(this.now).getTime();
        clearHandshakeTimer(runtime);
        runtime.secret = null;
        if (!runtime.firstReadySettled) {
          runtime.firstReadySettled = true;
          runtime.resolveFirstReady();
        }
        this.logger.info("bot_supervisor_group_ready", {
          groupId: runtime.plan.id,
          childId: runtime.childId,
          pid,
          botCount: runtime.plan.bots.length,
          deploymentTier: runtime.plan.deploymentTier,
        });
        break;
      case "stopping":
        runtime.state = "stopping";
        break;
      case "stopped":
        runtime.state = "stopping";
        await this.releaseCpu(runtime);
        break;
      case "failed":
        runtime.state = "failed";
        this.logger.error("bot_supervisor_group_failed", {
          groupId: runtime.plan.id,
          childId: runtime.childId,
          pid,
          code: message.payload.code ?? "CHILD_FAILED",
        });
        break;
    }
    void child;
  }

  private async handleChildExit(
    runtime: MutableGroupRuntime,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<void> {
    if (runtime.child !== child) return;
    clearHandshakeTimer(runtime);
    await this.releaseCpu(runtime);
    if (runtime.pid !== null) this.liveChildPids.delete(runtime.pid);
    const previousPid = runtime.pid;
    runtime.child = null;
    runtime.pid = null;
    runtime.sender = null;
    runtime.secret = null;
    runtime.hmacKey = null;
    runtime.challenge = null;
    runtime.authenticate = null;
    runtime.lastSequence = 0;
    if (this.stopping) {
      runtime.state = "pending";
      return;
    }
    this.logger.warn("bot_supervisor_child_exited", {
      groupId: runtime.plan.id,
      childId: runtime.childId,
      pid: previousPid,
      exitCode: code,
      signal,
    });
    this.handleAttemptFailure(runtime, "CHILD_EXITED");
  }

  private handleAttemptFailure(
    runtime: MutableGroupRuntime,
    code: string,
  ): void {
    if (this.stopping) return;
    const decision = runtime.budget.recordFailure(
      validNow(this.now).getTime(),
      runtime.readyAtMs,
    );
    runtime.readyAtMs = null;
    if (!decision.allowed || decision.delayMs === null) {
      runtime.state = "failed";
      const error = new Error(
        `Bot 进程组 ${runtime.plan.id} 的重启预算已耗尽。`,
      );
      if (!runtime.firstReadySettled) {
        runtime.firstReadySettled = true;
        runtime.rejectFirstReady(error);
      }
      this.logger.error("bot_supervisor_restart_exhausted", {
        groupId: runtime.plan.id,
        code,
        reason: decision.reason,
        attempt: decision.attempt,
      });
      this.onGroupRestartExhausted(runtime.plan.id);
      return;
    }
    runtime.restartAttempt = decision.attempt;
    runtime.state = "backoff";
    this.logger.warn("bot_supervisor_restart_scheduled", {
      groupId: runtime.plan.id,
      code,
      attempt: decision.attempt,
      delayMs: decision.delayMs,
    });
    runtime.restartTimer = setTimeout(() => {
      runtime.restartTimer = null;
      this.spawnAttempt(runtime);
    }, decision.delayMs);
  }

  private async stopGroup(
    runtime: MutableGroupRuntime,
    reason: string,
  ): Promise<void> {
    const child = runtime.child;
    if (!child) {
      await this.releaseCpu(runtime);
      runtime.state = "pending";
      return;
    }
    runtime.state = "stopping";
    const exitPromise = waitForExit(child);
    if (runtime.authenticate && runtime.hmacKey && runtime.sender && runtime.childId) {
      const context = {
        supervisorInstanceId: this.supervisorInstanceId,
        childId: runtime.childId,
        groupId: runtime.plan.id,
        reason,
      };
      const stop = supervisorIpcStopV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        timestamp: validNow(this.now).toISOString(),
        type: "supervisor.ipc.stop.v1",
        payload: {
          ...context,
          proof: signIpcProof(
            runtime.hmacKey,
            supervisorIpcStopProofInput(context),
          ),
        },
      });
      await runtime.sender.send(stop).catch(() => child.kill("SIGTERM"));
    } else {
      child.kill("SIGTERM");
    }

    const exited = await Promise.race([
      exitPromise.then(() => true),
      delay(this.config.ipc.gracefulShutdownMs).then(() => false),
    ]);
    if (!exited) {
      this.logger.warn("bot_supervisor_graceful_stop_timeout", {
        groupId: runtime.plan.id,
        childId: runtime.childId,
        pid: runtime.pid,
        code: "GRACEFUL_STOP_TIMEOUT_SIGTERM",
      });
      child.kill("SIGTERM");
    }
    await this.releaseCpu(runtime);
  }

  private async releaseCpu(runtime: MutableGroupRuntime): Promise<void> {
    if (!runtime.cpuRegistered) return;
    runtime.cpuRegistered = false;
    await this.cpuResourceManager
      .releaseResources(workloadId(runtime.plan.id))
      .catch(() => undefined);
  }

  private resetAttempt(runtime: MutableGroupRuntime): void {
    clearHandshakeTimer(runtime);
    runtime.child = null;
    runtime.childId = null;
    runtime.pid = null;
    runtime.state = "pending";
    runtime.challenge = null;
    runtime.authenticate = null;
    runtime.secret = null;
    runtime.hmacKey = null;
    runtime.sender = null;
    runtime.lastSequence = 0;
    runtime.cpuRegistered = false;
  }
}

function createMutableGroup(
  plan: BotProcessGroupPlan,
  config: BotSupervisorConfig,
  random: () => number,
): MutableGroupRuntime {
  let resolveFirstReady: () => void = () => undefined;
  let rejectFirstReady: (error: Error) => void = () => undefined;
  const firstReady = new Promise<void>((resolve, reject) => {
    resolveFirstReady = resolve;
    rejectFirstReady = reject;
  });
  return {
    plan,
    budget: new RestartBudget(config.restart, random),
    child: null,
    childId: null,
    pid: null,
    state: "pending",
    restartAttempt: 0,
    restartTimer: null,
    handshakeTimer: null,
    challenge: null,
    authenticate: null,
    secret: null,
    hmacKey: null,
    sender: null,
    lastSequence: 0,
    readyAtMs: null,
    cpuRegistered: false,
    firstReadySettled: false,
    resolveFirstReady,
    rejectFirstReady,
    firstReady,
  };
}

function childEnvironment(
  source: NodeJS.ProcessEnv,
  supervisorInstanceId: string,
  childId: string,
  groupId: string,
  secret: string,
  config: BotSupervisorConfig,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of ["LANG", "LC_ALL", "TZ", "TMPDIR", "TMP", "TEMP"] as const) {
    if (source[name]) environment[name] = source[name];
  }
  return {
    ...environment,
    NODE_ENV: source.NODE_ENV ?? "production",
    BOT_SUPERVISOR_INSTANCE_ID: supervisorInstanceId,
    BOT_SUPERVISOR_CHILD_ID: childId,
    BOT_SUPERVISOR_GROUP_ID: groupId,
    BOT_SUPERVISOR_IPC_SECRET: secret,
    BOT_SUPERVISOR_IPC_HANDSHAKE_TIMEOUT_MS: String(
      config.ipc.handshakeTimeoutMs,
    ),
    BOT_SUPERVISOR_IPC_SEND_TIMEOUT_MS: String(config.ipc.sendTimeoutMs),
    BOT_SUPERVISOR_IPC_MAX_QUEUED_MESSAGES: String(
      config.ipc.maxQueuedMessages,
    ),
    BOT_SUPERVISOR_IPC_MAX_QUEUED_BYTES: String(config.ipc.maxQueuedBytes),
  };
}

function assertSession(
  input: { supervisorInstanceId: string; childId: string; groupId: string },
  supervisorInstanceId: string,
  childId: string,
  groupId: string,
): void {
  if (
    input.supervisorInstanceId !== supervisorInstanceId ||
    input.childId !== childId ||
    input.groupId !== groupId
  ) {
    throw new Error("IPC_SESSION_MISMATCH");
  }
}

function clearHandshakeTimer(runtime: MutableGroupRuntime): void {
  if (runtime.handshakeTimer) clearTimeout(runtime.handshakeTimer);
  runtime.handshakeTimer = null;
}

function timestampWithinSkew(value: string, now: Date): boolean {
  const timestamp = Date.parse(value);
  return (
    Number.isFinite(timestamp) &&
    Number.isFinite(now.getTime()) &&
    Math.abs(now.getTime() - timestamp) <= MAX_CLOCK_SKEW_MS
  );
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new Error("Supervisor 时钟无效。");
  return value;
}

function workloadId(groupId: string): string {
  return `bot-process:${groupId}`;
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("close", () => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 128);
  }
  if (error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)) {
    return error.message.slice(0, 128);
  }
  return "UNEXPECTED_ERROR";
}

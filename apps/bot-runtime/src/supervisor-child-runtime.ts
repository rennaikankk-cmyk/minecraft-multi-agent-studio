import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

import {
  createStructuredLogger,
  type AppLogger,
} from "@minecraft-studio/observability";
import {
  parseSupervisorParentMessage,
  supervisorIpcAuthenticateV1Schema,
  supervisorIpcChildProofInput,
  supervisorIpcLifecycleProofInput,
  supervisorIpcLifecycleV1Schema,
  supervisorIpcParentProofInput,
  supervisorIpcStopProofInput,
  type SupervisorBotAssignmentV1,
  type SupervisorIpcAuthenticateV1,
  type SupervisorIpcChallengeV1,
} from "@minecraft-studio/protocol";

import { BotRuntimeHost } from "./runtime-host.js";
import { loadRuntimeLinkConfig } from "./runtime-link-config.js";
import { serverProfileSchema } from "./server-profile.js";
import type { BotSupervisorIpcConfig } from "./supervisor-config.js";
import {
  BoundedIpcSender,
  deriveIpcHmacKey,
  measureIpcPayload,
  signIpcProof,
  verifyIpcProof,
} from "./supervisor-ipc-channel.js";

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_PROFILE_BYTES = 64 * 1_024;
const MAX_CLOCK_SKEW_MS = 30_000;

export type SupervisorManagedHost = Readonly<{
  start(): Promise<void>;
  stop(reason: string): Promise<unknown>;
}>;

export type SupervisorHostFactory = (
  assignment: SupervisorBotAssignmentV1,
  onFatal: () => void,
) => Promise<SupervisorManagedHost>;

export type SupervisorChildRuntimeOptions = Readonly<{
  environment?: NodeJS.ProcessEnv;
  createHost?: SupervisorHostFactory;
  logger?: AppLogger;
  now?: () => Date;
  randomId?: () => string;
  randomNonce?: () => string;
}>;

type ChildBootstrap = Readonly<{
  supervisorInstanceId: string;
  childId: string;
  groupId: string;
  secret: string;
  ipc: BotSupervisorIpcConfig;
}>;

type ChildPhase =
  | "awaiting_challenge"
  | "awaiting_start"
  | "starting"
  | "running"
  | "stopping"
  | "closed";

export class SupervisorChildRuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "SupervisorChildRuntimeError";
  }
}

export async function runSupervisorChildRuntime(
  options: SupervisorChildRuntimeOptions = {},
): Promise<void> {
  const bootstrap = loadChildBootstrap(options.environment ?? process.env);
  delete process.env.BOT_SUPERVISOR_IPC_SECRET;
  if (!process.send) {
    throw new SupervisorChildRuntimeError(
      "IPC_CHANNEL_REQUIRED",
      "Supervisor 子进程必须通过 Node IPC 启动。",
    );
  }

  const logger = options.logger ?? createStructuredLogger({
    service: "bot-runtime-child",
    instanceId: bootstrap.childId,
  });
  const controller = new SupervisorChildController({
    bootstrap,
    logger,
    createHost: options.createHost ?? createProductionHost,
    now: options.now ?? (() => new Date()),
    randomId: options.randomId ?? randomUUID,
    randomNonce:
      options.randomNonce ?? (() => randomBytes(32).toString("base64url")),
    sender: new BoundedIpcSender(
      (message, callback) => process.send?.(message, callback) ?? false,
      bootstrap.ipc,
    ),
  });
  await controller.run();
}

class SupervisorChildController {
  private readonly hmacKey: Buffer;
  private readonly hosts: SupervisorManagedHost[] = [];
  private phase: ChildPhase = "awaiting_challenge";
  private challenge: SupervisorIpcChallengeV1 | null = null;
  private authenticate: SupervisorIpcAuthenticateV1 | null = null;
  private childNonce: string | null = null;
  private botIds: readonly string[] = [];
  private sequence = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private settled = false;
  private resolveCompletion: (() => void) | null = null;
  private rejectCompletion: ((error: Error) => void) | null = null;

  constructor(private readonly options: Readonly<{
    bootstrap: ChildBootstrap;
    logger: AppLogger;
    createHost: SupervisorHostFactory;
    now: () => Date;
    randomId: () => string;
    randomNonce: () => string;
    sender: BoundedIpcSender;
  }>) {
    this.hmacKey = deriveIpcHmacKey(options.bootstrap.secret);
  }

  run(): Promise<void> {
    const completion = new Promise<void>((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;
    });
    process.on("message", this.handleMessage);
    process.once("disconnect", this.handleDisconnect);
    process.once("SIGINT", this.handleSignal);
    process.once("SIGTERM", this.handleSignal);
    this.startTimer("IPC_CHALLENGE_TIMEOUT");
    return completion.finally(() => this.cleanupListeners());
  }

  private readonly handleMessage = (input: unknown): void => {
    void this.processMessage(input).catch((error: unknown) =>
      this.fail(errorCode(error)),
    );
  };

  private readonly handleDisconnect = (): void => {
    if (this.phase === "closed" || this.phase === "stopping") return;
    void this.fail("IPC_PARENT_DISCONNECTED");
  };

  private readonly handleSignal = (signal: NodeJS.Signals): void => {
    void this.stop(`signal_${signal.toLowerCase()}`, false);
  };

  private async processMessage(input: unknown): Promise<void> {
    measureIpcPayload(input);
    const message = parseSupervisorParentMessage(input);
    if (!timestampWithinSkew(message.timestamp, this.options.now())) {
      throw new SupervisorChildRuntimeError(
        "IPC_MESSAGE_EXPIRED",
        "Supervisor IPC 消息时间戳已过期。",
      );
    }
    if (message.type === "supervisor.ipc.challenge.v1") {
      await this.acceptChallenge(message);
      return;
    }
    if (message.type === "supervisor.ipc.start.v1") {
      await this.acceptStart(message);
      return;
    }
    await this.acceptStop(message);
  }

  private async acceptChallenge(
    challenge: SupervisorIpcChallengeV1,
  ): Promise<void> {
    if (this.phase !== "awaiting_challenge" || this.challenge) {
      throw new SupervisorChildRuntimeError(
        "IPC_CHALLENGE_REPLAYED",
        "Supervisor IPC challenge 重复或顺序错误。",
      );
    }
    this.assertSession(challenge.payload);
    const childNonce = this.options.randomNonce();
    const context = {
      supervisorInstanceId: challenge.payload.supervisorInstanceId,
      childId: challenge.payload.childId,
      groupId: challenge.payload.groupId,
      challengeMessageId: challenge.messageId,
      challengeNonce: challenge.payload.challengeNonce,
      childNonce,
      childPid: process.pid,
    };
    const authenticate = supervisorIpcAuthenticateV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.options.randomId(),
      timestamp: validNow(this.options.now).toISOString(),
      type: "supervisor.ipc.authenticate.v1",
      payload: {
        ...context,
        childProof: signIpcProof(
          this.hmacKey,
          supervisorIpcChildProofInput(context),
        ),
      },
    });
    this.challenge = challenge;
    this.authenticate = authenticate;
    this.childNonce = childNonce;
    this.phase = "awaiting_start";
    this.startTimer("IPC_START_TIMEOUT");
    await this.options.sender.send(authenticate);
  }

  private async acceptStart(
    message: Extract<
      ReturnType<typeof parseSupervisorParentMessage>,
      { type: "supervisor.ipc.start.v1" }
    >,
  ): Promise<void> {
    const challenge = this.challenge;
    const authenticate = this.authenticate;
    const childNonce = this.childNonce;
    if (
      this.phase !== "awaiting_start" ||
      !challenge ||
      !authenticate ||
      !childNonce
    ) {
      throw new SupervisorChildRuntimeError(
        "IPC_START_UNEXPECTED",
        "Supervisor IPC start 消息顺序错误。",
      );
    }
    this.assertSession(message.payload);
    if (
      message.payload.challengeMessageId !== challenge.messageId ||
      message.payload.authenticateMessageId !== authenticate.messageId ||
      message.payload.challengeNonce !== challenge.payload.challengeNonce ||
      message.payload.childNonce !== childNonce
    ) {
      throw new SupervisorChildRuntimeError(
        "IPC_START_CONTEXT_MISMATCH",
        "Supervisor IPC start 会话上下文不匹配。",
      );
    }
    const context = {
      supervisorInstanceId: this.options.bootstrap.supervisorInstanceId,
      childId: this.options.bootstrap.childId,
      groupId: this.options.bootstrap.groupId,
      challengeMessageId: challenge.messageId,
      challengeNonce: challenge.payload.challengeNonce,
      childNonce,
      childPid: process.pid,
      authenticateMessageId: authenticate.messageId,
      assignments: message.payload.assignments,
    };
    if (
      !verifyIpcProof(
        this.hmacKey,
        supervisorIpcParentProofInput(context),
        message.payload.parentProof,
      )
    ) {
      throw new SupervisorChildRuntimeError(
        "IPC_PARENT_AUTH_FAILED",
        "Supervisor 父进程认证失败。",
      );
    }

    this.clearTimer();
    this.botIds = Object.freeze(
      message.payload.assignments.map((assignment) => assignment.botId),
    );
    this.phase = "starting";
    await this.sendLifecycle("starting");
    for (const assignment of message.payload.assignments) {
      const host = await this.options.createHost(assignment, () => {
        void this.fail("RUNTIME_LINK_FAIL_CLOSED");
      });
      this.hosts.push(host);
    }
    await Promise.all(this.hosts.map((host) => host.start()));
    if (this.phase !== "starting") return;
    this.phase = "running";
    await this.sendLifecycle("ready");
  }

  private async acceptStop(
    message: Extract<
      ReturnType<typeof parseSupervisorParentMessage>,
      { type: "supervisor.ipc.stop.v1" }
    >,
  ): Promise<void> {
    if (this.phase !== "running") {
      throw new SupervisorChildRuntimeError(
        "IPC_STOP_UNEXPECTED",
        "Supervisor IPC stop 消息顺序错误。",
      );
    }
    this.assertSession(message.payload);
    const input = supervisorIpcStopProofInput({
      supervisorInstanceId: message.payload.supervisorInstanceId,
      childId: message.payload.childId,
      groupId: message.payload.groupId,
      reason: message.payload.reason,
    });
    if (!verifyIpcProof(this.hmacKey, input, message.payload.proof)) {
      throw new SupervisorChildRuntimeError(
        "IPC_STOP_AUTH_FAILED",
        "Supervisor IPC stop 认证失败。",
      );
    }
    await this.stop(message.payload.reason, true);
  }

  private async sendLifecycle(
    state: "starting" | "ready" | "stopping" | "stopped" | "failed",
    code?: string,
  ): Promise<void> {
    if (this.botIds.length === 0) return;
    this.sequence += 1;
    const context = {
      supervisorInstanceId: this.options.bootstrap.supervisorInstanceId,
      childId: this.options.bootstrap.childId,
      groupId: this.options.bootstrap.groupId,
      childPid: process.pid,
      sequence: this.sequence,
      state,
      botIds: this.botIds,
      ...(code ? { code } : {}),
    };
    const message = supervisorIpcLifecycleV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.options.randomId(),
      timestamp: validNow(this.options.now).toISOString(),
      type: "supervisor.ipc.lifecycle.v1",
      payload: {
        ...context,
        proof: signIpcProof(
          this.hmacKey,
          supervisorIpcLifecycleProofInput(context),
        ),
      },
    });
    await this.options.sender.send(message);
  }

  private async stop(reason: string, notifyParent: boolean): Promise<void> {
    if (this.phase === "closed" || this.phase === "stopping") return;
    this.clearTimer();
    this.phase = "stopping";
    if (notifyParent) {
      await this.sendLifecycle("stopping").catch(() => undefined);
    }
    await Promise.allSettled(this.hosts.map((host) => host.stop(reason)));
    if (notifyParent) {
      await this.sendLifecycle("stopped").catch(() => undefined);
    }
    this.phase = "closed";
    this.settled = true;
    this.resolveCompletion?.();
    if (process.connected) process.disconnect?.();
  }

  private async fail(code: string): Promise<void> {
    if (this.phase === "closed" || this.settled) return;
    this.clearTimer();
    const canNotify = this.botIds.length > 0 && process.connected;
    if (canNotify) {
      await this.sendLifecycle("failed", code).catch(() => undefined);
    }
    this.phase = "stopping";
    await Promise.allSettled(
      this.hosts.map((host) => host.stop(`supervisor_child_${code.toLowerCase()}`)),
    );
    this.phase = "closed";
    this.settled = true;
    this.options.logger.error("bot_supervisor_child_failed", { code });
    this.rejectCompletion?.(
      new SupervisorChildRuntimeError(code, "Supervisor 子进程安全关闭。"),
    );
    if (process.connected) process.disconnect?.();
  }

  private assertSession(input: {
    supervisorInstanceId: string;
    childId: string;
    groupId: string;
  }): void {
    if (
      input.supervisorInstanceId !== this.options.bootstrap.supervisorInstanceId ||
      input.childId !== this.options.bootstrap.childId ||
      input.groupId !== this.options.bootstrap.groupId
    ) {
      throw new SupervisorChildRuntimeError(
        "IPC_SESSION_MISMATCH",
        "Supervisor IPC 会话身份不匹配。",
      );
    }
  }

  private startTimer(code: string): void {
    this.clearTimer();
    this.timer = setTimeout(
      () => void this.fail(code),
      this.options.bootstrap.ipc.handshakeTimeoutMs,
    );
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private cleanupListeners(): void {
    this.clearTimer();
    process.off("message", this.handleMessage);
    process.off("disconnect", this.handleDisconnect);
    process.off("SIGINT", this.handleSignal);
    process.off("SIGTERM", this.handleSignal);
  }
}

async function createProductionHost(
  assignment: SupervisorBotAssignmentV1,
  onFatal: () => void,
): Promise<SupervisorManagedHost> {
  let information: Awaited<ReturnType<typeof stat>>;
  try {
    information = await stat(assignment.profilePath);
  } catch {
    throw new SupervisorChildRuntimeError(
      "PROFILE_UNREADABLE",
      "子进程无法读取 ServerProfile。",
    );
  }
  if (!information.isFile() || information.size > MAX_PROFILE_BYTES) {
    throw new SupervisorChildRuntimeError(
      "PROFILE_INVALID_FILE",
      "子进程拒绝 ServerProfile 文件。",
    );
  }
  const contents = await readFile(assignment.profilePath);
  const digest = createHash("sha256").update(contents).digest("hex");
  if (digest !== assignment.profileSha256) {
    throw new SupervisorChildRuntimeError(
      "PROFILE_DIGEST_MISMATCH",
      "ServerProfile 在父子进程交接期间发生变化。",
    );
  }
  let input: unknown;
  try {
    input = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new SupervisorChildRuntimeError(
      "PROFILE_INVALID_JSON",
      "ServerProfile 不是合法 JSON。",
    );
  }
  const profile = serverProfileSchema.parse(input);
  if (profile.botId !== assignment.botId) {
    throw new SupervisorChildRuntimeError(
      "PROFILE_IDENTITY_MISMATCH",
      "ServerProfile Bot 身份与启动清单不一致。",
    );
  }
  const runtimeLinkConfig = loadRuntimeLinkConfig({
    BOT_RUNTIME_LINK_URL: assignment.runtimeLink.url,
    BOT_RUNTIME_LINK_KEY_ID: assignment.runtimeLink.keyId,
    BOT_RUNTIME_LINK_SECRET: assignment.runtimeLink.secret,
  });
  const logger = createStructuredLogger({
    service: "bot-runtime",
    instanceId: `bot-runtime-${process.pid}-${profile.botId}`.slice(0, 128),
  });
  return new BotRuntimeHost({
    profile,
    runtimeLinkConfig,
    logger,
    onFatal,
  });
}

function loadChildBootstrap(environment: NodeJS.ProcessEnv): ChildBootstrap {
  const supervisorInstanceId = requiredIdentifier(
    environment.BOT_SUPERVISOR_INSTANCE_ID,
    "BOT_SUPERVISOR_INSTANCE_ID",
  );
  const childId = requiredIdentifier(
    environment.BOT_SUPERVISOR_CHILD_ID,
    "BOT_SUPERVISOR_CHILD_ID",
  );
  const groupId = requiredIdentifier(
    environment.BOT_SUPERVISOR_GROUP_ID,
    "BOT_SUPERVISOR_GROUP_ID",
  );
  const secret = environment.BOT_SUPERVISOR_IPC_SECRET ?? "";
  if (secret.length !== 43 || !/^[A-Za-z0-9_-]+$/u.test(secret)) {
    throw new SupervisorChildRuntimeError(
      "IPC_SECRET_INVALID",
      "Supervisor IPC 会话密钥无效。",
    );
  }
  return Object.freeze({
    supervisorInstanceId,
    childId,
    groupId,
    secret,
    ipc: Object.freeze({
      handshakeTimeoutMs: boundedInteger(
        environment.BOT_SUPERVISOR_IPC_HANDSHAKE_TIMEOUT_MS,
        500,
        30_000,
      ),
      sendTimeoutMs: boundedInteger(
        environment.BOT_SUPERVISOR_IPC_SEND_TIMEOUT_MS,
        100,
        30_000,
      ),
      gracefulShutdownMs: 30_000,
      maxQueuedMessages: boundedInteger(
        environment.BOT_SUPERVISOR_IPC_MAX_QUEUED_MESSAGES,
        1,
        256,
      ),
      maxQueuedBytes: boundedInteger(
        environment.BOT_SUPERVISOR_IPC_MAX_QUEUED_BYTES,
        1_024,
        4 * 1_024 * 1_024,
      ),
    }),
  });
}

function requiredIdentifier(value: string | undefined, name: string): string {
  if (!value || !IDENTIFIER_PATTERN.test(value)) {
    throw new SupervisorChildRuntimeError(
      "IPC_BOOTSTRAP_INVALID",
      `${name} 无效。`,
    );
  }
  return value;
}

function boundedInteger(
  value: string | undefined,
  minimum: number,
  maximum: number,
): number {
  if (!value || !/^[0-9]+$/u.test(value)) {
    throw new SupervisorChildRuntimeError(
      "IPC_BOOTSTRAP_INVALID",
      "Supervisor IPC 数值配置无效。",
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new SupervisorChildRuntimeError(
      "IPC_BOOTSTRAP_INVALID",
      "Supervisor IPC 数值配置超出边界。",
    );
  }
  return parsed;
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
  if (!Number.isFinite(value.getTime())) {
    throw new SupervisorChildRuntimeError(
      "IPC_CLOCK_INVALID",
      "Supervisor 子进程时钟无效。",
    );
  }
  return value;
}

function errorCode(error: unknown): string {
  if (error instanceof SupervisorChildRuntimeError) return error.code;
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code.slice(0, 128);
  }
  return "IPC_PROTOCOL_INVALID";
}

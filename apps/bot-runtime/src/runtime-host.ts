import type { AppLogger } from "@minecraft-studio/observability";
import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";

import type { BotClientFactory } from "./client.js";
import { CombatReactionLoopProbe } from "./combat-reflex-probe.js";
import { createMineflayerClient } from "./mineflayer-client.js";
import {
  RuntimeLinkClient,
  type RuntimeLinkClientError,
} from "./runtime-link-client.js";
import type { RuntimeLinkClientConfig } from "./runtime-link-config.js";
import { SingleBotRuntime, type RuntimeStopOutcome } from "./runtime.js";
import type { ServerProfile } from "./server-profile.js";

export type BotRuntimeHostOptions = Readonly<{
  profile: ServerProfile;
  runtimeLinkConfig: RuntimeLinkClientConfig;
  logger: AppLogger;
  createClient?: BotClientFactory;
  onFatal?: (error: RuntimeLinkClientError) => Promise<void> | void;
}>;

/**
 * L0 断线保号后的重连退避。实测痛点：2 血断线→进程被启动器立即重启→
 * 原地重连进同一群怪→再被打→再断线，形成分钟级死循环。退避让世界先
 * 变化（天亮/怪物游走），配合"稳定低血只吃不断线"的 L0 语义，重连后
 * 才有机会回血重建。连续多次仍触发则停手——那说明该位置本身不安全。
 */
const DEFAULT_EMERGENCY_RESTART_COOLDOWN_MS = 60_000;
const DEFAULT_EMERGENCY_RESTART_MAX = 3;

function boundedEnvInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return fallback;
  }
  return parsed;
}

export class BotRuntimeHost {
  readonly runtime: SingleBotRuntime;

  private readonly runtimeLink: RuntimeLinkClient;
  private started = false;
  private stopPromise: Promise<RuntimeStopOutcome> | null = null;
  private emergencyRestarts = 0;
  private emergencyRestartTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly emergencyRestartCooldownMs: number;
  private readonly emergencyRestartMax: number;

  constructor(private readonly options: BotRuntimeHostOptions) {
    let runtimeLink: RuntimeLinkClient | null = null;
    // 生产反射探针：测量本 runtime 战斗反应循环的实测步长（见
    // combat-reflex-probe.ts 文件头的诚实边界——它把 NO_PROBE_DATA 升级为
    // 实测拒绝，但代表性负载未自证前不单凭它放行）。
    const combatReflexProbe = new CombatReactionLoopProbe();
    this.runtime = new SingleBotRuntime(options.profile, {
      createClient: options.createClient ?? createMineflayerClient,
      messageSink: (message) => {
        reportTelemetry(options.logger, message);
        runtimeLink?.publishTelemetry(message);
      },
      logger: options.logger,
      combatReflexProbe,
      onStopped: (reason) => this.handleRuntimeStopped(reason),
    });
    this.emergencyRestartCooldownMs = boundedEnvInteger(
      process.env.BOT_EMERGENCY_RESTART_COOLDOWN_MS,
      DEFAULT_EMERGENCY_RESTART_COOLDOWN_MS,
      5_000,
      600_000,
    );
    this.emergencyRestartMax = boundedEnvInteger(
      process.env.BOT_EMERGENCY_RESTART_MAX,
      DEFAULT_EMERGENCY_RESTART_MAX,
      0,
      100,
    );
    this.runtimeLink = runtimeLink = new RuntimeLinkClient({
      config: options.runtimeLinkConfig,
      botId: options.profile.botId,
      runtimeInstanceId: this.runtime.getRuntimeInstanceId(),
      logger: options.logger,
      handleStopCommand: (command, authorizationContext) =>
        this.runtime.handleStopCommand(command, authorizationContext),
      handleSkillInvocation: (invocation, coordinatorInstanceId) =>
        this.runtime.handleCoordinatorSkillInvocation(
          invocation,
          coordinatorInstanceId,
        ),
      handleSkillCancellation: (cancellation, coordinatorInstanceId) =>
        this.runtime.handleCoordinatorSkillCancellation(
          cancellation,
          coordinatorInstanceId,
        ),
      publishCurrentState: () => this.runtime.publishCurrentState(),
      failClosed: async (error) => {
        options.logger.error("bot_runtime_control_link_lost", {
          code: error.code,
          botId: options.profile.botId,
        });
        await this.runtime.stop("runtime_link_fail_closed");
        await options.onFatal?.(error);
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("Bot Runtime Host 已经启动。");
    await this.runtimeLink.start();
    this.runtime.start();
    this.started = true;
  }

  stop(reason: string): Promise<RuntimeStopOutcome> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this.performStop(reason);
    return this.stopPromise;
  }

  /**
   * Only L0 emergency stops qualify for the backoff restart; operator-driven
   * stops (SIGINT/SIGTERM, coordinator stop) stay down, and the restart
   * budget only counts emergency cycles.
   */
  private handleRuntimeStopped(reason: string): void {
    if (reason !== "l0_emergency_stop") return;
    if (!this.options.profile.reconnect.enabled) return;
    if (this.emergencyRestarts >= this.emergencyRestartMax) {
      this.options.logger.warn("bot_runtime_emergency_restart_budget_exhausted", {
        attempts: this.emergencyRestarts,
        botId: this.options.profile.botId,
      });
      return;
    }
    if (this.emergencyRestartTimer) return;
    this.emergencyRestartTimer = setTimeout(() => {
      this.emergencyRestartTimer = null;
      this.emergencyRestarts += 1;
      // 允许新的 stop 生命周期；运行时在 offline 状态下可以重新 start。
      this.stopPromise = null;
      this.options.logger.info("bot_runtime_emergency_restart", {
        attempt: this.emergencyRestarts,
        cooldownMs: this.emergencyRestartCooldownMs,
        botId: this.options.profile.botId,
      });
      try {
        this.runtime.start();
      } catch (cause) {
        this.options.logger.error("bot_runtime_emergency_restart_failed", {
          error: cause instanceof Error ? cause.message.slice(0, 200) : String(cause),
        });
      }
    }, this.emergencyRestartCooldownMs);
    this.emergencyRestartTimer.unref?.();
  }

  private async performStop(reason: string): Promise<RuntimeStopOutcome> {
    if (this.emergencyRestartTimer) {
      clearTimeout(this.emergencyRestartTimer);
      this.emergencyRestartTimer = null;
    }
    const outcome = await this.runtime.stop(reason);
    await this.runtimeLink.close();
    this.started = false;
    return outcome;
  }
}

function reportTelemetry(
  logger: AppLogger,
  message: BotTelemetryMessageV1,
): void {
  const payload = message.payload;
  logger.info("bot_telemetry", {
    traceId: message.traceId,
    taskId:
      "currentTaskId" in payload
        ? payload.currentTaskId ?? null
        : "currentTask" in payload
          ? payload.currentTask?.taskId ?? null
          : null,
    messageType: message.type,
    botId: message.botId,
    skillId: null,
    modelName: null,
    sequence: "sequence" in payload ? payload.sequence : undefined,
    connectionState:
      "connectionState" in payload ? payload.connectionState : undefined,
  });
}

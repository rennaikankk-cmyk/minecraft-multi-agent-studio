import type { AppLogger } from "@minecraft-studio/observability";
import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";

import type { BotClientFactory } from "./client.js";
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

export class BotRuntimeHost {
  readonly runtime: SingleBotRuntime;

  private readonly runtimeLink: RuntimeLinkClient;
  private started = false;
  private stopPromise: Promise<RuntimeStopOutcome> | null = null;

  constructor(private readonly options: BotRuntimeHostOptions) {
    let runtimeLink: RuntimeLinkClient | null = null;
    this.runtime = new SingleBotRuntime(options.profile, {
      createClient: options.createClient ?? createMineflayerClient,
      messageSink: (message) => {
        reportTelemetry(options.logger, message);
        runtimeLink?.publishTelemetry(message);
      },
      logger: options.logger,
    });
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

  private async performStop(reason: string): Promise<RuntimeStopOutcome> {
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

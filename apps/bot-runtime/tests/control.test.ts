import type {
  ControlAuthorizationContext,
  StopBotCommandV1,
} from "@minecraft-studio/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
} from "../src/client.js";
import type { L0SafetyActionResult } from "@minecraft-studio/safety";
import {
  RuntimeControlError,
  SingleBotRuntime,
} from "../src/runtime.js";
import type { ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

const NOW = new Date("2026-07-20T04:00:00.000Z");
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";

const profile: ServerProfile = {
  schemaVersion: "1.0",
  id: "local-isolated-test",
  botId: "studio-bot-01",
  purpose: "isolated-test",
  networkScope: "loopback",
  host: "127.0.0.1",
  port: 25565,
  minecraftVersion: "1.21.8",
  username: "StudioBot",
  auth: "offline",
  statusIntervalMs: 1_000,
  heartbeatIntervalMs: 5_000,
  stopGracePeriodMs: 5_000,
  reconnect: {
    enabled: true,
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
  },
};

const snapshot: BotClientSnapshot = {
  health: { current: 20, maximum: 20 },
  food: { level: 20, saturation: 5 },
  armorPoints: 0,
  position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
  latencyMs: 10,
  safety: {
    oxygenLevel: 20,
    inWater: false,
    inLava: false,
    onGround: true,
    velocityY: 0,
    inventory: { usedSlots: 0, totalSlots: 36 },
    hasSafeFood: false,
    movementRequested: false,
  },
};

class ControlTestClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  closeCalls = 0;

  constructor(private readonly failClose = false) {}

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    return snapshot;
  }

  async executeSafetyAction(): Promise<L0SafetyActionResult> {
    return { outcome: "executed", errorCode: null };
  }

  versionCompatibility() {
    return {
      selection: "fixed" as const,
      requestedVersion: "1.21.8",
      resolvedVersion: "1.21.8",
      protocolVersion: 772,
      majorVersion: "1.21",
      supportLevel: "tested" as const,
      supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
    };
  }

  skillCompatibilityEnvironment() {
    return {
      minecraftVersion: "1.21.8",
      protocolVersion: 772,
      supportsFeature: () => false,
      hasResource: () => false,
      serverCapability: () => undefined,
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    if (this.failClose) throw new Error("isolated close failure");
    this.handlers?.onDisconnected({ reason: "requested_stop", expected: true });
  }

  spawn(): void {
    this.handlers?.onSpawn();
  }
}

const logger: RuntimeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function stopCommand(
  runtimeInstanceId: string,
  reason = "Operator confirmed a safe stop.",
): StopBotCommandV1 {
  return {
    schemaVersion: "1.0",
    messageId: MESSAGE_ID,
    traceId: "trace-control",
    timestamp: NOW.toISOString(),
    source: { service: "coordinator", instanceId: "coordinator-01" },
    botId: profile.botId,
    type: "bot.stop.command.v1",
    payload: {
      commandId: COMMAND_ID,
      mode: "graceful",
      reason,
      requestedAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      gracePeriodMs: 5_000,
      expectedRuntimeInstanceId: runtimeInstanceId,
      authorization: {
        decisionId: DECISION_ID,
        actorId: "operator-01",
        permission: "bot.stop",
        issuedAt: new Date(NOW.getTime() - 1_000).toISOString(),
        expiresAt: new Date(NOW.getTime() + 10_000).toISOString(),
      },
    },
  };
}

function authorization(): ControlAuthorizationContext {
  return {
    decisionId: DECISION_ID,
    actorId: "operator-01",
    botId: profile.botId,
    commandId: COMMAND_ID,
    permissions: new Set(["bot.stop"]),
    now: NOW,
  };
}

function runtime(client: BotClient): SingleBotRuntime {
  return new SingleBotRuntime(profile, {
    createClient: () => client,
    messageSink: () => undefined,
    logger,
    now: () => new Date(Date.now()),
    randomId: () => MESSAGE_ID,
  });
}

describe("SingleBotRuntime control path", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("executes an authorized stop once and returns a protocol confirmation", async () => {
    const client = new ControlTestClient();
    const bot = runtime(client);
    bot.start();
    client.spawn();
    const command = stopCommand(bot.getRuntimeInstanceId());

    const first = bot.handleStopCommand(command, authorization());
    const second = bot.handleStopCommand(command, authorization());
    const result = await first;

    expect(second).toBe(first);
    expect(await second).toEqual(result);
    expect(client.closeCalls).toBe(1);
    expect(result).toMatchObject({
      botId: profile.botId,
      type: "bot.stop.result.v1",
      payload: {
        commandId: COMMAND_ID,
        runtimeInstanceId: bot.getRuntimeInstanceId(),
        outcome: "completed",
      },
    });
    expect(bot.getMetricsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bot_stop_requests_total", value: 1 }),
        expect.objectContaining({ name: "bot_stop_results_total", value: 1 }),
      ]),
    );
    expect(logger.info).toHaveBeenCalledWith(
      "bot_runtime_stop_result",
      expect.objectContaining({
        traceId: "trace-control",
        botId: profile.botId,
        commandId: COMMAND_ID,
        outcome: "completed",
      }),
    );
  });

  it("rejects a command targeting another runtime without stopping", async () => {
    const client = new ControlTestClient();
    const bot = runtime(client);
    bot.start();
    client.spawn();

    const result = await bot.handleStopCommand(
      stopCommand("runtime-different"),
      authorization(),
    );
    expect(result.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "RUNTIME_INSTANCE_MISMATCH",
    });
    expect(client.closeCalls).toBe(0);
    await bot.stop("test_cleanup");
  });

  it("does not report completion when the client cannot confirm close", async () => {
    const client = new ControlTestClient(true);
    const bot = runtime(client);
    bot.start();
    client.spawn();

    const result = await bot.handleStopCommand(
      stopCommand(bot.getRuntimeInstanceId()),
      authorization(),
    );
    expect(result.payload).toMatchObject({
      outcome: "failed",
      errorCode: "CLIENT_CLOSE_FAILED",
    });
    expect(bot.getState()).toBe("error");
  });

  it("rejects reuse of one command ID with different parameters", async () => {
    const client = new ControlTestClient();
    const bot = runtime(client);
    bot.start();
    client.spawn();
    const expectedRuntime = bot.getRuntimeInstanceId();
    await bot.handleStopCommand(stopCommand(expectedRuntime), authorization());

    expect(() =>
      bot.handleStopCommand(
        stopCommand(expectedRuntime, "Different stop operation."),
        authorization(),
      ),
    ).toThrowError(
      expect.objectContaining<Partial<RuntimeControlError>>({
        code: "COMMAND_ID_CONFLICT",
      }),
    );
  });
});

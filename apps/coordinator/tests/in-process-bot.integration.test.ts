import type {
  ControlAuthorizationContext,
  StopBotCommandV1,
} from "@minecraft-studio/protocol";
import {
  createStructuredLogger,
  type StructuredLogRecord,
} from "@minecraft-studio/observability";
import type { L0SafetyActionResult } from "@minecraft-studio/safety";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
} from "../../bot-runtime/src/client.js";
import { SingleBotRuntime } from "../../bot-runtime/src/runtime.js";
import type { ServerProfile } from "../../bot-runtime/src/server-profile.js";
import {
  BotRegistry,
  InMemoryStopAuditSink,
  StopController,
} from "../src/index.js";

const NOW = new Date("2026-07-20T05:00:00.000Z");
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

class IntegrationClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  closeCalls = 0;

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    return {
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      latencyMs: 12,
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
    this.handlers?.onDisconnected({ reason: "requested_stop", expected: true });
  }

  spawn(): void {
    this.handlers?.onSpawn();
  }
}

function uuidSequence(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
  };
}

describe("Coordinator and Bot Runtime in-process integration", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("registers real runtime telemetry and completes an authorized stop", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const records: StructuredLogRecord[] = [];
    const runtimeLogger = createStructuredLogger({
      service: "bot-runtime",
      instanceId: "runtime-integration",
      now: () => new Date(Date.now()),
      sink: (record) => records.push(record),
    });
    const coordinatorLogger = createStructuredLogger({
      service: "coordinator",
      instanceId: "coordinator-01",
      now: () => new Date(Date.now()),
      sink: (record) => records.push(record),
    });
    const registry = new BotRegistry({ staleAfterMs: 10_000, now: () => NOW });
    const client = new IntegrationClient();
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => registry.ingest(message, NOW),
      logger: runtimeLogger,
      now: () => new Date(Date.now()),
      randomId: uuidSequence(),
    });

    runtime.start();
    client.spawn();
    expect(registry.get(profile.botId, NOW)).toMatchObject({
      connectionState: "online",
      runtimeInstanceId: runtime.getRuntimeInstanceId(),
    });

    const auditSink = new InMemoryStopAuditSink();
    const stopController = new StopController({
      instanceId: "coordinator-01",
      registry,
      auditSink,
      logger: coordinatorLogger,
      now: () => new Date(Date.now()),
      randomId: () => "11111111-1111-4111-8111-111111111111",
      transport: {
        sendStopCommand: (
          command: StopBotCommandV1,
          authorizationContext: ControlAuthorizationContext,
        ) => runtime.handleStopCommand(command, authorizationContext),
      },
    });

    const result = await stopController.requestStop({
      commandId: COMMAND_ID,
      traceId: "trace-integration",
      botId: profile.botId,
      mode: "graceful",
      reason: "Operator confirmed integration stop.",
      gracePeriodMs: 1_000,
      timeoutMs: 2_000,
      authorization: {
        decisionId: DECISION_ID,
        actorId: "operator-01",
        permissions: new Set(["bot.stop"]),
        issuedAt: new Date(NOW.getTime() - 1_000),
        expiresAt: new Date(NOW.getTime() + 10_000),
      },
    });

    expect(result.payload.outcome).toBe("completed");
    expect(client.closeCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
    expect(registry.get(profile.botId, NOW)).toMatchObject({
      connectionState: "offline",
      offlineReason: "requested_stop",
    });
    expect(auditSink.entries().map(({ status }) => status)).toEqual([
      "started",
      "completed",
    ]);
    expect(
      records
        .filter(({ traceId }) => traceId === "trace-integration")
        .map(({ service, event }) => `${service}:${event}`),
    ).toEqual([
      "coordinator:coordinator_stop_audit",
      "bot-runtime:bot_runtime_stop_requested",
      "bot-runtime:bot_runtime_stop_result",
      "coordinator:coordinator_stop_audit",
    ]);
  });
});

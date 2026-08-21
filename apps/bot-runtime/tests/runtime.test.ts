import type {
  BotTelemetryMessageV1,
  SkillInvocationV1,
} from "@minecraft-studio/protocol";
import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";
import type {
  SkillCapabilityRequest,
  SkillExecutionAuthorization,
} from "@minecraft-studio/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "../src/client.js";
import { SingleBotRuntime } from "../src/runtime.js";
import type { ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

const FIXED_UUID = "11111111-1111-4111-8111-111111111111";

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
  statusIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
  stopGracePeriodMs: 5000,
  reconnect: {
    enabled: true,
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2000,
  },
};

const snapshot: BotClientSnapshot = {
  health: { current: 18, maximum: 20 },
  food: { level: 16, saturation: 4.5 },
  armorPoints: 7,
  position: { x: 10.25, y: 64, z: -20.5, dimension: "minecraft:overworld" },
  latencyMs: 45,
  safety: {
    oxygenLevel: 20,
    inWater: false,
    inLava: false,
    onGround: true,
    velocityY: 0,
    inventory: { usedSlots: 4, totalSlots: 36 },
    hasSafeFood: true,
    movementRequested: false,
  },
};

class FakeBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  closeCalls = 0;
  actionCalls: L0SafetyAction[] = [];
  capabilityCalls: SkillCapabilityRequest[] = [];

  constructor(private currentSnapshot: BotClientSnapshot = structuredClone(snapshot)) {}

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    return structuredClone(this.currentSnapshot);
  }

  async executeSafetyAction(
    action: L0SafetyAction,
  ): Promise<L0SafetyActionResult> {
    this.actionCalls.push(action);
    return { outcome: "executed", errorCode: null };
  }

  async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    this.capabilityCalls.push(request);
    const input = request.input as {
      target: {
        x: number;
        y: number;
        z: number;
        dimension: string;
        serverProfileId: string;
      };
    };
    return {
      reached: true,
      finalPosition: input.target,
      distanceToTarget: 0,
    };
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

  stateChanged(): void {
    this.handlers?.onStateChanged();
  }

  setSnapshot(next: BotClientSnapshot): void {
    this.currentSnapshot = structuredClone(next);
  }

  versionUnsupported(): void {
    this.handlers?.onVersionUnsupported();
  }

  disconnect(info: BotDisconnectInfo): void {
    this.handlers?.onDisconnected(info);
  }
}

const logger: RuntimeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function movementInvocation(): SkillInvocationV1 {
  return {
    schemaVersion: "1.0",
    messageId: "22222222-2222-4222-8222-222222222222",
    traceId: "trace-pathfinder-runtime",
    timestamp: "2026-07-19T10:00:00.000Z",
    source: { service: "coordinator", instanceId: "coordinator-01" },
    botId: profile.botId,
    taskId: "task-pathfinder-runtime",
    type: "skill.invoke.v1",
    payload: {
      invocationId: "33333333-3333-4333-8333-333333333333",
      skillId: "movement.goto",
      skillVersion: "1.0.0",
      expiresAt: "2026-07-19T10:01:00.000Z",
      input: {
        target: {
          x: 12,
          y: 64,
          z: -20,
          dimension: "minecraft:overworld",
          serverProfileId: profile.id,
        },
        radius: 2,
      },
      authorization: {
        decisionId: "44444444-4444-4444-8444-444444444444",
        actorId: "coordinator-agent",
        issuedAt: "2026-07-19T09:59:59.000Z",
        expiresAt: "2026-07-19T10:01:00.000Z",
      },
    },
  };
}

function skillAuthorization(
  invocation: SkillInvocationV1,
): SkillExecutionAuthorization {
  return {
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
    allowedCapabilities: new Set(["bot.move"]),
  };
}

describe("SingleBotRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connecting heartbeat and real snapshot after spawn", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    expect(messages[0]).toMatchObject({
      type: "bot.heartbeat.v1",
      payload: { connectionState: "connecting" },
    });

    client.spawn();
    const status = messages.find(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1",
    );
    expect(status?.payload).toMatchObject({
      connectionState: "online",
      health: snapshot.health,
      food: snapshot.food,
      armorPoints: snapshot.armorPoints,
      position: snapshot.position,
      latencyMs: snapshot.latencyMs,
      currentTask: null,
      safety: {
        mode: "monitoring",
        activeRisks: [],
        normalTasksPaused: false,
      },
    });
    expect(runtime.getState()).toBe("online");
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.skill-catalog.v1",
        payload: expect.objectContaining({
          minecraftVersion: "1.21.8",
          protocolVersion: 772,
          skills: expect.arrayContaining([
            expect.objectContaining({
              skillId: "movement.goto",
              availability: "available",
              verification: "unverified",
              selectedVariantId: "portable",
            }),
          ]),
        }),
      }),
    );
    expect(runtime.getMetricsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bot_connection_attempts_total",
          value: 1,
        }),
        expect.objectContaining({ name: "bot_heartbeats_total", value: 2 }),
      ]),
    );

    const beforeRefresh = messages.length;
    await vi.advanceTimersByTimeAsync(10);
    runtime.publishCurrentState();
    expect(messages.slice(beforeRefresh).map(({ type }) => type)).toEqual([
      "bot.version.v1",
      "bot.skill-catalog.v1",
      "bot.status.v1",
      "bot.heartbeat.v1",
    ]);
    expect(messages.at(-1)?.timestamp).toBe("2026-07-19T10:00:00.010Z");

    client.stateChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.filter(({ type }) => type === "bot.status.v1").length).toBe(3);

    await runtime.stop();
    expect(client.closeCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
    expect(messages.at(-1)).toMatchObject({
      type: "bot.disconnected.v1",
      payload: { reason: "requested_stop", expected: true },
    });
  });

  it("reconnects with bounded backoff after an unexpected disconnect", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const clients = [new FakeBotClient(), new FakeBotClient()];
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => clients[factoryCalls++]!,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    clients[0]!.disconnect({
      reason: "network_error",
      expected: false,
      detail: "isolated_test_disconnect",
    });
    expect(factoryCalls).toBe(1);
    expect(messages.some(({ type }) => type === "bot.disconnected.v1")).toBe(true);
    expect(runtime.getMetricsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bot_disconnects_total", value: 1 }),
        expect.objectContaining({
          name: "bot_reconnects_scheduled_total",
          value: 1,
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(factoryCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(factoryCalls).toBe(2);
    expect(runtime.getState()).toBe("connecting");
    expect(
      runtime.getMetricsSnapshot().find(
        ({ name }) => name === "bot_connection_attempts_total",
      )?.value,
    ).toBe(2);

    await runtime.stop();
    expect(clients[1]!.closeCalls).toBe(1);
  });

  it("does not retry after an explicit stop", async () => {
    const client = new FakeBotClient();
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => {
        factoryCalls += 1;
        return client;
      },
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    client.spawn();
    await runtime.stop("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(factoryCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
  });

  it("reports an unsupported version and suppresses deterministic retries", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(
      { ...profile, minecraftVersion: "auto" },
      {
        createClient: () => {
          factoryCalls += 1;
          return client;
        },
        messageSink: (message) => messages.push(message),
        logger,
        now: () => new Date(Date.now()),
        randomId: () => FIXED_UUID,
      },
    );

    runtime.start();
    client.versionUnsupported();
    client.disconnect({
      reason: "runtime_error",
      expected: false,
      detail: "unsupported_minecraft_version",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(factoryCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.version.v1",
        payload: expect.objectContaining({
          compatibility: expect.objectContaining({
            selection: "auto",
            supportLevel: "unsupported",
          }),
        }),
      }),
    );
  });

  it("pauses normal actions and executes a deterministic low-health retreat", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    client.spawn();
    client.setSnapshot({
      ...snapshot,
      health: { current: 8, maximum: 20 },
    });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);

    expect(runtime.canAcceptNormalActions()).toBe(false);
    expect(runtime.getSafetyStatus()).toMatchObject({
      mode: "paused",
      activeRisks: ["LOW_HEALTH"],
      normalTasksPaused: true,
      lastAction: {
        kind: "RETREAT_STEP",
        outcome: "executed",
      },
    });
    expect(client.actionCalls.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "RETREAT_STEP",
    ]);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.status.v1",
        payload: expect.objectContaining({
          safety: expect.objectContaining({
            activeRisks: ["LOW_HEALTH"],
          }),
        }),
      }),
    );
    await runtime.stop("test_cleanup");
  });

  it("executes the registered Pathfinder skill and blocks it when L0 pauses", async () => {
    const client = new FakeBotClient();
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();

    const invocation = movementInvocation();
    const completed = await runtime.handleSkillInvocation(
      invocation,
      skillAuthorization(invocation),
    );
    expect(completed.payload).toMatchObject({
      outcome: "completed",
      skillId: "movement.goto",
    });
    expect(client.capabilityCalls).toHaveLength(1);

    client.setSnapshot({
      ...snapshot,
      health: { current: 8, maximum: 20 },
    });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);

    const rejected = await runtime.handleSkillInvocation(
      invocation,
      skillAuthorization(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "NORMAL_ACTIONS_PAUSED",
    });
    expect(client.capabilityCalls).toHaveLength(1);
    await runtime.stop("test_cleanup");
  });

  it("derives capability authorization for an authenticated Coordinator invocation", async () => {
    const client = new FakeBotClient();
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();
    const invocation = movementInvocation();

    const first = runtime.handleCoordinatorSkillInvocation(
      invocation,
      invocation.source.instanceId,
    );
    const duplicate = runtime.handleCoordinatorSkillInvocation(
      invocation,
      invocation.source.instanceId,
    );

    expect(duplicate).toBe(first);
    await expect(first).resolves.toMatchObject({
      payload: { outcome: "completed", skillId: "movement.goto" },
    });
    expect(client.capabilityCalls).toHaveLength(1);
    expect(() =>
      runtime.handleCoordinatorSkillInvocation(invocation, "coordinator-forged")
    ).toThrowError(expect.objectContaining({ code: "CONTROL_IDENTITY_MISMATCH" }));
    await runtime.stop("test_cleanup");
  });

  it("cancels an active Pathfinder skill when L0 takes control", async () => {
    const client = new FakeBotClient();
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled by L0")),
            { once: true },
          );
        }),
    );
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();

    const invocation = movementInvocation();
    const pending = runtime.handleSkillInvocation(
      invocation,
      skillAuthorization(invocation),
    );
    await vi.advanceTimersByTimeAsync(0);

    client.setSnapshot({
      ...snapshot,
      health: { current: 8, maximum: 20 },
    });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toMatchObject({
      payload: {
        outcome: "cancelled",
        errorCode: "SKILL_CANCELLED",
      },
    });
    await runtime.stop("test_cleanup");
  });

  it("cancels an active skill through an authenticated Coordinator command", async () => {
    const client = new FakeBotClient();
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      async (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled by Coordinator")),
            { once: true },
          );
        }),
    );
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();
    const invocation = movementInvocation();
    const pending = runtime.handleCoordinatorSkillInvocation(
      invocation,
      invocation.source.instanceId,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(
      runtime.handleCoordinatorSkillCancellation(
        {
          schemaVersion: "1.0",
          messageId: "55555555-5555-4555-8555-555555555555",
          traceId: invocation.traceId,
          timestamp: "2026-07-19T10:00:01.000Z",
          source: invocation.source,
          botId: invocation.botId,
          taskId: invocation.taskId,
          type: "skill.cancel.v1",
          payload: {
            invocationId: invocation.payload.invocationId,
            reason: "task_cancelled",
            expiresAt: "2026-07-19T10:00:30.000Z",
          },
        },
        invocation.source.instanceId,
      ),
    ).toBe(true);
    await expect(pending).resolves.toMatchObject({
      payload: { outcome: "cancelled", errorCode: "SKILL_CANCELLED" },
    });
    await runtime.stop("test_cleanup");
  });

  it("owns the critical-health emergency stop at the runtime boundary", async () => {
    const client = new FakeBotClient({
      ...snapshot,
      health: { current: 4, maximum: 20 },
    });
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    client.spawn();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.actionCalls.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
    ]);
    expect(client.closeCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
    expect(runtime.getMetricsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bot_safety_decisions_total" }),
        expect.objectContaining({ name: "bot_safety_actions_total" }),
      ]),
    );
  });
});

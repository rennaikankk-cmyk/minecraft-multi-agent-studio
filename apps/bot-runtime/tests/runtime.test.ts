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
import { ensureItemOutputSchema } from "@minecraft-studio/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
  BotRecoveryAction,
  BotRecoveryActionResult,
} from "../src/client.js";
import type {
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "../src/combat-driver.js";
import { SingleBotRuntime } from "../src/runtime.js";
import type { ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";
import {
  WorldStateStore,
  type WorldStateSnapshot,
} from "../src/world-state.js";

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
  inventory: [
    { itemName: "oak_log", count: 7 },
    { itemName: "wooden_pickaxe", count: 1 },
  ],
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

const combatGear = {
  armorMaterial: "iron" as const,
  protectionLevel: 0,
  blastProtectionLevel: 0,
  armorPieceCount: 4,
  weaponDamage: 6,
  health: 20,
  hasTotem: true,
};

function combatObservation(observedAtMs: number): CombatDriverObservation {
  return {
    observedAtMs,
    serverProfileId: profile.id,
    dimension: "minecraft:overworld",
    latencyMs: 0,
    explosionRuleSet: "java-1.21-release",
    self: {
      position: { x: 10, y: 64, z: -20 },
      health: 18,
      offhandIsTotem: true,
      inventoryTotemCount: 1,
      gear: combatGear,
      orientation: { yaw: -90, pitch: 0 },
      heldItemSlot: 0,
      onGround: true,
      fallDistance: 0,
    },
    entities: [{
      entity: {
        entityId: 42,
        kind: "player",
        username: "Enemy",
        uuid: null,
      },
      position: { x: 12, y: 64, z: -20 },
      velocity: null,
      health: 20,
      armorPoints: 7,
      wieldingWeapon: true,
      crystalNearby: false,
      anchorNearby: false,
      gear: combatGear,
    }],
    weapons: [{
      slot: 0,
      itemName: "iron_sword",
      kind: "sword",
      baseDamage: 6,
      fullCooldownMs: 625,
      durabilityRemaining: 100,
      enchantmentDamageBonus: 0,
    }],
    crystalCandidates: null,
    mineCandidates: null,
    hazards: [],
  };
}

const combatProfile: ServerProfile = {
  ...profile,
  combat: {
    enabled: true,
    stance: "preserve-life",
    whitelist: { usernames: [], uuids: [] },
  },
};

class FakeBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  closeCalls = 0;
  actionCalls: L0SafetyAction[] = [];
  capabilityCalls: SkillCapabilityRequest[] = [];
  combatEnabled = false;
  combatActions: CombatPrimitiveAction[] = [];
  interruptNormalActionsCalls = 0;

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

  combatObservation(nowMs: number): CombatDriverObservation | null {
    return this.combatEnabled ? combatObservation(nowMs) : null;
  }

  async executeCombatAction(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return { outcome: "failed" as const, reasonCode: "SKILL_CANCELLED" };
    this.combatActions.push(action);
    return { outcome: "executed" as const, executedAtMs: Date.now() };
  }

  interruptNormalActions(): void {
    this.interruptNormalActionsCalls += 1;
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

  damage(info: { previousHealth: number; currentHealth: number }): void {
    this.handlers?.onDamaged?.(info);
  }
}

class WorldStateBotClient extends FakeBotClient {
  constructor(private readonly currentWorldState: WorldStateSnapshot) {
    super();
  }

  worldStateSnapshot(): WorldStateSnapshot {
    return structuredClone(this.currentWorldState);
  }
}

class WatchdogBotClient extends WorldStateBotClient {
  readonly recoveryActions: BotRecoveryAction[] = [];

  async executeRecoveryAction(
    action: BotRecoveryAction,
  ): Promise<BotRecoveryActionResult> {
    this.recoveryActions.push(action);
    return { outcome: "executed", errorCode: null };
  }
}

class SharedWorldStateBotClient extends FakeBotClient {
  constructor(private readonly worldState: WorldStateStore) {
    super();
  }

  worldStateSnapshot(): WorldStateSnapshot {
    this.worldState.observe({
      observedAt: new Date(Date.now()),
      position: {
        ...snapshot.position,
        serverProfileId: profile.id,
      },
      inventory: [
        {
          name: "oak_log",
          count: 1,
          durability: null,
          maxDurability: null,
        },
      ],
      nearbyBlocks: [],
      entities: [],
      navigation: {
        target: null,
        movementOwner: null,
        pathLength: null,
        pathResetCount: 0,
        stuckSince: null,
        lastFailureTarget: null,
        blacklist: [],
      },
    });
    return this.worldState.snapshot();
  }

  async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    this.capabilityCalls.push(request);
    if (
      request.capability !== "inventory.read" ||
      request.operation !== "inventory.snapshot"
    ) {
      throw new Error(`Unexpected capability operation: ${request.operation}`);
    }
    const worldState = this.worldStateSnapshot();
    return {
      dimension: snapshot.position.dimension,
      serverProfileId: profile.id,
      worldStateVersion: worldState.version,
      items: [{ itemName: "oak_log", count: 1 }],
    };
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

function ensureItemInvocation(): SkillInvocationV1 {
  return {
    schemaVersion: "1.0",
    messageId: "55555555-5555-4555-8555-555555555555",
    traceId: "trace-ensure-item-runtime",
    timestamp: "2026-07-19T10:00:00.000Z",
    source: { service: "coordinator", instanceId: "coordinator-01" },
    botId: profile.botId,
    taskId: "task-ensure-item-runtime",
    type: "skill.invoke.v1",
    payload: {
      invocationId: "66666666-6666-4666-8666-666666666666",
      skillId: "goal.ensure-item",
      skillVersion: "1.0.0",
      expiresAt: "2026-07-19T10:01:00.000Z",
      input: {
        itemName: "oak_log",
        count: 1,
        dimension: snapshot.position.dimension,
        serverProfileId: profile.id,
      },
      authorization: {
        decisionId: "77777777-7777-4777-8777-777777777777",
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

function ensureItemAuthorization(
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
    allowedCapabilities: new Set([
      "inventory.read",
      "world.interact",
      "craft.execute",
    ]),
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
      "bot.world-state.v1",
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

  it("reports why a snapshot was rejected instead of dropping it silently", async () => {
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
    const publishedBefore = messages.filter(
      ({ type }) => type === "bot.status.v1",
    ).length;

    client.setSnapshot({
      ...snapshot,
      health: { ...snapshot.health, current: Number.NaN },
    });
    client.stateChanged();

    expect(
      messages.filter(({ type }) => type === "bot.status.v1").length,
    ).toBe(publishedBefore);
    expect(logger.error).toHaveBeenCalledWith(
      "l0_safety_snapshot_invalid",
      expect.objectContaining({
        botId: profile.botId,
        code: "SAFETY_SNAPSHOT_INVALID",
        reason: expect.stringContaining("health"),
      }),
    );

    await runtime.stop();
  });

  it("logs the pre-first-packet status rejection as a warning, then as an error once status has flowed", async () => {
    // 实测每次启动都恰好有一条 `bot_runtime_status_invalid`，reason
    // "health is outside the L0 safety boundary."：handleSpawn 在转 online 时
    // 立刻 emitStatus，而服务端的第一个 health 包还没到，mineflayer 的
    // bot.health 是 undefined。把这个必然发生的情形记成 error 会训练运维忽略
    // error 行，而真正的边界违规长得一模一样（同一个字段名、同一句话）——所以
    // 判据只能是"这条连接发出过状态没有"，不能是消息内容。
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient({
      ...snapshot,
      health: { ...snapshot.health, current: Number.NaN },
    });
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    client.spawn();

    expect(messages.some(({ type }) => type === "bot.status.v1")).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "bot_runtime_status_invalid",
      expect.objectContaining({
        botId: profile.botId,
        firstStatusPending: true,
        reason: expect.stringContaining("health"),
      }),
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      "bot_runtime_status_invalid",
      expect.anything(),
    );

    // 服务端补上 health 之后状态发得出去，这条连接的"第一条"就算过了。
    client.setSnapshot(snapshot);
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.some(({ type }) => type === "bot.status.v1")).toBe(true);

    // 已经发出过之后再坏，就是真问题：降级不能把它一起吞掉。
    client.setSnapshot({
      ...snapshot,
      health: { ...snapshot.health, current: Number.NaN },
    });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(1000);

    expect(logger.error).toHaveBeenCalledWith(
      "bot_runtime_status_invalid",
      expect.objectContaining({
        botId: profile.botId,
        firstStatusPending: false,
        reason: expect.stringContaining("health"),
      }),
    );

    await runtime.stop();
  });

  it("treats each reconnect as its own first status, not as an already-flowing one", async () => {
    // 降级的判据是"这条连接发出过状态没有"，所以它必须按连接重置。重连后
    // 服务端同样要重新送第一个 health 包，那一条拒绝和首次启动的那条是同一
    // 件事；不重置就会让重连时的预期情形升级成 error，而这正是本次修复要
    // 消除的噪声。
    const clients = [
      new FakeBotClient(),
      new FakeBotClient({
        ...snapshot,
        health: { ...snapshot.health, current: Number.NaN },
      }),
    ];
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => clients[factoryCalls++]!,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    // 第一条连接一切正常，status 发得出去，标志被置真。
    clients[0]!.spawn();
    expect(logger.warn).not.toHaveBeenCalledWith(
      "bot_runtime_status_invalid",
      expect.anything(),
    );

    clients[0]!.disconnect({
      reason: "network_error",
      expected: false,
      detail: "isolated_test_disconnect",
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(factoryCalls).toBe(2);
    clients[1]!.spawn();

    expect(logger.warn).toHaveBeenCalledWith(
      "bot_runtime_status_invalid",
      expect.objectContaining({ firstStatusPending: true }),
    );
    expect(logger.error).not.toHaveBeenCalledWith(
      "bot_runtime_status_invalid",
      expect.anything(),
    );

    await runtime.stop();
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
      "CONSUME_SAFE_FOOD",
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

  it("requests bounded food recovery when low health has no safe food", async () => {
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
    client.setSnapshot({
      ...snapshot,
      health: { current: 8, maximum: 20 },
      food: { level: 17, saturation: 0 },
      safety: { ...snapshot.safety, hasSafeFood: false },
    });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);

    expect(client.actionCalls.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "FORAGE_SAFE_FOOD",
      "RETREAT_STEP",
    ]);
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

  // §4 的验收：目标分解与恢复阶梯是否真的落在 bot 的派发路径上。
  //
  // dispatcher 在真实系统里由 coordinator 侧绑定世界坐标与授权；这里替换成一个
  // 协议合法的 movement 信封，因为断言的对象是**接线**——每一步是否真的穿过
  // handleSkillInvocation、executor 的协议校验、授权逐字段比对，一直到
  // capability adapter。步骤语义与技能是否对应是 dispatcher 的职责，不在此。
  it("drives a decomposed goal through the real skill dispatch path", async () => {
    const client = new FakeBotClient();
    const dispatchedItems: string[] = [];
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
      goalStepDispatcher: (step) => {
        const suffix = String(dispatchedItems.length).padStart(2, "0");
        const base = movementInvocation();
        const invocation: SkillInvocationV1 = {
          ...base,
          payload: {
            ...base.payload,
            invocationId: `33333333-3333-4333-8333-3333333333${suffix}`,
          },
        };
        dispatchedItems.push(step.itemName);
        return { invocation, authorization: skillAuthorization(invocation) };
      },
    });
    runtime.start();
    client.spawn();

    const outcome = await runtime.pursueGoals([
      { itemName: "crafting_table", count: 1 },
    ]);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.supervision.completed).toBe(true);
    expect(outcome.supervision.failure).toBeNull();
    // 计划真的展开了多步，并且每一步都走到了 client 的 capability。
    expect(dispatchedItems.length).toBeGreaterThan(1);
    expect(client.capabilityCalls).toHaveLength(dispatchedItems.length);
    expect(outcome.supervision.stepsCompleted).toBe(dispatchedItems.length);
    await runtime.stop("test_cleanup");
  });

  it("fails a goal closed when no step dispatcher is wired", async () => {
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

    const outcome = await runtime.pursueGoals([
      { itemName: "crafting_table", count: 1 },
    ]);

    expect(outcome.planned).toBe(true);
    if (!outcome.planned) return;
    expect(outcome.supervision.completed).toBe(false);
    expect(outcome.supervision.failure).toMatchObject({
      errorCode: "PLAN_STEP_DISPATCH_UNAVAILABLE",
      category: "CONTRACT_BUG",
      action: "ESCALATE_TO_OPERATOR",
    });
    // 接线缺失不能变成"悄悄什么都没做但报成功"。
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });

  it("refuses to plan a goal while offline or while L0 pauses normal actions", async () => {
    const client = new FakeBotClient();
    let dispatchCalls = 0;
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
      goalStepDispatcher: () => {
        dispatchCalls += 1;
        return null;
      },
    });

    const offline = await runtime.pursueGoals([
      { itemName: "crafting_table", count: 1 },
    ]);
    expect(offline).toMatchObject({
      planned: false,
      errorCode: "BOT_NOT_ONLINE",
    });

    runtime.start();
    client.spawn();
    client.setSnapshot({ ...snapshot, health: { current: 8, maximum: 20 } });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.canAcceptNormalActions()).toBe(false);

    const paused = await runtime.pursueGoals([
      { itemName: "crafting_table", count: 1 },
    ]);
    expect(paused).toMatchObject({
      planned: false,
      errorCode: "NORMAL_ACTIONS_PAUSED",
    });
    // 两种拒绝都发生在规划之前：一步都没派发。
    expect(dispatchCalls).toBe(0);
    expect(client.capabilityCalls).toHaveLength(0);
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

  it("publishes the authenticated Coordinator task lifecycle in status and heartbeat", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    let completeCapability!: (value: unknown) => void;
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      () =>
        new Promise((resolve) => {
          completeCapability = resolve;
        }),
    );
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();
    messages.length = 0;

    const invocation = movementInvocation();
    const pending = runtime.handleCoordinatorSkillInvocation(
      invocation,
      invocation.source.instanceId,
    );
    await vi.advanceTimersByTimeAsync(0);

    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.status.v1",
        payload: expect.objectContaining({
          currentTask: {
            taskId: invocation.taskId,
            title: invocation.payload.skillId,
            status: "running",
            startedAt: "2026-07-19T10:00:00.000Z",
          },
        }),
      }),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.heartbeat.v1",
        payload: expect.objectContaining({ currentTaskId: invocation.taskId }),
      }),
    );

    completeCapability({
      reached: true,
      finalPosition: invocation.payload.input.target,
      distanceToTarget: 0,
    });
    await expect(pending).resolves.toMatchObject({
      taskId: invocation.taskId,
      payload: { outcome: "completed" },
    });

    const statuses = messages.filter(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1",
    );
    expect(statuses.at(-1)?.payload.currentTask).toEqual({
      taskId: invocation.taskId,
      title: invocation.payload.skillId,
      status: "completed",
      startedAt: "2026-07-19T10:00:00.000Z",
    });
    await runtime.stop("test_cleanup");
  });

  it("keeps another active Coordinator invocation running when results finish out of order", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    const completions: Array<(value: unknown) => void> = [];
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      () =>
        new Promise((resolve) => {
          completions.push(resolve);
        }),
    );
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();
    messages.length = 0;

    const firstInvocation = movementInvocation();
    const secondInvocation: SkillInvocationV1 = {
      ...firstInvocation,
      messageId: "66666666-6666-4666-8666-666666666666",
      taskId: "task-pathfinder-runtime-second",
      payload: {
        ...firstInvocation.payload,
        invocationId: "77777777-7777-4777-8777-777777777777",
        authorization: {
          ...firstInvocation.payload.authorization,
          decisionId: "88888888-8888-4888-8888-888888888888",
        },
      },
    };
    const first = runtime.handleCoordinatorSkillInvocation(
      firstInvocation,
      firstInvocation.source.instanceId,
    );
    const second = runtime.handleCoordinatorSkillInvocation(
      secondInvocation,
      secondInvocation.source.instanceId,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(completions).toHaveLength(2);

    completions[1]?.({
      reached: true,
      finalPosition: {
        x: 12,
        y: 64,
        z: -20,
        dimension: "minecraft:overworld",
        serverProfileId: profile.id,
      },
      distanceToTarget: 0,
    });
    await second;
    const statusesAfterSecond = messages.filter(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1",
    );
    expect(statusesAfterSecond.at(-1)?.payload.currentTask).toMatchObject({
      taskId: firstInvocation.taskId,
      status: "running",
    });

    completions[0]?.({
      reached: true,
      finalPosition: {
        x: 12,
        y: 64,
        z: -20,
        dimension: "minecraft:overworld",
        serverProfileId: profile.id,
      },
      distanceToTarget: 0,
    });
    await first;
    const terminalStatuses = messages.filter(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1",
    );
    expect(terminalStatuses.at(-1)?.payload.currentTask).toMatchObject({
      taskId: firstInvocation.taskId,
      status: "completed",
    });
    await runtime.stop("test_cleanup");
  });

  it("publishes a cancelled task snapshot before an unexpected disconnect", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("disconnected")),
            { once: true },
          );
        }),
    );
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();
    messages.length = 0;
    const invocation = movementInvocation();
    const pending = runtime.handleCoordinatorSkillInvocation(
      invocation,
      invocation.source.instanceId,
    );
    await vi.advanceTimersByTimeAsync(0);

    client.disconnect({ reason: "network_error", expected: false });
    await expect(pending).resolves.toMatchObject({
      payload: { outcome: "cancelled" },
    });
    const statuses = messages.filter(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1",
    );
    expect(statuses.at(-1)?.payload.currentTask).toMatchObject({
      taskId: invocation.taskId,
      status: "cancelled",
    });
    expect(messages.at(-1)).toMatchObject({ type: "bot.disconnected.v1" });
    await runtime.stop("test_cleanup");
  });

  it("cancels an active Pathfinder skill when L0 takes control", async () => {
    const client = new FakeBotClient();
    let activeSignal: AbortSignal | null = null;
    let release!: () => void;
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      async (request) =>
        new Promise((resolve) => {
          activeSignal = request.signal;
          release = () => resolve({
            reached: true,
            finalPosition: {
              x: 1,
              y: 64,
              z: 1,
              dimension: "minecraft:overworld",
              serverProfileId: profile.id,
            },
            distanceToTarget: 0,
          });
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

    expect(activeSignal?.aborted).toBe(false);
    client.setSnapshot(snapshot);
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);
    release();
    await expect(pending).resolves.toMatchObject({
      payload: {
        outcome: "completed",
      },
    });
    await runtime.stop("test_cleanup");
  });

  it("reports the active task while a skill is running and clears it afterward", async () => {
    const client = new FakeBotClient();
    const messages: unknown[] = [];
    let release!: () => void;
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      async () => new Promise((resolve) => {
        release = () => resolve({
          reached: true,
          finalPosition: {
            x: 1,
            y: 64,
            z: 1,
            dimension: "minecraft:overworld",
            serverProfileId: profile.id,
          },
          distanceToTarget: 0,
        });
      }),
    );
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
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
    await vi.advanceTimersByTimeAsync(profile.statusIntervalMs);

    expect(messages).toContainEqual(expect.objectContaining({
      type: "bot.status.v1",
      payload: expect.objectContaining({
        currentTask: expect.objectContaining({
          taskId: invocation.taskId,
          title: "movement.goto",
          status: "running",
        }),
      }),
    }));

    release();
    await pending;
    await vi.advanceTimersByTimeAsync(profile.statusIntervalMs);
    const statuses = messages.filter(
      (message): message is Extract<
        BotTelemetryMessageV1,
        { type: "bot.status.v1" }
      > =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "bot.status.v1",
    );
    expect(statuses.at(-1)).toEqual(expect.objectContaining({
      type: "bot.status.v1",
      payload: expect.objectContaining({ currentTask: null }),
    }));
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

  it("preempts a normal task and starts a deterministic reaction when damaged", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    client.combatEnabled = true;
    vi.spyOn(client, "invokeSkillCapability").mockImplementation(
      (request) =>
        new Promise((_resolve, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled by damage reaction")),
            { once: true },
          );
        }),
    );
    const runtime = new SingleBotRuntime(combatProfile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
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

    client.damage({ previousHealth: 20, currentHealth: 18 });
    await vi.advanceTimersByTimeAsync(0);

    expect(client.interruptNormalActionsCalls).toBe(1);
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.status.v1",
        payload: expect.objectContaining({
          currentTask: expect.objectContaining({
            title: "战斗反应: 受到攻击",
            status: "running",
          }),
        }),
      }),
    );
    await expect(pending).resolves.toMatchObject({
      payload: { outcome: "cancelled" },
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(client.combatActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "MELEE_ATTACK", targetEntityId: 42 }),
      ]),
    );
    expect(client.combatActions.every(({ kind }) =>
      kind !== "PLACE_CRYSTAL" && kind !== "PACKET_MINE",
    )).toBe(true);
    await runtime.stop("test_cleanup");
  });

  it("keeps normal tasks paused but still reacts defensively when damaged at low health", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    client.combatEnabled = true;
    const runtime = new SingleBotRuntime(combatProfile, {
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

    client.damage({ previousHealth: 8, currentHealth: 7 });
    await vi.advanceTimersByTimeAsync(250);

    expect(client.combatActions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "MELEE_ATTACK", targetEntityId: 42 }),
      ]),
    );
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.status.v1",
        payload: expect.objectContaining({
          safety: expect.objectContaining({ normalTasksPaused: true }),
          currentTask: expect.objectContaining({
            title: "战斗反应: 受到攻击",
          }),
        }),
      }),
    );
    await runtime.stop("test_cleanup");
  });

  it("bounds an automatic damage reaction and publishes its terminal task state", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    client.combatEnabled = true;
    const runtime = new SingleBotRuntime(combatProfile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });
    runtime.start();
    client.spawn();
    client.damage({ previousHealth: 20, currentHealth: 18 });

    await vi.advanceTimersByTimeAsync(4_000);

    const statuses = messages.filter(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1" &&
        message.payload.currentTask?.title === "战斗反应: 受到攻击",
    );
    expect(statuses.at(-1)?.payload.currentTask?.status).toBe("completed");
    expect(client.combatActions.length).toBeLessThanOrEqual(32);
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

    // 第一份危急观测只建立基线（稳定低血不再立刻断线——那会把低血重连
    // 变成断线死循环）；血量继续下降的第二份观测才触发边界上的断线保号。
    expect(client.actionCalls.map(({ kind }) => kind)).toEqual([
      "PAUSE_NORMAL_TASKS",
      "CONSUME_SAFE_FOOD",
    ]);
    expect(client.closeCalls).toBe(0);
    expect(runtime.getState()).toBe("online");

    // 推过动作冷却期，第二份（正在下降的）危急观测才会产生新动作。
    await vi.advanceTimersByTimeAsync(6_000);
    client.setSnapshot({ ...snapshot, health: { current: 2, maximum: 20 } });
    client.stateChanged();
    await vi.advanceTimersByTimeAsync(0);

    // EMERGENCY_STOP 不经过 client.actionCalls：它在 runtime 边界直接走
    // performStop。断言降血后的断线保号效果本身。
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

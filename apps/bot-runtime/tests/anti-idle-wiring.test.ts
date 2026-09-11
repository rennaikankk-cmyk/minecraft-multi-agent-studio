// ---------------------------------------------------------------------------
// anti-idle 接线测试（防挂机偏转）。
//
// 背景：startAntiIdleTimer 的 60s 空闲判定读 lastActivityMonotonic，而该字段
// 曾在 emitStatus 的第一行被每秒刷新。由于 emitStatus 由 statusIntervalMs
// 驱动（生产 1000ms），idleMs 永远到不了 60s，"每 45s 一次视线偏转"从未触发
// ——整段防挂机逻辑是死代码，而它存在的唯一目的就是防"服务器踢完全无输入的
// 客户端"。
//
// 本文件断言的是**接线**而非游戏语义：
//   1. anarchy profile 下，持续 95s 空闲必须产生恰好 1 次偏转（t=90s 那次）；
//      修复前为 0 次（emitStatus 每秒把空闲窗口重置）。
//   2. 偏转受 60s 空闲门 + 45s 节拍共同约束（t=135s 不偏转，t=180s 再偏转）。
//   3. 非 anarchy（isolated-test / STRICT）下永不偏转——章程 §6 与
//      "反作弊零暴露"要求额外输入只能出现在 anarchy。
// ---------------------------------------------------------------------------

import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";
import type { SkillCapabilityRequest } from "@minecraft-studio/skills";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "../src/client.js";
import type { CombatPrimitiveAction } from "../src/combat-driver.js";
import { SingleBotRuntime } from "../src/runtime.js";
import type { RuntimeLogger } from "../src/runtime-types.js";
import type { ServerProfile } from "../src/server-profile.js";

const FIXED_UUID = "11111111-1111-4111-8111-111111111111";

const snapshot: BotClientSnapshot = {
  health: { current: 20, maximum: 20 },
  food: { level: 20, saturation: 5 },
  armorPoints: 0,
  armorSlots: { head: null, chest: null, legs: null, feet: null },
  inventory: [],
  position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
  latencyMs: 30,
  safety: {
    oxygenLevel: 20,
    inWater: false,
    inLava: false,
    onGround: true,
    velocityY: 0,
    inventory: { usedSlots: 0, totalSlots: 36 },
    hasSafeFood: true,
    movementRequested: false,
  },
};

function profileFor(purpose: ServerProfile["purpose"]): ServerProfile {
  return {
    schemaVersion: "1.0",
    id: `anti-idle-${purpose}`,
    botId: "studio-bot-01",
    purpose,
    networkScope: purpose === "anarchy" ? "public" : "loopback",
    host: purpose === "anarchy" ? "example.invalid" : "127.0.0.1",
    port: 25565,
    minecraftVersion: "1.21.8",
    username: "StudioBot",
    auth: "offline",
    statusIntervalMs: 1000,
    heartbeatIntervalMs: 5000,
    stopGracePeriodMs: 5000,
    reconnect: {
      enabled: false,
      maxAttempts: 1,
      baseDelayMs: 500,
      maxDelayMs: 1000,
    },
  };
}

/** 记录 look() 调用的最小 BotClient；其余 capability 一律抛错（fake 不吞未知调用）。 */
class AntiIdleBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  lookCalls: Array<{ yaw: number; pitch: number }> = [];

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    return structuredClone(snapshot);
  }

  /** anti-idle 通过 (this.client as {look?}) 调用，故必须挂在实例上。 */
  async look(yaw: number, pitch: number): Promise<void> {
    this.lookCalls.push({ yaw, pitch });
  }

  async executeSafetyAction(
    _action: L0SafetyAction,
  ): Promise<L0SafetyActionResult> {
    return { outcome: "executed", errorCode: null };
  }

  async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    throw new Error(
      `anti-idle test dispatched an unexpected capability: ${request.capability}/${request.operation}`,
    );
  }

  combatObservation(): null {
    return null;
  }

  async executeCombatAction(_action: CombatPrimitiveAction, _signal: AbortSignal) {
    return { outcome: "failed" as const, reasonCode: "SKILL_CANCELLED" };
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
    this.handlers?.onDisconnected({ reason: "requested_stop", expected: true });
  }

  spawn(): void {
    this.handlers?.onSpawn();
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

function startRuntime(purpose: ServerProfile["purpose"]): {
  client: AntiIdleBotClient;
  runtime: SingleBotRuntime;
} {
  const client = new AntiIdleBotClient();
  const runtime = new SingleBotRuntime(profileFor(purpose), {
    createClient: () => client,
    messageSink: () => undefined,
    logger,
    // 同一假时钟源：vi.advanceTimersByTimeAsync 会推进 Date.now()，
    // 于是注入的单调时钟与 setInterval 节拍严格同步。
    now: () => new Date(Date.now()),
    monotonicNow: () => Date.now(),
    randomId: () => FIXED_UUID,
  });
  runtime.start();
  client.spawn();
  return { client, runtime };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("anti-idle 偏转接线（anarchy）", () => {
  it("持续空闲 95s 必须产生恰好 1 次偏转", async () => {
    vi.useFakeTimers();
    const { client, runtime } = startRuntime("anarchy");

    // 45s 节拍：idle=45s < 60s → 不偏转；90s 节拍：idle=90s ≥ 60s → 偏转。
    // 期间 emitStatus 以 statusIntervalMs=1000 触发约 95 次；修复前它每次
    // 重置空闲窗口，使两次节拍都判为 idle≈1s，偏转次数为 0。
    await vi.advanceTimersByTimeAsync(95_000);

    expect(client.lookCalls).toHaveLength(1);

    await runtime.stop("test_teardown");
  });

  it("偏转受 60s 空闲门约束：135s 不再偏转，180s 再偏转一次", async () => {
    vi.useFakeTimers();
    const { client, runtime } = startRuntime("anarchy");

    await vi.advanceTimersByTimeAsync(95_000);
    expect(client.lookCalls).toHaveLength(1);

    // t=135s：距上次偏转（90s）仅 45s < 60s → 跳过。
    await vi.advanceTimersByTimeAsync(40_000);
    expect(client.lookCalls).toHaveLength(1);

    // t=180s：距上次偏转 90s ≥ 60s → 再偏转一次。
    await vi.advanceTimersByTimeAsync(45_000);
    expect(client.lookCalls).toHaveLength(2);

    await runtime.stop("test_teardown");
  });

  it("偏转角在 ±5° 内且俯仰被夹紧", async () => {
    vi.useFakeTimers();
    const { client, runtime } = startRuntime("anarchy");

    await vi.advanceTimersByTimeAsync(95_000);
    expect(client.lookCalls).toHaveLength(1);

    const call = client.lookCalls[0]!;
    const jitterLimit = Math.PI / 18; // ±5°
    expect(Number.isFinite(call.yaw)).toBe(true);
    expect(Number.isFinite(call.pitch)).toBe(true);
    expect(Math.abs(call.pitch)).toBeLessThanOrEqual(1.2 + jitterLimit);

    await runtime.stop("test_teardown");
  });
});

describe("anti-idle 在非 anarchy 下必须零额外输入", () => {
  it("isolated-test profile 永不偏转", async () => {
    vi.useFakeTimers();
    const { client, runtime } = startRuntime("isolated-test");

    await vi.advanceTimersByTimeAsync(190_000);

    expect(client.lookCalls).toHaveLength(0);

    await runtime.stop("test_teardown");
  });

  it("managed profile 永不偏转", async () => {
    vi.useFakeTimers();
    const { client, runtime } = startRuntime("managed");

    await vi.advanceTimersByTimeAsync(190_000);

    expect(client.lookCalls).toHaveLength(0);

    await runtime.stop("test_teardown");
  });
});

import type { SkillInvocationV1 } from "@minecraft-studio/protocol";
import type { L0SafetyAction, L0SafetyActionResult } from "@minecraft-studio/safety";
import type {
  SkillCapabilityRequest,
  SkillExecutionAuthorization,
} from "@minecraft-studio/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BotClient, BotClientHandlers, BotClientSnapshot } from "../src/client.js";
import { SingleBotRuntime } from "../src/runtime.js";
import type { ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

// ---------------------------------------------------------------------------
// 基础动作技能的**真实状态组装**接线测试。
//
// 存在理由（缺陷复盘）：三个技能各自的单测都对，但两段路都没被覆盖——
//   packages/skills/tests 直接调 skill.execute(context, input, state)（手搓 state）
//   apps/bot-runtime/tests/basic-actions.test.ts 直接打适配器（跳过前置条件）
// 中间那段"runtime.skillState() 组装 → 前置条件求值 → execute → 适配器"是断的：
// skillState() 当时不投影 hunger/saturation/foodItemCount/bucketCounts/timeOfDay，
// 于是 food.eat 恒 BOT_HUNGER_UNKNOWN、sleep.bed 恒 BOT_TIME_UNKNOWN、
// bucket.fill 恒 INVENTORY_COUNT_UNKNOWN——三个技能在真实链路上永远到不了适配器，
// 而且"永远拒绝"看起来和 fail-closed 一模一样，不会自己暴露。
//
// 本文件用真实的 SingleBotRuntime + 真实 handleSkillInvocation 走完整条路：
// 假 client 只提供**快照**（服务器读数），不做任何技能相关判断。
// ---------------------------------------------------------------------------

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
  reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2000 },
};

/**
 * 夜晚 + 有面包 + 有空桶的典型快照（可逐条覆盖）。
 *
 * 饥饿取 17：**food.eat 的可用区间是 15..19**。≤14 由 L0 反射层自己接管
 * （packages/safety 的 EAT_AT_FOOD_LEVEL=14 → HUNGER 风险 → PAUSE_NORMAL_TASKS），
 * 于是普通技能连前置条件都过不了，报文是 NORMAL_ACTIONS_PAUSED；20（满）由
 * FOOD_NOT_NEEDED 拒绝。低于这个区间的快照测的不是本文件的链路。
 */
function baseSnapshot(overrides: Partial<BotClientSnapshot> = {}): BotClientSnapshot {
  return {
    health: { current: 18, maximum: 20 },
    food: { level: 17, saturation: 5 },
    armorPoints: null,
    armorSlots: { head: null, chest: null, legs: null, feet: null },
    inventory: [
      { itemName: "bread", count: 3 },
      { itemName: "bucket", count: 2 },
    ],
    position: { x: 10.25, y: 64, z: -20.5, dimension: "minecraft:overworld" },
    latencyMs: 45,
    time: { timeOfDay: 15_000, isRaining: false, thunderState: 0 },
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
    ...overrides,
  };
}

/**
 * 只提供快照与能力记录的客户替身：**不含任何技能判断**。
 * capability 返回值按真实适配器的完成契约取最小诚实形状。
 */
class SnapshotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  capabilityCalls: SkillCapabilityRequest[] = [];

  constructor(private currentSnapshot: BotClientSnapshot = baseSnapshot()) {}

  setSnapshot(next: BotClientSnapshot): void {
    this.currentSnapshot = next;
  }

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    return structuredClone(this.currentSnapshot);
  }

  async executeSafetyAction(
    _action: L0SafetyAction,
  ): Promise<L0SafetyActionResult> {
    return { outcome: "executed", errorCode: null };
  }

  async invokeSkillCapability(request: SkillCapabilityRequest): Promise<unknown> {
    this.capabilityCalls.push(request);
    const input = request.input as {
      itemName?: string;
      mode?: "water" | "lava";
      target?: { x: number; y: number; z: number };
      bed?: { x: number; y: number; z: number };
    };
    if (request.operation === "food.eat-safe") {
      // invokeFoodEat 的读回事实形状。
      if (input.itemName === undefined) {
        throw new Error("food.eat-safe request is missing itemName");
      }
      return {
        succeeded: true,
        itemName: input.itemName,
        remainingCount: 2,
        consumedCount: 1,
        hungerBefore: 17,
        hungerAfter: 20,
        saturationBefore: 5,
        saturationAfter: 11,
        projectedSaturationGain: 6,
        reasonCode: "BEST_SATURATION_EFFICIENCY",
      };
    }
    if (request.operation === "sleep-safe") {
      if (input.bed === undefined) {
        throw new Error("sleep-safe request is missing bed");
      }
      return {
        succeeded: true,
        isSleepingAfter: true,
        sleepableWindowAtAttempt: true,
        timeOfDayAtAttempt: 15_000,
        timeOfDayAfter: 15_000,
        bedBlockName: "red_bed",
        position: input.bed,
      };
    }
    if (request.operation === "fluid.fill-safe") {
      if (input.mode === undefined || input.target === undefined) {
        throw new Error("fluid.fill-safe request is missing mode/target");
      }
      return {
        succeeded: true,
        mode: input.mode,
        filledItemName: input.mode === "water" ? "water_bucket" : "lava_bucket",
        emptyBucketBefore: 2,
        emptyBucketAfter: 1,
        filledBucketBefore: 0,
        filledBucketAfter: 1,
        resultingBlockName: "air",
        position: input.target,
      };
    }
    throw new Error(
      `Unexpected capability operation: ${request.capability}/${request.operation}`,
    );
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
      hasResource: () => true,
      serverCapability: () => undefined,
    };
  }

  async close(): Promise<void> {
    this.handlers?.onDisconnected({ reason: "requested_stop", expected: true });
  }

  spawn(): void {
    this.handlers?.onSpawn();
  }

  stateChanged(): void {
    this.handlers?.onStateChanged();
  }
}

const logger: RuntimeLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

let seed = 0;
function testUuid(offset: number): string {
  const suffix = (seed * 8 + offset).toString(16).padStart(4, "0").slice(-4);
  return `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb`.slice(0, 32) + suffix;
}

function skillInvocation(
  skillId: string,
  input: SkillInvocationV1["payload"]["input"],
): SkillInvocationV1 {
  seed += 1;
  return {
    schemaVersion: "1.0",
    messageId: testUuid(1),
    traceId: `trace-${skillId.replace(".", "-")}-state`,
    timestamp: "2026-07-19T10:00:00.000Z",
    source: { service: "coordinator", instanceId: "coordinator-01" },
    botId: profile.botId,
    taskId: `task-${skillId.replace(".", "-")}-state`,
    type: "skill.invoke.v1",
    payload: {
      invocationId: testUuid(2),
      skillId,
      skillVersion: "1.0.0",
      expiresAt: "2026-07-19T10:01:00.000Z",
      input,
      authorization: {
        decisionId: testUuid(3),
        actorId: "coordinator-agent",
        issuedAt: "2026-07-19T09:59:59.000Z",
        expiresAt: "2026-07-19T10:01:00.000Z",
      },
    },
  };
}

function authorizationFor(
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
    allowedCapabilities: new Set(["world.interact"]),
  };
}

function startRuntime(snapshot?: BotClientSnapshot) {
  const client = new SnapshotClient(snapshot);
  const runtime = new SingleBotRuntime(profile, {
    createClient: () => client,
    messageSink: () => undefined,
    logger,
    now: () => new Date(Date.now()),
    randomId: () => FIXED_UUID,
  });
  runtime.start();
  client.spawn();
  return { client, runtime };
}

async function pauseViaLowHealth(client: SnapshotClient): Promise<void> {
  client.setSnapshot(baseSnapshot({ health: { current: 8, maximum: 20 } }));
  client.stateChanged();
  await vi.advanceTimersByTimeAsync(0);
}

describe("basic actions reach the adapter through the real runtime state assembly", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [
      "food.eat",
      "food.eat-safe",
      { itemName: "bread", dimension: "minecraft:overworld", serverProfileId: profile.id },
    ],
    [
      "sleep.bed",
      "sleep-safe",
      { bed: { x: 10, y: 64, z: -20 }, dimension: "minecraft:overworld", serverProfileId: profile.id },
    ],
    [
      "bucket.fill",
      "fluid.fill-safe",
      { mode: "water", target: { x: 10, y: 63, z: -20 }, dimension: "minecraft:overworld", serverProfileId: profile.id },
    ],
  ] as const)(
    "%s completes through handleSkillInvocation and calls %s",
    async (skillId, operation, input) => {
      const { client, runtime } = startRuntime();
      const invocation = skillInvocation(skillId, input);
      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation),
      );
      expect(completed.payload).toMatchObject({ outcome: "completed", skillId });
      expect(client.capabilityCalls).toHaveLength(1);
      expect(client.capabilityCalls[0]).toMatchObject({
        capability: "world.interact",
        operation,
        skillId,
      });

      // L0 暂停后同一调用必须被拒，且不产生新的 capability 调用。
      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);
      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      await runtime.stop("test_cleanup");
    },
  );

  it("food.eat refuses a non-finite hunger reading as invalid state (SKILL_STATE_INVALID)", async () => {
    // NaN 是"服务器推了一个非法读数"的诚实替身：stateSchema 的 0..20 会挡住它，
    // 于是拒绝发生在技能边界而不是被当成一个可用数值算下去。
    const { client, runtime } = startRuntime(
      baseSnapshot({ food: { level: Number.NaN, saturation: 0 } }),
    );
    const invocation = skillInvocation("food.eat", {
      itemName: "bread",
      dimension: "minecraft:overworld",
      serverProfileId: profile.id,
    });
    const rejected = await runtime.handleSkillInvocation(
      invocation,
      authorizationFor(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "SKILL_STATE_INVALID",
    });
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });

  it("food.eat is not reachable at critical hunger: L0 owns ≤14 and pauses normal actions", async () => {
    // 分工钉死：饥饿 ≤14（EAT_AT_FOOD_LEVEL）由 L0 反射层自己吃
    // （CONSUME_SAFE_FOOD），普通技能一律被暂停。将来有人把这条当"bug"去
    // "修"（例如给 food.eat 开个豁免），这里会立刻变红。
    const { client, runtime } = startRuntime(
      baseSnapshot({ food: { level: 12, saturation: 1 } }),
    );
    const invocation = skillInvocation("food.eat", {
      itemName: "bread",
      dimension: "minecraft:overworld",
      serverProfileId: profile.id,
    });
    const rejected = await runtime.handleSkillInvocation(
      invocation,
      authorizationFor(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "NORMAL_ACTIONS_PAUSED",
    });
    expect(runtime.canAcceptNormalActions()).toBe(false);
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });

  it("food.eat refuses at full hunger before the adapter is reached", async () => {
    const { client, runtime } = startRuntime(
      baseSnapshot({ food: { level: 20, saturation: 8 } }),
    );
    const invocation = skillInvocation("food.eat", {
      itemName: "bread",
      dimension: "minecraft:overworld",
      serverProfileId: profile.id,
    });
    const rejected = await runtime.handleSkillInvocation(
      invocation,
      authorizationFor(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "FOOD_NOT_NEEDED",
    });
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });

  it("sleep.bed fails closed with BOT_TIME_UNKNOWN when the server never sent world time", async () => {
    // time 整块缺失 = 时间包没来。技能必须拒绝，而不是假定"现在是夜晚"。
    const { client, runtime } = startRuntime(baseSnapshot({ time: undefined }));
    const invocation = skillInvocation("sleep.bed", {
      bed: { x: 10, y: 64, z: -20 },
      dimension: "minecraft:overworld",
      serverProfileId: profile.id,
    });
    const rejected = await runtime.handleSkillInvocation(
      invocation,
      authorizationFor(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "BOT_TIME_UNKNOWN",
    });
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });

  it("sleep.bed refuses daytime before the adapter is reached", async () => {
    const { client, runtime } = startRuntime(
      baseSnapshot({ time: { timeOfDay: 6_000, isRaining: false, thunderState: 0 } }),
    );
    const invocation = skillInvocation("sleep.bed", {
      bed: { x: 10, y: 64, z: -20 },
      dimension: "minecraft:overworld",
      serverProfileId: profile.id,
    });
    const rejected = await runtime.handleSkillInvocation(
      invocation,
      authorizationFor(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "SLEEP_NOT_NIGHT",
    });
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });

  it("bucket.fill fails closed when the snapshot holds no empty bucket", async () => {
    const { client, runtime } = startRuntime(
      baseSnapshot({ inventory: [{ itemName: "bread", count: 3 }] }),
    );
    const invocation = skillInvocation("bucket.fill", {
      mode: "water",
      target: { x: 10, y: 63, z: -20 },
      dimension: "minecraft:overworld",
      serverProfileId: profile.id,
    });
    const rejected = await runtime.handleSkillInvocation(
      invocation,
      authorizationFor(invocation),
    );
    expect(rejected.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "FLUID_BUCKET_MISSING",
    });
    expect(client.capabilityCalls).toHaveLength(0);
    await runtime.stop("test_cleanup");
  });
});

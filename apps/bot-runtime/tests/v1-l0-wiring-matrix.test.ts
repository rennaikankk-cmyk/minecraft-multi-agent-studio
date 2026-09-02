import type { SkillInvocationV1 } from "@minecraft-studio/protocol";
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
import type { CombatPrimitiveAction } from "../src/combat-driver.js";
import { SingleBotRuntime } from "../src/runtime.js";
import type { ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

// ---------------------------------------------------------------------------
// L0 接线矩阵 —— packages/skills/src/skill-status.ts 的 runtimeWiring 证据位。
//
// 位语义（skill-status.ts）："运行时能力适配器已接线，且 L0 阻断路径有测试"。
// 每个技能一组：先经真实的 handleSkillInvocation 派发路径跑到 completed 并
// 记下预期的 capability 调用（capability + operation），再置 L0 低血暂停
// （health 8 = LOW_HEALTH），同一调用必须被拒以 NORMAL_ACTIONS_PAUSED 且
// 不产生新的 capability 调用。
//
// Fake 只证明**接线**（信封校验 → 授权 → 前置条件 → executor → capability
// 适配器 → 输出 schema），不证明游戏语义：capability 返回值按真实适配器
// （mineflayer-client.ts invokeMinePlan / invokePlaceBlock /
// invokeContainerTransfer）的完成契约取最小诚实形状。
//
// 例外：stock.levels 是纯函数（requiredCapabilities: []，stateSchema strip
// 成 {}，无前置条件），L0 暂停对它**按设计不生效**——它在暂停期间照样完成
// 才是诚实行为。它的 runtimeWiring 保持 false，直到为这类只读计算技能定义
// 豁免语义；见文件末尾的 describe。
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
  armorSlots: { head: null, chest: null, legs: null, feet: null },
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

/**
 * 与 runtime.test.ts 的 FakeBotClient 同构，capability 侧按 operation 分派：
 * 每个 operation 的返回值都取真实 mineflayer 适配器的完成契约形状，未登记的
 * operation 直接抛错——fakes 不允许悄悄吞掉不认识的调用。
 */
class WiringBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  closeCalls = 0;
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
    return { outcome: "executed", errorCode: null };
  }

  async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    this.capabilityCalls.push(request);
    const input = request.input as {
      plan?: unknown;
      itemName?: string;
      target?: { x: number; y: number; z: number };
      direction?: "deposit" | "withdraw";
      count?: number;
    };
    if (
      request.operation === "mine.branch-safe" ||
      request.operation === "mine.vein-safe"
    ) {
      // invokeMinePlan 完成后返回它执行过的已校验 plan。
      if (input.plan === undefined) {
        throw new Error("mine capability request is missing its plan");
      }
      return structuredClone(input.plan);
    }
    if (request.operation === "block.place-safe") {
      // invokePlaceBlock 返回落块事实；blueprint 分支按 target 校验位置。
      if (input.itemName === undefined || input.target === undefined) {
        throw new Error("place capability request is missing itemName/target");
      }
      return {
        placed: true,
        placedBlockName: input.itemName,
        position: { x: input.target.x, y: input.target.y, z: input.target.z },
      };
    }
    if (request.operation === "container.transfer-safe") {
      // invokeContainerTransfer 返回读回的转移数量；fake 记全额移动。
      if (
        input.direction === undefined ||
        input.itemName === undefined ||
        input.count === undefined
      ) {
        throw new Error("transfer capability request is missing fields");
      }
      return {
        direction: input.direction,
        itemName: input.itemName,
        requestedCount: input.count,
        movedCount: input.count,
      };
    }
    throw new Error(
      `Unexpected capability operation: ${request.capability}/${request.operation}`,
    );
  }

  combatObservation(): null {
    return null;
  }

  async executeCombatAction(
    _action: CombatPrimitiveAction,
    signal: AbortSignal,
  ) {
    if (signal.aborted) return { outcome: "failed" as const, reasonCode: "SKILL_CANCELLED" };
    return { outcome: "executed" as const, executedAtMs: Date.now() };
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

  disconnect(info: BotDisconnectInfo): void {
    this.handlers?.onDisconnected(info);
  }
}

const logger: RuntimeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function testUuid(seed: number): string {
  const suffix = seed.toString(16).padStart(4, "0").slice(-4);
  return `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`.slice(0, 32) + suffix;
}

let envelopeSeed = 0;

function skillInvocation(
  skillId: string,
  input: SkillInvocationV1["payload"]["input"],
): SkillInvocationV1 {
  envelopeSeed += 1;
  return {
    schemaVersion: "1.0",
    messageId: testUuid(envelopeSeed * 4 + 1),
    traceId: `trace-${skillId.replace(".", "-")}-wiring`,
    timestamp: "2026-07-19T10:00:00.000Z",
    source: { service: "coordinator", instanceId: "coordinator-01" },
    botId: profile.botId,
    taskId: `task-${skillId.replace(".", "-")}-wiring`,
    type: "skill.invoke.v1",
    payload: {
      invocationId: testUuid(envelopeSeed * 4 + 2),
      skillId,
      skillVersion: "1.0.0",
      expiresAt: "2026-07-19T10:01:00.000Z",
      input,
      authorization: {
        decisionId: testUuid(envelopeSeed * 4 + 3),
        actorId: "coordinator-agent",
        issuedAt: "2026-07-19T09:59:59.000Z",
        expiresAt: "2026-07-19T10:01:00.000Z",
      },
    },
  };
}

function authorizationFor(
  invocation: SkillInvocationV1,
  capabilities: readonly SkillCapabilityRequest["capability"][],
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
    allowedCapabilities: new Set(capabilities),
  };
}

function startWiredRuntime(): {
  client: WiringBotClient;
  runtime: SingleBotRuntime;
} {
  const client = new WiringBotClient();
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

async function pauseViaLowHealth(client: WiringBotClient): Promise<void> {
  client.setSnapshot({
    ...snapshot,
    health: { current: 8, maximum: 20 },
  });
  client.stateChanged();
  await vi.advanceTimersByTimeAsync(0);
}

describe("L0 wiring matrix", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("mine.branch", () => {
    it("executes through handleSkillInvocation and is blocked when L0 pauses", async () => {
      const { client, runtime } = startWiredRuntime();
      const invocation = skillInvocation("mine.branch", {
        targetItem: "minecraft:iron_ore",
        yLevel: 16,
        branchLength: 2,
        branchSpacing: 2,
        maxBlocks: 4,
        origin: { x: 10, y: 16, z: -20 },
        dimension: "minecraft:overworld",
        serverProfileId: profile.id,
        backfill: false,
        exclusions: [
          "own-hideout",
          "blueprint-anchor",
          "load-bearing",
          "liquid-adjacent",
        ],
      });

      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["world.interact"]),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "mine.branch",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      expect(client.capabilityCalls[0]).toMatchObject({
        capability: "world.interact",
        operation: "mine.branch-safe",
        skillId: "mine.branch",
      });

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["world.interact"]),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      await runtime.stop("test_cleanup");
    });
  });

  describe("mine.vein", () => {
    it("executes through handleSkillInvocation and is blocked when L0 pauses", async () => {
      const { client, runtime } = startWiredRuntime();
      const invocation = skillInvocation("mine.vein", {
        targetItem: "minecraft:diamond_ore",
        // 规划器无条件拒绝 yLevel < -58（MINE_VOID_RISK），矿脉样本取安全层。
        yLevel: 16,
        maxBlocks: 4,
        origin: { x: 10, y: 16, z: -20 },
        orePositions: [
          { x: 11, y: 16, z: -20 },
          { x: 11, y: 17, z: -21 },
        ],
        dimension: "minecraft:overworld",
        serverProfileId: profile.id,
        backfill: false,
        exclusions: [
          "own-hideout",
          "blueprint-anchor",
          "load-bearing",
          "liquid-adjacent",
        ],
      });

      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["world.interact"]),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "mine.vein",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      expect(client.capabilityCalls[0]).toMatchObject({
        capability: "world.interact",
        operation: "mine.vein-safe",
        skillId: "mine.vein",
      });

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["world.interact"]),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      await runtime.stop("test_cleanup");
    });
  });

  describe("build.blueprint", () => {
    it("executes through handleSkillInvocation and is blocked when L0 pauses", async () => {
      const { client, runtime } = startWiredRuntime();
      const invocation = skillInvocation("build.blueprint", {
        blueprint: {
          anchor: { x: 10, y: 64, z: -20 },
          dimension: "minecraft:overworld",
          serverProfileId: profile.id,
          cells: [
            {
              offset: { x: 0, y: 0, z: 0 },
              itemName: "stone",
              blockClass: "foundation",
              order: 0,
            },
            {
              offset: { x: 1, y: 0, z: 0 },
              itemName: "stone",
              blockClass: "structural",
              order: 1,
            },
          ],
        },
      });

      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["world.interact"]),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "build.blueprint",
      });
      // 每个 cell 一次 block.place-safe（真实适配器的 blueprint 输入分支）。
      expect(client.capabilityCalls).toHaveLength(2);
      for (const call of client.capabilityCalls) {
        expect(call).toMatchObject({
          capability: "world.interact",
          operation: "block.place-safe",
          skillId: "build.blueprint",
        });
      }

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["world.interact"]),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(2);
      await runtime.stop("test_cleanup");
    });
  });

  describe("store.sort", () => {
    it("executes through handleSkillInvocation and is blocked when L0 pauses", async () => {
      const { client, runtime } = startWiredRuntime();
      const invocation = skillInvocation("store.sort", {
        routes: [
          {
            itemName: "oak_log",
            count: 3,
            container: { x: 10, y: 64, z: -20 },
            dimension: "minecraft:overworld",
            serverProfileId: profile.id,
          },
        ],
        startIndex: 0,
        maxTransfers: 4,
      });

      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["container.write"]),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "store.sort",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      expect(client.capabilityCalls[0]).toMatchObject({
        capability: "container.write",
        operation: "container.transfer-safe",
        skillId: "store.sort",
      });

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["container.write"]),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      await runtime.stop("test_cleanup");
    });
  });

  describe("pack.shulker", () => {
    it("executes through handleSkillInvocation and is blocked when L0 pauses", async () => {
      const { client, runtime } = startWiredRuntime();
      const invocation = skillInvocation("pack.shulker", {
        shulker: { x: 10, y: 64, z: -20 },
        items: [{ itemName: "oak_log", count: 2 }],
        dimension: "minecraft:overworld",
        serverProfileId: profile.id,
        startIndex: 0,
        maxTransfers: 27,
      });

      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["container.write"]),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "pack.shulker",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      expect(client.capabilityCalls[0]).toMatchObject({
        capability: "container.write",
        operation: "container.transfer-safe",
        skillId: "pack.shulker",
      });

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, ["container.write"]),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(1);
      await runtime.stop("test_cleanup");
    });
  });

  describe("movement.profile", () => {
    it("executes through handleSkillInvocation and is blocked when L0 pauses", async () => {
      const { client, runtime } = startWiredRuntime();
      const invocation = skillInvocation("movement.profile", {
        profile: "SAFE",
        serverProfileId: profile.id,
      });

      // 纯决策技能：没有 capability 调用，接线点在 runtime 状态路径
      // （skillState 的 policyLimits / isolatedTestServer 喂给前置条件）。
      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, []),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "movement.profile",
      });
      expect(client.capabilityCalls).toHaveLength(0);

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const rejected = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, []),
      );
      expect(rejected.payload).toMatchObject({
        outcome: "rejected",
        errorCode: "NORMAL_ACTIONS_PAUSED",
      });
      expect(client.capabilityCalls).toHaveLength(0);
      await runtime.stop("test_cleanup");
    });
  });

  describe("stock.levels", () => {
    // 纯函数技能：requiredCapabilities 为空、stateSchema strip 成 {}、无前置
    // 条件——L0 暂停对它按设计不生效（暂停期间照样完成才是诚实行为，强行
    // 断言"被阻断"就是伪造一条不存在的路径）。因此它的 runtimeWiring 证据
    // 位保持 false：要么先为只读计算技能定义豁免语义，要么给它一条真实的
    // L0 联动（例如 state.normalActionsAllowed 前置）。这条测试固定住当前
    // 的豁免事实，防止它被悄悄改变。
    it("completes through handleSkillInvocation and is documented as exempt from the L0 pause", async () => {
      const { client, runtime } = startWiredRuntime();
      const input = {
        levels: [{ itemName: "oak_log", low: 4, target: 16, ceiling: 32 }],
        counts: [{ itemName: "oak_log", count: 7 }],
      };
      const invocation = skillInvocation("stock.levels", input);

      const completed = await runtime.handleSkillInvocation(
        invocation,
        authorizationFor(invocation, []),
      );
      expect(completed.payload).toMatchObject({
        outcome: "completed",
        skillId: "stock.levels",
      });
      expect(client.capabilityCalls).toHaveLength(0);

      await pauseViaLowHealth(client);
      expect(runtime.canAcceptNormalActions()).toBe(false);

      const exemptInvocation = skillInvocation("stock.levels", input);
      const exempt = await runtime.handleSkillInvocation(
        exemptInvocation,
        authorizationFor(exemptInvocation, []),
      );
      expect(exempt.payload).toMatchObject({
        outcome: "completed",
        skillId: "stock.levels",
      });
      expect(client.capabilityCalls).toHaveLength(0);
      await runtime.stop("test_cleanup");
    });
  });
});

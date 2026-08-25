import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import type { Movements } from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";

vi.mock("mineflayer-pathfinder", () => {
  class TestMovements {
    canDig = true;
    canOpenDoors = true;
    dontCreateFlow = false;
    dontMineUnderFallingBlock = false;
    allow1by1towers = true;
    allowFreeMotion = true;
    allowParkour = true;
    allowSprinting = true;
    scafoldingBlocks = [1, 2];
    maxDropDown = 4;
    infiniteLiquidDropdownDistance = true;
    exclusionAreasBreak: Array<(block: never) => number> = [];
    exclusionAreasPlace: Array<(block: never) => number> = [];
  }

  return {
    // 预检查用 GoalLookAtBlock，和 collectblock 自己用的目标一致：实测
    // GoalNear(2) 在 GoalLookAtBlock 183ms 就解出的块上返回 noPath，两者
    // 不可互换。
    default: {
      goals: {
        GoalNear: class {},
        GoalLookAtBlock: class {
          constructor(public pos: unknown) {}
        },
      },
    },
    goals: {
      GoalNear: class {},
      GoalLookAtBlock: class {
        constructor(public pos: unknown) {}
      },
    },
    Movements: TestMovements,
    pathfinder: vi.fn(),
  };
});

import type { BotClientHandlers } from "../src/client.js";
import {
  configureSafePathfinderMovements,
  hasReachableFace,
  MineflayerBotClient,
} from "../src/mineflayer-client.js";

describe("MineflayerBotClient lifecycle", () => {
  it("waits for spawn before subscribing to the deferred inventory", () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;

    expect(() => new MineflayerBotClient(bot, "auto")).not.toThrow();

    const client = new MineflayerBotClient(bot, "auto");
    const onSpawn = vi.fn();
    const onStateChanged = vi.fn();
    client.setHandlers(handlers({ onSpawn, onStateChanged }));
    const inventory = new EventEmitter();
    Object.assign(bot, { inventory });

    emitter.emit("spawn");
    inventory.emit("updateSlot");

    expect(onSpawn).toHaveBeenCalledTimes(1);
    expect(onStateChanged).toHaveBeenCalledTimes(1);
  });

  it("disables every Pathfinder block-changing and high-risk movement mode", () => {
    const movements = {
      canDig: true,
      canOpenDoors: true,
      dontCreateFlow: false,
      dontMineUnderFallingBlock: false,
      allow1by1towers: true,
      allowFreeMotion: true,
      allowParkour: true,
      allowSprinting: true,
      scafoldingBlocks: [1, 2],
      maxDropDown: 4,
      infiniteLiquidDropdownDistance: true,
      exclusionAreasBreak: [],
      exclusionAreasPlace: [],
    } as unknown as Movements;

    configureSafePathfinderMovements(movements);

    expect(movements).toMatchObject({
      canDig: false,
      canOpenDoors: false,
      dontCreateFlow: true,
      dontMineUnderFallingBlock: true,
      allow1by1towers: false,
      allowFreeMotion: false,
      allowParkour: false,
      allowSprinting: false,
      scafoldingBlocks: [],
      maxDropDown: 2,
      infiniteLiquidDropdownDistance: false,
    });
    expect(movements.exclusionAreasBreak[0]?.({} as never)).toBe(100);
    expect(movements.exclusionAreasPlace[0]?.({} as never)).toBe(100);
  });

  it("allows collect.block to break only the targets selected for this invocation", async () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(12, 64, -8);
    const targetBlock = harvestableBlock(targetPosition, 1);
    const collectBlock = {
      chestLocations: [new Vec3(1, 2, 3)],
      movements: null as Movements | null,
      collect: vi.fn(async () => undefined),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock,
    });
    const client = new MineflayerBotClient(
      bot,
      "auto",
      "isolated-test-profile",
    );

    await client.invokeSkillCapability({
      invocationId: "invocation-collect-1",
      traceId: "trace-collect-1",
      taskId: "task-collect-1",
      botId: "bot-collect-1",
      skillId: "collect.block",
      skillVersion: "1.0.0",
      capability: "world.interact",
      operation: "collect.blocks-safe",
      input: {
        blockName: "stone",
        maxCount: 1,
        maxDistance: 8,
        dimension: "minecraft:overworld",
        serverProfileId: "isolated-test-profile",
      },
      signal: new AbortController().signal,
    });

    const movements = collectBlock.movements;
    expect(movements).not.toBeNull();
    expect(movements?.canDig).toBe(true);
    const breakCost = movements?.exclusionAreasBreak[0];
    expect(breakCost?.(targetBlock as never)).toBe(0);
    expect(breakCost?.({ position: targetPosition, type: 2 } as never)).toBe(100);
    expect(
      breakCost?.({ position: targetPosition.offset(1, 0, 0), type: 1 } as never),
    ).toBe(100);
    expect(collectBlock.collect).toHaveBeenCalledWith([targetBlock], {
      ignoreNoPath: false,
    });
    // collectblock 的 collect() 会把这两个安全标志按回 false；钉住之后写入是
    // no-op，读出恒为 true。
    (movements as unknown as Record<string, boolean>).dontMineUnderFallingBlock =
      false;
    (movements as unknown as Record<string, boolean>).dontCreateFlow = false;
    expect(movements?.dontMineUnderFallingBlock).toBe(true);
    expect(movements?.dontCreateFlow).toBe(true);
  });

  it("sets its own pathfinder budget instead of inheriting movement.goto's", async () => {
    // 实测：thinkTimeout 是 astar.js:73 的挂钟期限，而 compute() 每
    // physicsTick(~50ms) 只跑 tickTimeout 毫秒，所以 tickTimeout=20 只有 40%
    // 占空比——5s 预算只买到约 2s 真实计算。40 个暴露目标从固定原点排干测得，
    // 能解的最贵 527ms、noPath 最慢 678ms，都是亚秒级。采集之前从
    // invokeMovementGoto 继承 5000/20，于是取决于调用顺序而不是自己的契约。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(3, 64, 3);
    const targetBlock = harvestableBlock(targetPosition, 1);
    const pathfinder = collectPathfinder();
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder,
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect: vi.fn(async () => undefined),
        cancelTask: vi.fn(async () => undefined),
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await client.invokeSkillCapability({
      ...collectRequest("invocation-collect-budget"),
      input: {
        blockName: "stone",
        maxCount: 1,
        maxDistance: 8,
        dimension: "minecraft:overworld",
        serverProfileId: "isolated-test-profile",
      },
    });

    // 8000ms × 约 80% 占空比 ≈ 6.4s 计算，对实测最坏 527ms 有十倍余量。
    expect(pathfinder.tickTimeout).toBe(40);
    expect(pathfinder.thinkTimeout).toBe(8_000);
  });

  it("does not treat Mineflayer's local dig prediction as a server success", async () => {
    const emitter = new EventEmitter();
    const wire = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(7, 64, 2);
    const targetBlock = {
      position: targetPosition,
      type: 49,
      name: "oak_log",
      boundingBox: "block",
      canHarvest: () => true,
    };
    let digCalls = 0;
    const collectBlock = {
      chestLocations: [] as Vec3[],
      movements: null as Movements | null,
      collect: vi.fn(async () => {
        await bot.dig(targetBlock as never);
      }),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      _client: wire,
      dig: vi.fn(async () => {
        digCalls += 1;
        // The first finish is rejected by the server; the retry is accepted.
        queueMicrotask(() => {
          wire.emit("block_change", {
            location: targetPosition,
            type: digCalls === 1 ? 49 : 0,
          });
        });
      }),
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 49 } } },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      inventory: { items: () => [] },
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock,
    });
    const client = new MineflayerBotClient(
      bot,
      "auto",
      "isolated-test-profile",
    );

    await client.invokeSkillCapability({
      invocationId: "invocation-collect-server-confirm",
      traceId: "trace-collect-server-confirm",
      taskId: "task-collect-server-confirm",
      botId: "bot-collect-server-confirm",
      skillId: "collect.block",
      skillVersion: "1.0.0",
      capability: "world.interact",
      operation: "collect.blocks-safe",
      input: {
        blockName: "oak_log",
        maxCount: 1,
        maxDistance: 8,
        dimension: "minecraft:overworld",
        serverProfileId: "isolated-test-profile",
      },
      signal: new AbortController().signal,
    });

    expect(digCalls).toBe(2);
    expect(collectBlock.collect).toHaveBeenCalledTimes(1);
    expect(wire.listenerCount("block_change")).toBe(0);
  });

  /**
   * Measured on the live 1.21.8 server (protocol 772): an accepted break answers
   * with `acknowledge_player_digging { sequenceId }` and sends no block update at
   * the target at all. Waiting for a block update there made every collect.block
   * time out, so the ack has to count as confirmation on its own.
   */
  it("accepts a digging acknowledgement as the server's confirmation", async () => {
    const emitter = new EventEmitter();
    const wire = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(7, 64, 2);
    const targetBlock = {
      position: targetPosition,
      type: 49,
      name: "oak_log",
      boundingBox: "block",
      canHarvest: () => true,
    };
    let digCalls = 0;
    const collectBlock = {
      chestLocations: [] as Vec3[],
      movements: null as Movements | null,
      collect: vi.fn(async () => {
        await bot.dig(targetBlock as never);
      }),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      _client: wire,
      dig: vi.fn(async () => {
        digCalls += 1;
        queueMicrotask(() => wire.emit("acknowledge_player_digging", { sequenceId: 0 }));
      }),
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 49 } } },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      inventory: { items: () => [] },
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock,
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await client.invokeSkillCapability(
      collectRequest("invocation-collect-ack"),
    );

    expect(digCalls).toBe(1);
    expect(wire.listenerCount("acknowledge_player_digging")).toBe(0);
    expect(wire.listenerCount("block_change")).toBe(0);
    expect(wire.listenerCount("multi_block_change")).toBe(0);
  });

  /**
   * A correction arrives right after the ack, which is the whole reason the ack
   * is held for a grace window instead of being trusted on arrival. Trusting it
   * immediately would report a break the server put straight back.
   */
  it("treats a correcting block update after an acknowledgement as a rejection", async () => {
    const emitter = new EventEmitter();
    const wire = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(7, 64, 2);
    const targetBlock = {
      position: targetPosition,
      type: 49,
      name: "oak_log",
      boundingBox: "block",
      canHarvest: () => true,
    };
    let digCalls = 0;
    const collectBlock = {
      chestLocations: [] as Vec3[],
      movements: null as Movements | null,
      collect: vi.fn(async () => {
        await bot.dig(targetBlock as never);
      }),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      _client: wire,
      dig: vi.fn(async () => {
        digCalls += 1;
        const attempt = digCalls;
        queueMicrotask(() => {
          wire.emit("acknowledge_player_digging", { sequenceId: 0 });
          // First attempt: the server puts the block back inside the grace
          // window. Second attempt: it confirms air.
          wire.emit("block_change", {
            location: targetPosition,
            type: attempt === 1 ? 49 : 0,
          });
        });
      }),
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 49 } } },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      inventory: { items: () => [] },
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock,
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await client.invokeSkillCapability(
      collectRequest("invocation-collect-corrected"),
    );

    expect(digCalls).toBe(2);
  });

  /**
   * `multi_block_change` records are packed varints from 1.16 on, not containers.
   * Reading `horizontalPos`/`blockId` off a number yields `undefined` for every
   * field, so every batched update was dropped without a trace.
   */
  it("decodes a packed multi-block-change record as an authoritative update", async () => {
    const emitter = new EventEmitter();
    const wire = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(7, 64, 2);
    const targetBlock = {
      position: targetPosition,
      type: 49,
      name: "oak_log",
      boundingBox: "block",
      canHarvest: () => true,
    };
    let digCalls = 0;
    const collectBlock = {
      chestLocations: [] as Vec3[],
      movements: null as Movements | null,
      collect: vi.fn(async () => {
        await bot.dig(targetBlock as never);
      }),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      _client: wire,
      dig: vi.fn(async () => {
        digCalls += 1;
        // stateId 0 (air) at local x=7, z=2, y=0 of section y=4 → 7*256 + 2*16.
        const packedAir = 7 * 256 + 2 * 16;
        queueMicrotask(() => {
          wire.emit("multi_block_change", {
            chunkCoordinates: { x: 0, z: 0, y: 4 },
            records: [packedAir],
          });
        });
      }),
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 49 } } },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      inventory: { items: () => [] },
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock,
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await client.invokeSkillCapability(
      collectRequest("invocation-collect-packed-record"),
    );

    expect(digCalls).toBe(1);
    expect(wire.listenerCount("multi_block_change")).toBe(0);
  });

  it("waits for the collected item slot update before reporting inventory delta", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(2, 64, 0);
    const targetBlock = {
      position: targetPosition,
      type: 1,
      name: "oak_log",
      boundingBox: "block",
      canHarvest: () => true,
    };
    let itemCount = 0;
    // 斧子在前后都在，所以它不动增量；只是让可采集门禁通过。
    inventory.items = () =>
      itemCount > 0
        ? [
            { name: "wooden_axe", type: 800, count: 1 },
            { name: "oak_log", count: itemCount },
          ]
        : [{ name: "wooden_axe", type: 800, count: 1 }];
    const collectBlock = {
      chestLocations: [] as Vec3[],
      movements: null as Movements | null,
      collect: vi.fn(async () => {
        setTimeout(() => {
          itemCount = 1;
          inventory.emit("updateSlot", 9, null, {
            name: "oak_log",
            count: 1,
          });
        }, 0);
      }),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 1 } } },
      inventory,
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
      collectBlock,
    });
    const client = new MineflayerBotClient(
      bot,
      "auto",
      "isolated-test-profile",
    );

    await expect(
      client.invokeSkillCapability({
        invocationId: "invocation-collect-delayed-slot",
        traceId: "trace-collect-delayed-slot",
        taskId: "task-collect-delayed-slot",
        botId: "bot-collect-delayed-slot",
        skillId: "collect.block",
        skillVersion: "1.0.0",
        capability: "world.interact",
        operation: "collect.blocks-safe",
        input: {
          blockName: "oak_log",
          maxCount: 1,
          maxDistance: 4,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({
      blockName: "oak_log",
      targetsFound: 1,
      itemsCollected: 1,
    });
  });

  it.each([
    ["NoPath", "COLLECT_TARGET_UNREACHABLE"],
    ["Timeout", "COLLECT_PATH_SEARCH_EXHAUSTED"],
    ["Error", "COLLECT_BLOCKS_FAILED"],
  ])(
    "reports a %s rejection from collectBlock as %s with the cause attached",
    async (errorName, expectedCode) => {
      // 实测这两种失败在活动运行时里长得一样但含义相反：一次 A* 在 700ms 就
      // 判出 noPath 的搜索，被 tickTimeout=20 切片后拖到 5010ms 报成
      // "Took to long to decide path to goal!"。合成一个码就等于把"到不了"
      // 报成"再试一次就好"，规划器会烧完整条重试阶梯。
      const emitter = new EventEmitter();
      const bot = emitter as unknown as Bot;
      const rejection = new Error("Took to long to decide path to goal!");
      rejection.name = errorName;
      Object.assign(bot, {
        game: { dimension: "overworld" },
        registry: { blocksByName: { oak_log: { id: 1 } } },
        inventory: { items: () => [{ name: "wooden_axe", type: 800, count: 1 }] },
        entity: { position: new Vec3(0, 64, 0) },
        world: {},
        findBlocks: vi.fn(() => [new Vec3(1, 64, 1)]),
        blockAt: vi.fn(() => ({
          name: "oak_log",
          type: 1,
          position: new Vec3(1, 64, 1),
          boundingBox: "block",
          canHarvest: () => true,
        })),
        // 预检查判定可达，所以拒绝只能来自 collect 本身——正是这条测试要区分的。
        pathfinder: collectPathfinder(),
        collectBlock: {
          collect: vi.fn(async () => {
            throw rejection;
          }),
          cancelTask: vi.fn(async () => undefined),
        },
      });
      const client = new MineflayerBotClient(
        bot,
        "auto",
        "isolated-test-profile",
      );

      await expect(
        client.invokeSkillCapability(collectRequest("invocation-collect-fail")),
      ).rejects.toMatchObject({
        code: expectedCode,
        message: "Took to long to decide path to goal!",
      });
    },
  );

  it("refuses to collect a block nothing in the inventory can harvest", async () => {
    // 实测这不是洁癖检查而是防崩溃：空手对石头 canHarvest(null) 为假，
    // mineflayer-tool 的 equipForBlock 在 itemList 空且 getFromChest 时会递归
    // 调用自己（tool.js:118-137），而 retrieveTools 在没有箱子时是 resolve 不是
    // throw，于是无界递归——实测 15ms 递归 2001 层，活动运行时里堆到 ~3.94GB
    // 后 Ineffective mark-compacts 崩溃，事件循环全程被占死。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(4, 64, 4);
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => harvestableBlock(targetPosition, 1)),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect,
        cancelTask: vi.fn(async () => undefined),
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability({
        ...collectRequest("invocation-collect-no-tool"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).rejects.toMatchObject({ code: "COLLECT_TOOL_MISSING" });
    // 关键断言：根本没进 collectblock，递归就无从发生。
    expect(collect).not.toHaveBeenCalled();
  });

  it("drops targets the bounded pre-check proves unreachable instead of aborting the batch", async () => {
    // CollectBlock.js:33 的 `// TODO: options.ignoreNoPath` 意味着 collectAll
    // 里任一目标 goto 被拒就中止整批。实测 40 个暴露目标里 7 个是 noPath，
    // 而选择是按距离的，所以撞上一个纯属常态。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const reachablePosition = new Vec3(2, 64, 0);
    const blockedPosition = new Vec3(9, 64, 0);
    const reachable = harvestableBlock(reachablePosition, 1);
    const blocked = harvestableBlock(blockedPosition, 1);
    const collect = vi.fn(async () => undefined);
    const pathfinder = collectPathfinder();
    pathfinder.getPathFromTo = vi.fn(function* (
      _movements: unknown,
      _start: unknown,
      goal: { pos?: Vec3; x?: number },
    ) {
      const x = goal.pos?.x ?? goal.x;
      yield {
        result: {
          status: x === blockedPosition.x ? "noPath" : "success",
          path: [],
          time: 1,
          visitedNodes: 1,
        },
      };
    }) as never;
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder,
      findBlocks: vi.fn(() => [reachablePosition, blockedPosition]),
      blockAt: vi.fn((position: Vec3) =>
        position.x === blockedPosition.x ? blocked : reachable,
      ),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect,
        cancelTask: vi.fn(async () => undefined),
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability({
        ...collectRequest("invocation-collect-precheck"),
        input: {
          blockName: "stone",
          maxCount: 2,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
      // targetsFound 报的是真正追的目标数，不是扫到的数量——否则规划器的
      // 验收谓词会拿一个虚高的数字去比对。
    ).resolves.toMatchObject({ targetsFound: 1 });
    expect(collect).toHaveBeenCalledWith([reachable], { ignoreNoPath: false });
  });

  it("reports every candidate proven unreachable as unreachable, not as a budget failure", async () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(9, 64, 0);
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder("noPath"),
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => harvestableBlock(targetPosition, 1)),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect,
        cancelTask: vi.fn(async () => undefined),
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability({
        ...collectRequest("invocation-collect-all-blocked"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).rejects.toMatchObject({ code: "COLLECT_TARGET_UNREACHABLE" });
    expect(collect).not.toHaveBeenCalled();
  });

  it("exposes negotiated protocol, feature, and registry facts to skills", () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    Object.assign(bot, {
      version: "1.21.11",
      protocolVersion: 774,
      majorVersion: "1.21",
      registry: {
        supportFeature: (name: string) => name === "hasElytraFlying",
        itemsByName: { mace: { id: 1 } },
        blocksByName: { oak_log: { id: 2 } },
        entitiesByName: { breeze: { id: 3 } },
      },
    });
    const facts = new MineflayerBotClient(
      bot,
      "auto",
    ).skillCompatibilityEnvironment();

    expect(facts).toMatchObject({
      minecraftVersion: "1.21.11",
      protocolVersion: 774,
    });
    expect(facts.supportsFeature("hasElytraFlying")).toBe(true);
    expect(facts.hasResource("item", "mace")).toBe(true);
    expect(facts.hasResource("block", "log")).toBe(false);
    expect(facts.serverCapability("combat.mace-enabled")).toBeUndefined();
  });

  it("measures a container deposit from the inventory state synchronized on open", async () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    let cobblestoneCount = 5;
    const deposit = vi.fn(async (_type: number, _metadata: number | null, count: number) => {
      cobblestoneCount -= count;
    });
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { itemsByName: { cobblestone: { id: 1 } } },
      inventory: {
        items: () =>
          cobblestoneCount > 0
            ? [{ name: "cobblestone", count: cobblestoneCount }]
            : [],
      },
      blockAt: vi.fn(() => ({ name: "chest" })),
      openContainer: vi.fn(async () => {
        // Simulate the prior place-block slot update arriving with window sync.
        cobblestoneCount = 4;
        return { deposit, withdraw: vi.fn(), close: vi.fn() };
      }),
    });
    const client = new MineflayerBotClient(
      bot,
      "auto",
      "isolated-test-profile",
    );

    await expect(
      client.invokeSkillCapability({
        invocationId: "invocation-container-1",
        traceId: "trace-container-1",
        taskId: "task-container-1",
        botId: "bot-container-1",
        skillId: "container.transfer",
        skillVersion: "1.0.0",
        capability: "container.write",
        operation: "container.transfer-safe",
        input: {
          direction: "deposit",
          itemName: "cobblestone",
          count: 4,
          container: { x: 5, y: 65, z: -2 },
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ requestedCount: 4, movedCount: 4 });
    expect(deposit).toHaveBeenCalledWith(1, null, 4);
  });
});

/**
 * collect.block 的寻路替身。可达性预检查用 getPathFromTo 排干一个生成器，
 * 所以替身要 yield 一个终态；默认 success 表示"这个目标走得到"。
 */
function collectPathfinder(status: "success" | "noPath" = "success") {
  return {
    setGoal: vi.fn(),
    setMovements: vi.fn(),
    stop: vi.fn(),
    goto: vi.fn(async () => undefined),
    thinkTimeout: 5_000,
    tickTimeout: 20,
    getPathFromTo: vi.fn(function* () {
      yield { result: { status, path: [], time: 1, visitedNodes: 1 } };
    }),
  };
}

// 采集目标的默认形态：空手挖不动，但背包里的工具挖得动。真实的石头就是这样，
// 而这条区分正是防 OOM 闸门的判据。
function harvestableBlock(position: Vec3, type: number) {
  return {
    position,
    type,
    name: "stone",
    boundingBox: "block",
    canHarvest: (itemType: number | null) => itemType !== null,
  };
}

function collectRequest(invocationId: string) {
  return {
    invocationId,
    traceId: `trace-${invocationId}`,
    taskId: `task-${invocationId}`,
    botId: `bot-${invocationId}`,
    skillId: "collect.block",
    skillVersion: "1.0.0",
    capability: "world.interact" as const,
    operation: "collect.blocks-safe",
    input: {
      blockName: "oak_log",
      maxCount: 1,
      maxDistance: 8,
      dimension: "minecraft:overworld",
      serverProfileId: "isolated-test-profile",
    },
    signal: new AbortController().signal,
  };
}

function handlers(
  overrides: Partial<BotClientHandlers>,
): BotClientHandlers {
  return {
    onSpawn: () => undefined,
    onStateChanged: () => undefined,
    onDisconnected: () => undefined,
    onError: () => undefined,
    onVersionUnsupported: () => undefined,
    ...overrides,
  };
}

describe("MineflayerBotClient travel.route capability", () => {
  it("strict-parses route metadata and delegates one bounded segment to movement.goto", async () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const pathfinder = {
      setMovements: vi.fn(),
      thinkTimeout: 0,
      tickTimeout: 0,
      stop: vi.fn(),
      goto: vi.fn(async () => {
        bot.entity.position = new Vec3(4, 64, 0);
      }),
    };
    Object.assign(bot, {
      game: { dimension: "overworld" },
      entity: { position: new Vec3(0, 64, 0) },
      pathfinder,
    });
    const client = new MineflayerBotClient(
      bot,
      "auto",
      "isolated-test-profile",
    );
    const request = {
      traceId: "trace-route-runtime",
      taskId: "task-route-runtime",
      botId: "bot-route-runtime",
      skillId: "travel.route",
      skillVersion: "1.0.0",
      capability: "bot.move" as const,
      operation: "travel.route-segment",
      signal: new AbortController().signal,
    };

    await expect(
      client.invokeSkillCapability({
        ...request,
        invocationId: "invocation-route-runtime",
        input: {
          target: {
            x: 4,
            y: 64,
            z: 0,
            dimension: "minecraft:overworld",
            serverProfileId: "isolated-test-profile",
          },
          radius: 1,
          corridorPolicy: "axis-aligned",
          segmentIndex: 0,
        },
      }),
    ).resolves.toMatchObject({
      reached: true,
      finalPosition: {
        x: 4,
        y: 64,
        z: 0,
        dimension: "minecraft:overworld",
        serverProfileId: "isolated-test-profile",
      },
    });
    expect(pathfinder.goto).toHaveBeenCalledTimes(1);
    expect(pathfinder.setMovements).toHaveBeenCalledTimes(1);

    await expect(
      client.invokeSkillCapability({
        ...request,
        invocationId: "invocation-route-runtime-invalid",
        input: {
          target: {
            x: 4,
            y: 64,
            z: 0,
            dimension: "minecraft:overworld",
            serverProfileId: "isolated-test-profile",
          },
          radius: 1,
          corridorPolicy: "axis-aligned",
          segmentIndex: 0,
          unexpected: true,
        },
      }),
    ).rejects.toMatchObject({ code: "SKILL_CAPABILITY_INPUT_INVALID" });
  });
});

describe("MineflayerBotClient world.scan capability", () => {
  const request = {
    invocationId: "invocation-scan",
    traceId: "trace-scan",
    taskId: "task-scan",
    botId: "bot-scan",
    skillId: "world.scan",
    skillVersion: "1.0.0",
    capability: "world.read" as const,
    operation: "world.scan-blocks-safe",
    signal: new AbortController().signal,
    input: {
      blockName: "oak_log",
      maxCount: 4,
      maxDistance: 32,
      dimension: "minecraft:overworld",
      serverProfileId: "isolated-test-profile",
    },
  };

  function scanBot(overrides: Record<string, unknown> = {}): Bot {
    const bot = new EventEmitter() as unknown as Bot;
    Object.assign(bot, {
      game: { dimension: "overworld" },
      entity: { position: new Vec3(0, 64, 0) },
      registry: { blocksByName: { oak_log: { id: 49 } } },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => []),
      blockAt: vi.fn(() => ({ type: 49 })),
      ...overrides,
    });
    return bot;
  }

  it("returns located blocks nearest-first without digging or moving", async () => {
    const far = new Vec3(9, 64, 0);
    const near = new Vec3(2, 64, 0);
    const dig = vi.fn();
    const pathfinder = { goto: vi.fn(), setMovements: vi.fn(), stop: vi.fn() };
    const bot = scanBot({
      findBlocks: vi.fn(() => [far, near]),
      dig,
      pathfinder,
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(client.invokeSkillCapability(request)).resolves.toEqual({
      blockName: "oak_log",
      dimension: "minecraft:overworld",
      // findBlocks returned the far hit first; the caller aims collect.block
      // with this list, so the ordering has to be by distance, not by luck.
      matches: [
        { x: 2, y: 64, z: 0, distance: 2 },
        { x: 9, y: 64, z: 0, distance: 9 },
      ],
      targetsFound: 2,
      complete: true,
    });
    expect(dig).not.toHaveBeenCalled();
    expect(pathfinder.goto).not.toHaveBeenCalled();
  });

  it("reports an unloaded-chunk hit as incomplete rather than as absence", async () => {
    const readable = new Vec3(2, 64, 0);
    const unreadable = new Vec3(40, 64, 0);
    const bot = scanBot({
      findBlocks: vi.fn(() => [readable, unreadable]),
      blockAt: vi.fn((position: Vec3) =>
        position.equals(readable) ? { type: 49 } : null,
      ),
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    // matches.length < targetsFound is the honest shape here: swallowing the
    // unreadable hit silently would tell the planner the world is emptier
    // than it was actually able to see.
    await expect(client.invokeSkillCapability(request)).resolves.toMatchObject({
      matches: [{ x: 2, y: 64, z: 0, distance: 2 }],
      targetsFound: 2,
      complete: false,
    });
  });

  it("reports an empty scan as a complete observation", async () => {
    const client = new MineflayerBotClient(
      scanBot(),
      "auto",
      "isolated-test-profile",
    );

    await expect(client.invokeSkillCapability(request)).resolves.toMatchObject({
      matches: [],
      targetsFound: 0,
      complete: true,
    });
  });

  it("fails closed on an unknown block name, wrong profile, or wrong dimension", async () => {
    const client = new MineflayerBotClient(
      scanBot(),
      "auto",
      "isolated-test-profile",
    );

    await expect(
      client.invokeSkillCapability({
        ...request,
        input: { ...request.input, blockName: "not_a_block" },
      }),
    ).rejects.toMatchObject({ code: "BLOCK_NAME_UNKNOWN" });
    await expect(
      client.invokeSkillCapability({
        ...request,
        input: { ...request.input, serverProfileId: "other-profile" },
      }),
    ).rejects.toMatchObject({ code: "TARGET_SERVER_PROFILE_MISMATCH" });
    await expect(
      client.invokeSkillCapability({
        ...request,
        input: { ...request.input, dimension: "minecraft:the_nether" },
      }),
    ).rejects.toMatchObject({ code: "TARGET_DIMENSION_MISMATCH" });
    await expect(
      client.invokeSkillCapability({
        ...request,
        input: { ...request.input, unexpected: true },
      }),
    ).rejects.toMatchObject({ code: "SKILL_CAPABILITY_INPUT_INVALID" });
  });

  it("asks findBlocks to filter candidates before the distance cut", async () => {
    // useExtraInfo 而不是事后 filter：mineflayer 在匹配之后才排序并截断到
    // count（lib/plugins/blocks.js:199-206），所以事后过滤只能从"最近的 N 个"
    // 里挑，而实测这 N 个全是埋着的。扫描与采集必须用同一个谓词，否则扫描
    // 会把埋着的方块报成 matches，规划器就会继续瞄一个采集拿不到的目标。
    const findBlocks = vi.fn(() => []);
    const client = new MineflayerBotClient(
      scanBot({ findBlocks }),
      "auto",
      "isolated-test-profile",
    );

    await client.invokeSkillCapability(request);

    expect(findBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ useExtraInfo: expect.any(Function) }),
    );
  });
});

// ---------------------------------------------------------------------------
// 候选可达性。
//
// 实测的世界事实（C:\tmp\exposure-probe.log，出生点 (-44.5, 78, 149.5)）：
// 半径 16 内有 12843 个 stone，其中只有 173 个有临空面，最近的一个在 12.9 格
// 之外。findBlocks 按距离排序后截断，所以交给采集器的永远是**埋着的**那几个：
// GoalLookAtBlock 需要一个能被射线看到的面，而 exclusionAreasBreak 给非目标
// 方块记 100，于是路径根本不存在。同一份探针里最近那个有临空面的 stone
// 寻路 158ms 就成功（visited=2836）——机器人到得了石头，只是从没被交给一个
// 到得了的候选。dirt 同样中招（within32 hits=64 exposed=0），所以过滤不能
// 针对石头写死。
// ---------------------------------------------------------------------------
describe("hasReachableFace", () => {
  const target = new Vec3(0, 64, 0);
  const solid = { boundingBox: "block" as const, name: "stone" };
  const air = { boundingBox: "empty" as const, name: "air" };

  function worldWhere(exposed: readonly Vec3[]): Pick<Bot, "blockAt"> {
    const keys = new Set(exposed.map((p) => `${p.x},${p.y},${p.z}`));
    return {
      blockAt: vi.fn((position: Vec3) =>
        keys.has(`${position.x},${position.y},${position.z}`) ? air : solid,
      ),
    } as unknown as Pick<Bot, "blockAt">;
  }

  it("rejects a fully buried block and accepts one with a single air face", () => {
    expect(hasReachableFace(worldWhere([]), target)).toBe(false);
    // 一面就够：探针里所有可达候选都是 faces=1。
    expect(hasReachableFace(worldWhere([target.offset(0, 1, 0)]), target)).toBe(
      true,
    );
  });

  it("does not count a liquid face as reachable", () => {
    const world = {
      blockAt: vi.fn((position: Vec3) =>
        position.equals(target.offset(0, 1, 0))
          ? { boundingBox: "empty" as const, name: "lava" }
          : solid,
      ),
    } as unknown as Pick<Bot, "blockAt">;

    // 临空面是岩浆时"能看到"并不等于"能安全靠近"。mine-planner 把液体邻接
    // 判成 MINE_LAVA_ADJACENT，这里必须站同一条线。
    expect(hasReachableFace(world, target)).toBe(false);
  });

  it("treats an unreadable neighbour as not exposed rather than guessing", () => {
    const world = {
      blockAt: vi.fn(() => null),
    } as unknown as Pick<Bot, "blockAt">;

    // 区块没加载时乐观放行的代价是上层拿着到不了的目标烧完整条重试阶梯。
    expect(hasReachableFace(world, target)).toBe(false);
  });
});

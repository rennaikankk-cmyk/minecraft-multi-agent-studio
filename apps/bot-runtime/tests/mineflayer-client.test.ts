import { EventEmitter } from "node:events";
import { InMemoryWorkstationRegistry } from "@minecraft-studio/skills";

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
        GoalNear: class {
          constructor(
            public x: number,
            public y: number,
            public z: number,
            public range: number,
          ) {}
        },
        GoalLookAtBlock: class {
          constructor(public pos: unknown) {}
        },
        GoalFollow: class {
          constructor(public entity: unknown, public range: number) {}
        },
      },
    },
    goals: {
      GoalNear: class {
        constructor(
          public x: number,
          public y: number,
          public z: number,
          public range: number,
        ) {}
      },
      GoalLookAtBlock: class {
        constructor(public pos: unknown) {}
      },
      GoalFollow: class {
        constructor(public entity: unknown, public range: number) {}
      },
    },
    Movements: TestMovements,
    pathfinder: vi.fn(),
  };
});

import type { BotClientHandlers } from "../src/client.js";
import {
  collectReachableTargets,
  configureSafePathfinderMovements,
  hasReachableFace,
  MineflayerBotClient,
} from "./fixtures/in-memory-client.js";

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

  it("reports health decreases and interrupts ordinary movement actions", () => {
    const emitter = new EventEmitter();
    const pathfinder = { stop: vi.fn() };
    const collectBlock = { cancelTask: vi.fn(async () => undefined) };
    const bot = emitter as unknown as Bot;
    Object.assign(bot, {
      health: 20,
      inventory: new EventEmitter(),
      pathfinder,
      collectBlock,
      clearControlStates: vi.fn(),
    });
    const client = new MineflayerBotClient(bot, "auto");
    const onDamaged = vi.fn();
    const onStateChanged = vi.fn();
    client.setHandlers(handlers({ onDamaged, onStateChanged }));

    emitter.emit("spawn");
    emitter.emit("health");
    expect(onDamaged).not.toHaveBeenCalled();

    (bot as unknown as { health: number }).health = 18;
    emitter.emit("health");
    expect(onDamaged).toHaveBeenCalledTimes(1);
    expect(onDamaged).toHaveBeenCalledWith({
      previousHealth: 20,
      currentHealth: 18,
    });

    (bot as unknown as { health: number }).health = 20;
    emitter.emit("health");
    expect(onDamaged).toHaveBeenCalledTimes(1);

    client.interruptNormalActions();
    expect(collectBlock.cancelTask).toHaveBeenCalledTimes(1);
    expect(pathfinder.stop).toHaveBeenCalledTimes(1);
    expect(bot.clearControlStates).toHaveBeenCalledTimes(1);
  });

  it("records real compat signals: forcedMove, kicked, and identifiable timeouts only", () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    Object.assign(bot, {
      health: 20,
      inventory: new EventEmitter(),
      entity: { id: 1, position: new Vec3(3, 64, -2) },
    });
    const client = new MineflayerBotClient(bot, "auto");
    client.setHandlers(handlers({}));

    expect(client.compatSignals().events).toHaveLength(0);

    emitter.emit("forcedMove");
    emitter.emit("kicked", "You are banned from this server");
    emitter.emit("error", Object.assign(new Error("connect ETIMEDOUT 1.2.3.4:25565"), { code: "ETIMEDOUT" }));
    // ECONNRESET 不是 timeout：识别不出就不记。
    emitter.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    emitter.emit("end", "socketClosed");

    const snapshot = client.compatSignals();
    expect(snapshot.events.map((event) => event.kind)).toEqual([
      "position-correction",
      "kick",
      "timeout",
    ]);
    expect(snapshot.familyStats.MOVEMENT).toMatchObject({ corrections: 1, total: 1 });
    expect(snapshot.familyStats.PACKET_INTENSIVE).toMatchObject({ total: 2 });
    expect(snapshot.stats.buffered).toBe(3);
    // kick 细节经 redaction 入口（此处无敏感内容应原样保留有界片段）。
    expect(snapshot.events[1]?.detail).toContain("banned");

    // timeout 语义的 end reason 也计入；非 timeout reason 不计。
    emitter.emit("end", "connection timed out");
    expect(client.compatSignals().events.at(-1)?.kind).toBe("timeout");
  });

  it("forages one bounded passive target when low health has no safe food", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const items: Array<{ name: string; type: number; count: number }> = [];
      const inventory = new EventEmitter() as EventEmitter & {
        items: () => typeof items;
      };
      inventory.items = () => items;
      const cow = {
        id: 2,
        name: "cow",
        type: "mob",
        isValid: true,
        height: 1.4,
        position: new Vec3(2, 64, 0),
      };
      const entities: Record<string, typeof cow> = { "2": cow };
      const pathfinder = collectPathfinder();
      const attack = vi.fn(async () => {
        cow.isValid = false;
        delete entities["2"];
        items.push({ name: "beef", type: 900, count: 1 });
      });
      const bot = emitter as unknown as Bot;
      Object.assign(bot, {
        health: 8,
        inventory,
        registry: {
          foodsByName: {
            beef: { foodPoints: 3, effectiveQuality: 3 },
          },
        },
        entity: { id: 1, position: new Vec3(0, 64, 0) },
        entities,
        pathfinder,
        nearestEntity: vi.fn((filter: (entity: typeof cow) => boolean) =>
          filter(cow) ? cow : null,
        ),
        clearControlStates: vi.fn(),
        lookAt: vi.fn(async () => undefined),
        attack,
      });
      const client = new MineflayerBotClient(bot, "auto");

      const result = client.executeSafetyAction({
        kind: "FORAGE_SAFE_FOOD",
        risk: "LOW_HEALTH",
      });
      await vi.advanceTimersByTimeAsync(700);

      await expect(result).resolves.toEqual({
        outcome: "executed",
        errorCode: null,
      });
      expect(attack).toHaveBeenCalledTimes(1);
      expect(pathfinder.setMovements).toHaveBeenCalledTimes(1);
      expect(items).toContainEqual({ name: "beef", type: 900, count: 1 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("harvests a mature berry bush before hunting or exploring", async () => {
    const emitter = new EventEmitter();
    const items: Array<{ name: string; type: number; count: number }> = [];
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => typeof items;
    };
    inventory.items = () => items;
    const berryPosition = new Vec3(2, 64, 0);
    const berryBush = {
      name: "sweet_berry_bush",
      position: berryPosition,
      getProperties: () => ({ age: 3 }),
    };
    const activateBlock = vi.fn(async () => {
      items.push({ name: "sweet_berries", type: 901, count: 2 });
    });
    const nearestEntity = vi.fn(() => null);
    const bot = emitter as unknown as Bot;
    Object.assign(bot, {
      health: 8,
      inventory,
      registry: {
        blocksByName: { sweet_berry_bush: { id: 7 } },
        foodsByName: {
          sweet_berries: { foodPoints: 2, effectiveQuality: 2 },
        },
      },
      entity: { id: 1, position: new Vec3(0, 64, 0) },
      entities: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => [berryPosition]),
      blockAt: vi.fn(() => berryBush),
      nearestEntity,
      clearControlStates: vi.fn(),
      lookAt: vi.fn(async () => undefined),
      activateBlock,
    });
    const client = new MineflayerBotClient(bot, "auto");

    await expect(
      client.executeSafetyAction({
        kind: "FORAGE_SAFE_FOOD",
        risk: "LOW_HEALTH",
      }),
    ).resolves.toEqual({ outcome: "executed", errorCode: null });
    expect(activateBlock).toHaveBeenCalledWith(berryBush);
    expect(nearestEntity).not.toHaveBeenCalled();
    expect(items).toContainEqual({ name: "sweet_berries", type: 901, count: 2 });
  });

  it("tries another ripe food block when the nearest candidate is unreachable", async () => {
    const emitter = new EventEmitter();
    const items: Array<{ name: string; type: number; count: number }> = [];
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => typeof items;
    };
    inventory.items = () => items;
    const blockedPosition = new Vec3(4, 64, 0);
    const reachablePosition = new Vec3(5, 64, 0);
    const entity = { id: 1, position: new Vec3(0, 64, 0) };
    const blockAt = vi.fn((position: Vec3) => ({
      name: "sweet_berry_bush",
      position,
      getProperties: () => ({ age: 3 }),
    }));
    const pathfinder = collectPathfinder();
    pathfinder.goto.mockImplementation(async (goal: unknown) => {
      const target = goal as { x?: number };
      if (target.x === blockedPosition.x) throw new Error("NoPath");
      entity.position = new Vec3(4, 64, 0);
    });
    const activateBlock = vi.fn(async (block: { position: Vec3 }) => {
      if (block.position.equals(reachablePosition)) {
        items.push({ name: "sweet_berries", type: 901, count: 2 });
      }
    });
    const bot = emitter as unknown as Bot;
    Object.assign(bot, {
      health: 8,
      inventory,
      registry: {
        blocksByName: { sweet_berry_bush: { id: 7 } },
        foodsByName: {
          sweet_berries: { foodPoints: 2, effectiveQuality: 2 },
        },
      },
      entity,
      entities: {},
      pathfinder,
      findBlocks: vi.fn(() => [blockedPosition, reachablePosition]),
      blockAt,
      clearControlStates: vi.fn(),
      lookAt: vi.fn(async () => undefined),
      activateBlock,
    });
    const client = new MineflayerBotClient(bot, "auto");

    await expect(
      client.executeSafetyAction({
        kind: "FORAGE_SAFE_FOOD",
        risk: "LOW_HEALTH",
      }),
    ).resolves.toEqual({ outcome: "executed", errorCode: null });
    expect(pathfinder.goto).toHaveBeenCalledTimes(2);
    expect(activateBlock).toHaveBeenCalledTimes(1);
    expect(activateBlock.mock.calls[0]?.[0].position).toEqual(reachablePosition);
  });

  it("uses a bounded directional waypoint before reporting no food source", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; type: number; count: number }>;
    };
    inventory.items = () => [];
    const pathfinder = collectPathfinder();
    const nearestEntity = vi.fn(() => null);
    const bot = emitter as unknown as Bot;
    Object.assign(bot, {
      health: 8,
      inventory,
      registry: { blocksByName: {}, foodsByName: {} },
      entity: { id: 1, position: new Vec3(10, 64, 20) },
      entities: {},
      pathfinder,
      findBlocks: vi.fn(() => []),
      nearestEntity,
      clearControlStates: vi.fn(),
    });
    const client = new MineflayerBotClient(bot, "auto");

    await expect(
      client.executeSafetyAction({
        kind: "FORAGE_SAFE_FOOD",
        risk: "LOW_HEALTH",
      }),
    ).resolves.toEqual({
      outcome: "skipped",
      errorCode: "NO_SAFE_FOOD_SOURCE",
    });
    expect(pathfinder.goto).toHaveBeenCalledTimes(1);
    expect(pathfinder.goto.mock.calls[0]?.[0]).toMatchObject({
      x: 22,
      y: 64,
      z: 20,
      range: 2,
    });
    expect(nearestEntity).not.toHaveBeenCalled();
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

  it("uses the bounded direct path, dig, and pickup flow on a real tool-capable client", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; type: number; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(2, 64, 0);
    const targetBlock = harvestableBlock(targetPosition, 1);
    let collected = 0;
    inventory.items = () => [
      { name: "wooden_pickaxe", type: 800, count: 1 },
      ...(collected > 0
        ? [{ name: "cobblestone", type: 4, count: collected }]
        : []),
    ];
    const pathfinder = collectPathfinder();
    const equipForBlock = vi.fn(async () => undefined);
    const dig = vi.fn(async () => {
      collected += 1;
      inventory.emit("updateSlot");
    });
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory,
      entity: { position: new Vec3(0, 64, 0) },
      entities: {},
      world: {},
      pathfinder,
      tool: { equipForBlock },
      dig,
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt: vi.fn(() => targetBlock),
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
        ...collectRequest("invocation-collect-direct"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({ targetsFound: 1, itemsCollected: 1 });
    expect(pathfinder.goto).toHaveBeenCalledTimes(1);
    expect(equipForBlock).toHaveBeenCalledWith(targetBlock, {
      requireHarvest: true,
      getFromChest: false,
      maxTools: 2,
    });
    expect(dig).toHaveBeenCalledWith(targetBlock);
    expect(collect).not.toHaveBeenCalled();
  });

  it("walks onto the exact dropped-item block before declaring pickup failure", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const inventory = new EventEmitter() as EventEmitter & {
        items: () => Array<{ name: string; type: number; count: number }>;
      };
      const bot = emitter as unknown as Bot;
      const targetPosition = new Vec3(2, 64, 0);
      const targetBlock = harvestableBlock(targetPosition, 1);
      const entities: Record<string, unknown> = {};
      let collected = 0;
      inventory.items = () => [
        { name: "wooden_pickaxe", type: 800, count: 1 },
        ...(collected > 0
          ? [{ name: "cobblestone", type: 4, count: collected }]
          : []),
      ];
      const pathfinder = collectPathfinder();
      pathfinder.goto.mockImplementation(async (goal: unknown) => {
        const pickupGoal = goal as {
          x?: number;
          y?: number;
          z?: number;
          range?: number;
        };
        if (
          pickupGoal.x === 2 &&
          pickupGoal.y === 64 &&
          pickupGoal.z === 0 &&
          pickupGoal.range === 0
        ) {
          collected = 1;
          inventory.emit("updateSlot");
        }
      });
      const equipForBlock = vi.fn(async () => undefined);
      const dig = vi.fn(async () => {
        entities.drop = {
          name: "item",
          isValid: true,
          position: new Vec3(2.8, 64.25, 0.7),
        };
      });
      const collect = vi.fn(async () => undefined);
      Object.assign(bot, {
        game: { dimension: "overworld" },
        registry: { blocksByName: { stone: { id: 1 } } },
        inventory,
        entity: { position: new Vec3(0, 64, 0) },
        entities,
        world: {},
        pathfinder,
        tool: { equipForBlock },
        dig,
        findBlocks: vi.fn(() => [targetPosition]),
        blockAt: vi.fn(() => targetBlock),
        collectBlock: {
          chestLocations: [] as Vec3[],
          movements: null as Movements | null,
          collect,
          cancelTask: vi.fn(async () => undefined),
        },
      });
      const client = new MineflayerBotClient(
        bot,
        "auto",
        "isolated-test-profile",
      );

      const pending = client.invokeSkillCapability({
        ...collectRequest("invocation-collect-exact-pickup"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      });
      const assertion = expect(pending).resolves.toMatchObject({
        targetsFound: 1,
        itemsCollected: 1,
      });
      await vi.advanceTimersByTimeAsync(1_200);
      await assertion;
      expect(pathfinder.goto).toHaveBeenCalledTimes(2);
      expect(pathfinder.goto.mock.calls[1]?.[0]).toMatchObject({
        x: 2,
        y: 64,
        z: 0,
        range: 0,
      });
      expect(collect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens a safe staircase when exposed stone has no proven path", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; type: number; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const entity = { position: new Vec3(0, 64, 0) };
    const removed = new Set<string>();
    let dirtCollected = 0;
    let stoneCollected = 0;
    inventory.items = () => [
      { name: "wooden_pickaxe", type: 800, count: 1 },
      ...(dirtCollected > 0
        ? [{ name: "dirt", type: 3, count: dirtCollected }]
        : []),
      ...(stoneCollected > 0
        ? [{ name: "cobblestone", type: 4, count: stoneCollected }]
        : []),
    ];
    const blockAt = vi.fn((position: Vec3) => {
      const key = `${position.x},${position.y},${position.z}`;
      const name = removed.has(key)
        ? "air"
        : position.y >= 64
          ? "air"
          : position.y === 63
            ? "dirt"
            : "stone";
      return {
        position,
        type: name === "stone" ? 1 : name === "dirt" ? 2 : 0,
        name,
        boundingBox: name === "air" ? "empty" : "block",
        canHarvest: (itemType: number | null) =>
          name !== "stone" || itemType !== null,
      };
    });
    const pathfinder = collectPathfinder("noPath");
    pathfinder.goto.mockImplementation(async () => {
      const step = pathfinder.goto.mock.calls.length;
      entity.position = new Vec3(step, 64 - step, 0);
    });
    const equipForBlock = vi.fn(async () => undefined);
    const dig = vi.fn(async (block: { name: string; position: Vec3 }) => {
      removed.add(`${block.position.x},${block.position.y},${block.position.z}`);
      if (block.name === "stone") stoneCollected += 1;
      if (block.name === "dirt") dirtCollected += 1;
      inventory.emit("updateSlot");
    });
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory,
      entity,
      entities: {},
      world: {},
      pathfinder,
      tool: { equipForBlock },
      dig,
      findBlocks: vi.fn(() => [new Vec3(9, 60, 0)]),
      blockAt,
      clearControlStates: vi.fn(),
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
        ...collectRequest("invocation-collect-staircase"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({
      blockName: "stone",
      targetsFound: 1,
      itemsCollected: 1,
    });
    expect(dirtCollected).toBeGreaterThan(0);
    expect(stoneCollected).toBe(1);
    expect(pathfinder.goto).toHaveBeenCalled();
    expect(dig).toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
  });

  it("aims an access staircase toward an unreachable underground resource", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; type: number; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const entity = { position: new Vec3(0, 64, 0) };
    const targetPosition = new Vec3(0, 60, 0);
    const removed = new Set<string>();
    let dirtCollected = 0;
    let cobblestoneCollected = 0;
    let coalCollected = 0;
    inventory.items = () => [
      { name: "stone_pickaxe", type: 801, count: 1 },
      ...(dirtCollected > 0
        ? [{ name: "dirt", type: 3, count: dirtCollected }]
        : []),
      ...(cobblestoneCollected > 0
        ? [{ name: "cobblestone", type: 4, count: cobblestoneCollected }]
        : []),
      ...(coalCollected > 0
        ? [{ name: "coal", type: 263, count: coalCollected }]
        : []),
    ];
    const blockAt = vi.fn((position: Vec3) => {
      const key = `${position.x},${position.y},${position.z}`;
      const target = position.equals(targetPosition);
      const name = removed.has(key)
        ? "air"
        : target
          ? "coal_ore"
          : position.y >= 66 ||
              (position.x === 0 &&
                position.z === 0 &&
                position.y >= 64)
            ? "air"
            : position.y === 63
              ? "dirt"
              : "stone";
      return {
        position,
        type: name === "coal_ore" ? 5 : name === "stone" ? 1 : name === "dirt" ? 2 : 0,
        name,
        boundingBox: name === "air" ? "empty" : "block",
        canHarvest: (itemType: number | null) =>
          name === "air" || name === "dirt" || itemType !== null,
      };
    });
    const pathfinder = collectPathfinder();
    pathfinder.getPathFromTo.mockImplementation(function* () {
      const status = entity.position.y <= 62 ? "success" : "noPath";
      yield { result: { status, path: [], time: 1, visitedNodes: 1 } };
    });
    pathfinder.goto.mockImplementation(async (goal: unknown) => {
      const exact = goal as {
        x?: number;
        y?: number;
        z?: number;
        range?: number;
        pos?: Vec3;
      };
      if (
        exact.range === 0 &&
        exact.x !== undefined &&
        exact.y !== undefined &&
        exact.z !== undefined
      ) {
        if (!removed.has(`${exact.x},${exact.y + 2},${exact.z}`)) return;
        entity.position = new Vec3(exact.x, exact.y, exact.z);
      } else if (exact.pos?.equals(targetPosition)) {
        entity.position = targetPosition.offset(0, 1, 0);
      }
    });
    const equipForBlock = vi.fn(async () => undefined);
    const dig = vi.fn(async (block: { name: string; position: Vec3 }) => {
      removed.add(`${block.position.x},${block.position.y},${block.position.z}`);
      if (block.name === "dirt") dirtCollected += 1;
      if (block.name === "stone") cobblestoneCollected += 1;
      if (block.name === "coal_ore") coalCollected += 1;
      inventory.emit("updateSlot");
    });
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { coal_ore: { id: 5 } } },
      inventory,
      entity,
      entities: {},
      world: {},
      pathfinder,
      tool: { equipForBlock },
      dig,
      findBlocks: vi.fn((options: { useExtraInfo?: unknown }) =>
        options.useExtraInfo ? [] : [targetPosition],
      ),
      blockAt,
      clearControlStates: vi.fn(),
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
        ...collectRequest("invocation-collect-directed-staircase"),
        input: {
          blockName: "coal_ore",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({
      blockName: "coal_ore",
      targetsFound: 1,
      itemsCollected: 1,
    });
    expect(pathfinder.goto.mock.calls[0]?.[0]).toMatchObject({
      x: 1,
      y: 63,
      z: 0,
      range: 0,
    });
    expect(removed).toContain("1,65,0");
    expect(coalCollected).toBe(1);
    expect(dirtCollected + cobblestoneCollected).toBeGreaterThan(0);
    expect(bot.findBlocks).toHaveBeenCalledTimes(2);
    expect(bot.findBlocks).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ useExtraInfo: expect.anything() }),
    );
    expect(collect).not.toHaveBeenCalled();
  });

  it("opens an ascending staircase toward a resource above the current endpoint", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; type: number; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const entity = { position: new Vec3(0, 64, 0) };
    const targetPosition = new Vec3(2, 66, 0);
    const removed = new Set<string>();
    let coalCollected = 0;
    inventory.items = () => [
      { name: "stone_pickaxe", type: 801, count: 1 },
      ...(coalCollected > 0
        ? [{ name: "coal", type: 263, count: coalCollected }]
        : []),
    ];
    const blockAt = vi.fn((position: Vec3) => {
      const key = `${position.x},${position.y},${position.z}`;
      const target = position.equals(targetPosition);
      const initialCavity =
        position.x === 0 &&
        position.z === 0 &&
        (position.y === 64 || position.y === 65);
      const name = removed.has(key)
        ? "air"
        : target
          ? "coal_ore"
          : initialCavity || position.y >= 68
            ? "air"
            : "stone";
      return {
        position,
        type: name === "coal_ore" ? 5 : name === "stone" ? 1 : 0,
        name,
        boundingBox: name === "air" ? "empty" : "block",
        canHarvest: (itemType: number | null) =>
          name === "air" || itemType !== null,
      };
    });
    const pathfinder = collectPathfinder("noPath");
    pathfinder.goto.mockImplementation(async (goal: unknown) => {
      const exact = goal as {
        x?: number;
        y?: number;
        z?: number;
        range?: number;
      };
      if (
        exact.range === 0 &&
        exact.x !== undefined &&
        exact.y !== undefined &&
        exact.z !== undefined &&
        removed.has("0,66,0") &&
        removed.has(`${exact.x},${exact.y},${exact.z}`) &&
        removed.has(`${exact.x},${exact.y + 1},${exact.z}`)
      ) {
        entity.position = new Vec3(exact.x, exact.y, exact.z);
      }
    });
    const dig = vi.fn(async (block: { name: string; position: Vec3 }) => {
      removed.add(`${block.position.x},${block.position.y},${block.position.z}`);
      if (block.name === "coal_ore") coalCollected += 1;
      inventory.emit("updateSlot");
    });
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { coal_ore: { id: 5 } } },
      inventory,
      entity,
      entities: {},
      world: {},
      pathfinder,
      tool: { equipForBlock: vi.fn(async () => undefined) },
      dig,
      findBlocks: vi.fn(() => [targetPosition]),
      blockAt,
      clearControlStates: vi.fn(),
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
        ...collectRequest("invocation-collect-ascending-staircase"),
        input: {
          blockName: "coal_ore",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({
      blockName: "coal_ore",
      targetsFound: 1,
      itemsCollected: 1,
    });
    expect(pathfinder.goto.mock.calls[0]?.[0]).toMatchObject({
      x: 1,
      y: 65,
      z: 0,
      range: 0,
    });
    expect(removed).toContain("0,66,0");
    expect(coalCollected).toBe(1);
    expect(collect).not.toHaveBeenCalled();
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
  }, 15_000);

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
  }, 15_000);

  it("uses observed pickups to finish a stuck entity-follow and continues the batch", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; type?: number; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const positions = [new Vec3(2, 64, 0), new Vec3(3, 64, 0)];
    let itemCount = 0;
    inventory.items = () => [
      { name: "wooden_axe", type: 800, count: 1 },
      ...(itemCount > 0 ? [{ name: "oak_log", count: itemCount }] : []),
    ];
    const collect = vi.fn((_targets: unknown[]) => {
      setTimeout(() => {
        itemCount += 1;
        inventory.emit("updateSlot");
      }, 0);
      return new Promise<void>(() => {});
    });
    // The real plugin can wait forever for collectBlock_finished after the item
    // is already in inventory. Runtime completion must not await this promise.
    const cancelTask = vi.fn(() => new Promise<void>(() => {}));
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 1 } } },
      inventory,
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => positions),
      blockAt: vi.fn((position: Vec3) => ({
        position,
        type: 1,
        name: "oak_log",
        boundingBox: "block",
        canHarvest: () => true,
      })),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect,
        cancelTask,
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability({
        ...collectRequest("invocation-collect-observed-pickups"),
        input: {
          blockName: "oak_log",
          maxCount: 2,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({
      blockName: "oak_log",
      targetsFound: 2,
      itemsCollected: 2,
    });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect.mock.calls.every(([targets]) => targets.length === 1)).toBe(true);
    // 租约归还触发的停止原语会多调一次幂等的 cancelTask。
    expect(cancelTask).toHaveBeenCalledTimes(3);
  }, 15_000);

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
        // 底层原因必须原样带走——屏蔽码留给协议,原因留给日志。后面追加的批次
        // 账目是另一件事(替补有没有登场),所以这里用包含而不是相等。
        message: expect.stringContaining("Took to long to decide path to goal!"),
      });
    },
  );

  it("says how many proven-reachable batches it actually attempted", async () => {
    // 实跑那次只能靠 durationMs(12588 → 15754ms)反推替补有没有登场,那是推断
    // 不是观测。预检查只证明了一个候选时替补席是空的,而"替补上过场也照样超时"
    // 的下一步正好相反,所以这个数字必须写在 reason 里。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const rejection = new Error("Took to long to decide path to goal!");
    rejection.name = "Timeout";
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
      pathfinder: collectPathfinder(),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect: vi.fn(async () => {
          throw rejection;
        }),
        cancelTask: vi.fn(async () => undefined),
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability(collectRequest("invocation-collect-batches")),
    ).rejects.toMatchObject({
      message: expect.stringContaining("attempted 1 of 1 live candidate"),
    });
  });

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

  it("refuses an empty resource search before entering collectblock", async () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { oak_log: { id: 49 } } },
      inventory: { items: () => [] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => []),
      blockAt: vi.fn(() => null),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect,
        cancelTask: vi.fn(async () => undefined),
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability(collectRequest("invocation-collect-empty")),
    ).rejects.toMatchObject({ code: "COLLECT_TARGET_UNREACHABLE" });
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

  it("over-fetches candidates so one unreachable nearest hit does not sink the batch", async () => {
    // findBlocks 的 count 截断发生在 useExtraInfo 过滤之后（blocks.js:199-206），
    // 所以 count == maxCount 时"最近的 maxCount 个暴露候选"就是全部候选——最近
    // 那个不可达就没有替补。实测的死法正是这个：只找到 1 个暴露的 oak_log，
    // 它不可达，整个目标在 step 1 结束、stepsCompleted:0，而世界里明明还有别的
    // 原木，只是不在"最近 1 个"里。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const nearestBlocked = new Vec3(2, 64, 0);
    const fartherReachable = new Vec3(6, 64, 0);
    const blocked = harvestableBlock(nearestBlocked, 1);
    const reachable = harvestableBlock(fartherReachable, 1);
    const collect = vi.fn(async () => undefined);
    const pathfinder = collectPathfinder();
    pathfinder.getPathFromTo = vi.fn(function* (
      _movements: unknown,
      _start: unknown,
      goal: { pos?: Vec3 },
    ) {
      yield {
        result: {
          status: goal.pos?.x === nearestBlocked.x ? "noPath" : "success",
          path: [],
          time: 1,
          visitedNodes: 1,
        },
      };
    }) as never;
    // 替补只有在 findBlocks 被要求多找时才存在，所以这个替身按请求的 count
    // 返回：count 只有 1 时它就只交出那个不可达的候选，正是修复前的形态。
    const findBlocks = vi.fn(({ count }: { count: number }) =>
      [nearestBlocked, fartherReachable].slice(0, count),
    );
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder,
      findBlocks,
      blockAt: vi.fn((position: Vec3) =>
        position.x === nearestBlocked.x ? blocked : reachable,
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
        ...collectRequest("invocation-collect-pool-slack"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({ targetsFound: 1 });
    // 池子要比需求量大，否则替补根本不在候选里。
    expect(findBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ count: 9 }),
    );
    // 攒够请求量就停手：只交 1 个目标，不是把整池都交下去。
    expect(collect).toHaveBeenCalledWith([reachable], { ignoreNoPath: false });
  });

  it("stops the pre-check at the requested count instead of collecting the whole pool", async () => {
    // 放大候选池是为了有替补，不是为了多采。若攒够请求量后还继续排，多出来的
    // 可达候选会一起交给 collect()，于是一个只要 1 块的步骤会去挖 9 块，
    // 并把 targetsFound 报成 9——规划器的验收谓词拿到的就是个虚高的数字。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const positions = [0, 1, 2].map((index) => new Vec3(2 + index, 64, 0));
    const collect = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      // 每个候选都可达，所以"停在请求量"是唯一能让目标数落在 1 的机制。
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => positions),
      blockAt: vi.fn((position: Vec3) => harvestableBlock(position, 1)),
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
        ...collectRequest("invocation-collect-pool-shortcircuit"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({ targetsFound: 1 });
    expect(collect).toHaveBeenCalledWith(
      [expect.objectContaining({ position: positions[0] })],
      { ignoreNoPath: false },
    );
  });

  it("falls through to a proven substitute when the live walk times out", async () => {
    // 实测 task 7bab377b step 6（oak_log，dur=12588ms）：前置检查证明了一个候选
    // 可达（日志里没有任何 "Examined ... candidates" 行），随后 collect() 自己的
    // goto 在同一个目标上以 `Timeout: Took to long to decide path to goal!`
    // 被拒。两次搜索不等价——前置检查 tickTimeout == timeout 背靠背跑满，实跑
    // 每 ~50ms 只跑 40ms 且 8000ms 是墙钟——所以"证明可达"之后实跑仍会判不出路。
    // 只交一个已证明的目标就等于让一次坏抽样沉掉整步。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const first = new Vec3(2, 64, 0);
    const second = new Vec3(5, 64, 0);
    const timeout = new Error("Took to long to decide path to goal!");
    timeout.name = "Timeout";
    const collect = vi.fn(async (batch: Array<{ position: Vec3 }>) => {
      if (batch[0]?.position.x === first.x) throw timeout;
    });
    const cancelTask = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => [first, second]),
      blockAt: vi.fn((position: Vec3) => harvestableBlock(position, 1)),
      collectBlock: {
        chestLocations: [] as Vec3[],
        movements: null as Movements | null,
        collect,
        cancelTask,
      },
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability({
        ...collectRequest("invocation-collect-substitute"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
      // 请求量仍然是 1：替补是换一个坐标，不是多挖一块。
    ).resolves.toMatchObject({ targetsFound: 1 });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(collect).toHaveBeenLastCalledWith(
      [expect.objectContaining({ position: second })],
      { ignoreNoPath: false },
    );
    // 换批次之前必须取消：插件的循环还带着上一批的目标。
    expect(cancelTask).toHaveBeenCalled();
  });

  it("does not spend a substitute on a failure that is not about pathing", async () => {
    // 换个坐标治不了"挖不动/够不到"，只会白烧一轮预算并把真实原因推迟上报。
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const collect = vi.fn(async () => {
      throw new Error("dig failed");
    });
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
      inventory: { items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }] },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
      pathfinder: collectPathfinder(),
      findBlocks: vi.fn(() => [new Vec3(2, 64, 0), new Vec3(5, 64, 0)]),
      blockAt: vi.fn((position: Vec3) => harvestableBlock(position, 1)),
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
        ...collectRequest("invocation-collect-no-substitute"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).rejects.toMatchObject({ code: "COLLECT_BLOCKS_FAILED" });
    expect(collect).toHaveBeenCalledTimes(1);
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

  it("spends a bounded live attempt on a candidate the pre-check could not decide", async () => {
    // astar.js 的 compute() 只有四个状态，只有 noPath 是"这里确实没有路"的证明；
    // timeout 只是总预算耗尽（tickTimeout == timeout 时第一片返回 partial，
    // getPathFromTo 再驱动一次就报 timeout，index.js:96-100）。两者合并会让一个
    // 没算完的搜索冒充定论，白丢分类器给 TRANSIENT 的那一级 RETRY_SAME
    // ——failure-classifier.ts:180 明令不许合并。
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
      pathfinder: collectPathfinder("timeout"),
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
        ...collectRequest("invocation-collect-precheck-exhausted"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 8,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      }),
    ).resolves.toMatchObject({ targetsFound: 1 });
    expect(collect).toHaveBeenCalledTimes(1);
  });

  it("bounds a collect that neither resolves nor rejects, and cancels the plugin task", async () => {
    // collectAll 的 Entity 分支有两条永不落定且永不抛错的 await
    // （CollectBlock.js:49-50），命中时 collect() 会一直吊着，把整个技能合约
    // 烧光，上层只看到一个没有 onFault 行的 SKILL_TIMEOUT。实测复现：一次
    // collect() 静默挂了 224 秒直到探针失效保护。
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const bot = emitter as unknown as Bot;
      const targetPosition = new Vec3(2, 64, 0);
      // 永不落定：既不 resolve 也不 reject，正是被测的那个形态。
      const collect = vi.fn(() => new Promise<void>(() => {}));
      const cancelTask = vi.fn(async () => undefined);
      const pathfinder = collectPathfinder();
      Object.assign(bot, {
        game: { dimension: "overworld" },
        registry: { blocksByName: { stone: { id: 1 } } },
        inventory: {
          items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }],
        },
        entity: { position: new Vec3(0, 64, 0) },
        world: {},
        pathfinder,
        findBlocks: vi.fn(() => [targetPosition]),
        blockAt: vi.fn(() => harvestableBlock(targetPosition, 1)),
        collectBlock: {
          chestLocations: [] as Vec3[],
          movements: null as Movements | null,
          collect,
          cancelTask,
        },
      });
      const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

      const pending = client.invokeSkillCapability({
        ...collectRequest("invocation-collect-stalled"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: "COLLECT_PICKUP_NOT_SETTLED",
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;
      // 超时后必须收尾：插件的循环还带着这次的目标，不取消就会污染下一次调用。
      expect(cancelTask).toHaveBeenCalled();
      expect(pathfinder.stop).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows the cancelled collect's late rejection instead of leaving it unhandled", async () => {
    // 超时后 cancelTask 会让 collect() 迟到地抛，那时已经没有 await 在等它。
    // 当前实现里这是安全的：Promise.race 一进来就给每个入参挂了反应，拒绝算已
    // 被处理。这条用例把该性质钉住——它不是为了守某个已发生的缺陷，而是防止以后
    // 有人把竞速改成"先 await 超时、再单独 await collect"之类会让拒绝外泄的形状，
    // 那种形状下未接住的拒绝按 Node 默认策略会打掉整个 Runtime 进程。
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const emitter = new EventEmitter();
      const bot = emitter as unknown as Bot;
      const targetPosition = new Vec3(2, 64, 0);
      let failCollect: ((cause: Error) => void) | undefined;
      const collect = vi.fn(
        () => new Promise<void>((_resolve, reject) => {
          failCollect = reject;
        }),
      );
      const cancelTask = vi.fn(async () => {
        failCollect?.(new Error("Collect task cancelled"));
      });
      const pathfinder = collectPathfinder();
      Object.assign(bot, {
        game: { dimension: "overworld" },
        registry: { blocksByName: { stone: { id: 1 } } },
        inventory: {
          items: () => [{ name: "wooden_pickaxe", type: 800, count: 1 }],
        },
        entity: { position: new Vec3(0, 64, 0) },
        world: {},
        pathfinder,
        findBlocks: vi.fn(() => [targetPosition]),
        blockAt: vi.fn(() => harvestableBlock(targetPosition, 1)),
        collectBlock: {
          chestLocations: [] as Vec3[],
          movements: null as Movements | null,
          collect,
          cancelTask,
        },
      });
      const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

      const pending = client.invokeSkillCapability({
        ...collectRequest("invocation-collect-late-reject"),
        input: {
          blockName: "stone",
          maxCount: 1,
          maxDistance: 16,
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
      });
      const assertion = expect(pending).rejects.toMatchObject({
        code: "COLLECT_PICKUP_NOT_SETTLED",
      });
      await vi.advanceTimersByTimeAsync(25_000);
      await assertion;
      expect(cancelTask).toHaveBeenCalled();
      // 让微任务队列排空，迟到的拒绝若没人接住就会在这一步冒出来。
      await Promise.resolve();
      await Promise.resolve();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      vi.useRealTimers();
    }
  });

  it("reuses an already-present station instead of placing into its occupied block", async () => {
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const referencePosition = new Vec3(2, 63, 0);
    const targetPosition = referencePosition.offset(0, 1, 0);
    const equip = vi.fn(async () => undefined);
    const placeBlock = vi.fn(async () => undefined);
    Object.assign(bot, {
      game: { dimension: "overworld" },
      inventory: { items: () => [] },
      blockAt: vi.fn((position: Vec3) =>
        position.equals(targetPosition)
          ? { name: "crafting_table", boundingBox: "block" }
          : { name: "stone", boundingBox: "block" },
      ),
      equip,
      placeBlock,
    });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");

    await expect(
      client.invokeSkillCapability({
        invocationId: "invocation-reuse-station",
        traceId: "trace-reuse-station",
        taskId: "task-reuse-station",
        botId: "bot-reuse-station",
        skillId: "world.place-block",
        skillVersion: "1.0.0",
        capability: "world.interact",
        operation: "block.place-safe",
        input: {
          itemName: "crafting_table",
          referenceBlock: {
            x: referencePosition.x,
            y: referencePosition.y,
            z: referencePosition.z,
          },
          face: { x: 0, y: 1, z: 0 },
          dimension: "minecraft:overworld",
          serverProfileId: "isolated-test-profile",
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({
      placed: true,
      placedBlockName: "crafting_table",
      position: {
        x: targetPosition.x,
        y: targetPosition.y,
        z: targetPosition.z,
      },
    });
    expect(equip).not.toHaveBeenCalled();
    expect(placeBlock).not.toHaveBeenCalled();
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
      blockAt: vi.fn(() => ({ name: "chest", position: new Vec3(5, 65, -2), getProperties: () => ({ type: "single" }) })),
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
      false, undefined, "safe", null, undefined, new InMemoryWorkstationRegistry(),
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

  it.each(["north", "east", "south", "west", "legacy"] as const)("fences double chest halves across Runtime instances (%s)", async (facing) => {
    const registry = new InMemoryWorkstationRegistry();
    const offset = facing === "east" ? new Vec3(0, 0, 1) : facing === "south" ? new Vec3(-1, 0, 0)
      : facing === "west" ? new Vec3(0, 0, -1) : new Vec3(1, 0, 0);
    const positionAt = (index: number) => new Vec3(0, 64, 0).plus(offset.scaled(index));
    let finishTransfer!: () => void;
    const blocked = new Promise<void>((resolve) => { finishTransfer = resolve; });
    const makeClient = () => {
      const bot = new EventEmitter() as unknown as Bot;
      let count = 2;
      const deposit = vi.fn(async () => { await blocked; count = 1; });
      Object.assign(bot, { game: { dimension: "overworld" }, registry: { itemsByName: { stone: { id: 1 } } },
        inventory: { items: () => [{ name: "stone", count }] },
        blockAt: (position: Vec3) => {
          // Modern adjacent pairs can contain a complementary half on the wrong side.
          const index = (facing === "legacy" ? [0, 1] : [-1, 0, 1, 2]).find((i) => position.equals(positionAt(i)));
          return index === undefined ? { name: "air", position, getProperties: () => ({}) }
            : { name: "chest", position, getProperties: () => facing === "legacy" ? { facing: "north" }
              : { facing, type: index === 0 || index === 2 ? "left" : "right" } };
        },
        openContainer: vi.fn(async () => ({ deposit, withdraw: vi.fn(), close: vi.fn() })),
      });
      return { deposit, client: new MineflayerBotClient(bot, "auto", "fixture", false, undefined, "safe", null, undefined, registry) };
    };
    const request = (index: number, botId: string) => ({ invocationId: crypto.randomUUID(), traceId: "trace", taskId: "task", botId,
      skillId: "container.transfer", skillVersion: "1.0.0", capability: "container.write" as const, operation: "container.transfer-safe",
      input: { direction: "deposit", itemName: "stone", count: 1, container: positionAt(index), dimension: "minecraft:overworld", serverProfileId: "fixture" },
      signal: new AbortController().signal });
    const first = makeClient(); const second = makeClient();
    const pending = first.client.invokeSkillCapability(request(0, "a"));
    await vi.waitFor(() => expect(first.deposit).toHaveBeenCalledOnce());
    await expect(second.client.invokeSkillCapability(request(1, "b"))).rejects.toMatchObject({ code: "WORKSTATION_BUSY" });
    expect(second.deposit).not.toHaveBeenCalled();
    finishTransfer();
    await expect(pending).resolves.toMatchObject({ movedCount: 1 });
  });
});

/**
 * collect.block 的寻路替身。可达性预检查用 getPathFromTo 排干一个生成器，
 * 所以替身要 yield 一个终态；默认 success 表示"这个目标走得到"。
 */
function collectPathfinder(
  status: "success" | "noPath" | "timeout" = "success",
) {
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
    const routeController = new AbortController();
    const request = {
      traceId: "trace-route-runtime",
      taskId: "task-route-runtime",
      botId: "bot-route-runtime",
      skillId: "travel.route",
      skillVersion: "1.0.0",
      capability: "bot.move" as const,
      operation: "travel.route-segment",
      signal: routeController.signal,
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
    const movementGoal = pathfinder.goto.mock.calls[0]![0] as { isEnd(node: { x: number; y: number; z: number }): boolean };
    expect(movementGoal.isEnd({ x: 3, y: 64, z: 0 })).toBe(true);
    expect(movementGoal.isEnd({ x: 5, y: 64, z: 0 })).toBe(false);
    const replacement = client.movementController.acquire({ owner: "next-navigation", priority: 40 })!;
    const stopCount = pathfinder.stop.mock.calls.length;
    routeController.abort();
    expect(pathfinder.stop).toHaveBeenCalledTimes(stopCount);
    expect(replacement.isCurrent()).toBe(true);
    replacement.release();
    const mineClient = client as unknown as { moveMineToTarget(request: Parameters<MineflayerBotClient["invokeSkillCapability"]>[0], target: Vec3, lookAt: boolean): Promise<void> };
    await expect(mineClient.moveMineToTarget({ ...request, invocationId: "next-mine", input: {},
      signal: new AbortController().signal }, new Vec3(4, 64, 0), false)).resolves.toBeUndefined();

    await expect(
      client.invokeSkillCapability({
        ...request,
        invocationId: "invocation-route-runtime-invalid",
        signal: new AbortController().signal,
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

describe("MineflayerBotClient process ownership", () => {
  it("clears inherited farm context and ignores late cleanup after another process takes ownership", async () => {
    const bot = new EventEmitter() as unknown as Bot;
    Object.assign(bot, { game: { dimension: "overworld" }, entity: { position: new Vec3(0, 64, 0) },
      pathfinder: { setMovements: vi.fn(), stop: vi.fn() }, clearControlStates: vi.fn(), stopDigging: vi.fn() });
    const client = new MineflayerBotClient(bot, "auto", "isolated-test-profile");
    const internals = client as unknown as {
      activeProcessSignal: AbortSignal | undefined; activeWorkAreaLeaseId: string | undefined; placementPurpose: string | undefined;
      withProcessNavigation(request: Parameters<MineflayerBotClient["invokeSkillCapability"]>[0],
        scope: { serverProfileId: string; dimension: string },
        work: (port: { assertActive(): void }) => Promise<void>): Promise<void>;
    };
    const controller = new AbortController();
    const scope = { serverProfileId: "isolated-test-profile", dimension: "minecraft:overworld" };
    const request = { invocationId: "old-farm", traceId: "trace", taskId: "task", botId: "bot", skillId: "farm.sustain",
      skillVersion: "1.0.0", capability: "bot.move" as const, operation: "test", signal: controller.signal, input: {} };
    let finishOld!: () => void, finishNew!: () => void;
    const old = internals.withProcessNavigation(request, scope, async (port) => {
      internals.placementPurpose = "farm"; internals.activeWorkAreaLeaseId = "old-area";
      await new Promise<void>((resolve) => { finishOld = resolve; });
      port.assertActive();
    });
    const oldResult = expect(old).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
    controller.abort();
    const next = internals.withProcessNavigation({ ...request, invocationId: "new-process", signal: new AbortController().signal }, scope, async (port) => {
      expect(internals.placementPurpose).toBeUndefined();
      expect(internals.activeWorkAreaLeaseId).toBeUndefined();
      internals.activeWorkAreaLeaseId = "new-area";
      await new Promise<void>((resolve) => { finishNew = resolve; });
      port.assertActive();
    });
    const nextSignal = internals.activeProcessSignal;
    const stops = vi.mocked(bot.pathfinder.stop).mock.calls.length;
    finishOld(); await oldResult;
    expect(internals.activeProcessSignal).toBe(nextSignal);
    expect(internals.activeWorkAreaLeaseId).toBe("new-area");
    expect(bot.pathfinder.stop).toHaveBeenCalledTimes(stops);
    finishNew(); await next;
    expect(internals.activeProcessSignal).toBeUndefined();
    expect(internals.activeWorkAreaLeaseId).toBeUndefined();
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

describe("collectReachableTargets", () => {
  // 总预算 6000ms 配逐候选 1500ms，最多只排得下 4 个候选。实测这条失败的
  // reason 曾写成 "Only 0 of 9 ... within the 1500ms pre-check budget."，
  // 读起来像九个都试过了；照那个数字去调 1500ms 只会让能排下的更少。
  function targetsAt(count: number) {
    return Array.from({ length: count }, (_unused, index) => ({
      position: new Vec3(index, 64, 0),
    }));
  }

  function pathfinderReturning(
    statuses: readonly string[],
    onCall?: () => void,
  ) {
    let call = 0;
    return {
      pathfinder: {
        getPathFromTo: vi.fn(function* () {
          onCall?.();
          yield { result: { status: statuses[call++] ?? "timeout" } };
        }),
      },
      entity: { position: new Vec3(0, 64, 0) },
      world: {},
    } as unknown as Pick<Bot, "pathfinder" | "entity" | "world">;
  }

  const movements = {} as Movements;

  it("counts only proven-pathless searches and reports how many it examined", async () => {
    const bot = pathfinderReturning(["noPath", "timeout", "noPath"]);

    const result = await collectReachableTargets(bot, movements, targetsAt(3), 3);

    expect(result.reachable).toHaveLength(0);
    expect(result.unproven).toHaveLength(1);
    // timeout 是预算耗尽,不是"这里没有路"的证明——合并两者会让一个没算完的
    // 搜索冒充定论,白丢一级 RETRY_SAME。
    expect(result.provenPathless).toBe(2);
    expect(result.examined).toBe(3);
    expect(result.stoppedOnTotalBudget).toBe(false);
  });

  it("stops at the requested count instead of draining the whole bench", async () => {
    const bot = pathfinderReturning(["success", "success", "success"]);

    const result = await collectReachableTargets(bot, movements, targetsAt(3), 1);

    expect(result.reachable).toHaveLength(1);
    expect(result.examined).toBe(1);
  });

  it("marks the total budget as the binding constraint when it truncates the sweep", async () => {
    // 每个候选推进 2500ms 的假时钟：第三个之前 6000ms 总预算就到了。
    vi.useFakeTimers();
    try {
      const bot = pathfinderReturning(
        ["timeout", "timeout", "timeout", "timeout"],
        () => vi.advanceTimersByTime(2_500),
      );

      const result = await collectReachableTargets(bot, movements, targetsAt(9), 9);

      expect(result.reachable).toHaveLength(0);
      expect(result.unproven).toHaveLength(9);
      expect(result.provenPathless).toBe(0);
      // 九个候选里只排得下三个。没有这个数,上层的 reason 就在暗示九个都试过。
      expect(result.examined).toBe(3);
      expect(result.stoppedOnTotalBudget).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("allows L0 cancellation between partial search slices", async () => {
    const controller = new AbortController();
    let slices = 0;
    const bot = pathfinderReturning([]);
    bot.pathfinder.getPathFromTo = function* () {
      for (;;) { slices++; yield { result: { status: "partial" } } as never; }
    } as typeof bot.pathfinder.getPathFromTo;
    setImmediate(() => controller.abort());
    await expect(collectReachableTargets(bot, movements, targetsAt(1), 1, controller.signal)).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
    expect(slices).toBe(1);
  });
});

describe("P5-D2c WorldMirror 灰度门（STUDIO_WORLD_MIRROR_SYNC）", () => {
  const probe = (client: MineflayerBotClient): unknown =>
    (client as unknown as { worldSyncAdapter: unknown }).worldSyncAdapter;

  it("flag 关闭（默认）：spawn 后零额外行为——不创建 adapter", () => {
    delete process.env.STUDIO_WORLD_MIRROR_SYNC;
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto");
    emitter.emit("spawn");
    expect(probe(client)).toBeNull();
  });

  it("flag 开启但 registry 未就绪：优雅无操作（不崩溃不伪造）", () => {
    process.env.STUDIO_WORLD_MIRROR_SYNC = "1";
    const emitter = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto");
    emitter.emit("spawn"); // 无 registry → bootWorldSync 早退
    expect(probe(client)).toBeNull();
    delete process.env.STUDIO_WORLD_MIRROR_SYNC;
  });
});

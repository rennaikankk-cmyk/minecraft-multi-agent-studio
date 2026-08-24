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
    default: { goals: { GoalNear: class {} } },
    Movements: TestMovements,
    pathfinder: vi.fn(),
  };
});

import type { BotClientHandlers } from "../src/client.js";
import {
  configureSafePathfinderMovements,
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
    const targetBlock = { position: targetPosition, type: 1 };
    const collectBlock = {
      chestLocations: [new Vec3(1, 2, 3)],
      movements: null as Movements | null,
      collect: vi.fn(async () => undefined),
      cancelTask: vi.fn(async () => undefined),
    };
    Object.assign(bot, {
      game: { dimension: "overworld" },
      registry: { blocksByName: { stone: { id: 1 } } },
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
  });

  it("does not treat Mineflayer's local dig prediction as a server success", async () => {
    const emitter = new EventEmitter();
    const wire = new EventEmitter();
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(7, 64, 2);
    const targetBlock = { position: targetPosition, type: 49 };
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

  it("waits for the collected item slot update before reporting inventory delta", async () => {
    const emitter = new EventEmitter();
    const inventory = new EventEmitter() as EventEmitter & {
      items: () => Array<{ name: string; count: number }>;
    };
    const bot = emitter as unknown as Bot;
    const targetPosition = new Vec3(2, 64, 0);
    const targetBlock = { position: targetPosition, type: 1 };
    let itemCount = 0;
    inventory.items = () =>
      itemCount > 0 ? [{ name: "oak_log", count: itemCount }] : [];
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
});

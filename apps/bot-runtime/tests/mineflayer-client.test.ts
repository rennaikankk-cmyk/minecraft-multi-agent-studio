import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import type { Movements } from "mineflayer-pathfinder";
import type { SkillCapabilityRequest } from "@minecraft-studio/skills";
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";

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

  it("scans only registry-confirmed blocks from loaded chunks without mutation", async () => {
    const emitter = new EventEmitter();
    const positions = [new Vec3(4, 62, 1), new Vec3(-2, 63, 0)];
    const bot = Object.assign(emitter, {
      game: { dimension: "overworld" },
      entity: { position: new Vec3(0.7, 64.2, 0.4) },
      registry: {
        blocksByName: {
          iron_ore: { id: 15 },
          lava: { id: 10 },
        },
      },
      findBlocks: vi.fn(() => positions),
      blockAt: vi.fn((position: Vec3) => ({
        name: position.x > 0 ? "iron_ore" : "lava",
        position,
      })),
    }) as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto", "isolated-local");

    await expect(
      client.invokeSkillCapability(capabilityRequest({
        capability: "world.read",
        operation: "scout.scan-blocks-safe",
        input: {
          serverProfileId: "isolated-local",
          dimension: "minecraft:overworld",
          blockNames: ["iron_ore", "lava"],
          maxDistance: 16,
          maxResults: 8,
        },
      })),
    ).resolves.toEqual({
      origin: { x: 0, y: 64, z: 0 },
      observations: [
        { blockName: "lava", position: { x: -2, y: 63, z: 0 } },
        { blockName: "iron_ore", position: { x: 4, y: 62, z: 1 } },
      ],
    });
    expect(bot.findBlocks).toHaveBeenCalledWith({
      matching: [15, 10],
      maxDistance: 16,
      count: 8,
    });
  });

  it("consumes only a registry-confirmed safe food and reports read-back", async () => {
    const emitter = new EventEmitter();
    const bread = { name: "bread", count: 2, slot: 36 };
    const inventoryItems = [bread];
    const bot = Object.assign(emitter, {
      food: 12,
      registry: { foodsByName: { bread: { foodPoints: 5, effectiveQuality: 6 } } },
      inventory: {
        items: () => inventoryItems,
      },
      clearControlStates: vi.fn(),
      equip: vi.fn(async () => undefined),
      consume: vi.fn(async () => {
        bot.food = 17;
        bread.count -= 1;
      }),
    }) as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto", "isolated-local");

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "inventory.write",
      operation: "food.consume-best-safe",
      input: { serverProfileId: "isolated-local", maximumFoodLevel: 18 },
    }))).resolves.toEqual({
      consumed: true,
      itemName: "bread",
      foodLevelBefore: 12,
      foodLevelAfter: 17,
    });
    expect(bot.consume).toHaveBeenCalledTimes(1);
  });

  it("sleeps only in the authorized nearby bed and verifies sleeping state", async () => {
    const emitter = new EventEmitter();
    const bot = Object.assign(emitter, {
      game: { dimension: "overworld" },
      isSleeping: false,
      blockAt: vi.fn(() => ({ name: "red_bed" })),
      sleep: vi.fn(async () => {
        bot.isSleeping = true;
      }),
    }) as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto", "isolated-local");

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "world.interact",
      operation: "bed.sleep-safe",
      input: {
        serverProfileId: "isolated-local",
        dimension: "minecraft:overworld",
        bed: { x: 1, y: 64, z: 0 },
      },
    }))).resolves.toEqual({
      sleeping: true,
      bed: { x: 1, y: 64, z: 0 },
    });
  });

  it("compacts into empty slots without changing stack or item totals", async () => {
    const emitter = new EventEmitter();
    const slots = Array.from({ length: 45 }, () => null) as Array<null | {
      name: string;
      count: number;
      slot: number;
    }>;
    slots[10] = { name: "bread", count: 3, slot: 10 };
    slots[44] = { name: "cobblestone", count: 64, slot: 44 };
    const inventory = {
      inventoryStart: 9,
      inventoryEnd: 45,
      slots,
    };
    const bot = Object.assign(emitter, {
      currentWindow: null,
      inventory,
      moveSlotItem: vi.fn(async (source: number, destination: number) => {
        inventory.slots[destination] = inventory.slots[source];
        inventory.slots[source] = null;
      }),
    }) as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto", "isolated-local");

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "inventory.write",
      operation: "inventory.compact-safe",
      input: { serverProfileId: "isolated-local", maxMoves: 2 },
    }))).resolves.toMatchObject({
      movedStacks: 1,
      occupiedSlotsBefore: 2,
      occupiedSlotsAfter: 2,
      totalItemsBefore: 67,
      totalItemsAfter: 67,
      preserved: true,
    });
  });

  it("attacks only a nearby hostile type with bounded attempts and honest tracking", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const self = { id: 1, position: new Vec3(0, 64, 0) };
      const zombie = {
        id: 2,
        type: "mob",
        name: "zombie",
        position: new Vec3(2, 64, 0),
        height: 1.95,
        isValid: true,
      };
      const entities: Record<number, unknown> = { 1: self, 2: zombie };
      const sword = { name: "iron_sword", count: 1, slot: 36 };
      const bot = Object.assign(emitter, {
        username: "StudioBot",
        health: 20,
        entity: self,
        entities,
        game: { dimension: "overworld" },
        inventory: { items: () => [sword] },
        pathfinder: { stop: vi.fn() },
        clearControlStates: vi.fn(),
        setControlState: vi.fn(),
        equip: vi.fn(async () => undefined),
        lookAt: vi.fn(async () => undefined),
        attack: vi.fn(() => {
          delete entities[2];
        }),
      }) as unknown as Bot;
      const client = new MineflayerBotClient(bot, "auto", "isolated-local");
      const resultPromise = client.invokeSkillCapability(capabilityRequest({
        capability: "combat.execute",
        operation: "combat.pve-melee-safe",
        input: {
          serverProfileId: "isolated-local",
          dimension: "minecraft:overworld",
          targetTypes: ["zombie"],
          maxDistance: 4,
          maxAttackAttempts: 3,
          retreatHealth: 10,
        },
      }));
      await vi.advanceTimersByTimeAsync(650);

      await expect(resultPromise).resolves.toMatchObject({
        targetFound: true,
        targetName: "zombie",
        weaponName: "iron_sword",
        attackAttempts: 1,
        targetStillTracked: false,
        retreated: false,
      });
      expect(bot.attack).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses PvP targets outside the explicit ServerProfile allow-list", async () => {
    const emitter = new EventEmitter();
    const self = { id: 1, position: new Vec3(0, 64, 0) };
    const target = {
      id: 2,
      type: "player",
      username: "ArenaBot",
      position: new Vec3(2, 64, 0),
      height: 1.8,
      isValid: true,
    };
    const bot = Object.assign(emitter, {
      username: "StudioBot",
      version: "1.21.8",
      protocolVersion: 772,
      majorVersion: "1.21",
      health: 20,
      entity: self,
      entities: { 1: self, 2: target },
      game: { dimension: "overworld" },
      registry: {},
    }) as unknown as Bot;
    const client = new MineflayerBotClient(
      bot,
      "auto",
      "isolated-local",
      ["SparringBot"],
    );

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "combat.execute",
      operation: "combat.pvp-melee-allowlisted",
      input: {
        serverProfileId: "isolated-local",
        dimension: "minecraft:overworld",
        targetUsername: "ArenaBot",
        maxDistance: 4,
        maxAttackAttempts: 1,
        retreatHealth: 10,
      },
    }))).rejects.toMatchObject({ code: "PVP_TARGET_NOT_ALLOWLISTED" });
    expect(client.skillCompatibilityEnvironment().serverCapability(
      "combat.pvp-enabled",
    )).toBe(true);
  });

  it("reads requested inventory and container counts without transferring items", async () => {
    const emitter = new EventEmitter();
    const close = vi.fn();
    const bot = Object.assign(emitter, {
      game: { dimension: "overworld" },
      blockAt: vi.fn(() => ({ name: "chest" })),
      inventory: {
        items: () => [{ name: "cobblestone", count: 8 }],
      },
      openContainer: vi.fn(async () => ({
        inventoryStart: 27,
        containerItems: () => [
          { name: "cobblestone", count: 64 },
          { name: "bread", count: 4 },
        ],
        close,
      })),
    }) as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto", "isolated-local");

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "container.read",
      operation: "container.account-safe",
      input: {
        serverProfileId: "isolated-local",
        dimension: "minecraft:overworld",
        container: { x: 1, y: 64, z: 0 },
        itemNames: ["cobblestone", "bread"],
      },
    }))).resolves.toMatchObject({
      containerName: "chest",
      containerUsedSlots: 2,
      containerTotalSlots: 27,
      items: [
        { itemName: "cobblestone", inventoryCount: 8, containerCount: 64, totalCount: 72 },
        { itemName: "bread", inventoryCount: 0, containerCount: 4, totalCount: 4 },
      ],
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("casts one fishing action and derives the catch from inventory read-back", async () => {
    vi.useFakeTimers();
    try {
      const emitter = new EventEmitter();
      const items = [{ name: "fishing_rod", count: 1, slot: 36 }];
      const bot = Object.assign(emitter, {
        game: { dimension: "overworld" },
        inventory: { items: () => items },
        equip: vi.fn(async () => undefined),
        fish: vi.fn(async () => {
          items.push({ name: "cod", count: 1, slot: 37 });
        }),
        activateItem: vi.fn(),
      }) as unknown as Bot;
      const client = new MineflayerBotClient(bot, "auto", "isolated-local");
      const resultPromise = client.invokeSkillCapability(capabilityRequest({
        capability: "world.interact",
        operation: "fishing.cast-once-safe",
        input: {
          serverProfileId: "isolated-local",
          dimension: "minecraft:overworld",
        },
      }));
      await vi.advanceTimersByTimeAsync(500);
      await expect(resultPromise).resolves.toEqual({
        caught: true,
        itemsGained: 1,
        itemName: "cod",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports honest no-op results when no requested drops or mature crops exist", async () => {
    const emitter = new EventEmitter();
    const bot = Object.assign(emitter, {
      game: { dimension: "overworld" },
      pathfinder: {},
      entities: {},
      registry: { blocksByName: { wheat: { id: 42 } } },
      findBlocks: vi.fn(() => []),
    }) as unknown as Bot;
    const client = new MineflayerBotClient(bot, "auto", "isolated-local");

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "bot.move",
      operation: "collect.drops-safe",
      input: {
        serverProfileId: "isolated-local",
        dimension: "minecraft:overworld",
        itemNames: ["oak_log"],
        maxCount: 4,
        maxDistance: 16,
      },
    }))).resolves.toEqual({ targetsFound: 0, itemsCollected: 0, items: [] });

    await expect(client.invokeSkillCapability(capabilityRequest({
      capability: "world.interact",
      operation: "farm.crop-replant-safe",
      input: {
        serverProfileId: "isolated-local",
        dimension: "minecraft:overworld",
        cropName: "wheat",
        maxCount: 4,
        maxDistance: 16,
      },
    }))).resolves.toEqual({
      cropName: "wheat",
      seedItemName: "wheat_seeds",
      matureTargetsFound: 0,
      harvested: 0,
      replanted: 0,
    });
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

function capabilityRequest(
  overrides: Pick<SkillCapabilityRequest, "capability" | "operation" | "input">,
): SkillCapabilityRequest {
  return {
    invocationId: "11111111-1111-4111-8111-111111111111",
    traceId: "trace-client-capability",
    taskId: "task-client-capability",
    botId: "worker-01",
    skillId: "test.skill",
    skillVersion: "1.0.0",
    signal: new AbortController().signal,
    ...overrides,
  };
}

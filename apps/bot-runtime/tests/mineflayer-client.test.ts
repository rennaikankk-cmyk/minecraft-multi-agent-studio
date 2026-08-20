import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import type { Movements } from "mineflayer-pathfinder";
import type { SkillCapabilityRequest } from "@minecraft-studio/skills";
import { describe, expect, it, vi } from "vitest";

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

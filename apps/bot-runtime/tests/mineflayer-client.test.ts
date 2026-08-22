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

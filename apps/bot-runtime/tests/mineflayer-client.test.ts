import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import type { Movements } from "mineflayer-pathfinder";
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

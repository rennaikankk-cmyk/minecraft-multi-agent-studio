import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import { describe, expect, it, vi } from "vitest";

import type { BotClientHandlers } from "../src/client.js";
import { MineflayerBotClient } from "../src/mineflayer-client.js";

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

import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { describe, expect, it, vi } from "vitest";
import { attachPlayerLoaded } from "../src/player-loaded.js";

describe("vanilla terrain-loading acknowledgment", () => {
  it.each(["1.21.4", "1.21.8", "1.21.11"])("announces readiness before actions after initial spawn and respawn (%s)", (version) => {
    const bot = new EventEmitter() as unknown as Bot;
    const order: string[] = [];
    Object.assign(bot, { version, _client: { write: (packet: string) => order.push(packet) } });
    bot.on("spawn", () => order.push("action"));
    attachPlayerLoaded(bot);
    bot.emit("spawn"); bot.emit("spawn");
    expect(order).toEqual(["player_loaded", "action", "player_loaded", "action"]);
    bot.emit("end"); bot.emit("spawn");
    expect(order.at(-2)).toBe("action");
  });
  it.each(["1.20.4", "1.21.1"])("does not write a packet absent from the negotiated protocol (%s)", (version) => {
    const bot = new EventEmitter() as unknown as Bot;
    const write = vi.fn();
    Object.assign(bot, { version, _client: { write } });
    attachPlayerLoaded(bot); bot.emit("spawn");
    expect(write).not.toHaveBeenCalled();
  });
});

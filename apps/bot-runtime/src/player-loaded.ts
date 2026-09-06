import minecraftData from "minecraft-data";
import type { Bot } from "mineflayer";

/** Locked Mineflayer4.37.1 omits the vanilla1.21.4+ loading-screen acknowledgment.
 * Upstream issue/fix: PrismarineJS/mineflayer#3960. Remove when the dependency handles it. */
export function attachPlayerLoaded(bot: Bot): void {
  const onSpawn = () => {
    if (typeof bot.version !== "string") return;
    const data = minecraftData(bot.version) as unknown as {
      protocol?: { play?: { toServer?: { types?: Record<string, unknown> } } };
    } | null;
    const packet = data?.protocol?.play?.toServer?.types?.packet_player_loaded;
    if (packet === undefined) return;
    if (!Array.isArray(packet) || packet[0] !== "container" || !Array.isArray(packet[1]) || packet[1].length !== 0) {
      bot.emit("error", new Error("PLAYER_LOADED_PROTOCOL_UNSUPPORTED"));
      return;
    }
    bot._client.write("player_loaded", {});
  };
  // Mineflayer's spawn indicates terrain/position readiness. Notify the server
  // before Runtime or Skill spawn listeners are allowed to interact.
  bot.prependListener("spawn", onSpawn);
  bot.once("end", () => { bot.removeListener("spawn", onSpawn); });
}

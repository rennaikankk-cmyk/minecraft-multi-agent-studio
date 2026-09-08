import type { BotChatMessage } from "./client.js";

type Player = { username: string; uuid: string };
type ChatPacket = { sender?: unknown; plainMessage?: unknown; verified?: unknown; type?: unknown };

/** The Mineflayer chat regex also matches forged system text. Use the
 * minecraft-protocol playerChat event and resolve its sender through the
 * server player list; names inside the rendered message confer no identity. */
export function protocolChatMessage(raw: unknown, players: readonly Player[]): BotChatMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const packet = raw as ChatPacket;
  if (typeof packet.sender !== "string" || typeof packet.plainMessage !== "string" ||
      !packet.plainMessage.length || packet.plainMessage.length > 512) return null;
  const sender = packet.sender.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/u.test(sender) || /^0+$/u.test(sender)) return null;
  const matching = players.filter((player) => typeof player.uuid === "string" &&
    player.uuid.replaceAll("-", "").toLowerCase() === sender);
  if (matching.length !== 1 || !/^[A-Za-z0-9_]{3,16}$/u.test(matching[0]!.username)) return null;
  return {
    speaker: matching[0]!.username, message: packet.plainMessage,
    protocolIdentity: { senderUuid: sender, playerListUsername: matching[0]!.username,
      signatureVerified: packet.verified === true, channel: "public" },
  };
}

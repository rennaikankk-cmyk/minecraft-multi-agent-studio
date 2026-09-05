import type { BotRegistryRecord } from "@minecraft-studio/coordinator";
import {
  publicBotDetailV1Schema,
  publicBotSummaryV1Schema,
  type ControlApiPermission,
  type PublicBotDetailV1,
  type PublicBotSummaryV1,
} from "@minecraft-studio/protocol";

export function toPublicBotSummary(
  record: BotRegistryRecord | PublicBotDetailV1,
): PublicBotSummaryV1 {
  return publicBotSummaryV1Schema.parse({
    botId: record.botId,
    connectionState: record.connectionState,
    lastMessageAt: record.lastMessageAt,
    lastHeartbeatAt: record.lastHeartbeatAt,
    lastStatusAt: record.lastStatusAt,
  });
}

export function toPublicBotDetail(
  record: BotRegistryRecord | PublicBotDetailV1,
  permissions: ReadonlySet<ControlApiPermission>,
): PublicBotDetailV1 {
  if ("positionRedacted" in record) {
    const canReadPosition = permissions.has("bot.position.read");
    return publicBotDetailV1Schema.parse({
      ...structuredClone(record),
      position: canReadPosition ? record.position : null,
      positionRedacted: record.position !== null && !canReadPosition,
    });
  }
  const status = record.currentStatus;
  const canReadPosition = permissions.has("bot.position.read");
  return publicBotDetailV1Schema.parse({
    ...toPublicBotSummary(record),
    health: status?.health ?? null,
    food: status?.food ?? null,
    armorPoints: status?.armorPoints ?? null,
    armorSlots: status?.armorSlots,
    performance: status?.performance,
    latencyMs: status?.latencyMs ?? null,
    currentTask: status?.currentTask ?? null,
    safety: status?.safety ?? null,
    combat: status?.combat ?? null,
    position: status && canReadPosition ? status.position : null,
    positionRedacted: status !== null && !canReadPosition,
    minecraftVersion: record.minecraftVersion,
  });
}

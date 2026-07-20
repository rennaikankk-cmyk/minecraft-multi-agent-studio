import type { BotRegistryRecord } from "@minecraft-studio/coordinator";
import {
  publicBotDetailV1Schema,
  publicBotSummaryV1Schema,
  type ControlApiPermission,
  type PublicBotDetailV1,
  type PublicBotSummaryV1,
} from "@minecraft-studio/protocol";

export function toPublicBotSummary(
  record: BotRegistryRecord,
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
  record: BotRegistryRecord,
  permissions: ReadonlySet<ControlApiPermission>,
): PublicBotDetailV1 {
  const status = record.currentStatus;
  const canReadPosition = permissions.has("bot.position.read");
  return publicBotDetailV1Schema.parse({
    ...toPublicBotSummary(record),
    health: status?.health ?? null,
    food: status?.food ?? null,
    armorPoints: status?.armorPoints ?? null,
    latencyMs: status?.latencyMs ?? null,
    currentTask: status?.currentTask ?? null,
    position: status && canReadPosition ? status.position : null,
    positionRedacted: status !== null && !canReadPosition,
    minecraftVersion: record.minecraftVersion,
  });
}

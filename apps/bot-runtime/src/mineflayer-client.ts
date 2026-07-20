import { createBot, type Bot } from "mineflayer";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "./client.js";
import type { ServerProfile } from "./server-profile.js";

const ARMOR_POINTS: Readonly<Record<string, number>> = {
  leather_helmet: 1,
  leather_chestplate: 3,
  leather_leggings: 2,
  leather_boots: 1,
  golden_helmet: 2,
  golden_chestplate: 5,
  golden_leggings: 3,
  golden_boots: 1,
  chainmail_helmet: 2,
  chainmail_chestplate: 5,
  chainmail_leggings: 4,
  chainmail_boots: 1,
  iron_helmet: 2,
  iron_chestplate: 6,
  iron_leggings: 5,
  iron_boots: 2,
  diamond_helmet: 3,
  diamond_chestplate: 8,
  diamond_leggings: 6,
  diamond_boots: 3,
  netherite_helmet: 3,
  netherite_chestplate: 8,
  netherite_leggings: 6,
  netherite_boots: 3,
  turtle_helmet: 2,
};

function safeDetail(value: unknown): string | undefined {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const normalized = text?.replace(/[\r\n\t]+/gu, " ").trim();
  return normalized ? normalized.slice(0, 500) : undefined;
}

function normalizeDimension(value: string): string {
  if (value.includes(":")) return value.toLowerCase();
  const normalized = value.toLowerCase().replace(/[^a-z0-9_./-]/gu, "_");
  return `minecraft:${normalized || "unknown"}`;
}

function readMaximumHealth(bot: Bot): number | null {
  const entity = bot.entity as typeof bot.entity & {
    attributes?: Record<string, { value?: number }>;
  };
  const attributes = entity.attributes ?? {};
  const entry = Object.entries(attributes).find(([name]) =>
    name.endsWith("max_health"),
  )?.[1];
  const value = entry?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

function readArmorPoints(bot: Bot): number | null {
  try {
    const destinations = ["head", "torso", "legs", "feet"] as const;
    return destinations.reduce((total, destination) => {
      const slot = bot.getEquipmentDestSlot(destination);
      const item = bot.inventory.slots[slot];
      return total + (item?.name ? (ARMOR_POINTS[item.name] ?? 0) : 0);
    }, 0);
  } catch {
    return null;
  }
}

function mapDisconnectReason(
  requestedStop: boolean,
  kickedDetail: string | undefined,
  errorDetail: string | undefined,
  endReason: string,
): BotDisconnectInfo {
  if (requestedStop) {
    return { reason: "requested_stop", expected: true };
  }
  if (kickedDetail) {
    return { reason: "kicked", expected: false, detail: kickedDetail };
  }
  if (errorDetail) {
    const authentication = /auth|login|token|session/iu.test(errorDetail);
    return {
      reason: authentication ? "authentication_error" : "network_error",
      expected: false,
      detail: errorDetail,
    };
  }
  const detail = safeDetail(endReason);
  return {
    reason: "unknown",
    expected: false,
    ...(detail ? { detail } : {}),
  };
}

export class MineflayerBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  private requestedStop = false;
  private kickedDetail: string | undefined;
  private errorDetail: string | undefined;

  constructor(private readonly bot: Bot) {
    bot.on("spawn", () => this.handlers?.onSpawn());
    bot.on("health", () => this.handlers?.onStateChanged());
    bot.on("move", () => this.handlers?.onStateChanged());
    bot.on("entityEquip", (entity) => {
      if (entity === bot.entity) this.handlers?.onStateChanged();
    });
    bot.on("kicked", (reason) => {
      this.kickedDetail = safeDetail(reason);
    });
    bot.on("error", (error) => {
      this.errorDetail = safeDetail(error.message);
      this.handlers?.onError(error);
    });
    bot.on("end", (reason) => {
      this.handlers?.onDisconnected(
        mapDisconnectReason(
          this.requestedStop,
          this.kickedDetail,
          this.errorDetail,
          reason,
        ),
      );
    });
  }

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    const position = this.bot.entity.position;
    const ping = this.bot.player?.ping;
    return {
      health: {
        current: this.bot.health,
        maximum: readMaximumHealth(this.bot),
      },
      food: {
        level: this.bot.food,
        saturation: this.bot.foodSaturation,
      },
      armorPoints: readArmorPoints(this.bot),
      position: {
        x: position.x,
        y: position.y,
        z: position.z,
        dimension: normalizeDimension(String(this.bot.game.dimension)),
      },
      latencyMs:
        typeof ping === "number" && Number.isFinite(ping) && ping >= 0
          ? Math.round(ping)
          : null,
    };
  }

  async close(gracePeriodMs: number): Promise<void> {
    if (this.requestedStop) return;
    this.requestedStop = true;

    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(() => {
        this.bot.end("studio_safe_stop_timeout");
        finish();
      }, gracePeriodMs);

      this.bot.once("end", finish);
      this.bot.quit("studio_safe_stop");
      if (gracePeriodMs === 0) {
        this.bot.end("studio_safe_stop");
      }
    });
  }
}

export function createMineflayerClient(profile: ServerProfile): BotClient {
  const bot = createBot({
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: profile.auth,
    version: profile.minecraftVersion,
    hideErrors: true,
    logErrors: false,
  });
  return new MineflayerBotClient(bot);
}

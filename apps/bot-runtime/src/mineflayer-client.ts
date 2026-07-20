import { createBot, type Bot } from "mineflayer";
import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "./client.js";
import type { ServerProfile } from "./server-profile.js";
import {
  isMineflayerUnsupportedVersionError,
  mineflayerVersionOption,
  resolvedVersionCompatibility,
} from "./version-compatibility.js";

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

const SAFE_FOOD_NAMES = new Set([
  "apple",
  "baked_potato",
  "beetroot",
  "beetroot_soup",
  "bread",
  "carrot",
  "cooked_beef",
  "cooked_chicken",
  "cooked_cod",
  "cooked_mutton",
  "cooked_porkchop",
  "cooked_rabbit",
  "cooked_salmon",
  "dried_kelp",
  "glow_berries",
  "melon_slice",
  "mushroom_stew",
  "pumpkin_pie",
  "rabbit_stew",
  "sweet_berries",
]);

type SafetyEntityState = Readonly<{
  isInWater?: unknown;
  isInLava?: unknown;
}>;

type FoodMetadata = Readonly<{
  foodPoints: number;
  effectiveQuality?: number;
}>;

type FoodRegistry = Readonly<{
  foodsByName?: Readonly<Record<string, FoodMetadata>>;
}>;

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
  versionUnsupported: boolean,
  kickedDetail: string | undefined,
  errorDetail: string | undefined,
  endReason: string,
): BotDisconnectInfo {
  if (requestedStop) {
    return { reason: "requested_stop", expected: true };
  }
  if (versionUnsupported) {
    return {
      reason: "runtime_error",
      expected: false,
      detail: "unsupported_minecraft_version",
    };
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
  private versionUnsupportedReported = false;
  private inventoryListenerBound = false;

  constructor(
    private readonly bot: Bot,
    private readonly configuredVersion: ServerProfile["minecraftVersion"],
  ) {
    bot.on("spawn", () => {
      this.bindInventoryEvents();
      this.handlers?.onSpawn();
    });
    bot.on("health", () => this.handlers?.onStateChanged());
    bot.on("breath", () => this.handlers?.onStateChanged());
    bot.on("move", () => this.handlers?.onStateChanged());
    bot.on("physicsTick", () => this.handlers?.onStateChanged());
    bot.on("entityEquip", (entity) => {
      if (entity === bot.entity) this.handlers?.onStateChanged();
    });
    bot.on("kicked", (reason) => {
      this.kickedDetail = safeDetail(reason);
    });
    bot.on("error", (error) => {
      this.errorDetail = safeDetail(error.message);
      if (
        !this.versionUnsupportedReported &&
        isMineflayerUnsupportedVersionError(error)
      ) {
        this.versionUnsupportedReported = true;
        this.handlers?.onVersionUnsupported();
      }
      this.handlers?.onError(error);
    });
    bot.on("end", (reason) => {
      this.handlers?.onDisconnected(
        mapDisconnectReason(
          this.requestedStop,
          this.versionUnsupportedReported,
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
    const entityState = this.bot.entity as typeof this.bot.entity &
      SafetyEntityState;
    const inventoryStart = this.bot.inventory.inventoryStart;
    const inventoryEnd = this.bot.inventory.inventoryEnd;
    const inventorySlots =
      Number.isInteger(inventoryStart) &&
      Number.isInteger(inventoryEnd) &&
      inventoryEnd >= inventoryStart
        ? this.bot.inventory.slots.slice(inventoryStart, inventoryEnd)
        : [];
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
      safety: {
        oxygenLevel:
          Number.isInteger(this.bot.oxygenLevel) &&
          this.bot.oxygenLevel >= 0 &&
          this.bot.oxygenLevel <= 20
            ? this.bot.oxygenLevel
            : null,
        inWater: entityState.isInWater === true,
        inLava: entityState.isInLava === true,
        onGround: this.bot.entity.onGround === true,
        velocityY: Number.isFinite(this.bot.entity.velocity.y)
          ? this.bot.entity.velocity.y
          : null,
        inventory: {
          usedSlots: inventorySlots.filter((item) => item !== null).length,
          totalSlots: inventorySlots.length,
        },
        hasSafeFood: this.safeFoodItems().length > 0,
        movementRequested: (["forward", "back", "left", "right"] as const)
          .some((control) => this.bot.getControlState(control)),
      },
    };
  }

  async executeSafetyAction(
    action: L0SafetyAction,
  ): Promise<L0SafetyActionResult> {
    if (this.requestedStop) {
      return { outcome: "skipped", errorCode: "RUNTIME_STOPPING" };
    }
    try {
      if (
        action.kind === "PAUSE_NORMAL_TASKS" ||
        action.kind === "HALT_HORIZONTAL_MOVEMENT"
      ) {
        this.bot.clearControlStates();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "CONSUME_SAFE_FOOD") {
        const food = this.safeFoodItems()[0];
        if (!food) return { outcome: "skipped", errorCode: "NO_SAFE_FOOD" };
        this.bot.clearControlStates();
        await this.bot.equip(food.item, "hand");
        await this.bot.consume();
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "RETREAT_STEP") {
        await this.applyBoundedControls(action.durationMs, ["back", "sprint"]);
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "ASCEND") {
        await this.applyBoundedControls(action.durationMs, ["jump"]);
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "ESCAPE_LAVA") {
        await this.applyBoundedControls(action.durationMs, ["jump", "forward"]);
        return { outcome: "executed", errorCode: null };
      }
      if (action.kind === "UNSTICK") {
        await this.applyBoundedControls(action.durationMs, ["jump", "back"]);
        return { outcome: "executed", errorCode: null };
      }
      return { outcome: "skipped", errorCode: "RUNTIME_ACTION_REQUIRED" };
    } catch {
      this.bot.clearControlStates();
      return { outcome: "failed", errorCode: "SAFETY_ACTION_FAILED" };
    }
  }

  versionCompatibility() {
    return resolvedVersionCompatibility(this.configuredVersion, this.bot.version);
  }

  async close(gracePeriodMs: number): Promise<void> {
    if (this.requestedStop) return;
    this.requestedStop = true;
    this.bot.clearControlStates();

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

  private safeFoodItems() {
    const registry = this.bot.registry as unknown as FoodRegistry;
    return this.bot.inventory
      .items()
      .filter((item) => SAFE_FOOD_NAMES.has(item.name))
      .map((item) => ({ item, metadata: registry.foodsByName?.[item.name] }))
      .filter(
        (entry): entry is typeof entry & { metadata: FoodMetadata } =>
          entry.metadata !== undefined &&
          Number.isFinite(entry.metadata.foodPoints) &&
          entry.metadata.foodPoints > 0,
      )
      .sort(
        (left, right) =>
          (right.metadata.effectiveQuality ?? right.metadata.foodPoints) -
            (left.metadata.effectiveQuality ?? left.metadata.foodPoints) ||
          left.item.name.localeCompare(right.item.name),
      );
  }

  private bindInventoryEvents(): void {
    if (this.inventoryListenerBound) return;
    const inventory = this.bot.inventory;
    if (!inventory || typeof inventory.on !== "function") return;
    inventory.on("updateSlot", () => this.handlers?.onStateChanged());
    this.inventoryListenerBound = true;
  }

  private async applyBoundedControls(
    durationMs: number | undefined,
    controls: readonly ("forward" | "back" | "jump" | "sprint")[],
  ): Promise<void> {
    if (
      !Number.isSafeInteger(durationMs) ||
      durationMs === undefined ||
      durationMs < 100 ||
      durationMs > 2_000
    ) {
      throw new TypeError("Safety action duration is invalid.");
    }
    this.bot.clearControlStates();
    for (const control of controls) this.bot.setControlState(control, true);
    await new Promise<void>((resolve) => setTimeout(resolve, durationMs));
    this.bot.clearControlStates();
  }
}

export function createMineflayerClient(profile: ServerProfile): BotClient {
  const bot = createBot(createMineflayerOptions(profile));
  return new MineflayerBotClient(bot, profile.minecraftVersion);
}

export function createMineflayerOptions(profile: ServerProfile) {
  const version = mineflayerVersionOption(profile.minecraftVersion);
  return {
    host: profile.host,
    port: profile.port,
    username: profile.username,
    auth: profile.auth,
    ...(version === false ? {} : { version }),
    hideErrors: true,
    logErrors: false,
  };
}

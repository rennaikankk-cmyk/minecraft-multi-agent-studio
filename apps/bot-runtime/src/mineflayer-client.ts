import { createBot, type Bot } from "mineflayer";
import pathfinderModule, {
  Movements,
  pathfinder,
} from "mineflayer-pathfinder";
import { plugin as collectBlockPlugin } from "mineflayer-collectblock";
import { Vec3 } from "vec3";
import type {
  L0SafetyAction,
  L0SafetyActionResult,
} from "@minecraft-studio/safety";
import {
  armorEquipCapabilityInputSchema,
  armorEquipCapabilityOutputSchema,
  armorSnapshotCapabilityInputSchema,
  armorSnapshotCapabilityOutputSchema,
  collectBlockCapabilityInputSchema,
  collectBlockCapabilityOutputSchema,
  containerTransferCapabilityInputSchema,
  containerTransferCapabilityOutputSchema,
  craftItemCapabilityInputSchema,
  craftItemCapabilityOutputSchema,
  placeBlockCapabilityInputSchema,
  placeBlockCapabilityOutputSchema,
  smeltItemCapabilityInputSchema,
  smeltItemCapabilityOutputSchema,
  SAFE_PATH_MAX_DISTANCE,
  SkillFault,
  resolveMovementProfile,
  type ServerPolicyLimits,
  safeMovementGotoCapabilityInputSchema,
  safeMovementGotoCapabilityOutputSchema,
  travelRouteCapabilityInputSchema,
  tradeVillagerCapabilityInputSchema,
  tradeVillagerCapabilityOutputSchema,
  scanBlocksCapabilityInputSchema,
  scanBlocksCapabilityOutputSchema,
  siteObserveCapabilityInputSchema,
  siteObserveCapabilityOutputSchema,
  shelterDigCapabilityInputSchema,
  shelterDigCapabilityOutputSchema,
  mineBranchCapabilityInputSchema,
  mineBranchCapabilityOutputSchema,
  mineVeinCapabilityInputSchema,
  mineVeinCapabilityOutputSchema,
  buildBlueprintCapabilityInputSchema,
  buildBlueprintCapabilityOutputSchema,
  storeSortCapabilityInputSchema,
  storeSortCapabilityOutputSchema,  type SkillCapabilityRequest,
  type SkillCompatibilityEnvironment,
  type SkillResourceKind,
} from "@minecraft-studio/skills";
import type {
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";
import { MineflayerCombatAdapter } from "./combat-mineflayer-adapter.js";
import { observeSite, digShelter } from "./site-shelter-adapter.js";

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

const { goals } = pathfinderModule;

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

/**
 * container.transfer 允许打开的容器方块。刻意不含漏斗/发射器等红石敏感容器，
 * 也不含潜影盒以外任何"打开会改变世界状态"的方块。
 */
const CONTAINER_BLOCK_NAMES = new Set([
  "chest",
  "trapped_chest",
  "barrel",
  ...[
    "shulker_box",
    "white_shulker_box",
    "orange_shulker_box",
    "magenta_shulker_box",
    "light_blue_shulker_box",
    "yellow_shulker_box",
    "lime_shulker_box",
    "pink_shulker_box",
    "gray_shulker_box",
    "light_gray_shulker_box",
    "cyan_shulker_box",
    "purple_shulker_box",
    "blue_shulker_box",
    "brown_shulker_box",
    "green_shulker_box",
    "red_shulker_box",
    "black_shulker_box",
  ],
]);

/** Armor skill slot names paired with Mineflayer equipment destinations. */
const ARMOR_SLOT_DESTINATIONS = [
  { slot: "head", destination: "head" },
  { slot: "torso", destination: "torso" },
  { slot: "legs", destination: "legs" },
  { slot: "feet", destination: "feet" },
] as const satisfies ReadonlyArray<{
  slot: "head" | "torso" | "legs" | "feet";
  destination: "head" | "torso" | "legs" | "feet";
}>;

/**
 * Map each known armor item to the slot it belongs in, derived from the item
 * name suffix. Only names present in ARMOR_POINTS are accepted, so the write
 * primitive can never be tricked into equipping a non-armor item.
 */
const ARMOR_ITEM_SLOT: Readonly<Record<string, "head" | "torso" | "legs" | "feet">> =
  Object.fromEntries(
    Object.keys(ARMOR_POINTS).map((name) => {
      if (name.endsWith("_helmet") || name === "turtle_helmet") {
        return [name, "head"] as const;
      }
      if (name.endsWith("_chestplate")) return [name, "torso"] as const;
      if (name.endsWith("_leggings")) return [name, "legs"] as const;
      return [name, "feet"] as const;
    }),
  );

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

const COLLECT_INVENTORY_SYNC_TIMEOUT_MS = 1_000;
// Mineflayer emits `diggingCompleted` after its local prediction, before the
// server necessarily accepts the finish packet. Keep collection fail-closed
// until an authoritative block update arrives.
const COLLECT_SERVER_CONFIRM_TIMEOUT_MS = 1_500;
const COLLECT_SERVER_DIG_RETRIES = 1;

type BlockPosition = Readonly<{ x: number; y: number; z: number }>;

type MineflayerWireClient = {
  on?: (event: string, listener: (packet: unknown) => void) => void;
  off?: (event: string, listener: (packet: unknown) => void) => void;
  removeListener?: (event: string, listener: (packet: unknown) => void) => void;
};

type AuthoritativeBlockUpdate = Readonly<{
  position: BlockPosition;
  stateId: number;
}>;

function blockPositionKey(position: BlockPosition): string {
  return `${position.x},${position.y},${position.z}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parseBlockChangePacket(packet: unknown): AuthoritativeBlockUpdate | null {
  const record = asRecord(packet);
  const location = asRecord(record?.location);
  const x = finiteNumber(location?.x);
  const y = finiteNumber(location?.y);
  const z = finiteNumber(location?.z);
  const stateId = finiteNumber(record?.type);
  if (x === null || y === null || z === null || stateId === null) return null;
  return { position: { x, y, z }, stateId };
}

function parseMultiBlockChangePackets(packet: unknown): AuthoritativeBlockUpdate[] {
  const record = asRecord(packet);
  const records = Array.isArray(record?.records) ? record.records : [];
  const chunkCoordinates = asRecord(record?.chunkCoordinates);
  const chunkX = finiteNumber(chunkCoordinates?.x ?? record?.chunkX);
  const chunkY = finiteNumber(chunkCoordinates?.y);
  const chunkZ = finiteNumber(chunkCoordinates?.z ?? record?.chunkZ);
  if (chunkX === null || chunkZ === null) return [];

  const updates: AuthoritativeBlockUpdate[] = [];
  for (const entry of records) {
    const change = asRecord(entry);
    const horizontalPos = finiteNumber(change?.horizontalPos);
    const localY = finiteNumber(change?.y);
    const stateId = finiteNumber(change?.blockId);
    if (horizontalPos === null || localY === null || stateId === null) continue;
    const x = chunkX * 16 + ((horizontalPos >> 4) & 0xf);
    const z = chunkZ * 16 + (horizontalPos & 0xf);
    const y = (chunkY === null ? 0 : chunkY * 16) + localY;
    updates.push({ position: { x, y, z }, stateId });
  }
  return updates;
}

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

export function configureSafePathfinderMovements(
  movements: Movements,
): Movements {
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.scafoldingBlocks = [];
  movements.maxDropDown = 2;
  movements.infiniteLiquidDropdownDistance = false;
  movements.exclusionAreasBreak = [() => 100];
  movements.exclusionAreasPlace = [() => 100];
  return movements;
}

export function configurePathfinderMovements(
  movements: Movements,
  profile: "SAFE" | "PARKOUR" = "SAFE",
  policyLimits?: ServerPolicyLimits,
  isolatedTestServer = false,
): Movements {
  if (profile === "SAFE") return configureSafePathfinderMovements(movements);
  if (policyLimits === undefined) throw new SkillFault("POLICY_PARKOUR_FORBIDDEN");
  const decision = resolveMovementProfile(profile, policyLimits, isolatedTestServer);
  if (!decision.allowed) throw new SkillFault(decision.errorCode);
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = decision.config.allowFreeMotion;
  movements.allowParkour = decision.config.allowParkour;
  movements.allowSprinting = decision.config.allowSprinting;
  movements.scafoldingBlocks = [];
  movements.maxDropDown = decision.config.maxDropDown;
  movements.infiniteLiquidDropdownDistance = false;
  movements.exclusionAreasBreak = [() => 100];
  movements.exclusionAreasPlace = [() => 100];
  return movements;
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
  private activePathInvocationId: string | null = null;
  private readonly combatAdapter: MineflayerCombatAdapter;

  constructor(
    private readonly bot: Bot,
    private readonly configuredVersion: ServerProfile["minecraftVersion"],
    private readonly serverProfileId: string | null = null,
    combatEnabled = false,
  ) {
    this.combatAdapter = new MineflayerCombatAdapter(
      bot,
      serverProfileId ?? "",
      combatEnabled,
    );
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
      this.stopPathfinder();
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

  async invokeSkillCapability(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    if (this.requestedStop) {
      throw new SkillFault("RUNTIME_STOPPING");
    }
    if (!this.serverProfileId) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    if (
      request.capability === "bot.move" &&
      request.operation === "travel.route-segment"
    ) {
      const input = travelRouteCapabilityInputSchema.safeParse(request.input);
      if (!input.success) {
        throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
      }
      return this.invokeMovementGoto({
        ...request,
        input: { target: input.data.target, radius: input.data.radius },
      });
    }
    if (
      request.capability === "bot.move" &&
      request.operation === "pathfinder.goto-safe"
    ) {
      return this.invokeMovementGoto(request);
    }
    if (
      request.capability === "inventory.read" &&
      request.operation === "armor.snapshot"
    ) {
      return this.invokeArmorSnapshot(request);
    }
    if (
      request.capability === "inventory.write" &&
      request.operation === "armor.equip"
    ) {
      return this.invokeArmorEquip(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "collect.blocks-safe"
    ) {
      return this.invokeCollectBlocks(request);
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "craft.item-safe"
    ) {
      return this.invokeCraftItem(request);
    }
    if (
      request.capability === "craft.execute" &&
      request.operation === "smelt.item-safe"
    ) {
      return this.invokeSmeltItem(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "block.place-safe"
    ) {
      return this.invokePlaceBlock(request);
    }
    if (
      request.capability === "container.write" &&
      request.operation === "container.transfer-safe"
    ) {
      return this.invokeContainerTransfer(request);
    }    if (
      request.capability === "world.interact" &&
      request.operation === "trade.villager-safe"
    ) {
      return this.invokeTradeVillager(request);
    }
    if (
      request.capability === "world.read" &&
      request.operation === "site.observe-safe"
    ) {
      return this.invokeSiteObservation(request);
    }
    if (
      request.capability === "world.read" &&
      request.operation === "world.scan-blocks-safe"
    ) {
      return this.invokeScanBlocks(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "shelter.dig-safe"
    ) {
      return this.invokeShelterDig(request);
    }
    if (
      request.capability === "world.interact" &&
      (request.operation === "mine.branch-safe" || request.operation === "mine.vein-safe")
    ) {
      return this.invokeMinePlan(request);
    }
    throw new SkillFault("SKILL_CAPABILITY_UNSUPPORTED");
  }

  private async invokeSiteObservation(request: SkillCapabilityRequest): Promise<unknown> {
    const input = siteObserveCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.candidate.serverProfileId);
    this.assertDimensionMatch(input.data.candidate.dimension);
    return siteObserveCapabilityOutputSchema.parse(observeSite(this.bot, this.serverProfileId!, input.data));
  }

  /**
   * 只读方块扫描。与 `invokeCollectBlocks` 共用 registry.blocksByName →
   * findBlocks → blockAt 这条链，但到 blockAt 就停：不设 canDig、不动
   * pathfinder、不碰背包。`complete` 记录的是这条链有没有走完——findBlocks
   * 报了坐标而 blockAt 读不到（区块未加载）时，那一项进不了 matches，
   * 于是 complete 为 false。把它当成"附近没有"会让上层误判。
   */
  private async invokeScanBlocks(request: SkillCapabilityRequest): Promise<unknown> {
    const input = scanBlocksCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id: number } | undefined>;
    };
    const blockType = registry.blocksByName?.[input.data.blockName];
    if (!blockType) throw new SkillFault("BLOCK_NAME_UNKNOWN");
    const origin = this.bot.entity?.position;
    if (!origin) throw new SkillFault("SKILL_CAPABILITY_FAILED");
    const positions = this.bot.findBlocks({
      matching: blockType.id,
      maxDistance: input.data.maxDistance,
      count: input.data.maxCount,
    });
    const matches = positions
      .filter((position) => this.bot.blockAt(position) !== null)
      .map((position) => ({
        x: Math.floor(position.x),
        y: Math.floor(position.y),
        z: Math.floor(position.z),
        distance: origin.distanceTo(position),
      }))
      .sort((left, right) => left.distance - right.distance);
    return scanBlocksCapabilityOutputSchema.parse({
      blockName: input.data.blockName,
      dimension: input.data.dimension,
      matches,
      targetsFound: positions.length,
      complete: matches.length === positions.length,
    });
  }

  private async invokeShelterDig(request: SkillCapabilityRequest): Promise<unknown> {
    const input = shelterDigCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const output = await digShelter(this.bot, this.serverProfileId!, input.data, request.signal);
    return shelterDigCapabilityOutputSchema.parse(output);
  }

  private async invokeMinePlan(request: SkillCapabilityRequest): Promise<unknown> {
    const isBranch = request.operation === "mine.branch-safe";
    const input = (isBranch ? mineBranchCapabilityInputSchema : mineVeinCapabilityInputSchema).safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const plan = (input.data as { plan?: unknown }).plan;
    if (plan === undefined) throw new SkillFault("MINE_RUNTIME_NOT_WIRED");
    // Mining execution is kept behind a dedicated bounded adapter. Returning a
    // planner result as a success would silently claim blocks were broken, so
    // until that adapter is supplied we fail closed with an auditable code.
    throw new SkillFault("MINE_RUNTIME_NOT_WIRED");
  }

  private async invokeTradeVillager(request: SkillCapabilityRequest): Promise<unknown> {
    const input = tradeVillagerCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const entities = Object.values(this.bot.entities ?? {}) as Array<any>;
    const villager = entities.find((entity) => String(entity?.id) === input.data.villagerEntityId);
    if (!villager) throw new SkillFault("VILLAGER_NOT_FOUND");
    const distance = this.bot.entity.position.distanceTo(villager.position);
    if (!Number.isFinite(distance) || distance > 3.8) throw new SkillFault("VILLAGER_OUT_OF_REACH");
    const botWithTrade = this.bot as Bot & {
      openVillager?: (entity: unknown) => Promise<any>;
      trade?: (entity: unknown, index: number, times: number) => Promise<void>;
    };
    if (typeof botWithTrade.openVillager !== "function" || typeof botWithTrade.trade !== "function") {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    let window: any = null;
    try {
      window = await botWithTrade.openVillager(villager);
      const trades = Array.isArray(window?.trades) ? window.trades : [];
      const index = trades.findIndex((trade: any) => String(trade?.outputItem?.name ?? trade?.outputItem?.type) === input.data.wantItem);
      if (index < 0) throw new SkillFault("TRADE_OFFER_NOT_FOUND");
      const trade = trades[index] as any;
      const uses = Number(trade?.nbTradeUses ?? trade?.uses ?? 0);
      const maximum = Number(trade?.maximumNbTradeUses ?? trade?.maxUses ?? 0);
      if (trade?.tradeDisabled === true || (maximum > 0 && uses >= maximum)) throw new SkillFault("TRADE_DISABLED");
      const realPrice = Math.max(0, Number(trade?.inputItem1?.count ?? trade?.price ?? 0));
      const specialPrice = Math.max(0, Number(trade?.specialPrice ?? realPrice));
      if (realPrice > input.data.maxUnitPrice || specialPrice > input.data.maxUnitPrice) throw new SkillFault("TRADE_PRICE_UNACCEPTABLE");
      const paymentName = String(trade?.inputItem1?.name ?? trade?.inputItem1?.type ?? "");
      if (!paymentName || this.countInventoryItem(paymentName) < realPrice) throw new SkillFault("TRADE_ITEM_NOT_IN_INVENTORY");
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      const beforeSpent = this.countInventoryItem(paymentName);
      const beforeReceived = this.countInventoryItem(input.data.wantItem);
      const maxAvailable = maximum > 0 ? Math.max(0, maximum - uses) : input.data.maxTrades;
      const times = Math.min(input.data.maxTrades, maxAvailable);
      await botWithTrade.trade(villager, index, times);
      const spent = Math.max(0, beforeSpent - this.countInventoryItem(paymentName));
      const received = Math.max(0, this.countInventoryItem(input.data.wantItem) - beforeReceived);
      const completedTrades = Math.min(times, received > 0 ? Math.max(1, Math.floor(received / Math.max(1, Number(trade?.outputItem?.count ?? 1)))) : Math.floor(spent / Math.max(1, realPrice)));
      if (completedTrades < 1) throw new SkillFault("NON_IDEMPOTENT_RESULT_UNCERTAIN");
      return tradeVillagerCapabilityOutputSchema.parse({
        villagerEntityId: input.data.villagerEntityId,
        wantItem: input.data.wantItem,
        requestedTrades: input.data.maxTrades,
        completedTrades,
        receivedCount: received,
        spentCount: spent,
        actualUnitPrice: Math.ceil(spent / completedTrades),
      });
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("SKILL_CAPABILITY_FAILED");
    } finally {
      try { window?.close?.(); } catch { /* close is best effort */ }
    }
  }
  combatObservation(nowMs: number): CombatDriverObservation | null {
    return this.combatAdapter.observation(nowMs);
  }

  executeCombatAction(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ): Promise<CombatActionAcknowledgement> {
    return this.combatAdapter.execute(action, signal);
  }

  resetCombat(): void {
    this.combatAdapter.reset();
  }

  setCombatClock(clock: () => number): void {
    this.combatAdapter.setClock(clock);
  }

  private async invokeMovementGoto(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    if (!this.bot.pathfinder) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    if (this.activePathInvocationId !== null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
    }

    const input = safeMovementGotoCapabilityInputSchema.safeParse(
      request.input,
    );
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    const currentDimension = normalizeDimension(String(this.bot.game.dimension));
    if (input.data.target.serverProfileId !== this.serverProfileId) {
      throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
    }
    if (input.data.target.dimension !== currentDimension) {
      throw new SkillFault("TARGET_DIMENSION_MISMATCH");
    }

    const startingPosition = this.bot.entity.position;
    const startingDistance = Math.hypot(
      input.data.target.x - startingPosition.x,
      input.data.target.y - startingPosition.y,
      input.data.target.z - startingPosition.z,
    );
    if (
      !Number.isFinite(startingDistance) ||
      startingDistance > SAFE_PATH_MAX_DISTANCE
    ) {
      throw new SkillFault("TARGET_OUT_OF_SAFE_RANGE");
    }

    const movements = configureSafePathfinderMovements(
      new Movements(this.bot),
    );
    this.bot.pathfinder.setMovements(movements);
    this.bot.pathfinder.thinkTimeout = 5_000;
    this.bot.pathfinder.tickTimeout = 20;
    this.activePathInvocationId = request.invocationId;

    const stopOnAbort = () => this.stopPathfinder();
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal.aborted) {
        stopOnAbort();
        throw new SkillFault("SKILL_CANCELLED");
      }
      await this.bot.pathfinder.goto(
        new goals.GoalNear(
          input.data.target.x,
          input.data.target.y,
          input.data.target.z,
          input.data.radius,
        ),
      );
    } catch {
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      this.stopPathfinder();
      throw new SkillFault("PATHFINDER_GOTO_FAILED");
    } finally {
      request.signal.removeEventListener("abort", stopOnAbort);
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
    }

    const finalPosition = this.bot.entity.position;
    const distanceToTarget = Math.hypot(
      input.data.target.x - finalPosition.x,
      input.data.target.y - finalPosition.y,
      input.data.target.z - finalPosition.z,
    );
    if (
      !Number.isFinite(distanceToTarget) ||
      distanceToTarget > input.data.radius + 0.5
    ) {
      throw new SkillFault("PATH_TARGET_NOT_REACHED");
    }

    return safeMovementGotoCapabilityOutputSchema.parse({
      reached: true,
      finalPosition: {
        x: finalPosition.x,
        y: finalPosition.y,
        z: finalPosition.z,
        dimension: currentDimension,
        serverProfileId: this.serverProfileId,
      },
      distanceToTarget,
    });
  }

  private assertServerProfileMatch(requestedProfileId: string): void {
    if (requestedProfileId !== this.serverProfileId) {
      throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
    }
  }

  /**
   * Report, per armor slot, the currently-equipped piece and the wearable
   * candidates the bot already holds. Read-only primitive: it never equips
   * anything or invents items. Decisions are made by the skill, not here.
   */
  private async invokeArmorSnapshot(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = armorSnapshotCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);

    const inventoryItems = this.bot.inventory.items();
    const slots = ARMOR_SLOT_DESTINATIONS.map(({ slot, destination }) => {
      let equipped: string | null = null;
      try {
        const equipmentSlot = this.bot.getEquipmentDestSlot(destination);
        equipped = this.bot.inventory.slots[equipmentSlot]?.name ?? null;
      } catch {
        equipped = null;
      }
      const candidates = inventoryItems
        .map((item) => item.name)
        .filter(
          (name) =>
            typeof name === "string" &&
            ARMOR_ITEM_SLOT[name] === slot &&
            name !== equipped,
        );
      return { slot, equipped, candidates };
    });

    return armorSnapshotCapabilityOutputSchema.parse({
      serverProfileId: this.serverProfileId,
      slots,
    });
  }

  /**
   * Equip one named armor piece the bot already holds into one slot. Write
   * primitive with a hard guard: it refuses any item that is not a real armor
   * piece for the requested slot, and refuses one the bot does not actually own.
   */
  private async invokeArmorEquip(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = armorEquipCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);

    const { slot, itemName } = input.data;
    if (ARMOR_ITEM_SLOT[itemName] !== slot) {
      throw new SkillFault("ARMOR_ITEM_SLOT_MISMATCH");
    }
    const destination = ARMOR_SLOT_DESTINATIONS.find(
      (entry) => entry.slot === slot,
    )?.destination;
    if (!destination) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    const item = this.bot.inventory
      .items()
      .find((candidate) => candidate.name === itemName);
    if (!item) {
      throw new SkillFault("ARMOR_ITEM_NOT_IN_INVENTORY");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    try {
      await this.bot.equip(item, destination);
    } catch {
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      throw new SkillFault("ARMOR_EQUIP_FAILED");
    }

    let equipped = false;
    try {
      const equipmentSlot = this.bot.getEquipmentDestSlot(destination);
      equipped = this.bot.inventory.slots[equipmentSlot]?.name === itemName;
    } catch {
      equipped = false;
    }

    return armorEquipCapabilityOutputSchema.parse({
      equipped,
      slot,
      itemName,
    });
  }

  /** 背包内某物品的总数（读回用，遥测不允许估算）。 */
  private countInventoryItem(itemName: string): number {
    return this.bot.inventory
      .items()
      .filter((item) => item.name === itemName)
      .reduce((total, item) => total + item.count, 0);
  }

  /** 背包全部物品总数（采集遥测用总量增量，不假设方块→掉落物映射）。 */
  private countInventoryTotal(): number {
    return this.bot.inventory
      .items()
      .reduce((total, item) => total + item.count, 0);
  }

  private async waitForCollectedInventorySync(
    inventoryBefore: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.countInventoryTotal() > inventoryBefore || signal.aborted) return;

    const inventory = this.bot.inventory;
    if (
      typeof inventory.on !== "function" ||
      typeof inventory.off !== "function"
    ) {
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        inventory.off("updateSlot", onUpdate);
        signal.removeEventListener("abort", finish);
        resolve();
      };
      const onUpdate = () => {
        if (this.countInventoryTotal() > inventoryBefore) finish();
      };

      inventory.on("updateSlot", onUpdate);
      signal.addEventListener("abort", finish, { once: true });
      timeout = setTimeout(finish, COLLECT_INVENTORY_SYNC_TIMEOUT_MS);
      // Close the listener-registration race if the slot packet arrived just
      // after the initial check but before updateSlot was bound.
      onUpdate();
    });
  }

  /**
   * Mineflayer's dig promise resolves on a client-side prediction. Wrap it for
   * collectblock so the plugin only advances after a server block-change packet
   * confirms that the target became air. A bounded retry handles a finish packet
   * that arrived just after the server tick boundary; timeout remains fail-closed.
   */
  private installServerConfirmedDigging(signal: AbortSignal): () => void {
    const botWithWire = this.bot as Bot & {
      _client?: MineflayerWireClient;
    };
    const wire = botWithWire._client;
    if (
      !wire ||
      typeof wire.on !== "function" ||
      (typeof wire.off !== "function" && typeof wire.removeListener !== "function")
    ) {
      // Unit doubles and pre-login clients do not expose the wire. The real
      // Mineflayer client always does; preserving the original method here keeps
      // lifecycle tests focused on their own contract.
      return () => {};
    }

    const mutableBot = this.bot as Bot & { dig: Bot["dig"] };
    const originalDig = mutableBot.dig;
    const callOriginalDig = originalDig.bind(this.bot);
    const remove = (
      event: string,
      listener: (packet: unknown) => void,
    ): void => {
      if (typeof wire.off === "function") wire.off(event, listener);
      else wire.removeListener?.(event, listener);
    };

    const waitForServerAir = (position: BlockPosition) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let resolvePromise: (confirmed: boolean) => void = () => {};
      const targetKey = blockPositionKey(position);
      const finish = (confirmed: boolean) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimeout(timeout);
        remove("block_change", onBlockChange);
        remove("multi_block_change", onMultiBlockChange);
        signal.removeEventListener("abort", onAbort);
        resolvePromise(confirmed);
      };
      const accept = (update: AuthoritativeBlockUpdate) => {
        if (blockPositionKey(update.position) !== targetKey) return;
        // Any authoritative non-air state is a rejection/correction for this
        // dig attempt; let the bounded retry resend the finish packet.
        finish(update.stateId === 0);
      };
      const onBlockChange = (packet: unknown) => {
        const update = parseBlockChangePacket(packet);
        if (update) accept(update);
      };
      const onMultiBlockChange = (packet: unknown) => {
        for (const update of parseMultiBlockChangePackets(packet)) accept(update);
      };
      const onAbort = () => finish(false);
      const promise = new Promise<boolean>((resolve) => {
        resolvePromise = resolve;
        wire.on?.("block_change", onBlockChange);
        wire.on?.("multi_block_change", onMultiBlockChange);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      return {
        promise,
        armTimeout: () => {
          if (!settled && timeout === null) {
            timeout = setTimeout(
              () => finish(false),
              COLLECT_SERVER_CONFIRM_TIMEOUT_MS,
            );
          }
        },
        cancel: () => finish(false),
      };
    };

    const wrappedDig = (async (...args: Parameters<Bot["dig"]>) => {
      const block = args[0];
      for (let attempt = 0; attempt <= COLLECT_SERVER_DIG_RETRIES; attempt += 1) {
        if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const confirmation = waitForServerAir(block.position);
        try {
          await callOriginalDig(...args);
          confirmation.armTimeout();
          if (await confirmation.promise) return;
        } finally {
          confirmation.cancel();
        }
      }
      throw new Error("Server did not confirm collected block break.");
    }) as Bot["dig"];

    mutableBot.dig = wrappedDig;
    return () => {
      if (mutableBot.dig === wrappedDig) mutableBot.dig = originalDig;
    };
  }

  private assertDimensionMatch(requestedDimension: string): void {
    const current = normalizeDimension(String(this.bot.game.dimension));
    if (requestedDimension !== current) {
      throw new SkillFault("TARGET_DIMENSION_MISMATCH");
    }
  }

  /**
   * 采集方块：包装 MIT 的 mineflayer-collectblock。查找由本层做（名称→
   * 方块 id 强校验），采集循环交给插件，L0/取消随时可停。
   */
  private async invokeCollectBlocks(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = collectBlockCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    if (!this.bot.collectBlock) {
      throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    }
    if (this.activePathInvocationId !== null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
    }

    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id: number } | undefined>;
    };
    const blockType = registry.blocksByName?.[input.data.blockName];
    if (!blockType) {
      throw new SkillFault("BLOCK_NAME_UNKNOWN");
    }

    const targetPositions = this.bot.findBlocks({
      matching: blockType.id,
      maxDistance: input.data.maxDistance,
      count: input.data.maxCount,
    });
    const targets = targetPositions
      .map((position) => this.bot.blockAt(position))
      .filter((block): block is NonNullable<typeof block> => block !== null);
    if (targets.length === 0) {
      return collectBlockCapabilityOutputSchema.parse({
        blockName: input.data.blockName,
        targetsFound: 0,
        itemsCollected: 0,
      });
    }

    // 采集途中不允许插件把物品倒进任何箱子——入库是 container.transfer
    // 的职责，且必须显式授权。
    this.bot.collectBlock.chestLocations = [];
    const movements = configureSafePathfinderMovements(new Movements(this.bot));
    const targetBlockKeys = new Set(
      targets.map(
        ({ position, type }) =>
          `${type}:${position.x},${position.y},${position.z}`,
      ),
    );
    // 只放行本次已选定的目标坐标。不能直接清空排除区，否则
    // collectblock 使用 Pathfinder 接近目标时也可以随意挖路。
    movements.canDig = true;
    movements.exclusionAreasBreak = [({ position, type }) =>
      targetBlockKeys.has(`${type}:${position.x},${position.y},${position.z}`)
        ? 0
        : 100
    ];
    this.bot.collectBlock.movements = movements;

    const inventoryBefore = this.countInventoryTotal();
    this.activePathInvocationId = request.invocationId;
    const restoreServerConfirmedDigging =
      this.installServerConfirmedDigging(request.signal);
    const stopOnAbort = () => {
      void this.bot.collectBlock.cancelTask().catch(() => {});
      this.stopPathfinder();
    };
    request.signal.addEventListener("abort", stopOnAbort, { once: true });
    try {
      if (request.signal.aborted) {
        stopOnAbort();
        throw new SkillFault("SKILL_CANCELLED");
      }
      await this.bot.collectBlock.collect(targets, { ignoreNoPath: false });
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      throw new SkillFault("COLLECT_BLOCKS_FAILED");
    } finally {
      request.signal.removeEventListener("abort", stopOnAbort);
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
      restoreServerConfirmedDigging();
    }

    // collectblock resolves when the dropped entity disappears. Mineflayer can
    // receive that packet before the corresponding inventory slot update.
    await this.waitForCollectedInventorySync(inventoryBefore, request.signal);

    const itemsCollected = Math.max(
      0,
      this.countInventoryTotal() - inventoryBefore,
    );
    return collectBlockCapabilityOutputSchema.parse({
      blockName: input.data.blockName,
      targetsFound: targets.length,
      itemsCollected,
    });
  }

  /**
   * 合成：mineflayer 原生 recipesFor + craft。craftedCount 是合成后背包
   * 读回的实际增量，不是配方理论产量。
   */
  private async invokeCraftItem(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = craftItemCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id: number } | undefined>;
    };
    const itemType = registry.itemsByName?.[input.data.itemName];
    if (!itemType) {
      throw new SkillFault("ITEM_NAME_UNKNOWN");
    }

    let craftingTable = null;
    if (input.data.craftingTable) {
      const { x, y, z } = input.data.craftingTable;
      craftingTable = this.bot.blockAt(new Vec3(x, y, z));
      if (!craftingTable || craftingTable.name !== "crafting_table") {
        throw new SkillFault("CRAFTING_TABLE_NOT_FOUND");
      }
    }

    const recipes = this.bot.recipesFor(
      itemType.id,
      null,
      1,
      craftingTable ?? false,
    );
    const recipe = recipes[0];
    if (!recipe) {
      // 区分"没配方"与"材料不够"由上层结合库存判断；这里如实报不可合成。
      throw new SkillFault("RECIPE_UNAVAILABLE");
    }

    const before = this.countInventoryItem(input.data.itemName);
    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    try {
      await this.bot.craft(
        recipe,
        input.data.count,
        craftingTable ?? undefined,
      );
    } catch {
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // craft 抛错时也读回增量——部分成功要如实上报而不是丢弃。
      const partial = Math.max(
        0,
        this.countInventoryItem(input.data.itemName) - before,
      );
      if (partial > 0) {
        return craftItemCapabilityOutputSchema.parse({
          itemName: input.data.itemName,
          requestedCount: input.data.count,
          craftedCount: partial,
          usedCraftingTable: craftingTable !== null,
        });
      }
      throw new SkillFault("CRAFT_FAILED");
    }

    const craftedCount = Math.max(
      0,
      this.countInventoryItem(input.data.itemName) - before,
    );
    return craftItemCapabilityOutputSchema.parse({
      itemName: input.data.itemName,
      requestedCount: input.data.count,
      craftedCount,
      usedCraftingTable: craftingTable !== null,
    });
  }

  /** 熔炼：只使用空熔炉，显式装入原料和燃料，逐次取出并读回真实产物。 */
  private async invokeSmeltItem(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = smeltItemCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id: number } | undefined>;
    };
    const inputType = registry.itemsByName?.[input.data.inputItemName];
    const fuelType = registry.itemsByName?.[input.data.fuelItemName];
    if (!inputType || !fuelType) throw new SkillFault("ITEM_NAME_UNKNOWN");
    if (this.countInventoryItem(input.data.inputItemName) < input.data.count) {
      throw new SkillFault("SMELT_INPUT_INSUFFICIENT");
    }
    if (this.countInventoryItem(input.data.fuelItemName) < input.data.fuelCount) {
      throw new SkillFault("SMELT_FUEL_INSUFFICIENT");
    }

    const { x, y, z } = input.data.furnace;
    const block = this.bot.blockAt(new Vec3(x, y, z));
    if (!block || !["furnace", "blast_furnace", "smoker"].includes(block.name)) {
      throw new SkillFault("FURNACE_NOT_FOUND");
    }

    let furnace: Awaited<ReturnType<Bot["openFurnace"]>> | null = null;
    let outputItemName: string | null = null;
    let smeltedCount = 0;
    try {
      furnace = await this.bot.openFurnace(block);
      if (furnace.inputItem() || furnace.fuelItem() || furnace.outputItem()) {
        throw new SkillFault("FURNACE_NOT_EMPTY");
      }
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await furnace.putInput(inputType.id, null, input.data.count);
      await furnace.putFuel(fuelType.id, null, input.data.fuelCount);

      while (smeltedCount < input.data.count) {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const output = furnace.outputItem();
        if (output) {
          outputItemName ??= output.name;
          if (output.name !== outputItemName) throw new SkillFault("FURNACE_OUTPUT_MISMATCH");
          const taken = await furnace.takeOutput();
          smeltedCount += taken.count;
          continue;
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(finish, 250);
          const onAbort = () => finish(new SkillFault("SKILL_CANCELLED"));
          const onUpdate = () => finish();
          function finish(error?: Error) {
            clearTimeout(timer);
            furnace?.removeListener("update", onUpdate);
            request.signal.removeEventListener("abort", onAbort);
            error ? reject(error) : resolve();
          }
          furnace?.once("update", onUpdate);
          request.signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("SMELT_FAILED");
    } finally {
      try { furnace?.close(); } catch { /* closing never fabricates success */ }
    }
    if (!outputItemName || smeltedCount < 1) throw new SkillFault("SMELT_OUTPUT_NOT_CONFIRMED");
    return smeltItemCapabilityOutputSchema.parse({
      inputItemName: input.data.inputItemName,
      fuelItemName: input.data.fuelItemName,
      outputItemName,
      requestedCount: input.data.count,
      insertedFuelCount: input.data.fuelCount,
      smeltedCount,
    });
  }

  /** 放置方块：原生 placeBlock，放置后读回目标位校验，不伪造成功。 */
  private async invokePlaceBlock(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = placeBlockCapabilityInputSchema.safeParse(request.input);
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const { referenceBlock, face } = input.data;
    const reference = this.bot.blockAt(
      new Vec3(referenceBlock.x, referenceBlock.y, referenceBlock.z),
    );
    if (!reference || reference.name === "air") {
      throw new SkillFault("REFERENCE_BLOCK_NOT_FOUND");
    }
    const targetPosition = new Vec3(
      referenceBlock.x + face.x,
      referenceBlock.y + face.y,
      referenceBlock.z + face.z,
    );
    const occupant = this.bot.blockAt(targetPosition);
    if (occupant && occupant.boundingBox !== "empty") {
      throw new SkillFault("PLACE_TARGET_OCCUPIED");
    }

    const item = this.bot.inventory
      .items()
      .find((candidate) => candidate.name === input.data.itemName);
    if (!item) {
      throw new SkillFault("ITEM_NOT_IN_INVENTORY");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    try {
      await this.bot.equip(item, "hand");
      await this.bot.placeBlock(reference, new Vec3(face.x, face.y, face.z));
    } catch {
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      throw new SkillFault("PLACE_BLOCK_FAILED");
    }

    const placedBlock = this.bot.blockAt(targetPosition);
    if (!placedBlock || placedBlock.boundingBox === "empty") {
      throw new SkillFault("PLACE_NOT_CONFIRMED");
    }
    return placeBlockCapabilityOutputSchema.parse({
      placed: true,
      placedBlockName: placedBlock.name,
      position: {
        x: targetPosition.x,
        y: targetPosition.y,
        z: targetPosition.z,
      },
    });
  }

  /**
   * 箱子存取：openContainer + deposit/withdraw。movedCount 是操作前后背包
   * 该物品数量差（读回），少于请求量如实上报。
   */
  private async invokeContainerTransfer(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = containerTransferCapabilityInputSchema.safeParse(
      request.input,
    );
    if (!input.success) {
      throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    }
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const registry = this.bot.registry as unknown as {
      itemsByName?: Record<string, { id: number } | undefined>;
    };
    const itemType = registry.itemsByName?.[input.data.itemName];
    if (!itemType) {
      throw new SkillFault("ITEM_NAME_UNKNOWN");
    }

    const { container } = input.data;
    const containerBlock = this.bot.blockAt(
      new Vec3(container.x, container.y, container.z),
    );
    if (!containerBlock || !CONTAINER_BLOCK_NAMES.has(containerBlock.name)) {
      throw new SkillFault("CONTAINER_NOT_FOUND");
    }

    if (request.signal.aborted) {
      throw new SkillFault("SKILL_CANCELLED");
    }
    let before: number | null = null;
    let window: Awaited<ReturnType<Bot["openContainer"]>> | null = null;
    try {
      window = await this.bot.openContainer(containerBlock);
      // Opening the window synchronizes pending inventory slot updates from
      // earlier actions. Use that acknowledged state as the transfer baseline.
      before = this.countInventoryItem(input.data.itemName);
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      if (input.data.direction === "deposit") {
        await window.deposit(itemType.id, null, input.data.count);
      } else {
        await window.withdraw(itemType.id, null, input.data.count);
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) {
        throw new SkillFault("SKILL_CANCELLED");
      }
      // deposit/withdraw 在数量不足时抛错——读回增量如实上报部分成功。
      const partial = before === null
        ? 0
        : this.transferredItemCount(
            input.data.direction,
            before,
            this.countInventoryItem(input.data.itemName),
          );
      if (partial > 0) {
        return containerTransferCapabilityOutputSchema.parse({
          direction: input.data.direction,
          itemName: input.data.itemName,
          requestedCount: input.data.count,
          movedCount: partial,
        });
      }
      throw new SkillFault("CONTAINER_TRANSFER_FAILED");
    } finally {
      try {
        window?.close();
      } catch {
        // 关窗失败不掩盖真实结果。
      }
    }

    const movedCount = this.transferredItemCount(
      input.data.direction,
      before ?? this.countInventoryItem(input.data.itemName),
      this.countInventoryItem(input.data.itemName),
    );
    return containerTransferCapabilityOutputSchema.parse({
      direction: input.data.direction,
      itemName: input.data.itemName,
      requestedCount: input.data.count,
      movedCount,
    });
  }

  private transferredItemCount(
    direction: "deposit" | "withdraw",
    before: number,
    after: number,
  ): number {
    return direction === "deposit"
      ? Math.max(0, before - after)
      : Math.max(0, after - before);
  }

  versionCompatibility() {
    const protocolVersion = Number(this.bot.protocolVersion);
    return resolvedVersionCompatibility(
      this.configuredVersion,
      this.bot.version,
      protocolVersion,
      this.bot.majorVersion,
    );
  }

  skillCompatibilityEnvironment(): SkillCompatibilityEnvironment {
    const registry = this.bot.registry as unknown as {
      supportFeature?: (name: string) => boolean;
      itemsByName?: Record<string, unknown>;
      blocksByName?: Record<string, unknown>;
      entitiesByName?: Record<string, unknown>;
    };
    const resources: Readonly<
      Record<SkillResourceKind, Record<string, unknown> | undefined>
    > = {
      item: registry.itemsByName,
      block: registry.blocksByName,
      entity: registry.entitiesByName,
    };
    const protocolVersion = Number(this.bot.protocolVersion);
    if (
      typeof this.bot.version !== "string" ||
      !Number.isSafeInteger(protocolVersion)
    ) {
      throw new Error("Mineflayer compatibility facts are unavailable.");
    }
    return Object.freeze({
      minecraftVersion: this.bot.version,
      protocolVersion,
      supportsFeature: (name: string): boolean | undefined => {
        if (typeof registry.supportFeature !== "function") return undefined;
        try {
          const supported = registry.supportFeature(name);
          return typeof supported === "boolean" ? supported : undefined;
        } catch {
          return undefined;
        }
      },
      hasResource: (
        kind: SkillResourceKind,
        name: string,
      ): boolean | undefined => {
        const index = resources[kind];
        return index ? index[name] !== undefined : undefined;
      },
      // Server-side plugins and rules can disable mechanics that exist in the
      // negotiated protocol. Those facts stay unknown until an explicit,
      // approved probe records them; version alone must not fabricate support.
      serverCapability: (): undefined => undefined,
    });
  }

  async close(gracePeriodMs: number): Promise<void> {
    if (this.requestedStop) return;
    this.requestedStop = true;
    this.stopPathfinder();
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

  private stopPathfinder(): void {
    try {
      this.bot.pathfinder?.stop();
    } catch {
      // Stopping movement is best-effort; callers still clear Mineflayer controls.
    }
  }
}

export function createMineflayerClient(profile: ServerProfile): BotClient {
  const bot = createBot(createMineflayerOptions(profile));
  bot.loadPlugin(pathfinder);
  // collectblock 会自动加载它依赖的 mineflayer-tool（两者均 MIT，供应链已锁定）。
  bot.loadPlugin(collectBlockPlugin);
  return new MineflayerBotClient(
    bot,
    profile.minecraftVersion,
    profile.id,
    profile.combat?.enabled === true,
  );
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

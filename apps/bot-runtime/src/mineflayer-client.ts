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
  collectDropsCapabilityInputSchema,
  collectDropsCapabilityOutputSchema,
  combatPveMeleeCapabilityInputSchema,
  combatPveMeleeCapabilityOutputSchema,
  combatPvpMeleeCapabilityInputSchema,
  combatPvpMeleeCapabilityOutputSchema,
  consumeFoodCapabilityInputSchema,
  consumeFoodCapabilityOutputSchema,
  containerTransferCapabilityInputSchema,
  containerTransferCapabilityOutputSchema,
  craftItemCapabilityInputSchema,
  craftItemCapabilityOutputSchema,
  farmCropCapabilityInputSchema,
  farmCropCapabilityOutputSchema,
  fishOnceCapabilityInputSchema,
  fishOnceCapabilityOutputSchema,
  inventoryCompactCapabilityInputSchema,
  inventoryCompactCapabilityOutputSchema,
  movementRecoverCapabilityInputSchema,
  movementRecoverCapabilityOutputSchema,
  placeBlockCapabilityInputSchema,
  placeBlockCapabilityOutputSchema,
  sleepCapabilityInputSchema,
  sleepCapabilityOutputSchema,
  smeltItemCapabilityInputSchema,
  smeltItemCapabilityOutputSchema,
  storageAccountCapabilityInputSchema,
  storageAccountCapabilityOutputSchema,
  SAFE_PATH_MAX_DISTANCE,
  SkillFault,
  safeMovementGotoCapabilityInputSchema,
  safeMovementGotoCapabilityOutputSchema,
  type SkillCapabilityRequest,
  type SkillCompatibilityEnvironment,
  type SkillResourceKind,
} from "@minecraft-studio/skills";

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

const MELEE_WEAPON_SCORE: Readonly<Record<string, number>> = {
  wooden_sword: 10,
  golden_sword: 11,
  stone_sword: 20,
  wooden_axe: 21,
  golden_axe: 22,
  iron_sword: 30,
  stone_axe: 31,
  iron_axe: 40,
  diamond_sword: 50,
  diamond_axe: 51,
  netherite_sword: 60,
  netherite_axe: 61,
  trident: 62,
  mace: 63,
};

const CROP_RULES: Readonly<
  Record<
    "wheat" | "carrots" | "potatoes" | "beetroots" | "nether_wart",
    Readonly<{ matureMetadata: number; seedItemName: string; soilName: string }>
  >
> = {
  wheat: { matureMetadata: 7, seedItemName: "wheat_seeds", soilName: "farmland" },
  carrots: { matureMetadata: 7, seedItemName: "carrot", soilName: "farmland" },
  potatoes: { matureMetadata: 7, seedItemName: "potato", soilName: "farmland" },
  beetroots: { matureMetadata: 3, seedItemName: "beetroot_seeds", soilName: "farmland" },
  nether_wart: { matureMetadata: 3, seedItemName: "nether_wart", soilName: "soul_sand" },
};

type CombatEntity = NonNullable<ReturnType<Bot["nearestEntity"]>>;

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
  private readonly allowedPvpTargets: ReadonlySet<string>;

  constructor(
    private readonly bot: Bot,
    private readonly configuredVersion: ServerProfile["minecraftVersion"],
    private readonly serverProfileId: string | null = null,
    allowedPvpTargets: readonly string[] = [],
  ) {
    this.allowedPvpTargets = new Set(
      allowedPvpTargets.map((target) => target.toLowerCase()),
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
    }
    if (
      request.capability === "inventory.write" &&
      request.operation === "food.consume-best-safe"
    ) {
      return this.invokeConsumeFood(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "bed.sleep-safe"
    ) {
      return this.invokeSleep(request);
    }
    if (
      request.capability === "inventory.write" &&
      request.operation === "inventory.compact-safe"
    ) {
      return this.invokeInventoryCompact(request);
    }
    if (
      request.capability === "bot.move" &&
      request.operation === "movement.recover-bounded"
    ) {
      return this.invokeMovementRecover(request);
    }
    if (
      request.capability === "combat.execute" &&
      request.operation === "combat.pve-melee-safe"
    ) {
      return this.invokePveMelee(request);
    }
    if (
      request.capability === "combat.execute" &&
      request.operation === "combat.pvp-melee-allowlisted"
    ) {
      return this.invokePvpMelee(request);
    }
    if (
      request.capability === "container.read" &&
      request.operation === "container.account-safe"
    ) {
      return this.invokeStorageAccount(request);
    }
    if (
      request.capability === "bot.move" &&
      request.operation === "collect.drops-safe"
    ) {
      return this.invokeCollectDrops(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "farm.crop-replant-safe"
    ) {
      return this.invokeFarmCrop(request);
    }
    if (
      request.capability === "world.interact" &&
      request.operation === "fishing.cast-once-safe"
    ) {
      return this.invokeFishOnce(request);
    }
    throw new SkillFault("SKILL_CAPABILITY_UNSUPPORTED");
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
    // 采集必须能挖目标方块本身。
    movements.canDig = true;
    this.bot.collectBlock.movements = movements;

    const inventoryBefore = this.countInventoryTotal();
    this.activePathInvocationId = request.invocationId;
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
    }

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
    const before = this.countInventoryItem(input.data.itemName);
    let window: Awaited<ReturnType<Bot["openContainer"]>> | null = null;
    try {
      window = await this.bot.openContainer(containerBlock);
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
      const partial = Math.abs(
        this.countInventoryItem(input.data.itemName) - before,
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

    const movedCount = Math.abs(
      this.countInventoryItem(input.data.itemName) - before,
    );
    return containerTransferCapabilityOutputSchema.parse({
      direction: input.data.direction,
      itemName: input.data.itemName,
      requestedCount: input.data.count,
      movedCount,
    });
  }

  /** Consume only the highest-ranked item from the immutable safe-food list. */
  private async invokeConsumeFood(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = consumeFoodCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);

    const foodLevelBefore = this.bot.food;
    if (!Number.isInteger(foodLevelBefore) || foodLevelBefore < 0 || foodLevelBefore > 20) {
      throw new SkillFault("FOOD_LEVEL_UNAVAILABLE");
    }
    if (foodLevelBefore > input.data.maximumFoodLevel) {
      return consumeFoodCapabilityOutputSchema.parse({
        consumed: false,
        itemName: null,
        foodLevelBefore,
        foodLevelAfter: foodLevelBefore,
      });
    }

    const food = this.safeFoodItems()[0];
    if (!food) throw new SkillFault("NO_SAFE_FOOD");
    const itemName = food.item.name;
    const countBefore = this.countInventoryItem(itemName);
    if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    try {
      this.bot.clearControlStates();
      await this.bot.equip(food.item, "hand");
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await this.bot.consume();
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("FOOD_CONSUME_FAILED");
    }

    const foodLevelAfter = this.bot.food;
    const countAfter = this.countInventoryItem(itemName);
    if (
      !Number.isInteger(foodLevelAfter) ||
      foodLevelAfter < 0 ||
      foodLevelAfter > 20 ||
      (foodLevelAfter <= foodLevelBefore && countAfter >= countBefore)
    ) {
      throw new SkillFault("FOOD_CONSUMPTION_NOT_CONFIRMED");
    }
    return consumeFoodCapabilityOutputSchema.parse({
      consumed: true,
      itemName,
      foodLevelBefore,
      foodLevelAfter,
    });
  }

  /** Sleep in one explicitly authorized, nearby bed and verify client state. */
  private async invokeSleep(request: SkillCapabilityRequest): Promise<unknown> {
    const input = sleepCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const bed = this.bot.blockAt(
      new Vec3(input.data.bed.x, input.data.bed.y, input.data.bed.z),
    );
    if (!bed || !bed.name.endsWith("_bed")) {
      throw new SkillFault("BED_NOT_FOUND");
    }
    if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    try {
      await this.bot.sleep(bed);
    } catch {
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("SLEEP_FAILED");
    }
    if (!this.bot.isSleeping) throw new SkillFault("SLEEP_NOT_CONFIRMED");
    return sleepCapabilityOutputSchema.parse({
      sleeping: true,
      bed: input.data.bed,
    });
  }

  /**
   * Fill earlier empty inventory slots from the tail. Destinations are always
   * empty, so the operation never swaps, merges, drops, or touches equipment.
   */
  private async invokeInventoryCompact(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = inventoryCompactCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    if (this.bot.currentWindow !== null) {
      throw new SkillFault("INVENTORY_WINDOW_OPEN");
    }

    const start = this.bot.inventory.inventoryStart;
    const end = this.bot.inventory.inventoryEnd;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start || end - start > 36) {
      throw new SkillFault("INVENTORY_RANGE_UNAVAILABLE");
    }
    const inventoryStats = () => {
      const slots = this.bot.inventory.slots.slice(start, end);
      return {
        occupied: slots.filter((item) => item !== null).length,
        total: slots.reduce((sum, item) => sum + (item?.count ?? 0), 0),
      };
    };
    const before = inventoryStats();
    let movedStacks = 0;

    for (let destination = start; destination < end; destination += 1) {
      if (movedStacks >= input.data.maxMoves) break;
      if (this.bot.inventory.slots[destination] !== null) continue;
      let source = end - 1;
      while (
        source > destination &&
        this.bot.inventory.slots[source] === null
      ) {
        source -= 1;
      }
      if (source <= destination) break;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      try {
        await this.bot.moveSlotItem(source, destination);
      } catch {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        throw new SkillFault("INVENTORY_COMPACT_FAILED");
      }
      if (
        this.bot.inventory.slots[destination] === null ||
        this.bot.inventory.slots[source] !== null
      ) {
        throw new SkillFault("INVENTORY_MOVE_NOT_CONFIRMED");
      }
      movedStacks += 1;
    }

    const after = inventoryStats();
    if (after.occupied !== before.occupied || after.total !== before.total) {
      throw new SkillFault("INVENTORY_PRESERVATION_FAILED");
    }
    return inventoryCompactCapabilityOutputSchema.parse({
      movedStacks,
      occupiedSlotsBefore: before.occupied,
      occupiedSlotsAfter: after.occupied,
      totalItemsBefore: before.total,
      totalItemsAfter: after.total,
      preserved: true,
    });
  }

  /** Try a small fixed sequence of non-destructive movements and read back displacement. */
  private async invokeMovementRecover(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = movementRecoverCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    if (this.activePathInvocationId !== null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
    }

    const start = this.bot.entity.position.clone();
    const patterns = [
      ["jump", "back"],
      ["jump", "forward"],
      ["left", "jump"],
    ] as const;
    let attempts = 0;
    let distanceMoved = 0;
    this.activePathInvocationId = request.invocationId;
    this.stopPathfinder();
    try {
      for (const controls of patterns.slice(0, input.data.maxAttempts)) {
        attempts += 1;
        await this.applyBoundedSkillControls(550, controls, request.signal);
        distanceMoved = this.bot.entity.position.distanceTo(start);
        if (distanceMoved >= 0.35) break;
      }
    } finally {
      this.bot.clearControlStates();
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
    }

    const final = this.bot.entity.position;
    return movementRecoverCapabilityOutputSchema.parse({
      recovered: distanceMoved >= 0.35,
      attempts,
      distanceMoved,
      finalPosition: {
        x: final.x,
        y: final.y,
        z: final.z,
        dimension: normalizeDimension(String(this.bot.game.dimension)),
        serverProfileId: this.serverProfileId,
      },
    });
  }

  private async invokePveMelee(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = combatPveMeleeCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const permitted = new Set<string>(input.data.targetTypes);
    const target = this.nearestCombatEntity(
      (entity) => typeof entity.name === "string" && permitted.has(entity.name),
      input.data.maxDistance,
    );
    const output = await this.performBoundedMelee(request, target, {
      maxDistance: input.data.maxDistance,
      maxAttackAttempts: input.data.maxAttackAttempts,
      retreatHealth: input.data.retreatHealth,
    });
    return combatPveMeleeCapabilityOutputSchema.parse(output);
  }

  private async invokePvpMelee(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = combatPvpMeleeCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const targetName = input.data.targetUsername.toLowerCase();
    if (!this.allowedPvpTargets.has(targetName)) {
      throw new SkillFault("PVP_TARGET_NOT_ALLOWLISTED");
    }
    const target = this.nearestCombatEntity(
      (entity) =>
        entity.type === "player" &&
        typeof entity.username === "string" &&
        entity.username.toLowerCase() === targetName &&
        entity.username.toLowerCase() !== this.bot.username.toLowerCase(),
      input.data.maxDistance,
    );
    const output = await this.performBoundedMelee(request, target, {
      maxDistance: input.data.maxDistance,
      maxAttackAttempts: input.data.maxAttackAttempts,
      retreatHealth: input.data.retreatHealth,
    });
    return combatPvpMeleeCapabilityOutputSchema.parse(output);
  }

  private nearestCombatEntity(
    predicate: (entity: CombatEntity) => boolean,
    maxDistance: number,
  ): CombatEntity | null {
    return Object.values(this.bot.entities)
      .filter((entity): entity is CombatEntity => {
        if (!entity || entity.id === this.bot.entity.id || !predicate(entity)) {
          return false;
        }
        const distance = entity.position.distanceTo(this.bot.entity.position);
        return Number.isFinite(distance) && distance <= maxDistance;
      })
      .sort((left, right) =>
        left.position.distanceTo(this.bot.entity.position) -
          right.position.distanceTo(this.bot.entity.position) ||
        left.id - right.id
      )[0] ?? null;
  }

  private bestMeleeWeapon() {
    return this.bot.inventory
      .items()
      .filter((item) => MELEE_WEAPON_SCORE[item.name] !== undefined)
      .sort((left, right) =>
        (MELEE_WEAPON_SCORE[right.name] ?? 0) -
          (MELEE_WEAPON_SCORE[left.name] ?? 0) ||
        left.name.localeCompare(right.name)
      )[0] ?? null;
  }

  private async performBoundedMelee(
    request: SkillCapabilityRequest,
    target: CombatEntity | null,
    limits: Readonly<{
      maxDistance: number;
      maxAttackAttempts: number;
      retreatHealth: number;
    }>,
  ): Promise<unknown> {
    if (!target) {
      return {
        targetFound: false,
        targetName: null,
        targetEntityId: null,
        weaponName: null,
        attackAttempts: 0,
        targetStillTracked: false,
        retreated: false,
        finalDistance: null,
      };
    }
    if (this.activePathInvocationId !== null) {
      throw new SkillFault("BOT_MOVEMENT_BUSY");
    }
    if (!Number.isFinite(this.bot.health)) {
      throw new SkillFault("COMBAT_HEALTH_UNAVAILABLE");
    }

    const targetName = target.type === "player"
      ? target.username ?? "player"
      : target.name ?? "unknown";
    const weapon = this.bestMeleeWeapon();
    let attackAttempts = 0;
    let retreated = false;
    this.activePathInvocationId = request.invocationId;
    this.stopPathfinder();
    try {
      if (this.bot.health <= limits.retreatHealth) {
        await this.applyBoundedSkillControls(
          650,
          ["back", "sprint"],
          request.signal,
        );
        retreated = true;
      } else {
        if (weapon) {
          try {
            await this.bot.equip(weapon, "hand");
          } catch {
            if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
            throw new SkillFault("COMBAT_WEAPON_EQUIP_FAILED");
          }
        }

        for (let attempt = 0; attempt < limits.maxAttackAttempts; attempt += 1) {
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          if (this.bot.health <= limits.retreatHealth) {
            await this.applyBoundedSkillControls(
              650,
              ["back", "sprint"],
              request.signal,
            );
            retreated = true;
            break;
          }
          const current = this.bot.entities[target.id];
          if (!current || current.isValid === false) break;
          const distance = current.position.distanceTo(this.bot.entity.position);
          if (!Number.isFinite(distance) || distance > limits.maxDistance) break;
          const lookHeight =
            typeof current.height === "number" && Number.isFinite(current.height)
              ? Math.max(0.5, current.height * 0.75)
              : 1;
          try {
            await this.bot.lookAt(current.position.offset(0, lookHeight, 0), true);
            this.bot.attack(current);
            attackAttempts += 1;
          } catch {
            if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
            throw new SkillFault("COMBAT_ATTACK_FAILED");
          }
          await this.waitWithSignal(650, request.signal);
        }
      }
    } finally {
      this.bot.clearControlStates();
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
    }

    const finalTarget = this.bot.entities[target.id];
    const targetStillTracked = Boolean(finalTarget && finalTarget.isValid !== false);
    const finalDistance = targetStillTracked && finalTarget
      ? finalTarget.position.distanceTo(this.bot.entity.position)
      : null;
    return {
      targetFound: true,
      targetName,
      targetEntityId: target.id,
      weaponName: weapon?.name ?? null,
      attackAttempts,
      targetStillTracked,
      retreated,
      finalDistance,
    };
  }

  private async invokeStorageAccount(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = storageAccountCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);

    const { container } = input.data;
    const block = this.bot.blockAt(new Vec3(container.x, container.y, container.z));
    if (!block || !CONTAINER_BLOCK_NAMES.has(block.name)) {
      throw new SkillFault("CONTAINER_NOT_FOUND");
    }
    let window: Awaited<ReturnType<Bot["openContainer"]>> | null = null;
    try {
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      window = await this.bot.openContainer(block);
      const containerItems = window.containerItems();
      const requested = new Set(input.data.itemNames);
      const inventoryCounts = new Map<string, number>();
      const containerCounts = new Map<string, number>();
      for (const item of this.bot.inventory.items()) {
        if (requested.has(item.name)) {
          inventoryCounts.set(
            item.name,
            (inventoryCounts.get(item.name) ?? 0) + item.count,
          );
        }
      }
      for (const item of containerItems) {
        if (requested.has(item.name)) {
          containerCounts.set(
            item.name,
            (containerCounts.get(item.name) ?? 0) + item.count,
          );
        }
      }
      const items = input.data.itemNames.map((itemName) => {
        const inventoryCount = inventoryCounts.get(itemName) ?? 0;
        const containerCount = containerCounts.get(itemName) ?? 0;
        return {
          itemName,
          inventoryCount,
          containerCount,
          totalCount: inventoryCount + containerCount,
        };
      });
      return storageAccountCapabilityOutputSchema.parse({
        containerName: block.name,
        containerUsedSlots: containerItems.length,
        containerTotalSlots: window.inventoryStart,
        items,
      });
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("CONTAINER_ACCOUNT_FAILED");
    } finally {
      try { window?.close(); } catch { /* read result remains independently validated */ }
    }
  }

  private async invokeCollectDrops(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = collectDropsCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    if (!this.bot.pathfinder) throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    if (this.activePathInvocationId !== null) throw new SkillFault("BOT_MOVEMENT_BUSY");

    const permitted = new Set(input.data.itemNames);
    const targets = Object.values(this.bot.entities)
      .map((entity) => {
        try {
          const item = entity.getDroppedItem();
          return item && permitted.has(item.name) ? { entity, itemName: item.name } : null;
        } catch {
          return null;
        }
      })
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null)
      .filter(({ entity }) => entity.position.distanceTo(this.bot.entity.position) <= input.data.maxDistance)
      .sort((left, right) =>
        left.entity.position.distanceTo(this.bot.entity.position) -
          right.entity.position.distanceTo(this.bot.entity.position) ||
        left.entity.id - right.entity.id
      )
      .slice(0, input.data.maxCount);
    if (targets.length === 0) {
      return collectDropsCapabilityOutputSchema.parse({ targetsFound: 0, itemsCollected: 0, items: [] });
    }

    const before = new Map(
      input.data.itemNames.map((name) => [name, this.countInventoryItem(name)]),
    );
    const movements = configureSafePathfinderMovements(new Movements(this.bot));
    this.bot.pathfinder.setMovements(movements);
    this.activePathInvocationId = request.invocationId;
    const onAbort = () => this.stopPathfinder();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (const target of targets) {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        const current = this.bot.entities[target.entity.id];
        if (!current || current.isValid === false) continue;
        try {
          await this.bot.pathfinder.goto(
            new goals.GoalNear(
              current.position.x,
              current.position.y,
              current.position.z,
              1,
            ),
          );
          await this.waitWithSignal(300, request.signal);
        } catch {
          if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
          const collectedSoFar = input.data.itemNames.reduce(
            (sum, name) => sum + Math.max(0, this.countInventoryItem(name) - (before.get(name) ?? 0)),
            0,
          );
          if (collectedSoFar === 0) throw new SkillFault("COLLECT_DROPS_FAILED");
          break;
        }
      }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.stopPathfinder();
      if (this.activePathInvocationId === request.invocationId) {
        this.activePathInvocationId = null;
      }
    }

    const items = input.data.itemNames
      .map((itemName) => ({
        itemName,
        count: Math.max(0, this.countInventoryItem(itemName) - (before.get(itemName) ?? 0)),
      }))
      .filter(({ count }) => count > 0);
    return collectDropsCapabilityOutputSchema.parse({
      targetsFound: targets.length,
      itemsCollected: items.reduce((sum, item) => sum + item.count, 0),
      items,
    });
  }

  private async invokeFarmCrop(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = farmCropCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    if (!this.bot.pathfinder) throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
    if (this.activePathInvocationId !== null) throw new SkillFault("BOT_MOVEMENT_BUSY");

    const rule = CROP_RULES[input.data.cropName];
    const registry = this.bot.registry as unknown as {
      blocksByName?: Record<string, { id: number } | undefined>;
    };
    const cropType = registry.blocksByName?.[input.data.cropName];
    if (!cropType) throw new SkillFault("BLOCK_NAME_UNKNOWN");
    const targets = this.bot.findBlocks({
      matching: cropType.id,
      maxDistance: input.data.maxDistance,
      count: input.data.maxCount,
    }).map((position) => this.bot.blockAt(position))
      .filter((block): block is NonNullable<typeof block> =>
        block !== null &&
        block.name === input.data.cropName &&
        block.metadata >= rule.matureMetadata
      );
    if (targets.length === 0) {
      return farmCropCapabilityOutputSchema.parse({
        cropName: input.data.cropName,
        seedItemName: rule.seedItemName,
        matureTargetsFound: 0,
        harvested: 0,
        replanted: 0,
      });
    }
    if (this.countInventoryItem(rule.seedItemName) < targets.length) {
      throw new SkillFault("FARM_SEEDS_INSUFFICIENT");
    }

    const movements = configureSafePathfinderMovements(new Movements(this.bot));
    this.bot.pathfinder.setMovements(movements);
    let harvested = 0;
    let replanted = 0;
    this.activePathInvocationId = request.invocationId;
    const onAbort = () => this.stopPathfinder();
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (const original of targets) {
        if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
        await this.bot.pathfinder.goto(
          new goals.GoalNear(original.position.x, original.position.y, original.position.z, 3),
        );
        const crop = this.bot.blockAt(original.position);
        if (!crop || crop.name !== input.data.cropName || crop.metadata < rule.matureMetadata) continue;
        const soil = this.bot.blockAt(original.position.offset(0, -1, 0));
        if (!soil || soil.name !== rule.soilName) throw new SkillFault("FARM_SOIL_MISMATCH");
        await this.bot.dig(crop, true);
        harvested += 1;
        const seed = this.bot.inventory.items().find((item) => item.name === rule.seedItemName);
        if (!seed) throw new SkillFault("FARM_SEEDS_INSUFFICIENT");
        await this.bot.equip(seed, "hand");
        await this.bot.placeBlock(soil, new Vec3(0, 1, 0));
        const planted = this.bot.blockAt(original.position);
        if (!planted || planted.name !== input.data.cropName) {
          throw new SkillFault("FARM_REPLANT_NOT_CONFIRMED");
        }
        replanted += 1;
      }
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("FARM_CROP_FAILED");
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      this.stopPathfinder();
      if (this.activePathInvocationId === request.invocationId) this.activePathInvocationId = null;
    }
    return farmCropCapabilityOutputSchema.parse({
      cropName: input.data.cropName,
      seedItemName: rule.seedItemName,
      matureTargetsFound: targets.length,
      harvested,
      replanted,
    });
  }

  private async invokeFishOnce(
    request: SkillCapabilityRequest,
  ): Promise<unknown> {
    const input = fishOnceCapabilityInputSchema.safeParse(request.input);
    if (!input.success) throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
    this.assertServerProfileMatch(input.data.serverProfileId);
    this.assertDimensionMatch(input.data.dimension);
    const rod = this.bot.inventory.items().find((item) => item.name === "fishing_rod");
    if (!rod) throw new SkillFault("FISHING_ROD_NOT_IN_INVENTORY");
    const before = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      before.set(item.name, (before.get(item.name) ?? 0) + item.count);
    }
    const onAbort = () => {
      try { this.bot.activateItem(); } catch { /* best-effort reel-in */ }
    };
    request.signal.addEventListener("abort", onAbort, { once: true });
    try {
      await this.bot.equip(rod, "hand");
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      await this.bot.fish();
      await this.waitWithSignal(500, request.signal);
    } catch (error) {
      if (error instanceof SkillFault) throw error;
      if (request.signal.aborted) throw new SkillFault("SKILL_CANCELLED");
      throw new SkillFault("FISHING_FAILED");
    } finally {
      request.signal.removeEventListener("abort", onAbort);
    }
    const after = new Map<string, number>();
    for (const item of this.bot.inventory.items()) {
      after.set(item.name, (after.get(item.name) ?? 0) + item.count);
    }
    const gains = [...after]
      .map(([itemName, count]) => ({
        itemName,
        count: Math.max(0, count - (before.get(itemName) ?? 0)),
      }))
      .filter(({ count }) => count > 0)
      .sort((left, right) => right.count - left.count || left.itemName.localeCompare(right.itemName));
    const itemsGained = gains.reduce((sum, item) => sum + item.count, 0);
    return fishOnceCapabilityOutputSchema.parse({
      caught: itemsGained > 0,
      itemsGained,
      itemName: gains[0]?.itemName ?? null,
    });
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
      serverCapability: (name: string): boolean | undefined =>
        name === "combat.pvp-enabled"
          ? this.allowedPvpTargets.size > 0
          : undefined,
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

  private async applyBoundedSkillControls(
    durationMs: number,
    controls: readonly ("forward" | "back" | "left" | "right" | "jump" | "sprint")[],
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    this.bot.clearControlStates();
    for (const control of controls) this.bot.setControlState(control, true);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, durationMs);
      const onAbort = () => finish(new SkillFault("SKILL_CANCELLED"));
      function finish(error?: Error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
    this.bot.clearControlStates();
  }

  private async waitWithSignal(
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(finish, durationMs);
      const onAbort = () => finish(new SkillFault("SKILL_CANCELLED"));
      function finish(error?: Error) {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        error ? reject(error) : resolve();
      }
      signal.addEventListener("abort", onAbort, { once: true });
    });
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
    profile.pvp?.allowedTargets ?? [],
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

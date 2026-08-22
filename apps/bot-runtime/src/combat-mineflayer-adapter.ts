import type { Bot } from "mineflayer";

import {
  combatEntityFromMineflayer,
  type MineflayerCombatEntityView,
} from "./combat-entity-adapter.js";
import type { CombatGearSnapshot } from "@minecraft-studio/combat";
import type {
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";

type VecLike = Readonly<{ x: number; y: number; z: number }>;
type ItemLike = Readonly<{
  name?: unknown;
  slot?: unknown;
  count?: unknown;
  durabilityUsed?: unknown;
  maxDurability?: unknown;
}>;
type EntityLike = MineflayerCombatEntityView &
  Readonly<{
    position?: VecLike;
    velocity?: VecLike;
    health?: unknown;
    yaw?: unknown;
    pitch?: unknown;
    onGround?: unknown;
    fallDistance?: unknown;
    equipment?: readonly ItemLike[];
  }>;
type CombatBotLike = Readonly<{
  entity?: EntityLike;
  entities?: Readonly<Record<string, EntityLike>>;
  inventory?: Readonly<{
    items?: () => readonly ItemLike[];
    slots?: readonly (ItemLike | null | undefined)[];
  }>;
  game?: Readonly<{ dimension?: unknown }>;
  registry?: unknown;
  player?: Readonly<{ ping?: unknown }>;
  getEquipmentDestSlot?: (destination: string) => number;
  equip?: (item: unknown, destination: string) => Promise<void>;
  attack?: (entity: unknown) => Promise<void> | void;
  look?: (yaw: number, pitch: number, force?: boolean) => Promise<void>;
  setControlState?: (control: string, state: boolean) => void;
  clearControlStates?: () => void;
  pathfinder?: Readonly<{ stop?: () => void }>;
}>;

type RegistryEntityInfo = Readonly<{
  /** minecraft-data exposes this as `category` on supported versions. */
  category?: unknown;
  type?: unknown;
  metadataKeys?: readonly string[];
}>;

type CombatRegistryLike = Readonly<{
  entitiesByName?: Readonly<Record<string, RegistryEntityInfo | undefined>>;
}>;

const HOSTILE_MOBS = new Set([
  "blaze",
  "bogged",
  "breeze",
  "camel_husk",
  "cave_spider",
  "creeper",
  "creaking",
  "drowned",
  "elder_guardian",
  "ender_dragon",
  "endermite",
  "evoker",
  "ghast",
  "giant",
  "guardian",
  "hoglin",
  "husk",
  "illusioner",
  "magma_cube",
  "phantom",
  "parched",
  "piglin",
  "piglin_brute",
  "pillager",
  "ravager",
  "shulker",
  "silverfish",
  "skeleton",
  "slime",
  "spider",
  "stray",
  "vex",
  "vindicator",
  "warden",
  "witch",
  "wither",
  "wither_skeleton",
  "zoglin",
  "zombie",
  "zombie_villager",
  "zombified_piglin",
  "zombie_nautilus",
]);
// Endermen are deliberately handled as a hostile-kind observation so the
// combat identity layer can inspect `endermanState`: calm/unknown remains
// neutral, while an explicitly angry state is hostile. Leaving them as an
// `unknown` Mineflayer mob would make the state check unreachable.
const ENDERMAN_NAME = "enderman";
const ANIMAL_MOBS = new Set([
  "axolotl",
  "bat",
  "bee",
  "camel",
  "cat",
  "chicken",
  "cod",
  "cow",
  "dolphin",
  "donkey",
  "fox",
  "frog",
  "glow_squid",
  "goat",
  "horse",
  "llama",
  "mooshroom",
  "mule",
  "ocelot",
  "panda",
  "parrot",
  "pig",
  "polar_bear",
  "rabbit",
  "salmon",
  "sheep",
  "squid",
  "tadpole",
  "tropical_fish",
  "turtle",
  "villager",
  "wandering_trader",
  "wolf",
]);
const WEAPON_KINDS = new Map<string, "sword" | "axe" | "trident" | "bow" | "crossbow">([
  ["sword", "sword"],
  ["axe", "axe"],
  ["trident", "trident"],
  ["bow", "bow"],
  ["crossbow", "crossbow"],
]);
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

type ArmorMaterial = "none" | "leather" | "golden" | "chainmail" | "iron" | "diamond" | "netherite";

const ARMOR_MATERIAL_RANK: Readonly<Record<Exclude<ArmorMaterial, "none">, number>> = {
  leather: 0,
  golden: 1,
  chainmail: 2,
  iron: 3,
  diamond: 4,
  netherite: 5,
};

/**
 * Narrow Mineflayer boundary for W0. It intentionally does not enumerate
 * world geometry or combat placements: those observations are unavailable
 * until a versioned, tested adapter exists.
 */
export class MineflayerCombatAdapter {
  private clock: () => number = () => Date.now();
  private movementAbortController: AbortController | null = null;

  constructor(
    private readonly bot: Bot,
    private readonly serverProfileId: string,
    private readonly enabled: boolean,
  ) {}

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  observation(nowMs: number): CombatDriverObservation | null {
    if (!this.enabled || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
    const bot = this.bot as unknown as CombatBotLike;
    const self = bot.entity;
    const position = self?.position;
    if (
      !self ||
      !Number.isSafeInteger(self.id) ||
      self.id < 0 ||
      !position ||
      !finiteVector(position)
    ) return null;
    const dimension = normalizeDimension(bot.game?.dimension);
    if (dimension === null) return null;

    // These values are required by the deterministic driver. Do not turn a
    // pre-spawn/partially populated Mineflayer entity into a fabricated safe
    // snapshot (for example health=0 or onGround=false).
    const health = finiteNumber(self.health) ? Number(self.health) : null;
    const yaw = finiteNumber(self.yaw) ? Number(self.yaw) : null;
    const pitch = finiteNumber(self.pitch) ? Number(self.pitch) : null;
    if (
      health === null ||
      health < 0 ||
      yaw === null ||
      pitch === null ||
      typeof self.onGround !== "boolean"
    ) return null;

    if (
      !bot.inventory ||
      !Array.isArray(bot.inventory.slots) ||
      typeof bot.getEquipmentDestSlot !== "function"
    ) return null;
    const inventoryItems = readInventoryItems(bot);
    if (inventoryItems === null) return null;

    if (!bot.entities || typeof bot.entities !== "object") return null;
    const entities = Object.values(bot.entities)
      .filter((entity) =>
        entity !== null &&
        typeof entity === "object" &&
        entity !== self &&
        entity.id !== self.id &&
        entity.position &&
        finiteVector(entity.position),
      )
      // A malformed entity must not make the whole combat snapshot look valid.
      // Drop only that entity and let the deterministic identity layer decide
      // whether any remaining observations are sufficient to act.
      .map((entity) => {
        try {
          return this.entityObservation(entity, bot.registry);
        } catch {
          return null;
        }
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const offhand = this.equipmentItem(bot, "off-hand");
    const selfGear = this.gearSnapshot(self, inventoryItems, offhand);
    const orientation = {
      yaw: radiansToDegrees(yaw),
      pitch: radiansToDegrees(pitch),
    };
    const latency = numberOr(bot.player?.ping, NaN);
    return {
      observedAtMs: nowMs,
      serverProfileId: this.serverProfileId,
      dimension,
      latencyMs: Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null,
      self: {
        position: { x: position.x, y: position.y, z: position.z },
        health,
        offhandIsTotem: offhand?.name === "totem_of_undying",
        inventoryTotemCount: inventoryItems.filter(
          (item) => item.name === "totem_of_undying",
        ).length,
        gear: selfGear,
        orientation,
        heldItemSlot: this.heldItemSlot(bot),
        onGround: self.onGround === true,
        fallDistance: finiteNumber((self as EntityLike & { fallDistance?: unknown }).fallDistance)
          ? Number((self as EntityLike & { fallDistance?: unknown }).fallDistance)
          : null,
      },
      entities,
      weapons: inventoryItems
        .map((item) => this.weaponCandidate(item))
        .filter((value): value is NonNullable<typeof value> => value !== null),
      crystalCandidates: null,
      mineCandidates: null,
      hazards: null,
    };
  }

  async execute(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ): Promise<CombatActionAcknowledgement> {
    if (!this.enabled) return { outcome: "unavailable", reasonCode: "COMBAT_DRIVER_UNAVAILABLE" };
    if (signal.aborted) return { outcome: "failed", reasonCode: "SKILL_CANCELLED" };
    const bot = this.bot as unknown as CombatBotLike;
    try {
      switch (action.kind) {
        case "DISENGAGE":
          this.movementAbortController?.abort();
          bot.pathfinder?.stop?.();
          bot.clearControlStates?.();
          return { outcome: "executed", executedAtMs: this.clock() };
        case "REEQUIP_TOTEM": {
          const item = (bot.inventory?.items?.() ?? []).find(
            (candidate) => candidate.name === "totem_of_undying",
          );
          if (!item || !bot.equip) return { outcome: "unavailable", reasonCode: "COMBAT_TOTEM_NOT_IN_INVENTORY" };
          await bot.equip(item, "off-hand");
          return { outcome: "executed", executedAtMs: this.clock() };
        }
        case "EQUIP_WEAPON": {
          const item = bot.inventory?.slots?.[action.slot];
          if (!item || !bot.equip) return { outcome: "unavailable", reasonCode: "COMBAT_WEAPON_NOT_IN_INVENTORY" };
          await bot.equip(item, "hand");
          return { outcome: "executed", executedAtMs: this.clock() };
        }
        case "MELEE_ATTACK": {
          const target = Object.values(bot.entities ?? {}).find(
            (entity) => entity.id === action.targetEntityId,
          );
          if (!target || !bot.attack) return { outcome: "unavailable", reasonCode: "COMBAT_TARGET_NOT_FOUND" };
          await bot.attack(target);
          return { outcome: "executed", executedAtMs: this.clock() };
        }
        case "ROTATE":
          if (!bot.look) return { outcome: "unavailable", reasonCode: "COMBAT_ROTATION_UNAVAILABLE" };
          await bot.look(
            degreesToRadians(action.orientation.yaw),
            degreesToRadians(action.orientation.pitch),
            true,
          );
          return { outcome: "executed", executedAtMs: this.clock() };
        case "MOVE":
          bot.pathfinder?.stop?.();
          await this.applyMovement(action.direction, action.sprint, action.durationMs, signal);
          return { outcome: "executed", executedAtMs: this.clock() };
        case "RETREAT_MOVE":
          if (action.direction === null) {
            this.movementAbortController?.abort();
            bot.pathfinder?.stop?.();
            bot.clearControlStates?.();
          } else {
            bot.pathfinder?.stop?.();
            await this.applyMovement(action.direction, action.sprint, action.durationMs, signal);
          }
          return { outcome: "executed", executedAtMs: this.clock() };
        case "PLACE_CRYSTAL":
        case "PACKET_MINE":
          return { outcome: "unavailable", reasonCode: "COMBAT_ACTION_ADAPTER_UNAVAILABLE" };
      }
    } catch {
      bot.clearControlStates?.();
      return {
        outcome: "failed",
        reasonCode: signal.aborted
          ? "SKILL_CANCELLED"
          : "COMBAT_ACTION_EXECUTION_FAILED",
      };
    }
  }

  reset(): void {
    const bot = this.bot as unknown as CombatBotLike;
    this.movementAbortController?.abort();
    this.movementAbortController = null;
    bot.pathfinder?.stop?.();
    bot.clearControlStates?.();
  }

  private entityObservation(
    entity: EntityLike,
    registry: unknown,
  ): CombatDriverObservation["entities"][number] | null {
    if (!entity.position || !finiteVector(entity.position)) return null;
    const name = typeof entity.name === "string" ? entity.name.toLowerCase() : null;
    const bareName = name?.replace(/^minecraft:/u, "") ?? null;
    const type = typeof entity.type === "string" ? entity.type.toLowerCase() : "unknown";
    const registryInfo = registryEntityInfo(registry, bareName);
    const registryCategory = normalizedRegistryCategory(registryInfo?.category);
    const normalizedType = type === "player"
      ? "player"
      : (type === "hostile" ||
          type === "monster" ||
          HOSTILE_MOBS.has(bareName ?? "") ||
          bareName === ENDERMAN_NAME ||
          registryCategory === "hostile" ||
          registryCategory === "monster")
        ? "hostile"
        : type === "animal" ||
            type === "passive" ||
            registryCategory === "passive" ||
            registryCategory === "ambient" ||
            registryCategory === "water"
          ? "animal"
          : ANIMAL_MOBS.has(bareName ?? "")
            ? "animal"
            : type === "mob"
              ? "unknown"
              : "object";
    const combatEntity = combatEntityFromMineflayer(
      { ...entity, type: normalizedType },
      (registry ?? {}) as CombatRegistryLike,
    );
    const velocity = entity.velocity && finiteVector(entity.velocity)
      ? { x: entity.velocity.x, y: entity.velocity.y, z: entity.velocity.z }
      : null;
    return {
      entity: combatEntity,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      velocity,
      health: finiteNumber(entity.health) ? Number(entity.health) : null,
      armorPoints: this.entityArmorPoints(entity),
      wieldingWeapon: this.entityWieldsWeapon(entity),
      crystalNearby: false,
      // A complete Mineflayer equipment array is a useful tactical fact. If
      // either equipment or health is incomplete, preserve GearAssessor's
      // fail-closed `unknown` path by returning null instead of guessing.
      gear: this.gearSnapshotForEntity(entity),
    };
  }

  private gearSnapshotForEntity(entity: EntityLike): CombatGearSnapshot | null {
    if (!entity.equipment || entity.equipment.length < 4) return null;
    const health = finiteNumber(entity.health) ? Number(entity.health) : null;
    if (health === null || health < 0 || health > 20) return null;
    const armorPoints = this.entityArmorPoints(entity);
    if (armorPoints === null) return null;
    return {
      armorMaterial: armorMaterialForItems(entity.equipment, armorPoints),
      // Enchantments are not part of this read-only boundary yet. Zero is a
      // conservative lower bound; it never invents protection data.
      protectionLevel: 0,
      weaponDamage: weaponDamageForItems(entity.equipment),
      health,
      hasTotem: entity.equipment.some(
        (item) => normalizeItemName(item) === "totem_of_undying",
      ),
    };
  }

  private gearSnapshot(
    self: EntityLike,
    inventory: readonly ItemLike[],
    offhand: ItemLike | null,
  ): CombatGearSnapshot | null {
    if (!self.equipment || self.equipment.length < 4 || !finiteNumber(self.health)) {
      return null;
    }
    const armorPoints = (self.equipment ?? []).reduce(
      (sum, item) => sum + (typeof item.name === "string" ? ARMOR_POINTS[item.name] ?? 0 : 0),
      0,
    );
    const weapon = inventory
      .map((item) => this.weaponCandidate(item))
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => right.baseDamage - left.baseDamage)[0];
    return {
      armorMaterial: armorMaterialForItems(self.equipment ?? [], armorPoints),
      protectionLevel: 0,
      weaponDamage: weapon?.baseDamage ?? 0,
      health: Math.max(0, Number(self.health)),
      hasTotem: offhand?.name === "totem_of_undying",
    } as const;
  }

  private weaponCandidate(item: ItemLike) {
    const name = typeof item.name === "string" ? item.name : null;
    if (!name) return null;
    const kindEntry = [...WEAPON_KINDS.entries()].find(([suffix]) => name.endsWith(`_${suffix}`) || name === suffix);
    if (!kindEntry) return null;
    const slot = Number.isSafeInteger(item.slot) ? Number(item.slot) : -1;
    if (slot < 0) return null;
    const kind = kindEntry[1];
    const ranged = kind === "bow" || kind === "crossbow";
    return {
      slot,
      itemName: name,
      kind,
      baseDamage: kind === "axe" ? 9 : kind === "trident" ? 9 : kind === "sword" ? 6 : 1,
      fullCooldownMs: kind === "axe" ? 1_000 : 625,
      durabilityRemaining: finiteNumber(item.maxDurability) && finiteNumber(item.durabilityUsed)
        ? Math.max(0, Number(item.maxDurability) - Number(item.durabilityUsed))
        : null,
      enchantmentDamageBonus: 0,
      ...(ranged
        ? {
            ammoRemaining: (this.bot as unknown as CombatBotLike).inventory?.items?.().filter(
              (candidate) => candidate.name === "arrow",
            ).length ?? 0,
            drawTimeMs: kind === "bow" ? 1_000 : 1_250,
            effectiveRange: kind === "bow" ? 32 : 32,
          }
        : {}),
    };
  }

  private equipmentItem(bot: CombatBotLike, destination: string): ItemLike | null {
    try {
      const slot = bot.getEquipmentDestSlot?.(destination);
      const item = slot === undefined ? null : bot.inventory?.slots?.[slot];
      return item ?? null;
    } catch {
      return null;
    }
  }

  private heldItemSlot(bot: CombatBotLike): number | null {
    const item = this.equipmentItem(bot, "hand");
    return item && Number.isSafeInteger(item.slot) ? Number(item.slot) : null;
  }

  private entityArmorPoints(entity: EntityLike): number | null {
    if (!entity.equipment) return null;
    const points = entity.equipment.reduce(
      (sum, item) => sum + (typeof item.name === "string" ? ARMOR_POINTS[item.name] ?? 0 : 0),
      0,
    );
    return points;
  }

  private entityWieldsWeapon(entity: EntityLike): boolean {
    return (entity.equipment ?? []).some((item) => weaponKindForName(normalizeItemName(item)) !== null);
  }

  private async applyMovement(
    direction: Readonly<{ x: number; z: number }>,
    sprint: boolean,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    const bot = this.bot as unknown as CombatBotLike;
    this.movementAbortController?.abort();
    const movementAbortController = new AbortController();
    this.movementAbortController = movementAbortController;
    const abortMovement = () => movementAbortController.abort();
    signal.addEventListener("abort", abortMovement, { once: true });
    // MovementController emits a world-space direction. Mineflayer control
    // states are relative to the bot's current yaw, so convert to local
    // forward/right components before selecting keys. At yaw 0 Minecraft's
    // forward basis points toward +Z and the right basis toward +X.
    const yaw = finiteNumber(bot.entity?.yaw) ? Number(bot.entity?.yaw) : 0;
    const forwardX = -Math.sin(yaw);
    const forwardZ = Math.cos(yaw);
    const rightX = Math.cos(yaw);
    const rightZ = Math.sin(yaw);
    const forwardComponent = direction.x * forwardX + direction.z * forwardZ;
    const rightComponent = direction.x * rightX + direction.z * rightZ;
    bot.clearControlStates?.();
    if (forwardComponent > 0.05) bot.setControlState?.("forward", true);
    if (forwardComponent < -0.05) bot.setControlState?.("back", true);
    if (rightComponent > 0.05) bot.setControlState?.("right", true);
    if (rightComponent < -0.05) bot.setControlState?.("left", true);
    if (sprint) bot.setControlState?.("sprint", true);
    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let onAbort: () => void;
        const timer = setTimeout(() => {
          settled = true;
          movementAbortController.signal.removeEventListener("abort", onAbort);
          resolve();
        }, Math.max(100, Math.min(2_000, durationMs)));
        onAbort = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          movementAbortController.signal.removeEventListener("abort", onAbort);
          bot.clearControlStates?.();
          reject(new Error("cancelled"));
        };
        movementAbortController.signal.addEventListener("abort", onAbort, { once: true });
        if (movementAbortController.signal.aborted) onAbort();
      });
    } finally {
      signal.removeEventListener("abort", abortMovement);
      if (this.movementAbortController === movementAbortController) {
        this.movementAbortController = null;
      }
      bot.clearControlStates?.();
    }
  }
}

function finiteNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value);
}

function numberOr(value: unknown, fallback: number): number {
  return finiteNumber(value) ? Number(value) : fallback;
}

function readInventoryItems(bot: CombatBotLike): readonly ItemLike[] | null {
  const inventory = bot.inventory;
  try {
    if (!inventory || typeof inventory.items !== "function") return null;
    const items = inventory.items();
    if (!Array.isArray(items)) return null;
    // Mineflayer's `items()` contract returns Item objects. Treat a partially
    // initialized or malformed array as unavailable rather than counting it
    // as an empty inventory and allowing combat to proceed.
    if (items.some((item) => typeof item !== "object" || item === null)) return null;
    return items as readonly ItemLike[];
  } catch {
    return null;
  }
}

function registryEntityInfo(
  registry: unknown,
  bareName: string | null,
): RegistryEntityInfo | undefined {
  if (bareName === null || typeof registry !== "object" || registry === null) {
    return undefined;
  }
  const entitiesByName = (registry as CombatRegistryLike).entitiesByName;
  if (typeof entitiesByName !== "object" || entitiesByName === null) {
    return undefined;
  }
  for (const name of [bareName, `minecraft:${bareName}`]) {
    const candidate = entitiesByName[name];
    if (typeof candidate === "object" && candidate !== null) return candidate;
  }
  return undefined;
}

function normalizedRegistryCategory(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const category = value.trim().toLowerCase();
  return category.length > 0 ? category : null;
}

function finiteVector(value: unknown): value is VecLike {
  return typeof value === "object" && value !== null &&
    finiteNumber((value as VecLike).x) &&
    finiteNumber((value as VecLike).y) &&
    finiteNumber((value as VecLike).z);
}

function normalizeDimension(value: unknown): string | null {
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const lower = value.toLowerCase();
  return lower.includes(":") ? lower : `minecraft:${lower}`;
}

function radiansToDegrees(value: number): number {
  return (value * 180) / Math.PI;
}

function degreesToRadians(value: number): number {
  return (value * Math.PI) / 180;
}

function armorMaterialFor(points: number): ArmorMaterial {
  if (points >= 20) return "diamond";
  if (points >= 15) return "iron";
  if (points >= 12) return "chainmail";
  if (points >= 10) return "golden";
  if (points > 0) return "leather";
  return "none";
}

function normalizeItemName(item: ItemLike): string | null {
  return typeof item.name === "string" && item.name.length > 0
    ? item.name.toLowerCase()
    : null;
}

function armorMaterialForItems(
  items: readonly ItemLike[],
  fallbackPoints: number,
): ArmorMaterial {
  const materials = items
    .map(normalizeItemName)
    .map((name) => name?.split("_")[0] ?? null)
    .filter(
      (material): material is Exclude<ArmorMaterial, "none"> =>
        material !== null && material in ARMOR_MATERIAL_RANK &&
        items.some((item) => {
          const name = normalizeItemName(item);
          return name !== null && name in ARMOR_POINTS && name.startsWith(`${material}_`);
        }),
    );
  if (materials.length === 0) return armorMaterialFor(fallbackPoints);
  const weakest = materials.reduce((left, right) =>
    ARMOR_MATERIAL_RANK[left] <= ARMOR_MATERIAL_RANK[right] ? left : right,
  );
  return weakest;
}

function weaponKindForName(name: string | null): "sword" | "axe" | "trident" | "bow" | "crossbow" | null {
  if (name === null) return null;
  for (const [suffix, kind] of WEAPON_KINDS) {
    if (name === suffix || name.endsWith(`_${suffix}`)) return kind;
  }
  return null;
}

function weaponDamageForItems(items: readonly ItemLike[]): number {
  return items.reduce((damage, item) => {
    switch (weaponKindForName(normalizeItemName(item))) {
      case "axe":
      case "trident":
        return Math.max(damage, 9);
      case "sword":
        return Math.max(damage, 6);
      case "bow":
      case "crossbow":
        return Math.max(damage, 1);
      default:
        return damage;
    }
  }, 0);
}

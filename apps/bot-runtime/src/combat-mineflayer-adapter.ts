import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

import {
  combatEntityFromMineflayer,
  type MineflayerCombatEntityView,
} from "./combat-entity-adapter.js";
import {
  HitWindowTracker,
  TotemPopTracker,
  detonateCrystals,
  enumerateCrystalCandidates,
  explosionRuleSetForMinecraftVersion,
  inCriticalWindow,
  meleeControlFrame,
  MELEE_CONTROL_FRAME_MS,
  placeCrystal,
  primeWTap,
  selectWTapStrategy,
  primeCritical,
  releaseCriticalPriming,
  selectCriticalStrategy,
  type CombatGearSnapshot,
  type CombatWeaponCandidate,
} from "@minecraft-studio/combat";
import type {
  CombatActionAcknowledgement,
  CombatDriverObservation,
  CombatPrimitiveAction,
} from "./combat-driver.js";
import {
  ExplosionPacketAdapter,
  type CombatExplosionObservation,
} from "./explosion-packet-adapter.js";

type VecLike = Readonly<{ x: number; y: number; z: number }>;
type ItemLike = Readonly<{
  name?: unknown;
  slot?: unknown;
  count?: unknown;
  durabilityUsed?: unknown;
  maxDurability?: unknown;
  enchants?: unknown;
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
  health?: unknown;
  version?: unknown;
  entities?: Readonly<Record<string, EntityLike>>;
  inventory?: Readonly<{
    items?: () => readonly ItemLike[];
    slots?: readonly (ItemLike | null | undefined)[];
  }>;
  game?: Readonly<{ dimension?: unknown }>;
  _client?: MineflayerWireClient;
  registry?: unknown;
  player?: Readonly<{ ping?: unknown }>;
  getEquipmentDestSlot?: (destination: string) => number;
  equip?: (item: unknown, destination: string) => Promise<void>;
  attack?: (entity: unknown) => Promise<void> | void;
  activateItem?: (offHand?: boolean) => void;
  deactivateItem?: () => void;
  look?: (yaw: number, pitch: number, force?: boolean) => Promise<void>;
  setControlState?: (control: string, state: boolean) => void;
  clearControlStates?: () => void;
  pathfinder?: Readonly<{ stop?: () => void }>;
  blockAt?: (position: VecLike) => Readonly<{ name?: unknown }> | null;
}>;

type CombatBotHeldItemState = {
  usingHeldItem?: boolean;
};

type MineflayerWireClient = Readonly<{
  on?: (event: string, listener: (packet: unknown) => void) => void;
  prependListener?: (event: string, listener: (packet: unknown) => void) => void;
  off?: (event: string, listener: (packet: unknown) => void) => void;
  removeListener?: (event: string, listener: (packet: unknown) => void) => void;
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

const COMBAT_HAZARD_BLOCKS = new Set([
  "lava",
  "fire",
  "soul_fire",
  "magma_block",
  "cactus",
  "powder_snow",
  "sweet_berry_bush",
  "campfire",
  "soul_campfire",
  "pointed_dripstone",
]);
const COMBAT_HAZARD_SCAN_RADIUS = 2;

/**
 * Narrow Mineflayer boundary for the deterministic combat layer. World
 * geometry and combat placements remain unavailable until versioned adapters
 * exist; server-authoritative entity status events are safe to observe here.
 */
export class MineflayerCombatAdapter {
  private clock: () => number = () => Date.now();
  private movementAbortController: AbortController | null = null;
  private readonly totemPopTracker = new TotemPopTracker();
  private readonly hitWindowTracker: HitWindowTracker;
  private explosionPacketAdapter: ExplosionPacketAdapter | null = null;
  private explosionObservations: CombatExplosionObservation[] = [];
  private boundWire: MineflayerWireClient | null = null;
  private heldItemBeforeForeignStatus = new WeakMap<
    object,
    boolean
  >();
  private readonly onEntityStatus = (packet: unknown): void => {
    this.recordTotemPop(packet);
  };
  private readonly onEntityStatusBeforeMineflayer = (packet: unknown): void => {
    const entityId = entityStatusEntityId(packet);
    const bot = this.bot as unknown as CombatBotLike;
    if (
      entityId !== null &&
      Number.isSafeInteger(bot.entity?.id) &&
      entityId !== bot.entity?.id
    ) {
      const usingHeldItem = (bot as CombatBotHeldItemState).usingHeldItem;
      if (typeof usingHeldItem === "boolean") {
        const record = asRecord(packet);
        if (record !== null) {
          this.heldItemBeforeForeignStatus.set(record, usingHeldItem);
        }
      }
    }
    this.recordTotemPop(packet);
  };
  private readonly onEntityStatusAfterMineflayer = (packet: unknown): void => {
    const record = asRecord(packet);
    if (record === null) return;
    const previous = this.heldItemBeforeForeignStatus.get(record);
    if (previous === undefined) return;
    this.heldItemBeforeForeignStatus.delete(record);
    // Mineflayer's inventory listener clears this flag for every status packet.
    // Restore it only for another entity; self status packets keep Mineflayer's
    // original semantics (including self POP/eating completion).
    (this.bot as unknown as CombatBotHeldItemState).usingHeldItem = previous;
  };
  private readonly onDamageEvent = (packet: unknown): void => {
    // Entity Status 2 不是受击：per minecraft.wiki Entity statuses，2 是三叉戟
    // 蓄力（trident charge）动画。受击的权威信号是 clientbound damage_event
    // 包（1.19.3+，字段 entityId），HitWindowTracker 的 i-frame 只从这里喂。
    this.recordEntityHurt(entityStatusEntityId(packet));
  };
  private readonly onAnimation = (packet: unknown): void => {
    const record = asRecord(packet);
    if (record?.animation !== 0) return;
    const entityId = entityStatusEntityId(packet);
    if (entityId === null) return;
    const bot = this.bot as unknown as CombatBotLike;
    const entity = Object.values(bot.entities ?? {}).find(
      (candidate) => candidate.id === entityId,
    );
    const observedAtMs = this.clock();
    if (
      !entity ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs < 0
    ) return;
    try {
      this.hitWindowTracker.recordSwingObserved(
        entityId,
        observedAtMs,
        observedAttackCooldownMs(entity),
      );
    } catch {
      // Ignore malformed/out-of-order wire observations.
    }
  };
  private readonly onExplosion = (packet: unknown): void => {
    const adapter = this.explosionPacketAdapter;
    if (adapter === null) return;
    const bot = this.bot as unknown as CombatBotLike;
    const dimension = normalizeDimension(bot.game?.dimension);
    const observedAtMs = this.clock();
    if (
      dimension === null ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs < 0
    ) return;
    try {
      this.explosionObservations.push(adapter.adapt(packet, {
        observedAtMs,
        serverProfileId: this.serverProfileId,
        dimension,
      }));
      if (this.explosionObservations.length > 64) {
        this.explosionObservations.splice(
          0,
          this.explosionObservations.length - 64,
        );
      }
    } catch {
      // The wire is untrusted. A malformed packet is not converted into a
      // partial observation and does not take down unrelated combat tracking.
    }
  };

  /** PACKET_CRIT 只在无反作弊档启用（构造后由 runtime 注入）。 */
  private criticalPacketAllowed = false;

  constructor(
    private readonly bot: Bot,
    private readonly serverProfileId: string,
    private readonly enabled: boolean,
  ) {
    this.hitWindowTracker = enabled
      ? new HitWindowTracker(serverProfileId)
      : new HitWindowTracker();
    const version = (bot as unknown as CombatBotLike).version;
    if (enabled && typeof version === "string") {
      this.initializeExplosionProtocol();
    }
    this.bindTotemPopEvents();
  }

  setClock(clock: () => number): void {
    this.clock = clock;
  }

  setCriticalPacketAllowed(allowed: boolean): void {
    this.criticalPacketAllowed = allowed;
  }

  /** 真实 ping（来自 bot.player 或 telemetry 采集）。 */
  private latencyMs(): number {
    const ping = (this.bot as unknown as { player?: { ping?: number } }).player?.ping;
    return Number.isFinite(ping) && ping !== undefined && ping >= 0 ? ping : 80;
  }

  /**
   * 轮询等待物理下落窗口（50ms 步进）。用真实墙钟而不是注入时钟：
   * 注入时钟可能被冻结用于断言（实测把 deadline 卡成永不到达），
   * 而这是物理等待不是被测事件的时间戳。
   */
  private waitForCriticalWindow(budgetMs: number, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      const deadline = Date.now() + budgetMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean) => { clearTimeout(timer); signal.removeEventListener("abort", abort); resolve(value); };
      const abort = () => finish(false);
      signal.addEventListener("abort", abort, { once: true });
      const poll = () => {
        if (signal.aborted) return finish(false);
        if (inCriticalWindow(this.bot)) return finish(true);
        if (Date.now() >= deadline) return finish(false);
        timer = setTimeout(poll, 50);
      };
      poll();
    });
  }

  /** Called again after auto-version negotiation; unknown schemas throw. */
  initializeExplosionProtocol(): void {
    if (!this.enabled) return;
    const version = (this.bot as unknown as CombatBotLike).version;
    if (typeof version !== "string" || version.trim().length === 0) {
      throw new TypeError("Combat explosion protocol version is unavailable.");
    }
    if (this.explosionPacketAdapter?.minecraftVersion === version) return;
    this.explosionPacketAdapter = new ExplosionPacketAdapter(version);
  }

  drainExplosionObservations(): readonly CombatExplosionObservation[] {
    const observations = this.explosionObservations.map((entry) => ({
      ...entry,
      center: { ...entry.center },
      knockback: entry.knockback === null ? null : { ...entry.knockback },
    }));
    this.explosionObservations = [];
    return observations;
  }

  observation(nowMs: number): CombatDriverObservation | null {
    if (!this.enabled || !Number.isSafeInteger(nowMs) || nowMs < 0) return null;
    this.bindTotemPopEvents();
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
    let selfPopWindow;
    try {
      selfPopWindow = this.totemPopTracker.windowFor({
        entityId: self.id,
        observedAtMs: nowMs,
        serverProfileId: this.serverProfileId,
        dimension,
      });
    } catch {
      return null;
    }

    // These values are required by the deterministic driver. Do not turn a
    // pre-spawn/partially populated Mineflayer entity into a fabricated safe
    // snapshot (for example health=0 or onGround=false).
    // Mineflayer exposes the local player's health on `bot.health`; entity
    // health is optional and is primarily populated for observed mobs.
    const health = finiteNumber(bot.health) ? Number(bot.health) : null;
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
          return this.entityObservation(entity, bot.registry, nowMs, dimension);
        } catch {
          return null;
        }
      })
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const offhand = this.equipmentItem(bot, "off-hand");
    const heldItem = this.equipmentItem(bot, "hand");
    const selfGear = this.gearSnapshot(self, inventoryItems, offhand);
    const weapons = inventoryItems
      .map((item) => this.weaponCandidate(item))
      .filter((value): value is NonNullable<typeof value> => value !== null);
    const heldFallback = heldItem === null
      ? null
      : this.weaponCandidate(heldItem, true);
    if (
      heldFallback !== null &&
      !weapons.some(({ slot }) => slot === heldFallback.slot)
    ) {
      weapons.push(heldFallback);
    }
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
      explosionRuleSet: typeof bot.version === "string"
        ? explosionRuleSetForMinecraftVersion(bot.version)
        : null,
      self: {
        position: { x: position.x, y: position.y, z: position.z },
        health,
        offhandIsTotem: offhand?.name === "totem_of_undying",
        totemPopObservedAtMs: selfPopWindow.phase === "PUNISH"
          ? selfPopWindow.popObservedAtMs
          : null,
        inventoryTotemCount: inventoryItems.filter(
          (item) => item.name === "totem_of_undying",
        ).length,
        gear: selfGear,
        orientation,
        heldItemSlot: this.heldItemSlot(bot),
        usingHeldItem: (bot as CombatBotHeldItemState).usingHeldItem === true,
        hasShield: inventoryItems.some((item) => item.name === "shield") || offhand?.name === "shield",
        onGround: self.onGround === true,
        fallDistance: finiteNumber((self as EntityLike & { fallDistance?: unknown }).fallDistance)
          ? Number((self as EntityLike & { fallDistance?: unknown }).fallDistance)
          : null,
      },
      entities,
      weapons,
      // CrystalEngine 的候选枚举（此前恒 null，评分引擎永远不被触发）：
      // 以最近敌对实体为中心扫黑曜石/基岩承载。无目标时给空数组而不是
      // null——null 语义是"不知道"，空数组是"确认没有"。
      crystalCandidates: (() => {
        const hostile = Object.values(bot.entities ?? {}).find(
          (entity) =>
            entity !== bot.entity &&
            (entity as { isValid?: boolean }).isValid !== false &&
            (entity as { type?: string }).type === "player",
        );
        const targetPos = (hostile as { position?: Vec3 } | undefined)?.position;
        if (!targetPos) return [];
        try {
          // The combat package uses its own lightweight vector; pass a real
          // Vec3 so blockAt receives the same type the rest of the adapter uses.
          return enumerateCrystalCandidates(
            bot as never,
            new Vec3(targetPos.x, targetPos.y, targetPos.z) as never,
          ) as never;
        } catch {
          return [];
        }
      })(),
      mineCandidates: null,
      hazards: this.hazardsAround(position),
    };
  }

  async execute(
    action: CombatPrimitiveAction,
    signal: AbortSignal,
  ): Promise<CombatActionAcknowledgement> {
    if (!this.enabled) return { outcome: "unavailable", reasonCode: "COMBAT_DRIVER_UNAVAILABLE" };
    if (signal.aborted) return { outcome: "failed", reasonCode: "SKILL_CANCELLED" };
    const epoch = this.executionEpoch;
    const active = () => !signal.aborted && epoch === this.executionEpoch;
    const bot = this.bot as unknown as CombatBotLike;
    try {
      switch (action.kind) {
        case "DISENGAGE":
          this.movementAbortController?.abort();
          bot.deactivateItem?.();
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
          const targetUuid = target.uuid;
          const targetCurrent = () => active() && Object.values(bot.entities ?? {}).some((entity) => entity === target) &&
            target.uuid === targetUuid && !!bot.entity?.position && !!target.position &&
            Math.hypot(target.position.x - bot.entity.position.x, target.position.y - bot.entity.position.y,
              target.position.z - bot.entity.position.z) <= 3;
          if (!targetCurrent()) return { outcome: "failed", reasonCode: "COMBAT_TARGET_NOT_FOUND" };
          // ---- Critical Hit Engine（参考项目学习的产物，本轮接入）----
          // 策略选择：物理不可靠/高延迟/追击/贴脸/天花板各走各的路径；
          // PACKET_CRIT 只在 anarchy 档（无反作弊）启用。
          const self = bot.entity;
          const targetSpeed = Math.hypot(
            target.velocity?.x ?? 0,
            target.velocity?.z ?? 0,
          );
          const selfSpeed = Math.hypot(
            self?.velocity?.x ?? 0,
            self?.velocity?.z ?? 0,
          );
          const selfPosition = self?.position;
          const targetPosition = target.position;
          const distance = selfPosition && targetPosition
            ? Math.hypot(
                targetPosition.x - selfPosition.x,
                targetPosition.y - selfPosition.y,
                targetPosition.z - selfPosition.z,
              )
            : 99;
          const blockAbove = (() => {
            if (!selfPosition) return false;
            try {
              const block = this.bot.blockAt(
                new Vec3(selfPosition.x, selfPosition.y + 2, selfPosition.z),
              );
              return (block as { boundingBox?: string } | null)?.boundingBox === "solid";
            } catch {
              return false;
            }
          })();
          const selfEntity = self as
            | { isInWater?: boolean; isInLava?: boolean; isClimbing?: boolean }
            | undefined;
          const inWater = selfEntity?.isInWater === true;
          const inLava = selfEntity?.isInLava === true;
          const onLadder = selfEntity?.isClimbing === true;
          const critical = selectCriticalStrategy({
            pingMs: this.latencyMs(),
            selfSpeed,
            targetDistance: distance,
            inCompromisedPhysics: inWater || inLava || onLadder,
            targetMoving: targetSpeed > 0.15,
            ceilingAbove: blockAbove,
            allowPacketCrit: this.criticalPacketAllowed,
          });
          const critBotView = {
            entity: self
              ? {
                  position: { x: self.position!.x, y: self.position!.y, z: self.position!.z },
                  velocity: { x: self.velocity?.x ?? 0, y: self.velocity?.y ?? 0, z: self.velocity?.z ?? 0 },
                  onGround: self.onGround ?? false,
                }
              : null,
            setControlState: (name: string, state: boolean) =>
              this.bot.setControlState(name as never, state),
          } as Parameters<typeof primeCritical>[0];
          if (
            critical.awaitFallWindow &&
            self &&
            !inCriticalWindow(this.bot) &&
            self.onGround
          ) {
            primeCritical(critBotView, critical.strategy);
            // 等待下落窗口（物理跳起后 ~150-300ms 到达攻击判定段）。
            const windowOpened = await this.waitForCriticalWindow(400, signal);
            if (!active()) return { outcome: "failed", reasonCode: "SKILL_CANCELLED" };
            releaseCriticalPriming(critBotView);
            if (!targetCurrent()) return { outcome: "failed", reasonCode: "COMBAT_TARGET_NOT_FOUND" };
            if (!windowOpened) {
              // P0-C13: 暴击窗口未打开——不能假报 executed。
              // 降级为普通攻击（真实攻击 + fallback 标注）。
              await bot.attack(target);
              return {
                outcome: "executed",
                executedAtMs: this.clock(),
                ...{ fallback: "CRIT_WINDOW_TIMEOUT" },
              } as never;
            }
          } else if (critical.strategy === "PACKET_CRIT") {
            const primed = primeCritical(critBotView, "PACKET_CRIT");
            if (!primed) {
              // PACKET_CRIT 包注入失败——降级为普通攻击
              await bot.attack(target);
              return {
                outcome: "executed",
                executedAtMs: this.clock(),
                ...{ fallback: "PACKET_CRIT_PRIME_FAILED" },
              } as never;
            }
          }
          // ---- W-Tap（sprint reset）：贴脸 Combo 减少自身被弹开 ----
          const wtap = selectWTapStrategy({
            health: Number((bot as { health?: number }).health ?? 20),
            targetDistance: distance,
            inCombo: distance < 2.5,
          });
          if (!targetCurrent()) return { outcome: "failed", reasonCode: "COMBAT_TARGET_NOT_FOUND" };
          const restoreWTap = primeWTap(
            critBotView as unknown as { setControlState: (n: string, s: boolean) => void },
            wtap,
          );
          await bot.attack(target);
          // P0-C14: W-Tap 需要 tick 间隔让 sprint 真正重置——50ms = 1 tick
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (active()) { restoreWTap(); releaseCriticalPriming(critBotView); }
          return { outcome: "executed", executedAtMs: this.clock() };
        }
        case "DRAW_RANGED_WEAPON": {
          const item = bot.inventory?.slots?.[action.weaponSlot];
          if (!item || !bot.activateItem) {
            return {
              outcome: "unavailable",
              reasonCode: "COMBAT_WEAPON_NOT_IN_INVENTORY",
            };
          }
          bot.activateItem(false);
          return { outcome: "executed", executedAtMs: this.clock() };
        }
        case "RELEASE_RANGED_WEAPON":
          if (!bot.deactivateItem) {
            return {
              outcome: "unavailable",
              reasonCode: "COMBAT_ACTION_ADAPTER_UNAVAILABLE",
            };
          }
          bot.deactivateItem();
          return { outcome: "executed", executedAtMs: this.clock() };
        case "SHIELD_BLOCK": {
          const shield = (bot.inventory?.items?.() ?? []).find(
            (candidate) => candidate.name === "shield",
          );
          if (!shield || !bot.equip || !bot.activateItem) {
            return { outcome: "unavailable", reasonCode: "COMBAT_SHIELD_UNAVAILABLE" };
          }
          await bot.equip(shield, "off-hand");
          if (!active()) return { outcome: "failed", reasonCode: "SKILL_CANCELLED" };
          bot.activateItem(true);
          const durationMs = Math.max(50, Math.min(1000, action.durationMs));
          setTimeout(() => {
            if (active()) bot.deactivateItem?.();
          }, durationMs);
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
        case "PLACE_CRYSTAL": {
          const placed = await placeCrystal(
            bot as never,
            action.position as never,
          );
          return placed
            ? { outcome: "executed", executedAtMs: this.clock() }
            : { outcome: "failed", reasonCode: "COMBAT_CRYSTAL_PLACE_FAILED" };
        }
        case "DETONATE_CRYSTALS": {
          const count = await detonateCrystals(bot as never);
          return {
            outcome: count > 0 ? "executed" : "skipped",
            executedAtMs: this.clock(),
            ...(count > 0 ? { reasonCode: `CRYSTALS_DETONATED:${count}` } : { reasonCode: "NO_CRYSTALS_IN_RANGE" }),
          } as never;
        }
        case "PACKET_MINE":
          return { outcome: "unavailable", reasonCode: "COMBAT_ACTION_ADAPTER_UNAVAILABLE" };
      }
    } catch {
      if (active()) bot.clearControlStates?.();
      return {
        outcome: "failed",
        reasonCode: signal.aborted
          ? "SKILL_CANCELLED"
          : "COMBAT_ACTION_EXECUTION_FAILED",
      };
    }
  }

  reset(): void {
    this.executionEpoch++;
    const bot = this.bot as unknown as CombatBotLike;
    this.totemPopTracker.reset();
    this.hitWindowTracker.reset();
    this.explosionObservations = [];
    this.movementAbortController?.abort();
    this.movementAbortController = null;
    bot.deactivateItem?.();
    bot.pathfinder?.stop?.();
    bot.clearControlStates?.();
  }

  private executionEpoch = 0;

  /**
   * MovementController needs an honest local hazard set. Mineflayer's blockAt
   * is synchronous, so a small loaded-area scan is cheap and keeps ordinary
   * weapon movement from being rejected simply because hazards were left
   * permanently unknown. Any missing sample remains unknown and fails closed.
   */
  private hazardsAround(position: VecLike): readonly VecLike[] | null {
    const bot = this.bot as unknown as CombatBotLike;
    if (typeof bot.blockAt !== "function") return null;
    const hazards: VecLike[] = [];
    const baseX = Math.floor(position.x);
    const baseY = Math.floor(position.y);
    const baseZ = Math.floor(position.z);
    for (
      let dx = -COMBAT_HAZARD_SCAN_RADIUS;
      dx <= COMBAT_HAZARD_SCAN_RADIUS;
      dx += 1
    ) {
      for (
        let dz = -COMBAT_HAZARD_SCAN_RADIUS;
        dz <= COMBAT_HAZARD_SCAN_RADIUS;
        dz += 1
      ) {
        for (const dy of [-1, 0, 1] as const) {
          let block: Readonly<{ name?: unknown }> | null;
          try {
            block = bot.blockAt(
              new Vec3(baseX + dx, baseY + dy, baseZ + dz),
            );
          } catch {
            return null;
          }
          if (block === null || typeof block.name !== "string") return null;
          const name = block.name.toLowerCase().replace(/^minecraft:/u, "");
          if (COMBAT_HAZARD_BLOCKS.has(name)) {
            hazards.push({
              x: baseX + dx,
              y: baseY + dy,
              z: baseZ + dz,
            });
          }
        }
      }
    }
    return hazards;
  }

  private entityObservation(
    entity: EntityLike,
    registry: unknown,
    observedAtMs: number,
    dimension: string,
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
    const popWindow = this.totemPopTracker.windowFor({
      entityId: combatEntity.entityId,
      observedAtMs,
      serverProfileId: this.serverProfileId,
      dimension,
    });
    const hitWindow = this.hitWindowTracker.stateFor(
      combatEntity.entityId,
      observedAtMs,
    );
    return {
      entity: combatEntity,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      velocity,
      health: finiteNumber(entity.health) ? Number(entity.health) : null,
      armorPoints: this.entityArmorPoints(entity),
      wieldingWeapon: this.entityWieldsWeapon(entity),
      rangedWeapon: this.entityWieldsRangedWeapon(entity),
      // 真实观测：已加载实体里有没有贴脸的末影水晶（敌人放的水雷）。
      // 此前硬编码 false 让 CRYSTAL_PLACED 威胁加分与 CRYSTAL_THREAT 撤退
      // 信号永远死置。anchor 仍显式 false：重生锚需要方块枚举确认，
      // 不能从实体表推断，留待世界扫描接线。
      crystalNearby: this.hasLoadedEndCrystalNearby(entity.position),
      anchorNearby: false,
      invulnerableRemainingMs: hitWindow.invulnerableRemainingMs,
      targetCooldownRatio01: hitWindow.cooldownRatio01,
      ...(popWindow.phase === "PUNISH" ? { recentlyPopped: true } : {}),
      // A complete Mineflayer equipment array is a useful tactical fact. If
      // either equipment or health is incomplete, preserve GearAssessor's
      // fail-closed `unknown` path by returning null instead of guessing.
      gear: this.gearSnapshotForEntity(entity),
    };
  }

  private bindTotemPopEvents(): void {
    if (!this.enabled) return;
    const bot = this.bot as unknown as CombatBotLike;
    const wire = bot._client;
    if (wire === this.boundWire) return;
    this.unbindTotemPopEvents();
    if (!wire || typeof wire.on !== "function") return;
    if (typeof wire.prependListener === "function") {
      // Mineflayer's inventory plugin is already registered in production.
      // Capture before it clears usingHeldItem, then restore after its listener
      // only when the status belonged to another entity.
      wire.prependListener("entity_status", this.onEntityStatusBeforeMineflayer);
      wire.on("entity_status", this.onEntityStatusAfterMineflayer);
    } else {
      // Compatibility path for minimal test doubles/older clients: POP
      // observation still works, but the ordering repair is unavailable.
      wire.on("entity_status", this.onEntityStatus);
    }
    wire.on("damage_event", this.onDamageEvent);
    wire.on("animation", this.onAnimation);
    wire.on("explosion", this.onExplosion);
    this.boundWire = wire;
  }

  private unbindTotemPopEvents(): void {
    const wire = this.boundWire;
    if (wire === null) return;
    if (typeof wire.off === "function") {
      wire.off("entity_status", this.onEntityStatus);
      wire.off("entity_status", this.onEntityStatusBeforeMineflayer);
      wire.off("entity_status", this.onEntityStatusAfterMineflayer);
      wire.off("damage_event", this.onDamageEvent);
      wire.off("animation", this.onAnimation);
      wire.off("explosion", this.onExplosion);
    } else {
      wire.removeListener?.("entity_status", this.onEntityStatus);
      wire.removeListener?.("entity_status", this.onEntityStatusBeforeMineflayer);
      wire.removeListener?.("entity_status", this.onEntityStatusAfterMineflayer);
      wire.removeListener?.("damage_event", this.onDamageEvent);
      wire.removeListener?.("animation", this.onAnimation);
      wire.removeListener?.("explosion", this.onExplosion);
    }
    this.heldItemBeforeForeignStatus = new WeakMap<object, boolean>();
    this.boundWire = null;
  }

  private recordTotemPop(packet: unknown): void {
    const record = asRecord(packet);
    if (record?.entityStatus !== 35) return;
    const entityId = entityStatusEntityId(packet);
    if (entityId === null) return;
    const bot = this.bot as unknown as CombatBotLike;
    const dimension = normalizeDimension(bot.game?.dimension);
    const observedAtMs = this.clock();
    if (
      dimension === null ||
      this.serverProfileId.trim().length === 0 ||
      !Number.isSafeInteger(observedAtMs) ||
      observedAtMs < 0
    ) return;
    try {
      this.totemPopTracker.record({
        entityId,
        observedAtMs,
        serverProfileId: this.serverProfileId,
        dimension,
      });
    } catch {
      // Packet data is untrusted. A malformed or out-of-order event must not
      // take down the Runtime or invent a combat fact.
    }
  }

  private recordEntityHurt(entityId: number | null): void {
    if (entityId === null || this.serverProfileId.trim().length === 0) return;
    const observedAtMs = this.clock();
    if (!Number.isSafeInteger(observedAtMs) || observedAtMs < 0) return;
    try {
      this.hitWindowTracker.recordHurt(
        entityId,
        observedAtMs,
        this.serverProfileId,
      );
    } catch {
      // Wire data and event ordering are untrusted. Refuse the fact without
      // crashing Runtime or extending an old i-frame window.
    }
  }

  private gearSnapshotForEntity(entity: EntityLike): CombatGearSnapshot | null {
    if (!entity.equipment || entity.equipment.length < 4) return null;
    const health = finiteNumber(entity.health) ? Number(entity.health) : null;
    if (health === null || health < 0 || health > 20) return null;
    const armorPoints = this.entityArmorPoints(entity);
    if (armorPoints === null) return null;
    const enchantments = armorEnchantmentFacts(entity.equipment);
    if (enchantments === null) return null;
    return {
      armorMaterial: armorMaterialForItems(entity.equipment, armorPoints),
      protectionLevel: enchantments.protectionLevel,
      blastProtectionLevel: enchantments.blastProtectionLevel,
      armorPieceCount: enchantments.armorPieceCount,
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
    const enchantments = armorEnchantmentFacts(self.equipment ?? []);
    if (enchantments === null) return null;
    const weapon = inventory
      .map((item) => this.weaponCandidate(item))
      .filter((item): item is NonNullable<typeof item> => item !== null)
      .sort((left, right) => right.baseDamage - left.baseDamage)[0];
    return {
      armorMaterial: armorMaterialForItems(self.equipment ?? [], armorPoints),
      protectionLevel: enchantments.protectionLevel,
      blastProtectionLevel: enchantments.blastProtectionLevel,
      armorPieceCount: enchantments.armorPieceCount,
      weaponDamage: weapon?.baseDamage ?? 0,
      health: Math.max(0, Number(self.health)),
      hasTotem: offhand?.name === "totem_of_undying",
    } as const;
  }

  private weaponCandidate(
    item: ItemLike,
    allowOther = false,
  ): CombatWeaponCandidate | null {
    const name = typeof item.name === "string" ? item.name : null;
    if (!name) return null;
    const kindEntry = [...WEAPON_KINDS.entries()].find(([suffix]) => name.endsWith(`_${suffix}`) || name === suffix);
    if (!kindEntry && !allowOther) return null;
    const slot = Number.isSafeInteger(item.slot) ? Number(item.slot) : -1;
    if (slot < 0) return null;
    const kind = kindEntry?.[1] ?? "other";
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
            ammoRemaining: (this.bot as unknown as CombatBotLike).inventory
              ?.items?.()
              .filter((candidate) => candidate.name === "arrow")
              .reduce(
                (sum, candidate) =>
                  sum +
                  (Number.isSafeInteger(candidate.count)
                    ? Number(candidate.count)
                    : 0),
                0,
              ) ?? 0,
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

  /**
   * 已加载实体中是否存在距离给定位置 16 格内的末影水晶。这是敌人
   * crystal PvP 的直接信号（放置的水雷）；16 格覆盖典型引爆半径外的
   * 部署圈。实体表没有水晶就是没有——不存在"未知"态。
   */
  private hasLoadedEndCrystalNearby(position: { x: number; y: number; z: number }): boolean {
    const bot = this.bot;
    if (!bot.entities || typeof bot.entities !== "object") return false;
    return Object.values(bot.entities).some((candidate) => {
      const name =
        typeof candidate.name === "string" ? candidate.name.toLowerCase() : "";
      if (name !== "end_crystal" || !candidate.isValid || candidate.position === undefined) {
        return false;
      }
      return (
        Math.hypot(
          candidate.position.x - position.x,
          candidate.position.y - position.y,
          candidate.position.z - position.z,
        ) <= 16
      );
    });
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

  private entityWieldsRangedWeapon(entity: EntityLike): boolean {
    return (entity.equipment ?? []).some((item) => {
      const name = normalizeItemName(item);
      return name === "bow" || name === "crossbow";
    });
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

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function entityStatusEntityId(packet: unknown): number | null {
  const entityId = asRecord(packet)?.entityId;
  return typeof entityId === "number" &&
      Number.isSafeInteger(entityId) &&
      entityId >= 0
    ? entityId
    : null;
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

function observedAttackCooldownMs(entity: EntityLike): number {
  const heldName = normalizeItemName(entity.equipment?.[0] ?? {});
  const kind = weaponKindForName(heldName);
  if (kind === "axe") return 1_000;
  if (kind === "trident") return 910;
  return 625;
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

function armorEnchantmentFacts(
  items: readonly ItemLike[],
): Readonly<{
  protectionLevel: number;
  blastProtectionLevel: number;
  armorPieceCount: number;
}> | null {
  const armorItems = items.filter((item) => {
    const name = normalizeItemName(item);
    return name !== null && name in ARMOR_POINTS;
  });
  if (armorItems.length > 4) return null;
  if (armorItems.length === 0) {
    return {
      protectionLevel: 0,
      blastProtectionLevel: 0,
      armorPieceCount: 0,
    };
  }

  let protectionTotal = 0;
  let blastProtectionTotal = 0;
  for (const item of armorItems) {
    let enchants: unknown;
    try {
      enchants = item.enchants;
    } catch {
      return null;
    }
    if (!Array.isArray(enchants)) return null;
    for (const enchantment of enchants) {
      const record = asRecord(enchantment);
      const rawName = record?.name;
      const rawLevel = record?.lvl;
      if (
        typeof rawName !== "string" ||
        typeof rawLevel !== "number" ||
        !Number.isFinite(rawLevel) ||
        rawLevel < 0 ||
        rawLevel > 4
      ) {
        return null;
      }
      const name = rawName.toLowerCase().replace(/^minecraft:/u, "");
      if (name === "protection") protectionTotal += rawLevel;
      if (name === "blast_protection") blastProtectionTotal += rawLevel;
    }
  }

  return {
    protectionLevel: protectionTotal / armorItems.length,
    blastProtectionLevel: blastProtectionTotal / armorItems.length,
    armorPieceCount: armorItems.length,
  };
}

import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

const timestampSchema = z.string().datetime({ offset: true });

export const worldPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
  })
  .strict();

export type WorldPosition = z.infer<typeof worldPositionSchema>;

export const inventoryItemSchema = z
  .object({
    itemName: z.string().min(1).max(128),
    count: z.number().int().nonnegative().max(2_147_483_647),
    slot: z.number().int().nonnegative().max(127).nullable().optional(),
    durability: z.number().int().nonnegative().nullable().optional(),
    maxDurability: z.number().int().positive().nullable().optional(),
  })
  .strict();

export type InventoryItem = z.infer<typeof inventoryItemSchema>;

export const inventoryStateSchema = z
  .object({
    items: z.array(inventoryItemSchema).max(512),
    equipment: z.record(z.string().max(32), z.string().max(128).nullable()),
    toolDurability: z.record(z.string().max(128), z.number().int().nonnegative()),
    foodCount: z.number().int().nonnegative().max(2_147_483_647),
    reservedResources: z.record(z.string().max(128), z.number().int().nonnegative()),
  })
  .strict();

export type InventoryState = z.infer<typeof inventoryStateSchema>;

export const nearbyBlockKindSchema = z.string().min(1).max(128).regex(/^[a-z0-9_.:-]+$/u);
export type NearbyBlockKind = z.infer<typeof nearbyBlockKindSchema>;

export const nearbyBlockSchema = z
  .object({
    kind: nearbyBlockKindSchema,
    position: worldPositionSchema,
    dimension: z.string().min(1).max(128),
    lastSeen: timestampSchema,
    reachable: z.boolean(),
    source: z.string().min(1).max(128),
    ownership: z.string().min(1).max(128).nullable(),
    confidence: z.number().finite().min(0).max(1),
    staleAfterMs: z.number().int().positive().max(7 * 24 * 60 * 60_000),
  })
  .strict();

export type NearbyBlock = z.infer<typeof nearbyBlockSchema>;

export const worldEntitySchema = z
  .object({
    entityId: identifierSchema,
    kind: z.string().min(1).max(128),
    position: worldPositionSchema,
    dimension: z.string().min(1).max(128),
    lastSeen: timestampSchema,
    hostile: z.boolean(),
    health: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export type WorldEntity = z.infer<typeof worldEntitySchema>;

const navigationTargetSchema = z
  .object({
    position: worldPositionSchema,
    dimension: z.string().min(1).max(128),
    label: z.string().max(256).nullable().optional(),
  })
  .strict();

export const navigationStateSchema = z
  .object({
    currentGoal: navigationTargetSchema.nullable(),
    path: z.array(worldPositionSchema).max(4_096),
    movementOwner: identifierSchema.nullable(),
    lastPosition: worldPositionSchema.nullable(),
    stuckSince: timestampSchema.nullable(),
    lastFailedTarget: z.string().max(256).nullable(),
    blacklist: z.array(z.string().max(256)).max(512),
  })
  .strict();

export type NavigationState = z.infer<typeof navigationStateSchema>;

export const botWorldStateSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    botId: identifierSchema,
    serverProfileId: identifierSchema,
    dimension: z.string().min(1).max(128),
    version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    updatedAt: timestampSchema,
    inventory: inventoryStateSchema,
    nearbyBlocks: z.array(nearbyBlockSchema).max(8_192),
    entities: z.array(worldEntitySchema).max(4_096),
    navigation: navigationStateSchema,
  })
  .strict();

export type BotWorldState = z.infer<typeof botWorldStateSchema>;
export type WorldState = BotWorldState;

export const workingMemoryEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("inventory"), inventory: inventoryStateSchema }).strict(),
  z.object({ type: z.literal("block"), block: nearbyBlockSchema }).strict(),
  z.object({ type: z.literal("forget_block"), kind: nearbyBlockKindSchema, position: worldPositionSchema }).strict(),
  z.object({ type: z.literal("entity"), entity: worldEntitySchema }).strict(),
  z.object({ type: z.literal("remove_entity"), entityId: identifierSchema }).strict(),
  z.object({ type: z.literal("navigation"), navigation: navigationStateSchema }).strict(),
]);

export type WorkingMemoryEvent = z.infer<typeof workingMemoryEventSchema>;

export type WorkingMemoryStore = Readonly<{
  get(botId: string): BotWorldState | null;
  save(state: BotWorldState): void;
}>;

export class InMemoryWorkingMemoryStore implements WorkingMemoryStore {
  private readonly states = new Map<string, BotWorldState>();

  get(botId: string): BotWorldState | null {
    const state = this.states.get(botId);
    return state === undefined ? null : structuredClone(state);
  }

  save(state: BotWorldState): void {
    const parsed = botWorldStateSchema.parse(state);
    this.states.set(parsed.botId, structuredClone(parsed));
  }
}

export class WorkingMemoryScopeError extends Error {
  readonly code = "WORKING_MEMORY_SCOPE_MISMATCH" as const;

  constructor(message = "Persisted working memory belongs to another world scope.") {
    super(message);
    this.name = "WorkingMemoryScopeError";
  }
}

export type BotWorkingMemoryOptions = Readonly<{
  botId: string;
  serverProfileId: string;
  dimension: string;
  now?: () => Date;
  store?: WorkingMemoryStore;
  initial?: Partial<BotWorldState>;
}>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function timestamp(now: () => Date): string {
  const value = now();
  if (!Number.isFinite(value.getTime())) throw new TypeError("Working memory clock returned an invalid date.");
  return value.toISOString();
}

function emptyInventory(): InventoryState {
  return { items: [], equipment: {}, toolDurability: {}, foodCount: 0, reservedResources: {} };
}

function emptyNavigation(): NavigationState {
  return {
    currentGoal: null,
    path: [],
    movementOwner: null,
    lastPosition: null,
    stuckSince: null,
    lastFailedTarget: null,
    blacklist: [],
  };
}

function blockKey(block: Pick<NearbyBlock, "kind" | "dimension" | "position">): string {
  const { position } = block;
  return `${block.dimension}|${block.kind}|${position.x}|${position.y}|${position.z}`;
}

function entityKey(entity: Pick<WorldEntity, "entityId">): string {
  return entity.entityId;
}

function mergeInventoryItems(items: readonly InventoryItem[]): InventoryItem[] {
  const byName = new Map<string, InventoryItem>();
  for (const item of items) {
    const parsed = inventoryItemSchema.parse(item);
    const existing = byName.get(parsed.itemName);
    if (existing === undefined) {
      byName.set(parsed.itemName, { ...parsed });
    } else {
      byName.set(parsed.itemName, {
        ...existing,
        count: existing.count + parsed.count,
        durability: parsed.durability ?? existing.durability,
        maxDurability: parsed.maxDurability ?? existing.maxDurability,
      });
    }
  }
  return [...byName.values()].sort((left, right) => left.itemName.localeCompare(right.itemName));
}

/**
 * Event-driven per-bot working memory. It has no model dependency: Mineflayer
 * events can update it at tick speed while a slow planner is unavailable.
 */
export class BotWorkingMemory {
  private readonly now: () => Date;
  private readonly store: WorkingMemoryStore | null;
  private state: BotWorldState;

  constructor(options: BotWorkingMemoryOptions) {
    const botId = identifierSchema.parse(options.botId);
    const serverProfileId = identifierSchema.parse(options.serverProfileId);
    const now = options.now ?? (() => new Date());
    this.now = now;
    this.store = options.store ?? null;
    const stored = this.store?.get(botId);
    if (
      stored !== null &&
      stored !== undefined &&
      (stored.serverProfileId !== serverProfileId || stored.dimension !== options.dimension)
    ) {
      throw new WorkingMemoryScopeError();
    }
    const currentTimestamp = timestamp(now);
    const initial = options.initial ?? {};
    this.state = botWorldStateSchema.parse({
      schemaVersion: "1.0",
      version: 0,
      updatedAt: currentTimestamp,
      inventory: emptyInventory(),
      nearbyBlocks: [],
      entities: [],
      navigation: emptyNavigation(),
      ...(stored ?? {}),
      ...initial,
      botId,
      serverProfileId,
      dimension: options.dimension,
    });
  }

  get botId(): string {
    return this.state.botId;
  }

  get version(): number {
    return this.state.version;
  }

  /** Returns a defensive snapshot; callers cannot mutate the cache in place. */
  snapshot(): BotWorldState {
    return clone(this.state);
  }

  getState(): BotWorldState {
    return this.snapshot();
  }

  applyEvent(input: WorkingMemoryEvent): BotWorldState {
    const event = workingMemoryEventSchema.parse(input);
    switch (event.type) {
      case "inventory":
        this.state.inventory = clone(event.inventory);
        break;
      case "block":
        this.assertDimension(event.block.dimension);
        this.upsertBlock(event.block);
        break;
      case "forget_block":
        this.state.nearbyBlocks = this.state.nearbyBlocks.filter(
          (block) =>
            blockKey(block) !==
            blockKey({ kind: event.kind, dimension: this.state.dimension, position: event.position }),
        );
        break;
      case "entity":
        this.assertDimension(event.entity.dimension);
        this.state.entities = [
          ...this.state.entities.filter((entity) => entityKey(entity) !== entityKey(event.entity)),
          clone(event.entity),
        ];
        break;
      case "remove_entity":
        this.state.entities = this.state.entities.filter((entity) => entity.entityId !== event.entityId);
        break;
      case "navigation":
        this.state.navigation = clone(event.navigation);
        break;
    }
    return this.commit();
  }

  replaceInventory(inventory: InventoryState | readonly InventoryItem[]): BotWorldState {
    const parsed = Array.isArray(inventory)
      ? { ...emptyInventory(), items: mergeInventoryItems(inventory) }
      : inventoryStateSchema.parse(inventory);
    this.state.inventory = clone(parsed);
    return this.commit();
  }

  /** Update one item count without requiring a model round trip. */
  updateInventory(itemName: string, count: number, details: Readonly<Partial<InventoryItem>> = {}): BotWorldState {
    const parsedName = z.string().min(1).max(128).parse(itemName);
    if (!Number.isInteger(count) || count < 0) throw new RangeError("Inventory count must be a nonnegative integer.");
    const items = this.state.inventory.items.filter((item) => item.itemName !== parsedName);
    if (count > 0) {
      items.push(inventoryItemSchema.parse({ ...details, itemName: parsedName, count }));
    }
    this.state.inventory = { ...this.state.inventory, items: mergeInventoryItems(items) };
    return this.commit();
  }

  setInventory(inventory: InventoryState | readonly InventoryItem[]): BotWorldState {
    return this.replaceInventory(inventory);
  }

  observeBlock(block: NearbyBlock): BotWorldState {
    const parsed = nearbyBlockSchema.parse(block);
    this.assertDimension(parsed.dimension);
    this.upsertBlock(parsed);
    return this.commit();
  }

  forgetBlock(kind: NearbyBlockKind, position: WorldPosition): BotWorldState {
    return this.applyEvent({ type: "forget_block", kind, position });
  }

  observeEntity(entity: WorldEntity): BotWorldState {
    const parsed = worldEntitySchema.parse(entity);
    this.assertDimension(parsed.dimension);
    this.state.entities = [
      ...this.state.entities.filter((item) => item.entityId !== parsed.entityId),
      clone(parsed),
    ];
    return this.commit();
  }

  removeEntity(entityId: string): BotWorldState {
    const parsed = identifierSchema.parse(entityId);
    this.state.entities = this.state.entities.filter((entity) => entity.entityId !== parsed);
    return this.commit();
  }

  updateNavigation(patch: Partial<NavigationState>): BotWorldState {
    this.state.navigation = navigationStateSchema.parse({ ...this.state.navigation, ...patch });
    return this.commit();
  }

  setMovementOwner(owner: string | null): BotWorldState {
    return this.updateNavigation({ movementOwner: owner });
  }

  /**
   * Switches the connected world scope. Old observations are discarded before
   * the new scope is committed, so coordinates from another server/dimension
   * cannot leak into a fresh plan.
   */
  switchWorld(serverProfileId: string, dimension: string): BotWorldState {
    const nextServerProfileId = identifierSchema.parse(serverProfileId);
    const nextDimension = z.string().min(1).max(128).parse(dimension);
    this.state = botWorldStateSchema.parse({
      ...this.state,
      serverProfileId: nextServerProfileId,
      dimension: nextDimension,
      version: this.state.version + 1,
      updatedAt: timestamp(this.now),
      nearbyBlocks: [],
      entities: [],
      navigation: emptyNavigation(),
    });
    this.store?.save(this.state);
    return this.snapshot();
  }

  /** Alias for reconnect handlers that replace the active profile. */
  resetWorld(serverProfileId: string, dimension: string): BotWorldState {
    return this.switchWorld(serverProfileId, dimension);
  }

  reserveResource(itemName: string, count: number): BotWorldState {
    const parsedName = z.string().min(1).max(128).parse(itemName);
    if (!Number.isInteger(count) || count <= 0) throw new RangeError("Reserved resource count must be positive.");
    const available = this.itemCount(parsedName) - (this.state.inventory.reservedResources[parsedName] ?? 0);
    if (count > available) throw new Error(`Insufficient unreserved resource: ${parsedName}.`);
    this.state.inventory = {
      ...this.state.inventory,
      reservedResources: {
        ...this.state.inventory.reservedResources,
        [parsedName]: (this.state.inventory.reservedResources[parsedName] ?? 0) + count,
      },
    };
    return this.commit();
  }

  releaseResource(itemName: string, count?: number): BotWorldState {
    const parsedName = z.string().min(1).max(128).parse(itemName);
    if (count !== undefined && (!Number.isInteger(count) || count <= 0)) {
      throw new RangeError("Released resource count must be positive.");
    }
    const current = this.state.inventory.reservedResources[parsedName] ?? 0;
    const released = count === undefined ? current : Math.min(current, Math.max(0, count));
    const reservedResources = { ...this.state.inventory.reservedResources };
    if (current - released === 0) delete reservedResources[parsedName];
    else reservedResources[parsedName] = current - released;
    this.state.inventory = { ...this.state.inventory, reservedResources };
    return this.commit();
  }

  itemCount(itemName: string): number {
    return this.state.inventory.items
      .filter((item) => item.itemName === itemName)
      .reduce((sum, item) => sum + item.count, 0);
  }

  hasItem(itemName: string, count = 1): boolean {
    return this.itemCount(itemName) >= count;
  }

  nearbyBlocks(kind?: NearbyBlockKind, radius = Number.POSITIVE_INFINITY): readonly NearbyBlock[] {
    const parsedKind = kind === undefined ? undefined : nearbyBlockKindSchema.parse(kind);
    if (!Number.isFinite(radius) && radius !== Number.POSITIVE_INFINITY) throw new RangeError("Block radius is invalid.");
    if (radius < 0) throw new RangeError("Block radius must be nonnegative.");
    const center = this.state.navigation.lastPosition;
    const radiusSquared = radius === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : radius * radius;
    return this.state.nearbyBlocks
      .filter((block) => block.dimension === this.state.dimension && (parsedKind === undefined || block.kind === parsedKind))
      .filter((block) => center === null || distanceSquared(center, block.position) <= radiusSquared)
      .sort((left, right) => {
        if (center === null) return left.lastSeen.localeCompare(right.lastSeen);
        return distanceSquared(center, left.position) - distanceSquared(center, right.position);
      })
      .map(clone);
  }

  getNearbyBlocks(kind?: NearbyBlockKind, radius = Number.POSITIVE_INFINITY): readonly NearbyBlock[] {
    return this.nearbyBlocks(kind, radius);
  }

  nearestBlock(kind: NearbyBlockKind, radius = Number.POSITIVE_INFINITY): NearbyBlock | null {
    return this.nearbyBlocks(kind, radius)[0] ?? null;
  }

  isBlockAvailable(kind: NearbyBlockKind, radius = 16): boolean {
    return this.nearbyBlocks(kind, radius).some((block) => block.reachable && !this.isStale(block));
  }

  isCraftingTableAvailable(radius = 16): boolean {
    return this.isBlockAvailable("crafting_table", radius);
  }

  isStale(block: NearbyBlock): boolean {
    const age = Date.parse(timestamp(this.now)) - Date.parse(block.lastSeen);
    return age < 0 || age > block.staleAfterMs;
  }

  private upsertBlock(block: NearbyBlock): void {
    const key = blockKey(block);
    this.state.nearbyBlocks = [
      ...this.state.nearbyBlocks.filter((item) => blockKey(item) !== key),
      clone(block),
    ];
  }

  private assertDimension(dimension: string): void {
    if (dimension !== this.state.dimension) {
      throw new WorkingMemoryScopeError(
        "Working memory observation belongs to another dimension.",
      );
    }
  }

  private commit(): BotWorldState {
    this.state = botWorldStateSchema.parse({
      ...this.state,
      version: this.state.version + 1,
      updatedAt: timestamp(this.now),
    });
    this.store?.save(this.state);
    return this.snapshot();
  }
}

/** Alias makes the per-bot ownership explicit in callers. */
export const PersistentBotWorkingMemory = BotWorkingMemory;

function distanceSquared(left: WorldPosition, right: WorldPosition): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  const dz = left.z - right.z;
  return dx * dx + dy * dy + dz * dz;
}

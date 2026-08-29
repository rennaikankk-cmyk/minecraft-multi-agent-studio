export const importantBlockNames = [
  "crafting_table",
  "furnace",
  "blast_furnace",
  "smoker",
  "chest",
  "barrel",
  "bed",
  "shulker_box",
  "water",
  "lava",
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
  "coal_ore",
  "iron_ore",
  "diamond_ore",
  "wheat",
  "carrots",
  "potatoes",
] as const;

export type ImportantBlockName = (typeof importantBlockNames)[number] | string;

export type WorldPosition = Readonly<{
  x: number;
  y: number;
  z: number;
  dimension: string;
  serverProfileId: string;
}>;

export type InventoryItemState = Readonly<{
  name: string;
  count: number;
  durability: number | null;
  maxDurability: number | null;
}>;

export type NearbyBlockState = Readonly<{
  name: ImportantBlockName;
  position: WorldPosition;
  lastSeen: string;
  reachable: boolean | null;
  source: "observation" | "memory" | "placed" | "unknown";
  confidence: number;
}>;

export type EntityState = Readonly<{
  entityId: string;
  name: string;
  position: WorldPosition;
  hostile: boolean | null;
  lastSeen: string;
  confidence: number;
}>;

export type NavigationState = Readonly<{
  target: WorldPosition | null;
  movementOwner: string | null;
  pathLength: number | null;
  pathResetCount: number;
  stuckSince: string | null;
  lastFailureTarget: string | null;
  blacklist: readonly string[];
}>;

export type WorldStateSnapshot = Readonly<{
  version: number;
  observedAt: string;
  position: WorldPosition | null;
  inventory: readonly InventoryItemState[];
  reservedResources: Readonly<Record<string, number>>;
  nearbyBlocks: readonly NearbyBlockState[];
  entities: readonly EntityState[];
  navigation: NavigationState;
}>;

export type WorldStateObservation = Readonly<{
  observedAt: Date;
  position?: WorldPosition | null;
  inventory?: readonly InventoryItemState[];
  nearbyBlocks?: readonly NearbyBlockState[];
  /** True when nearbyBlocks is a complete scan for the current world scope. */
  replaceNearbyBlocks?: boolean;
  entities?: readonly EntityState[];
  navigation?: Partial<NavigationState>;
}>;

const emptyNavigation = (): NavigationState => Object.freeze({
  target: null,
  movementOwner: null,
  pathLength: null,
  pathResetCount: 0,
  stuckSince: null,
  lastFailureTarget: null,
  blacklist: Object.freeze([]),
});

function clonePosition(value: WorldPosition | null): WorldPosition | null {
  return value === null ? null : Object.freeze({ ...value });
}

function inventoryMap(items: readonly InventoryItemState[]): Map<string, InventoryItemState> {
  const result = new Map<string, InventoryItemState>();
  for (const item of items) {
    if (!item.name || !Number.isSafeInteger(item.count) || item.count < 0) continue;
    const current = result.get(item.name);
    result.set(item.name, Object.freeze({
      name: item.name,
      count: (current?.count ?? 0) + item.count,
      durability: item.durability ?? current?.durability ?? null,
      maxDurability: item.maxDurability ?? current?.maxDurability ?? null,
    }));
  }
  return result;
}

/** Event-driven cache owned by one Bot.  The cache is authoritative for what
 * was observed, while callers can use `version` to reject stale plans. */
export class WorldStateStore {
  private version = 0;
  private observedAt = new Date(0).toISOString();
  private position: WorldPosition | null = null;
  private inventory: readonly InventoryItemState[] = Object.freeze([]);
  private readonly blocks = new Map<string, NearbyBlockState>();
  private readonly entities = new Map<string, EntityState>();
  private reservedResources = new Map<string, number>();
  private navigation: NavigationState = emptyNavigation();

  observe(observation: WorldStateObservation): number {
    const time = observation.observedAt;
    if (!Number.isFinite(time.getTime())) throw new TypeError("World observation time is invalid.");
    const before = this.materialFingerprint();
    if (observation.position !== undefined) {
      this.position = clonePosition(observation.position);
    }
    if (observation.inventory !== undefined) {
      const normalized = [...inventoryMap(observation.inventory).values()].sort((a, b) => a.name.localeCompare(b.name));
      this.inventory = Object.freeze(normalized.map((item) => Object.freeze({ ...item })));
    }
    if (observation.nearbyBlocks !== undefined) {
      if (observation.replaceNearbyBlocks === true && this.position !== null) {
        for (const [key, block] of this.blocks) {
          if (
            block.source === "observation" &&
            block.position.serverProfileId === this.position.serverProfileId &&
            block.position.dimension === this.position.dimension
          ) {
            this.blocks.delete(key);
          }
        }
      }
      for (const block of observation.nearbyBlocks) {
        if (!this.validBlock(block)) continue;
        this.blocks.set(this.blockKey(block.position), Object.freeze({ ...block }));
      }
    }
    if (observation.entities !== undefined) {
      const observedIds = new Set<string>();
      for (const entity of observation.entities) {
        if (!entity.entityId || !this.validPosition(entity.position)) continue;
        observedIds.add(entity.entityId);
        this.entities.set(entity.entityId, Object.freeze({ ...entity }));
      }
      for (const entityId of this.entities.keys()) {
        if (!observedIds.has(entityId)) this.entities.delete(entityId);
      }
    }
    if (observation.navigation !== undefined) {
      this.navigation = Object.freeze({ ...this.navigation, ...observation.navigation, blacklist: Object.freeze([...(observation.navigation.blacklist ?? this.navigation.blacklist)]) });
    }
    this.observedAt = time.toISOString();
    if (before !== this.materialFingerprint()) this.version += 1;
    return this.version;
  }

  recordBlock(block: NearbyBlockState): number {
    return this.observe({ observedAt: new Date(block.lastSeen), nearbyBlocks: [block] });
  }

  forgetBlock(position: WorldPosition): number {
    if (this.blocks.delete(this.blockKey(position))) this.version += 1;
    return this.version;
  }

  setReservedResources(resources: Readonly<Record<string, number>>): number {
    const next = new Map<string, number>();
    for (const [name, count] of Object.entries(resources)) {
      if (Number.isSafeInteger(count) && count > 0) next.set(name, count);
    }
    const before = JSON.stringify([...this.reservedResources].sort());
    this.reservedResources = next;
    if (before !== JSON.stringify([...next].sort())) this.version += 1;
    return this.version;
  }

  reserve(itemName: string, count: number): boolean {
    if (!itemName || !Number.isSafeInteger(count) || count < 1) return false;
    const available = this.inventoryCount(itemName) - (this.reservedResources.get(itemName) ?? 0);
    if (available < count) return false;
    this.reservedResources.set(itemName, (this.reservedResources.get(itemName) ?? 0) + count);
    this.version += 1;
    return true;
  }

  release(itemName: string, count: number): void {
    if (!itemName || !Number.isSafeInteger(count) || count < 1) return;
    const current = this.reservedResources.get(itemName) ?? 0;
    if (current === 0) return;
    const next = Math.max(0, current - count);
    if (next === 0) this.reservedResources.delete(itemName);
    else this.reservedResources.set(itemName, next);
    this.version += 1;
  }

  inventoryCount(itemName: string): number {
    return this.inventory.find((item) => item.name === itemName)?.count ?? 0;
  }

  findNearbyBlock(name: string, options: Readonly<{ dimension?: string; maxDistance?: number; reachableOnly?: boolean }> = {}): NearbyBlockState | null {
    const origin = this.position;
    if (!origin) return null;
    let best: NearbyBlockState | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const block of this.blocks.values()) {
      // P0-B10: serverProfileId + dimension 是不可省略的复合过滤键——
      // 跨服的方块坐标拿来当前服导航是致命错误。
      if (block.name !== name) continue;
      if (block.position.serverProfileId !== origin.serverProfileId) continue;
      if (block.position.dimension !== origin.dimension) continue;
      if (options.dimension && block.position.dimension !== options.dimension) continue;
      if (options.reachableOnly && block.reachable !== true) continue;
      const distance = Math.hypot(block.position.x - origin.x, block.position.y - origin.y, block.position.z - origin.z);
      if (options.maxDistance !== undefined && distance > options.maxDistance) continue;
      if (distance < bestDistance) { best = block; bestDistance = distance; }
    }
    return best;
  }

  snapshot(): WorldStateSnapshot {
    return Object.freeze({
      version: this.version,
      observedAt: this.observedAt,
      position: clonePosition(this.position),
      inventory: Object.freeze(this.inventory.map((item) => Object.freeze({ ...item }))),
      reservedResources: Object.freeze(Object.fromEntries(this.reservedResources)),
      nearbyBlocks: Object.freeze([...this.blocks.values()].map((block) => Object.freeze({ ...block, position: clonePosition(block.position)! }))),
      entities: Object.freeze([...this.entities.values()].map((entity) => Object.freeze({ ...entity, position: clonePosition(entity.position)! }))),
      navigation: Object.freeze({ ...this.navigation, target: clonePosition(this.navigation.target), blacklist: Object.freeze([...this.navigation.blacklist]) }),
    });
  }

  private blockKey(position: WorldPosition): string {
    return `${position.serverProfileId}|${position.dimension}|${position.x}|${position.y}|${position.z}`;
  }

  private validPosition(position: WorldPosition): boolean {
    return Boolean(position.serverProfileId && position.dimension && [position.x, position.y, position.z].every(Number.isFinite));
  }

  private validBlock(block: NearbyBlockState): boolean {
    return Boolean(block.name && this.validPosition(block.position) && Number.isFinite(Date.parse(block.lastSeen)) && Number.isFinite(block.confidence) && block.confidence >= 0 && block.confidence <= 1);
  }

  /** Version only plan-relevant changes; observation timestamps and mob jitter
   * must not invalidate every slow planner response. */
  private materialFingerprint(): string {
    const positionScope = this.position === null
      ? null
      : {
          dimension: this.position.dimension,
          serverProfileId: this.position.serverProfileId,
        };
    const blocks = [...this.blocks.values()]
      .map(({ lastSeen: _lastSeen, ...block }) => block)
      .sort((left, right) =>
        this.blockKey(left.position).localeCompare(this.blockKey(right.position)),
      );
    const entities = [...this.entities.values()]
      .map(({ lastSeen: _lastSeen, position: _position, ...entity }) => entity)
      .sort((left, right) => left.entityId.localeCompare(right.entityId));
    const {
      pathLength: _pathLength,
      stuckSince: _stuckSince,
      ...planRelevantNavigation
    } = this.navigation;
    return JSON.stringify({
      positionScope,
      inventory: this.inventory,
      blocks,
      entities,
      navigation: planRelevantNavigation,
    });
  }
}

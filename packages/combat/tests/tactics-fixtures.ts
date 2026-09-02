// 战术核心测试夹具：最小快照/belief 构造器。只含测试数据形状，无生产逻辑。
import type { EnemyBeliefState } from "../src/tactics/belief.js";
import type { CombatSnapshot, OurCombatState } from "../src/tactics/snapshot.js";

export function beliefFixture(overrides: Partial<EnemyBeliefState> = {}): EnemyBeliefState {
  return {
    entityId: 42,
    uuid: "00000000-0000-0000-0000-000000000042",
    username: "EnemyFixture",
    classification: "HOSTILE",
    lastObservedAtMs: 10_000,
    position: { x: 2, y: 64, z: 0 },
    velocityInterval: {
      min: { x: -7, y: -7, z: -7 },
      max: { x: 7, y: 7, z: 7 },
    },
    lineOfSight: true,
    tracking: "IN_RANGE",
    equipment: { heldItem: "minecraft:netherite_sword", offhandItem: null, armorPieces: [], componentsStripped: false },
    blockingWithShield: false,
    usingItem: { kind: null, startedAtMs: null },
    health: {
      intervalHp: { lo: 8, hi: 20 },
      absorption: { possible: false, certainHp: 0 },
      distribution: "UNIFORM",
      pointSource: { kind: null, trustedServer: false },
      lastUpdateEvidence: "PRIOR",
    },
    observedTotemPops: 0,
    lastTotemPopAtMs: null,
    attackCadence: { samples: 0, meanIntervalMs: null },
    critRate: { samples: 0, rate: null },
    pingMs: 80,
    opponentProfile: "UNPROFILED",
    confidence: 0.3,
    evidenceRefs: ["prior@42"],
    ...overrides,
  } as EnemyBeliefState;
}

export function selfFixture(overrides: Partial<OurCombatState> = {}): OurCombatState {
  return {
    health: 20,
    absorption: 0,
    food: 20,
    effects: [],
    armor: { points: 0, toughness: 0, durabilityCritical: false },
    weapon: { id: "minecraft:netherite_sword", cooldownProgress: 1 },
    offhand: { item: null, totemReady: false },
    totemsAvailable: 0,
    consumables: { goldenApples: 3, healingPotions: 0, shieldDurabilityOk: true },
    crystalMaterials: { crystals: 0, obsidian: 0, glowstone: 0 },
    onGround: true,
    inWater: false,
    position: { x: 0, y: 64, z: 0 },
    nearestCover: { distanceBlocks: null },
    escapeRoutes: [
      { direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 6, blocked: false },
    ],
    pingMs: 80,
    rttEstimateMs: 120,
    recentSetbacks: 0,
    goal: { criticalInventory: false, migrating: false },
    inventoryValueBand: "NORMAL",
    deathRecoveryFeasible: true,
    stance: "expendable",
    ...overrides,
  } as OurCombatState;
}

export function snapshotFixture(overrides: {
  self?: Partial<OurCombatState>;
  target?: EnemyBeliefState | null;
  nowMonotonicMs?: number;
  allies?: CombatSnapshot["allies"];
  world?: Partial<CombatSnapshot["world"]>;
  policy?: Partial<CombatSnapshot["policy"]>;
} = {}): CombatSnapshot {
  const now = overrides.nowMonotonicMs ?? 10_000;
  return {
    nowMonotonicMs: now,
    stepMs: 100,
    self: selfFixture(overrides.self),
    target:
      overrides.target === undefined
        ? beliefFixture({ lastObservedAtMs: now })
        : overrides.target,
    otherEnemies: [],
    allies: overrides.allies ?? [],
    world: {
      dimension: "overworld",
      crystalPlacementsAvailable: 0,
      enemyCrystalThreat: false,
      enemyAnchorThreat: false,
      hostileCount: 1,
      reinforcementEtaMs: null,
      ...overrides.world,
    },
    policy: {
      gameplayProfile: "anarchy_first",
      compatMode: "EXPLICIT_UNRESTRICTED",
      explosiveCrystalGateOpen: false,
      respawnAnchorGateOpen: false,
      serverRejectionSignals: 0,
      ...overrides.policy,
    },
  };
}

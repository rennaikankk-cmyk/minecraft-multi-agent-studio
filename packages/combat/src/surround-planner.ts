/**
 * Deterministic surround / hole-fill planning. No clock, AI, or world access.
 *
 * The caller injects every occupancy result and the current ServerPolicy reach.
 * Unknown occupancy is never treated as air. Retreat always wins, so this
 * planner cannot wall in a bot that is already trying to leave combat.
 */

import { BLAST_POWER, entityRangeFor } from "./blast-model.js";
import type { CombatVector3 } from "./threat-analyzer.js";

export const SURROUND_BLAST_RESISTANCE = 1_200;

export type CombatSurroundBlockClass =
  | "obsidian"
  | "crying_obsidian"
  | "ancient_debris"
  | "netherite_block"
  | "respawn_anchor";

export type CombatSurroundOffsetRole =
  | "cardinal"
  | "below"
  | "above"
  | "diagonal";

export type CombatSurroundOccupancy = Readonly<{
  state: "replaceable" | "occupied" | "unknown";
  /** Required for occupied; null for replaceable/unknown. */
  blastResistance: number | null;
}>;

export type CombatSurroundOccupancyQuery = (
  position: CombatVector3,
) => CombatSurroundOccupancy;

export type CombatSurroundInventoryBlock = Readonly<{
  blockClass: CombatSurroundBlockClass;
  count: number;
}>;

export type CombatSurroundThreatDirection = Readonly<{
  /** Direction from self toward the threat. It need not already be normalized. */
  direction: CombatVector3;
  weight: number;
}>;

export type CombatSurroundExplosiveReadiness =
  | Readonly<{
      /** Melee/ranged combat, or no committed explosive tactic. */
      mode: "NONE";
      inventoryVerified: false;
      candidateVerified: false;
    }>
  | Readonly<{
      mode: "CRYSTAL" | "ANCHOR";
      /** Required items were observed in the live inventory snapshot. */
      inventoryVerified: boolean;
      /** CrystalEngine/AnchorEngine accepted at least one current candidate. */
      candidateVerified: boolean;
    }>;

export type CombatSurroundSnapshot = Readonly<{
  selfFootPosition: CombatVector3;
  occupancy: CombatSurroundOccupancyQuery;
  inventoryBlocks: readonly CombatSurroundInventoryBlock[];
  /** Current ServerPolicy blockInteractionReach. */
  reachDistance: number;
  threatDirections: readonly CombatSurroundThreatDirection[];
  /** Desired fraction of the local shell, in (0, 1]. */
  coverageObjective01: number;
  retreatInProgress: boolean;
  /**
   * Surround sacrifices mobility and is therefore restricted to a committed,
   * currently viable explosive tactic. Merely carrying explosive items while
   * fighting with a sword or bow is not enough.
   */
  explosiveCombat: CombatSurroundExplosiveReadiness;
}>;

export type CombatSurroundProtectionEffect =
  | "MODELED_EXPOSURE_AND_PLACEMENT"
  | "PLACEMENT_DENIAL_ONLY";

export type CombatSurroundPlacement = Readonly<{
  position: CombatVector3;
  blockClass: CombatSurroundBlockClass;
  blastResistance: number;
  offsetRole: CombatSurroundOffsetRole;
  protectionEffect: CombatSurroundProtectionEffect;
  /** Higher values were closer to the weighted hostile direction. */
  threatPriority: number;
}>;

export type CombatSurroundExposedOffset = Readonly<{
  position: CombatVector3;
  offsetRole: CombatSurroundOffsetRole;
  reason:
    | "OUT_OF_REACH"
    | "OCCUPIED_WEAK"
    | "OCCUPANCY_UNKNOWN"
    | "OBJECTIVE_NOT_SELECTED"
    | "INVENTORY_EXHAUSTED";
  protectionEffect: CombatSurroundProtectionEffect;
}>;

export type CombatSurroundRefusalCode =
  | "RETREAT_IN_PROGRESS"
  | "EXPLOSIVE_COMBAT_NOT_READY"
  | "NO_BLAST_RESISTANT_BLOCKS"
  | "ALL_OFFSETS_OUT_OF_REACH"
  | "ALL_OFFSETS_OCCUPIED";

export type CombatSurroundPlan = Readonly<{
  placements: readonly CombatSurroundPlacement[];
  refusal: CombatSurroundRefusalCode | null;
  coverageAchieved01: number;
  coverageObjective01: number;
  objectiveMet: boolean;
  exposedOffsets: readonly CombatSurroundExposedOffset[];
  existingProtectedCount: number;
  /** Shared model ranges used when reporting the local shell's blast context. */
  blastRangesUsed: Readonly<{ crystal: number; anchor: number }>;
}>;

type OffsetDefinition = Readonly<{
  offset: CombatVector3;
  role: CombatSurroundOffsetRole;
  tier: number;
  stableOrder: number;
  effect: CombatSurroundProtectionEffect;
}>;

// The first five entries preserve the standard four-sided shell plus floor.
// Head-height cardinals deny anchor placements on top of that first ring;
// overhead and diagonals extend coverage when the requested objective is high.
const OFFSETS: readonly OffsetDefinition[] = [
  offset(0, 0, -1, "cardinal", 0, 0, true),
  offset(1, 0, 0, "cardinal", 0, 1, true),
  offset(0, 0, 1, "cardinal", 0, 2, true),
  offset(-1, 0, 0, "cardinal", 0, 3, true),
  offset(0, -1, 0, "below", 1, 4, false),
  offset(0, 1, -1, "cardinal", 2, 5, true),
  offset(1, 1, 0, "cardinal", 2, 6, true),
  offset(0, 1, 1, "cardinal", 2, 7, true),
  offset(-1, 1, 0, "cardinal", 2, 8, true),
  offset(0, 2, 0, "above", 3, 9, true),
  offset(1, 0, 1, "diagonal", 4, 10, false),
  offset(-1, 0, 1, "diagonal", 4, 11, false),
  offset(1, 0, -1, "diagonal", 4, 12, false),
  offset(-1, 0, -1, "diagonal", 4, 13, false),
];

const BLOCK_PREFERENCE: readonly CombatSurroundBlockClass[] = [
  "obsidian",
  "crying_obsidian",
  "ancient_debris",
  "netherite_block",
  // A respawn anchor is structurally strong but creates an anchor interaction
  // surface, so it is consumed only after every inert option.
  "respawn_anchor",
];

const BLAST_RANGES = Object.freeze({
  crystal: entityRangeFor(BLAST_POWER.crystal),
  anchor: entityRangeFor(BLAST_POWER.anchor),
});

export class SurroundPlanner {
  plan(snapshot: CombatSurroundSnapshot): CombatSurroundPlan {
    validateSnapshot(snapshot);
    if (snapshot.retreatInProgress) {
      return emptyPlan(snapshot, "RETREAT_IN_PROGRESS");
    }
    if (
      snapshot.explosiveCombat.mode === "NONE" ||
      !snapshot.explosiveCombat.inventoryVerified ||
      !snapshot.explosiveCombat.candidateVerified
    ) {
      return emptyPlan(snapshot, "EXPLOSIVE_COMBAT_NOT_READY");
    }

    const inventory = inventoryQueue(snapshot.inventoryBlocks);
    if (inventory.length === 0) {
      return emptyPlan(snapshot, "NO_BLAST_RESISTANT_BLOCKS");
    }

    const evaluated = OFFSETS.map((definition) => {
      const position = add(snapshot.selfFootPosition, definition.offset);
      const withinReach = blockCenterDistance(
        snapshot.selfFootPosition,
        position,
      ) <= snapshot.reachDistance;
      const occupancy = withinReach ? snapshot.occupancy(position) : null;
      if (occupancy !== null) validateOccupancy(occupancy);
      return {
        definition,
        position,
        withinReach,
        occupancy,
        threatPriority: threatPriority(
          definition.offset,
          snapshot.threatDirections,
        ),
      };
    });

    const inReach = evaluated.filter(({ withinReach }) => withinReach);
    if (inReach.length === 0) {
      return planFromEvaluation(
        snapshot,
        [],
        "ALL_OFFSETS_OUT_OF_REACH",
        evaluated,
        new Set<number>(),
        Math.ceil(snapshot.coverageObjective01 * OFFSETS.length),
      );
    }

    const existingProtected = new Set(
      inReach
        .filter(({ occupancy }) =>
          occupancy?.state === "occupied" &&
          (occupancy.blastResistance ?? 0) >= SURROUND_BLAST_RESISTANCE
        )
        .map(({ definition }) => definition.stableOrder),
    );
    const requiredProtected = Math.ceil(
      snapshot.coverageObjective01 * OFFSETS.length,
    );
    if (existingProtected.size >= requiredProtected) {
      return planFromEvaluation(
        snapshot,
        [],
        null,
        evaluated,
        existingProtected,
        requiredProtected,
      );
    }

    const replaceable = inReach.filter(
      ({ occupancy }) => occupancy?.state === "replaceable",
    );
    if (replaceable.length === 0) {
      return planFromEvaluation(
        snapshot,
        [],
        "ALL_OFFSETS_OCCUPIED",
        evaluated,
        existingProtected,
        requiredProtected,
      );
    }

    replaceable.sort((left, right) =>
      left.definition.tier - right.definition.tier ||
      right.threatPriority - left.threatPriority ||
      left.definition.stableOrder - right.definition.stableOrder
    );
    const placementCount = Math.min(
      inventory.length,
      Math.max(0, requiredProtected - existingProtected.size),
      replaceable.length,
    );
    const selected = replaceable.slice(0, placementCount);
    const placements = selected.map((candidate, index) => ({
      position: candidate.position,
      blockClass: inventory[index]!,
      blastResistance: SURROUND_BLAST_RESISTANCE,
      offsetRole: candidate.definition.role,
      protectionEffect: candidate.definition.effect,
      threatPriority: candidate.threatPriority,
    }));
    const plannedProtected = new Set([
      ...existingProtected,
      ...selected.map(({ definition }) => definition.stableOrder),
    ]);
    return planFromEvaluation(
      snapshot,
      placements,
      null,
      evaluated,
      plannedProtected,
      requiredProtected,
    );
  }
}

function planFromEvaluation(
  snapshot: CombatSurroundSnapshot,
  placements: readonly CombatSurroundPlacement[],
  refusal: CombatSurroundRefusalCode | null,
  evaluated: readonly {
    definition: OffsetDefinition;
    position: CombatVector3;
    withinReach: boolean;
    occupancy: CombatSurroundOccupancy | null;
  }[],
  protectedOffsets: ReadonlySet<number>,
  requiredProtected: number,
): CombatSurroundPlan {
  const selectedPositions = new Set(
    placements.map(({ position }) => positionKey(position)),
  );
  const objectiveMet = protectedOffsets.size >= requiredProtected;
  const exposedOffsets = evaluated
    .filter(({ definition }) => !protectedOffsets.has(definition.stableOrder))
    .map(({ definition, position, withinReach, occupancy }) => ({
      position,
      offsetRole: definition.role,
      reason: !withinReach
        ? "OUT_OF_REACH" as const
        : occupancy?.state === "unknown"
          ? "OCCUPANCY_UNKNOWN" as const
          : occupancy?.state === "occupied"
            ? "OCCUPIED_WEAK" as const
            : selectedPositions.has(positionKey(position)) || objectiveMet
              ? "OBJECTIVE_NOT_SELECTED" as const
              : "INVENTORY_EXHAUSTED" as const,
      protectionEffect: definition.effect,
    }));
  const coverageAchieved01 = protectedOffsets.size / OFFSETS.length;
  return {
    placements,
    refusal,
    coverageAchieved01,
    coverageObjective01: snapshot.coverageObjective01,
    objectiveMet,
    exposedOffsets,
    existingProtectedCount: evaluated.filter(({ definition, occupancy }) =>
      protectedOffsets.has(definition.stableOrder) &&
      occupancy?.state === "occupied"
    ).length,
    blastRangesUsed: BLAST_RANGES,
  };
}

function emptyPlan(
  snapshot: CombatSurroundSnapshot,
  refusal: CombatSurroundRefusalCode,
): CombatSurroundPlan {
  return {
    placements: [],
    refusal,
    coverageAchieved01: 0,
    coverageObjective01: snapshot.coverageObjective01,
    objectiveMet: false,
    exposedOffsets: OFFSETS.map((definition) => ({
      position: add(snapshot.selfFootPosition, definition.offset),
      offsetRole: definition.role,
      reason: "OBJECTIVE_NOT_SELECTED" as const,
      protectionEffect: definition.effect,
    })),
    existingProtectedCount: 0,
    blastRangesUsed: BLAST_RANGES,
  };
}

function inventoryQueue(
  blocks: readonly CombatSurroundInventoryBlock[],
): CombatSurroundBlockClass[] {
  const counts = new Map<CombatSurroundBlockClass, number>();
  for (const block of blocks) {
    if (counts.has(block.blockClass)) {
      throw new TypeError("Surround inventory block classes must be unique.");
    }
    counts.set(block.blockClass, block.count);
  }
  const queue: CombatSurroundBlockClass[] = [];
  for (const blockClass of BLOCK_PREFERENCE) {
    const count = counts.get(blockClass) ?? 0;
    for (let index = 0; index < count; index += 1) queue.push(blockClass);
  }
  return queue;
}

function threatPriority(
  offsetVector: CombatVector3,
  threats: readonly CombatSurroundThreatDirection[],
): number {
  const offsetMagnitude = Math.hypot(
    offsetVector.x,
    offsetVector.y,
    offsetVector.z,
  );
  if (offsetMagnitude === 0) return 0;
  let score = 0;
  for (const threat of threats) {
    const magnitude = Math.hypot(
      threat.direction.x,
      threat.direction.y,
      threat.direction.z,
    );
    const dot =
      (offsetVector.x * threat.direction.x +
        offsetVector.y * threat.direction.y +
        offsetVector.z * threat.direction.z) /
      (offsetMagnitude * magnitude);
    score += Math.max(0, dot) * threat.weight;
  }
  return score;
}

function blockCenterDistance(
  selfFootPosition: CombatVector3,
  blockPosition: CombatVector3,
): number {
  const eye = {
    x: selfFootPosition.x,
    y: selfFootPosition.y + 1.62,
    z: selfFootPosition.z,
  };
  return Math.hypot(
    blockPosition.x - eye.x,
    blockPosition.y - eye.y,
    blockPosition.z - eye.z,
  );
}

function validateSnapshot(snapshot: CombatSurroundSnapshot): void {
  validateVector(snapshot.selfFootPosition, "selfFootPosition");
  if (typeof snapshot.occupancy !== "function") {
    throw new TypeError("Surround occupancy must be a query function.");
  }
  if (!Number.isFinite(snapshot.reachDistance) || snapshot.reachDistance <= 0) {
    throw new TypeError("Surround reachDistance must be positive.");
  }
  if (
    !Number.isFinite(snapshot.coverageObjective01) ||
    snapshot.coverageObjective01 <= 0 ||
    snapshot.coverageObjective01 > 1
  ) {
    throw new TypeError("Surround coverageObjective01 must be in (0, 1].");
  }
  if (typeof snapshot.retreatInProgress !== "boolean") {
    throw new TypeError("Surround retreatInProgress must be boolean.");
  }
  validateExplosiveReadiness(snapshot.explosiveCombat);
  for (const block of snapshot.inventoryBlocks) {
    if (!BLOCK_PREFERENCE.includes(block.blockClass)) {
      throw new TypeError("Unknown surround block class.");
    }
    if (!Number.isInteger(block.count) || block.count < 0 || block.count > 64) {
      throw new TypeError("Surround block count must be an integer in [0, 64].");
    }
  }
  for (const threat of snapshot.threatDirections) {
    validateVector(threat.direction, "threat.direction");
    if (
      Math.hypot(
        threat.direction.x,
        threat.direction.y,
        threat.direction.z,
      ) === 0 ||
      !Number.isFinite(threat.weight) ||
      threat.weight <= 0
    ) {
      throw new TypeError("Surround threat direction is malformed.");
    }
  }
}

function validateExplosiveReadiness(
  readiness: CombatSurroundExplosiveReadiness,
): void {
  if (
    readiness === null ||
    typeof readiness !== "object" ||
    (readiness.mode !== "NONE" &&
      readiness.mode !== "CRYSTAL" &&
      readiness.mode !== "ANCHOR") ||
    typeof readiness.inventoryVerified !== "boolean" ||
    typeof readiness.candidateVerified !== "boolean" ||
    (readiness.mode === "NONE" &&
      (readiness.inventoryVerified || readiness.candidateVerified))
  ) {
    throw new TypeError("Surround explosiveCombat readiness is malformed.");
  }
}

function validateOccupancy(occupancy: CombatSurroundOccupancy): void {
  if (
    occupancy.state !== "replaceable" &&
    occupancy.state !== "occupied" &&
    occupancy.state !== "unknown"
  ) {
    throw new TypeError("Unknown surround occupancy state.");
  }
  if (occupancy.state === "occupied") {
    if (
      !Number.isFinite(occupancy.blastResistance) ||
      Number(occupancy.blastResistance) < 0
    ) {
      throw new TypeError("Occupied surround blocks need blast resistance.");
    }
  } else if (occupancy.blastResistance !== null) {
    throw new TypeError("Non-occupied surround offsets use null resistance.");
  }
}

function validateVector(vector: CombatVector3, label: string): void {
  if (
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`${label} must contain finite coordinates.`);
  }
}

function offset(
  x: number,
  y: number,
  z: number,
  role: CombatSurroundOffsetRole,
  tier: number,
  stableOrder: number,
  reducesExposure: boolean,
): OffsetDefinition {
  return {
    offset: { x, y, z },
    role,
    tier,
    stableOrder,
    effect: reducesExposure
      ? "MODELED_EXPOSURE_AND_PLACEMENT"
      : "PLACEMENT_DENIAL_ONLY",
  };
}

function add(left: CombatVector3, right: CombatVector3): CombatVector3 {
  return {
    x: left.x + right.x,
    y: left.y + right.y,
    z: left.z + right.z,
  };
}

function positionKey(position: CombatVector3): string {
  return `${position.x}:${position.y}:${position.z}`;
}

/**
 * AnchorEngine - tactical respawn-anchor offense and defense assessment.
 *
 * Anchors deliberately do not share CrystalEngine's reflex clearance gate.
 * Their place -> charge -> use sequence is a multi-use interaction chain, not
 * a same-tick crystal detonation. Both engines do share blast-model damage and
 * the non-negotiable self-damage red line.
 *
 * World facts stay outside this module. Candidate placement, occlusion,
 * current charge and live dimension are injected on every plan. In
 * particular, callers must never cache the dimension across a portal change:
 * using a charged anchor in the Nether sets spawn instead of exploding.
 */

import {
  BLAST_POWER,
  blastDamage,
  entityRangeFor,
  redLineBreached,
} from "./blast-model.js";
import type { CombatVector3 } from "./threat-analyzer.js";

export type CombatAnchorDimension =
  | "minecraft:overworld"
  | "minecraft:the_nether"
  | "minecraft:the_end";

export type CombatAnchorChargeLevel = 0 | 1 | 2 | 3 | 4;

export type CombatAnchorCandidate = Readonly<{
  /** Anchor block center, not the integer block corner. */
  position: CombatVector3;
  /** Current world geometry and resources permit placing or using this spot. */
  placeable: boolean;
  /** True when an anchor already occupies this position. */
  anchorPresent: boolean;
  /** Existing anchor charge. Must be zero when anchorPresent is false. */
  chargeLevel: CombatAnchorChargeLevel;
  /** Fraction of target exposure blocked, in [0, 1]. */
  targetOcclusion: number;
  /** Fraction of self exposure blocked, in [0, 1]. */
  selfOcclusion: number;
}>;

export type CombatAnchorSelfState = Readonly<{
  position: CombatVector3;
  health: number;
  totemMarginHealth: number;
  glowstoneCount: number;
  /**
   * Verified explosion mitigation. Missing means unknown and therefore zero;
   * this fail-closed default must not be replaced with an equipment guess.
   */
  explosionMitigation01?: number;
}>;

export type CombatAnchorPolicy = Readonly<{
  /** Anchor entity range, derived from power 5. */
  blastRadius: number;
  /** Fully exposed center damage, derived from power 5. */
  maxDamage: number;
  selfDamageWeight: number;
  selfDamageCeiling: number;
  minimumNetGain: number;
  /** Conservative use-interaction cadence; not a measured server guarantee. */
  interactionStepMs: number;
}>;

export const DEFAULT_ANCHOR_POLICY: CombatAnchorPolicy = {
  blastRadius: entityRangeFor(BLAST_POWER.anchor),
  maxDamage: 14 * BLAST_POWER.anchor + 1,
  selfDamageWeight: 1.5,
  selfDamageCeiling: 6,
  minimumNetGain: 1,
  interactionStepMs: 200,
};

export type CombatAnchorRefusalCode =
  | "DIMENSION_IS_NETHER"
  | "NO_CANDIDATES"
  | "ALL_UNPLACEABLE"
  | "SELF_DAMAGE_RED_LINE"
  | "SELF_DAMAGE_ABOVE_CEILING"
  | "NO_GLOWSTONE_TO_ARM"
  | "NET_GAIN_TOO_LOW";

export type CombatAnchorScore = Readonly<{
  candidate: CombatAnchorCandidate;
  targetDamage: number;
  selfDamage: number;
  netGain: number;
  /** Zero for any pre-charged anchor, one for an uncharged/new anchor. */
  chargeStepsRequired: 0 | 1;
  /** Conservative time until the activation interaction can complete. */
  estimatedArmMs: number;
}>;

export type CombatAnchorPlan = Readonly<{
  chosen: CombatAnchorScore | null;
  refusal: CombatAnchorRefusalCode | null;
  redLineRejections: number;
  viableCount: number;
  survivalMarginUsed: number;
  chargeStepsRequired: 0 | 1 | null;
  estimatedArmMs: number | null;
}>;

export type CombatHostileAnchorObservation = Readonly<{
  /** Anchor block center. */
  position: CombatVector3;
  /** Emitted block light: 0 when uncharged, then 3/7/11/15 for charges 1-4. */
  lightLevel: 0 | 3 | 7 | 11 | 15;
  selfOcclusion: number;
  /** Verified mitigation only. Missing/unknown is treated as zero. */
  selfMitigation01?: number;
}>;

export type CombatHostileAnchorArmLevel = "PLACED" | "ARMED_ONE_CLICK";

export type CombatHostileAnchorAssessment = Readonly<{
  /** True only when one click can explode it in the current dimension. */
  armed: boolean;
  chargeLevel: CombatAnchorChargeLevel;
  armLevel: CombatHostileAnchorArmLevel;
  entityRangeUsed: number;
  estimatedIncomingDamage: number;
  withinEntityRange: boolean;
}>;

export class AnchorEngine {
  private readonly policy: CombatAnchorPolicy;

  constructor(policy: CombatAnchorPolicy = DEFAULT_ANCHOR_POLICY) {
    validatePolicy(policy);
    this.policy = policy;
  }

  /** Tactical planner. It is intentionally not gated by CombatReflexDecision. */
  plan(
    candidates: readonly CombatAnchorCandidate[],
    targetPosition: CombatVector3,
    self: CombatAnchorSelfState,
    dimension: CombatAnchorDimension,
  ): CombatAnchorPlan {
    validateDimension(dimension);
    validatePosition(targetPosition, "targetPosition");
    validateSelf(self);
    for (const candidate of candidates) validateCandidate(candidate);

    const survivalMargin = self.health + self.totemMarginHealth;
    if (dimension === "minecraft:the_nether") {
      return refuse("DIMENSION_IS_NETHER", 0, 0, survivalMargin);
    }
    if (candidates.length === 0) {
      return refuse("NO_CANDIDATES", 0, 0, survivalMargin);
    }

    const placeable = candidates.filter((candidate) => candidate.placeable);
    if (placeable.length === 0) {
      return refuse("ALL_UNPLACEABLE", 0, 0, survivalMargin);
    }

    let redLineRejections = 0;
    let ceilingRejections = 0;
    let noGlowstoneRejections = 0;
    const viable: CombatAnchorScore[] = [];
    for (const candidate of placeable) {
      const targetDamage = estimateAnchorDamage(
        candidate.position,
        targetPosition,
        candidate.targetOcclusion,
        0,
      );
      const selfDamage = estimateAnchorDamage(
        candidate.position,
        self.position,
        candidate.selfOcclusion,
        self.explosionMitigation01 ?? 0,
      );

      if (redLineBreached(selfDamage, self.health, self.totemMarginHealth)) {
        redLineRejections += 1;
        continue;
      }
      if (selfDamage > this.policy.selfDamageCeiling) {
        ceilingRejections += 1;
        continue;
      }

      const chargeStepsRequired = candidate.chargeLevel > 0 ? 0 : 1;
      if (chargeStepsRequired === 1 && self.glowstoneCount === 0) {
        noGlowstoneRejections += 1;
        continue;
      }
      // A new anchor needs placement -> charge -> activation (two cadence
      // gaps). An existing anchor needs at most charge/use -> activation.
      const estimatedArmMs = this.policy.interactionStepMs *
        (candidate.anchorPresent ? 1 : 2);
      viable.push({
        candidate,
        targetDamage,
        selfDamage,
        netGain: targetDamage - selfDamage * this.policy.selfDamageWeight,
        chargeStepsRequired,
        estimatedArmMs,
      });
    }

    if (viable.length === 0) {
      if (redLineRejections > 0) {
        return refuse(
          "SELF_DAMAGE_RED_LINE",
          redLineRejections,
          0,
          survivalMargin,
        );
      }
      if (ceilingRejections > 0) {
        return refuse(
          "SELF_DAMAGE_ABOVE_CEILING",
          redLineRejections,
          0,
          survivalMargin,
        );
      }
      if (noGlowstoneRejections > 0) {
        return refuse(
          "NO_GLOWSTONE_TO_ARM",
          redLineRejections,
          0,
          survivalMargin,
        );
      }
    }

    viable.sort(compareScores);
    const chosen = viable[0];
    if (!chosen || chosen.netGain < this.policy.minimumNetGain) {
      return refuse(
        "NET_GAIN_TOO_LOW",
        redLineRejections,
        viable.length,
        survivalMargin,
      );
    }
    return {
      chosen,
      refusal: null,
      redLineRejections,
      viableCount: viable.length,
      survivalMarginUsed: survivalMargin,
      chargeStepsRequired: chosen.chargeStepsRequired,
      estimatedArmMs: chosen.estimatedArmMs,
    };
  }

  /**
   * Defensive assessment remains separate from entity threat scoring. Charge
   * 1-4 all use power 5; charge is a boolean weapon state, not a damage curve.
   */
  assessHostileAnchor(
    observation: CombatHostileAnchorObservation,
    selfPosition: CombatVector3,
    dimension: CombatAnchorDimension,
  ): CombatHostileAnchorAssessment {
    validateDimension(dimension);
    validatePosition(observation.position, "anchor.position");
    validatePosition(selfPosition, "selfPosition");
    validateUnitInterval(observation.selfOcclusion, "selfOcclusion");
    validateUnitInterval(
      observation.selfMitigation01 ?? 0,
      "selfMitigation01",
    );
    const chargeLevel = anchorChargeFromLightLevel(observation.lightLevel);
    const armLevel: CombatHostileAnchorArmLevel =
      chargeLevel === 0 ? "PLACED" : "ARMED_ONE_CLICK";
    const armed =
      dimension !== "minecraft:the_nether" && chargeLevel > 0;
    const damage = armed
      ? blastDamage({
          power: BLAST_POWER.anchor,
          blastCenter: observation.position,
          victimPosition: selfPosition,
          victimEyeHeight: 0,
          exposure01: 1 - observation.selfOcclusion,
          difficulty: "normal",
          mitigation01: observation.selfMitigation01 ?? 0,
        })
      : {
          mitigatedDamage: 0,
          withinEntityRange: distanceBetween(
            observation.position,
            selfPosition,
          ) <= this.policy.blastRadius,
        };

    return {
      armed,
      chargeLevel,
      armLevel,
      entityRangeUsed: this.policy.blastRadius,
      estimatedIncomingDamage: damage.mitigatedDamage,
      withinEntityRange: damage.withinEntityRange,
    };
  }
}

export function anchorChargeFromLightLevel(
  lightLevel: CombatHostileAnchorObservation["lightLevel"],
): CombatAnchorChargeLevel {
  switch (lightLevel) {
    case 0:
      return 0;
    case 3:
      return 1;
    case 7:
      return 2;
    case 11:
      return 3;
    case 15:
      return 4;
    default:
      throw new TypeError("anchor lightLevel must be 0, 3, 7, 11, or 15.");
  }
}

function estimateAnchorDamage(
  blastCenter: CombatVector3,
  victimPosition: CombatVector3,
  occlusion: number,
  mitigation01: number,
): number {
  return blastDamage({
    power: BLAST_POWER.anchor,
    blastCenter,
    victimPosition,
    victimEyeHeight: 0,
    exposure01: 1 - occlusion,
    difficulty: "normal",
    mitigation01,
  }).mitigatedDamage;
}

function compareScores(
  left: CombatAnchorScore,
  right: CombatAnchorScore,
): number {
  return right.netGain - left.netGain ||
    left.estimatedArmMs - right.estimatedArmMs ||
    left.selfDamage - right.selfDamage ||
    comparePosition(left.candidate.position, right.candidate.position);
}

function refuse(
  refusal: CombatAnchorRefusalCode,
  redLineRejections: number,
  viableCount: number,
  survivalMarginUsed: number,
): CombatAnchorPlan {
  return {
    chosen: null,
    refusal,
    redLineRejections,
    viableCount,
    survivalMarginUsed,
    chargeStepsRequired: null,
    estimatedArmMs: null,
  };
}

function validatePolicy(policy: CombatAnchorPolicy): void {
  if (
    policy.blastRadius !== entityRangeFor(BLAST_POWER.anchor) ||
    policy.maxDamage !== 14 * BLAST_POWER.anchor + 1 ||
    !Number.isFinite(policy.selfDamageWeight) ||
    policy.selfDamageWeight < 1 ||
    !Number.isFinite(policy.selfDamageCeiling) ||
    policy.selfDamageCeiling <= 0 ||
    !Number.isFinite(policy.minimumNetGain) ||
    policy.minimumNetGain <= 0 ||
    !Number.isFinite(policy.interactionStepMs) ||
    policy.interactionStepMs <= 0
  ) {
    throw new TypeError("Anchor policy is out of bounds.");
  }
}

function validateSelf(self: CombatAnchorSelfState): void {
  validatePosition(self.position, "self.position");
  if (!Number.isFinite(self.health) || self.health < 0) {
    throw new TypeError("self.health must be a non-negative finite number.");
  }
  if (
    !Number.isFinite(self.totemMarginHealth) ||
    self.totemMarginHealth < 0
  ) {
    throw new TypeError(
      "self.totemMarginHealth must be a non-negative finite number.",
    );
  }
  if (!Number.isInteger(self.glowstoneCount) || self.glowstoneCount < 0) {
    throw new TypeError("self.glowstoneCount must be a non-negative integer.");
  }
  validateUnitInterval(
    self.explosionMitigation01 ?? 0,
    "self.explosionMitigation01",
  );
}

function validateCandidate(candidate: CombatAnchorCandidate): void {
  validatePosition(candidate.position, "candidate.position");
  if (
    typeof candidate.placeable !== "boolean" ||
    typeof candidate.anchorPresent !== "boolean" ||
    !Number.isInteger(candidate.chargeLevel) ||
    candidate.chargeLevel < 0 ||
    candidate.chargeLevel > 4 ||
    (!candidate.anchorPresent && candidate.chargeLevel !== 0)
  ) {
    throw new TypeError("Anchor candidate state is malformed.");
  }
  validateUnitInterval(candidate.targetOcclusion, "targetOcclusion");
  validateUnitInterval(candidate.selfOcclusion, "selfOcclusion");
}

function validateDimension(dimension: CombatAnchorDimension): void {
  if (
    dimension !== "minecraft:overworld" &&
    dimension !== "minecraft:the_nether" &&
    dimension !== "minecraft:the_end"
  ) {
    throw new TypeError("Anchor dimension is unsupported.");
  }
}

function validateUnitInterval(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new TypeError(`${label} must be in [0, 1].`);
  }
}

function validatePosition(position: CombatVector3, label: string): void {
  if (
    !Number.isFinite(position.x) ||
    !Number.isFinite(position.y) ||
    !Number.isFinite(position.z)
  ) {
    throw new TypeError(`${label} must contain finite coordinates.`);
  }
}

function distanceBetween(left: CombatVector3, right: CombatVector3): number {
  return Math.hypot(
    left.x - right.x,
    left.y - right.y,
    left.z - right.z,
  );
}

function comparePosition(left: CombatVector3, right: CombatVector3): number {
  return left.x - right.x || left.y - right.y || left.z - right.z;
}

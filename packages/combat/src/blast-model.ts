/**
 * Shared deterministic explosion damage model.
 *
 * Inputs that depend on the live world stay at the boundary: callers provide
 * exposure, difficulty, and mitigation rather than this module guessing block
 * geometry or equipment. The result is an estimate, not a server guarantee.
 */

import type { CombatVector3 } from "./threat-analyzer.js";

export const BLAST_POWER = {
  crystal: 6,
  anchor: 5,
  bed: 5,
} as const;

export type CombatDifficulty = "easy" | "normal" | "hard";

export type CombatBlastDamageInput = Readonly<{
  power: number;
  blastCenter: CombatVector3;
  /** Entity feet/base position. `victimEyeHeight` is added to its y value. */
  victimPosition: CombatVector3;
  victimEyeHeight: number;
  /** 0 = no exposure, 1 = fully exposed. */
  exposure01: number;
  difficulty: CombatDifficulty;
  /** Fraction of damage removed by armor/effects, 0 = no mitigation. */
  mitigation01: number;
}>;

export type CombatBlastDamage = Readonly<{
  /** Damage before mitigation, after exposure and difficulty scaling. */
  rawDamage: number;
  /** Damage after the injected mitigation fraction is applied. */
  mitigatedDamage: number;
  distance: number;
  /** Whether the victim is inside the entity damage range. */
  withinEntityRange: boolean;
}>;

/** Entity range is twice the explosion power in blocks. */
export function entityRangeFor(power: number): number {
  validatePower(power);
  return 2 * power;
}

/**
 * Public Minecraft explosion approximation using the documented impact curve.
 * Exposure is caller-supplied because the 27-ray (3x3x3) visibility sample is
 * a world-adapter concern and must not be hidden inside this pure function.
 */
export function blastDamage(
  input: CombatBlastDamageInput,
): CombatBlastDamage {
  validateInput(input);
  const range = entityRangeFor(input.power);
  const eyePosition = {
    x: input.victimPosition.x,
    y: input.victimPosition.y + input.victimEyeHeight,
    z: input.victimPosition.z,
  };
  const distance = Math.hypot(
    eyePosition.x - input.blastCenter.x,
    eyePosition.y - input.blastCenter.y,
    eyePosition.z - input.blastCenter.z,
  );
  const withinEntityRange = distance <= range;
  if (!withinEntityRange) {
    return {
      rawDamage: 0,
      mitigatedDamage: 0,
      distance,
      withinEntityRange,
    };
  }

  const impact = Math.max(0, 1 - distance / range);
  const baseDamage = ((impact * impact + impact) / 2) * 14 * input.power + 1;
  const exposedDamage = baseDamage * input.exposure01;
  const rawDamage = difficultyScale(exposedDamage, input.difficulty);
  return {
    rawDamage,
    mitigatedDamage: rawDamage * (1 - input.mitigation01),
    distance,
    withinEntityRange,
  };
}

/** The non-negotiable self-damage condition shared by explosive engines. */
export function redLineBreached(
  mitigatedSelfDamage: number,
  health: number,
  totemMarginHealth: number,
): boolean {
  if (
    !Number.isFinite(mitigatedSelfDamage) ||
    mitigatedSelfDamage < 0 ||
    !Number.isFinite(health) ||
    health < 0 ||
    !Number.isFinite(totemMarginHealth) ||
    totemMarginHealth < 0
  ) {
    throw new TypeError("爆炸红线输入必须是非负有限数。");
  }
  return mitigatedSelfDamage >= health + totemMarginHealth;
}

function difficultyScale(
  damage: number,
  difficulty: CombatDifficulty,
): number {
  switch (difficulty) {
    case "easy":
      return Math.min(damage / 2 + 1, damage);
    case "normal":
      return damage;
    case "hard":
      return damage * 1.5;
  }
}

function validateInput(input: CombatBlastDamageInput): void {
  validatePower(input.power);
  validateVector(input.blastCenter, "blastCenter");
  validateVector(input.victimPosition, "victimPosition");
  if (!Number.isFinite(input.victimEyeHeight) || input.victimEyeHeight < 0) {
    throw new TypeError("victimEyeHeight 必须是非负有限数。");
  }
  if (
    !Number.isFinite(input.exposure01) ||
    input.exposure01 < 0 ||
    input.exposure01 > 1
  ) {
    throw new TypeError("exposure01 必须落在 [0, 1]。");
  }
  if (
    input.difficulty !== "easy" &&
    input.difficulty !== "normal" &&
    input.difficulty !== "hard"
  ) {
    throw new TypeError("difficulty 不是受支持的难度。");
  }
  if (
    !Number.isFinite(input.mitigation01) ||
    input.mitigation01 < 0 ||
    input.mitigation01 > 1
  ) {
    throw new TypeError("mitigation01 必须落在 [0, 1].");
  }
}

function validatePower(power: number): void {
  if (!Number.isFinite(power) || power <= 0) {
    throw new TypeError("爆炸 power 必须是正的有限数。");
  }
}

function validateVector(vector: CombatVector3, name: string): void {
  if (
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`${name} 必须是有限坐标。`);
  }
}

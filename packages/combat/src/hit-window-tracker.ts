/**
 * HitWindowTracker - deterministic observation of target hurt/i-frame windows.
 *
 * Hurt events arrive after network delay, so this is a tactical estimate, not
 * a server guarantee. Missing data is intentionally permissive: unknown means
 * 0ms remaining, allowing a swing instead of permanently silencing the bot.
 */

export const TARGET_INVULNERABILITY_WINDOW_MS = 500;
export const HIT_WINDOW_STALE_AFTER_MS = 2_000;

export type CombatHitWindowConfidence = "observed" | "stale" | "unknown";

export type CombatHitWindowState = Readonly<{
  invulnerableRemainingMs: number;
  cooldownRatio01: number;
  lastHurtAgeMs: number | null;
  confidence: CombatHitWindowConfidence;
}>;

type HurtRecord = Readonly<{
  observedAtMs: number;
  serverProfileId: string;
}>;

type SwingRecord = Readonly<{
  observedAtMs: number;
  fullCooldownMs: number;
}>;

export class HitWindowTracker {
  private readonly configuredServerProfileId: string | null;
  private activeServerProfileId: string | null;
  private readonly hurtRecords = new Map<number, HurtRecord>();
  private readonly swingRecords = new Map<number, SwingRecord>();
  private lastObservedAtMs: number | null = null;

  constructor(serverProfileId?: string) {
    if (
      serverProfileId !== undefined &&
      (typeof serverProfileId !== "string" || serverProfileId.trim().length === 0)
    ) {
      throw new TypeError("HitWindowTracker serverProfileId is required when supplied.");
    }
    this.configuredServerProfileId = serverProfileId ?? null;
    this.activeServerProfileId = this.configuredServerProfileId;
  }

  recordHurt(
    entityId: number,
    nowMs: number,
    serverProfileId: string,
  ): void {
    validateEntityId(entityId);
    validateTime(nowMs);
    validateProfile(serverProfileId);
    if (
      this.activeServerProfileId !== null &&
      serverProfileId !== this.activeServerProfileId
    ) {
      return;
    }
    this.activeServerProfileId = serverProfileId;
    this.advanceClock(nowMs);
    this.hurtRecords.set(entityId, { observedAtMs: nowMs, serverProfileId });
  }

  recordSwingObserved(
    entityId: number,
    nowMs: number,
    fullCooldownMs: number,
  ): void {
    validateEntityId(entityId);
    validateTime(nowMs);
    if (!Number.isFinite(fullCooldownMs) || fullCooldownMs <= 0) {
      throw new TypeError("fullCooldownMs must be a positive finite number.");
    }
    this.advanceClock(nowMs);
    this.swingRecords.set(entityId, { observedAtMs: nowMs, fullCooldownMs });
  }

  stateFor(entityId: number, nowMs: number): CombatHitWindowState {
    validateEntityId(entityId);
    validateTime(nowMs);
    this.advanceClock(nowMs);

    const hurt = this.hurtRecords.get(entityId);
    const swing = this.swingRecords.get(entityId);
    const lastHurtAgeMs = hurt === undefined
      ? null
      : Math.max(0, nowMs - hurt.observedAtMs);
    const latestObservedAtMs = Math.max(
      hurt?.observedAtMs ?? 0,
      swing?.observedAtMs ?? 0,
    );
    const hasObservation = hurt !== undefined || swing !== undefined;
    const latestAgeMs = hasObservation
      ? Math.max(0, nowMs - latestObservedAtMs)
      : null;
    const confidence: CombatHitWindowConfidence = !hasObservation
      ? "unknown"
      : (latestAgeMs ?? 0) <= HIT_WINDOW_STALE_AFTER_MS
        ? "observed"
        : "stale";
    const invulnerableRemainingMs = hurt === undefined
      ? 0
      : Math.max(
          0,
          TARGET_INVULNERABILITY_WINDOW_MS - (lastHurtAgeMs ?? 0),
        );
    const cooldownRatio01 = swing === undefined
      ? 1
      : Math.min(
          1,
          Math.max(0, nowMs - swing.observedAtMs) / swing.fullCooldownMs,
        );

    return {
      invulnerableRemainingMs,
      cooldownRatio01,
      lastHurtAgeMs,
      confidence,
    };
  }

  reset(): void {
    this.hurtRecords.clear();
    this.swingRecords.clear();
    this.lastObservedAtMs = null;
    this.activeServerProfileId = this.configuredServerProfileId;
  }

  private advanceClock(nowMs: number): void {
    if (this.lastObservedAtMs !== null && nowMs < this.lastObservedAtMs) {
      throw new RangeError("Hit-window observation clock moved backwards.");
    }
    this.lastObservedAtMs = nowMs;
  }
}

function validateEntityId(entityId: number): void {
  if (!Number.isSafeInteger(entityId) || entityId < 0) {
    throw new TypeError("Hit-window entityId must be a non-negative safe integer.");
  }
}

function validateTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new TypeError("Hit-window time must be a non-negative safe integer.");
  }
}

function validateProfile(serverProfileId: string): void {
  if (typeof serverProfileId !== "string" || serverProfileId.trim().length === 0) {
    throw new TypeError("Hit-window serverProfileId is required.");
  }
}

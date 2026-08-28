/**
 * TotemPopTracker - deterministic tracking of server-authoritative totem POP
 * events. Zero AI and zero Mineflayer dependencies.
 *
 * A POP gives the target a short absorption window. The longer regeneration
 * window is retained as context only; it must not be treated as a free-kill
 * period. Every record is scoped to one server profile and dimension so an
 * entity ID reused after a transfer cannot leak combat state across worlds.
 */

export const TOTEM_POP_ABSORPTION_WINDOW_MS = 5_000;
export const TOTEM_POP_REGEN_WINDOW_MS = 45_000;
/** Descriptive alias for callers that prefer the full phase name. */
export const TOTEM_POP_REGENERATION_WINDOW_MS = TOTEM_POP_REGEN_WINDOW_MS;

export type CombatTotemPopRecord = Readonly<{
  entityId: number;
  observedAtMs: number;
  serverProfileId: string;
  dimension: string;
}>;

export type CombatTotemPopPhase = "PUNISH" | "REGEN" | "EXPIRED";

export type CombatTotemPopWindowReason =
  | "NO_RECORD"
  | "PROFILE_MISMATCH"
  | "WINDOW_EXPIRED";

export type CombatTotemPopWindow = Readonly<{
  entityId: number;
  serverProfileId: string;
  dimension: string;
  /** True while the POP record is inside either the punish or regen window. */
  popped: boolean;
  /** Server-observed time of the active POP record, or null when inactive. */
  popObservedAtMs: number | null;
  /** Null means there is no record usable in the requested scope. */
  elapsedMs: number | null;
  /** Remaining absorption time; it is zero during REGEN and after expiry. */
  absorptionRemainingMs: number;
  /** EXPIRED also represents an inactive query; inspect `reason` to distinguish it. */
  phase: CombatTotemPopPhase;
  reason: CombatTotemPopWindowReason | null;
}>;

export type CombatTotemPopQuery = Readonly<{
  entityId: number;
  observedAtMs: number;
  serverProfileId: string;
  dimension: string;
}>;

export class TotemPopTracker {
  private readonly records = new Map<number, CombatTotemPopRecord>();
  private lastObservedAtMs: number | null = null;

  /** Record one server event. Duplicate events at the same timestamp are safe. */
  record(record: CombatTotemPopRecord): void {
    validateScope(record);
    this.advanceClock(record.observedAtMs);
    this.records.set(record.entityId, { ...record });
  }

  /** Clear all event and clock state when a bot changes connection/world epoch. */
  reset(): void {
    this.records.clear();
    this.lastObservedAtMs = null;
  }

  windowFor(query: CombatTotemPopQuery): CombatTotemPopWindow {
    validateScope(query);
    this.advanceClock(query.observedAtMs);

    const record = this.records.get(query.entityId);
    if (record === undefined) {
      return inactiveWindow(query, "NO_RECORD");
    }
    if (
      record.serverProfileId !== query.serverProfileId ||
      record.dimension !== query.dimension
    ) {
      return inactiveWindow(query, "PROFILE_MISMATCH");
    }

    const elapsedMs = query.observedAtMs - record.observedAtMs;
    const phase = elapsedMs < TOTEM_POP_ABSORPTION_WINDOW_MS
      ? "PUNISH"
      : elapsedMs < TOTEM_POP_REGEN_WINDOW_MS
        ? "REGEN"
        : "EXPIRED";
    return {
      entityId: query.entityId,
      serverProfileId: query.serverProfileId,
      dimension: query.dimension,
      popped: phase !== "EXPIRED",
      popObservedAtMs: record.observedAtMs,
      elapsedMs,
      absorptionRemainingMs: Math.max(
        0,
        TOTEM_POP_ABSORPTION_WINDOW_MS - elapsedMs,
      ),
      phase,
      reason: phase === "EXPIRED" ? "WINDOW_EXPIRED" : null,
    };
  }

  private advanceClock(observedAtMs: number): void {
    if (
      this.lastObservedAtMs !== null &&
      observedAtMs < this.lastObservedAtMs
    ) {
      throw new RangeError("Totem POP observation clock moved backwards.");
    }
    this.lastObservedAtMs = observedAtMs;
  }
}

function inactiveWindow(
  query: CombatTotemPopQuery,
  reason: Exclude<CombatTotemPopWindowReason, "WINDOW_EXPIRED">,
): CombatTotemPopWindow {
  return {
    entityId: query.entityId,
    serverProfileId: query.serverProfileId,
    dimension: query.dimension,
    popped: false,
    popObservedAtMs: null,
    elapsedMs: null,
    absorptionRemainingMs: 0,
    phase: "EXPIRED",
    reason,
  };
}

function validateScope(scope: {
  entityId: number;
  observedAtMs: number;
  serverProfileId: string;
  dimension: string;
}): void {
  if (!Number.isSafeInteger(scope.entityId) || scope.entityId < 0) {
    throw new TypeError("Totem POP entityId must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(scope.observedAtMs) || scope.observedAtMs < 0) {
    throw new TypeError("Totem POP observedAtMs must be a non-negative safe integer.");
  }
  if (
    typeof scope.serverProfileId !== "string" ||
    scope.serverProfileId.trim().length === 0
  ) {
    throw new TypeError("Totem POP serverProfileId is required.");
  }
  if (
    typeof scope.dimension !== "string" ||
    scope.dimension.trim().length === 0
  ) {
    throw new TypeError("Totem POP dimension is required.");
  }
}

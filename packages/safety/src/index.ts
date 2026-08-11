import type {
  L0SafetyActionKind,
  L0SafetyRisk,
} from "@minecraft-studio/protocol";

export type L0SafetySnapshot = Readonly<{
  observedAtMs: number;
  health: number;
  foodLevel: number;
  oxygenLevel: number | null;
  inWater: boolean;
  inLava: boolean;
  onGround: boolean;
  velocityY: number | null;
  position: Readonly<{ x: number; y: number; z: number }>;
  inventory: Readonly<{ usedSlots: number; totalSlots: number }>;
  hasSafeFood: boolean;
  movementRequested: boolean;
}>;

export type L0SafetyAction = Readonly<{
  kind: L0SafetyActionKind;
  risk: L0SafetyRisk;
  durationMs?: number;
}>;

export type L0SafetyDecision = Readonly<{
  decisionId: string | null;
  evaluatedAtMs: number;
  severity: "none" | "warning" | "critical";
  activeRisks: readonly L0SafetyRisk[];
  normalTasksPaused: boolean;
  changed: boolean;
  actions: readonly L0SafetyAction[];
}>;

export type L0SafetyActionResult = Readonly<{
  outcome: "executed" | "skipped" | "failed";
  errorCode: string | null;
}>;

const CRITICAL_HEALTH = 4;
const LOW_HEALTH = 8;
const EAT_AT_FOOD_LEVEL = 14;
const LOW_OXYGEN_LEVEL = 6;
const FALL_VELOCITY_Y = -0.75;
const STUCK_AFTER_MS = 5_000;
const MOVEMENT_EPSILON = 0.2;

const ACTION_COOLDOWN_MS: Readonly<Record<L0SafetyActionKind, number>> = {
  PAUSE_NORMAL_TASKS: 1_000,
  CONSUME_SAFE_FOOD: 5_000,
  RETREAT_STEP: 2_000,
  ASCEND: 750,
  ESCAPE_LAVA: 750,
  HALT_HORIZONTAL_MOVEMENT: 1_000,
  UNSTICK: 2_000,
  EMERGENCY_STOP: 60_000,
};

const ACTION_DURATION_MS: Partial<Record<L0SafetyActionKind, number>> = {
  RETREAT_STEP: 700,
  ASCEND: 750,
  ESCAPE_LAVA: 1_000,
  UNSTICK: 600,
};

const RISK_ORDER: readonly L0SafetyRisk[] = [
  "CRITICAL_HEALTH",
  "LAVA",
  "DROWNING",
  "FALLING",
  "LOW_HEALTH",
  "STUCK",
  "INVENTORY_FULL",
  "HUNGER",
];

export class L0SafetyController {
  private sequence = 0;
  private readonly lastActionAt = new Map<L0SafetyActionKind, number>();
  private movementAnchor: L0SafetySnapshot["position"] | null = null;
  private movementAnchorAt = 0;
  private lastFingerprint = "";

  reset(): void {
    this.sequence = 0;
    this.lastActionAt.clear();
    this.movementAnchor = null;
    this.movementAnchorAt = 0;
    this.lastFingerprint = "";
  }

  evaluate(snapshot: L0SafetySnapshot): L0SafetyDecision {
    validateSnapshot(snapshot);
    const risks = this.detectRisks(snapshot);
    const normalTasksPaused = risks.length > 0;
    const fingerprint = `${risks.join(",")}|${normalTasksPaused}`;
    const changed = fingerprint !== this.lastFingerprint;
    this.lastFingerprint = fingerprint;

    const actions: L0SafetyAction[] = [];
    const pushAction = (kind: L0SafetyActionKind, risk: L0SafetyRisk) => {
      const lastAt = this.lastActionAt.get(kind) ?? Number.NEGATIVE_INFINITY;
      if (snapshot.observedAtMs - lastAt < ACTION_COOLDOWN_MS[kind]) return;
      this.lastActionAt.set(kind, snapshot.observedAtMs);
      const durationMs = ACTION_DURATION_MS[kind];
      actions.push({ kind, risk, ...(durationMs ? { durationMs } : {}) });
    };

    if (risks.includes("CRITICAL_HEALTH")) {
      pushAction("PAUSE_NORMAL_TASKS", "CRITICAL_HEALTH");
      pushAction("EMERGENCY_STOP", "CRITICAL_HEALTH");
    } else {
      if (risks.includes("LAVA")) {
        pushAction("PAUSE_NORMAL_TASKS", "LAVA");
        pushAction("ESCAPE_LAVA", "LAVA");
      } else if (risks.includes("DROWNING")) {
        pushAction("PAUSE_NORMAL_TASKS", "DROWNING");
        pushAction("ASCEND", "DROWNING");
      } else if (risks.includes("FALLING")) {
        pushAction("PAUSE_NORMAL_TASKS", "FALLING");
        pushAction("HALT_HORIZONTAL_MOVEMENT", "FALLING");
      } else if (risks.includes("LOW_HEALTH")) {
        pushAction("PAUSE_NORMAL_TASKS", "LOW_HEALTH");
        if (snapshot.onGround && !snapshot.inWater && !snapshot.inLava) {
          pushAction("RETREAT_STEP", "LOW_HEALTH");
        }
      } else if (risks.includes("STUCK")) {
        pushAction("PAUSE_NORMAL_TASKS", "STUCK");
        pushAction("UNSTICK", "STUCK");
        this.movementAnchorAt = snapshot.observedAtMs;
      } else if (risks.includes("INVENTORY_FULL")) {
        pushAction("PAUSE_NORMAL_TASKS", "INVENTORY_FULL");
      } else if (risks.includes("HUNGER") && snapshot.hasSafeFood) {
        pushAction("CONSUME_SAFE_FOOD", "HUNGER");
      }
    }

    const hasDecision = changed || actions.length > 0;
    return {
      decisionId: hasDecision ? `l0-${++this.sequence}` : null,
      evaluatedAtMs: snapshot.observedAtMs,
      severity: risks.some((risk) =>
        risk === "CRITICAL_HEALTH" || risk === "LAVA" || risk === "DROWNING"
      )
        ? "critical"
        : risks.length > 0
          ? "warning"
          : "none",
      activeRisks: risks,
      normalTasksPaused,
      changed,
      actions,
    };
  }

  private detectRisks(snapshot: L0SafetySnapshot): L0SafetyRisk[] {
    const detected = new Set<L0SafetyRisk>();
    if (snapshot.health <= CRITICAL_HEALTH) detected.add("CRITICAL_HEALTH");
    else if (snapshot.health <= LOW_HEALTH) detected.add("LOW_HEALTH");
    if (snapshot.foodLevel <= EAT_AT_FOOD_LEVEL) detected.add("HUNGER");
    if (
      snapshot.inWater &&
      snapshot.oxygenLevel !== null &&
      snapshot.oxygenLevel <= LOW_OXYGEN_LEVEL
    ) {
      detected.add("DROWNING");
    }
    if (snapshot.inLava) detected.add("LAVA");
    if (
      !snapshot.onGround &&
      !snapshot.inWater &&
      !snapshot.inLava &&
      snapshot.velocityY !== null &&
      snapshot.velocityY <= FALL_VELOCITY_Y
    ) {
      detected.add("FALLING");
    }
    if (
      snapshot.inventory.totalSlots > 0 &&
      snapshot.inventory.usedSlots >= snapshot.inventory.totalSlots
    ) {
      detected.add("INVENTORY_FULL");
    }
    if (this.isStuck(snapshot)) detected.add("STUCK");
    return RISK_ORDER.filter((risk) => detected.has(risk));
  }

  private isStuck(snapshot: L0SafetySnapshot): boolean {
    if (!snapshot.movementRequested) {
      this.movementAnchor = null;
      this.movementAnchorAt = snapshot.observedAtMs;
      return false;
    }
    if (!this.movementAnchor) {
      this.movementAnchor = { ...snapshot.position };
      this.movementAnchorAt = snapshot.observedAtMs;
      return false;
    }
    const dx = snapshot.position.x - this.movementAnchor.x;
    const dy = snapshot.position.y - this.movementAnchor.y;
    const dz = snapshot.position.z - this.movementAnchor.z;
    if (Math.hypot(dx, dy, dz) >= MOVEMENT_EPSILON) {
      this.movementAnchor = { ...snapshot.position };
      this.movementAnchorAt = snapshot.observedAtMs;
      return false;
    }
    return snapshot.observedAtMs - this.movementAnchorAt >= STUCK_AFTER_MS;
  }
}

function validateSnapshot(snapshot: L0SafetySnapshot): void {
  finiteInRange(snapshot.observedAtMs, 0, Number.MAX_SAFE_INTEGER, "observedAtMs");
  finiteInRange(snapshot.health, 0, 2_048, "health");
  finiteInRange(snapshot.foodLevel, 0, 20, "foodLevel", true);
  if (snapshot.oxygenLevel !== null) {
    finiteInRange(snapshot.oxygenLevel, 0, 20, "oxygenLevel", true);
  }
  if (snapshot.velocityY !== null) {
    finiteInRange(snapshot.velocityY, -100, 100, "velocityY");
  }
  finiteInRange(snapshot.position.x, -30_000_000, 30_000_000, "position.x");
  finiteInRange(snapshot.position.y, -2_048, 2_048, "position.y");
  finiteInRange(snapshot.position.z, -30_000_000, 30_000_000, "position.z");
  finiteInRange(snapshot.inventory.usedSlots, 0, 256, "inventory.usedSlots", true);
  finiteInRange(snapshot.inventory.totalSlots, 0, 256, "inventory.totalSlots", true);
  if (snapshot.inventory.usedSlots > snapshot.inventory.totalSlots) {
    throw new TypeError("Inventory used slots cannot exceed total slots.");
  }
}

function finiteInRange(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
  integer = false,
): void {
  if (
    !Number.isFinite(value) ||
    value < minimum ||
    value > maximum ||
    (integer && !Number.isInteger(value))
  ) {
    throw new TypeError(`${name} is outside the L0 safety boundary.`);
  }
}

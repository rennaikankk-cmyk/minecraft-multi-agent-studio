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
const LOW_HEALTH_RETREAT_MAX_STEPS = 2;

const ACTION_COOLDOWN_MS: Readonly<Record<L0SafetyActionKind, number>> = {
  PAUSE_NORMAL_TASKS: 1_000,
  CONSUME_SAFE_FOOD: 5_000,
  FORAGE_SAFE_FOOD: 20_000,
  RETREAT_STEP: 2_000,
  ASCEND: 750,
  ESCAPE_LAVA: 750,
  HALT_HORIZONTAL_MOVEMENT: 1_000,
  UNSTICK: 2_000,
  TIDY_DROP_JUNK: 10_000,
  EMERGENCY_STOP: 60_000,
};

/**
 * 未确认紧急停止的重发间隔（§6「全局暂停和紧急停止优先于所有任务与模型建议」）。
 *
 * 60s 的 ACTION_COOLDOWN_MS 是"确认成功后的去重"，不能同时充当"没送出去时的
 * 沉默期"：断线保号是分钟级的事，一次 client.close() 失败却要等满 60s 才允许
 * 再发，期间血量继续掉——那是把去重写成了放弃。
 *
 * 取值论证：5s 远小于 60s 的正常去重间隔（确认后不会变成刷屏），又足够长到
 * 不构成每 tick 的噪声。评估周期最快约 1s（statusIntervalMs），5s 意味着最坏
 * 约 5 次评估一次重发；即便一直无法确认也只有 12 次/分钟量级，且每次重发都
 * 走同一条受审计的 stop 路径，不会放大成失控循环。
 */
const UNCONFIRMED_EMERGENCY_STOP_RETRY_MS = 5_000;

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
  private lowHealthRetreatSteps = 0;
  /** 上一次观测的绝对血量；None = 本连接还没有基线。 */
  private previousHealth: number | null = null;
  /**
   * 上一次 EMERGENCY_STOP 的确认结果。null = 本连接还没有发出过紧急停止。
   * false 期间按 UNCONFIRMED_EMERGENCY_STOP_RETRY_MS 重发，而不是等满 60s。
   */
  private emergencyStopConfirmed: boolean | null = null;

  reset(): void {
    this.sequence = 0;
    this.lastActionAt.clear();
    this.movementAnchor = null;
    this.movementAnchorAt = 0;
    this.lastFingerprint = "";
    this.lowHealthRetreatSteps = 0;
    this.previousHealth = null;
    this.emergencyStopConfirmed = null;
  }

  /**
   * 上报上一次 EMERGENCY_STOP 的执行结果。运行时在 stop() 返回后调用：
   * confirmed=true 时维持 60s 去重；false 时缩短到重发间隔。
   * 没有已记录的紧急停止时间戳时忽略（不存在可缩短的沉默期）。
   */
  reportEmergencyStop(confirmed: boolean): void {
    if (!this.lastActionAt.has("EMERGENCY_STOP")) return;
    this.emergencyStopConfirmed = confirmed;
  }

  evaluate(snapshot: L0SafetySnapshot): L0SafetyDecision {
    validateSnapshot(snapshot);
    const risks = this.detectRisks(snapshot);
    if (!risks.includes("LOW_HEALTH")) this.lowHealthRetreatSteps = 0;
    const healthStillFalling =
      this.previousHealth !== null && snapshot.health < this.previousHealth;
    this.previousHealth = snapshot.health;
    const normalTasksPaused = risks.length > 0;
    const fingerprint = `${risks.join(",")}|${normalTasksPaused}`;
    const changed = fingerprint !== this.lastFingerprint;
    this.lastFingerprint = fingerprint;

    const actions: L0SafetyAction[] = [];
    const pushAction = (
      kind: L0SafetyActionKind,
      risk: L0SafetyRisk,
    ): boolean => {
      const lastAt = this.lastActionAt.get(kind) ?? Number.NEGATIVE_INFINITY;
      const intervalMs =
        kind === "EMERGENCY_STOP" && this.emergencyStopConfirmed === false
          ? UNCONFIRMED_EMERGENCY_STOP_RETRY_MS
          : ACTION_COOLDOWN_MS[kind];
      if (snapshot.observedAtMs - lastAt < intervalMs) return false;
      this.lastActionAt.set(kind, snapshot.observedAtMs);
      if (kind === "EMERGENCY_STOP") {
        // 本次重发在拿到结果之前不算"已确认"。
        this.emergencyStopConfirmed = false;
      }
      const durationMs = ACTION_DURATION_MS[kind];
      actions.push({ kind, risk, ...(durationMs ? { durationMs } : {}) });
      return true;
    };

    if (risks.includes("CRITICAL_HEALTH")) {
      pushAction("PAUSE_NORMAL_TASKS", "CRITICAL_HEALTH");
      // 断线保号的语义是"正在被杀"——血还在掉。实测痛点：上次 2 血断线
      // 后重连，血量原样保留，"只要处于危急血量就断线"把 Bot 变成
      // 重连→再断线的死循环。稳定低血+有食物的正确反射是吃食物回血；
      // 没有基线（刚连上）或血量未在下降时不再触发断线。
      if (healthStillFalling) {
        pushAction("EMERGENCY_STOP", "CRITICAL_HEALTH");
      } else if (snapshot.hasSafeFood && snapshot.foodLevel < 20) {
        pushAction("CONSUME_SAFE_FOOD", "CRITICAL_HEALTH");
      } else if (!snapshot.hasSafeFood) {
        pushAction("FORAGE_SAFE_FOOD", "CRITICAL_HEALTH");
      }
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
        if (snapshot.hasSafeFood && snapshot.foodLevel < 20) {
          pushAction("CONSUME_SAFE_FOOD", "LOW_HEALTH");
        } else if (!snapshot.hasSafeFood && snapshot.foodLevel < 20) {
          pushAction("FORAGE_SAFE_FOOD", "LOW_HEALTH");
        }
        if (
          this.lowHealthRetreatSteps < LOW_HEALTH_RETREAT_MAX_STEPS &&
          snapshot.onGround &&
          !snapshot.inWater &&
          !snapshot.inLava &&
          pushAction("RETREAT_STEP", "LOW_HEALTH")
        ) {
          this.lowHealthRetreatSteps += 1;
        }
      } else if (risks.includes("STUCK")) {
        pushAction("PAUSE_NORMAL_TASKS", "STUCK");
        pushAction("UNSTICK", "STUCK");
        this.movementAnchorAt = snapshot.observedAtMs;
      } else if (risks.includes("INVENTORY_FULL")) {
        pushAction("PAUSE_NORMAL_TASKS", "INVENTORY_FULL");
        // 背包满在此前的处置只有暂停——那是一个必然的死锁：没有任何上层
        // 会在暂停期间清背包。先做一次确定性丢垃圾（白名单+保留阈值），
        // 丢得动下一轮评估就解除风险；确实全是必需品时保持暂停（如实）。
        pushAction("TIDY_DROP_JUNK", "INVENTORY_FULL");
      } else if (risks.includes("HUNGER")) {
        pushAction(
          snapshot.hasSafeFood ? "CONSUME_SAFE_FOOD" : "FORAGE_SAFE_FOOD",
          "HUNGER",
        );
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

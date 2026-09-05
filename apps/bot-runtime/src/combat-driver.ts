import {
  ChainSequencer,
  CombatIdentityRegistry,
  CombatReflexNotClearedError,
  CrystalEngine,
  DEFAULT_ENGAGEMENT_POLICY,
  DEFAULT_GEAR_POLICY,
  DEFAULT_MINE_POLICY,
  DEFAULT_RETREAT_POLICY,
  DEFAULT_TOTEM_POLICY,
  MovementController,
  PacketMineController,
  PredictionEngine,
  RetreatController,
  RotationController,
  TargetSelector,
  ThreatAnalyzer,
  TotemManager,
  WeaponManager,
  assessWorstMatchup,
  decideReflexClearance,
  explosionMitigation01,
  eyePosition,
  orientationToward,
  type CombatChainStepRecord,
  type CombatCrystalCandidate,
  type CombatEntityObservation,
  type CombatExplosionRuleSet,
  type CombatGearAssessment,
  type CombatGearSnapshot,
  type CombatMineAssignment,
  type CombatMineCandidate,
  type CombatMotionSample,
  type CombatOrientation,
  type CombatReflexDecision,
  type CombatReflexProbeReport,
  type CombatSurvivalStance,
  type CombatTargetRefusalCode,
  validateSurvivalStance,
  type CombatThreat,
  type CombatVector3,
  type CombatWeaponCandidate,
} from "@minecraft-studio/combat";
import type { CombatRuntimeStatusV1 } from "@minecraft-studio/protocol";
import {
  ServerPolicyGate,
  type PolicyActionKind,
  type PolicyDenialCode,
} from "@minecraft-studio/skills";

const MOTION_HISTORY_LIMIT = 4;
const MOVEMENT_ACTION_MS = 150;
// A live attacker gets a lower defensive floor than an operator-requested
// engagement. The Bot still retreats at critical health, but ordinary low
// health must not make close-range self-defense look inert.
const RETALIATION_CRITICAL_HEALTH = 6;
// ECMAScript Date supports millisecond timestamps only in this bounded range.
// Safe integers above it are valid arithmetic values but cannot be emitted in
// the protocol's ISO-8601 audit fields without a RangeError.
const MAX_DATE_MS = 8_640_000_000_000_000;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,127}$/u;
const ARMOR_MATERIALS = new Set([
  "none",
  "leather",
  "golden",
  "chainmail",
  "iron",
  "diamond",
  "netherite",
]);
const ENTITY_KINDS = new Set(["player", "monster", "animal", "object", "unknown"]);
const WEAPON_KINDS = new Set([
  "sword",
  "axe",
  "trident",
  "bow",
  "crossbow",
  "other",
]);

export type CombatDriverEntityObservation = CombatEntityObservation &
  Readonly<{
    /** null means the equipment observation was incomplete. */
    gear: CombatGearSnapshot | null;
    /** Missing means no hurt observation; callers must allow the swing. */
    invulnerableRemainingMs?: number;
    /** Opponent swing cooldown estimate; observation-only for spacing telemetry. */
    targetCooldownRatio01?: number;
  }>;

export type CombatDriverObservation = Readonly<{
  observedAtMs: number;
  serverProfileId: string;
  dimension: string;
  latencyMs: number | null;
  /** null means this Minecraft version has no verified explosion rules. */
  explosionRuleSet: CombatExplosionRuleSet | null;
  self: Readonly<{
    position: CombatVector3;
    health: number;
    offhandIsTotem: boolean;
    totemPopObservedAtMs?: number | null;
    inventoryTotemCount: number;
    gear: CombatGearSnapshot | null;
    orientation: CombatOrientation;
    heldItemSlot: number | null;
    /** Mineflayer's authoritative use-item state for bow/crossbow charging. */
    usingHeldItem?: boolean;
    onGround: boolean;
    fallDistance: number | null;
  }>;
  entities: readonly CombatDriverEntityObservation[];
  weapons: readonly CombatWeaponCandidate[];
  /** null means enumeration is unavailable; [] means it ran and found none. */
  crystalCandidates: readonly CombatCrystalCandidate[] | null;
  /** null means enumeration is unavailable; [] means it ran and found none. */
  mineCandidates: readonly CombatMineCandidate[] | null;
  /** null is unknown and must not be treated as an empty, safe hazard set. */
  hazards: readonly CombatVector3[] | null;
}>;

export type CombatPrimitiveAction =
  | Readonly<{ kind: "DISENGAGE" }>
  | Readonly<{
      kind: "REEQUIP_TOTEM";
    }>
  | Readonly<{
      kind: "EQUIP_WEAPON";
      slot: number;
    }>
  | Readonly<{
      kind: "RETREAT_MOVE";
      direction: CombatVector3 | null;
      sprint: boolean;
      durationMs: number;
    }>
  | Readonly<{
      kind: "ROTATE";
      orientation: CombatOrientation;
    }>
  | Readonly<{
      kind: "MELEE_ATTACK";
      targetEntityId: number;
      /** null means a retaliation-only unarmed strike. */
      weaponSlot: number | null;
    }>
  | Readonly<{
      kind: "DRAW_RANGED_WEAPON";
      weaponSlot: number;
    }>
  | Readonly<{
      kind: "RELEASE_RANGED_WEAPON";
      targetEntityId: number;
      weaponSlot: number;
    }>
  | Readonly<{
      kind: "MOVE";
      direction: CombatVector3;
      sprint: boolean;
      durationMs: number;
    }>
  | Readonly<{
      kind: "PLACE_CRYSTAL";
      position: CombatVector3;
    }>
  | Readonly<{
      /** 引爆范围内全部水晶（打碎即爆）。 */
      kind: "DETONATE_CRYSTALS";
    }>
  | Readonly<{
      kind: "PACKET_MINE";
      assignments: readonly CombatMineAssignment[];
    }>;

export type CombatActionAcknowledgement =
  | Readonly<{
      outcome: "executed";
      executedAtMs: number;
    }>
  | Readonly<{
      outcome: "failed" | "unavailable";
      reasonCode: string;
    }>;

export type CombatActionExecutor = (
  action: CombatPrimitiveAction,
  signal: AbortSignal,
) => Promise<CombatActionAcknowledgement>;

export type CombatDriverDisposition =
  | "executed"
  | "clipped"
  | "delayed"
  | "dropped"
  | "modified";

export type CombatDriverReceipt = Readonly<{
  requested: Readonly<{
    action: "ENGAGE" | "DISENGAGE";
    requestedAtMs: number;
  }>;
  actual: Readonly<{
    disposition: CombatDriverDisposition;
    action: "ENGAGE" | "DISENGAGE" | "RETREAT" | "NONE";
    primitiveAction: CombatPrimitiveAction["kind"] | "NONE";
    executedAtMs: number | null;
    reasonCode: string | null;
    targetEntityId: number | null;
  }>;
}>;

export type CombatDriverConfig = Readonly<{
  serverProfileId: string;
  selfUsername: string;
  stance: CombatSurvivalStance;
  /**
   * 无规则服强度档：交战/撤退/装备阈值全面放宽、未知装备不判劣势、
   * 无反射探针时图腾补位照做（不再降级为撤退）。默认 standard 保持
   * 既有行为，隔离测试零变化。
   */
  combatIntensity?: "standard" | "anarchy";
  whitelist: Readonly<{
    usernames: readonly string[];
    uuids: readonly string[];
  }>;
  policyGate: ServerPolicyGate;
  /** Optional per-request policy resolver; used when a live policy is updated. */
  policyGateProvider?: () => ServerPolicyGate;
  reflexProbe: CombatReflexProbeReport | null;
}>;

type ExecutionRecord = Readonly<{
  actionKinds: readonly PolicyActionKind[];
  afterAck?: (executedAtMs: number) => void;
}>;

type ActionSuccess = Readonly<{
  disposition: Exclude<CombatDriverDisposition, "delayed" | "dropped">;
  action: "ENGAGE" | "DISENGAGE" | "RETREAT";
  reasonCode: string | null;
  targetEntityId: number | null;
}>;

type PolicyCheck =
  | Readonly<{ allowed: true; record: ExecutionRecord }>
  | Readonly<{ allowed: false; denial: PolicyDenialCode }>;

type CombatEngagementMode = "active" | "retaliation";

const TARGET_REFUSAL_CODES: Readonly<Record<CombatTargetRefusalCode, string>> = {
  NO_HOSTILE_IN_RANGE: "COMBAT_NO_HOSTILE_TARGET",
  HEALTH_BELOW_ENGAGE_FLOOR: "COMBAT_HEALTH_BELOW_ENGAGE_FLOOR",
  TOTEM_RESERVE_INSUFFICIENT: "COMBAT_TOTEM_RESERVE_INSUFFICIENT",
  OUTNUMBERED: "COMBAT_OUTNUMBERED",
  GEAR_OUTCLASSED: "COMBAT_GEAR_OUTCLASSED",
};

/**
 * 无规则服交战/撤退策略：低血才撤（8/4），敌人多才避（8），交战距离 48，
 * 不看装备差（respectGearGap=false），图腾零储备也打（先活下来再补）。
 */
const ANARCHY_ENGAGEMENT_POLICY = Object.freeze({
  ...DEFAULT_ENGAGEMENT_POLICY,
  minimumEngageHealth: 8,
  minimumTotemCount: 0,
  maximumHostileCount: 8,
  maximumEngageDistance: 48,
  respectGearGap: false,
});

const ANARCHY_RETREAT_POLICY = Object.freeze({
  ...DEFAULT_RETREAT_POLICY,
  emergencyHealth: 4,
  withdrawHealth: 8,
  outnumberedAbove: 8,
  respectGearGap: false,
  // G1 实战加固（2026-09-03 luv）：anarchy/preserve-life 对纯 mob 群零门槛撤
  // ——裸装逃离而不是与怪物交战（用户产品方向）。
  avoidMeleeMobPacks: true,
});

const AGGRESSIVE_ENGAGEMENT_POLICY = Object.freeze({
  ...ANARCHY_ENGAGEMENT_POLICY,
  minimumEngageHealth: 4,
  maximumHostileCount: 99,
  maximumEngageDistance: 64,
});

const AGGRESSIVE_RETREAT_POLICY = Object.freeze({
  ...ANARCHY_RETREAT_POLICY,
  emergencyHealth: 3,
  withdrawHealth: 4,
  outnumberedAbove: 99,
});

export class CombatDriver {
  private readonly identity: CombatIdentityRegistry;
  private readonly threatAnalyzer: ThreatAnalyzer;
  /** 立场切换会重建（setStance），故非 readonly。 */
  private targetSelector: TargetSelector;
  private retreatController: RetreatController;
  private readonly retaliationTargetSelector: TargetSelector;
  private readonly retaliationRetreatController: RetreatController;
  private readonly predictionEngine = new PredictionEngine();
  private readonly interactionSequencer = new ChainSequencer();
  private policyGate: ServerPolicyGate;
  private readonly motionHistory = new Map<number, CombatMotionSample[]>();
  private totemManager: TotemManager;
  private retaliationTotemManager: TotemManager;
  private crystalEngine: CrystalEngine;
  private packetMineController: PacketMineController;
  private weaponManager: WeaponManager;
  private rotationController: RotationController;
  private movementController: MovementController;
  private lastObservedAtMs: number | null = null;
  private reflexProbe: CombatReflexProbeReport | null;
  /** 当前立场：构造后可由 combat.stance 技能切换（神谕/运维入口）。 */
  private currentStance: CombatSurvivalStance;
  private reflexClearance: CombatReflexDecision;
  private operationTail: Promise<void> = Promise.resolve();
  private connectionAbortController = new AbortController();
  private connectionGeneration = 0;
  private stance: CombatRuntimeStatusV1["stance"] = "disengaged";
  private target: CombatRuntimeStatusV1["target"] = null;
  private latestRefusal: CombatRuntimeStatusV1["latestRefusal"] = null;

  constructor(private readonly config: CombatDriverConfig) {
    if (config.policyGate.serverProfileId !== config.serverProfileId) {
      throw new TypeError("Combat policy and whitelist must use the same server profile.");
    }
    this.policyGate = config.policyGate;
    this.currentStance = config.stance;
    this.identity = CombatIdentityRegistry.fromOperatorConfig({
      provenance: "operator-config",
      serverProfileId: config.serverProfileId,
      selfUsername: config.selfUsername,
      usernames: config.whitelist.usernames,
      uuids: config.whitelist.uuids,
    });
    const anarchy = config.combatIntensity === "anarchy";
    this.threatAnalyzer = new ThreatAnalyzer(this.identity);
    this.targetSelector = new TargetSelector({
      ...this.engagementPolicyFor(anarchy, config.stance),
      stance: config.stance,
    });
    this.retreatController = new RetreatController({
      ...this.retreatPolicyFor(anarchy, config.stance),
      stance: config.stance,
    });
    this.retaliationTargetSelector = new TargetSelector({
      ...DEFAULT_ENGAGEMENT_POLICY,
      minimumEngageHealth: RETALIATION_CRITICAL_HEALTH,
      stance: "expendable",
      respectGearGap: false,
    });
    this.retaliationRetreatController = new RetreatController({
      ...DEFAULT_RETREAT_POLICY,
      emergencyHealth: RETALIATION_CRITICAL_HEALTH,
      withdrawHealth: RETALIATION_CRITICAL_HEALTH,
      stance: "expendable",
      respectGearGap: false,
    });
    this.reflexProbe = config.reflexProbe;
    this.reflexClearance = decideReflexClearance(
      this.reflexProbe,
      config.serverProfileId,
    );
    this.totemManager = this.newTotemManager();
    this.retaliationTotemManager = this.newTotemManager("expendable");
    this.crystalEngine = new CrystalEngine();
    this.packetMineController = this.newPacketMineController();
    this.weaponManager = new WeaponManager();
    this.rotationController = new RotationController();
    this.movementController = new MovementController();
  }

  observationAvailable(observation: CombatDriverObservation | null): boolean {
    if (
      observation === null ||
      observation.serverProfileId !== this.config.serverProfileId
    ) {
      return false;
    }
    try {
      this.validateObservation(observation);
      return true;
    } catch {
      return false;
    }
  }

  recordUnavailable(reasonCode: string, observedAtMs: number): void {
    if (!validErrorCode(reasonCode) || !validCombatTimestamp(observedAtMs)) return;
    this.latestRefusal = {
      reasonCode,
      observedAt: new Date(observedAtMs).toISOString(),
    };
  }

  shouldEngageProactively(observation: CombatDriverObservation, nowMs: number): boolean {
    if (!this.observationAvailable(observation) || observation.observedAtMs > nowMs ||
      nowMs - observation.observedAtMs > 250 || observation.self.health < 12 ||
      observation.weapons.length === 0 || observation.hazards === null) return false;
    const totalTotems = observation.self.inventoryTotemCount + Number(observation.self.offhandIsTotem);
    const assessment = this.threatAnalyzer.assess({ observedAtMs: observation.observedAtMs,
      serverProfileId: observation.serverProfileId, selfPosition: observation.self.position,
      selfHealth: observation.self.health, totemCount: totalTotems, entities: observation.entities });
    const players = new Set(observation.entities.filter(({ entity }) => entity.kind === "player").map(({ entity }) => entity.entityId));
    if (!assessment.threats.some((threat) => players.has(threat.entityId) && threat.distance <= 16)) return false;
    const gear = this.gearAssessment(observation, assessment.threats);
    if (this.currentStance !== "aggressive" && (gear.shouldAvoid || assessment.hostileCount > 3)) return false;
    const retreat = this.retreatController.evaluate(assessment, observation.self.health, observation.self.position,
      new Map(observation.entities.map((entity) => [entity.entity.entityId, entity.position])), gear);
    return !retreat.suppressOffense && this.targetSelector.select(assessment, observation.self.health, totalTotems, gear).target !== null;
  }

  status(): CombatRuntimeStatusV1 {
    return {
      schemaVersion: "1.0",
      stance: this.stance,
      target: this.target === null ? null : { ...this.target },
      latestRefusal:
        this.latestRefusal === null ? null : { ...this.latestRefusal },
      reflexProbe: this.reflexClearance.cleared
        ? { status: "cleared", denial: null }
        : this.reflexClearance.denial === null ||
            this.reflexClearance.denial === "NO_PROBE_DATA"
          ? { status: "not-run", denial: "NO_PROBE_DATA" }
          : { status: "denied", denial: this.reflexClearance.denial },
    };
  }

  interactionAudit(): readonly CombatChainStepRecord[] {
    return this.interactionSequencer.records();
  }

  /**
   * Install the probe report for the current connection. The runtime calls
   * this after spawn; a report is never implicitly carried across a reset.
   */
  setReflexProbe(report: CombatReflexProbeReport | null): void {
    this.reflexProbe = report;
    this.reflexClearance = decideReflexClearance(
      report,
      this.config.serverProfileId,
    );
  }

  /** Refresh the per-connection policy snapshot before a control request. */
  setPolicyGate(policyGate: ServerPolicyGate): void {
    if (policyGate.serverProfileId !== this.config.serverProfileId) {
      throw new TypeError("Combat policy and driver must use the same server profile.");
    }
    this.policyGate = policyGate;
    this.packetMineController = this.newPacketMineController();
  }

  reset(clearReflexProbe = true): void {
    this.connectionGeneration += 1;
    // Propagate reconnect/L0 cancellation to the adapter. A generation check
    // protects accounting, while this signal also stops in-flight movement
    // before a new connection can start another physical action.
    this.connectionAbortController.abort();
    this.connectionAbortController = new AbortController();
    // A reset, including an L0 pause reset, starts a new execution epoch. Do
    // not let a hung acknowledgement from the old epoch hold the new session's
    // serialized combat queue hostage. The generation check still prevents the
    // abandoned operation from recording state if it eventually returns.
    this.operationTail = Promise.resolve();
    this.policyGate.reset();
    this.totemManager.reset();
    this.retaliationTotemManager.reset();
    this.crystalEngine.reset();
    this.packetMineController.reset();
    this.weaponManager.reset();
    this.interactionSequencer.reset();
    // These controllers contain deterministic PRNG state, so recreating them
    // is required for a true reconnect reset; clearing only their timestamps
    // would carry the previous connection's phase into the next one.
    this.rotationController = new RotationController();
    this.movementController = new MovementController();
    this.motionHistory.clear();
    this.lastObservedAtMs = null;
    if (clearReflexProbe) this.reflexProbe = null;
    this.reflexClearance = decideReflexClearance(
      this.reflexProbe,
      this.config.serverProfileId,
    );
    this.stance = "disengaged";
    this.target = null;
    this.latestRefusal = null;
  }

  engage(
    observation: CombatDriverObservation,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
  ): Promise<CombatDriverReceipt> {
    const operationGeneration = this.connectionGeneration;
    return this.enqueueOperation(() => {
      if (operationGeneration !== this.connectionGeneration) {
        this.validateRequestTime(requestedAtMs);
        return Promise.resolve(this.refuse(
          "ENGAGE",
          requestedAtMs,
          "SKILL_EXECUTION_INTERRUPTED",
          null,
        ));
      }
      return this.engageInternal(
        observation,
        requestedAtMs,
        execute,
        signal,
        operationGeneration,
        "active",
      );
    });
  }

  /**
   * Defensive combat entered only after a live damage event. It may fight
   * without a totem and ignores a gear mismatch, while preserving health,
   * hostile-count, crystal, and anchor retreat gates.
   */
  retaliate(
    observation: CombatDriverObservation,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
  ): Promise<CombatDriverReceipt> {
    const operationGeneration = this.connectionGeneration;
    return this.enqueueOperation(() => {
      if (operationGeneration !== this.connectionGeneration) {
        this.validateRequestTime(requestedAtMs);
        return Promise.resolve(this.refuse(
          "ENGAGE",
          requestedAtMs,
          "SKILL_EXECUTION_INTERRUPTED",
          null,
        ));
      }
      return this.engageInternal(
        observation,
        requestedAtMs,
        execute,
        signal,
        operationGeneration,
        "retaliation",
      );
    });
  }

  private async engageInternal(
    observation: CombatDriverObservation,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
    mode: CombatEngagementMode,
  ): Promise<CombatDriverReceipt> {
    this.refreshPolicyGate();
    // Re-evaluate on every live-combat request. `decideReflexClearance` is
    // pure, so this keeps the gate explicit even when the injected report is
    // unchanged; a new connection must install a fresh report via
    // `setReflexProbe` after reset.
    this.reflexClearance = decideReflexClearance(
      this.reflexProbe,
      this.config.serverProfileId,
    );
    this.validateRequestTime(requestedAtMs);
    if (observation.serverProfileId !== this.config.serverProfileId) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_OBSERVATION_PROFILE_MISMATCH",
        null,
      );
    }
    try {
      this.validateObservation(observation);
    } catch {
      this.recordUnavailable(
        "COMBAT_OBSERVATION_UNAVAILABLE",
        requestedAtMs,
      );
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_OBSERVATION_UNAVAILABLE",
        null,
      );
    }
    this.recordObservationClock(observation.observedAtMs);
    this.ingestMotion(observation);

    // TotemManager is the highest preemption tier. It receives the smallest
    // validated self snapshot first; no target ranking, threat scoring, gear
    // comparison, or geometry may delay a live replacement/retreat.
    const totemManager = mode === "retaliation"
      ? this.retaliationTotemManager
      : this.totemManager;
    let totemDecision;
    try {
      const totemSnapshot = {
        nowMs: observation.observedAtMs,
        offhandIsTotem: observation.self.offhandIsTotem,
        ...(observation.self.totemPopObservedAtMs === undefined
          ? {}
          : { totemPopObservedAtMs: observation.self.totemPopObservedAtMs }),
        inventoryTotemCount: observation.self.inventoryTotemCount,
        selfHealth: observation.self.health,
        engaged: true,
      };
      // A missing reflex probe blocks sub-50ms replacement, but it must not
      // disable ordinary sword/bow combat. Totem replacement remains gated;
      // the weapon path below is tactical and still passes policy/reach checks.
      totemDecision = this.reflexClearance.cleared
        ? totemManager.decideForLiveCombat(
            totemSnapshot,
            this.reflexClearance,
          )
        : totemManager.decide(totemSnapshot);
    } catch (error) {
      if (!(error instanceof CombatReflexNotClearedError)) throw error;
      // 无规则档：没有探针也要补图腾（50ms 时序对抗的是外挂对手，不是
      // 自己人的反射精度）；standard 档维持"不确定就撤"的既有立场。
      if (this.config.combatIntensity === "anarchy") {
        totemDecision = {
          action: "REEQUIP_OFFHAND",
          reason: "TOTEM_MISSING",
          preempts: true,
          totemsRemainingAfter: 0,
        };
      } else {
        return this.executeRetreat(
          observation,
          requestedAtMs,
          execute,
          signal,
          expectedGeneration,
          "COMBAT_REFLEX_NOT_CLEARED",
          null,
          null,
        );
      }
    }

    if (totemDecision.action === "REEQUIP_OFFHAND") {
      if (
        !this.reflexClearance.cleared &&
        this.config.combatIntensity !== "anarchy"
      ) {
        return this.executeRetreat(
          observation,
          requestedAtMs,
          execute,
          signal,
          expectedGeneration,
          "COMBAT_REFLEX_NOT_CLEARED",
          null,
          this.fallbackRetreatDirection(observation),
        );
      }
      return this.executeAction(
        "ENGAGE",
        requestedAtMs,
        { kind: "REEQUIP_TOTEM" },
        observation,
        execute,
        signal,
        expectedGeneration,
        {
          disposition: "modified",
          action: "ENGAGE",
          reasonCode: "COMBAT_TOTEM_REEQUIPPED",
          targetEntityId: null,
        },
        (executedAtMs) => {
          totemManager.recordReequip(executedAtMs);
          if (
            totemDecision.reason === "TOTEM_POP_OBSERVED" &&
            observation.self.totemPopObservedAtMs !== undefined &&
            observation.self.totemPopObservedAtMs !== null
          ) {
            totemManager.recordTotemPopHandled(
              observation.self.totemPopObservedAtMs,
            );
          }
        },
      );
    }
    if (totemDecision.action === "RETREAT") {
      return this.executeRetreat(
        observation,
        requestedAtMs,
        execute,
        signal,
        expectedGeneration,
        "COMBAT_NO_TOTEM_AVAILABLE",
        null,
        this.fallbackRetreatDirection(observation),
      );
    }

    const totalTotems = observation.self.inventoryTotemCount +
      (observation.self.offhandIsTotem ? 1 : 0);
    // Threat/target facts are a read-only tactical prerequisite for supplying
    // the target position to CrystalEngine/PacketMineController. No tactical
    // or planning action is emitted before the higher preemption tier gets its
    // chance; the ordering here does not let target scoring override Totem.
    const assessment = this.threatAnalyzer.assess({
      observedAtMs: observation.observedAtMs,
      serverProfileId: observation.serverProfileId,
      selfPosition: observation.self.position,
      selfHealth: observation.self.health,
      totemCount: totalTotems,
      entities: observation.entities,
    });
    if (assessment.hostileCount === 0) {
      this.stance = "disengaged";
      this.target = null;
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_NO_HOSTILE_TARGET",
        null,
      );
    }

    const gear = this.gearAssessment(observation, assessment.threats);
    const targetSelector = mode === "retaliation"
      ? this.retaliationTargetSelector
      : this.targetSelector;
    const retreatController = mode === "retaliation"
      ? this.retaliationRetreatController
      : this.retreatController;
    const targetDecision = targetSelector.select(
      assessment,
      observation.self.health,
      totalTotems,
      gear,
    );
    const hostilePositions = new Map(
      observation.entities.map((entity) => [
        entity.entity.entityId,
        entity.position,
      ] as const),
    );
    const retreat = retreatController.evaluate(
      assessment,
      observation.self.health,
      observation.self.position,
      hostilePositions,
      gear,
    );
    const primaryThreat = targetDecision.target ?? assessment.threats[0] ?? null;
    this.target = this.publicTarget(primaryThreat, observation);
    if (retreat.suppressOffense) {
      return this.executeRetreat(
        observation,
        requestedAtMs,
        execute,
        signal,
        expectedGeneration,
        retreat.reasons[0]
          ? `COMBAT_${retreat.reasons[0]}`
          : "COMBAT_RETREAT_REQUIRED",
        primaryThreat?.entityId ?? null,
        retreat.direction,
      );
    }
    if (!targetDecision.target) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        TARGET_REFUSAL_CODES[targetDecision.refusal ?? "NO_HOSTILE_IN_RANGE"],
        primaryThreat?.entityId ?? null,
      );
    }

    this.stance = "engaging";
    const targetObservation = observation.entities.find(
      ({ entity }) => entity.entityId === targetDecision.target?.entityId,
    );
    if (!targetObservation) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_TARGET_OBSERVATION_STALE",
        targetDecision.target.entityId,
      );
    }
    const predictedTarget = this.predictedTargetPosition(
      targetObservation,
      observation,
    );

    let crystalReceipt: CombatDriverReceipt | null;
    if (
      observation.crystalCandidates !== null &&
      observation.crystalCandidates.length > 0
    ) {
      try {
        crystalReceipt = await this.tryCrystal(
          observation,
          predictedTarget,
          targetDecision.target,
          requestedAtMs,
          execute,
          signal,
          expectedGeneration,
        );
      } catch (error) {
        if (!(error instanceof CombatReflexNotClearedError)) throw error;
        // Explosive tactics are optional. Without a measured reflex window,
        // decline this candidate and continue with the safe weapon path.
        crystalReceipt = null;
      }
    } else {
      crystalReceipt = null;
    }
    if (crystalReceipt) return crystalReceipt;

    let mineReceipt: CombatDriverReceipt | null;
    if (
      observation.mineCandidates !== null &&
      observation.mineCandidates.length > 0
    ) {
      try {
        mineReceipt = await this.tryPacketMine(
          observation,
          targetDecision.target,
          requestedAtMs,
          execute,
          signal,
          expectedGeneration,
          totemDecision.preempts,
        );
      } catch (error) {
        if (!(error instanceof CombatReflexNotClearedError)) throw error;
        // Packet mining is reflex-gated as well; do not turn its denial into
        // a total loss of ordinary sword/bow response.
        mineReceipt = null;
      }
    } else {
      mineReceipt = null;
    }
    if (mineReceipt) return mineReceipt;

    return this.engageWithWeapon(
      observation,
      targetDecision.target,
      targetObservation,
      predictedTarget,
      requestedAtMs,
      execute,
      signal,
      expectedGeneration,
      mode === "retaliation",
    );
  }

  disengage(
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
  ): Promise<CombatDriverReceipt> {
    const operationGeneration = this.connectionGeneration;
    return this.enqueueOperation(() => {
      if (operationGeneration !== this.connectionGeneration) {
        this.validateRequestTime(requestedAtMs);
        return Promise.resolve(this.refuse(
          "DISENGAGE",
          requestedAtMs,
          "SKILL_EXECUTION_INTERRUPTED",
          null,
        ));
      }
      return this.disengageInternal(
        requestedAtMs,
        execute,
        signal,
        operationGeneration,
      );
    });
  }

  private async disengageInternal(
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
  ): Promise<CombatDriverReceipt> {
    this.refreshPolicyGate();
    this.validateRequestTime(requestedAtMs);
    if (this.stance === "disengaged") {
      return this.refuse(
        "DISENGAGE",
        requestedAtMs,
        "COMBAT_ALREADY_DISENGAGED",
        null,
      );
    }
    const receipt = await this.executeAction(
      "DISENGAGE",
      requestedAtMs,
      { kind: "DISENGAGE" },
      null,
      execute,
      signal,
      expectedGeneration,
      {
        disposition: "executed",
        action: "DISENGAGE",
        reasonCode: null,
        targetEntityId: this.target?.entityId ?? null,
      },
    );
    if (receipt.actual.executedAtMs !== null) {
      this.stance = "disengaged";
      this.target = null;
    }
    return receipt;
  }

  private tryCrystal(
    observation: CombatDriverObservation,
    targetPosition: CombatVector3,
    target: CombatThreat,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
  ): Promise<CombatDriverReceipt> | null {
    // null means the enumerator is unavailable; an empty list means it ran and
    // found no placement. Neither case requires entering the reflex-gated
    // crystal planner, so tactical melee may continue when no probe exists.
    if (
      observation.crystalCandidates === null ||
      observation.crystalCandidates.length === 0
    ) {
      return null;
    }
    const plan = this.crystalEngine.planForLiveCombat(
      observation.crystalCandidates,
      targetPosition,
      {
        position: observation.self.position,
        health: observation.self.health,
        totemMarginHealth: observation.self.offhandIsTotem ? 20 : 0,
        explosionMitigation01: observation.self.gear === null
          ? 0
          : explosionMitigation01(
              observation.self.gear,
              observation.explosionRuleSet,
            ),
      },
      this.reflexClearance,
    );
    if (!plan.chosen) return null;
    return this.executeAction(
      "ENGAGE",
      requestedAtMs,
      { kind: "PLACE_CRYSTAL", position: plan.chosen.candidate.position },
      observation,
      execute,
      signal,
      expectedGeneration,
      {
        disposition: "executed",
        action: "ENGAGE",
        reasonCode: null,
        targetEntityId: target.entityId,
      },
      (executedAtMs) => this.crystalEngine.recordPlacement(executedAtMs),
    );
  }

  private tryPacketMine(
    observation: CombatDriverObservation,
    target: CombatThreat,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
    totemPreempting: boolean,
  ): Promise<CombatDriverReceipt> | null {
    if (
      observation.mineCandidates === null ||
      observation.mineCandidates.length === 0
    ) {
      return null;
    }
    const plan = this.packetMineController.planForLiveCombat(
      {
        evaluatedAtMs: observation.observedAtMs,
        selfPosition: observation.self.position,
        engaged: true,
        suppressOffense: false,
        totemPreempting,
        candidates: observation.mineCandidates,
      },
      this.reflexClearance,
    );
    if (plan.assignments.length === 0) return null;
    return this.executeAction(
      "ENGAGE",
      requestedAtMs,
      { kind: "PACKET_MINE", assignments: plan.assignments },
      observation,
      execute,
      signal,
      expectedGeneration,
      {
        disposition: "executed",
        action: "ENGAGE",
        reasonCode: null,
        targetEntityId: target.entityId,
      },
      (executedAtMs) =>
        this.packetMineController.recordPlanExecuted(executedAtMs),
    );
  }

  private async engageWithWeapon(
    observation: CombatDriverObservation,
    target: CombatThreat,
    targetObservation: CombatDriverEntityObservation,
    predictedTarget: CombatVector3,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
    allowUnarmed: boolean,
  ): Promise<CombatDriverReceipt> {
    const selection = this.weaponManager.select(
      observation.weapons,
      target.distance,
    );
    const unarmed = selection.weapon === null && allowUnarmed;
    const weapon: CombatWeaponCandidate | null = selection.weapon ??
      (unarmed
        ? {
            slot: 0,
            itemName: "unarmed",
            kind: "other",
            baseDamage: 1,
            fullCooldownMs: 625,
            durabilityRemaining: null,
            enchantmentDamageBonus: 0,
          }
        : null);
    if (weapon === null) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_NO_USABLE_WEAPON",
        target.entityId,
      );
    }

    const ranged = selection.mode === "ranged";
    const reach = ranged
      ? null
      : this.policyGate.checkAttackReach(target.distance);
    if (reach !== null && !reach.allowed) {
      return this.moveTowardTarget(
        observation,
        targetObservation.position,
        target,
        requestedAtMs,
        execute,
        signal,
        expectedGeneration,
      );
    }

    // Check the shared combat policy before weapon-specific cooldown logic so
    // a request clipped by the global action window reports the policy denial
    // deterministically rather than exposing an internal weapon timer.
    const attackRate = ranged
      ? null
      : this.policyGate.checkActionRate(
          "attack",
          observation.observedAtMs,
        );
    if (attackRate !== null && !attackRate.allowed) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        attackRate.errorCode,
        target.entityId,
        attackRate.errorCode === "POLICY_ACTION_INTERVAL_TOO_SHORT" ||
            attackRate.errorCode === "POLICY_RATE_EXCEEDED"
          ? "delayed"
          : "dropped",
      );
    }

    if (!unarmed && observation.self.heldItemSlot !== weapon.slot) {
      return this.executeAction(
        "ENGAGE",
        requestedAtMs,
        { kind: "EQUIP_WEAPON", slot: weapon.slot },
        observation,
        execute,
        signal,
        expectedGeneration,
        {
          disposition: "modified",
          action: "ENGAGE",
          reasonCode: "COMBAT_WEAPON_EQUIPPED",
          targetEntityId: target.entityId,
        },
      );
    }

    const desired = orientationToward(
      eyePosition(observation.self.position),
      { ...predictedTarget, y: predictedTarget.y + 0.9 },
    );
    const rotation = this.rotationController.step(
      observation.self.orientation,
      desired,
    );
    if (!rotation.aimed) {
      const policyRotation = this.policyGate.clampRotation(
        observation.self.orientation,
        rotation.orientation,
        50,
      );
      return this.executeAction(
        "ENGAGE",
        requestedAtMs,
        {
          kind: "ROTATE",
          orientation: {
            yaw: policyRotation.yaw,
            pitch: policyRotation.pitch,
          },
        },
        observation,
        execute,
        signal,
        expectedGeneration,
        {
          disposition: policyRotation.clamped ? "clipped" : "modified",
          action: "ENGAGE",
          reasonCode: policyRotation.clamped
            ? "COMBAT_ROTATION_POLICY_CLIPPED"
            : "COMBAT_ROTATION_IN_PROGRESS",
          targetEntityId: target.entityId,
        },
      );
    }

    if (ranged) {
      const rangedDecision = this.weaponManager.evaluateRanged(
        weapon,
        observation.observedAtMs,
        target.distance,
        observation.self.usingHeldItem ?? false,
      );
      if (rangedDecision.action === "DRAW") {
        return this.executeAction(
          "ENGAGE",
          requestedAtMs,
          { kind: "DRAW_RANGED_WEAPON", weaponSlot: weapon.slot },
          observation,
          execute,
          signal,
          expectedGeneration,
          {
            disposition: "modified",
            action: "ENGAGE",
            reasonCode: "COMBAT_RANGED_DRAW_STARTED",
            targetEntityId: target.entityId,
          },
          (executedAtMs) => this.weaponManager.recordDrawStart(executedAtMs),
        );
      }
      if (rangedDecision.action === "HOLD") {
        return this.refuse(
          "ENGAGE",
          requestedAtMs,
          "COMBAT_RANGED_DRAWING",
          target.entityId,
          "delayed",
        );
      }
      if (rangedDecision.action === "RELEASE") {
        return this.executeAction(
          "ENGAGE",
          requestedAtMs,
          {
            kind: "RELEASE_RANGED_WEAPON",
            targetEntityId: target.entityId,
            weaponSlot: weapon.slot,
          },
          observation,
          execute,
          signal,
          expectedGeneration,
          {
            disposition: "executed",
            action: "ENGAGE",
            reasonCode: null,
            targetEntityId: target.entityId,
          },
          () => this.weaponManager.recordRelease(),
        );
      }
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        `COMBAT_RANGED_${rangedDecision.reason}`,
        target.entityId,
      );
    }

    const targetInvulnerableRemainingMs =
      targetObservation.invulnerableRemainingMs ?? 0;
    if (
      targetInvulnerableRemainingMs > 0 &&
      observation.hazards !== null
    ) {
      const spacing = this.movementController.plan({
        nowMs: observation.observedAtMs,
        selfPosition: observation.self.position,
        targetPosition: targetObservation.position,
        hazards: observation.hazards,
        retreatDirection: null,
        targetInvulnerableRemainingMs,
      });
      if (
        spacing.direction !== null &&
        (spacing.intent === "BACK_OFF" || spacing.intent === "CLOSE_IN")
      ) {
        return this.executeAction(
          "ENGAGE",
          requestedAtMs,
          {
            kind: "MOVE",
            direction: spacing.direction,
            sprint: false,
            durationMs: Math.max(
              100,
              Math.min(MOVEMENT_ACTION_MS, targetInvulnerableRemainingMs),
            ),
          },
          observation,
          execute,
          signal,
          expectedGeneration,
          {
            disposition: "modified",
            action: "ENGAGE",
            reasonCode: "COMBAT_HIT_WINDOW_SPACING",
            targetEntityId: target.entityId,
          },
        );
      }
    }

    const swing = this.weaponManager.evaluateSwing(
      weapon,
      observation.observedAtMs,
      true,
      targetInvulnerableRemainingMs,
    );
    if (!swing.shouldAttack) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        swing.reason === "COOLDOWN"
          ? "COMBAT_WEAPON_COOLDOWN"
          : swing.reason === "TARGET_INVULNERABLE"
            ? "COMBAT_TARGET_INVULNERABLE"
          : `COMBAT_${swing.reason}`,
        target.entityId,
        "delayed",
      );
    }
    return this.executeAction(
      "ENGAGE",
      requestedAtMs,
      {
        kind: "MELEE_ATTACK",
        targetEntityId: target.entityId,
        weaponSlot: unarmed ? null : weapon.slot,
      },
      observation,
      execute,
      signal,
      expectedGeneration,
      {
        disposition: "executed",
        action: "ENGAGE",
        reasonCode: null,
        targetEntityId: target.entityId,
      },
      (executedAtMs) => this.weaponManager.recordSwing(weapon, executedAtMs),
    );
  }

  private async moveTowardTarget(
    observation: CombatDriverObservation,
    targetPosition: CombatVector3,
    target: CombatThreat,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
  ): Promise<CombatDriverReceipt> {
    if (observation.hazards === null) {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        "COMBAT_HAZARD_OBSERVATION_UNAVAILABLE",
        target.entityId,
      );
    }
    const movement = this.movementController.plan({
      nowMs: observation.observedAtMs,
      selfPosition: observation.self.position,
      targetPosition,
      hazards: observation.hazards,
      retreatDirection: null,
      targetInvulnerableRemainingMs: observation.entities.find(
        ({ entity }) => entity.entityId === target.entityId,
      )?.invulnerableRemainingMs ?? 0,
    });
    if (!movement.direction || movement.intent === "HOLD") {
      return this.refuse(
        "ENGAGE",
        requestedAtMs,
        movement.blockedByHazard
          ? "COMBAT_MOVEMENT_BLOCKED_BY_HAZARD"
          : "COMBAT_MOVEMENT_NOT_REQUIRED",
        target.entityId,
      );
    }
    return this.executeAction(
      "ENGAGE",
      requestedAtMs,
      {
        kind: "MOVE",
        direction: movement.direction,
        sprint: movement.sprint && this.policyGate.limits.allowSprint,
        durationMs: MOVEMENT_ACTION_MS,
      },
      observation,
      execute,
      signal,
      expectedGeneration,
      {
        disposition: "modified",
        action: "ENGAGE",
        reasonCode: "COMBAT_CLOSING_DISTANCE",
        targetEntityId: target.entityId,
      },
    );
  }

  private async executeRetreat(
    observation: CombatDriverObservation,
    requestedAtMs: number,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
    reasonCode: string,
    targetEntityId: number | null,
    direction: CombatVector3 | null,
  ): Promise<CombatDriverReceipt> {
    this.stance = "retreating";
    let safeDirection = direction;
    if (direction !== null) {
      // RetreatController supplies a geometric direction, not a movement
      // clearance. Route it through MovementController before touching the
      // adapter so a lava/void hazard cannot be crossed blindly.
      if (observation.hazards === null) {
        return this.refuse(
          "ENGAGE",
          requestedAtMs,
          "COMBAT_HAZARD_OBSERVATION_UNAVAILABLE",
          targetEntityId,
        );
      }
      const targetPosition = targetEntityId === null
        ? null
        : observation.entities.find(
            ({ entity }) => entity.entityId === targetEntityId,
          )?.position ?? null;
      const movement = this.movementController.plan({
        nowMs: observation.observedAtMs,
        selfPosition: observation.self.position,
        targetPosition,
        hazards: observation.hazards,
        retreatDirection: direction,
      });
      if (movement.direction === null || movement.blockedByHazard) {
        return this.refuse(
          "ENGAGE",
          requestedAtMs,
          "COMBAT_MOVEMENT_BLOCKED_BY_HAZARD",
          targetEntityId,
        );
      }
      safeDirection = movement.direction;
    }
    return this.executeAction(
      "ENGAGE",
      requestedAtMs,
      {
        kind: "RETREAT_MOVE",
        direction: safeDirection,
        sprint:
          safeDirection !== null && this.policyGate.limits.allowSprint,
        durationMs: MOVEMENT_ACTION_MS,
      },
      observation,
      execute,
      signal,
      expectedGeneration,
      {
        disposition: "modified",
        action: "RETREAT",
        reasonCode,
        targetEntityId,
      },
    );
  }

  private async executeAction(
    requestedAction: "ENGAGE" | "DISENGAGE",
    requestedAtMs: number,
    primitive: CombatPrimitiveAction,
    observation: CombatDriverObservation | null,
    execute: CombatActionExecutor,
    signal: AbortSignal,
    expectedGeneration: number,
    success: ActionSuccess,
    afterAck?: (executedAtMs: number) => void,
  ): Promise<CombatDriverReceipt> {
    const actionGeneration = expectedGeneration;
    if (actionGeneration !== this.connectionGeneration) {
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "SKILL_EXECUTION_INTERRUPTED",
        success.targetEntityId,
      );
    }
    if (signal.aborted) {
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "SKILL_CANCELLED",
        success.targetEntityId,
      );
    }
    const policy = this.checkPolicy(primitive, observation);
    if (!policy.allowed) {
      return this.refuse(
        requestedAction,
        requestedAtMs,
        policy.denial,
        success.targetEntityId,
        policy.denial === "POLICY_RATE_EXCEEDED" ||
            policy.denial === "POLICY_ACTION_INTERVAL_TOO_SHORT"
          ? "delayed"
          : "dropped",
      );
    }

    const interactionClass = interactionClassForPrimitive(primitive);
    const interactionLabel = interactionClass === null
      ? null
      : `${actionGeneration}:${requestedAtMs}:${primitive.kind}`;
    if (interactionClass !== null && interactionLabel !== null) {
      const sequence = this.interactionSequencer.beginChain(
        [{ label: interactionLabel, interactionClass }],
        requestedAtMs,
        {
          retreatInProgress: false,
          clearance: this.reflexClearance,
        },
      );
      if (sequence.state !== "STEP_READY") {
        return this.refuse(
          requestedAction,
          requestedAtMs,
          sequence.refusal === "THROTTLED"
            ? "COMBAT_INTERACTION_THROTTLED"
            : `COMBAT_CHAIN_${sequence.refusal ?? "NOT_READY"}`,
          success.targetEntityId,
          sequence.refusal === "THROTTLED" ? "delayed" : "dropped",
        );
      }
    }
    const abandonInteraction = (): void => {
      if (interactionLabel !== null) this.interactionSequencer.abandonChain();
    };

    const epochSignal = this.connectionAbortController.signal;
    const actionController = new AbortController();
    const abortAction = () => actionController.abort();
    signal.addEventListener("abort", abortAction, { once: true });
    epochSignal.addEventListener("abort", abortAction, { once: true });
    if (signal.aborted || epochSignal.aborted) actionController.abort();

    let rawAcknowledgement: unknown;
    try {
      rawAcknowledgement = await execute(primitive, actionController.signal);
    } catch {
      abandonInteraction();
      if (actionGeneration !== this.connectionGeneration) {
        return this.refuse(
          requestedAction,
          requestedAtMs,
          "SKILL_EXECUTION_INTERRUPTED",
          success.targetEntityId,
        );
      }
      if (signal.aborted || epochSignal.aborted) {
        return this.refuse(
          requestedAction,
          requestedAtMs,
          "SKILL_CANCELLED",
          success.targetEntityId,
        );
      }
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "COMBAT_ACTION_EXECUTION_FAILED",
        success.targetEntityId,
      );
    } finally {
      signal.removeEventListener("abort", abortAction);
      epochSignal.removeEventListener("abort", abortAction);
    }
    // A disconnect/L0 reset may happen while the adapter is awaiting a server
    // acknowledgement. The old ACK must not mutate the newly reset managers
    // or policy window, even if the underlying packet was already sent.
    if (actionGeneration !== this.connectionGeneration) {
      abandonInteraction();
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "SKILL_EXECUTION_INTERRUPTED",
        success.targetEntityId,
      );
    }
    // The adapter may complete a packet-level operation after cancellation.
    // Report the request as cancelled and do not record it as an executed
    // combat action in the new audit/rate state.
    if (signal.aborted || epochSignal.aborted) {
      abandonInteraction();
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "SKILL_CANCELLED",
        success.targetEntityId,
      );
    }
    const acknowledgement = parseCombatActionAcknowledgement(rawAcknowledgement);
    if (acknowledgement === null) {
      abandonInteraction();
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "COMBAT_EXECUTION_ACK_INVALID",
        success.targetEntityId,
      );
    }
    if (acknowledgement.outcome !== "executed") {
      abandonInteraction();
      return this.refuse(
        requestedAction,
        requestedAtMs,
        validErrorCode(acknowledgement.reasonCode)
          ? acknowledgement.reasonCode
          : "COMBAT_ACTION_EXECUTION_FAILED",
        success.targetEntityId,
      );
    }
    if (
      !validCombatTimestamp(acknowledgement.executedAtMs) ||
      acknowledgement.executedAtMs < requestedAtMs
    ) {
      abandonInteraction();
      return this.refuse(
        requestedAction,
        requestedAtMs,
        "COMBAT_EXECUTION_ACK_INVALID",
        success.targetEntityId,
      );
    }

    for (const kind of policy.record.actionKinds) {
      this.policyGate.recordAction(kind, acknowledgement.executedAtMs);
    }
    const interactionRecord = interactionLabel === null
      ? null
      : this.interactionSequencer.recordStepAcked(
          interactionLabel,
          acknowledgement.executedAtMs,
        );
    policy.record.afterAck?.(acknowledgement.executedAtMs);
    afterAck?.(acknowledgement.executedAtMs);
    const interactionAckLate =
      interactionRecord?.acknowledgedWithinBudget === false;
    const receipt: CombatDriverReceipt = {
      requested: { action: requestedAction, requestedAtMs },
      actual: {
        disposition: interactionAckLate ? "delayed" : success.disposition,
        action: success.action,
        primitiveAction: primitive.kind,
        executedAtMs: acknowledgement.executedAtMs,
        reasonCode: interactionAckLate
          ? "COMBAT_CHAIN_STEP_UNACKED"
          : success.reasonCode,
        targetEntityId: success.targetEntityId,
      },
    };
    this.observeReceipt(receipt);
    return receipt;
  }

  private checkPolicy(
    action: CombatPrimitiveAction,
    observation: CombatDriverObservation | null,
  ): PolicyCheck {
    const allowed = (
      actionKinds: readonly PolicyActionKind[] = [],
    ): PolicyCheck => ({ allowed: true, record: { actionKinds } });
    const rate = (
      kind: PolicyActionKind,
      nowMs: number,
    ): PolicyCheck => {
      const decision = this.policyGate.checkActionRate(kind, nowMs);
      return decision.allowed
        ? allowed([kind])
        : { allowed: false, denial: decision.errorCode };
    };

    if (
      action.kind === "DISENGAGE" ||
      action.kind === "ROTATE" ||
      action.kind === "DRAW_RANGED_WEAPON"
    ) {
      return allowed();
    }
    if (!observation) {
      return { allowed: false, denial: "POLICY_RATE_EXCEEDED" };
    }
    if (action.kind === "REEQUIP_TOTEM" || action.kind === "EQUIP_WEAPON") {
      return rate("hotbar-switch", observation.observedAtMs);
    }
    if (action.kind === "MELEE_ATTACK") {
      const target = observation.entities.find(
        ({ entity }) => entity.entityId === action.targetEntityId,
      );
      if (!target) {
        return { allowed: false, denial: "POLICY_ATTACK_REACH_EXCEEDED" };
      }
      const distance = distanceBetween(
        observation.self.position,
        target.position,
      );
      const reach = this.policyGate.checkAttackReach(distance);
      if (!reach.allowed) return { allowed: false, denial: reach.errorCode };
      return rate("attack", observation.observedAtMs);
    }
    if (action.kind === "RELEASE_RANGED_WEAPON") {
      const target = observation.entities.find(
        ({ entity }) => entity.entityId === action.targetEntityId,
      );
      const weapon = observation.weapons.find(
        ({ slot }) => slot === action.weaponSlot,
      );
      if (
        !target ||
        !weapon ||
        (weapon.kind !== "bow" && weapon.kind !== "crossbow") ||
        weapon.effectiveRange === undefined ||
        distanceBetween(observation.self.position, target.position) >
          weapon.effectiveRange
      ) {
        return { allowed: false, denial: "POLICY_ATTACK_REACH_EXCEEDED" };
      }
      return rate("attack", observation.observedAtMs);
    }
    if (action.kind === "PLACE_CRYSTAL") {
      const reach = this.policyGate.checkBlockReach(
        distanceBetween(observation.self.position, action.position),
      );
      if (!reach.allowed) return { allowed: false, denial: reach.errorCode };
      return rate("place", observation.observedAtMs);
    }
    if (action.kind === "PACKET_MINE") {
      for (const assignment of action.assignments) {
        const reach = this.policyGate.checkBlockReach(
          distanceBetween(observation.self.position, assignment.position),
        );
        if (!reach.allowed) return { allowed: false, denial: reach.errorCode };
      }
      return rate("dig-start", observation.observedAtMs);
    }

    const movement = this.policyGate.checkMovement({
      sprint: "sprint" in action ? action.sprint : false,
      jump: false,
      airStrafe: false,
      fallBlocks: observation.self.onGround
        ? 0
        : observation.self.fallDistance ?? Number.POSITIVE_INFINITY,
    });
    return movement.allowed
      ? allowed()
      : { allowed: false, denial: movement.errorCode };
  }

  private gearAssessment(
    observation: CombatDriverObservation,
    threats: readonly CombatThreat[],
  ): CombatGearAssessment {
    const strongestWeapon = this.weaponManager.select(
      observation.weapons,
      null,
    ).effectiveDamage;
    const selfGear: CombatGearSnapshot = observation.self.gear
      ? {
          ...observation.self.gear,
          weaponDamage: Math.max(
            observation.self.gear.weaponDamage,
            strongestWeapon,
          ),
        }
      : {
          armorMaterial: "none",
          protectionLevel: 0,
          blastProtectionLevel: 0,
          armorPieceCount: 0,
          weaponDamage: strongestWeapon,
          health: Math.min(20, observation.self.health),
          hasTotem: observation.self.offhandIsTotem,
        };
    const hostileIds = new Set(threats.map(({ entityId }) => entityId));
    const opponents = observation.entities
      .filter(({ entity }) => hostileIds.has(entity.entityId))
      .map(({ gear }) => gear);
    return assessWorstMatchup(
      selfGear,
      opponents,
      {
        ...DEFAULT_GEAR_POLICY,
        treatUnknownAsOutclassed: this.config.stance === "preserve-life",
      },
      observation.explosionRuleSet,
    );
  }

  private ingestMotion(observation: CombatDriverObservation): void {
    const observedIds = new Set<number>();
    for (const entity of observation.entities) {
      const entityId = entity.entity.entityId;
      observedIds.add(entityId);
      const samples = this.motionHistory.get(entityId) ?? [];
      samples.push({
        observedAtMs: observation.observedAtMs,
        serverProfileId: observation.serverProfileId,
        dimension: observation.dimension,
        position: entity.position,
      });
      if (samples.length > MOTION_HISTORY_LIMIT) {
        samples.splice(0, samples.length - MOTION_HISTORY_LIMIT);
      }
      this.motionHistory.set(entityId, samples);
    }
    for (const entityId of this.motionHistory.keys()) {
      if (!observedIds.has(entityId)) this.motionHistory.delete(entityId);
    }
  }

  private predictedTargetPosition(
    target: CombatDriverEntityObservation,
    observation: CombatDriverObservation,
  ): CombatVector3 {
    const prediction = this.predictionEngine.predict(
      this.motionHistory.get(target.entity.entityId) ?? [],
      observation.latencyMs ?? 0,
      observation.serverProfileId,
      observation.dimension,
    );
    return prediction.position ?? target.position;
  }

  private fallbackRetreatDirection(
    observation: CombatDriverObservation,
  ): CombatVector3 | null {
    let weightSum = 0;
    let x = 0;
    let z = 0;
    for (const entity of observation.entities) {
      try {
        if (!this.identity.isHostile(entity.entity, observation.serverProfileId)) {
          continue;
        }
      } catch {
        continue;
      }
      const weight = 1 / Math.max(
        1,
        distanceBetween(observation.self.position, entity.position),
      );
      weightSum += weight;
      x += entity.position.x * weight;
      z += entity.position.z * weight;
    }
    if (weightSum === 0) return null;
    const awayX = observation.self.position.x - x / weightSum;
    const awayZ = observation.self.position.z - z / weightSum;
    const magnitude = Math.hypot(awayX, awayZ);
    if (magnitude < 1e-9) return null;
    return { x: awayX / magnitude, y: 0, z: awayZ / magnitude };
  }

  private publicTarget(
    threat: CombatThreat | null,
    observation: CombatDriverObservation,
  ): CombatRuntimeStatusV1["target"] {
    if (!threat) return null;
    const entity = observation.entities.find(
      (candidate) => candidate.entity.entityId === threat.entityId,
    )?.entity;
    if (!entity || (entity.kind !== "player" && entity.kind !== "monster")) {
      return null;
    }
    return { entityId: entity.entityId, kind: entity.kind };
  }

  private refuse(
    requestedAction: "ENGAGE" | "DISENGAGE",
    requestedAtMs: number,
    reasonCode: string,
    targetEntityId: number | null,
    disposition: "delayed" | "dropped" = "dropped",
  ): CombatDriverReceipt {
    const receipt: CombatDriverReceipt = {
      requested: { action: requestedAction, requestedAtMs },
      actual: {
        disposition,
        action: "NONE",
        primitiveAction: "NONE",
        executedAtMs: null,
        reasonCode: validErrorCode(reasonCode)
          ? reasonCode
          : "COMBAT_ACTION_EXECUTION_FAILED",
        targetEntityId,
      },
    };
    this.observeReceipt(receipt);
    return receipt;
  }

  private observeReceipt(receipt: CombatDriverReceipt): void {
    const refusal = receipt.actual.reasonCode;
    if (
      refusal !== null &&
      (receipt.actual.disposition === "dropped" ||
        receipt.actual.disposition === "delayed" ||
        receipt.actual.action === "RETREAT")
    ) {
      this.latestRefusal = {
        reasonCode: refusal,
        observedAt: new Date(receipt.requested.requestedAtMs).toISOString(),
      };
    }
  }

  private recordObservationClock(observedAtMs: number): void {
    if (this.lastObservedAtMs !== null && observedAtMs < this.lastObservedAtMs) {
      throw new RangeError("Combat observation clock moved backwards.");
    }
    this.lastObservedAtMs = observedAtMs;
  }

  private validateRequestTime(requestedAtMs: number): void {
    if (!validCombatTimestamp(requestedAtMs)) {
      throw new TypeError("requestedAtMs must be a non-negative safe integer.");
    }
  }

  private validateObservation(observation: CombatDriverObservation): void {
    if (
      !validCombatTimestamp(observation.observedAtMs) ||
      typeof observation.dimension !== "string" ||
      observation.dimension.trim().length === 0 ||
      (observation.explosionRuleSet !== null &&
        observation.explosionRuleSet !== "java-1.21-release") ||
      (observation.latencyMs !== null &&
        (!Number.isFinite(observation.latencyMs) || observation.latencyMs < 0)) ||
      !Number.isFinite(observation.self.health) ||
      observation.self.health < 0 ||
      !Number.isInteger(observation.self.inventoryTotemCount) ||
      observation.self.inventoryTotemCount < 0 ||
      typeof observation.self.offhandIsTotem !== "boolean" ||
      (observation.self.usingHeldItem !== undefined &&
        typeof observation.self.usingHeldItem !== "boolean") ||
      typeof observation.self.onGround !== "boolean"
    ) {
      throw new TypeError("Combat observation is malformed.");
    }
    if (
      observation.self.totemPopObservedAtMs !== undefined &&
      observation.self.totemPopObservedAtMs !== null &&
      (!Number.isSafeInteger(observation.self.totemPopObservedAtMs) ||
        observation.self.totemPopObservedAtMs < 0 ||
        observation.self.totemPopObservedAtMs > observation.observedAtMs)
    ) {
      throw new TypeError("Combat observation totem POP time is malformed.");
    }
    validateCombatVector(observation.self.position, "self.position");
    validateCombatOrientation(observation.self.orientation);
    if (observation.self.gear !== null) {
      validateCombatGear(observation.self.gear, "self.gear");
    }
    if (
      observation.self.heldItemSlot !== null &&
      (!Number.isSafeInteger(observation.self.heldItemSlot) ||
        observation.self.heldItemSlot < 0)
    ) {
      throw new TypeError("Combat observation heldItemSlot is malformed.");
    }
    if (
      observation.self.fallDistance !== null &&
      (!Number.isFinite(observation.self.fallDistance) ||
        observation.self.fallDistance < 0)
    ) {
      throw new TypeError("Combat observation fallDistance is malformed.");
    }
    const entityIds = new Set<number>();
    for (const entity of observation.entities) {
      if (typeof entity !== "object" || entity === null ||
        typeof entity.entity !== "object" || entity.entity === null) {
        throw new TypeError("Combat observation entity is malformed.");
      }
      if (
        !Number.isSafeInteger(entity.entity.entityId) ||
        entity.entity.entityId < 0 ||
        entityIds.has(entity.entity.entityId)
      ) {
        throw new TypeError("Combat observation entity IDs are malformed.");
      }
      if (
        !ENTITY_KINDS.has(entity.entity.kind) ||
        (entity.entity.username !== null && typeof entity.entity.username !== "string") ||
        (entity.entity.uuid !== null && typeof entity.entity.uuid !== "string") ||
        (entity.entity.mobType !== undefined && entity.entity.mobType !== null &&
          typeof entity.entity.mobType !== "string") ||
        (entity.entity.endermanState !== undefined &&
          entity.entity.endermanState !== null &&
          entity.entity.endermanState !== "calm" &&
          entity.entity.endermanState !== "angry" &&
          entity.entity.endermanState !== "unknown") ||
        typeof entity.wieldingWeapon !== "boolean" ||
        typeof entity.crystalNearby !== "boolean" ||
        typeof entity.anchorNearby !== "boolean" ||
        (entity.recentlyPopped !== undefined &&
          typeof entity.recentlyPopped !== "boolean") ||
        (entity.invulnerableRemainingMs !== undefined &&
          (!Number.isFinite(entity.invulnerableRemainingMs) ||
            entity.invulnerableRemainingMs < 0)) ||
        (entity.targetCooldownRatio01 !== undefined &&
          (!Number.isFinite(entity.targetCooldownRatio01) ||
            entity.targetCooldownRatio01 < 0 ||
            entity.targetCooldownRatio01 > 1))
      ) {
        throw new TypeError("Combat observation entity facts are malformed.");
      }
      entityIds.add(entity.entity.entityId);
      validateCombatVector(entity.position, "entity.position");
      if (entity.velocity !== null) {
        validateCombatVector(entity.velocity, "entity.velocity");
      }
      if (entity.health !== null && (!Number.isFinite(entity.health) || entity.health < 0)) {
        throw new TypeError("Combat observation entity health is malformed.");
      }
      if (entity.armorPoints !== null &&
        (!Number.isFinite(entity.armorPoints) || entity.armorPoints < 0)) {
        throw new TypeError("Combat observation entity armor is malformed.");
      }
      if (entity.gear !== null) {
        validateCombatGear(entity.gear, "entity.gear");
      }
    }
    for (const weapon of observation.weapons) {
      if (
        !Number.isSafeInteger(weapon.slot) ||
        weapon.slot < 0 ||
        typeof weapon.itemName !== "string" ||
        !WEAPON_KINDS.has(weapon.kind) ||
        !Number.isFinite(weapon.baseDamage) ||
        weapon.baseDamage < 0 ||
        !Number.isFinite(weapon.fullCooldownMs) ||
        weapon.fullCooldownMs <= 0 ||
        (weapon.durabilityRemaining !== null &&
          (!Number.isFinite(weapon.durabilityRemaining) || weapon.durabilityRemaining < 0)) ||
        !Number.isFinite(weapon.enchantmentDamageBonus) ||
        weapon.enchantmentDamageBonus < 0
      ) {
        throw new TypeError("Combat observation weapon data is malformed.");
      }
      if (weapon.ammoRemaining !== undefined && weapon.ammoRemaining !== null &&
        (!Number.isInteger(weapon.ammoRemaining) || weapon.ammoRemaining < 0)) {
        throw new TypeError("Combat observation weapon ammo is malformed.");
      }
      if (weapon.drawTimeMs !== undefined &&
        (!Number.isFinite(weapon.drawTimeMs) || weapon.drawTimeMs <= 0)) {
        throw new TypeError("Combat observation weapon draw time is malformed.");
      }
      if (weapon.effectiveRange !== undefined &&
        (!Number.isFinite(weapon.effectiveRange) || weapon.effectiveRange < 0)) {
        throw new TypeError("Combat observation weapon range is malformed.");
      }
    }
    for (const candidate of observation.crystalCandidates ?? []) {
      if (typeof candidate !== "object" || candidate === null ||
        typeof candidate.hasValidBase !== "boolean" ||
        typeof candidate.spaceObstructed !== "boolean" ||
        !Number.isFinite(candidate.targetOcclusion) ||
        candidate.targetOcclusion < 0 || candidate.targetOcclusion > 1 ||
        !Number.isFinite(candidate.selfOcclusion) ||
        candidate.selfOcclusion < 0 || candidate.selfOcclusion > 1) {
        throw new TypeError("Combat observation crystal candidate is malformed.");
      }
      validateCombatVector(candidate.position, "crystal.position");
    }
    for (const candidate of observation.mineCandidates ?? []) {
      if (typeof candidate !== "object" || candidate === null ||
        !Number.isFinite(candidate.estimatedBreakMs) ||
        candidate.estimatedBreakMs < 0 ||
        typeof candidate.unbreakable !== "boolean" ||
        typeof candidate.hasMatchingTool !== "boolean" ||
        !Number.isFinite(candidate.distanceToTarget) ||
        candidate.distanceToTarget < 0) {
        throw new TypeError("Combat observation mine candidate is malformed.");
      }
      validateCombatVector(candidate.position, "mine.position");
    }
    for (const hazard of observation.hazards ?? []) {
      validateCombatVector(hazard, "hazard");
    }
  }

  private engagementPolicyFor(
    anarchy: boolean,
    stance: CombatSurvivalStance,
  ) {
    if (stance === "aggressive") return AGGRESSIVE_ENGAGEMENT_POLICY;
    return anarchy ? ANARCHY_ENGAGEMENT_POLICY : DEFAULT_ENGAGEMENT_POLICY;
  }

  private retreatPolicyFor(
    anarchy: boolean,
    stance: CombatSurvivalStance,
  ) {
    if (stance === "aggressive") return AGGRESSIVE_RETREAT_POLICY;
    return anarchy ? ANARCHY_RETREAT_POLICY : DEFAULT_RETREAT_POLICY;
  }

  /** 当前立场（combat.stance 技能与状态遥测消费）。 */
  survivalStance(): CombatSurvivalStance {
    return this.currentStance;
  }

  /**
   * 切换存活立场（神谕"combat-stance"菜单项的执行面）。重建受立场影响
   * 的控制器，保持连接/策略/节奏状态不动——这是一次纯战术参数切换。
   */
  setStance(next: CombatSurvivalStance): CombatSurvivalStance {
    this.currentStance = validateSurvivalStance(next);
    const anarchy = this.config.combatIntensity === "anarchy";
    this.targetSelector = new TargetSelector({
      ...this.engagementPolicyFor(anarchy, this.currentStance),
      stance: this.currentStance,
    });
    this.retreatController = new RetreatController({
      ...this.retreatPolicyFor(anarchy, this.currentStance),
      stance: this.currentStance,
    });
    this.totemManager = this.newTotemManager(this.currentStance);
    return this.currentStance;
  }

  private newTotemManager(
    stance: CombatSurvivalStance = this.currentStance,
  ): TotemManager {
    return new TotemManager({
      ...DEFAULT_TOTEM_POLICY,
      stance,
    });
  }

  private refreshPolicyGate(): void {
    const next = this.config.policyGateProvider?.();
    if (next === undefined || next === this.policyGate) return;
    // Limits are not the policy identity. Validate the server binding before
    // deduplicating an equivalent-looking limits object; otherwise a provider
    // bug could smuggle another server profile through this fast path.
    if (next.serverProfileId !== this.config.serverProfileId) {
      throw new TypeError("Combat policy and driver must use the same server profile.");
    }
    // The provider may return a fresh wrapper on every call. Preserve the
    // current connection-local rate window when the effective limits did not
    // change; replace it only after an actual policy update.
    if (JSON.stringify(next.limits) === JSON.stringify(this.policyGate.limits)) return;
    this.setPolicyGate(next);
  }

  private newPacketMineController(): PacketMineController {
    return new PacketMineController({
      ...DEFAULT_MINE_POLICY,
      maximumReachDistance: this.policyGate.limits.blockInteractionReach,
      stance: this.config.stance,
    });
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

function distanceBetween(left: CombatVector3, right: CombatVector3): number {
  return Math.hypot(
    left.x - right.x,
    left.y - right.y,
    left.z - right.z,
  );
}

function validErrorCode(value: string): boolean {
  return ERROR_CODE_PATTERN.test(value);
}

function validCombatTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) &&
    Number(value) >= 0 &&
    Number(value) <= MAX_DATE_MS;
}

function parseCombatActionAcknowledgement(
  value: unknown,
): CombatActionAcknowledgement | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.outcome === "executed") {
    return validCombatTimestamp(record.executedAtMs)
      ? { outcome: "executed", executedAtMs: Number(record.executedAtMs) }
      : null;
  }
  if (record.outcome !== "failed" && record.outcome !== "unavailable") {
    return null;
  }
  return typeof record.reasonCode === "string" &&
      validErrorCode(record.reasonCode)
    ? { outcome: record.outcome, reasonCode: record.reasonCode }
    : null;
}

function interactionClassForPrimitive(
  action: CombatPrimitiveAction,
): "use" | "attack" | null {
  if (action.kind === "PLACE_CRYSTAL") return "use";
  if (
    action.kind === "MELEE_ATTACK" ||
    action.kind === "RELEASE_RANGED_WEAPON"
  ) {
    return "attack";
  }
  return null;
}

function validateCombatVector(
  vector: CombatVector3,
  name: string,
): void {
  if (
    !Number.isFinite(vector.x) ||
    !Number.isFinite(vector.y) ||
    !Number.isFinite(vector.z)
  ) {
    throw new TypeError(`Combat observation ${name} is malformed.`);
  }
}

function validateCombatOrientation(orientation: CombatOrientation): void {
  if (
    !Number.isFinite(orientation.yaw) ||
    !Number.isFinite(orientation.pitch) ||
    orientation.pitch < -90 ||
    orientation.pitch > 90
  ) {
    throw new TypeError("Combat observation orientation is malformed.");
  }
}

function validateCombatGear(
  gear: CombatGearSnapshot,
  name: string,
): void {
  if (
    !ARMOR_MATERIALS.has(gear.armorMaterial) ||
    !Number.isFinite(gear.protectionLevel) ||
    gear.protectionLevel < 0 ||
    gear.protectionLevel > 4 ||
    !Number.isFinite(gear.blastProtectionLevel) ||
    gear.blastProtectionLevel < 0 ||
    gear.blastProtectionLevel > 4 ||
    !Number.isInteger(gear.armorPieceCount) ||
    gear.armorPieceCount < 0 ||
    gear.armorPieceCount > 4 ||
    (gear.armorPieceCount === 0 &&
      (gear.protectionLevel !== 0 || gear.blastProtectionLevel !== 0)) ||
    !Number.isFinite(gear.weaponDamage) ||
    gear.weaponDamage < 0 ||
    !Number.isFinite(gear.health) ||
    gear.health < 0 ||
    gear.health > 20 ||
    typeof gear.hasTotem !== "boolean"
  ) {
    throw new TypeError(`Combat observation ${name} is malformed.`);
  }
}

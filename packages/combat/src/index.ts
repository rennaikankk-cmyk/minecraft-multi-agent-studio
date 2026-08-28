/**
 * `@minecraft-studio/combat` —— §5 实时战斗的确定性内核。
 *
 * 全包**零 AI、零 mineflayer 依赖**：所有世界状态以自带 `observedAtMs` 的快照
 * 注入，所有模块都是可单测的纯决策。AI 永远只能通过"经 Schema + Policy 校验
 * 的白名单技能调用"触发这里的能力，绝不下发原始动作（AGENTS.md §0.1）。
 *
 * 时序分档见 docs/combat-tactics-reference.md §0：
 *   - 战术级 T（≤200ms）：ThreatAnalyzer、TargetSelector 等，不受时序探针阻塞。
 *   - 反射级 R（≤50ms）：TotemManager、CrystalEngine，**必须先过时序探针**。
 */

export {
  CombatIdentityError,
  CombatIdentityRegistry,
  type CombatAllegiance,
  type CombatEntity,
  type CombatEntityKind,
  type CombatIdentityErrorCode,
  type CombatWhitelistSource,
} from "./identity.js";
export { DeterministicJitter } from "./deterministic-jitter.js";
export {
  ChainSequencer,
  DEFAULT_CHAIN_SEQUENCER_POLICY,
  type CombatChainContext,
  type CombatChainDecision,
  type CombatChainRefusalCode,
  type CombatChainSequencerPolicy,
  type CombatChainStep,
  type CombatChainStepRecord,
  type CombatInteractionClass,
} from "./chain-sequencer.js";
export {
  BLAST_POWER,
  blastDamage,
  entityRangeFor,
  redLineBreached,
  type CombatBlastDamage,
  type CombatBlastDamageInput,
  type CombatDifficulty,
} from "./blast-model.js";
export {
  HIT_WINDOW_STALE_AFTER_MS,
  TARGET_INVULNERABILITY_WINDOW_MS,
  HitWindowTracker,
  type CombatHitWindowConfidence,
  type CombatHitWindowState,
} from "./hit-window-tracker.js";
export {
  CombatReflexNotClearedError,
  REFLEX_BUDGET_MS,
  decideReflexClearance,
  type CombatReflexDecision,
  type CombatReflexDenialCode,
  type CombatReflexProbeReport,
} from "./reflex-clearance.js";
export {
  CrystalEngine,
  DEFAULT_CRYSTAL_POLICY,
  type CombatCrystalCandidate,
  type CombatCrystalDetonateDecision,
  type CombatCrystalPlan,
  type CombatCrystalPolicy,
  type CombatCrystalRefusalCode,
  type CombatCrystalScore,
  type CombatCrystalSelfState,
} from "./crystal-engine.js";
export {
  AnchorEngine,
  DEFAULT_ANCHOR_POLICY,
  anchorChargeFromLightLevel,
  type CombatAnchorCandidate,
  type CombatAnchorChargeLevel,
  type CombatAnchorDimension,
  type CombatAnchorPlan,
  type CombatAnchorPolicy,
  type CombatAnchorRefusalCode,
  type CombatAnchorScore,
  type CombatAnchorSelfState,
  type CombatHostileAnchorArmLevel,
  type CombatHostileAnchorAssessment,
  type CombatHostileAnchorObservation,
} from "./anchor-engine.js";
export {
  DEFAULT_SURVIVAL_STANCE,
  totemAbsenceForcesRetreat,
  validateSurvivalStance,
  type CombatSurvivalStance,
} from "./survival-stance.js";
export {
  DEFAULT_TOTEM_POLICY,
  TotemManager,
  type CombatTotemAction,
  type CombatTotemDecision,
  type CombatTotemPolicy,
  type CombatTotemReason,
  type CombatTotemSnapshot,
} from "./totem-manager.js";
export {
  DEFAULT_MOVEMENT_POLICY,
  MovementController,
  type CombatMovementIntent,
  type CombatMovementPlan,
  type CombatMovementPolicy,
  type CombatMovementSnapshot,
} from "./movement-controller.js";
export {
  SURROUND_BLAST_RESISTANCE,
  SurroundPlanner,
  type CombatSurroundBlockClass,
  type CombatSurroundExposedOffset,
  type CombatSurroundExplosiveReadiness,
  type CombatSurroundInventoryBlock,
  type CombatSurroundOccupancy,
  type CombatSurroundOccupancyQuery,
  type CombatSurroundOffsetRole,
  type CombatSurroundPlacement,
  type CombatSurroundPlan,
  type CombatSurroundProtectionEffect,
  type CombatSurroundRefusalCode,
  type CombatSurroundSnapshot,
  type CombatSurroundThreatDirection,
} from "./surround-planner.js";
export {
  DEFAULT_MINE_POLICY,
  MAX_CONCURRENT_MINE,
  PacketMineController,
  type CombatMineAssignment,
  type CombatMineCandidate,
  type CombatMineExclusion,
  type CombatMineExclusionCode,
  type CombatMineHand,
  type CombatMinePlan,
  type CombatMinePolicy,
  type CombatMineRefusalCode,
  type CombatMineSnapshot,
} from "./packetmine-controller.js";
export {
  DEFAULT_PREDICTION_POLICY,
  PredictionEngine,
  type CombatMotionSample,
  type CombatPrediction,
  type CombatPredictionConfidence,
  type CombatPredictionPolicy,
} from "./prediction-engine.js";
export {
  DEFAULT_WEAPON_POLICY,
  WeaponManager,
  isRangedWeapon,
  type CombatRangedAction,
  type CombatRangedDecision,
  type CombatSwingDecision,
  type CombatWeaponCandidate,
  type CombatWeaponKind,
  type CombatWeaponPolicy,
  type CombatWeaponSelection,
} from "./weapon-manager.js";
export {
  DEFAULT_ROTATION_POLICY,
  RotationController,
  eyePosition,
  orientationToward,
  type CombatOrientation,
  type CombatRotationPolicy,
  type CombatRotationStep,
} from "./rotation-controller.js";
export {
  JAVA_1_21_EXPLOSION_RULES,
  DEFAULT_GEAR_POLICY,
  assessGearMatchup,
  assessExplosionProtection,
  assessWorstMatchup,
  explosionKnockbackResistance01,
  explosionMitigation01,
  explosionRuleSetForMinecraftVersion,
  gearPower,
  validateGearPolicy,
  type CombatArmorMaterial,
  type CombatExplosionProtectionAssessment,
  type CombatExplosionRuleSet,
  type CombatGearAssessment,
  type CombatGearPolicy,
  type CombatGearSnapshot,
  type CombatGearVerdict,
} from "./gear-assessor.js";
export {
  DEFAULT_RETREAT_POLICY,
  RetreatController,
  type CombatRetreatAction,
  type CombatRetreatDecision,
  type CombatRetreatPolicy,
  type CombatRetreatReason,
  type CombatRetreatUrgency,
} from "./retreat-controller.js";
export {
  CombatPolicyError,
  DEFAULT_ENGAGEMENT_POLICY,
  TargetSelector,
  validateEngagementPolicy,
  type CombatEngagementPolicy,
  type CombatTargetDecision,
  type CombatTargetRefusalCode,
} from "./target-selector.js";
export {
  ThreatAnalyzer,
  type CombatEntityObservation,
  type CombatThreat,
  type CombatThreatAssessment,
  type CombatThreatLevel,
  type CombatThreatReason,
  type CombatThreatSnapshot,
  type CombatVector3,
} from "./threat-analyzer.js";
export {
  TOTEM_POP_ABSORPTION_WINDOW_MS,
  TOTEM_POP_REGEN_WINDOW_MS,
  TOTEM_POP_REGENERATION_WINDOW_MS,
  TotemPopTracker,
  type CombatTotemPopPhase,
  type CombatTotemPopQuery,
  type CombatTotemPopRecord,
  type CombatTotemPopWindow,
  type CombatTotemPopWindowReason,
} from "./totem-pop-tracker.js";

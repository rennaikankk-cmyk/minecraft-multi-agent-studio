export {
  SkillAbortError,
  SkillFault,
  SkillFrameworkError,
  type SkillFrameworkErrorCode,
  SkillRefusal,
} from "./errors.js";
export {
  COMBAT_CONTROL_TIMEOUT_MS,
  combatControlActualActionSchema,
  combatControlDispositionSchema,
  combatControlInputSchema,
  combatControlStateSchema,
  combatDisengageCapabilityInputSchema,
  combatDisengageCapabilityOutputSchema,
  combatDisengageOutputSchema,
  combatDisengageSkill,
  combatEngageCapabilityInputSchema,
  combatEngageCapabilityOutputSchema,
  combatEngageOutputSchema,
  combatEngageSkill,
} from "./builtin/combat-control.js";
export {
  movementGotoSkill,
  SAFE_PATH_MAX_DISTANCE,
  SAFE_PATH_TIMEOUT_MS,
  safeMovementGotoCapabilityInputSchema,
  safeMovementGotoCapabilityOutputSchema,
  safeMovementGotoInputSchema,
  safeMovementGotoOutputSchema,
  safeMovementGotoStateSchema,
} from "./builtin/movement-goto.js";
export {
  MAX_ROUTE_SEGMENTS,
  TRAVEL_ROUTE_SEGMENT_OPERATION,
  TRAVEL_ROUTE_TIMEOUT_MS,
  estimateTravelRouteSegments,
  nextTravelRouteSegment,
  travelCorridorPolicies,
  travelCorridorPolicySchema,
  travelRouteCapabilityInputSchema,
  travelRouteCapabilityOutputSchema,
  travelRouteInputSchema,
  travelRouteOutputSchema,
  travelRouteSegmentAuditSchema,
  travelRouteSegmentStatusSchema,
  travelRouteSkill,
  travelRouteStateSchema,
  type TravelCorridorPolicy,
  type TravelRouteInput,
  type TravelRouteSegmentAudit,
  type TravelRouteState,
  type TravelRouteTarget,
} from "./builtin/travel-route.js";
export {
  ARMOR_SCORE,
  armorEquipCapabilityInputSchema,
  armorEquipCapabilityOutputSchema,
  armorScore,
  armorSnapshotCapabilityInputSchema,
  armorSnapshotCapabilityOutputSchema,
  decideSlot,
  EQUIP_ARMOR_TIMEOUT_MS,
  equipArmorInputSchema,
  equipArmorOutputSchema,
  equipArmorSkill,
  equipArmorStateSchema,
} from "./builtin/equip-armor.js";
export {
  COLLECT_BLOCK_TIMEOUT_MS,
  COLLECT_MAX_COUNT,
  COLLECT_MAX_DISTANCE,
  collectBlockCapabilityInputSchema,
  collectBlockCapabilityOutputSchema,
  collectBlockInputSchema,
  collectBlockOutputSchema,
  collectBlockSkill,
  collectBlockStateSchema,
} from "./builtin/collect-block.js";
export {
  SCAN_BLOCKS_TIMEOUT_MS,
  SCAN_MAX_COUNT,
  SCAN_MAX_DISTANCE,
  scanBlocksCapabilityInputSchema,
  scanBlocksCapabilityOutputSchema,
  scanBlocksInputSchema,
  scanBlocksOutputSchema,
  scanBlocksSkill,
  scanBlocksStateSchema,
} from "./builtin/scan-blocks.js";
export {
  combatStanceCapabilityInputSchema,
  combatStanceCapabilityOutputSchema,
  combatStanceInputSchema,
  combatStanceOutputSchema,
  combatStanceSkill,
  combatStanceStateSchema,
} from "./builtin/combat-stance.js";
export {
  SECURE_FOOD_MAX_TARGET,
  SECURE_FOOD_TIMEOUT_MS,
  secureFoodCapabilityInputSchema,
  secureFoodCapabilityOutputSchema,
  secureFoodInputSchema,
  secureFoodOutputSchema,
  secureFoodSkill,
  secureFoodStateSchema,
} from "./builtin/secure-food.js";
export {
  blockCenterDistance,
  blockWithinPolicyReach,
  type BlockCoordinate,
  type ObservedCoordinate,
} from "./builtin/reach.js";
export {
  MINIMUM_INCOMING_SLOTS,
  freeInventorySlots,
  inventoryHasRoomFor,
  observedInventorySchema,
  type ObservedInventory,
} from "./builtin/inventory-space.js";
export {
  CRAFT_CAPABILITY_MAX_COUNT,
  CRAFT_ITEM_TIMEOUT_MS,
  CRAFT_MAX_COUNT,
  craftItemCapabilityInputSchema,
  craftItemCapabilityOutputSchema,
  craftItemInputSchema,
  craftItemOutputSchema,
  craftItemSkill,
  craftItemStateSchema,
} from "./builtin/craft-item.js";
export {
  PLACE_BLOCK_TIMEOUT_MS,
  placeBlockCapabilityInputSchema,
  placeBlockCapabilityOutputSchema,
  placeBlockInputSchema,
  placeBlockOutputSchema,
  placeBlockSkill,
  placeBlockStateSchema,
} from "./builtin/place-block.js";
export {
  CONTAINER_TRANSFER_TIMEOUT_MS,
  containerTransferCapabilityInputSchema,
  containerTransferCapabilityOutputSchema,
  containerTransferInputSchema,
  containerTransferOutputSchema,
  containerTransferSkill,
  containerTransferStateSchema,
  TRANSFER_MAX_COUNT,
} from "./builtin/container-transfer.js";
export {
  SMELT_ITEM_TIMEOUT_MS,
  SMELT_MAX_COUNT,
  smeltItemCapabilityInputSchema,
  smeltItemCapabilityOutputSchema,
  smeltItemInputSchema,
  smeltItemOutputSchema,
  smeltItemSkill,
  smeltItemStateSchema,
} from "./builtin/smelt-item.js";
export {
  INVENTORY_SNAPSHOT_MAX_ITEM_TYPES,
  inventorySnapshotCapabilityInputSchema,
  inventorySnapshotCapabilityOutputSchema,
} from "./builtin/inventory-snapshot.js";
export {
  antiCheatCompatibilityProfiles,
  antiCheatCompatibilityProfileSchema,
  baselineLimits,
  baselineServerPolicy,
  DEFAULT_UNKNOWN_SERVER_PROFILE,
  intersectLimits,
  isAtLeastAsConservative,
  MINECRAFT_TICK_MS,
  profileIsAtLeastAsConservative,
  serverPolicyLimitsSchema,
  serverPolicySchema,
  VANILLA_BLOCK_INTERACTION_REACH,
  VANILLA_ENTITY_ATTACK_REACH,
  type AntiCheatCompatibilityProfile,
  type BaselineAntiCheatProfile,
  type ServerPolicy,
  type ServerPolicyLimits,
} from "./policy/server-policy.js";
export {
  ServerPolicyStore,
  type ServerPolicyWriteResult,
} from "./policy/policy-store.js";
export {
  candidateLadder,
  MAX_PROBE_STEPS,
  PROBE_STEPS_PER_DIMENSION,
  probeAuthorizationSchema,
  probeDimensions,
  probeEvidenceSchema,
  probeObservationKinds,
  ServerPolicyDetector,
  ServerPolicyProbeSession,
  type ProbeAuthorization,
  type ProbeDimension,
  type ProbeEvidence,
  type ProbeHaltReason,
  type ProbeObservationKind,
  type ProbeSessionState,
  type ProbeStartResult,
  type ProbeStep,
  type ProbeSubmitResult,
} from "./policy/boundary-probe.js";
export {
  policyActionKinds,
  ServerPolicyGate,
  type ClampedRotation,
  type PolicyActionKind,
  type PolicyDecision,
  type PolicyDenialCode,
} from "./policy/policy-gate.js";
export {
  acquisitionKinds,
  pickaxeForTier,
  resourceInputSchema,
  resourceRecipeSchema,
  ResourceGraph,
  resourceStations,
  tierRank,
  tierSatisfies,
  toolTierByItem,
  toolTiers,
  vanillaResourceRecipes,
  type AcquisitionKind,
  type ResourceGraphIssue,
  type ResourceInput,
  type ResourceRecipe,
  type ResourceStation,
} from "./planning/resource-graph.js";
export {
  GoalPlanner,
  MAX_GOAL_COUNT,
  MAX_PLAN_DEPTH,
  MAX_PLAN_STEPS,
  planStepKinds,
  skillIdForStepKind,
  type GoalRequest,
  type PlanFailureCode,
  type PlannerInventory,
  type PlanResult,
  type PlanStep,
  type PlanStepKind,
} from "./planning/goal-planner.js";
export {
  classificationSources,
  classifyFailure,
  failureCategories,
  isRecoverableFailure,
  isTerminalRecoveryAction,
  planRecovery,
  recoveryActions,
  recoveryLadderFor,
  type ClassificationSource,
  type FailureCategory,
  type FailureClassification,
  type RecoveryAction,
  type RecoveryDecision,
} from "./recovery/failure-classifier.js";
export {
  MAX_ATTEMPTS_PER_STEP,
  MAX_REPAIRS_PER_STEP,
  MAX_TOTAL_REPAIRS,
  PlanSupervisor,
  recoveryActionNeedsEffect,
  recoveryActionRewritesPlan,
  type RecoveryEffects,
  type StepExecutor,
  type StepOutcome,
  type SupervisionResult,
  type SupervisorEvent,
  type SupervisorEventKind,
} from "./recovery/plan-supervisor.js";
export { SkillExecutor } from "./executor.js";
export { SkillRegistry } from "./registry.js";
export { resolveSkillCompatibility } from "./compatibility.js";
export {
  builtinSkillIds,
  builtinSkills,
  builtinSkillStatusCatalog,
} from "./builtin/catalog.js";
export {
  buildSkillStatusCatalog,
  deriveSkillStatus,
  evidenceIssuesFor,
  evidenceSupportsVerifiedClaim,
  pendingGatesFor,
  skillEvidenceGates,
  skillEvidenceIssues,
  skillIdsWithRecordedEvidence,
  skillStatuses,
  type SkillEvidence,
  type SkillEvidenceGate,
  type SkillEvidenceIssue,
  type SkillStatus,
  type SkillStatusEntry,
} from "./skill-status.js";
export {
  builtinSkillVerificationManifestsV1,
  skillScenarioCategories,
  skillScenarioCategorySchema,
  skillVerificationManifestV1Schema,
  skillVerificationScenarioV1Schema,
  type SkillVerificationManifestV1,
} from "./verification-scenarios.js";
export {
  defineSkill,
  type SkillCompatibilityEnvironment,
  type SkillCompatibilityManifest,
  type SkillCompatibilityRequirement,
  type SkillCompatibilityResolution,
  type SkillCompatibilityUnmetRequirement,
  type SkillCompatibilityVariant,
  type SkillCapabilityAdapter,
  type SkillCapabilityRequest,
  type SkillDefinition,
  type SkillExecutionAuthorization,
  type SkillExecutionContext,
  type SkillExecutorOptions,
  type SkillFaultDiagnostic,
  type SkillMetadata,
  type SkillPolicyView,
  type SkillPrecondition,
  type SkillResourceKind,
  type SkillRetryPolicy,
  type SkillVariantCompatibility,
} from "./types.js";
export {
  MOVEMENT_PRIORITIES,
  MovementArbiter,
  MovementController,
  MovementLeaseUnavailableError,
  StaleMovementLeaseError,
  movementPriorities,
  type MovementArbiterOptions,
  type MovementControllerOptions,
  type MovementLease,
  type MovementLeaseEndReason,
  type MovementLeaseEvent,
  type MovementLeasePreemptHandler,
  type MovementLeaseReleaseHandler,
  type MovementLeaseRequest,
  type MovementLeaseSnapshot,
  type MovementLeaseState,
  type MovementOperation,
  type MovementPriority,
  type MovementPriorityInput,
  type MovementPriorityName,
} from "./movement-arbiter.js";
export {
  actionLockKinds,
  ActionLockError,
  ActionLockManager,
  type ActionLockAcquireOptions,
  type ActionLockKind,
  type ActionLockSnapshot,
} from "./runtime/action-lock.js";
export {
  tradeVillagerSkill, tradeVillagerInputSchema, tradeVillagerOutputSchema, tradeVillagerStateSchema, tradeVillagerCapabilityInputSchema, tradeVillagerCapabilityOutputSchema,
} from "./builtin/trade-villager.js";
export {
  mineBranchSkill, mineVeinSkill, mineBranchInputSchema, mineVeinInputSchema, mineBranchOutputSchema, mineVeinOutputSchema, mineBranchStateSchema, mineVeinStateSchema, planBranchMine, planVeinMine, defaultOreYLayers,
} from "./planning/mine-planner.js";
export {
  siteAssessSkill, shelterDigSkill, assessSite, DEFAULT_UNVERIFIED_SITE_POLICY, siteAssessInputSchema, siteAssessOutputSchema, siteAssessStateSchema, shelterDigInputSchema, shelterDigOutputSchema, shelterDigStateSchema,
} from "./planning/site-assessor.js";
export {
  BUILD_BLUEPRINT_TIMEOUT_MS,
  BLUEPRINT_DESIGN_PLACEMENT_MS,
  MAX_BLUEPRINT_BATCH,
  MAX_BLUEPRINT_CELLS,
  blueprintBlockClasses,
  blueprintBlockClassSchema,
  blueprintCellSchema,
  blueprintSchema,
  buildBlueprintCapabilityInputSchema,
  blueprintObservationSchema,
  buildBlueprintCapabilityOutputSchema,
  buildBlueprintInputSchema,
  buildBlueprintOutputSchema,
  buildBlueprintSkill,
  buildBlueprintStateSchema,
  isIntermediateBlueprintSafe,
  orderBlueprintCells,
  planBlueprint,
  type Blueprint,
  type BlueprintBlockClass,
  type BlueprintCell,
  type BlueprintPlan,
} from './planning/blueprint-planner.js';
export {
  MAX_STORE_TRANSFERS,
  PACK_SHULKER_TIMEOUT_MS,
  STORE_SORT_TIMEOUT_MS,
  evaluateStockLevel,
  evaluateStockLevels,
  packShulkerCapabilityInputSchema,
  packShulkerCapabilityOutputSchema,
  packShulkerInputSchema,
  packShulkerOutputSchema,
  packShulkerSkill,
  stockCountSchema,
  stockDecisionSchema,
  stockLevelInputSchema,
  stockLevelOutputSchema,
  stockLevelSchema,
  stockLevelSkill,
  stockStateSchema,
  storeSortCapabilityInputSchema,
  storeSortCapabilityOutputSchema,
  storeSortInputSchema,
  storeSortOutputSchema,
  storeSortSkill,
  unmanagedFoodItems,
  type MaterialRoute,
  type StockCount,
  type StockDecision,
  type StockLevel,
  type StockState,
} from './planning/stock-levels.js';
export {
  movementProfileConfigSchema,
  movementProfileInputSchema,
  movementProfileOutputSchema,
  movementProfileSchema,
  movementProfileSkill,
  movementProfileStateSchema,
  movementProfiles,
  resolveMovementProfile,
  type MovementProfile,
  type MovementProfileConfig,
  type MovementProfileDecision,
} from './planning/movement-profile.js';
export {
  siteObserveCapabilityInputSchema,
  siteObserveCapabilityOutputSchema,
  shelterDigCapabilityInputSchema,
  shelterDigCapabilityOutputSchema,
} from "./planning/site-assessor.js";
export {
  mineBranchCapabilityInputSchema,
  mineBranchCapabilityOutputSchema,
  mineVeinCapabilityInputSchema,
  mineVeinCapabilityOutputSchema,
} from "./planning/mine-planner.js";

// ---------------------------------------------------------------------------
// Bot State Catalog —— 跨层共享的 Bot 状态语义（唯一定义点）
// ---------------------------------------------------------------------------
export {
  ALL_EDIBLE_ITEMS,
  BOT_ARMOR_SLOTS,
  ARMOR_SLOT_BY_ITEM,
  DIAMOND_ARMOR_BY_SLOT,
  EMERGENCY_FOOD_ITEMS,
  highestPickaxeTier,
  IRON_ARMOR_BY_SLOT,
  LOG_BY_PLANKS,
  PICKAXE_BY_TIER,
  PLANKS_BY_LOG,
  SAFE_FOOD_ITEMS,
  totalWoodUnits,
  TOOL_TIERS,
  TOOL_TIER_BY_PICKAXE,
  WOOD_LOG_ITEMS,
  type BotArmorSlot,
  type ToolTier,
  type WoodLogItem,
} from "./bot-state-catalog.js";

// ---------------------------------------------------------------------------
// Skill SDK —— 统一的 Skill 开发框架
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Workstation Registry
// ---------------------------------------------------------------------------
export {
  InMemoryWorkstationRegistry,
  acquireWorkstation,
  type FacilityFailureSignal,
  type WorkstationEntry,
  type WorkstationLease,
  type WorkstationLeaseOwner,
  type WorkstationType,
  type BlockPosition,
  type WorkstationRegistryOptions,
  type WorkstationAcquireResult,
  type WorkstationRegistryPort,
  type WorkstationScanFn,
  type WorkstationVerifyFn,
  normalizeBlockPos,
  usageModeFor,
} from "./workstation-registry.js";

// ---------------------------------------------------------------------------
// Facility Registry + Placement + Capacity
// ---------------------------------------------------------------------------
export {
  FacilityRegistry,
  TRANSITIONS,
  canTransition,
  facilityId,
  smeltingLinePattern,
  smeltingWallGridPattern,
  toWorldPosition,
  transformOffset,
  type Facility,
  type FacilityRegistryOptions,
  type FacilityRegistryPort,
  type FacilitySlot,
  type FacilitySlotStatus,
  type FacilityType,
  type Orientation,
  type PatternSlot,
} from "./facility-registry.js";
export {
  assessCapacity,
  creationPolicyFor,
  type CapacityDecision,
  type CapacityPlannerInput,
  type WorkstationCreationPolicy,
} from "./capacity-planner.js";
export {
  SharedStateClient,
  SharedStateError,
  captureSharedStateSnapshot,
  createSharedStateDispatcher,
  dispatchSharedState,
  sharedStateRequestSchema,
  restoreSharedStateSnapshot,
  type Maybe,
  type MaybeAsyncFacilityRegistryPort,
  type MaybeAsyncWorkstationRegistryPort,
  type SharedStateClientOptions,
  type SharedStateHandler,
  type SharedStateRequest,
  type SharedStateResponse,
  type SharedStateSnapshot,
} from "./shared-state.js";
export {
  STARTER_BASE_V1_ID,
  STARTER_BASE_V1_VERSION,
  BaseRegistry,
  baseId,
  reconcileBlueprint,
  resolveMaterials,
  starterBaseV1,
  type BaseCellReservation,
  type BaseRecord,
  type BaseRegistryOptions,
  type BaseAvailability,
  type BasePhaseFact,
  type BaseStatus,
  type ReconcileResult,
  type ReconciledCell,
  type StarterBaseParams,
} from "./base-registry.js";

export { blueprintWorksetObservationSchema, blueprintWorksetSummarySchema, selectBlueprintWorkset,
  type BlueprintWorksetObservation } from "./planning/blueprint-workset.js";
export {
  DurableStateStore,
  durableSnapshotFrom,
  registriesFromDurableSnapshot,
  stripEphemeralState,
  type DurableStateSnapshot,
} from "./durable-state-store.js";
export {
  skillSystemV1Manifest,
  skillMaturityLevels,
  type SkillV1ManifestEntry,
  type SkillSystemV1Manifest,
  type SkillMaturityLevel,
  type PlannerReachability,
} from "./v1-manifest.js";
export { scenarioResults, type ScenarioResult } from "./scenario-results.js";

// Round 7 兼容层（compat/）：结构化服务器行为信号（observer/profile/适应机）。
// mineflayer 边界显式上报，不解析自然语言日志——bot-runtime 消费 observer
// 与 ACTION_FAMILIES，coordinator/dashboard 消费 profile 面。
export {
  ACTION_FAMILIES,
  ACTION_RISKS,
  COMPAT_PROFILE_SCHEMA_VERSION,
  CompatibilityProfileError,
  featureGateSchema,
  MODE_SOURCES,
  MODE_TO_BASELINE,
  newBehaviorProfile,
  OBSERVER_DEFAULT_WINDOW_MS,
  OBSERVER_MAX_EVENTS,
  resolveCompatibilityMode,
  SERVER_COMPATIBILITY_MODES,
  serverBehaviorProfileSchema,
  ServerBehaviorObserver,
  type ActionFamily,
  type ActionRisk,
  type BehaviorSignalEvent,
  type BehaviorSignalKind,
  type CompatibilityModeSource,
  type FamilyWindowStats,
  type FeatureGate,
  type ServerBehaviorProfile,
  type ServerCompatibilityMode,
} from "./compat/index.js";
export * from "./facility-platform.js";
export * from "./base-master-plan.js";
export * from "./skill-gap.js";
export * from "./gap-bundle.js";
export * from "./provenance.js";
export * from "./death-recovery.js";
export * from "./nether-coords.js";
export * from "./chunk-census.js";
export * from "./recon-ledger.js";
export * from "./recon-patrol.js";
export * from "./work-area.js";
export * from "./work-area-lease.js";
export * from "./baritone-processes.js";
export * from "./process-completion.js";
export * from "./world-assets.js";
export * from "./farm-maintenance.js";
export * from "./farm-production.js";

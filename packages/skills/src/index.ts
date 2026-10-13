export { baseLayoutSchema, planBaseLayout, plannedBlueprintAnchor, type BaseLayout } from "./base-layout.js";
export {
  FacilityExecutor,
  FACILITY_EXECUTION_PROFILES,
  facilitySkillId,
  type FacilityExecutionAdapter,
  type FacilityExecutionPhase,
  type FacilityExecutionResult,
  type FacilityExecutionProfile,
} from "./facility-executor.js";
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
  RECOVER_DROPS_MAX_DISTANCE,
  RECOVER_DROPS_TIMEOUT_MS,
  recoverDropsInputSchema,
  recoverDropsOutputSchema,
  recoverDropsSkill,
  recoverDropsStateSchema,
} from "./builtin/recover-drops.js";
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
  animalBreedCapabilityInputSchema,
  animalBreedCapabilityOutputSchema,
  animalBreedInputSchema,
  animalBreedOutputSchema,
  animalBreedSkill,
  BREED_FOOD_BY_ANIMAL,
  breedFoodAccepted,
} from "./builtin/animal-breed.js";
export {
  fluidPlaceCapabilityInputSchema,
  fluidPlaceCapabilityOutputSchema,
  fluidPlaceInputSchema,
  fluidPlaceOutputSchema,
  fluidPlaceSkill,
} from "./builtin/fluid-place.js";
export {
  inventoryDropCapabilityInputSchema,
  inventoryDropCapabilityOutputSchema,
  inventoryDropInputSchema,
  inventoryDropOutputSchema,
  inventoryDropSkill,
} from "./builtin/inventory-drop.js";
export {
  blockCenterDistance,
  blockWithinPolicyReach,
  type BlockCoordinate,
  type ObservedCoordinate,
} from "./builtin/reach.js";
// 基础动作技能（food.eat / sleep.bed / bucket.fill）的 barrel 出口。
// bot-runtime 的适配器从这里取 capability input/output schema 与
// sleepableWindow（睡眠判据的唯一实现）；三条 export 是接线的一部分，
// 删掉会让 apps/bot-runtime 的 typecheck 与测试直接失败。
export {
  bucketFillCapabilityInputSchema,
  bucketFillCapabilityOutputSchema,
  bucketFillInputSchema,
  bucketFillOutputSchema,
  bucketFillSkill,
  BUCKET_FILL_TIMEOUT_MS,
} from "./builtin/bucket-fill.js";
export {
  foodEatCapabilityInputSchema,
  foodEatCapabilityOutputSchema,
  foodEatInputSchema,
  foodEatOutputSchema,
  foodEatSkill,
  FOOD_EAT_TIMEOUT_MS,
} from "./builtin/food-eat.js";
export {
  sleepBedCapabilityInputSchema,
  sleepBedCapabilityOutputSchema,
  sleepBedInputSchema,
  sleepBedOutputSchema,
  sleepBedSkill,
  SLEEP_BED_TIMEOUT_MS,
  SLEEP_WINDOW_CLEAR,
  SLEEP_WINDOW_RAIN,
  SLEEP_WINDOW_THUNDERSTORM,
  sleepableWindow,
  sleepWeatherFrom,
  type SleepWeather,
} from "./builtin/sleep-bed.js";
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
  portalIgniteSkill, portalUseSkill, ascendSkill, bridgeSkill,
  portalIgniteInputSchema, portalIgniteOutputSchema,
  portalUseInputSchema, portalUseOutputSchema,
  ascendInputSchema, ascendOutputSchema,
  bridgeInputSchema, bridgeOutputSchema,
} from "./builtin/nether-travel.js";
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
  type FacilityOperationalState,
  type FacilityProductionLedger,
  FACILITY_OPERATIONAL_TRANSITIONS,
  canTransitionFacilityOperationalState,
  readFacilityProductionLedger,
  transitionFacilityOperationalState,
  recordFacilityProduction,
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
export * from "./skill-gap-composition.js";
export * from "./skill-gap-persistence.js";
export * from "./skill-release.js";
export * from "./gap-bundle.js";
// 包对外的 redaction 出口以 incidents.ts 的强实现为准：redactSecrets 递归抠
// key，并覆盖 JWT / AWS / Slack / URL userinfo / 自由文本 key=value；
// containsUnredactedSecrets 是"残留即拒绝"的 fail-closed 扫描。gap-bundle 的
// redactText/scanResidualSecrets 继续导出以保持向后兼容（apps/coordinator 的
// planner-memory、lesson-store、lesson-review 在用），但它只有 3 条模式，
// 新代码请用上面这套。
export {
  REDACTED,
  containsUnredactedSecrets,
  redactSecrets,
} from "./incidents.js";
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
export * from "./asset-policy.js";
export * from "./farm-maintenance.js";
export * from "./farm-production.js";
export * from "./farm-sustain.js";
export * from "./facility-lease.js";
export * from "./planning/resource-management.js";
export { residenceCheckSkill } from "./builtin/residence-check.js";

// Minecraft 常识层：纯知识表与判定函数（危险/工具树/食物/放置），以及在其之上的
// 纯判断技能。它们不产生游戏动作，也不声明 capability。
export * from "./commons/index.js";
export { hazardAssessSkill } from "./builtin/hazard-assess.js";
export { toolPlanSkill } from "./builtin/tool-plan.js";
export { foodPickSkill } from "./builtin/food-pick.js";
export { stationPlanSkill } from "./builtin/station-plan.js";
export { inventoryRoomSkill } from "./builtin/inventory-room.js";
// 常识层的执行面：把"该在哪插火把"变成真实放置（纯组合，复用 block.place-safe）。
export { lightPlaceSkill, plannedTorchPositions, LIGHT_PLACE_MAX_PLACEMENTS, LIGHT_PLACE_TIMEOUT_MS, lightPlaceInputSchema } from "./builtin/light-place.js";

import {
  FacilityRegistry,
  recordFacilityProduction,
  readFacilityProductionLedger,
  transitionFacilityOperationalState,
  type Facility,
  type FacilityType,
} from "./facility-registry.js";

export type FacilityExecutionResult = Readonly<{
  ok: boolean;
  produced?: Readonly<Record<string, number>>;
  consumed?: Readonly<Record<string, number>>;
  blockedReason?: string | null;
  evidence?: readonly string[];
}>;

export type FacilityExecutionAdapter = Readonly<{
  invoke: (request: Readonly<{ skillId: string; facility: Facility; phase: FacilityExecutionPhase; slotIndex?: number }>) => Promise<FacilityExecutionResult>;
  readback: (facility: Facility) => Promise<Readonly<{ cells: readonly Readonly<{ slotIndex: number; blockPresent: boolean; blockName: string | null }>[]; collectorFull?: boolean; blockedReason?: string | null; output?: Readonly<Record<string, number>> }>>;
  persist?: () => void | Promise<void>;
}>;

export type FacilityExecutionPhase = "construct" | "entities" | "activate" | "verify" | "repair";

export type FacilityExecutionProfile = Readonly<{
  kind: FacilityType;
  constructionSkill: string;
  requiredPhases: readonly FacilityExecutionPhase[];
  outputMustBeObserved: boolean;
}>;

const SKILL_BY_TYPE: Readonly<Record<FacilityType, string>> = {
  crop_farm: "farm.sustain", iron_farm: "build.blueprint", mob_farm: "build.blueprint", gunpowder_farm: "build.blueprint", tree_farm: "build.blueprint", cobblestone_generator: "build.blueprint", trading_hall: "trade.villager", storage_system: "store.sort", storage_zone: "store.sort", smelting_zone: "smelt.item", crafting_zone: "craft.item",
};

/** Concrete commissioning contract for every production facility in a base. */
export const FACILITY_EXECUTION_PROFILES: Readonly<Record<FacilityType, FacilityExecutionProfile>> = Object.freeze(
  Object.fromEntries((Object.keys(SKILL_BY_TYPE) as FacilityType[]).map((kind) => [kind, {
    kind,
    constructionSkill: SKILL_BY_TYPE[kind],
    requiredPhases: ["construct", "entities", "activate", "verify"] as const,
    outputMustBeObserved: true,
  }])) as unknown as Record<FacilityType, FacilityExecutionProfile>,
);

/** Unified real-server facility lifecycle executor. */
export class FacilityExecutor {
  constructor(private readonly registry: FacilityRegistry, private readonly adapter: FacilityExecutionAdapter, private readonly now: () => number = () => Date.now()) {}

  async run(facilityId: string): Promise<FacilityExecutionResult> {
    const facility = this.registry.get(facilityId);
    if (!facility) return { ok: false, blockedReason: "FACILITY_NOT_FOUND" };
    const skillId = SKILL_BY_TYPE[facility.facilityType];
    const ledger = readFacilityProductionLedger(facility);
    if (ledger.state === "STOPPED") transitionFacilityOperationalState(facility, "BUILDING", this.now(), "restart_recovery");
    if (readFacilityProductionLedger(facility).state === "PLANNED") transitionFacilityOperationalState(facility, "BUILDING", this.now(), "construction_started");
    for (const slot of facility.slots) {
      if (slot.status === "occupied") continue;
      if (!this.registry.reserveSlot(facility.id, slot.index, `facility-executor:${facility.id}`, 120_000)) continue;
      const result = await this.adapter.invoke({ skillId, facility, phase: "construct", slotIndex: slot.index });
      if (!result.ok) {
        this.registry.markPlacementFailed(facility.id, slot.index, result.blockedReason ?? "construction_failed", `facility-executor:${facility.id}`);
        transitionFacilityOperationalState(facility, "DEGRADED", this.now(), result.blockedReason ?? "construction_failed");
        return result;
      }
      const observed = await this.adapter.readback(facility);
      const cell = observed.cells.find((entry) => entry.slotIndex === slot.index);
      if (!cell?.blockPresent || (cell.blockName !== null && cell.blockName !== slot.workstationType) || !this.registry.markSlotOccupied(facility.id, slot.index, `${facility.id}#${slot.index}`, { reservationOwner: `facility-executor:${facility.id}` })) {
        this.registry.markPlacementFailed(facility.id, slot.index, "server_readback_missing", `facility-executor:${facility.id}`);
        transitionFacilityOperationalState(facility, "DEGRADED", this.now(), "server_readback_missing");
        return { ok: false, blockedReason: "SERVER_READBACK_MISSING" };
      }
    }
    if (readFacilityProductionLedger(facility).state === "BUILDING") transitionFacilityOperationalState(facility, "COMMISSIONING", this.now(), "structure_verified");
    const entityResult = await this.adapter.invoke({ skillId, facility, phase: "entities" });
    await this.recordConsumed(facility, entityResult);
    if (!entityResult.ok) return this.degrade(facility, entityResult.blockedReason ?? "entity_setup_failed");
    const activation = await this.adapter.invoke({ skillId, facility, phase: "activate" });
    await this.recordConsumed(facility, activation);
    if (!activation.ok) return this.degrade(facility, activation.blockedReason ?? "activation_failed");
    const verification = await this.adapter.readback(facility);
    if (verification.blockedReason || verification.collectorFull) return this.degrade(facility, verification.blockedReason ?? "collector_full");
    if (!verification.output || Object.values(verification.output).every((count) => !Number.isSafeInteger(count) || count <= 0)) return this.degrade(facility, "NO_SERVER_OUTPUT");
    for (const [item, count] of Object.entries(verification.output)) recordFacilityProduction(facility, item, count, this.now(), "produced");
    for (const [item, count] of Object.entries(entityResult.consumed ?? {})) recordFacilityProduction(facility, item, count, this.now(), "consumed");
    transitionFacilityOperationalState(facility, "ACTIVE", this.now(), "server_output_verified");
    await this.adapter.persist?.();
    return { ok: true, produced: verification.output, ...(entityResult.consumed ? { consumed: entityResult.consumed } : {}), evidence: ["construction_readback", "activation_readback", "production_readback"] };
  }

  async repair(facilityId: string): Promise<FacilityExecutionResult> {
    const facility = this.registry.get(facilityId);
    if (!facility) return { ok: false, blockedReason: "FACILITY_NOT_FOUND" };
    const current = readFacilityProductionLedger(facility);
    if (current.state !== "DEGRADED" && current.state !== "STOPPED") return this.run(facilityId);
    transitionFacilityOperationalState(facility, "COMMISSIONING", this.now(), "repair_started");
    const result = await this.adapter.invoke({ skillId: SKILL_BY_TYPE[facility.facilityType], facility, phase: "repair" });
    await this.recordConsumed(facility, result);
    if (!result.ok) return this.degrade(facility, result.blockedReason ?? "repair_failed");
    return this.run(facilityId);
  }

  private degrade(facility: Facility, reason: string): FacilityExecutionResult {
    transitionFacilityOperationalState(facility, "DEGRADED", this.now(), reason);
    void this.adapter.persist?.();
    return { ok: false, blockedReason: reason };
  }

  private async recordConsumed(facility: Facility, result: FacilityExecutionResult): Promise<void> {
    for (const [item, count] of Object.entries(result.consumed ?? {})) recordFacilityProduction(facility, item, count, this.now(), "consumed");
  }
}

export const facilitySkillId = (type: FacilityType): string => SKILL_BY_TYPE[type];

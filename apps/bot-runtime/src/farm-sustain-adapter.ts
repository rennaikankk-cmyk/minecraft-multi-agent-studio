import { SkillFault, foodFarmLayout, foodFarmMaintenance, type FarmSustainInput, type FarmSustainOutput, type WorkPosition } from "@minecraft-studio/skills";
import { maintainFarm, type FarmMaintenancePort } from "./farm-maintenance-adapter.js";

export interface FoodFarmPort {
  farm: FarmMaintenancePort;
  inspect(position: WorkPosition): { name: string; solid: boolean; light: number; moisture: number; source: boolean; open: boolean } | null;
  ensure(position: WorkPosition, name: string): Promise<void>;
  irrigate(): Promise<void>;
  enter(): Promise<void>;
  leave(): Promise<void>;
  store(retain: number): Promise<{ before: number; after: number; deposited: number; withdrawn: number; full: boolean }>;
}

export async function sustainFarm(port: FoodFarmPort, input: FarmSustainInput): Promise<FarmSustainOutput> {
  const layout = foodFarmLayout(input.center);
  const result: FarmSustainOutput = { status: "WAITING_INFRASTRUCTURE", reason: null, maintenance: null,
    supply: { waterReady: false, lightingReady: false, enclosureReady: false, hydratedPlots: 0, plantedPlots: 0,
      repairs: 0, seedReserved: 0, foodReserved: 0, deposited: 0, withdrawn: 0, storageBefore: null, storageAfter: null, inventoryFood: 0 },
    observedAt: new Date().toISOString() };
  const observe = () => {
    const supply = result.supply;
    supply.waterReady = port.inspect(layout.water)?.source === true;
    supply.enclosureReady = layout.fences.every((p) => port.inspect(p)?.name === "oak_fence") &&
      port.inspect(layout.gate)?.name === "oak_fence_gate" && port.inspect(layout.gate)?.open === false;
    supply.lightingReady = layout.lights.every((p) => port.inspect(p)?.name === "torch");
    supply.hydratedPlots = 0; supply.plantedPlots = 0;
    for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
      if (x === 0 && z === 0) continue;
      const p = { x: input.center.x + x, y: input.center.y, z: input.center.z + z };
      const cell = port.inspect(p), soil = port.inspect({ ...p, y: p.y - 1 });
      if (!cell || cell.light < 9) supply.lightingReady = false;
      if (cell?.name === "carrots") supply.plantedPlots++;
      if (soil?.name === "farmland" && soil.moisture > 0) supply.hydratedPlots++;
    }
    const carrots = port.farm.inventory().get("carrot") ?? 0;
    supply.inventoryFood = carrots;
    supply.seedReserved = Math.min(carrots, input.seedReserve);
    supply.foodReserved = Math.min(Math.max(0, carrots - input.seedReserve), input.foodReserve);
    result.observedAt = new Date().toISOString();
  };
  const ensure = async (position: WorkPosition, name: string) => {
    port.farm.assertActive();
    const cell = port.inspect(position);
    if (!cell) throw new SkillFault("FARM_OBSERVATION_UNAVAILABLE");
    if (cell.name === name) return;
    if (result.supply.repairs >= input.maxActions) throw new SkillFault("FARM_REPAIR_BUDGET");
    await port.ensure(position, name);
    port.farm.assertActive();
    if (port.inspect(position)?.name !== name) throw new SkillFault("FARM_READBACK_MISMATCH");
    result.supply.repairs++;
  };
  try {
    await ensure(layout.gate, "oak_fence_gate");
    await port.enter();
    for (const position of layout.fences) await ensure(position, "oak_fence");
    for (const position of layout.lights) await ensure(position, "torch");
    if (!port.inspect(layout.water)?.source) {
      if (result.supply.repairs + 2 > input.maxActions) throw new SkillFault("FARM_REPAIR_BUDGET");
      await port.irrigate(); result.supply.repairs += 2;
    }
    observe();
    if (!result.supply.waterReady || !result.supply.lightingReady || !result.supply.enclosureReady) {
      throw new SkillFault("FARM_INFRASTRUCTURE_UNCONFIRMED");
    }
    await port.leave();
    await ensure(layout.storage, "barrel");
    // Refill first, so a hungry returning worker can recover from its own stock.
    const first = await port.store(input.seedReserve + input.foodReserve + 24 - result.supply.plantedPlots);
    result.supply.storageBefore = first.before;
    result.supply.deposited += Number(first.deposited) || 0; result.supply.withdrawn += Number(first.withdrawn) || 0;
    await port.enter();
    const remaining = input.maxActions - result.supply.repairs;
    if (remaining < 2) throw new SkillFault("FARM_REPAIR_BUDGET");
    result.maintenance = await maintainFarm(port.farm, { ...foodFarmMaintenance(input), maxActions: remaining });
    await port.leave();
    const storage = await port.store(input.seedReserve + input.foodReserve);
    result.supply.storageAfter = storage.after;
    result.supply.deposited += Number(storage.deposited) || 0; result.supply.withdrawn += Number(storage.withdrawn) || 0;
    result.status = storage.full ? "STORAGE_FULL" : result.maintenance.status;
    result.reason = storage.full ? "FARM_STORAGE_FULL" : null;
  } catch (error) {
    if (!(error instanceof SkillFault) || !["FARM_REPAIR_BUDGET", "FARM_MATERIAL_REQUIRED", "FARM_WATER_BUCKET_REQUIRED",
      "FARM_WATER_SOURCE_UNSAFE", "FARM_INFRASTRUCTURE_UNCONFIRMED", "FARM_OBSERVATION_UNAVAILABLE",
      "FARM_SITE_OCCUPIED", "FARM_SITE_UNSUPPORTED"].includes(error.code)) throw error;
    result.status = error.code === "FARM_REPAIR_BUDGET" ? "BATCH_LIMIT" : error.code === "FARM_OBSERVATION_UNAVAILABLE" ? "WAITING_OBSERVATION" : "WAITING_INFRASTRUCTURE";
    result.reason = error.message;
  }
  port.farm.assertActive();
  observe();
  return result;
}

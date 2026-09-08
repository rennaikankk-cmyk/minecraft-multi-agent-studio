import { SkillFault, cropRules, selectFarmAction, type FarmCell, type FarmMaintainInput, type FarmMaintainOutput, type FarmCropName } from '@minecraft-studio/skills';
import { workAreaPositions, withinWorkArea, type WorkPosition } from '@minecraft-studio/asset-policy';

export interface FarmMaintenancePort {
  inspect(position: WorkPosition): FarmCell;
  inventory(): ReadonlyMap<string, number>;
  assertActive(): void;
  approach(position: WorkPosition): Promise<void>;
  harvest(cell: FarmCell): Promise<void>;
  plant(crop: FarmCropName, cell: FarmCell): Promise<void>;
  till?(cell: FarmCell): Promise<void>;
  bonemeal(cell: FarmCell): Promise<void>;
  collectDrops(position: WorkPosition): Promise<void>;
  yield(): Promise<void>;
}

/** One bounded maintenance pass. A successful pass does not assert farm throughput. */
export async function maintainFarm(port: FarmMaintenancePort, input: FarmMaintainInput): Promise<FarmMaintainOutput> {
  const before = new Map(port.inventory());
  const positions = workAreaPositions(input.area, true);
  let scannedCells = 0, unknownCells = 0, harvested = 0, planted = 0, tilled = 0, bonemealUsed = 0, actions = 0;
  let waitingSeeds = false, growing = false, limited = false;
  for (const position of positions) {
    port.assertActive();
    if (actions >= input.maxActions) { limited = true; break; }
    let cell = port.inspect(position);
    scannedCells++;
    if (scannedCells % 16 === 0) { await port.yield(); port.assertActive(); }
    if (cell.blockName === null) { unknownCells++; continue; }
    if (["air", "cave_air"].includes(cell.blockName) && input.plantEmpty) {
      const rule = cropRules[input.plantEmpty];
      const hasSeeds = (port.inventory().get(rule.seedItem!) ?? 0) > input.seedReserve;
      const soil = { ...position, y: position.y - 1 };
      const tillable = input.prepareSoil && rule.substrate === "farmland" &&
        ["dirt", "grass_block"].includes(cell.belowName ?? "") && withinWorkArea(input.area, soil);
      if ((tillable || cell.belowName === rule.substrate) && !hasSeeds) waitingSeeds = true;
      if (tillable && hasSeeds) {
        if (actions + 2 > input.maxActions) { limited = true; break; }
        if (!port.till) throw new SkillFault("FARM_TILLING_UNAVAILABLE");
        await port.approach(soil);
        port.assertActive();
        await port.till(cell);
        port.assertActive();
        cell = port.inspect(position);
        if (cell.belowName !== "farmland") throw new SkillFault("FARM_READBACK_MISMATCH");
        tilled++; actions++;
      }
    }
    const selectedCrop = input.crops.includes(cell.blockName as FarmCropName) ? cell.blockName as FarmCropName : null;
    if (selectedCrop) {
      const rule = cropRules[selectedCrop];
      if ((rule.matureAge !== null && cell.age === null) || (rule.preserveBase && (cell.belowName === null || cell.aboveName === null))) {
        unknownCells++; continue;
      }
      if (rule.matureAge !== null && cell.age! < rule.matureAge) growing = true;
      if (input.replant && rule.seedItem && !rule.preserveBase && cell.age! >= (rule.matureAge ?? 0) &&
        (port.inventory().get(rule.seedItem) ?? 0) <= input.seedReserve) waitingSeeds = true;
    }
    let action = selectFarmAction(cell, input, port.inventory(), bonemealUsed);
    if (action === null) continue;
    const rule = cropRules[action.crop];
    const needsReplant = action.kind === "harvest" && input.replant && rule.seedItem !== null && !rule.preserveBase;
    // Reserve the replant action before harvesting, including when the batch is nearly full.
    if (actions + (needsReplant ? 2 : 1) > input.maxActions) { limited = true; break; }
    await port.approach(position);
    port.assertActive();
    cell = port.inspect(position);
    const fresh = selectFarmAction(cell, input, port.inventory(), bonemealUsed);
    if (fresh === null || fresh.kind !== action.kind || fresh.crop !== action.crop) continue;
    action = fresh;
    if (!withinWorkArea(input.area, cell.position)) throw new SkillFault("WORK_AREA_VIOLATION");
    if (action.kind === "harvest") {
      await port.harvest(cell);
      port.assertActive();
      const after = port.inspect(position);
      if (after.blockName === null) throw new SkillFault("FARM_OBSERVATION_UNAVAILABLE");
      if (!["air", "cave_air", "void_air"].includes(after.blockName)) throw new SkillFault("FARM_READBACK_MISMATCH");
      harvested++; actions++;
      await port.collectDrops(position);
      port.assertActive();
      if (needsReplant) {
        if ((port.inventory().get(rule.seedItem!) ?? 0) <= input.seedReserve) throw new SkillFault("FARM_SEEDS_EXHAUSTED");
        await port.plant(action.crop, cell);
        port.assertActive();
        const plantedCell = port.inspect(position);
        if (plantedCell.blockName !== action.crop) throw new SkillFault("FARM_READBACK_MISMATCH");
        planted++; actions++;
      }
    } else if (action.kind === "plant") {
      await port.plant(action.crop, cell);
      port.assertActive();
      if (port.inspect(position).blockName !== action.crop) throw new SkillFault("FARM_READBACK_MISMATCH");
      planted++; actions++;
    } else {
      await port.bonemeal(cell);
      port.assertActive();
      bonemealUsed++; actions++;
    }
  }
  port.assertActive();
  const after = port.inventory();
  const names = new Set([...before.keys(), ...after.keys()]);
  return {
    status: limited ? "BATCH_LIMIT" : unknownCells > 0 ? "WAITING_OBSERVATION" : waitingSeeds ? "WAITING_SEEDS"
      : actions === 0 && growing ? "WAITING_GROWTH" : "PASS_COMPLETE",
    scannedCells, unknownCells, harvested, planted, tilled, bonemealUsed,
    inventoryDelta: [...names].sort().map((itemName) => ({ itemName, delta: (after.get(itemName) ?? 0) - (before.get(itemName) ?? 0) })).filter((item) => item.delta !== 0),
    observedAt: new Date().toISOString(),
  };
}

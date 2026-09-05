import { describe, expect, it } from "vitest";
import { farmMaintainInputSchema, cropRules, selectFarmAction, farmMaintainSkill,
  workAreaSchema, workAreaPositions, baritoneProcessSkills, processContinuationCode,
  builtinSkillVerificationManifestsV1 } from "../src/index.js";

const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
const position = { x: 0, y: 64, z: 0 };
const area = { ...scope, min: position, max: position };
const cell = { position, blockName: "wheat", age: 7, belowName: "farmland", aboveName: "air", facing: null } as const;

describe("process inputs and crop mechanics", () => {
  it("bounds area scans and permits fractional observed player positions", () => {
    expect(workAreaSchema.safeParse({ ...area, max: { x: 100, y: 100, z: 100 } }).success).toBe(false);
    expect(workAreaSchema.safeParse({ ...area, max: { ...position, x: -1 } }).success).toBe(false);
    expect(workAreaPositions({ ...area, max: { ...position, y: 66 } }, true).map((p) => p.y)).toEqual([66, 65, 64]);
    expect(farmMaintainSkill.stateSchema.safeParse({ online: true, normalActionsAllowed: true, ...scope,
      position: { ...position, x: 0.5, y: 64.02, dimension: scope.dimension } }).success).toBe(true);
  });
  it.each(Object.entries(cropRules))("harvests mature %s while respecting its base", (name, rule) => {
    const input = farmMaintainInputSchema.parse({ area, crops: [name] });
    const inventory = new Map(rule.seedItem ? [[rule.seedItem, 3]] : []);
    expect(selectFarmAction({ ...cell, blockName: name, age: rule.matureAge, belowName: rule.preserveBase ? name : rule.substrate }, input, inventory, 0)?.kind).toBe("harvest");
    if (rule.preserveBase) expect(selectFarmAction({ ...cell, blockName: name, belowName: "dirt" }, input, inventory, 0)).toBeNull();
    if (rule.matureAge) expect(selectFarmAction({ ...cell, blockName: name, age: rule.matureAge - 1 }, input, inventory, 0)).toBeNull();
  });
  it("reserves seeds and never interprets unknown maturity as ripe", () => {
    const input = farmMaintainInputSchema.parse({ area, crops: ["wheat"] });
    expect(selectFarmAction(cell, input, new Map([["wheat_seeds", 1]]), 0)).toBeNull();
    expect(selectFarmAction({ ...cell, age: null }, input, new Map([["wheat_seeds", 5]]), 0)).toBeNull();
    expect(farmMaintainInputSchema.safeParse({ area, crops: ["wheat"], plantEmpty: "carrots" }).success).toBe(false);
  });
  it.each([...baritoneProcessSkills, farmMaintainSkill])("enforces L0 and server identity for $id", (skill) => {
    const manifest = builtinSkillVerificationManifestsV1.find((m) => m.skillId === skill.id)!;
    const input = skill.inputSchema.parse(manifest.scenarios[0]!.input);
    const state = skill.stateSchema.parse({ ...scope, online: true, normalActionsAllowed: false,
      position: { ...position, dimension: scope.dimension }, retreatInProgress: false });
    const l0 = skill.preconditions.find((p) => p.id === "l0.normal-actions-allowed")!;
    expect(l0.check(input as never, state as never)).toBe(false);
  });
  it("does not claim a whole objective from partial clearing or growing crops", () => {
    expect(processContinuationCode("build.clear-area", { completed: false, status: "BATCH_LIMIT", broken: 1, remaining: 1, unknown: 0, blocked: 0, observedAt: new Date().toISOString() })).toBe("PROCESS_BATCH_LIMIT");
    expect(processContinuationCode("farm.maintain", { status: "WAITING_GROWTH", scannedCells: 1, unknownCells: 0, harvested: 0, planted: 0, bonemealUsed: 0, inventoryDelta: [], observedAt: new Date().toISOString() })).toBe("PROCESS_WAITING_GROWTH");
  });
});

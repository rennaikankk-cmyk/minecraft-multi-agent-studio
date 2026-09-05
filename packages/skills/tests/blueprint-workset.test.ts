import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildBlueprintSkill, buildBlueprintInputSchema, orderBlueprintCells, selectBlueprintWorkset,
  blueprintWorksetObservationSchema, SkillFault, type SkillExecutionContext, type BuildBlueprintInput } from "../src/index.js";

const cell = (x: number, itemName = "stone", y = 0) => ({ offset: { x, y, z: 0 }, itemName, blockClass: "structural" as const, order: x });
const inputFor = (cells = [cell(0), cell(1), cell(2)]): BuildBlueprintInput => buildBlueprintInputSchema.parse({
  strategy: "workset", reconcile: true, maxPlacements: 2,
  blueprint: { anchor: { x: 0, y: 64, z: 0 }, dimension: "minecraft:overworld", serverProfileId: "fixture", cells },
});

/** Deterministic world fixture; these tests do not connect to Minecraft. */
function fixture(input: BuildBlueprintInput, initial: Array<string | null | undefined>, materials = new Map([["stone", 64]])) {
  const world = [...initial];
  const effects: number[] = [];
  const calls: string[] = [];
  const controller = new AbortController();
  const ordered = orderBlueprintCells(input.blueprint);
  const snapshot = () => blueprintWorksetObservationSchema.parse({
    snapshotId: randomUUID(), observedAt: new Date().toISOString(),
    playerPosition: { x: 0, y: 64, z: 0 },
    cells: ordered.map((c, index) => ({
      state: world[index] === undefined ? "unknown" : world[index] === c.itemName ? "match" : "different",
      observedItemName: world[index] ?? null, reachable: true, supportUnknown: false,
      workfaces: [{ referenceBlock: { x: c.offset.x, y: 63 + c.offset.y, z: 0 }, face: { x: 0, y: 1, z: 0 } }],
    })), availableMaterials: [...materials].map(([itemName, count]) => ({ itemName, count })),
  });
  const context = { signal: controller.signal, policy: { serverProfileId: "fixture",
    checkBlockReach: () => ({ allowed: true }), checkAttackReach: () => ({ allowed: false }) },
    callCapability: async (_cap: string, op: string, args: any) => {
    calls.push(op);
    if (op === "blueprint.inspect-workset") return snapshot();
    if (op === "blueprint.inspect") return { states: snapshot().cells.map((c) => c.state), observedAt: new Date().toISOString() };
    if (op !== "block.place-safe") throw new Error("unexpected operation");
    if ((materials.get(args.itemName) ?? 0) < 1) throw new SkillFault("BUILD_MATERIAL_MISSING");
    if (args.referenceBlock.x + args.face.x !== args.target.x || args.referenceBlock.y + args.face.y !== args.target.y) throw new Error("shifted target");
    effects.push(args.blueprintIndex);
    world[args.blueprintIndex] = args.itemName;
    materials.set(args.itemName, materials.get(args.itemName)! - 1);
    return { placed: true, placedBlockName: args.itemName, position: args.target };
  } } as unknown as SkillExecutionContext;
  return { context, snapshot, effects, calls, world, materials, controller,
    run: () => buildBlueprintSkill.execute(context, input, {} as never) };
}

describe("blueprint difference workset", () => {
  it("applies the current server reach policy to each candidate instead of trusting the observer alone", async () => {
    const input = inputFor();
    const f = fixture(input, [null, null, null]);
    const context = { ...f.context, policy: { ...f.context.policy!, checkBlockReach: () => ({ allowed: false }) } };
    expect((await buildBlueprintSkill.execute(context, input, {} as never)).workset?.status).toBe("WAITING_REACH");
    expect(f.effects).toEqual([]);
  });
  it("uses the placement budget for actual sparse repairs, compared with the linear baseline", async () => {
    const input = inputFor(Array.from({ length: 16 }, (_, x) => cell(x)));
    const world = Array.from({ length: 16 }, (_, x) => x === 0 || x === 15 ? null : "stone");
    const baseline = fixture({ ...input, strategy: "linear" }, world);
    const candidate = fixture(input, world);
    expect((await baseline.run()).completed).toBe(false);
    expect(baseline.effects).toEqual([0]);
    const result = await candidate.run();
    expect(result.completed).toBe(true);
    expect(candidate.effects).toEqual([0, 15]);
    expect(result.placements.map((p) => p.index)).toEqual([0, 15]);
    expect(candidate.calls.filter((c) => c === "blueprint.inspect-workset")).toHaveLength(3);
  });

  it("uses supplied material on independent cells, then reports the exact remaining shortfall", async () => {
    const f = fixture(inputFor([cell(0, "glass"), cell(1)]), [null, null], new Map([["stone", 1]]));
    const result = await f.run();
    expect(f.effects).toEqual([1]);
    expect(result.nextIndex).toBe(0);
    expect(result.workset).toMatchObject({ status: "WAITING_MATERIAL", missingMaterials: [{ itemName: "glass", count: 1 }] });
    f.materials.set("glass", 1);
    expect((await f.run()).completed).toBe(true);
    expect(f.effects).toEqual([1, 0]);
  });

  it("honors material budgets across multiple fresh inventory snapshots", async () => {
    const input = { ...inputFor(), availableMaterials: [{ itemName: "stone", count: 1 }] };
    const f = fixture(input, [null, null, null]);
    expect((await f.run()).workset?.status).toBe("WAITING_MATERIAL");
    expect(f.effects).toEqual([0]);
  });

  it("retains unknown cells, repairs known independent cells, and blocks later structural classes", async () => {
    const input = inputFor();
    input.blueprint.cells[2]!.blockClass = "decoration";
    const f = fixture(input, [undefined, null, null]);
    const result = await f.run();
    expect(f.effects).toEqual([1]);
    expect(result.verification?.states).toEqual(["unknown", "match", "different"]);
    expect(result.workset?.status).toBe("WAITING_OBSERVATION");
    expect(result.completed).toBe(false);
  });

  it("cannot use an unverified blueprint cell as support, then resumes once support is verified", () => {
    const input = inputFor([cell(0, "stone", 1), cell(1)]);
    const f = fixture(input, [null, null]);
    const observation = f.snapshot();
    observation.cells[0]!.workfaces = [{ referenceBlock: { x: 1, y: 64, z: 0 }, face: { x: -1, y: 0, z: 0 } }];
    // Use valid adjacent geometry with an internal support dependency.
    input.blueprint.cells[0]!.offset.y = 0;
    expect(selectBlueprintWorkset(input, observation).next?.index).toBe(1);
    observation.cells[1]!.state = "match";
    observation.cells[1]!.observedItemName = "stone";
    expect(selectBlueprintWorkset(input, observation).next?.index).toBe(0);
  });

  it.each(["support", "reach", "properties"])("reports waiting for %s without effects", async (reason) => {
    const input = inputFor([cell(0)]);
    const f = fixture(input, [null]);
    const observation = f.snapshot();
    if (reason === "support") observation.cells[0]!.workfaces = [];
    if (reason === "reach") observation.cells[0]!.reachable = false;
    if (reason === "properties") observation.cells[0]!.observedItemName = "stone";
    const result = selectBlueprintWorkset(input, observation);
    expect(result.next).toBeNull();
    expect(result.summary.status).toBe(`WAITING_${reason.toUpperCase()}`);
  });

  it("performs read-only workset inspection and rejects incomplete snapshot identities", async () => {
    const f = fixture({ ...inputFor(), inspectOnly: true }, [null, "stone", null]);
    expect((await f.run()).completed).toBe(false);
    expect(f.effects).toEqual([]);
    const bad = f.snapshot(); bad.cells.pop();
    expect(() => selectBlueprintWorkset(inputFor(), bad)).toThrow("Skill execution failed");
  });

  it("stops after cancellation even when a placement receipt arrives late", async () => {
    const input = inputFor();
    const f = fixture(input, [null, null, null]);
    const original = f.context.callCapability;
    const context = { ...f.context, callCapability: async (...args: Parameters<typeof original>) => {
      const receipt = await original(...args);
      if (args[1] === "block.place-safe") f.controller.abort();
      return receipt;
    } } as SkillExecutionContext;
    await expect(buildBlueprintSkill.execute(context, input, {} as never)).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
    expect(f.effects).toEqual([0]);
  });

  it("rejects a successful receipt when the subsequent world read does not confirm it", async () => {
    const input = inputFor([cell(0)]);
    const f = fixture(input, [null]);
    const original = f.context.callCapability;
    const context = { ...f.context, callCapability: async (...args: Parameters<typeof original>) => {
      const receipt = await original(...args);
      if (args[1] === "block.place-safe") f.world[0] = null;
      return receipt;
    } } as SkillExecutionContext;
    await expect(buildBlueprintSkill.execute(context, input, {} as never)).rejects.toMatchObject({ code: "BUILD_WRONG_BLOCK" });
    expect(f.effects).toEqual([0]);
  });

  it("resumes sparse progress after a lost result without replaying confirmed cells", async () => {
    const input = inputFor();
    const f = fixture(input, ["stone", null, "stone"]);
    expect((await f.run()).completed).toBe(true);
    expect(f.effects).toEqual([1]);
    expect((await f.run()).completed).toBe(true);
    expect(f.effects).toEqual([1]);
  });
});

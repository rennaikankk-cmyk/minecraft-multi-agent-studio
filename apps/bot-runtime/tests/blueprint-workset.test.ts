import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { blueprintWorksetObservationSchema } from "@minecraft-studio/skills";
import { MineflayerBotClient } from "../src/mineflayer-client.js";

const blueprint = { serverProfileId: "fixture", dimension: "minecraft:overworld", anchor: { x: 0, y: 64, z: 0 },
  cells: [{ offset: { x: 0, y: 0, z: 0 }, itemName: "stone", blockClass: "structural", order: 0 }] };
function fixture(blockAt: (position: Vec3) => unknown, hasMaterial = true) {
  const bot = new EventEmitter() as unknown as Bot;
  const effects = { dig: vi.fn(), equip: vi.fn(), placeBlock: vi.fn() };
  Object.assign(bot, { game: { dimension: "overworld" }, entity: { position: new Vec3(0, 64, 1) },
    inventory: { items: () => hasMaterial ? [{ name: "stone", count: 2 }] : [] }, blockAt, ...effects });
  const client = new MineflayerBotClient(bot, "auto", "fixture");
  const invoke = (operation: string, input: unknown = blueprint) => client.invokeSkillCapability({
    invocationId: "attempt", taskId: "task", botId: "bot", traceId: "trace", skillId: "build.blueprint", skillVersion: "1.0.0",
    capability: "world.interact", operation, input: input as never, signal: new AbortController().signal,
  });
  return { ...effects, invoke };
}
const block = (position: Vec3, name: string) => ({ position, name, boundingBox: name === "air" ? "empty" : "block", getProperties: () => ({}) });
const placement = { itemName: "stone", referenceBlock: { x: 0, y: 63, z: 0 }, face: { x: 0, y: 1, z: 0 },
  target: { x: 0, y: 64, z: 0 }, blueprintIndex: 0, serverProfileId: "fixture", dimension: "minecraft:overworld" };

describe("Runtime blueprint workfaces", () => {
  it("observes an alternate side support and actual material without moving or placing", async () => {
    const f = fixture((p) => block(p, p.equals(new Vec3(-1, 64, 0)) ? "stone" : "air"));
    const snapshot = blueprintWorksetObservationSchema.parse(await f.invoke("blueprint.inspect-workset"));
    expect(snapshot.cells[0]).toMatchObject({ state: "different", observedItemName: null, reachable: true,
      workfaces: [{ referenceBlock: { x: -1, y: 64, z: 0 }, face: { x: 1, y: 0, z: 0 } }] });
    expect(snapshot.availableMaterials).toEqual([{ itemName: "stone", count: 2 }]);
    expect(f.dig).not.toHaveBeenCalled();
    expect(f.placeBlock).not.toHaveBeenCalled();
  });

  it("preserves unknown targets and respects an explicit nondefault support face", async () => {
    const f = fixture((p) => p.equals(new Vec3(0, 64, 0)) ? null : block(p, p.equals(new Vec3(-1, 64, 0)) ? "stone" : "air"));
    const snapshot = blueprintWorksetObservationSchema.parse(await f.invoke("blueprint.inspect-workset", { ...blueprint,
      cells: [{ ...blueprint.cells[0], referenceOffset: { x: 0, y: 1, z: 0 }, face: { x: 0, y: -1, z: 0 } }] }));
    expect(snapshot.cells[0]).toMatchObject({ state: "unknown", workfaces: [] });
  });

  it("cannot shift a fixed blueprint target down when its reference disappears", async () => {
    const f = fixture((p) => block(p, p.y === 62 ? "stone" : "air"));
    await expect(f.invoke("block.place-safe", placement)).rejects.toMatchObject({ code: "BLUEPRINT_STEP_BLOCKED" });
    expect(f.dig).not.toHaveBeenCalled();
    expect(f.equip).not.toHaveBeenCalled();
    expect(f.placeBlock).not.toHaveBeenCalled();
  });

  it("does not clear an occupied target before confirming replacement material", async () => {
    const f = fixture((p) => block(p, p.y === 64 ? "dirt" : "stone"), false);
    await expect(f.invoke("block.place-safe", placement)).rejects.toMatchObject({ code: "BUILD_MATERIAL_MISSING" });
    expect(f.dig).not.toHaveBeenCalled();
    expect(f.placeBlock).not.toHaveBeenCalled();
  });

  it("does not place when the target unloads between workset inspection and execution", async () => {
    const f = fixture((p) => p.y === 64 ? null : block(p, "stone"));
    await expect(f.invoke("block.place-safe", placement)).rejects.toMatchObject({ code: "BUILD_VERIFY_TIMEOUT" });
    expect(f.dig).not.toHaveBeenCalled();
    expect(f.placeBlock).not.toHaveBeenCalled();
  });
});

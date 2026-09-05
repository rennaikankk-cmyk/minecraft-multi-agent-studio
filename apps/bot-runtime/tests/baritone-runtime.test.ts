import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { describe, expect, it, vi } from "vitest";
import { WorldAssetAuthority, InMemoryWorkstationRegistry, builtinSkillVerificationManifestsV1 } from "@minecraft-studio/skills";
import { MineflayerBotClient } from "../src/mineflayer-client.js";

vi.mock("mineflayer-pathfinder", async (original) => {
  const actual = await original<typeof import("mineflayer-pathfinder")>();
  return { ...actual, Movements: class { exclusionAreasBreak = []; exclusionAreasPlace = []; } };
});
const scope = { serverProfileId: "isolated-local", dimension: "minecraft:overworld" };
function fixture(assets = new WorldAssetAuthority()) {
  const bot = new EventEmitter() as unknown as Bot;
  const wire = new EventEmitter();
  let crop = "wheat", age = 7, seeds = 3, wheat = 0;
  const block = (p: Vec3) => ({ position: p, name: p.y === 63 ? "farmland" : p.x === 0 && p.z === 0 && p.y === 64 ? crop : "air",
    boundingBox: p.y < 64 ? "block" : "empty", diggable: true, getProperties: () => ({ age }) });
  const dig = vi.fn(async () => { crop = "air"; wheat++; wire.emit("block_change", { location: { x: 0, y: 64, z: 0 }, type: 0 }); });
  const placeBlock = vi.fn(async () => { crop = "wheat"; age = 0; seeds--; });
  Object.assign(bot, { _client: wire, game: { dimension: "overworld" }, entity: { position: new Vec3(0.5, 64, 1.5) },
    registry: { blocksByName: {} }, blockAt: block, clearControlStates: vi.fn(), stopDigging: vi.fn(),
    inventory: { items: () => [{ name: "wheat_seeds", count: seeds }, ...(wheat ? [{ name: "wheat", count: wheat }] : [])] },
    equip: vi.fn(async () => {}), dig, placeBlock,
    pathfinder: { goto: vi.fn(async () => {}), setMovements: vi.fn(), setGoal: vi.fn(), stop: vi.fn() } });
  const client = new MineflayerBotClient(bot, "auto", scope.serverProfileId, false, undefined, "safe", null, undefined,
    new InMemoryWorkstationRegistry(), { assets, workAreas: assets.workAreas });
  const invoke = (id: string, input: unknown, signal = new AbortController().signal) => client.invokeSkillCapability({
    invocationId: "attempt", taskId: "task", botId: "bot-a", traceId: "trace", skillId: id, skillVersion: "1.0.0",
    capability: id === "farm.maintain" || id === "build.clear-area" ? "world.interact" : "bot.move", operation: `${id}-safe`, input: input as never, signal });
  return { bot, client, dig, placeBlock, assets, invoke };
}
const input = { area: { ...scope, min: { x: 0, y: 64, z: 0 }, max: { x: 0, y: 64, z: 0 } }, crops: ["wheat"] };
describe("process Runtime wiring", () => {
  it("executes farm maintenance through locks, shared lease, wire confirmation, and shared provenance", async () => {
    const f = fixture();
    expect(await f.invoke("farm.maintain", input)).toMatchObject({ harvested: 1, planted: 1 });
    expect(f.assets.observe({ ...scope, position: input.area.min }).record).toMatchObject({ purpose: "farm", serverVerified: true });
    expect(f.bot.dig).toBe(f.dig); expect(f.bot.placeBlock).toBe(f.placeBlock);
    expect(f.assets.workAreas.claim({ area: input.area, owner: "bot-b" })).toBeDefined();
  });
  it("refuses a teammate's structural asset before digging", async () => {
    const f = fixture();
    f.assets.record({ ...scope, position: input.area.min, source: "team_placed", owner: "own_team", purpose: "structural", serverVerified: true });
    await expect(f.invoke("farm.maintain", input)).rejects.toMatchObject({ code: "HARVEST_PROTECTED_ASSET" });
    expect(f.dig).not.toHaveBeenCalled();
  });
  it("stops all new effects when cancellation arrives during approach", async () => {
    const f = fixture(); const controller = new AbortController();
    vi.mocked(f.bot.pathfinder.goto).mockImplementation(async () => { controller.abort(); });
    await expect(f.invoke("farm.maintain", input, controller.signal)).rejects.toBeDefined();
    expect(f.dig).not.toHaveBeenCalled(); expect(f.placeBlock).not.toHaveBeenCalled();
  });
  it("holds the effect lock through L0 preemption and invalidates escaped dig callbacks", async () => {
    const f = fixture();
    const originalDig = f.dig.getMockImplementation()!;
    let finishDig!: () => void;
    const pending = new Promise<void>((resolve) => { finishDig = resolve; });
    f.dig.mockImplementationOnce(async () => { await pending; await originalDig(); });
    const result = f.invoke("farm.maintain", input).then(() => null, (error: unknown) => error);
    await vi.waitFor(() => expect(f.dig).toHaveBeenCalledTimes(1));
    const escapedDig = f.bot.dig;
    expect(await f.client.executeSafetyAction({ kind: "FORAGE_SAFE_FOOD" })).toMatchObject({ outcome: "skipped", errorCode: "ACTION_LOCK_BUSY" });
    expect(f.bot.dig).toBe(escapedDig);
    finishDig();
    expect(await result).toMatchObject({ code: "SKILL_CANCELLED" });
    expect(f.placeBlock).not.toHaveBeenCalled();
    expect(f.bot.dig).toBe(f.dig);
    await expect(escapedDig(f.bot.blockAt(new Vec3(0, 64, 0))!)).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
    expect(f.dig).toHaveBeenCalledTimes(1);
    const forage = vi.spyOn(f.client as unknown as { forageSafeFood(): Promise<{ outcome: "executed"; errorCode: null }> }, "forageSafeFood")
      .mockImplementation(async () => {
        await f.bot.dig(f.bot.blockAt(new Vec3(0, 64, 0))!);
        return { outcome: "executed", errorCode: null };
      });
    expect(await f.client.executeSafetyAction({ kind: "FORAGE_SAFE_FOOD" })).toMatchObject({ outcome: "executed" });
    expect(f.dig).toHaveBeenCalledTimes(2);
    expect(f.bot.dig).toBe(f.dig);
    forage.mockRestore();
  });
  it("refuses a placement when the dimension changes during the authority round trip", async () => {
    const f = fixture();
    const originalRecord = f.assets.record.bind(f.assets);
    vi.spyOn(f.assets, "record").mockImplementation((entry) => {
      const result = originalRecord(entry);
      if (entry.source === "bot_placed" && !entry.serverVerified) Object.assign(f.bot.game, { dimension: "the_nether" });
      return result;
    });
    await expect(f.invoke("farm.maintain", input)).rejects.toMatchObject({ code: "TARGET_DIMENSION_MISMATCH" });
    expect(f.dig).toHaveBeenCalledTimes(1);
    expect(f.placeBlock).not.toHaveBeenCalled();
    expect(f.assets.observe({ ...scope, position: input.area.min }).record?.serverVerified).toBe(false);
  });
  it.each(["farm.maintain", "movement.goal", "movement.follow", "movement.get-to-block", "world.explore", "build.clear-area", "movement.elytra"])("L0 retains movement ownership against %s", async (id) => {
    const f = fixture();
    const lease = f.client.movementController.acquire({ owner: "l0", priority: 0 })!;
    const manifest = builtinSkillVerificationManifestsV1.find((entry) => entry.skillId === id)!;
    await expect(f.invoke(id, manifest.scenarios[0]!.input)).rejects.toMatchObject({ code: "BOT_MOVEMENT_BUSY" });
    expect(f.dig).not.toHaveBeenCalled(); expect(f.placeBlock).not.toHaveBeenCalled();
    expect(lease.isCurrent()).toBe(true); lease.release();
  });
});

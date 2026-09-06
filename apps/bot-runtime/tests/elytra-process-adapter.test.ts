import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import type { Bot } from "mineflayer";
import { elytraInputSchema, elytraSkill } from "@minecraft-studio/skills";
import { glideToLanding, safeFlightRocket } from "../src/elytra-process-adapter.js";
import type { NavigationProcessPort } from "../src/navigation-process-adapter.js";

function fixture() {
  let now = 0;
  const rocket = { name: "firework_rocket", count: 8, components: [{ type: "fireworks", data: { flightDuration: 1, explosions: [] } }] };
  const entity = { position: new Vec3(0.5, 72, 0.5), velocity: new Vec3(0.8, -0.1, 0), onGround: false, elytraFlying: true };
  const bot = { entity, heldItem: null as unknown, inventory: { items: () => [rocket], slots: { 6: { name: "elytra", durabilityUsed: 1 } } },
    getEquipmentDestSlot: () => 6, registry: { itemsByName: { elytra: { maxDurability: 432 } } },
    blockAt: (p: Vec3) => ({ name: p.y < 64 ? "stone" : "air", boundingBox: p.y < 64 ? "block" : "empty" }),
    equip: vi.fn(async (item: unknown) => { bot.heldItem = item; }), lookAt: vi.fn(async () => {}),
    elytraFly: vi.fn(async () => {}), setControlState: vi.fn(), deactivateItem: vi.fn(),
    activateItem: vi.fn(() => { rocket.count--; }),
  };
  const port: NavigationProcessPort = { bot: bot as unknown as Bot, now: () => now, assertActive: () => {},
    wait: async (ms) => { now += ms; }, goto: vi.fn(), stop: vi.fn() };
  const input = elytraInputSchema.parse({ serverProfileId: "isolated", dimension: "minecraft:overworld", target: { x: 100, y: 64, z: 0 }, maxFlightMs: 1000 });
  return { bot, rocket, port, input };
}

describe("flight preflight and control boundaries", () => {
  it("only accepts known non-explosive modern rockets", () => {
    const f = fixture();
    expect(safeFlightRocket(f.rocket)).toBe(true);
    expect(safeFlightRocket({ ...f.rocket, components: [], removedComponents: [] })).toBe(true);
    expect(safeFlightRocket({ ...f.rocket, components: [], removedComponents: ["fireworks"] })).toBe(false);
    expect(safeFlightRocket({ name: "firework_rocket", count: 64 })).toBe(false);
    expect(safeFlightRocket({ ...f.rocket, components: [{ type: "fireworks", data: { flightDuration: 1, explosions: [{}] } }] })).toBe(false);
  });
  it("keeps unverified flight out of private and production skill execution", () => {
    const f = fixture();
    const gate = elytraSkill.preconditions.find((p) => p.id === "flight.isolated-validation")!;
    const state = { online: true, normalActionsAllowed: true, serverProfileId: "isolated", position: null };
    expect(gate.check(f.input, elytraSkill.stateSchema.parse(state))).toBe(false);
    expect(gate.check(f.input, elytraSkill.stateSchema.parse({ ...state, isolatedTestServer: true }))).toBe(true);
  });
  it("rejects rocket shortages before starting a flight or consuming reserve", async () => {
    const f = fixture(); f.rocket.count = 1;
    await expect(glideToLanding(f.port, f.input)).rejects.toMatchObject({ code: "ELYTRA_FIREWORKS_REQUIRED" });
    expect(f.bot.activateItem).not.toHaveBeenCalled();
    expect(f.bot.elytraFly).not.toHaveBeenCalled();
  });
  it("requires grounded safe takeoff geometry", async () => {
    const f = fixture(); f.bot.entity.onGround = true;
    f.bot.blockAt = (p) => ({ name: "lava", boundingBox: "empty" });
    await expect(glideToLanding(f.port, f.input)).rejects.toMatchObject({ code: "ELYTRA_TAKEOFF_UNSAFE" });
    expect(f.bot.setControlState).not.toHaveBeenCalled();
  });
  it("does not send a rocket after an asynchronous equip loses execution rights", async () => {
    const f = fixture(); let cancelled = false;
    f.port.assertActive = () => { if (cancelled) throw new Error("cancelled"); };
    f.bot.equip = vi.fn(async () => { cancelled = true; });
    await expect(glideToLanding(f.port, f.input)).rejects.toThrow("cancelled");
    expect(f.bot.activateItem).not.toHaveBeenCalled();
  });
  it("does not infer rocket use from elapsed time without an inventory acknowledgement", async () => {
    const f = fixture(); f.bot.activateItem = vi.fn();
    await expect(glideToLanding(f.port, f.input)).rejects.toMatchObject({ code: "ELYTRA_FIREWORK_UNCONFIRMED" });
    expect(f.rocket.count).toBe(8);
  });
  it("rejects ambiguous consumption instead of issuing another boost", async () => {
    const f = fixture(); f.bot.activateItem = vi.fn(() => { f.rocket.count -= 2; });
    await expect(glideToLanding(f.port, f.input)).rejects.toMatchObject({ code: "ELYTRA_FIREWORK_READBACK_MISMATCH" });
    expect(f.bot.activateItem).toHaveBeenCalledOnce();
  });
  it("reports the real touchdown separately from a verified short ground approach", async () => {
    const f = fixture();
    f.port.wait = async () => { f.bot.entity.onGround = true; f.bot.entity.position = new Vec3(108.5, 64, 0.5); };
    f.port.goto = vi.fn(async () => { f.bot.entity.position = new Vec3(100.5, 64, 0.5); });
    await expect(glideToLanding(f.port, f.input)).resolves.toMatchObject({
      landed: true, reached: true, touchdown: { x: 108, y: 64, z: 0 }, groundApproachDistance: 8,
      position: { x: 100, y: 64, z: 0 }, fireworksUsed: 1,
    });
    expect(f.port.goto).toHaveBeenCalledOnce();
  });
  it("does not claim arrival when the ground pathfinder resolves outside the requested radius", async () => {
    const f = fixture();
    f.port.wait = async () => { f.bot.entity.onGround = true; f.bot.entity.position = new Vec3(108.5, 64, 0.5); };
    await expect(glideToLanding(f.port, f.input)).rejects.toMatchObject({ code: "ELYTRA_LANDING_MISSED" });
  });
  it("rejects distant touchdown without walking an unbounded recovery route", async () => {
    const f = fixture();
    f.port.wait = async () => { f.bot.entity.onGround = true; f.bot.entity.position = new Vec3(140.5, 64, 0.5); };
    await expect(glideToLanding(f.port, f.input)).rejects.toMatchObject({ code: "ELYTRA_LANDING_MISSED" });
    expect(f.port.goto).not.toHaveBeenCalled();
  });
});

import { EventEmitter } from "node:events";
import type { Bot } from "mineflayer";
import { describe, expect, it } from "vitest";
import { AssetPolicy, assetPolicyRecordSchema, WorldAssetAuthority } from "@minecraft-studio/asset-policy";
import { MachineProtection } from "../src/machine-protection.js";

const scope = { serverProfileId: "fixture", worldId: "world-a", dimension: "minecraft:overworld", subject: "bot-a" };
const position = { x: 5, y: 64, z: 5 };
function fixture() {
  const packets: { name: string; data: unknown }[] = [];
  const wire = { write: (name: string, data: unknown) => { packets.push({ name, data }); } };
  const window = Object.assign(new EventEmitter(), {
    containerItems: () => [{ name: "iron_ingot", count: 16 }],
    withdraw: async (_type: number, _metadata: number | null, count: number | null) => { wire.write("window_click", { windowId: 2, count }); },
    deposit: async () => { wire.write("window_click", { windowId: 2 }); },
  });
  const bot = {
    _client: wire, players: {}, entities: { 7: { position, name: "end_crystal", uuid: "crystal-7" } },
    heldItem: { name: "diamond_pickaxe" }, entity: { position: { x: 1, y: 64, z: 1 } },
    registry: { items: { 1: { name: "iron_ingot" } } },
    blockAt: (p: { x: number; y: number; z: number }) => ({ name: "barrel", position: p }),
    openContainer: async () => window,
  } as unknown as Bot;
  const authority = new WorldAssetAuthority();
  let now = 1000;
  const guard = new MachineProtection(bot, authority, () => scope, () => now);
  return { bot, window, wire, packets, authority, guard, advance: () => { now += 2001; } };
}

describe("final Runtime machine protection", () => {
  it("intercepts actual wire writes from digging, placement, combat and raw plugin calls", async () => {
    const f = fixture();
    f.authority.policy.register({ ...scopeFields(), assetId: "machine", position, role: "machine", protection: "UNKNOWN_PROTECTED", revision: 1, version: 1 });
    f.guard.install();
    try {
      await f.guard.refresh();
      for (const [name, data] of [
        ["block_dig", { location: position, status: 0 }],
        ["block_place", { location: position }],
        ["use_entity", { target: 7 }],
      ] as const) expect(() => f.wire.write(name, data)).toThrow();
      expect(f.packets).toHaveLength(0);
      f.wire.write("position", { x: 50, y: 64, z: 50 });
      expect(f.packets).toHaveLength(1);
    } finally { f.guard.stop(); }
  });
  it("keeps L0 movement usable when policy is unavailable and rejects new world effects", async () => {
    const f = fixture(); f.guard.install();
    try {
      await f.guard.refresh(); f.advance();
      expect(() => f.wire.write("block_dig", { location: position, status: 0 })).toThrow("ASSET_POLICY_UNAVAILABLE");
      f.wire.write("position", { x: 50, y: 64, z: 50 });
      expect(f.packets).toHaveLength(1);
    } finally { f.guard.stop(); }
  });
  it("permits bounded output withdrawal but blocks deposit, untracked GUI clicks and revoked grants", async () => {
    const f = fixture();
    const output = assetPolicyRecordSchema.parse({ ...scopeFields(), assetId: "output", position, role: "container", protection: "OUTPUT_ONLY",
      subjects: [scope.subject], expectedBlock: "barrel", allowedItems: ["iron_ingot"], maxWithdrawal: 8, minimumRetained: 4, revision: 1, version: 1 });
    f.authority.policy.register(output); f.guard.install();
    try {
      await f.guard.refresh();
      const window = await f.bot.openContainer({ position, name: "barrel" } as never);
      await window.withdraw(1, null, 8);
      expect(f.packets).toHaveLength(1);
      await expect(window.deposit(1, null, 1)).rejects.toThrow("ASSET_OUTPUT_ONLY");
      await expect(window.withdraw(1, null, 9)).rejects.toThrow("ASSET_OUTPUT_ALLOWANCE");
      expect(() => f.wire.write("window_click", { windowId: 2 })).toThrow("ASSET_TRANSFER_CONTEXT_REQUIRED");
      f.authority.policy.revoke(output);
      await expect(window.withdraw(1, null, 1)).rejects.toThrow("ASSET_POLICY_REVOKED");
      expect(f.packets).toHaveLength(1);
    } finally { f.guard.stop(); }
  });

  it("guards movement-triggered mechanisms, sign updates, and furnace windows", async () => {
    const f = fixture();
    const originalBlockAt = f.bot.blockAt;
    f.bot.blockAt = ((p: { x: number; y: number; z: number }) => {
      const block = originalBlockAt(p);
      if (p.x === position.x && p.y === position.y && p.z === position.z) return { ...block, name: "stone_pressure_plate", position: p };
      return block;
    }) as never;
    const furnaceWindow = Object.assign(new EventEmitter(), {
      outputItem: () => ({ name: "iron_ingot", count: 2 }), inputItem: () => null, fuelItem: () => null,
      takeOutput: async () => undefined, takeInput: async () => undefined, takeFuel: async () => undefined,
    });
    f.bot.openFurnace = (async () => furnaceWindow) as never;
    f.authority.policy.register(assetPolicyRecordSchema.parse({ ...scopeFields(), assetId: "machine", position,
      role: "machine", protection: "UNKNOWN_PROTECTED", revision: 1, version: 1 }));
    f.guard.install();
    try {
      await f.guard.refresh();
      expect(() => f.wire.write("position", { position })).toThrow("ASSET_MACHINE_PROTECTED");
      expect(() => f.wire.write("update_sign", { location: position, lines: [] })).toThrow("ASSET_MACHINE_PROTECTED");
      await expect(f.bot.openFurnace({ position, name: "furnace" } as never)).rejects.toThrow("ASSET_MACHINE_PROTECTED");
    } finally { f.guard.stop(); }
  });
});
function scopeFields() { const { subject: _subject, ...fields } = scope; return fields; }

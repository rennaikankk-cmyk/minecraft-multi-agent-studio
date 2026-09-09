import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { AssetPolicy, assetPolicyRecordSchema, evaluateWorldEffect, WorldAssetAuthority } from "../src/index.js";

const scope = { serverProfileId: "fixture", worldId: "world-a", dimension: "minecraft:overworld" };
const p = { x: 4, y: 64, z: 4 };
const machine = assetPolicyRecordSchema.parse({ ...scope, assetId: "machine", position: p, role: "machine",
  bounds: { min: p, max: { x: 7, y: 68, z: 7 } }, protection: "UNKNOWN_PROTECTED", revision: 1, version: 1,
  protectedEntityUuids: ["functional-villager"] });

describe("durable world protection", () => {
  it("retains machine protection through revocation, restart, stale revisions and grants", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "v2-asset-")), file = path.join(directory, "policy.json");
    try {
      const policy = new AssetPolicy(file);
      policy.register(machine);
      expect(() => policy.grant({ ...scope, assetId: "machine", position: p, version: 1, revision: 1,
        subject: "bot-a", action: "dig", expiresAtMs: Date.now() + 10_000 })).toThrow("ASSET_GRANT_PROTECTED");
      expect(() => policy.register({ ...machine, protection: "UNPROTECTED" })).toThrow("ASSET_POLICY_REVISION_CONFLICT");
      policy.revoke(machine);
      const restored = new AssetPolicy(file);
      expect(restored.snapshot(scope)[0]?.revoked).toBe(true);
      expect(() => restored.register(machine)).toThrow("ASSET_POLICY_REVISION_REWIND");
      expect(restored.snapshot({ ...scope, worldId: "world-b" })).toEqual([]);
      writeFileSync(file, "broken");
      expect(() => new AssetPolicy(file)).toThrow("ASSET_POLICY_CORRUPT");
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it("checks supporting blocks, indirect blast effects and moved protected entities", () => {
    const request = { ...scope, schemaVersion: "1.0" as const, subject: "bot-a", position: { x: 6, y: 65, z: 5 }, action: "dig" as const, impactRadius: 0 };
    expect(evaluateWorldEffect([machine], request).allowed).toBe(false);
    expect(evaluateWorldEffect([machine], { ...request, position: { x: 1, y: 64, z: 4 }, impactRadius: 4 }).allowed).toBe(false);
    expect(evaluateWorldEffect([machine], { ...request, position: { x: 100, y: 64, z: 4 }, action: "entity", entityUuid: "functional-villager" }).allowed).toBe(false);
    expect(evaluateWorldEffect([machine], { ...request, position: { x: 100, y: 64, z: 4 } }).allowed).toBe(true);
  });
  it("allows an explicit output inside an unknown base only for the configured subject and items", () => {
    const base = assetPolicyRecordSchema.parse({ ...machine, assetId: "base", role: "unknown", protectedEntityUuids: [] });
    const output = assetPolicyRecordSchema.parse({ ...scope, assetId: "output", position: { x: 5, y: 64, z: 5 }, role: "container",
      protection: "OUTPUT_ONLY", expectedBlock: "barrel", subjects: ["bot-a"], allowedItems: ["iron_ingot"], maxWithdrawal: 8, revision: 1, version: 1 });
    const request = { ...scope, schemaVersion: "1.0" as const, subject: "bot-a", position: output.position,
      action: "container-transfer" as const, impactRadius: 0, direction: "withdraw" as const, observedBlock: "barrel", itemName: "iron_ingot", count: 4 };
    expect(evaluateWorldEffect([base, output], request).allowed).toBe(true);
    for (const change of [{ count: 9 }, { subject: "bot-b" }, { direction: "deposit" as const }, { observedBlock: "chest" }]) {
      expect(evaluateWorldEffect([base, output], { ...request, ...change }).allowed).toBe(false);
    }
    expect(evaluateWorldEffect([machine, output], request).allowed).toBe(false);
  });
  it("keeps provenance and leases separate when the same server starts a new world", () => {
    const authority = new WorldAssetAuthority();
    authority.record({ ...scope, position: p, source: "bot_placed", owner: "own_bot", purpose: "structural", serverVerified: true });
    expect(authority.observe({ ...scope, position: p }).record?.owner).toBe("own_bot");
    expect(authority.observe({ ...scope, worldId: "world-b", position: p }).record).toBeNull();
    expect(() => authority.record({ ...scope, position: p, source: "bot_placed", owner: "own_bot", purpose: "navigation", serverVerified: true })).toThrow("PROVENANCE_PROTECTION_IMMUTABLE");
  });
});

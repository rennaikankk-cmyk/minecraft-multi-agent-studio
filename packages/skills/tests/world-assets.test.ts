import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WorldAssetAuthority, WorkAreaLeaseAuthority, BaseRegistry, authorizeHarvest,
  SharedStateClient, createSharedStateDispatcher, dispatchSharedState, InMemoryWorkstationRegistry, FacilityRegistry,
  AssetPolicy } from "../src/index.js";

const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
const position = { x: 10, y: 64, z: 10 };
const area = { ...scope, min: position, max: { x: 12, y: 66, z: 12 } };
const entry = { ...scope, position, source: "bot_placed" as const, owner: "own_team" as const, purpose: "structural" as const, serverVerified: true };

describe("shared world asset authority", () => {
  it("keeps both bots' placements and updates across authority restart", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-assets-"));
    try {
      const a = new WorldAssetAuthority({ persistDir: dir });
      a.record(entry); a.record({ ...entry, position: { ...position, x: 11 }, placedByBotId: "bot-b" });
      a.record({ ...entry, purpose: "farm" });
      const restored = new WorldAssetAuthority({ persistDir: dir });
      expect(restored.observe({ ...scope, position }).record?.purpose).toBe("farm");
      expect(restored.observe({ ...scope, position: { ...position, x: 11 } }).record?.placedByBotId).toBe("bot-b");
      expect(restored.observe({ ...scope, serverProfileId: "other", position }).record).toBeNull();
      expect(restored.observe({ ...scope, dimension: "minecraft:the_nether", position }).record).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("refuses corrupt storage, mixed server records, and capacity eviction", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-assets-"));
    try {
      writeFileSync(path.join(dir, "fixture.json"), "bad-json");
      expect(() => new WorldAssetAuthority({ persistDir: dir }).observe({ ...scope, position })).toThrow("PROVENANCE_STORAGE_INVALID");
      const other = new WorldAssetAuthority();
      const record = other.record({ ...entry, serverProfileId: "other" });
      writeFileSync(path.join(dir, "fixture.json"), JSON.stringify({ schemaVersion: "1.0", records: [record] }));
      expect(() => new WorldAssetAuthority({ persistDir: dir }).observe({ ...scope, position })).toThrow("PROVENANCE_STORAGE_INVALID");
      const bounded = new WorldAssetAuthority({ maxRecordsPerServer: 1 });
      bounded.record(entry);
      expect(() => bounded.record({ ...entry, position: { ...position, x: 11 } })).toThrow("PROVENANCE_CAPACITY_EXCEEDED");
      expect(bounded.observe({ ...scope, position }).record).not.toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("blocks unknown blocks near a registered base and protects shared ownership", () => {
    const bases = new BaseRegistry();
    bases.create({ ...scope, anchor: position, name: "base", blueprintId: "starter" });
    const authority = new WorldAssetAuthority({ bases });
    const observation = authority.observe({ ...scope, position });
    expect(authorizeHarvest({ ...observation, explicitSalvageAuthorized: false })).toMatchObject({ allowed: false, code: "HARVEST_UNKNOWN_NEAR_BASE" });
    authority.record(entry);
    expect(authorizeHarvest({ ...authority.observe({ ...scope, position }), explicitSalvageAuthorized: false })).toMatchObject({ allowed: false });
  });
  it("fails closed for unknown ownership near a base and prevents provenance relabeling", () => {
    const bases = new BaseRegistry();
    bases.create({ ...scope, anchor: position, name: "base", blueprintId: "starter" });
    const authority = new WorldAssetAuthority({ bases });
    const unknown = { ...entry, owner: "unknown" as const, source: "unknown" as const };
    authority.record(unknown);
    expect(authorizeHarvest({ ...authority.observe({ ...scope, position }), explicitSalvageAuthorized: false }))
      .toMatchObject({ allowed: false, code: "HARVEST_UNKNOWN_NEAR_BASE" });
    expect(() => authority.record({ ...entry, owner: "external", source: "external_placed" }))
      .toThrow("PROVENANCE_IDENTITY_IMMUTABLE");
  });
  it("isolates case and punctuation variants when both stores exist before the first write", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-assets-"));
    try {
      const authority = new WorldAssetAuthority({ persistDir: dir });
      const profiles = ["Alpha", "alpha", "alpha:one", "alpha_one"];
      for (const serverProfileId of profiles) authority.observe({ ...scope, serverProfileId, position });
      for (const serverProfileId of profiles) authority.record({ ...entry, serverProfileId, placedByBotId: serverProfileId });
      const restored = new WorldAssetAuthority({ persistDir: dir });
      for (const serverProfileId of profiles) expect(restored.observe({ ...scope, serverProfileId, position }).record?.placedByBotId).toBe(serverProfileId);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("migrates legacy unqualified dimensions without rewriting the original file", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-assets-"));
    try {
      const original = JSON.stringify({ schemaVersion: "1.0", records: [{ ...entry, dimension: "overworld", recordId: "legacy", recordedAtMs: 1 }] });
      const legacyFile = path.join(dir, "fixture.json");
      writeFileSync(legacyFile, original);
      const authority = new WorldAssetAuthority({ persistDir: dir });
      expect(authority.observe({ ...scope, position }).record?.owner).toBe("own_team");
      authority.record({ ...entry, position: { ...position, x: 11 } });
      expect(readFileSync(legacyFile, "utf8")).toBe(original);
      expect(new WorldAssetAuthority({ persistDir: dir }).observe({ ...scope, position }).record?.owner).toBe("own_team");
      expect(() => authority.record({ ...entry, dimension: "overworld" })).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("serves assets to two versioned RPC clients through the same dispatcher", async () => {
    const authority = new WorldAssetAuthority();
    const dispatcher = createSharedStateDispatcher(new InMemoryWorkstationRegistry(), new FacilityRegistry(), authority, authority.workAreas);
    const fetchImpl: typeof fetch = async (_url, init) => new Response(JSON.stringify(dispatchSharedState(dispatcher, JSON.parse(String(init?.body)))));
    const a = new SharedStateClient({ baseUrl: "http://fixture", fetchImpl });
    const b = new SharedStateClient({ baseUrl: "http://fixture", fetchImpl });
    await a.assets.record(entry);
    expect((await b.assets.observe({ ...scope, position })).record?.owner).toBe("own_team");
    const lease = await a.workAreas.claim({ area, owner: "a" });
    expect((await b.assets.observe({ ...scope, position })).workAllowed).toBe(false);
    expect((await a.assets.observe({ ...scope, position, leaseId: lease.leaseId })).workAllowed).toBe(true);
    await expect(b.assets.remove({ ...scope, position })).rejects.toThrow("WORK_AREA_BUSY");
  });
});

describe("asset policy", () => {
  const policyRecord = {
    assetId: "machine-1", serverProfileId: "fixture", worldId: "world-a",
    dimension: "minecraft:overworld", position: { x: 4, y: 64, z: 4 },
    role: "machine" as const, protection: "OUTPUT_ONLY" as const,
    revision: 1, version: 1, allowedActions: ["container-transfer" as const],
  };
  it("requires matching scope/version and allows only confirmed output withdrawal", () => {
    const policy = new AssetPolicy();
    policy.register(policyRecord);
    const base = { assetId: policyRecord.assetId, serverProfileId: policyRecord.serverProfileId,
      worldId: policyRecord.worldId, dimension: policyRecord.dimension, subject: "bot-a", action: "container-transfer" as const,
      assetVersion: 1, policyRevision: 1, position: policyRecord.position };
    expect(policy.authorize({ ...base, direction: "withdraw" })).toMatchObject({ allowed: true, reason: "authorized_output" });
    expect(policy.authorize({ ...base, direction: "deposit" })).toMatchObject({ allowed: false, code: "ASSET_OUTPUT_ONLY" });
    expect(policy.authorize({ ...base, assetVersion: 2 })).toMatchObject({ allowed: false, code: "ASSET_VERSION_STALE" });
    expect(policy.authorize({ ...base, worldId: "world-b" })).toMatchObject({ allowed: false, code: "ASSET_UNKNOWN_PROTECTED" });
  });
  it("invalidates grants on revision replacement and revocation", () => {
    const policy = new AssetPolicy();
    policy.register({ ...policyRecord, protection: "PRIVATE" });
    policy.grant({ assetId: "machine-1", subject: "bot-a", action: "use", expiresAtMs: Date.now() + 10_000, revision: 1 });
    const request = { assetId: policyRecord.assetId, serverProfileId: policyRecord.serverProfileId,
      worldId: policyRecord.worldId, dimension: policyRecord.dimension, position: policyRecord.position,
      subject: "bot-a", action: "use" as const, assetVersion: 1, policyRevision: 1 };
    expect(policy.authorize(request)).toMatchObject({ allowed: true, reason: "owner" });
    policy.register({ ...policyRecord, protection: "PRIVATE", revision: 2 });
    expect(policy.authorize({ ...request, policyRevision: 2 })).toMatchObject({ allowed: false, code: "ASSET_ACTION_DENIED" });
    expect(policy.revoke(policyRecord)).toBe(true);
    expect(policy.authorize({ ...request, policyRevision: 2 })).toMatchObject({ allowed: false, code: "ASSET_UNKNOWN_PROTECTED" });
  });
});

describe("work area leases", () => {
  it("rejects overlapping selections even with different corners; expiry fences stale operations", () => {
    let now = 1000;
    const authority = new WorkAreaLeaseAuthority(() => now);
    const a = authority.claim({ area, owner: "a" });
    expect(() => authority.claim({ area: { ...area, min: { x: 11, y: 65, z: 11 } }, owner: "b" })).toThrow("WORK_AREA_BUSY");
    expect(authority.claim({ area: { ...area, dimension: "minecraft:the_nether" }, owner: "b" })).toBeDefined();
    expect(authority.validate({ leaseId: a.leaseId, owner: "b" })).toBe(false);
    now += 30_001;
    const b = authority.claim({ area, owner: "b" });
    expect(authority.permits({ ...scope, position, leaseId: a.leaseId })).toBe(false);
    expect(authority.release({ leaseId: a.leaseId, owner: "a" })).toBe(false);
    expect(authority.validate({ leaseId: b.leaseId, owner: "b" })).toBe(true);
  });
});

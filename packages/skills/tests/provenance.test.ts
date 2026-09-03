// Provenance + HarvestAuthorization 测试。
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ProvenanceStore,
  authorizeHarvest,
  type ProvenanceRecord,
} from "../src/provenance.js";

const POS = { x: 100, y: 64, z: -200 };
const DIM = "minecraft:overworld";

function makeRecord(overrides: Partial<ProvenanceRecord> = {}): ProvenanceRecord {
  return {
    recordId: "test-1",
    serverProfileId: "sp-1",
    dimension: DIM,
    position: POS,
    source: "bot_placed",
    owner: "own_bot",
    purpose: "structural",
    recordedAtMs: 1_000,
    serverVerified: true,
    ...overrides,
  };
}

describe("authorizeHarvest", () => {
  it("无记录 + 不在基地范围 → allowed（natural/unprotected）", () => {
    const result = authorizeHarvest({ record: null, explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(result.allowed).toBe(true);
  });

  it("无记录 + 在己方基地附近 → 拒绝（fail-closed）", () => {
    const result = authorizeHarvest({ record: null, explicitSalvageAuthorized: false, nearOwnBase: true });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("HARVEST_UNKNOWN_NEAR_BASE");
  });

  it("own_bot 记录 → 拒绝", () => {
    const result = authorizeHarvest({ record: makeRecord({ owner: "own_bot" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("HARVEST_PROTECTED_OWN");
  });

  it("own_team 记录 → 拒绝", () => {
    const result = authorizeHarvest({ record: makeRecord({ owner: "own_team" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("HARVEST_PROTECTED_TEAM");
  });

  it("explicit salvage 授权 → allowed", () => {
    const result = authorizeHarvest({ record: makeRecord({ owner: "own_bot" }), explicitSalvageAuthorized: true, nearOwnBase: false });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("authorized_salvage");
  });

  it("natural 记录 → allowed", () => {
    const result = authorizeHarvest({ record: makeRecord({ source: "natural", owner: "none" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(result.allowed).toBe(true);
    expect(result.reason).toBe("natural");
  });

  it("facility purpose → 拒绝", () => {
    const result = authorizeHarvest({ record: makeRecord({ purpose: "facility" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(result.allowed).toBe(false);
  });

  it("external 记录 → allowed（anarchy 场景可采集）", () => {
    const result = authorizeHarvest({ record: makeRecord({ owner: "external", source: "external_placed" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(result.allowed).toBe(true);
  });
});


describe('ProvenanceStore 持久化（2026-09-03 深度审计）', () => {
  it('记录落盘；新实例从磁盘恢复', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prov-test-'));
    try {
      const filePath = path.join(dir, 'prov.json');
      const s1 = new ProvenanceStore({ persistPath: filePath });
      s1.record(makeRecord());
      expect(existsSync(filePath)).toBe(true);
      const s2 = new ProvenanceStore({ persistPath: filePath });
      expect(s2.size).toBe(1);
      expect(s2.get(POS, DIM)!.owner).toBe('own_bot');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('remove 后落盘；重启后不再恢复', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prov-test-'));
    try {
      const filePath = path.join(dir, 'prov.json');
      const s1 = new ProvenanceStore({ persistPath: filePath });
      s1.record(makeRecord());
      expect(s1.remove(POS, DIM)).toBe(true);
      const s2 = new ProvenanceStore({ persistPath: filePath });
      expect(s2.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('corrupt 文件隔离为 .corrupt-*，空库继续', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'prov-test-'));
    try {
      const filePath = path.join(dir, 'prov.json');
      writeFileSync(filePath, 'NOT JSON {{{');
      const store = new ProvenanceStore({ persistPath: filePath });
      expect(store.size).toBe(0);
      const corrupt = readdirSync(dir).filter((f) => f.startsWith('prov.json.corrupt-'));
      expect(corrupt).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("灰度前加固：一次性用途 own 方块自挖（2026-09-03）", () => {
  it("own navigation/temporary/sacrificial 允许自挖（脚手架不死锁）", () => {
    for (const purpose of ["navigation", "temporary", "sacrificial"]) {
      const r = authorizeHarvest({ record: makeRecord({ purpose }), explicitSalvageAuthorized: false, nearOwnBase: false });
      expect(r).toEqual({ allowed: true, reason: "disposable_own" });
    }
  });
  it("own structural/facility/storage/farm/portal 仍拒绝（资产保护不变）", () => {
    for (const purpose of ["structural", "facility", "storage", "farm", "portal", undefined]) {
      const r = authorizeHarvest({ record: makeRecord({ purpose }), explicitSalvageAuthorized: false, nearOwnBase: false });
      expect(r.allowed).toBe(false);
    }
  });
  it("own_team 的 disposable 同样放行（队友垫脚可拆）", () => {
    const r = authorizeHarvest({ record: makeRecord({ owner: "own_team", purpose: "navigation" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(r.allowed).toBe(true);
  });
});
describe("ProvenanceStore", () => {
  it("record + get 基本操作", () => {
    const store = new ProvenanceStore();
    store.record(makeRecord());
    const found = store.get(POS, DIM);
    expect(found).not.toBeNull();
    expect(found!.owner).toBe("own_bot");
    expect(store.size).toBe(1);
  });

  it("同位置覆写（更新不重复）", () => {
    const store = new ProvenanceStore();
    store.record(makeRecord({ owner: "own_bot" }));
    store.record(makeRecord({ owner: "own_team" }));
    expect(store.size).toBe(1);
    expect(store.get(POS, DIM)!.owner).toBe("own_team");
  });

  it("不同位置/维度隔离", () => {
    const store = new ProvenanceStore();
    store.record(makeRecord({ position: { x: 1, y: 64, z: 1 } }));
    store.record(makeRecord({ position: { x: 1, y: 64, z: 1 }, dimension: "minecraft:the_nether" }));
    expect(store.size).toBe(2);
    expect(store.get({ x: 1, y: 64, z: 1 }, "minecraft:overworld")).not.toBeNull();
    expect(store.get({ x: 1, y: 64, z: 1 }, "minecraft:the_nether")).not.toBeNull();
    expect(store.get({ x: 2, y: 64, z: 1 }, DIM)).toBeNull();
  });

  it("chunk 索引查询", () => {
    const store = new ProvenanceStore();
    // x=100 → chunk 6; z=-200 → chunk -13
    store.record(makeRecord({ position: { x: 100, y: 64, z: -200 } }));
    const chunk = store.getChunk(6, -13, DIM);
    expect(chunk).toHaveLength(1);
    expect(store.getChunk(0, 0, DIM)).toHaveLength(0);
  });

  it("bounded（超限驱逐最旧）", () => {
    const store = new ProvenanceStore({ maxRecords: 2 });
    store.record(makeRecord({ position: { x: 1, y: 64, z: 1 }, recordedAtMs: 1 }));
    // 直接造记录绕过 Date.now
    const r2 = makeRecord({ position: { x: 2, y: 64, z: 1 }, recordedAtMs: 2 });
    const r3 = makeRecord({ position: { x: 3, y: 64, z: 1 }, recordedAtMs: 3 });
    store.record(r2);
    store.record(r3); // 满了，驱逐 x=1（最旧）
    expect(store.size).toBe(2);
    expect(store.get({ x: 1, y: 64, z: 1 }, DIM)).toBeNull();
    expect(store.get({ x: 2, y: 64, z: 1 }, DIM)).not.toBeNull();
  });
});

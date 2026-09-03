// recon-ledger 测试：分级启发式、登出点聚类、账本幂等/持久化/候选区。
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ReconLedgerStore,
  clusterLogoutPoints,
  gradeMark,
} from "../src/recon-ledger.js";

const DIM = "minecraft:the_nether";

describe("gradeMark 分级启发式", () => {
  it("dressed + 远离出生点 → high", () => {
    expect(gradeMark({ distanceToSpawnBlocks: 3_000, distanceToHighwayBlocks: 500, nearbyCraftedCount: 6, isCoveredPortal: false })).toBe("high");
  });

  it("覆盖伪装门即使不算 dressed 计数也视为 dressed", () => {
    expect(gradeMark({ distanceToSpawnBlocks: 3_000, distanceToHighwayBlocks: null, nearbyCraftedCount: 0, isCoveredPortal: true })).toBe("high");
  });

  it("dressed 但离出生点近 → medium", () => {
    expect(gradeMark({ distanceToSpawnBlocks: 1_000, distanceToHighwayBlocks: null, nearbyCraftedCount: 5, isCoveredPortal: false })).toBe("medium");
  });

  it("裸门 + 出生点旁 + 高速边 → low（出生点垃圾门）", () => {
    expect(gradeMark({ distanceToSpawnBlocks: 300, distanceToHighwayBlocks: 30, nearbyCraftedCount: 0, isCoveredPortal: false })).toBe("low");
  });

  it("裸门 + 出生点旁（无高速数据）→ low", () => {
    expect(gradeMark({ distanceToSpawnBlocks: 300, distanceToHighwayBlocks: null, nearbyCraftedCount: 0, isCoveredPortal: false })).toBe("low");
  });

  it("裸门 + 远离出生点 → medium", () => {
    expect(gradeMark({ distanceToSpawnBlocks: 1_500, distanceToHighwayBlocks: null, nearbyCraftedCount: 0, isCoveredPortal: false })).toBe("medium");
  });
});

describe("clusterLogoutPoints（S1 登出点聚类）", () => {
  const UUID = "11111111-2222-3333-4444-555555555555";

  it("同 UUID 三次近点登出 → 成簇（≥minSamples）", () => {
    const clusters = clusterLogoutPoints([
      { playerUuid: UUID, position: { x: 100, y: 64, z: 100 }, observedAtMs: 1 },
      { playerUuid: UUID, position: { x: 105, y: 64, z: 98 }, observedAtMs: 2 },
      { playerUuid: UUID, position: { x: 103, y: 66, z: 104 }, observedAtMs: 3 },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.sampleCount).toBe(3);
    expect(clusters[0]!.playerUuid).toBe(UUID);
    expect(clusters[0]!.centroid.x).toBeGreaterThanOrEqual(100);
    expect(clusters[0]!.centroid.x).toBeLessThanOrEqual(105);
  });

  it("两次登出不成簇（minSamples=3）", () => {
    const clusters = clusterLogoutPoints([
      { playerUuid: UUID, position: { x: 0, y: 64, z: 0 }, observedAtMs: 1 },
      { playerUuid: UUID, position: { x: 1, y: 64, z: 0 }, observedAtMs: 2 },
    ]);
    expect(clusters).toHaveLength(0);
  });

  it("不同 UUID 不互相污染", () => {
    const clusters = clusterLogoutPoints([
      { playerUuid: UUID, position: { x: 0, y: 64, z: 0 }, observedAtMs: 1 },
      { playerUuid: UUID, position: { x: 1, y: 64, z: 0 }, observedAtMs: 2 },
      { playerUuid: UUID, position: { x: 2, y: 64, z: 0 }, observedAtMs: 3 },
      { playerUuid: "other", position: { x: 5_000, y: 64, z: 5_000 }, observedAtMs: 4 },
    ]);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.playerUuid).toBe(UUID);
  });

  it("确定性：同样本不同输入顺序 → 同输出", () => {
    const samples = [
      { playerUuid: UUID, position: { x: 10, y: 64, z: 10 }, observedAtMs: 1 },
      { playerUuid: UUID, position: { x: 12, y: 64, z: 8 }, observedAtMs: 2 },
      { playerUuid: UUID, position: { x: 11, y: 64, z: 9 }, observedAtMs: 3 },
    ];
    const a = JSON.stringify(clusterLogoutPoints(samples));
    const b = JSON.stringify(clusterLogoutPoints([...samples].reverse()));
    expect(a).toBe(b);
  });
});

describe("ReconLedgerStore", () => {
  function tempDir(): string {
    return mkdtempSync(path.join(tmpdir(), "recon-ledger-"));
  }

  const baseEntry = {
    serverProfileId: "sp-1",
    dimension: DIM,
    position: { x: 100, y: 70, z: -200 },
    type: "nether_portal" as const,
    grade: "medium" as const,
  };

  it("同 key 幂等：计数递增、grade 只升不降、evidence 合并", () => {
    const store = new ReconLedgerStore({ now: () => 1_000 });
    const first = store.record({ ...baseEntry, evidence: { covered: true } });
    expect(first.observationCount).toBe(1);
    const again = store.record({ ...baseEntry, grade: "high", evidence: { observedVia: "corridor-run-1" } });
    expect(again.markId).toBe(first.markId);
    expect(again.observationCount).toBe(2);
    expect(again.grade).toBe("high");
    expect(again.evidence).toEqual({ covered: true, observedVia: "corridor-run-1" });
    // 降级尝试不生效
    const downgraded = store.record({ ...baseEntry, grade: "low" });
    expect(downgraded.grade).toBe("high");
    expect(store.size).toBe(1);
  });

  it("持久化往返 + corrupt 隔离", () => {
    const dir = tempDir();
    try {
      const persistPath = path.join(dir, "ledger.json");
      const store = new ReconLedgerStore({ persistPath, now: () => 2_000 });
      store.record(baseEntry);
      expect(existsSync(persistPath)).toBe(true);

      const restored = new ReconLedgerStore({ persistPath, now: () => 3_000 });
      expect(restored.size).toBe(1);
      const mark = restored.byGrade("medium");
      expect(mark).toHaveLength(1);
      expect(mark[0]!.position).toEqual(baseEntry.position);

      // corrupt → 隔离 .corrupt-*，空账本继续
      writeFileSync(persistPath, "{ not json", "utf8");
      const afterCorrupt = new ReconLedgerStore({ persistPath, now: () => 4_000 });
      expect(afterCorrupt.size).toBe(0);
      const quarantined = readdirSync(dir).filter((f) => f.startsWith("ledger.json.corrupt-"));
      expect(quarantined.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bounded：超上限驱逐最旧观测", () => {
    let clock = 1_000;
    const store = new ReconLedgerStore({ maxMarks: 2, now: () => clock });
    store.record({ ...baseEntry, position: { x: 1, y: 70, z: 1 } });
    clock += 1;
    store.record({ ...baseEntry, position: { x: 2, y: 70, z: 2 } });
    clock += 1;
    store.record({ ...baseEntry, position: { x: 3, y: 70, z: 3 } });
    expect(store.size).toBe(2);
    // 最旧（x=1）被驱逐：medium 查询不应再包含它
    const remaining = [...store.byGrade("medium")];
    expect(remaining.some((m) => m.position.x === 1)).toBe(false);
  });

  it("overworldCandidateFor：仅下界门标记给候选区（nether-coords 单源）", () => {
    const store = new ReconLedgerStore({ now: () => 1_000 });
    const portal = store.record(baseEntry);
    const region = store.overworldCandidateFor(portal.markId);
    expect(region).not.toBeNull();
    expect(region!.centerX).toBe(800);
    expect(region!.centerZ).toBe(-1_600);
    const stash = store.record({
      ...baseEntry,
      position: { x: 10, y: 70, z: 10 },
      type: "stash_container",
    });
    expect(store.overworldCandidateFor(stash.markId)).toBeNull();
  });
});

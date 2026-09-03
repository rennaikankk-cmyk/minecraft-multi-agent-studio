// chunk-census 测试：穿墙命中、预算三闸、列清单派生、汇总。
import { describe, expect, it } from "vitest";
import {
  columnsForCorridor,
  columnsForRegion,
  scanColumnsBatch,
  summarizeCensus,
  type CensusColumnProvider,
  type CensusQuery,
} from "../src/chunk-census.js";

const DIM = "minecraft:the_nether";

/** 假 provider：以 Map 存稀疏方块。未记录位置返回 null（=未观测，不是空气）。 */
class FakeProvider implements CensusColumnProvider {
  private readonly blocks = new Map<string, string>();
  public readCalls = 0;

  set(x: number, y: number, z: number, blockName: string): void {
    this.blocks.set(`${x},${y},${z}`, blockName);
  }

  loadedColumns(): { cx: number; cz: number }[] {
    const seen = new Set<string>();
    const columns: { cx: number; cz: number }[] = [];
    for (const key of this.blocks.keys()) {
      const [x, , z] = key.split(",").map(Number);
      const cx = Math.floor(x! / 16);
      const cz = Math.floor(z! / 16);
      const ck = `${cx},${cz}`;
      if (!seen.has(ck)) {
        seen.add(ck);
        columns.push({ cx, cz });
      }
    }
    return columns;
  }

  getBlock(_dimension: string, cx: number, cz: number, localX: number, y: number, localZ: number): string | null {
    this.readCalls += 1;
    return this.blocks.get(`${cx * 16 + localX},${y},${cz * 16 + localZ}`) ?? null;
  }
}

const QUERY: CensusQuery = {
  dimension: DIM,
  blockNames: ["nether_portal"],
  minY: 0,
  maxY: 127,
};

describe("scanColumnsBatch 命中", () => {
  it("被实心方块包围的伪装门照样命中（chunk 数据非视线）", () => {
    const provider = new FakeProvider();
    // 门体 (10..11, 70, 10)，四周封死（伪装覆盖）
    provider.set(10, 70, 10, "nether_portal");
    provider.set(11, 70, 10, "nether_portal");
    provider.set(9, 70, 10, "netherrack");
    provider.set(12, 70, 10, "netherrack");
    provider.set(10, 69, 10, "netherrack");
    provider.set(10, 71, 10, "netherrack");
    provider.set(10, 70, 9, "netherrack");
    provider.set(10, 70, 11, "netherrack");

    const result = scanColumnsBatch(provider, QUERY, [{ cx: 0, cz: 0 }]);
    expect(result.done).toBe(true);
    expect(result.hits).toHaveLength(2);
    expect(result.hits.map((h) => `${h.x},${h.y},${h.z}`).sort()).toEqual(["10,70,10", "11,70,10"]);
  });

  it("未观测方块不产生命中", () => {
    const provider = new FakeProvider();
    const result = scanColumnsBatch(provider, QUERY, [{ cx: 5, cz: -3 }]);
    expect(result.hits).toHaveLength(0);
    expect(result.done).toBe(true);
  });
});

describe("预算三闸", () => {
  function providerWithNPortals(n: number): FakeProvider {
    const provider = new FakeProvider();
    for (let i = 0; i < n; i += 1) provider.set(i * 20, 70, 0, "nether_portal");
    return provider;
  }

  it("列数闸：maxColumns=1 → 中断；循环续扫（调用方分帧模式）直到全量", () => {
    const provider = providerWithNPortals(4);
    const columns = columnsForRegion(0, -8, 80, 8);
    const totalHits: number[] = [];
    let pending = columns;
    let totalScanned = 0;
    let guard = 0;
    while (pending.length > 0 && guard < 100) {
      const batch = scanColumnsBatch(provider, QUERY, pending, { maxColumns: 1 });
      totalHits.push(...batch.hits.map((h) => h.x));
      totalScanned += batch.scannedColumns;
      pending = [...batch.pendingColumns];
      guard += 1;
    }
    expect(guard).toBeLessThan(100); // 分帧确实在推进，不是死循环
    expect(totalScanned).toBe(columns.length);
    expect(new Set(totalHits).size).toBe(4); // 4 个门全命中，无重复计数
  });

  it("方块数闸：maxBlocks 极小 → y 层粒度中断（列内不超支）", () => {
    const provider = providerWithNPortals(2);
    const result = scanColumnsBatch(provider, QUERY, [{ cx: 0, cz: 0 }], { maxBlocks: 10 });
    expect(result.done).toBe(false);
    expect(result.stoppedBy).toBe("blocks");
    // 被打断的列完整保留在 pending（下次重扫，只读幂等）
    expect(result.pendingColumns).toEqual([{ cx: 0, cz: 0 }]);
    expect(result.scannedColumns).toBe(0);
  });

  it("截止时刻闸：到点立即收工（注入时钟确定性验证）", () => {
    const provider = providerWithNPortals(2);
    let clock = 0;
    const result = scanColumnsBatch(provider, QUERY, [{ cx: 0, cz: 0 }, { cx: 1, cz: 0 }], {
      maxColumns: 10,
      deadlineMonotonicMs: 0,
      nowMonotonicMs: () => clock,
    });
    expect(result.done).toBe(false);
    expect(result.stoppedBy).toBe("deadline");
    clock = 100; // 时间恢复后可续扫
    const resumed = scanColumnsBatch(provider, QUERY, result.pendingColumns, { nowMonotonicMs: () => clock });
    expect(resumed.done).toBe(true);
  });
});

describe("列清单派生", () => {
  it("columnsForRegion 负坐标 floor 语义（-1 落 -1 列）", () => {
    const columns = columnsForRegion(-1, 0, 0, 15);
    expect(columns).toEqual([{ cx: -1, cz: 0 }, { cx: 0, cz: 0 }]);
  });

  it("columnsForCorridor 沿 +x 的矩形投影（两端各外扩 halfWidth 的保守覆盖）", () => {
    const columns = columnsForCorridor({ x: 0, z: 0 }, "+x", 32, 16);
    // x: (0..32)±16 → -16..48 → cx -1..3（5）；z: ±16 → cz -1..1（3）→ 15 列
    expect(columns.length).toBe(15);
    expect(columns).toContainEqual({ cx: 2, cz: 1 });
    expect(columns).toContainEqual({ cx: 0, cz: -1 });
  });

  it("columnsForCorridor 沿 -z", () => {
    const columns = columnsForCorridor({ x: 100, z: 0 }, "-z", 40, 0);
    expect(columns.length).toBe(4); // cz 0..-3（40 格 → 3 列边界 + 起点）
  });
});

describe("summarizeCensus", () => {
  it("按方块名计数（dressedness 原料）", () => {
    const counts = summarizeCensus([
      { x: 0, y: 0, z: 0, blockName: "torch" },
      { x: 1, y: 0, z: 0, blockName: "torch" },
      { x: 2, y: 0, z: 0, blockName: "rail" },
    ]);
    expect(counts.get("torch")).toBe(2);
    expect(counts.get("rail")).toBe(1);
  });
});

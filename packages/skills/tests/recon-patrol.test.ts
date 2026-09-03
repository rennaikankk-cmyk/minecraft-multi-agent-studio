// recon-patrol 测试：网格分配确定性、环序外扩、staleness 重扫、全新鲜→null。
import { describe, expect, it } from "vitest";
import {
  nextPatrolCorridor,
  patrolCellKey,
  recordCorridorScanned,
} from "../src/recon-patrol.js";

const ANCHOR = { anchorX: 0, anchorZ: 0 };
const NOW = 1_000_000;

describe("nextPatrolCorridor", () => {
  it("空账本 → 锚点格（环 0）优先", () => {
    const corridor = nextPatrolCorridor(new Map(), ANCHOR, NOW)!;
    expect(corridor).not.toBeNull();
    expect(corridor.cell).toEqual({ gx: 0, gz: 0 });
    expect(corridor.originX).toBe(0);
    expect(corridor.goalText).toBe("roof 扫描走廊：起点 x=0 y=128 z=0，沿 +x 扫 128 格");
  });

  it("环 0 已扫 → 环 1 字典序第一格（gx=-1 起按序）", () => {
    const state = new Map<string, number>();
    recordCorridorScanned(state, { gx: 0, gz: 0 }, NOW);
    const corridor = nextPatrolCorridor(state, ANCHOR, NOW)!;
    expect(corridor.cell.gx).toBe(-1);
    expect(corridor.cell.gz).toBe(-1);
  });

  it("staleness 过期 → 旧格重扫（7 天窗口）", () => {
    const state = new Map<string, number>();
    const scannedAt = NOW - 8 * 24 * 60 * 60 * 1000; // 8 天前
    recordCorridorScanned(state, { gx: 0, gz: 0 }, scannedAt);
    const corridor = nextPatrolCorridor(state, ANCHOR, NOW)!;
    expect(corridor.cell).toEqual({ gx: 0, gz: 0 }); // 过期重扫
  });

  it("全部新鲜 → null（不硬造工作）", () => {
    const state = new Map<string, number>();
    recordCorridorScanned(state, { gx: 0, gz: 0 }, NOW);
    const corridor = nextPatrolCorridor(state, { ...ANCHOR, maxRing: 0 }, NOW);
    expect(corridor).toBeNull();
  });

  it("确定性：同状态两次调用同输出；负锚点 floor 语义", () => {
    const opts = { anchorX: -10, anchorZ: 300 };
    const a = nextPatrolCorridor(new Map(), opts, NOW);
    const b = nextPatrolCorridor(new Map(), opts, NOW);
    expect(a).toEqual(b);
    // -10/128 → floor -1；300/128 → 2
    expect(patrolCellKey(a!.cell)).toBe("-1,2");
  });
});

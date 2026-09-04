// P5-D1 提取器测试：真实 prismarine-chunk 1.40 fixture（1.21.11/774）。
// 覆盖：正负 Y/边界 Y/local index 映射、Empty vs NotPresent 契约、
// Uint32Array 全量 stateId、分片预算让出、会话 update/unload/reset/
// 溢出、重放幂等。
import { describe, expect, it } from "vitest";
import {
  ChunkExtractionSession,
  extractColumnBudgeted,
  extractColumnSync,
  replayUpdates,
} from "../src/world-section-extractor.js";

// 真实 ChunkColumn（非 mock）——与 bot-runtime 相同的 prismarine-chunk 1.40
// + minecraft-data 1.21.11（协议 774）。
function makeRealColumn(): {
  column: {
    sections: Array<{ get(index: number): number } | null | undefined>;
    minY: number;
    numSections: number;
  };
  raw: {
    setBlockStateId(pos: { x: number; y: number; z: number }, id: number): void;
    getBlockStateId(pos: { x: number; y: number; z: number }): number;
  };
} {
  // createRequire（vitest 走 ESM；prismarine-chunk 是 CJS）
  const { createRequire } = require("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const pcPath = require.resolve("prismarine-chunk", { paths: [process.cwd()] });
  const pc = nodeRequire(pcPath);
  const mdPath = require.resolve("minecraft-data", { paths: [process.cwd()] });
  const md = nodeRequire(mdPath);
  const mcData = md("1.21.11");
  const Column = pc(mcData, 774);
  const raw = new Column();
  return {
    column: raw as never,
    raw: raw as never,
  };
}

describe("P5-D1 world-section-extractor", () => {
  it("real fixture: constructor sanity (numSections=24, minY=-64)", () => {
    const { column } = makeRealColumn();
    expect(column.numSections).toBe(24);
    expect(column.minY).toBe(-64);
  });

  it("positive Y local index mapping roundtrips through real ChunkColumn", () => {
    const { column, raw } = makeRealColumn();
    raw.setBlockStateId({ x: 3, y: 70, z: 5 }, 12345);
    raw.setBlockStateId({ x: 15, y: 79, z: 15 }, 999);
    const session = new ChunkExtractionSession();
    const extracted = extractColumnSync(column, 0, 0, session);
    // y=70 → sectionY = 70>>4 = 4（绝对）——注意这里用绝对 y>>4（world 高度
    // 的数学分区），而 ChunkColumn 内部用 (y-minY)>>4。提取器输出用绝对
    // sectionY 与 WorldMirror SectionKey 对齐。
    const section4 = extracted.sections.find((s) => s.sectionY === 4);
    expect(section4).toBeDefined();
    expect(section4!.status).toBe("data");
    // local index = ((y&15)<<8)|((z&15)<<4)|(x&15)
    expect(section4!.stateIds![((70 & 15) << 8) | ((5 & 15) << 4) | 3]).toBe(12345);
    expect(section4!.stateIds![((79 & 15) << 8) | ((15 & 15) << 4) | 15]).toBe(999);
  });

  it("negative Y and boundary Y map correctly", () => {
    const { column, raw } = makeRealColumn();
    raw.setBlockStateId({ x: 0, y: -64, z: 0 }, 111); // 最低
    raw.setBlockStateId({ x: 1, y: -1, z: 1 }, 222); // 负段末
    raw.setBlockStateId({ x: 2, y: 0, z: 2 }, 333); // 正负交界
    raw.setBlockStateId({ x: 3, y: 319, z: 3 }, 444); // 最高
    const extracted = extractColumnSync(column, 0, 0, new ChunkExtractionSession());
    const secM4 = extracted.sections.find((s) => s.sectionY === -4)!;
    const secM1 = extracted.sections.find((s) => s.sectionY === -1)!;
    const sec0 = extracted.sections.find((s) => s.sectionY === 0)!;
    const sec19 = extracted.sections.find((s) => s.sectionY === 19)!;
    expect(secM4.stateIds![((-64 & 15) << 8) | 0]).toBe(111);
    expect(secM1.stateIds![((-1 & 15) << 8) | ((1 & 15) << 4) | 1]).toBe(222);
    expect(sec0.stateIds![((0 & 15) << 8) | ((2 & 15) << 4) | 2]).toBe(333);
    expect(sec19.stateIds![((319 & 15) << 8) | ((3 & 15) << 4) | 3]).toBe(444);
  });

  it("Empty vs NotPresent contract: untouched=all-zero sections report empty, nulled slot reports not-present", () => {
    const { column, raw } = makeRealColumn();
    // 全新鲜 column：所有 section 全 0 → empty（显式空，非缺席）
    const extracted = extractColumnSync(column, 0, 0, new ChunkExtractionSession());
    expect(extracted.sections.every((s) => s.status === "empty")).toBe(true);
    // 置空一个槽位 → not-present
    (raw as never as { sections: unknown[] }).sections[5] = null;
    const extracted2 = extractColumnSync(column, 0, 0, new ChunkExtractionSession());
    const sec = extracted2.sections.find((s) => s.sectionY === -4 + 5);
    expect(sec!.status).toBe("not-present");
    expect(sec!.stateIds).toBeNull();
  });

  it("Uint32Array preserves full stateId (no premature u16 compression)", () => {
    const { column, raw } = makeRealColumn();
    const bigId = 2000000000; // 远超 u16
    raw.setBlockStateId({ x: 0, y: 0, z: 0 }, bigId);
    const extracted = extractColumnSync(column, 0, 0, new ChunkExtractionSession());
    const sec = extracted.sections.find((s) => s.sectionY === 0)!;
    expect(sec.stateIds!.byteLength).toBe(4096 * 4);
    expect(sec.stateIds![0]).toBe(bigId);
  });

  it("budgeted extraction yields between sections when budget exceeded", async () => {
    const { column } = makeRealColumn();
    let yields = 0;
    const yieldFn = async () => { yields += 1; };
    // 预算 0ms：每 section 后都让出
    const extracted = await extractColumnBudgeted(column, 0, 0, new ChunkExtractionSession(), 0, yieldFn);
    expect(extracted.sections.length).toBe(24);
    expect(yields).toBeGreaterThanOrEqual(23); // 24 section - 首个
  });

  it("session: update during extraction is captured and replayed idempotently after commit", () => {
    const { column, raw } = makeRealColumn();
    raw.setBlockStateId({ x: 5, y: 10, z: 5 }, 100);
    const session = new ChunkExtractionSession();
    // BEGIN 后世界变化
    session.recordBlockUpdate(5, 10, 5, 200, 1);
    session.recordBlockUpdate(5, 10, 5, 300, 2); // 同坐标合并=最终值
    const extracted = extractColumnSync(column, 0, 0, session);
    extracted.pendingUpdates = session.drainUpdates();
    expect(extracted.pendingUpdates.length).toBe(1);
    expect(extracted.pendingUpdates[0]!.stateId).toBe(300); // 最高 sequence 的最终值
    const { applied } = replayUpdates(extracted, column.minY);
    expect(applied).toBe(1);
    const sec = extracted.sections.find((s) => s.sectionY === 0)!;
    expect(sec.stateIds![((10 & 15) << 8) | ((5 & 15) << 4) | 5]).toBe(300);
    // 幂等：重放同一最终值无副作用
    extracted.pendingUpdates = [{ x: 5, y: 10, z: 5, stateId: 300, sequence: 2 }];
    replayUpdates(extracted, column.minY);
    expect(sec.stateIds![((10 & 15) << 8) | ((5 & 15) << 4) | 5]).toBe(300);
  });

  it("session: unload/reset cancel immediately; queue overflow marks overflow", () => {
    const session = new ChunkExtractionSession();
    session.recordBlockUpdate(0, 0, 0, 1, 1);
    session.cancel("unload"); // cancel 同时清空累积
    expect(session.isCancelled).toBe(true);
    expect(session.cancelReasonOrNull).toBe("unload");
    // 取消后 update 静默
    expect(session.recordBlockUpdate(1, 1, 1, 2, 2)).toBe("recorded");
    expect(session.drainUpdates().length).toBe(0);

    const overflow = new ChunkExtractionSession(2);
    overflow.recordBlockUpdate(0, 0, 0, 1, 1);
    overflow.recordBlockUpdate(1, 1, 1, 1, 2);
    expect(overflow.recordBlockUpdate(2, 2, 2, 1, 3)).toBe("overflow");
    expect(overflow.cancelReasonOrNull).toBe("queue-overflow");
  });

  it("budgeted extraction aborts when session cancelled mid-flight", async () => {
    const { column } = makeRealColumn();
    const session = new ChunkExtractionSession();
    const yieldFn = async () => { session.cancel("reset"); };
    await expect(
      extractColumnBudgeted(column, 0, 0, session, 0, yieldFn),
    ).rejects.toThrow("extraction cancelled: reset");
  });
});

// P5-D2d 压力/预算/故障测试。
// §17：section 内部每 256 格预算检查（真实昂贵 get 下必须 section 内部
// 让出）；超支可观测（sliceOverruns/maxSliceMs）；abort 在 section 内部
// 生效；单个 data.get 异常不卡死队列。
// §24/§25：多 chunk burst 期间事件循环保持响应（monitorEventLoopDelay
// P99/MAX 门）；block update 突发与导入交错；queue/in-flight 有界；
// dropped updates=0；stop 时在途消息有界收敛。
import { describe, expect, it, afterEach } from "vitest";
import { monitorEventLoopDelay } from "node:perf_hooks";
import {
  ChunkExtractionSession,
  extractColumnBudgeted,
} from "../src/world-section-extractor.js";
import {
  buildRegistryTable,
  registryTableFingerprint,
  WorldSyncAdapter,
  type RegistryTable,
} from "../src/world-sync-adapter.js";
import { mirrorTransport, terminatePathfinderWorker } from "../src/rust-pathfinder.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 10_000, stepMs = 10): Promise<void> {
  const began = Date.now();
  while (!predicate()) {
    if (Date.now() - began > timeoutMs) throw new Error(`waitFor timeout (state predicate)`);
    await sleep(stepMs);
  }
}

/** 昂贵 section：get 内部自旋（每次 ~50µs 级）——256 格一批稳定超 3ms 预算。 */
function expensiveSection(spin = 60_000): { data: { get(index: number): number } } {
  return {
    data: {
      get(index: number): number {
        let x = index & 1;
        for (let i = 0; i < spin; i += 1) x = (x + i) & 1;
        return x;
      },
    },
  };
}

function smallTable(): RegistryTable {
  return buildRegistryTable(
    [
      { name: "air", minStateId: 0, maxStateId: 0, boundingBox: "empty" },
      { name: "stone", minStateId: 1, maxStateId: 1, boundingBox: "full" },
    ],
    { revision: 1, minecraftVersion: "1.21.11", serverProfileId: "stress-test" },
  );
}

function makeRealColumn(): {
  sections: Array<{ data: { get(index: number): number } } | null | undefined>;
  minY: number;
  numSections: number;
} {
  const { createRequire } = require("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const pcPath = require.resolve("prismarine-chunk", { paths: [process.cwd()] });
  const pc = nodeRequire(pcPath);
  const mdPath = require.resolve("minecraft-data", { paths: [process.cwd()] });
  const md = nodeRequire(mdPath);
  const Column = pc(md("1.21.11"), 774);
  return new Column() as never;
}

afterEach(async () => {
  await terminatePathfinderWorker().catch(() => undefined);
});

describe("P5-D2d section 内部预算（提取器）", () => {
  it("昂贵 section：预算检查发生在 section 内部（单 section 内多次让出）+ overrun 计数", async () => {
    let yields = 0;
    const yieldFn = async () => {
      yields += 1;
      await Promise.resolve();
    };
    const column = { sections: [expensiveSection()], minY: 0, numSections: 1 };
    const result = await extractColumnBudgeted(column, 0, 0, new ChunkExtractionSession(), 3, yieldFn);
    // 单 section 列：任何让出都发生在 section **内部**（无 section 间让出）。
    expect(yields).toBeGreaterThanOrEqual(3);
    expect(result.sliceOverruns).toBeGreaterThan(0);
    expect(result.maxSliceMs).toBeGreaterThan(3);
    expect(result.sections[0]?.status).toBe("data");
  }, 30_000);

  it("abort/unload 在 section 内部生效（昂贵提取中途取消即抛出）", async () => {
    const session = new ChunkExtractionSession();
    let yields = 0;
    const yieldFn = async () => {
      yields += 1;
      if (yields === 1) session.cancel("unload"); // 第一个内部让出点到达时卸载
      await Promise.resolve();
    };
    const column = { sections: [expensiveSection()], minY: 0, numSections: 1 };
    await expect(
      extractColumnBudgeted(column, 0, 0, session, 3, yieldFn),
    ).rejects.toThrow(/cancelled: unload/);
  }, 30_000);

  it("单个 data.get 异常不卡死：带 sectionY 上下文抛出（调用方可清理）", async () => {
    const column = {
      sections: [
        {
          data: {
            get(index: number): number {
              if (index === 500) throw new Error("boom");
              return 0;
            },
          },
        },
      ],
      minY: 0,
      numSections: 1,
    };
    await expect(
      extractColumnBudgeted(column, 0, 0, new ChunkExtractionSession(), 3, async () => undefined),
    ).rejects.toThrow(/section 0 extraction failed: boom/);
  });

  it("廉价 section 突发不产生 overrun（零对象分配路径确实低于预算）", async () => {
    const column = makeRealColumn();
    const result = await extractColumnBudgeted(column, 0, 0, new ChunkExtractionSession(), 3);
    // 真实空列（全默认 section）在预算内完成；结构完整。
    expect(result.sections).toHaveLength(24);
    expect(result.sliceOverruns).toBe(0);
    expect(result.extractMs).toBeLessThan(50);
  });
});

describe("P5-D2d burst/背压/stop（真实 worker）", () => {
  it("多 chunk 连续载入 burst：事件循环保持响应，queue/in-flight 有界，dropped=0", async () => {
    const table = smallTable();
    const spans: Array<{ name: string; ms: number }> = [];
    const adapter = new WorldSyncAdapter({
      transport: mirrorTransport(),
      registryTable: table,
      sessionEpoch: Math.floor(Date.now() / 1000),
      dimensionEpoch: 1,
      span: (name, ms) => spans.push({ name, ms }),
    });
    await adapter.start();

    const histogram = monitorEventLoopDelay({ resolution: 1 });
    histogram.enable();
    const burstSize = 12;
    for (let i = 0; i < burstSize; i += 1) {
      adapter.onChunkColumnLoad(makeRealColumn(), i, 0);
      // burst 期间穿插 update 突发（与导入交错）。
      for (let u = 0; u < 5; u += 1) {
        adapter.onBlockUpdate((i * 16) + u, 1, 3, u % 2);
      }
    }
    await adapter.flushUpdates();
    await waitFor(
      () => adapter.getMetrics().queueDepth === 0 && adapter.getMetrics().inFlightMessages === 0,
      30_000,
    );
    histogram.disable();

    const metrics = adapter.getMetrics();
    const p50 = histogram.percentile(50) / 1e6;
    const p99 = histogram.percentile(99) / 1e6;
    const max = histogram.max / 1e6;
    // 证据输出（§30-13/14：性能数字必须报告实际分布）。
    console.log(
      `[world-sync-stress] burst=${burstSize} eventLoopMs p50=${p50.toFixed(2)} p99=${p99.toFixed(2)} max=${max.toFixed(2)} ` +
        `sent=${metrics.sent} acked=${metrics.acked} queueMax=${metrics.queueDepthMax} ` +
        `inFlightBytesMax=${metrics.inFlightBytesMax} ackP99=${metrics.ackRttP95Ms ?? -1}ms`,
    );
    // 完成门（§25）：同步协议自身不制造新主线程尖峰——噪声容忍阈值。
    expect(p99).toBeLessThan(50);
    expect(max).toBeLessThan(200);
    expect(metrics.inFlightMessages).toBeLessThanOrEqual(16);
    expect(metrics.droppedUpdates).toBe(0);
    expect(metrics.queueDepthMax).toBeLessThanOrEqual(2048);
    const health = await adapter.health();
    expect(health?.loadedChunks).toBe(burstSize);
    expect(health?.desynced).toBe(false);
    expect(health?.skippedUpdatesTotal).toBe(0);
    // span 观测面存在（enqueue/postMessage/ack/extract）。
    const names = new Set(spans.map((s) => s.name));
    for (const expected of [
      "world_sync.enqueue",
      "world_sync.post_message",
      "world_sync.ack_rtt",
      "world_sync.extract_column",
    ]) {
      expect(names.has(expected), `span ${expected}`).toBe(true);
    }
    await adapter.stop();
  }, 60_000);

  it("真实 worker：burst 后 stop 干净退出（在途=0、队列=0、worker 可再拉起）", async () => {
    const table = smallTable();
    const adapter = new WorldSyncAdapter({
      transport: mirrorTransport(),
      registryTable: table,
      sessionEpoch: 501,
      dimensionEpoch: 1,
    });
    await adapter.start();
    adapter.onBlockUpdate(1, 1, 1, 1);
    await adapter.flushUpdates();
    await waitFor(() => adapter.getMetrics().inFlightMessages === 0, 5000);
    await adapter.stop();
    expect(adapter.currentState).toBe("stopped");
    const metrics = adapter.getMetrics();
    expect(metrics.inFlightMessages).toBe(0);
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.droppedUpdates).toBe(0);
    // stop 后 worker 可为下一次会话重新拉起（进程级无悬挂）。
    const adapter2 = new WorldSyncAdapter({
      transport: mirrorTransport(),
      registryTable: table,
      sessionEpoch: 502,
      dimensionEpoch: 1,
    });
    await adapter2.start();
    expect(adapter2.currentState).toBe("ready");
    await adapter2.stop();
  });
});

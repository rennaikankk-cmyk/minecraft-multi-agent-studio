// P5-D2c WorldSyncAdapter 测试。
// 单元（FakeTransport）：唯一 sender、source/transport 双序号分离、registry
// 先行、合并、背压（in-flight 消息数/字节）、overflow→desync→reset→rebuild、
// ACK 超时有界恢复、transport 失败、stop 清理。
// 契约（真实 worker + 真实 prismarine-chunk 1.40/1.21.11 fixture）：
// registry fingerprint 跨语言一致（TS BigInt FNV-1a64 == Rust u64）、
// 真实列导入→health→update→dispose、transfer 后主线程 buffer detached、
// worker terminate→fail-close 不悬挂。
import { describe, expect, it, afterEach } from "vitest";
import type { MirrorAck, MirrorEnvelopeWire, MirrorHealth, MirrorControlWire } from "@minecraft-studio/pathfinder-rs";
import {
  buildRegistryTable,
  buildSectionPayload,
  registryTableFingerprint,
  WorldSyncAdapter,
  type MirrorTransport,
  type RegistryTable,
} from "../src/world-sync-adapter.js";
import { mirrorTransport, terminatePathfinderWorker } from "../src/rust-pathfinder.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 5000, stepMs = 10): Promise<void> {
  const began = Date.now();
  while (!predicate()) {
    if (Date.now() - began > timeoutMs) throw new Error("waitFor timeout");
    await sleep(stepMs);
  }
}

/** 测试表：小而确定（4 stateId）。 */
function smallTable(): RegistryTable {
  return buildRegistryTable(
    [
      { name: "air", minStateId: 0, maxStateId: 0, boundingBox: "empty" },
      { name: "stone", minStateId: 1, maxStateId: 1, boundingBox: "full" },
      { name: "water", minStateId: 2, maxStateId: 2, boundingBox: "empty" },
      { name: "chest", minStateId: 3, maxStateId: 3, boundingBox: "full" },
    ],
    { revision: 1, minecraftVersion: "1.21.11", serverProfileId: "test-profile" },
  );
}

type Recorded = { envelope: MirrorEnvelopeWire; transferList?: ArrayBuffer[] };

class FakeTransport implements MirrorTransport {
  created = 0;
  disposed = 0;
  controls: MirrorControlWire[] = [];
  sent: Recorded[] = [];
  ackDelayMs = 0;
  failEnvelopes = false;
  healthOverride: MirrorHealth | null = null;
  concurrent = 0;
  maxConcurrent = 0;
  /** registry ack 的 fingerprint 回显（测试注入期望值）。 */
  registryFingerprint = "";

  async mirrorCreate(): Promise<number> {
    this.created += 1;
    return 777;
  }

  async mirrorSubmitEnvelope(
    _handle: number,
    envelope: MirrorEnvelopeWire,
    transferList?: ArrayBuffer[],
  ): Promise<MirrorAck> {
    this.sent.push({ envelope, transferList });
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      if (this.failEnvelopes) throw new Error("fake worker gone");
      if (this.ackDelayMs > 0) await sleep(this.ackDelayMs);
      return this.ackFor(envelope);
    } finally {
      this.concurrent -= 1;
    }
  }

  private ackFor(envelope: MirrorEnvelopeWire): MirrorAck {
    if (envelope.message.kind === "registryTable") {
      return {
        protocolVersion: 1,
        sessionEpoch: envelope.sessionEpoch,
        dimensionEpoch: envelope.dimensionEpoch,
        transportSequence: envelope.transportSequence,
        status: "registryReady",
        mirrorGeneration: 1,
        registryRevision: envelope.message.revision,
        chunkRevision: null,
        reason: null,
        payloadFingerprint: this.registryFingerprint,
        skippedUpdates: null,
      };
    }
    return {
      protocolVersion: 1,
      sessionEpoch: envelope.sessionEpoch,
      dimensionEpoch: envelope.dimensionEpoch,
      transportSequence: envelope.transportSequence,
      status: "applied",
      mirrorGeneration: 1,
      registryRevision: null,
      chunkRevision: null,
      reason: null,
      payloadFingerprint: null,
      skippedUpdates: 0,
    };
  }

  async mirrorSubmitControl(_handle: number, control: MirrorControlWire): Promise<MirrorAck> {
    this.controls.push(control);
    const status =
      control.kind === "worldReset" ? "resetApplied" : control.kind === "stop" ? "stopping" : "healthy";
    return {
      protocolVersion: 1,
      sessionEpoch: 0,
      dimensionEpoch: 0,
      transportSequence: 0,
      status,
      mirrorGeneration: 1,
      registryRevision: null,
      chunkRevision: null,
      reason: null,
      payloadFingerprint: null,
      skippedUpdates: null,
    };
  }

  async mirrorHealth(): Promise<MirrorHealth> {
    return (
      this.healthOverride ?? {
        desynced: false,
        stopped: false,
        loadedChunks: 1,
        pendingImports: 0,
        queuedUpdates: 0,
        registryReady: true,
        registryRevision: 1,
        lastTransportSequence: 0,
        replayWindowLen: 0,
        replayWindowFloor: null,
        mirrorGeneration: 1,
        skippedUpdatesTotal: 0,
      }
    );
  }

  async mirrorDispose(): Promise<boolean> {
    this.disposed += 1;
    return true;
  }

  kinds(): string[] {
    return this.sent.map((entry) => entry.envelope.message.kind);
  }
}

async function startWith(transport: FakeTransport, table = smallTable()): Promise<WorldSyncAdapter> {
  transport.registryFingerprint = registryTableFingerprint(table);
  const adapter = new WorldSyncAdapter({
    transport,
    registryTable: table,
    sessionEpoch: 100,
    dimensionEpoch: 1,
  });
  await adapter.start();
  return adapter;
}

afterEach(() => {
  delete process.env.STUDIO_WORLD_MIRROR_SYNC;
});

describe("P5-D2c WorldSyncAdapter（单元，FakeTransport）", () => {
  it("启动顺序：create → reset → registry 握手（fingerprint 核对）先于一切 chunk 流量", async () => {
    const transport = new FakeTransport();
    const adapter = await startWith(transport);
    // 唯一 sender：所有数据消息按传输序严格连续。
    expect(transport.created).toBe(1);
    expect(transport.controls[0]?.kind).toBe("worldReset");
    expect(transport.sent[0]?.envelope.message.kind).toBe("registryTable");
    expect(transport.sent[0]?.envelope.transportSequence).toBe(1);
    expect(adapter.currentState).toBe("ready");
    await adapter.stop();
    expect(transport.disposed).toBe(1);
  });

  it("registry fingerprint 不匹配 → 启动失败降级（不伪造 ready）", async () => {
    const transport = new FakeTransport();
    transport.registryFingerprint = "999"; // 错误回显
    const table = smallTable();
    const adapter = new WorldSyncAdapter({
      transport,
      registryTable: table,
      sessionEpoch: 100,
      dimensionEpoch: 1,
    });
    await expect(adapter.start()).rejects.toThrow(/fingerprint mismatch/);
    expect(adapter.currentState).toBe("degraded");
  });

  it("source/transport 双序号分离：101–103 合并后 transport 仍连续", async () => {
    const transport = new FakeTransport();
    const adapter = await startWith(transport);
    const before = transport.sent.length;
    // 三个源事件打同一坐标（source 1,2,3）→ 一条 batch 携带最终值。
    adapter.onBlockUpdate(1, 1, 1, 5);
    adapter.onBlockUpdate(1, 1, 1, 7);
    adapter.onBlockUpdate(1, 1, 1, 9);
    await adapter.flushUpdates();
    await waitFor(() => transport.sent.length >= before + 1);
    const batch = transport.sent[transport.sent.length - 1]?.envelope.message;
    expect(batch).toMatchObject({
      kind: "blockUpdateBatch",
      sourceFirstSequence: 1,
      sourceLastSequence: 3,
      sourceEventCount: 3,
      coalescedEventCount: 2,
    });
    if (batch?.kind === "blockUpdateBatch") {
      expect(batch.updatesFlat).toEqual([1, 1, 1, 9]); // 最终绝对 stateId
    }
    const seq = transport.sent[transport.sent.length - 1]?.envelope.transportSequence;
    expect(seq).toBe(before + 1); // transport 连续（source 空洞不影响）
    await adapter.stop();
  });

  it("unload 取消进行中的提取（BEGIN/DATA 不入队）且淘汰未发送的排队工作", async () => {
    const transport = new FakeTransport();
    const table = smallTable();
    transport.registryFingerprint = registryTableFingerprint(table);
    // 提取挂在受控 yieldFn 上（真实列、分片跨 tick）：unload 到达时取消。
    let releaseGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const adapter = new WorldSyncAdapter({
      transport,
      registryTable: table,
      sessionEpoch: 100,
      dimensionEpoch: 1,
      yieldFn: () => gate,
      limits: { extractBudgetMs: 0 }, // 第 2 个 section 必然让出（确定性挂起）
    });
    await adapter.start();
    // 128 个廉价 section：提取稳定超 3ms 预算 → 必然经 yieldFn 让出挂起。
    const bigColumn = {
      sections: Array.from({ length: 128 }, () => ({ data: { get: () => 1 } })),
      minY: 0,
      numSections: 128,
    };
    adapter.onChunkColumnLoad(bigColumn, 0, 0);
    adapter.onChunkColumnUnload(0, 0); // 提取挂起期间卸载
    releaseGate?.();
    await sleep(50);
    // 卸载先于提取完成：该 chunk 的 BEGIN/DATA/COMMIT 全部不得出现。
    const kinds = transport.kinds();
    expect(kinds).not.toContain("chunkBegin");
    expect(kinds).not.toContain("sectionData");
    expect(kinds.filter((kind) => kind === "chunkUnload")).toHaveLength(1);
    await adapter.stop();
  });

  it("背压：in-flight 消息数双限（不能只按条数）", async () => {
    const transport = new FakeTransport();
    transport.ackDelayMs = 40; // 慢 worker
    const table = smallTable();
    transport.registryFingerprint = registryTableFingerprint(table);
    const adapter = new WorldSyncAdapter({
      transport,
      registryTable: table,
      sessionEpoch: 100,
      dimensionEpoch: 1,
      limits: { maxInFlightMessages: 2, maxInFlightBytes: 64 * 1024 * 1024 },
    });
    await adapter.start();
    // 12 个廉价 chunk 事务（not-present 单 section）灌队列。
    for (let i = 0; i < 12; i += 1) {
      adapter.onChunkColumnLoad({ sections: [null], minY: 0, numSections: 1 }, i, 0);
    }
    await sleep(200);
    expect(transport.maxConcurrent).toBeLessThanOrEqual(2);
    const metrics = adapter.getMetrics();
    expect(metrics.inFlightMessages).toBeLessThanOrEqual(2);
    await adapter.stop();
  });

  it("ACK 超时：worker 健康时有界等待，不无限重试也不误杀", async () => {
    const transport = new FakeTransport();
    const table = smallTable();
    transport.registryFingerprint = registryTableFingerprint(table);
    const adapter = new WorldSyncAdapter({
      transport,
      registryTable: table,
      sessionEpoch: 100,
      dimensionEpoch: 1,
      limits: { ackTimeoutMs: 60 },
    });
    await adapter.start();
    transport.ackDelayMs = 300; // 超时阈值后 ACK 到达
    adapter.onBlockUpdate(1, 1, 1, 3);
    await adapter.flushUpdates();
    await sleep(600);
    // 慢而健康：batch 最终 applied（rtt ≥300ms 证明慢 ack 真到达）且未降级。
    const metrics = adapter.getMetrics();
    expect(metrics.applied).toBeGreaterThanOrEqual(1);
    expect(metrics.ackRttMaxMs ?? 0).toBeGreaterThanOrEqual(250);
    expect(adapter.currentState).not.toBe("degraded");
    expect(metrics.desyncs).toBe(0);
    transport.ackDelayMs = 0;
    await adapter.stop();
  });

  it("transport 失败 → desynced；恢复（reset+重握手）成功后 recovered", async () => {
    const incidents: string[] = [];
    const transport = new FakeTransport();
    const table = smallTable();
    transport.registryFingerprint = registryTableFingerprint(table);
    const adapter = new WorldSyncAdapter({
      transport,
      registryTable: table,
      sessionEpoch: 100,
      dimensionEpoch: 1,
      onIncident: (incident) => incidents.push(incident.kind),
    });
    await adapter.start();
    transport.failEnvelopes = true;
    adapter.onBlockUpdate(1, 1, 1, 3);
    await adapter.flushUpdates();
    await waitFor(() => adapter.currentState === "desynced" || adapter.currentState === "degraded");
    expect(incidents).toContain("worker_unavailable");
    // 恢复：worker 回来 → reset+握手 → recovered。
    transport.failEnvelopes = false;
    transport.sent.length = 0;
    adapter.reImportColumn({ sections: [null], minY: 0, numSections: 1 }, 0, 0);
    await waitFor(() => incidents.includes("recovered"), 3000);
    expect(adapter.currentState).not.toBe("desynced");
    await adapter.stop();
  });

  it("overflow→desynced→reset→rebuild（队列容量诚实失败）", async () => {
    const incidents: string[] = [];
    const transport = new FakeTransport();
    const table = smallTable();
    transport.registryFingerprint = registryTableFingerprint(table);
    const adapter = new WorldSyncAdapter({
      transport,
      registryTable: table,
      sessionEpoch: 100,
      dimensionEpoch: 1,
      limits: { queueCapacity: 2, maxInFlightMessages: 1 },
      onIncident: (incident) => incidents.push(incident.kind),
    });
    await adapter.start();
    transport.ackDelayMs = 500; // 泵卡住 → 队列积压
    for (let i = 0; i < 8; i += 1) {
      adapter.onBlockUpdate(i, 1, 0, 1);
      await adapter.flushUpdates();
    }
    await waitFor(() => incidents.includes("queue_overflow"), 4000);
    expect(adapter.getMetrics().desyncs).toBeGreaterThan(0);
    await adapter.stop();
  });

  it("stop 清理：无残留队列/in-flight，dispose 恰好一次，状态 STOPPED", async () => {
    const transport = new FakeTransport();
    const adapter = await startWith(transport);
    adapter.onBlockUpdate(1, 1, 1, 3);
    await adapter.flushUpdates();
    await adapter.stop();
    expect(adapter.currentState).toBe("stopped");
    const metrics = adapter.getMetrics();
    expect(metrics.queueDepth).toBe(0);
    expect(metrics.inFlightMessages).toBe(0);
    expect(transport.disposed).toBe(1);
    // stop 后再无流量。
    const sent = transport.sent.length;
    adapter.onBlockUpdate(2, 1, 1, 3);
    await adapter.flushUpdates();
    expect(transport.sent.length).toBe(sent);
    await adapter.stop(); // 幂等
  });

  it("buildSectionPayload：data 构建去重 palette，empty/notPresent 显式语义", () => {
    const table = smallTable();
    const data = buildSectionPayload(
      { sectionY: 4, status: "data", stateIds: new Uint32Array(4096).fill(1) },
      table,
      3,
      5,
    );
    expect(data.payloadKind).toBe("data");
    expect(data.paletteEntries).toEqual([table.masks[1]]);
    expect(data.paletteIndices?.byteLength).toBe(8192);
    const empty = buildSectionPayload({ sectionY: 5, status: "empty", stateIds: null }, table, 0, 0);
    expect(empty).toMatchObject({ payloadKind: "empty", fillStateId: 0 });
    const absent = buildSectionPayload({ sectionY: 6, status: "not-present", stateIds: null }, table, 0, 0);
    expect(absent).toMatchObject({ payloadKind: "notPresent" });
  });
});

// ---------------------------------------------------------------------------
// 真实 worker 契约（真实 pathfinder-rs worker + 真实 prismarine-chunk 1.40）。
// ---------------------------------------------------------------------------

function makeRealColumn(): {
  column: {
    sections: Array<{ data: { get(index: number): number } } | null | undefined>;
    minY: number;
    numSections: number;
  };
  raw: {
    setBlockStateId(pos: { x: number; y: number; z: number }, id: number): void;
  };
} {
  const { createRequire } = require("node:module");
  const nodeRequire = createRequire(import.meta.url);
  const pcPath = require.resolve("prismarine-chunk", { paths: [process.cwd()] });
  const pc = nodeRequire(pcPath);
  const mdPath = require.resolve("minecraft-data", { paths: [process.cwd()] });
  const md = nodeRequire(mdPath);
  const mcData = md("1.21.11");
  const Column = pc(mcData, 774);
  const raw = new Column();
  return { column: raw as never, raw: raw as never };
}

describe("P5-D2c WorldSyncAdapter（真实 worker 契约）", () => {
  afterEach(async () => {
    await terminatePathfinderWorker();
  });

  it("registry fingerprint 跨语言一致（TS BigInt FNV-1a64 == Rust u64）+ 全链路导入/更新/健康", async () => {
    const { createRequire } = require("node:module");
    const nodeRequire = createRequire(import.meta.url);
    const md = nodeRequire(require.resolve("minecraft-data", { paths: [process.cwd()] }));
    const mcData = md("1.21.11");
    // 真实全量表（~2.7 万 stateId）——fingerprint 是最硬的跨语言契约。
    const table = buildRegistryTable(mcData.blocksArray as never, {
      revision: 1,
      minecraftVersion: "1.21.11",
      serverProfileId: "contract-test",
    });
    expect(table.masks.length).toBeGreaterThan(10_000);

    const adapter = new WorldSyncAdapter({
      transport: mirrorTransport(),
      registryTable: table,
      sessionEpoch: Math.floor(Date.now() / 1000),
      dimensionEpoch: 1,
    });
    await adapter.start();
    // start() 已完成 registry 握手——fingerprint 不一致会在这里抛。
    expect(adapter.currentState).toBe("ready");

    const { column, raw } = makeRealColumn();
    raw.setBlockStateId({ x: 3, y: 70, z: 5 }, 1);
    adapter.onChunkColumnLoad(column, 0, 0);
    await waitFor(() => adapter.getMetrics().queuedExtractions === 0 && adapter.getMetrics().queueDepth === 0 && adapter.getMetrics().inFlightMessages === 0, 10_000);
    await sleep(50); // 泵收尾一拍（ready 翻沿）
    const health = await adapter.health();
    expect(health?.loadedChunks).toBe(1);
    expect(health?.registryReady).toBe(true);
    expect(health?.desynced).toBe(false);

    // 真实 update → 应用到镜像。
    adapter.onBlockUpdate(3, 70, 5, 2);
    await adapter.flushUpdates();
    await waitFor(() => adapter.getMetrics().inFlightMessages === 0, 5000);
    const after = await adapter.health();
    expect(after?.skippedUpdatesTotal).toBe(0);
    expect(after?.lastTransportSequence).toBeGreaterThanOrEqual(health!.lastTransportSequence + 1);

    // dropped updates 稳态必须为 0。
    expect(adapter.getMetrics().droppedUpdates).toBe(0);
    await adapter.stop();
  }, 30_000);

  it("transfer 后主线程 buffer detached（不可读不可复用）", async () => {
    const transport = mirrorTransport();
    const handle = await transport.mirrorCreate({ sessionEpoch: 0, dimensionEpoch: 0 });
    await transport.mirrorSubmitControl(handle, {
      kind: "worldReset",
      newSessionEpoch: 5,
      newDimensionEpoch: 1,
      reason: "sessionRestart",
    });
    const table = smallTable();
    const masksBytes = new Uint8Array(table.masks.buffer, table.masks.byteOffset, table.masks.byteLength);
    const registryAck = await transport.mirrorSubmitEnvelope(handle, {
      protocolVersion: 1,
      sessionEpoch: 5,
      dimensionEpoch: 1,
      transportSequence: 1,
      message: {
        kind: "registryTable",
        revision: table.revision,
        masks: masksBytes,
        ...(table.minecraftVersion !== undefined ? { minecraftVersion: table.minecraftVersion } : {}),
      },
    });
    expect(registryAck.status).toBe("registryReady");
    const beginAck = await transport.mirrorSubmitEnvelope(handle, {
      protocolVersion: 1,
      sessionEpoch: 5,
      dimensionEpoch: 1,
      transportSequence: 2,
      message: { kind: "chunkBegin", chunkX: 0, chunkZ: 0 },
    });
    expect(beginAck.status).toBe("applied");
    // 手工 sectionData：传输后视图必须 detached。
    const payload = buildSectionPayload(
      { sectionY: 0, status: "data", stateIds: new Uint32Array(4096).fill(1) },
      table,
      0,
      0,
    );
    const view = payload.paletteIndices as Uint8Array;
    expect(view.byteLength).toBe(8192);
    const ack = await transport.mirrorSubmitEnvelope(
      handle,
      {
        protocolVersion: 1,
        sessionEpoch: 5,
        dimensionEpoch: 1,
        transportSequence: 3,
        message: payload as never,
      },
      [view.buffer as ArrayBuffer],
    );
    expect(ack.status).toBe("applied");
    expect(view.byteLength).toBe(0); // detached：不可读不可复用
    await transport.mirrorDispose(handle);
  });

  it("worker terminate → in-flight 拒绝 → 适配器 fail-close（不返回旧 ready）", async () => {
    const table = smallTable();
    const adapter = new WorldSyncAdapter({
      transport: mirrorTransport(),
      registryTable: table,
      sessionEpoch: Math.floor(Date.now() / 1000) + 1,
      dimensionEpoch: 1,
      limits: { ackTimeoutMs: 500 },
    });
    await adapter.start();
    expect(adapter.currentState).toBe("ready");
    // worker 硬杀（外部 terminate）：下一条消息必须失败收敛。
    await terminatePathfinderWorker();
    adapter.onBlockUpdate(1, 1, 1, 1);
    await adapter.flushUpdates();
    await waitFor(
      () => adapter.currentState === "desynced" || adapter.currentState === "degraded",
      8000,
    );
    expect(adapter.currentState).not.toBe("ready"); // 不得继续返回旧 READY
    await adapter.stop();
  }, 15_000);
});

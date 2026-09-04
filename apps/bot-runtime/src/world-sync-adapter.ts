// world-sync-adapter.ts —— P5-D2c：TS WorldSyncAdapter（灰度门后启用，
// 默认关闭；flag=STUDIO_WORLD_MIRROR_SYNC=1）。
//
// 职责边界（P5-D2 §16——只做同步通道，不做第二个 Bot Supervisor）：
//   - session/dimension 身份（epoch 权威在本适配器=TS session supervisor）
//   - registry 握手（构建 stateId→classMask 表，核对 Rust 回显 revision/
//     fingerprint——用 BigInt FNV-1a 64 与 Rust 侧同构算法比对）
//   - 订阅 chunk load/unload/block update（由调用方接线；本模块只提供入口）
//   - D1 提取器驱动（extractColumnBudgeted 分片）
//   - source 事件序号（允许同坐标合并不连续）与 transport 序号（唯一
//     sender 串行分配、严格连续）分离
//   - block update 按坐标合并最终值
//   - ACK 关联/超时、in-flight 消息数与字节双限背压
//   - desync→reset→rebuild 有界恢复（一次恢复尝试，不无限重试）
//   - transferable buffer 所有权（postMessage 传输后主线程视图立即
//     detached；D2 无 buffer 池——安全释放优先于微优化）
//   - metrics 计数 + 结构化事件（Incident 上报经回调，由接线方映射
//     FailureCode——本模块不 import skills 包）
//   - stop/dispose（不 terminate worker——P5-F 前 TypeScript Bot
//     Supervisor 唯一进程管理权；worker 与寻路共享）
//
// 禁止（§16）：运行 A*、Goal 调度、HarvestAuthorization、替换
// worldStateSnapshot、findBlocks、持久业务事实。
//
// 生命周期：CREATED→STARTING→RESETTING→REGISTRY_HANDSHAKE→IMPORTING→
// READY→(DESYNCED/DEGRADED)→STOPPING→STOPPED。

import {
  ChunkExtractionSession,
  extractColumnBudgeted,
  type ExtractedChunk,
  type ExtractedSection,
} from "./world-section-extractor.js";
import { classifyBlock } from "./rust-pathfinder.js";
import type {
  MirrorAck,
  MirrorControlWire,
  MirrorEnvelopeWire,
  MirrorHealth,
  MirrorMessageWire,
} from "@minecraft-studio/pathfinder-rs";

// ---------------------------------------------------------------------------
// 线上类型（与 Rust mirror_napi 字符串映射逐字对齐）。
// ---------------------------------------------------------------------------

export type MirrorTransport = {
  mirrorCreate(options: {
    sessionEpoch: number;
    dimensionEpoch: number;
    replayCapacity?: number | null;
  }): Promise<number>;
  mirrorSubmitEnvelope(
    handle: number,
    envelope: MirrorEnvelopeWire,
    transferList?: ArrayBuffer[],
  ): Promise<MirrorAck>;
  mirrorSubmitControl(handle: number, control: MirrorControlWire): Promise<MirrorAck>;
  mirrorHealth(handle: number): Promise<MirrorHealth>;
  mirrorDispose(handle: number): Promise<boolean>;
};

export type WorldSyncState =
  | "created"
  | "starting"
  | "resetting"
  | "registry_handshake"
  | "importing"
  | "ready"
  | "desynced"
  | "degraded"
  | "stopping"
  | "stopped";

/** 结构化事件（接线方映射 Incident/FailureCode；本模块零 skills 依赖）。 */
export type WorldSyncIncident =
  | { kind: "sequence_gap"; transportSequence: number; lastSequence: number }
  | { kind: "protocol_conflict"; transportSequence: number }
  | { kind: "malformed_envelope"; transportSequence: number }
  | { kind: "registry_mismatch"; revision: number | null }
  | { kind: "queue_overflow"; queueDepth: number }
  | { kind: "ack_timeout"; transportSequence: number; waitedMs: number }
  | { kind: "worker_unavailable"; detail: string }
  | { kind: "desynced"; reason: string }
  | { kind: "recovered"; reason: string };

export type WorldSyncMetrics = {
  state: WorldSyncState;
  sent: number;
  acked: number;
  applied: number;
  duplicates: number;
  stale: number;
  conflicts: number;
  gaps: number;
  resets: number;
  desyncs: number;
  skippedUpdates: number;
  droppedUpdates: number;
  queueDepth: number;
  queueDepthMax: number;
  inFlightMessages: number;
  inFlightBytes: number;
  inFlightBytesMax: number;
  ackRttP50Ms: number | null;
  ackRttP95Ms: number | null;
  ackRttMaxMs: number | null;
  lastTransportSequence: number;
  sourceEventsObserved: number;
  sourceEventsCoalesced: number;
  extractSliceOverruns: number;
};

export type WorldSyncAdapterOptions = {
  transport: MirrorTransport;
  registryTable: RegistryTable;
  sessionEpoch: number;
  dimensionEpoch: number;
  logger?: {
    info?: (event: string, fields?: Record<string, unknown>) => void;
    warn?: (event: string, fields?: Record<string, unknown>) => void;
    error?: (event: string, fields?: Record<string, unknown>) => void;
  };
  onIncident?: (incident: WorldSyncIncident) => void;
  limits?: Partial<WorldSyncLimits>;
  /** D2d：span 记录（enqueue/postMessage/ack 往返/提取分片）。 */
  span?: (name: string, ms: number, fields?: Record<string, number>) => void;
  clock?: () => number;
  yieldFn?: () => Promise<void>;
};

export type WorldSyncLimits = {
  queueCapacity: number;
  maxInFlightMessages: number;
  maxInFlightBytes: number;
  ackTimeoutMs: number;
  updateFlushIntervalMs: number;
  updateBatchMaxEntries: number;
  /** 提取分片 wall-time 预算（ms；D2d：section 内部也有批次检查）。 */
  extractBudgetMs: number;
};

const DEFAULT_LIMITS: WorldSyncLimits = {
  // 与 D1 提取队列上限同量级：登录 burst（视距 81 列 × ~26 消息）不得
  // 触发 overflow——overflow 只留给病态背压（§14），不是正常路径。
  queueCapacity: 2048,
  maxInFlightMessages: 16,
  maxInFlightBytes: 8 * 1024 * 1024,
  ackTimeoutMs: 10_000,
  updateFlushIntervalMs: 250,
  updateBatchMaxEntries: 512,
  extractBudgetMs: 3,
};

// ---------------------------------------------------------------------------
// Registry 表构建（真实 minecraft-data → stateId→classMask）。
// ---------------------------------------------------------------------------

export type RegistryTable = {
  revision: number;
  /** 索引即 stateId；值=镜像 class mask（位定义：bit0..3=分类位，bit31=UNKNOWN 由 Rust 侧使用）。 */
  masks: Uint32Array;
  minecraftVersion: string | undefined;
  serverProfileId: string | undefined;
};

/** class 位定义（镜像 bitmask；与寻路体素类 0..3 同源分类器，位不同）。 */
export const MIRROR_CLASS_BITS = {
  PASSABLE: 1 << 0,
  SOLID: 1 << 1,
  DIGGABLE: 1 << 2,
  HAZARD: 1 << 3,
} as const;

/** 从 minecraft-data blocks 数组构建全量表（flag 开启时一次性；关闭时零成本）。 */
export function buildRegistryTable(
  blocks: Array<{
    name: string;
    minStateId: number;
    maxStateId: number;
    boundingBox?: string;
  }>,
  options: { revision: number; minecraftVersion: string | undefined; serverProfileId: string | undefined },
): RegistryTable {
  let maxStateId = 0;
  for (const block of blocks) maxStateId = Math.max(maxStateId, block.maxStateId);
  const masks = new Uint32Array(maxStateId + 1);
  // 缺省位=0（未分类）→ Rust 侧查表得到 0 ≠ UNKNOWN_BIT……表内 0 视为
  // "未分类"（Rust CLASS_UNKNOWN_BIT 语义=握手表项全 0 视为未分类）。
  const maskByClass = [
    MIRROR_CLASS_BITS.PASSABLE,
    MIRROR_CLASS_BITS.SOLID,
    MIRROR_CLASS_BITS.DIGGABLE,
    MIRROR_CLASS_BITS.HAZARD,
  ];
  for (const block of blocks) {
    const cls = classifyBlock(block.name, String(block.boundingBox ?? "empty"));
    const mask = maskByClass[cls] ?? MIRROR_CLASS_BITS.DIGGABLE;
    for (let stateId = block.minStateId; stateId <= block.maxStateId; stateId += 1) {
      masks[stateId] = mask;
    }
  }
  return {
    revision: options.revision,
    masks,
    minecraftVersion: options.minecraftVersion,
    serverProfileId: options.serverProfileId,
  };
}

// ---------------------------------------------------------------------------
// FNV-1a 64（BigInt；与 Rust payload_fingerprint 的 RegistryTable 分支同构
// ——字段序：tag(1)+revision+len+masks[]+可选字符串）。仅 registry 握手
// 核对用；数据消息指纹由 Rust 侧自算自存。
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

class Fnv1a64 {
  private hash = FNV_OFFSET;
  u8(value: number): void {
    this.hash ^= BigInt(value & 0xff);
    this.hash = (this.hash * FNV_PRIME) & MASK64;
  }
  u32(value: number): void {
    let v = value >>> 0;
    for (let i = 0; i < 4; i += 1) {
      this.u8(v & 0xff);
      v = Math.floor(v / 256);
    }
  }
  u64(value: number | bigint): void {
    let v = BigInt(value);
    for (let i = 0; i < 8; i += 1) {
      this.u8(Number(v & 0xffn));
      v >>= 8n;
    }
  }
  str(value: string): void {
    this.u64(value.length);
    for (const ch of Buffer.from(value, "utf8")) this.u8(ch);
  }
  optionStr(value: string | undefined): void {
    if (value === undefined) this.u8(0);
    else {
      this.u8(1);
      this.str(value);
    }
  }
  finish(): bigint {
    return this.hash;
  }
}

/** RegistryTable 消息指纹（与 Rust MSG_REGISTRY_TABLE=1 分支逐字段对齐）。 */
export function registryTableFingerprint(table: RegistryTable): string {
  const h = new Fnv1a64();
  h.u8(1); // MSG_REGISTRY_TABLE
  h.u64(table.revision);
  h.u64(table.masks.length);
  for (let i = 0; i < table.masks.length; i += 1) h.u32(table.masks[i] ?? 0);
  h.optionStr(table.minecraftVersion);
  h.optionStr(table.serverProfileId);
  return h.finish().toString();
}

// ---------------------------------------------------------------------------
// 提取结果 → 协议载荷（stateId→mask→去重 palette 索引）。
// ---------------------------------------------------------------------------

/** sectionData 线上形态（扁平 tagged object，与 Rust MirrorMessageJs 对齐）。 */
export type SectionDataWire = {
  kind: "sectionData";
  chunkX: number;
  chunkZ: number;
  payloadKind: "data" | "empty" | "notPresent";
  sectionY: number;
  fillStateId?: number;
  paletteIndices?: Uint8Array;
  paletteEntries?: number[];
};

/**
 * 单 section 转换：Data/Empty/NotPresent 三态。Data 构建 per-section
 * palette（mask 去重）并映射 4096 索引；Empty 用提取器声明的语义
 * （prismarine 显式空=全 stateId 0——fillStateId 显式=0，不隐含"空气"）。
 * 返回的 paletteIndices 是新分配的 Uint16Array 字节视图——所有权随
 * postMessage 传输移交，ACK 前主线程不得复用（复用即 detached buffer）。
 */
export function buildSectionPayload(
  section: ExtractedSection,
  registryTable: RegistryTable,
  chunkX: number,
  chunkZ: number,
): SectionDataWire {
  if (section.status === "empty") {
    return {
      kind: "sectionData",
      chunkX,
      chunkZ,
      payloadKind: "empty",
      sectionY: section.sectionY,
      fillStateId: 0,
    };
  }
  if (section.status === "not-present" || section.stateIds === null) {
    return {
      kind: "sectionData",
      chunkX,
      chunkZ,
      payloadKind: "notPresent",
      sectionY: section.sectionY,
    };
  }
  const paletteEntries: number[] = [];
  const paletteIndexByMask = new Map<number, number>();
  const indices = new Uint16Array(4096);
  for (let i = 0; i < 4096; i += 1) {
    const stateId = section.stateIds[i] ?? 0;
    const mask = stateId < registryTable.masks.length ? (registryTable.masks[stateId] ?? 0) : 0;
    let paletteIndex = paletteIndexByMask.get(mask);
    if (paletteIndex === undefined) {
      paletteIndex = paletteEntries.length;
      paletteEntries.push(mask);
      paletteIndexByMask.set(mask, paletteIndex);
    }
    indices[i] = paletteIndex;
  }
  const bytes = new Uint8Array(indices.buffer, indices.byteOffset, indices.byteLength);
  return {
    kind: "sectionData",
    chunkX,
    chunkZ,
    payloadKind: "data",
    sectionY: section.sectionY,
    paletteIndices: bytes,
    paletteEntries,
  };
}

// ---------------------------------------------------------------------------
// 适配器本体。
// ---------------------------------------------------------------------------

type QueuedSend = {
  kind: string;
  chunk?: { x: number; z: number };
  build: (transportSequence: number) => { envelope: MirrorEnvelopeWire; transferBuffer: ArrayBuffer | undefined; bytes: number };
};

type InFlight = {
  transportSequence: number;
  bytes: number;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
};

type CoalescedUpdate = {
  x: number;
  y: number;
  z: number;
  stateId: number;
  sourceFirst: number;
  sourceLast: number;
  eventCount: number;
};

export class WorldSyncAdapter {
  private readonly transport: MirrorTransport;
  private readonly table: RegistryTable;
  private readonly logger: NonNullable<WorldSyncAdapterOptions["logger"]>;
  private readonly onIncident: (incident: WorldSyncIncident) => void;
  private readonly span: NonNullable<WorldSyncAdapterOptions["span"]>;
  private readonly limits: WorldSyncLimits;
  private readonly clock: () => number;
  private readonly yieldFn: () => Promise<void>;

  private state: WorldSyncState = "created";
  private handle: number | null = null;
  private sessionEpoch: number;
  private dimensionEpoch: number;
  private transportSequence = 0;
  private sourceSequence = 0;

  private readonly queue: QueuedSend[] = [];
  private readonly inFlight = new Map<number, InFlight>();
  private readonly ackRtts: number[] = [];
  private readonly coalesced = new Map<string, CoalescedUpdate>();
  private readonly extractionSessions = new Map<string, ChunkExtractionSession>();
  private updateFlushTimer: ReturnType<typeof setInterval> | null = null;
  private ackCheckTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private recovering = false;

  private readonly metrics = {
    sent: 0,
    acked: 0,
    applied: 0,
    duplicates: 0,
    stale: 0,
    conflicts: 0,
    gaps: 0,
    resets: 0,
    desyncs: 0,
    skippedUpdates: 0,
    droppedUpdates: 0,
    queueDepthMax: 0,
    inFlightBytesMax: 0,
    sourceEventsObserved: 0,
    sourceEventsCoalesced: 0,
    extractSliceOverruns: 0,
  };

  constructor(private readonly options: WorldSyncAdapterOptions) {
    this.transport = options.transport;
    this.table = options.registryTable;
    this.logger = options.logger ?? {};
    this.onIncident = options.onIncident ?? (() => {});
    this.span = options.span ?? (() => {});
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.clock = options.clock ?? (() => Date.now());
    this.yieldFn = options.yieldFn ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
    this.sessionEpoch = options.sessionEpoch;
    this.dimensionEpoch = options.dimensionEpoch;
  }

  get currentState(): WorldSyncState {
    return this.state;
  }

  getMetrics(): WorldSyncMetrics {
    const sorted = [...this.ackRtts].sort((a, b) => a - b);
    const at = (p: number): number | null =>
      sorted.length === 0 ? null : (sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? null);
    let inFlightBytes = 0;
    for (const entry of this.inFlight.values()) inFlightBytes += entry.bytes;
    return {
      state: this.state,
      ...this.metrics,
      queueDepth: this.queue.length,
      inFlightMessages: this.inFlight.size,
      inFlightBytes,
      ackRttP50Ms: at(50),
      ackRttP95Ms: at(95),
      ackRttMaxMs: sorted.length === 0 ? null : (sorted[sorted.length - 1] ?? null),
      lastTransportSequence: this.transportSequence,
    };
  }

  // -------------------------------------------------------------------
  // 生命周期。
  // -------------------------------------------------------------------

  /**
   * 启动：建会话 → 权威 Reset（epoch 前进由本侧分配）→ registry 握手
   * （核对 revision+fingerprint）→ IMPORTING/READY。
   */
  async start(): Promise<void> {
    if (this.state !== "created") throw new Error(`world-sync: start() from ${this.state}`);
    this.setState("starting");
    const handle = await this.transport.mirrorCreate({
      sessionEpoch: 0,
      dimensionEpoch: 0,
    });
    this.handle = handle;
    try {
      this.setState("resetting");
      const resetAck = await this.transport.mirrorSubmitControl(handle, {
        kind: "worldReset",
        newSessionEpoch: this.sessionEpoch,
        newDimensionEpoch: this.dimensionEpoch,
        reason: "sessionRestart",
        resyncToken: this.sessionEpoch,
      });
      if (resetAck.status !== "resetApplied") {
        throw new Error(`world-sync: initial reset -> ${resetAck.status}`);
      }
      this.metrics.resets += 1;
      this.setState("registry_handshake");
      await this.drainQueueForHandshake(handle, registryTableFingerprint(this.table));
      this.transportSequence = 1;
      this.setState("importing");
      this.updateFlushTimer = setInterval(() => {
        void this.flushUpdates();
      }, this.limits.updateFlushIntervalMs);
      this.updateFlushTimer.unref?.();
      this.ackCheckTimer = setInterval(() => this.checkAckDeadlines(), 250);
      this.ackCheckTimer.unref?.();
      void this.pump();
    } catch (error) {
      this.handle = null;
      await this.transport.mirrorDispose(handle).catch(() => false);
      this.setState("degraded");
      throw error;
    }
  }

  /** registry 握手（独立方法，恢复路径复用）。 */
  private async drainQueueForHandshake(handle: number, expectedFingerprint: string): Promise<void> {
    const masksBytes = new Uint8Array(
      this.table.masks.buffer,
      this.table.masks.byteOffset,
      this.table.masks.byteLength,
    );
    const began = this.clock();
    const ack = await this.transport.mirrorSubmitEnvelope(handle, {
      protocolVersion: 1,
      sessionEpoch: this.sessionEpoch,
      dimensionEpoch: this.dimensionEpoch,
      transportSequence: 1,
      message: {
        kind: "registryTable",
        revision: this.table.revision,
        masks: masksBytes,
        ...(this.table.minecraftVersion !== undefined ? { minecraftVersion: this.table.minecraftVersion } : {}),
        ...(this.table.serverProfileId !== undefined ? { serverProfileId: this.table.serverProfileId } : {}),
      },
    });
    this.span("world_sync.registry_handshake", this.clock() - began, { bytes: masksBytes.byteLength });
    if (ack.status !== "registryReady") {
      throw new Error(`world-sync: registry handshake -> ${ack.status} (${ack.reason ?? "no reason"})`);
    }
    if (ack.registryRevision !== this.table.revision) {
      this.onIncident({ kind: "registry_mismatch", revision: ack.registryRevision ?? null });
      throw new Error(`world-sync: registry revision mismatch (sent ${this.table.revision}, ack ${String(ack.registryRevision)})`);
    }
    if (ack.payloadFingerprint !== expectedFingerprint) {
      this.onIncident({ kind: "registry_mismatch", revision: ack.registryRevision ?? null });
      throw new Error(
        `world-sync: registry fingerprint mismatch (ts ${expectedFingerprint}, rust ${String(ack.payloadFingerprint)})`,
      );
    }
  }

  // -------------------------------------------------------------------
  // 停止与事件入口。
  // -------------------------------------------------------------------

  /** 停止：拒绝新输入、取消提取、有界排空、dispose（不 terminate worker——
   * P5-F 前进程管理权在 TypeScript Bot Supervisor；worker 与寻路共享）。 */
  async stop(): Promise<void> {
    if (this.state === "stopped" || this.state === "stopping") return;
    this.setState("stopping");
    this.stopped = true;
    if (this.updateFlushTimer !== null) clearInterval(this.updateFlushTimer);
    if (this.ackCheckTimer !== null) clearInterval(this.ackCheckTimer);
    this.updateFlushTimer = null;
    this.ackCheckTimer = null;
    for (const session of this.extractionSessions.values()) session.cancel("reset");
    this.extractionSessions.clear();
    this.queue.length = 0;
    // 有界排空：in-flight 直接失败清理（worker 崩溃路径同构）。
    for (const entry of this.inFlight.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    this.inFlight.clear();
    this.coalesced.clear();
    const handle = this.handle;
    this.handle = null;
    if (handle !== null) {
      await this.transport.mirrorSubmitControl(handle, { kind: "stop" }).catch(() => null);
      await this.transport.mirrorDispose(handle).catch(() => false);
    }
    this.setState("stopped");
  }

  // -------------------------------------------------------------------
  // 世界事件入口（由接线方订阅 bot.world 事件后转发；唯一 sender 在此）。
  // -------------------------------------------------------------------

  /** chunk 列加载：分片提取 → BEGIN/DATA×/COMMIT 事务入队。 */
  onChunkColumnLoad(
    column: {
      sections: Array<{ data: { get(index: number): number } } | null | undefined>;
      minY: number;
      numSections: number;
    },
    chunkX: number,
    chunkZ: number,
  ): void {
    if (this.stopped || this.handle === null) return;
    if (this.state === "desynced" || this.state === "degraded") {
      // 显式重入（reImportColumn/新列事件）：触发一次有界恢复尝试。
      void this.desyncAndRecover("reimport_after_desync");
      return;
    }
    if (this.state !== "importing" && this.state !== "ready" && this.state !== "registry_handshake") return;
    const key = `${chunkX},${chunkZ}`;
    const session = new ChunkExtractionSession();
    this.extractionSessions.set(key, session);
    void this.extractAndEnqueue(column, chunkX, chunkZ, session).catch((error) => {
      this.logger.warn?.("world_sync_extract_failed", {
        chunkX,
        chunkZ,
        error: error instanceof Error ? error.message : String(error),
      });
      this.extractionSessions.delete(key);
    });
  }

  private async extractAndEnqueue(
    column: Parameters<WorldSyncAdapter["onChunkColumnLoad"]>[0],
    chunkX: number,
    chunkZ: number,
    session: ChunkExtractionSession,
  ): Promise<void> {
    const key = `${chunkX},${chunkZ}`;
    const began = this.clock();
    let extracted: ExtractedChunk;
    try {
      extracted = await extractColumnBudgeted(column, chunkX, chunkZ, session, this.limits.extractBudgetMs, this.yieldFn);
    } finally {
      this.extractionSessions.delete(key);
    }
    this.span("world_sync.extract_column", this.clock() - began, {
      sections: extracted.sections.length,
      overruns: extracted.sliceOverruns,
      maxSliceMs: extracted.maxSliceMs,
      chunkX,
      chunkZ,
    });
    this.metrics.extractSliceOverruns += extracted.sliceOverruns;
    this.enqueue({ kind: "chunkBegin", chunk: { x: chunkX, z: chunkZ }, build: (seq) => ({
      envelope: this.envelope(seq, { kind: "chunkBegin", chunkX, chunkZ }),
      transferBuffer: undefined,
      bytes: 16,
    }) });
    for (const section of extracted.sections) {
      const payload = buildSectionPayload(section, this.table, chunkX, chunkZ);
      const isData = payload.payloadKind === "data";
      this.enqueue({ kind: "sectionData", chunk: { x: chunkX, z: chunkZ }, build: (seq) => ({
        envelope: this.envelope(seq, payload as MirrorMessageWire),
        transferBuffer: isData ? ((payload.paletteIndices as Uint8Array).buffer as ArrayBuffer) : undefined,
        bytes: isData ? 8192 + 64 : 32,
      }) });
    }
    this.enqueue({ kind: "chunkCommit", chunk: { x: chunkX, z: chunkZ }, build: (seq) => ({
      envelope: this.envelope(seq, { kind: "chunkCommit", chunkX, chunkZ }),
      transferBuffer: undefined,
      bytes: 16,
    }) });
    // 该 chunk 的提取窗口关闭：持有中的 update 补冲（Rust 侧按 loaded 应用）。
    void this.flushUpdates();
    void this.pump();
  }

  /** chunk 列卸载：取消提取 + 淘汰该 chunk 的排队工作 + UNLOAD 入队。 */
  onChunkColumnUnload(chunkX: number, chunkZ: number): void {
    if (this.stopped || this.handle === null) return;
    const key = `${chunkX},${chunkZ}`;
    const session = this.extractionSessions.get(key);
    if (session !== undefined) {
      session.cancel("unload");
      this.extractionSessions.delete(key);
    }
    // 淘汰更旧的目标 chunk 工作（BEGIN/DATA 未发出的直接丢弃；已 in-flight
    // 的由 Rust 侧 UNLOAD 语义兜底——迟到 COMMIT 不复活）。
    for (let i = this.queue.length - 1; i >= 0; i -= 1) {
      if (this.queue[i]?.chunk?.x === chunkX && this.queue[i]?.chunk?.z === chunkZ) {
        this.queue.splice(i, 1);
      }
    }
    this.enqueue({ kind: "chunkUnload", build: (seq) => ({
      envelope: this.envelope(seq, { kind: "chunkUnload", chunkX, chunkZ }),
      transferBuffer: undefined,
      bytes: 16,
    }) });
    void this.pump();
  }

  /** block update：同坐标合并最终值（source 序号允许不连续）。 */
  onBlockUpdate(x: number, y: number, z: number, stateId: number): void {
    if (this.stopped || this.handle === null) return;
    this.sourceSequence += 1;
    this.metrics.sourceEventsObserved += 1;
    const key = `${x},${y},${z}`;
    const existing = this.coalesced.get(key);
    if (existing !== undefined) {
      // 合并：保留最终 stateId 与扩展后的 source 范围。
      existing.stateId = stateId;
      existing.sourceLast = this.sourceSequence;
      existing.eventCount += 1;
      this.metrics.sourceEventsCoalesced += 1;
      return;
    }
    this.coalesced.set(key, {
      x,
      y,
      z,
      stateId,
      sourceFirst: this.sourceSequence,
      sourceLast: this.sourceSequence,
      eventCount: 1,
    });
    if (this.coalesced.size >= this.limits.updateBatchMaxEntries) {
      void this.flushUpdates();
    }
  }

  /** 冲刷合并 update 为一个 BlockUpdateBatch（测试可显式调用）。
   * 提取窗口内的 chunk（BEGIN 未达 Rust）其 update 持有回填——等该 chunk
   * COMMIT 入队后再冲（§13：导入期 update 必须排队重放，不是 skip）。 */
  async flushUpdates(): Promise<void> {
    if (this.stopped || this.handle === null || this.coalesced.size === 0) return;
    const entries: CoalescedUpdate[] = [];
    for (const [key, entry] of [...this.coalesced.entries()]) {
      if (this.extractionSessions.has(`${entry.x >> 4},${entry.z >> 4}`)) {
        continue; // 提取中：保留在合并表（COMMIT 后再冲）
      }
      entries.push(entry);
      this.coalesced.delete(key);
    }
    if (entries.length === 0) return;
    let sourceFirst = Infinity;
    let sourceLast = 0;
    let eventCount = 0;
    const updatesFlat: number[] = [];
    for (const entry of entries) {
      sourceFirst = Math.min(sourceFirst, entry.sourceFirst);
      sourceLast = Math.max(sourceLast, entry.sourceLast);
      eventCount += entry.eventCount;
      updatesFlat.push(entry.x, entry.y, entry.z, entry.stateId);
    }
    const coalescedCount = eventCount - entries.length;
    this.enqueue({ kind: "blockUpdateBatch", build: (seq) => ({
      envelope: this.envelope(seq, {
        kind: "blockUpdateBatch",
        sourceFirstSequence: sourceFirst,
        sourceLastSequence: sourceLast,
        sourceEventCount: eventCount,
        ...(coalescedCount > 0 ? { coalescedEventCount: coalescedCount } : {}),
        updatesFlat,
      }),
      transferBuffer: undefined,
      bytes: updatesFlat.length * 8 + 64,
    }) });
    void this.pump();
  }

  // -------------------------------------------------------------------
  // 唯一 sender：串行队列 → transport 序号分配 → in-flight 限额 → ACK。
  // -------------------------------------------------------------------

  private envelope(transportSequence: number, message: MirrorMessageWire): MirrorEnvelopeWire {
    return {
      protocolVersion: 1,
      sessionEpoch: this.sessionEpoch,
      dimensionEpoch: this.dimensionEpoch,
      transportSequence,
      message,
    };
  }

  private enqueue(item: QueuedSend): void {
    if (this.queue.length >= this.limits.queueCapacity) {
      // §14：overflow → desync + 有界恢复（不静默丢——诚实失败）。
      this.metrics.queueDepthMax = Math.max(this.metrics.queueDepthMax, this.queue.length);
      this.onIncident({ kind: "queue_overflow", queueDepth: this.queue.length });
      void this.desyncAndRecover("queue_overflow");
      return;
    }
    this.queue.push(item);
    this.metrics.queueDepthMax = Math.max(this.metrics.queueDepthMax, this.queue.length);
    this.span("world_sync.enqueue", 0, { queueDepth: this.queue.length });
  }

  private inFlightBytes(): number {
    let total = 0;
    for (const entry of this.inFlight.values()) total += entry.bytes;
    return total;
  }

  /** 队列泵：受 in-flight 消息数与字节双限（§15——不能只按条数）。
   * 只有 IMPORTING/READY 状态泵送——握手/恢复期间排队不抢先（registry
   * 屏障在 Rust 侧兜底，这里先序不发=少一轮 ResetRequired churn）。 */
  private async pump(): Promise<void> {
    if (this.stopped || this.handle === null || this.recovering) return;
    if (this.state !== "importing" && this.state !== "ready") return;
    const handle = this.handle;
    while (
      this.queue.length > 0 &&
      this.inFlight.size < this.limits.maxInFlightMessages &&
      this.inFlightBytes() < this.limits.maxInFlightBytes
    ) {
      const item = this.queue.shift();
      if (item === undefined) break;
      this.transportSequence += 1;
      const seq = this.transportSequence;
      const built = item.build(seq);
      const transferList = built.transferBuffer !== undefined ? [built.transferBuffer] : undefined;
      const inFlight: InFlight = {
        transportSequence: seq,
        bytes: built.bytes,
        sentAt: this.clock(),
        timer: null,
      };
      this.inFlight.set(seq, inFlight);
      this.metrics.inFlightBytesMax = Math.max(this.metrics.inFlightBytesMax, this.inFlightBytes());
      this.metrics.sent += 1;
      const postBegan = this.clock();
      this.transport
        .mirrorSubmitEnvelope(handle, built.envelope, transferList)
        .then((ack) => {
          this.span("world_sync.ack_rtt", this.clock() - inFlight.sentAt, { transportSequence: seq });
          this.onAck(seq, ack);
        })
        .catch((error) => {
          this.onTransportFailure(seq, error instanceof Error ? error.message : String(error));
        });
      this.span("world_sync.post_message", this.clock() - postBegan, { bytes: built.bytes });
    }
    // 队列排空且无 in-flight → READY（IMPORTING↔READY 往返）。
    if (
      (this.state === "importing" || this.state === "ready") &&
      this.queue.length === 0 &&
      this.inFlight.size === 0 &&
      this.coalesced.size === 0
    ) {
      this.setState("ready");
    } else if (this.state === "ready" && (this.queue.length > 0 || this.inFlight.size > 0)) {
      this.setState("importing");
    }
  }

  private onAck(seq: number, ack: MirrorAck): void {
    const entry = this.inFlight.get(seq);
    if (entry === undefined) return; // 已被 stop/恢复清理：stale ack 不改状态
    if (entry.timer !== null) clearTimeout(entry.timer);
    this.inFlight.delete(seq);
    this.metrics.acked += 1;
    this.ackRtts.push(this.clock() - entry.sentAt);
    if (this.ackRtts.length > 256) this.ackRtts.shift();
    switch (ack.status) {
      case "applied":
      case "registryReady":
      case "queuedUntilCommit":
        this.metrics.applied += 1;
        if (ack.skippedUpdates !== null && ack.skippedUpdates !== undefined) {
          this.metrics.skippedUpdates += ack.skippedUpdates;
        }
        break;
      case "ignoredDuplicate":
        this.metrics.duplicates += 1;
        break;
      case "ignoredStale":
        this.metrics.stale += 1;
        break;
      case "semanticRejected":
        // 传输槽已被消费（§9）：序号连续性不受影响，无需恢复。
        this.logger.warn?.("world_sync_semantic_rejected", {
          transportSequence: ack.transportSequence,
          reason: ack.reason ?? null,
        });
        break;
      case "gapDesynced":
        this.metrics.gaps += 1;
        this.onIncident({ kind: "sequence_gap", transportSequence: seq, lastSequence: seq - 1 });
        void this.desyncAndRecover("sequence_gap");
        break;
      case "protocolConflict":
        this.metrics.conflicts += 1;
        this.onIncident({ kind: "protocol_conflict", transportSequence: seq });
        void this.desyncAndRecover("protocol_conflict");
        break;
      case "malformedEnvelope":
        this.onIncident({ kind: "malformed_envelope", transportSequence: seq });
        void this.desyncAndRecover("malformed_envelope");
        break;
      case "resetRequired":
        this.logger.warn?.("world_sync_reset_required", {
          transportSequence: seq,
          reason: ack.reason ?? null,
        });
        void this.desyncAndRecover(`reset_required:${ack.reason ?? "unknown"}`);
        break;
      case "wrongEpoch":
      case "unsupportedProtocol":
        // 编程错误面（发送侧构造错）：不重试，降级并上报。
        this.onIncident({ kind: "desynced", reason: ack.status });
        this.setState("degraded");
        break;
      default:
        break;
    }
    void this.pump();
  }

  private onTransportFailure(seq: number, detail: string): void {
    const entry = this.inFlight.get(seq);
    if (entry !== undefined) {
      if (entry.timer !== null) clearTimeout(entry.timer);
      this.inFlight.delete(seq);
    }
    this.onIncident({ kind: "worker_unavailable", detail });
    this.metrics.desyncs += 1;
    this.setState("desynced");
    // §19：有界恢复（一次 reset+握手尝试；失败→DEGRADED，不无限重试）。
    void this.desyncAndRecover("worker_unavailable");
  }

  private checkAckDeadlines(): void {
    if (this.stopped) return;
    const now = this.clock();
    for (const [seq, entry] of [...this.inFlight.entries()]) {
      const waited = now - entry.sentAt;
      if (waited >= this.limits.ackTimeoutMs) {
        // ACK 超时：先检查 worker 健康（§19——不能盲重试）。
        void this.handleAckTimeout(seq, waited);
      }
    }
  }

  private async handleAckTimeout(seq: number, waitedMs: number): Promise<void> {
    if (this.stopped || this.handle === null) return;
    this.onIncident({ kind: "ack_timeout", transportSequence: seq, waitedMs });
    const handle = this.handle;
    try {
      const health = await this.transport.mirrorHealth(handle);
      if (health.stopped || health.desynced) {
        void this.desyncAndRecover(`ack_timeout_unhealthy:${health.desynced ? "desynced" : "stopped"}`);
        return;
      }
      // worker 健康但 ACK 迟到：有界等待一次（下一个检查周期仍超时→恢复）。
      this.logger.warn?.("world_sync_ack_slow", { transportSequence: seq, waitedMs });
    } catch (error) {
      this.onTransportFailure(seq, error instanceof Error ? error.message : String(error));
    }
  }

  // -------------------------------------------------------------------
  // desync → reset → rebuild（有界：一次恢复尝试；失败→DEGRADED）。
  // -------------------------------------------------------------------

  private async desyncAndRecover(reason: string): Promise<void> {
    if (this.stopped || this.recovering) return;
    this.recovering = true;
    this.metrics.desyncs += 1;
    this.setState("desynced");
    this.onIncident({ kind: "desynced", reason });
    // 清干净本地发送面（队列丢弃=in-flight 之后必然 reset 重建）。
    for (const entry of this.inFlight.values()) {
      if (entry.timer !== null) clearTimeout(entry.timer);
    }
    this.inFlight.clear();
    this.queue.length = 0;
    this.coalesced.clear();
    for (const session of this.extractionSessions.values()) session.cancel("reset");
    this.extractionSessions.clear();
    const handle = this.handle;
    try {
      if (handle === null) throw new Error("no session");
      this.sessionEpoch += 1;
      this.transportSequence = 0;
      const began = this.clock();
      const resetAck = await this.transport.mirrorSubmitControl(handle, {
        kind: "worldReset",
        newSessionEpoch: this.sessionEpoch,
        newDimensionEpoch: this.dimensionEpoch,
        reason: "desyncRecovery",
        resyncToken: this.sessionEpoch,
      });
      this.span("world_sync.reset", this.clock() - began, {});
      if (resetAck.status !== "resetApplied") {
        throw new Error(`reset -> ${resetAck.status}`);
      }
      this.metrics.resets += 1;
      await this.drainQueueForHandshake(handle, registryTableFingerprint(this.table));
      this.transportSequence = 1;
      this.setState("importing");
      this.onIncident({ kind: "recovered", reason });
      // 注意：不自动重放历史 chunk（truth 重建由调用方重新触发 columnLoad
      // 或 P5-D3 的全量重建——D2 范围内重建=重新订阅现有已加载列）。
      this.recovering = false;
      void this.pump();
    } catch (error) {
      this.recovering = false;
      this.logger.error?.("world_sync_recovery_failed", {
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
      this.setState("degraded");
    }
  }

  private setState(state: WorldSyncState): void {
    if (this.state === state) return;
    this.state = state;
    this.logger.info?.("world_sync_state", { state });
  }

  /** 恢复后由接线方重新声明已加载列（truth 重建入口）。 */
  reImportColumn(
    column: Parameters<WorldSyncAdapter["onChunkColumnLoad"]>[0],
    chunkX: number,
    chunkZ: number,
  ): void {
    this.onChunkColumnLoad(column, chunkX, chunkZ);
  }

  /** 健康透传（诊断/接线方决策用）。 */
  async health(): Promise<MirrorHealth | null> {
    if (this.handle === null) return null;
    return this.transport.mirrorHealth(this.handle).catch(() => null);
  }
}

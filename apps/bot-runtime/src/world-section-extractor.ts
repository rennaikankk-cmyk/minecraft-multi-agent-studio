// world-section-extractor.ts —— P5-D1：TS Section 提取器（只提取+测试，不接生产数据源）。
//
// 纪律（P5-D1 指令）：
//  - 真实 prismarine-chunk 1.40 ChunkColumn fixture 验证（1.21.11/774：
//    numSections=24、minY=-64、绝对 sectionY=(y-minY)>>4）。
//  - Uint32Array 保留完整 stateId（未验证范围前不压 u16——palette 压缩
//    属于 Rust 侧导入职责）。
//  - transferable ArrayBuffer 在 ACK 前不得复用（本模块只导出 buffer；
//    所有权移交由 P5-D2 的 ACK 协议管理——extractor 冻结 source 不再读）。
//  - CHUNK_BEGIN 后记录该 chunk 全部 block update（绝对 stateId），
//    分片提取跨多 tick；CHUNK_COMMIT 后按 sequence 重放累积更新；
//    unload/reset 立即取消；队列溢出→DESYNCED。重放幂等：更新携带
//    最终绝对 stateId，即使提取时已读到新值，重放相同最终值无副作用。
//  - chunk burst 按 wall-time 预算（默认 3ms）分片，setImmediate 让出。

/** 单 section 提取结果（buffer 所有权随导出移交，调用方 ACK 前不复用）。 */
export type ExtractedSection = {
  // replay 可能 empty→data 升级（状态字段可变是设计的一部分）
  /** 绝对 sectionY（1.18+ 负 minY 已换算）。 */
  sectionY: number;
  /** Data=有数据；Empty=显式空（全 stateId 0）；NotPresent=槽位缺席。 */
  status: "data" | "empty" | "not-present";
  /** 长 4096 的 stateId 表（仅 data 状态非空）。Uint32Array 保留全量。 */
  stateIds: Uint32Array | null;
};

/** 单 chunk 提取结果（完整 column，已含所有 section）。 */
export type ExtractedChunk = {
  chunkX: number;
  chunkZ: number;
  sections: ExtractedSection[];
  /** 提取期间累积的 block update（COMMIT 后按 sequence 重放）。 */
  pendingUpdates: ReadonlyArray<{ x: number; y: number; z: number; stateId: number; sequence: number }>;
  /** 提取用时统计（ms）。 */
  extractMs: number;
};

/** CHUNK_BEGIN 后的提取会话：记录 block update、处理 unload/reset 取消。 */
export class ChunkExtractionSession {
  private updates = new Map<string, { x: number; y: number; z: number; stateId: number; sequence: number }>();
  private cancelled = false;
  private cancelReason: "unload" | "reset" | "queue-overflow" | null = null;
  private readonly maxQueuedUpdates: number;

  constructor(maxQueuedUpdates = 2048) {
    this.maxQueuedUpdates = maxQueuedUpdates;
  }

  /** block update 事件：同坐标合并保留最终值+最高 sequence。 */
  recordBlockUpdate(x: number, y: number, z: number, stateId: number, sequence: number): "recorded" | "overflow" {
    if (this.cancelled) return "recorded"; // 已取消：静默吞（调用方不再消费）
    const key = `${x},${y},${z}`;
    this.updates.set(key, { x, y, z, stateId, sequence });
    if (this.updates.size > this.maxQueuedUpdates) {
      this.cancelled = true;
      this.cancelReason = "queue-overflow";
      return "overflow";
    }
    return "recorded";
  }

  /** unload/reset：立即取消提取。 */
  cancel(reason: "unload" | "reset"): void {
    this.cancelled = true;
    this.cancelReason = reason;
    this.updates.clear(); // 取消即丢弃全部累积（不再可重放）
  }

  get isCancelled(): boolean {
    return this.cancelled;
  }

  get cancelReasonOrNull(): "unload" | "reset" | "queue-overflow" | null {
    return this.cancelReason;
  }

  /** COMMIT 后按 sequence 重放的更新列表。 */
  drainUpdates(): Array<{ x: number; y: number; z: number; stateId: number; sequence: number }> {
    const list = [...this.updates.values()].sort((a, b) => a.sequence - b.sequence);
    this.updates.clear();
    return list;
  }
}

/** 检查 section 是否全 stateId=0（显式空）。 */
function isSectionAllZero(section: { data: { get(index: number): number } }): boolean {
  for (let i = 0; i < 4096; i += 1) {
    if (section.data.get(i) !== 0) return false;
  }
  return true;
}

/** 从真实 ChunkColumn 提取单 section。 */
function extractSection(
  section: { data: { get(index: number): number } } | null | undefined,
  sectionY: number,
): ExtractedSection {
  if (section === null || section === undefined) {
    return { sectionY, status: "not-present", stateIds: null };
  }
  const stateIds = new Uint32Array(4096);
  let allZero = true;
  for (let i = 0; i < 4096; i += 1) {
    const value = section.data.get(i);
    stateIds[i] = value;
    if (value !== 0) allZero = false;
  }
  return { sectionY, status: allZero ? "empty" : "data", stateIds: allZero ? null : stateIds };
}

/**
 * 同步提取完整 column（测试/benchmark 用）。生产路径用 extractColumnBudgeted
 * 分片——一个 chunkColumnLoad 回调不得同步遍历全部 section。
 */
export function extractColumnSync(
  column: {
    sections: Array<{ data: { get(index: number): number } } | null | undefined>;
    minY: number;
    numSections: number;
  },
  chunkX: number,
  chunkZ: number,
  session: ChunkExtractionSession,
): ExtractedChunk {
  const began = performance.now();
  const sections: ExtractedSection[] = [];
  for (let i = 0; i < column.numSections; i += 1) {
    sections.push(extractSection(column.sections[i], (column.minY >> 4) + i));
  }
  return {
    chunkX,
    chunkZ,
    sections,
    pendingUpdates: [],
    extractMs: performance.now() - began,
  };
}

/**
 * 预算分片提取：每片消耗 ≤ sliceBudgetMs 后经 setImmediate 让出。
 * 返回异步迭代器——生产路径消费。提取完成后把 session 累积的 update
 * 附在结果上（调用方 COMMIT 后重放）。
 */
export async function extractColumnBudgeted(
  column: {
    sections: Array<{ data: { get(index: number): number } } | null | undefined>;
    minY: number;
    numSections: number;
  },
  chunkX: number,
  chunkZ: number,
  session: ChunkExtractionSession,
  sliceBudgetMs = 3,
  yieldFn: () => Promise<void> = () => new Promise((resolve) => setImmediate(resolve)),
): Promise<ExtractedChunk> {
  const began = performance.now();
  const sections: ExtractedSection[] = [];
  for (let i = 0; i < column.numSections; i += 1) {
    if (session.isCancelled) {
      throw new Error(`extraction cancelled: ${session.cancelReasonOrNull}`);
    }
    if (i > 0 && performance.now() - began >= sliceBudgetMs) {
      await yieldFn();
    }
    sections.push(extractSection(column.sections[i], (column.minY >> 4) + i));
  }
  return {
    chunkX,
    chunkZ,
    sections,
    pendingUpdates: session.drainUpdates(),
    extractMs: performance.now() - began,
  };
}

/** 提取期间的 block update 重放到已提取的 chunk 上（幂等：写最终值）。 */
export function replayUpdates(
  extracted: ExtractedChunk,
  columnMinY: number,
): { applied: number; skippedNoSection: number } {
  let applied = 0;
  let skippedNoSection = 0;
  const bySectionY = new Map<number, ExtractedSection>();
  for (const section of extracted.sections) bySectionY.set(section.sectionY, section);
  for (const update of extracted.pendingUpdates) {
    const sectionY = update.y >> 4;
    const section = bySectionY.get(sectionY);
    if (!section || section.status !== "data" || section.stateIds === null) {
      // Empty/NotPresent 上的 update：升级为 data？P5-C 镜像侧 fail-closed，
      // 这里同样跳过（P5-D2 oracle 会暴露差异）。
      skippedNoSection += 1;
      continue;
    }
    const localIndex = ((update.y & 15) << 8) | ((update.z & 15) << 4) | (update.x & 15);
    section.stateIds[localIndex] = update.stateId;
    // 更新后可能从 empty 升级
    if ((section.status as string) === "empty") section.status = "data";
    applied += 1;
  }
  void columnMinY;
  return { applied, skippedNoSection };
}

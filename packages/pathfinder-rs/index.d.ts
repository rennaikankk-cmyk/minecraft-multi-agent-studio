declare module "@minecraft-studio/pathfinder-rs" {
  export const CLASS: Readonly<{
    PASSABLE: 0;
    SOLID: 1;
    DIGGABLE: 2;
    HAZARD: 3;
  }>;

  export interface WorldVolume {
    sx: number;
    sy: number;
    sz: number;
    /** 体素分类字节（sx*sy*sz，布局 [(y*sz+z)*sx+x]）。 */
    classes: Buffer;
  }

  export interface PathPoint {
    x: number;
    y: number;
    z: number;
  }

  export interface PathResult {
    success: boolean;
    visitedNodes: number;
    elapsedMs: number;
    path: PathPoint[];
  }

  export interface FindOptionsJs {
    maxNodes?: number;
    timeoutMs?: number;
    allowDig?: boolean;
    goalKind?: "point" | "near" | "classAdjacent";
    goalRadius?: number;
    goalClass?: number;
  }

  export function findPathAsync(input: {
    world: WorldVolume;
    start: PathPoint;
    goal: PathPoint;
    options?: FindOptionsJs | null;
  }): Promise<PathResult>;

  export function findPathSync(
    world: WorldVolume,
    start: PathPoint,
    goal: PathPoint,
    options?: FindOptionsJs | null,
  ): PathResult;

  // ------------------------------------------------------------------
  // P5-D2 WorldMirror 同步通道（与寻路共用 worker；唯一 sender 由
  // bot-runtime WorldSyncAdapter 保证）。epoch/序号=number（i64 边界）；
  // fingerprint=十进制字符串（完整 u64，TS 侧 BigInt 核对）。
  // ------------------------------------------------------------------

  export type MirrorAckStatus =
    | "applied"
    | "semanticRejected"
    | "ignoredDuplicate"
    | "ignoredStale"
    | "gapDesynced"
    | "protocolConflict"
    | "wrongEpoch"
    | "unsupportedProtocol"
    | "malformedEnvelope"
    | "resetRequired"
    | "queuedUntilCommit"
    | "resetApplied"
    | "registryReady"
    | "stopping"
    | "healthy";

  export interface MirrorAck {
    protocolVersion: number;
    sessionEpoch: number;
    dimensionEpoch: number;
    transportSequence: number;
    status: MirrorAckStatus;
    mirrorGeneration: number;
    registryRevision?: number | null;
    chunkRevision?: number | null;
    reason?: string | null;
    payloadFingerprint?: string | null;
    skippedUpdates?: number | null;
  }

  export interface MirrorHealth {
    desynced: boolean;
    stopped: boolean;
    loadedChunks: number;
    pendingImports: number;
    queuedUpdates: number;
    registryReady: boolean;
    registryRevision: number;
    lastTransportSequence: number;
    replayWindowLen: number;
    replayWindowFloor?: number | null;
    mirrorGeneration: number;
    skippedUpdatesTotal: number;
  }

  /** 宽松 tagged 信封（Rust 侧 fail-closed 解析；缺字段=malformedEnvelope）。 */
  export interface MirrorEnvelopeWire {
    protocolVersion: number;
    sessionEpoch: number;
    dimensionEpoch: number;
    transportSequence: number;
    message: MirrorMessageWire;
  }

  export type MirrorMessageWire =
    | ({ kind: "semanticRegistryV1"; selectors: Uint8Array } & SemanticScope)
    | {
        kind: "registryTable";
        revision: number;
        /** stateId→mask 全表（LE u32 字节流；Uint8Array view of Uint32Array）。 */
        masks: Uint8Array;
        minecraftVersion?: string;
        serverProfileId?: string;
      }
    | { kind: "chunkBegin"; chunkX: number; chunkZ: number }
    | {
        kind: "sectionData";
        chunkX: number;
        chunkZ: number;
        /** payload 三态扁平化（Rust 侧 tagged object）：data|empty|notPresent。 */
        payloadKind: "data" | "empty" | "notPresent" | "stateDataV1";
        stateIds?: Uint8Array;
        sectionY: number;
        fillStateId?: number;
        /** 长 4096 的 palette 索引（LE u16 字节流）。 */
        paletteIndices?: Uint8Array;
        paletteEntries?: number[];
      }
    | { kind: "chunkCommit"; chunkX: number; chunkZ: number }
    | { kind: "chunkUnload"; chunkX: number; chunkZ: number }
    | {
        kind: "blockUpdateBatch";
        sourceFirstSequence: number;
        sourceLastSequence: number;
        sourceEventCount: number;
        coalescedEventCount?: number;
        /** flat [x,y,z,stateId]×N。 */
        updatesFlat: number[];
      };

  export type MirrorControlWire =
    | {
        kind: "worldReset";
        newSessionEpoch: number;
        newDimensionEpoch: number;
        reason: "sessionRestart" | "dimensionChange" | "desyncRecovery" | "operatorRequest";
        resyncToken?: number;
      }
    | { kind: "stop" }
    | { kind: "healthProbe" };

  export function mirrorCreate(options: {
    sessionEpoch: number;
    dimensionEpoch: number;
    replayCapacity?: number | null;
  }): Promise<number>;

  /** transferList 可传 [paletteIndices.buffer]——传输后主线程视图立即 detached。 */
  export function mirrorSubmitEnvelope(
    handle: number,
    envelope: MirrorEnvelopeWire,
    transferList?: ArrayBuffer[],
  ): Promise<MirrorAck>;

  export function mirrorSubmitControl(handle: number, control: MirrorControlWire): Promise<MirrorAck>;

  export function mirrorHealth(handle: number): Promise<MirrorHealth>;

  export function mirrorDispose(handle: number): Promise<boolean>;

  /** 测试用：活镜像会话计数（idle 保活审计）。 */
  export function mirrorAliveSessions(): number;

  export interface SemanticScope {
    selectorRevision: 1;
    botSessionId: string;
    serverProfileId: string;
    dimension: string;
    minecraftVersion: string;
  }
  export interface SpatialQuery {
    queryId: string;
    sessionEpoch: number;
    dimensionEpoch: number;
    scope: SemanticScope;
    x: number; y: number; z: number;
    radius: number; count: number;
    selectors: number;
    /** each keeps count nearest points per selector; count * selected bits <=256. */
    matching: "union" | "intersection" | "each";
    maxVisits: number; maxMs: number;
  }
  export interface SpatialResult {
    queryId: string;
    sessionEpoch: number;
    dimensionEpoch: number;
    scope?: SemanticScope | null;
    generation: number;
    status: "complete" | "incomplete" | "budgetExceeded" | "invalidQuery" | "scopeMismatch" | "notReady" | "desynced";
    points: Array<{ x: number; y: number; z: number; selectors: number; distanceSquared: number }>;
    consultedChunks: Array<{ x: number; z: number; revision?: number | null; importing: boolean }>;
    visitedEntries: number;
    elapsedMs: number;
    snapshotBuildMs: number;
    snapshotChunkEntries: number;
  }
  export interface SpatialMemory {
    chunksLoaded: number; sectionsData: number; sectionsOther: number;
    paletteEntries: number; indexEntries: number;
    /** Estimate of current mirror payload/index allocation, not process RSS. */
    approxBytes: number;
  }
  export function mirrorSpatialQuery(handle: number, query: SpatialQuery): Promise<SpatialResult>;
  export function mirrorSpatialMemory(handle: number): Promise<SpatialMemory>;

  /** 显式回收 worker（测试 teardown；在途任务会 reject）。 */
  export function terminateWorker(): Promise<void>;
}

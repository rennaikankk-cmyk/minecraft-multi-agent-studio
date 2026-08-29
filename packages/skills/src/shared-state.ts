// ---------------------------------------------------------------------------
// Shared state control plane（Phase 5：Coordinator-backed 共享状态）
//
// 目标：Workstation/Facility 注册表从 InMemory（单进程）升级为跨进程共享。
// 架构：
//   - createSharedStateDispatcher(): op → handler 的纯映射，服务端与测试共用
//   - SharedStateClient: fetch 客户端，实现 MaybeAsync*Port（可 await）
//   - Coordinator 用 node:http 包一层 dispatcher 即成 HTTP 服务
//
// 契约：
//   1. RPC 信封 {op, args} → {ok:true, result} | {ok:false, error}
//   2. 错误信息不携带任何凭据（token/密码）；op 名是唯一日志面
//   3. 快照 {workstations:{entries}, facilities:{facilities}} 支持 GET/PUT 持久化
// ---------------------------------------------------------------------------

import {
  FacilityRegistry,
  type Facility,
  type FacilityRegistryPort,
  type FacilitySlot,
  type FacilityType,
  type Orientation,
  type PatternSlot,
} from "./facility-registry.js";
import {
  InMemoryWorkstationRegistry,
  type BlockPosition,
  type WorkstationEntry,
  type WorkstationRegistryPort,
  type WorkstationType,
} from "./workstation-registry.js";

// ---------------------------------------------------------------------------
// RPC 信封
// ---------------------------------------------------------------------------

export interface SharedStateRequest {
  readonly op: string;
  readonly args?: Record<string, unknown>;
}

export type SharedStateResponse =
  | Readonly<{ ok: true; result: unknown }>
  | Readonly<{ ok: false; error: string }>;

export interface SharedStateSnapshot {
  workstations: { entries: WorkstationEntry[] };
  facilities: { facilities: Facility[] };
}

// ---------------------------------------------------------------------------
// Dispatcher —— op → handler 纯映射（服务端内核，无 HTTP 依赖）
// ---------------------------------------------------------------------------

export type SharedStateHandler = (args: Record<string, unknown>) => unknown;

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new Error(`arg ${key} must be string`);
  return v;
}

function num(args: Record<string, unknown>, key: string): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`arg ${key} must be number`);
  return v;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  return args[key] === undefined ? undefined : num(args, key);
}

function pos(args: Record<string, unknown>, key = "position"): BlockPosition {
  const v = args[key] as Record<string, unknown> | undefined;
  if (!v || typeof v !== "object") throw new Error(`arg ${key} must be a position object`);
  return { x: num(v, "x"), y: num(v, "y"), z: num(v, "z") };
}

function int(args: Record<string, unknown>, key: string): number {
  const v = num(args, key);
  if (!Number.isInteger(v)) throw new Error(`arg ${key} must be integer`);
  return v;
}

export function createSharedStateDispatcher(
  workstations: WorkstationRegistryPort,
  facilities: FacilityRegistryPort,
): Readonly<Record<string, SharedStateHandler>> {
  return {
    // -- workstations --------------------------------------------------------
    "ws.register": (a) =>
      workstations.register(
        str(a, "serverProfileId"), str(a, "dimension"), str(a, "type") as WorkstationType,
        pos(a), a.confidence === undefined ? undefined : num(a, "confidence"),
      ),
    "ws.get": (a) => workstations.get(str(a, "serverProfileId"), str(a, "dimension"), pos(a)),
    "ws.findCandidates": (a) =>
      workstations.findCandidates(
        str(a, "serverProfileId"), str(a, "dimension"), str(a, "type") as WorkstationType,
        pos(a, "from"), optNum(a, "maxDistance"),
      ),
    "ws.claim": (a) =>
      workstations.claim(str(a, "serverProfileId"), str(a, "dimension"), pos(a), str(a, "botId"), optNum(a, "ttlMs")),
    "ws.renewClaim": (a) =>
      workstations.renewClaim(str(a, "serverProfileId"), str(a, "dimension"), pos(a), str(a, "botId"), optNum(a, "ttlMs")),
    "ws.release": (a) =>
      workstations.release(str(a, "serverProfileId"), str(a, "dimension"), pos(a), str(a, "botId")),
    "ws.invalidate": (a) => workstations.invalidate(str(a, "serverProfileId"), str(a, "dimension"), pos(a)),
    "ws.releaseAllClaims": (a) => workstations.releaseAllClaims(str(a, "botId")),
    "ws.clearServer": (a) => workstations.clearServer(str(a, "serverProfileId")),

    // -- facilities ----------------------------------------------------------
    "fac.create": (a) =>
      facilities.create({
        facilityType: str(a, "facilityType") as FacilityType,
        serverProfileId: str(a, "serverProfileId"),
        dimension: str(a, "dimension"),
        anchor: pos(a, "anchor"),
        orientation: str(a, "orientation") as Orientation,
        layoutVersion: str(a, "layoutVersion"),
        patternSlots: (a.patternSlots as PatternSlot[] | undefined) ?? [],
        ...(a.discovery === undefined ? {} : { discovery: str(a, "discovery") as "planned" | "observed_existing" }),
        ...(a.baseId === undefined ? {} : { baseId: str(a, "baseId") }),
      }),
    "fac.get": (a) => facilities.get(str(a, "facilityId")),
    "fac.findCandidates": (a) =>
      facilities.findCandidates(
        str(a, "serverProfileId"), str(a, "dimension"),
        str(a, "facilityType") as FacilityType, pos(a, "reference"),
      ),
    "fac.findByBase": (a) => facilities.findByBase(str(a, "baseId")),
    "fac.nextPlannableSlot": (a) => facilities.nextPlannableSlot(str(a, "facilityId")),
    "fac.reserveSlot": (a) =>
      facilities.reserveSlot(str(a, "facilityId"), int(a, "slotIndex"), str(a, "botId"), optNum(a, "ttlMs")),
    "fac.releaseReservation": (a) =>
      facilities.releaseReservation(
        str(a, "facilityId"), int(a, "slotIndex"), str(a, "reason"),
        a.botId === undefined ? undefined : str(a, "botId"),
      ),
    "fac.renewSlotReservation": (a) =>
      facilities.renewSlotReservation(str(a, "facilityId"), int(a, "slotIndex"), str(a, "botId"), optNum(a, "ttlMs")),
    "fac.markSlotOccupied": (a) =>
      facilities.markSlotOccupied(
        str(a, "facilityId"), int(a, "slotIndex"), str(a, "workstationEntryKey"),
        a.reservationOwner === undefined ? undefined : { reservationOwner: str(a, "reservationOwner") },
      ),
    "fac.markPlacementFailed": (a) =>
      facilities.markPlacementFailed(str(a, "facilityId"), int(a, "slotIndex"), str(a, "reason"), str(a, "botId")),
    "fac.markSlotMissing": (a) =>
      facilities.markSlotMissing(str(a, "facilityId"), int(a, "slotIndex"), str(a, "reason")),
    "fac.markSlotTemporarilyBlocked": (a) =>
      facilities.markSlotTemporarilyBlocked(str(a, "facilityId"), int(a, "slotIndex"), str(a, "reason")),
    "fac.markSlotInvalid": (a) =>
      facilities.markSlotInvalid(str(a, "facilityId"), int(a, "slotIndex"), str(a, "reason")),
    "fac.replanSlot": (a) => facilities.replanSlot(str(a, "facilityId"), int(a, "slotIndex")),
    "fac.observeSlot": (a) =>
      facilities.observeSlot(
        str(a, "facilityId"), int(a, "slotIndex"),
        {
          blockPresent: a.blockPresent === true,
          blockName: a.blockName === undefined || a.blockName === null ? null : str(a, "blockName"),
        },
      ),
    "fac.expireReservations": (a) => facilities.expireReservations(str(a, "facilityId")),
  };
}

export function dispatchSharedState(
  dispatcher: Readonly<Record<string, SharedStateHandler>>,
  request: SharedStateRequest,
): SharedStateResponse {
  const handler = dispatcher[request.op];
  if (!handler) return { ok: false, error: `unknown_op:${request.op}` };
  try {
    return { ok: true, result: handler(request.args ?? {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "dispatch_failed" };
  }
}

// ---------------------------------------------------------------------------
// 快照（Phase 6 持久化基础）
// ---------------------------------------------------------------------------

export function captureSharedStateSnapshot(
  workstations: InMemoryWorkstationRegistry,
  facilities: FacilityRegistry,
): SharedStateSnapshot {
  return {
    workstations: { entries: workstations.serialize().entries },
    facilities: { facilities: [...facilities.serialize().facilities] },
  };
}

export function restoreSharedStateSnapshot(
  snapshot: SharedStateSnapshot,
): { workstations: InMemoryWorkstationRegistry; facilities: FacilityRegistry } {
  return {
    workstations: InMemoryWorkstationRegistry.restore({ entries: snapshot.workstations?.entries ?? [] }),
    facilities: FacilityRegistry.restore({ facilities: snapshot.facilities?.facilities ?? [] }),
  };
}

// ---------------------------------------------------------------------------
// MaybeAsync Port —— InMemory（同步）与 Remote（异步）共同满足，调用方统一 await
// ---------------------------------------------------------------------------

export type Maybe<T> = T | Promise<T>;

export interface MaybeAsyncWorkstationRegistryPort {
  register(serverProfileId: string, dimension: string, type: WorkstationType, position: { x: number; y: number; z: number }, confidence?: number): Maybe<WorkstationEntry>;
  get(serverProfileId: string, dimension: string, position: BlockPosition): Maybe<WorkstationEntry | null>;
  findCandidates(serverProfileId: string, dimension: string, type: WorkstationType, from: { x: number; y: number; z: number }, maxDistance?: number): Maybe<readonly WorkstationEntry[]>;
  claim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number): Maybe<boolean>;
  renewClaim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number): Maybe<boolean>;
  release(serverProfileId: string, dimension: string, position: BlockPosition, botId: string): Maybe<void>;
  invalidate(serverProfileId: string, dimension: string, position: BlockPosition): Maybe<void>;
  releaseAllClaims(botId: string): Maybe<void>;
  clearServer(serverProfileId: string): Maybe<void>;
}

export interface MaybeAsyncFacilityRegistryPort {
  create(params: Readonly<{
    facilityType: FacilityType;
    serverProfileId: string;
    dimension: string;
    anchor: BlockPosition;
    orientation: Orientation;
    layoutVersion: string;
    patternSlots: readonly PatternSlot[];
    discovery?: "planned" | "observed_existing";
    baseId?: string;
  }>): Maybe<Facility>;
  get(facilityId: string): Maybe<Facility | null>;
  findCandidates(serverProfileId: string, dimension: string, facilityType: FacilityType, reference: BlockPosition): Maybe<readonly Facility[]>;
  findByBase(baseId: string): Maybe<readonly Facility[]>;
  nextPlannableSlot(facilityId: string): Maybe<FacilitySlot | null>;
  reserveSlot(facilityId: string, slotIndex: number, botId: string, ttlMs?: number): Maybe<boolean>;
  releaseReservation(facilityId: string, slotIndex: number, reason: string, botId?: string): Maybe<boolean>;
  renewSlotReservation(facilityId: string, slotIndex: number, botId: string, ttlMs?: number): Maybe<boolean>;
  markSlotOccupied(facilityId: string, slotIndex: number, workstationEntryKey: string, opts?: Readonly<{ reservationOwner?: string }>): Maybe<boolean>;
  markPlacementFailed(facilityId: string, slotIndex: number, reason: string, botId: string): Maybe<boolean>;
  markSlotMissing(facilityId: string, slotIndex: number, reason: string): Maybe<boolean>;
  markSlotTemporarilyBlocked(facilityId: string, slotIndex: number, reason: string): Maybe<boolean>;
  markSlotInvalid(facilityId: string, slotIndex: number, reason: string): Maybe<boolean>;
  replanSlot(facilityId: string, slotIndex: number): Maybe<boolean>;
  observeSlot(facilityId: string, slotIndex: number, observation: Readonly<{ blockPresent: boolean; blockName: string | null }>): Maybe<boolean>;
  expireReservations(facilityId: string): Maybe<number>;
}

// ---------------------------------------------------------------------------
// SharedStateClient —— 远端适配器（fetch 到 coordinator）
// ---------------------------------------------------------------------------

export interface SharedStateClientOptions {
  /** 例如 http://127.0.0.1:8791 */
  readonly baseUrl: string;
  /** 可选 Bearer token（STUDIO_SHARED_STATE_TOKEN，只存内存，永不外泄到日志）。 */
  readonly token?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: { warn(message: string, meta?: unknown): void };
}

export class SharedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharedStateError";
  }
}

export class SharedStateClient {
  private readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly doFetch: typeof fetch;
  private readonly timeoutMs: number;
  private readonly logger: SharedStateClientOptions["logger"];

  /** 满足 MaybeAsyncWorkstationRegistryPort 的视图（依赖注入用）。 */
  readonly workstations: MaybeAsyncWorkstationRegistryPort;
  /** 满足 MaybeAsyncFacilityRegistryPort 的视图（依赖注入用）。 */
  readonly facilities: MaybeAsyncFacilityRegistryPort;

  constructor(options: SharedStateClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.doFetch = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.logger = options.logger;
    this.workstations = {
      register: (serverProfileId, dimension, type, position, confidence) =>
        this.#rpc("ws.register", { serverProfileId, dimension, type, position, confidence }) as Promise<WorkstationEntry>,
      get: (serverProfileId, dimension, position) =>
        this.#rpc("ws.get", { serverProfileId, dimension, position }) as Promise<WorkstationEntry | null>,
      findCandidates: (serverProfileId, dimension, type, from, maxDistance) =>
        this.#rpc("ws.findCandidates", { serverProfileId, dimension, type, from, maxDistance }) as Promise<readonly WorkstationEntry[]>,
      claim: (serverProfileId, dimension, position, botId, ttlMs) =>
        this.#rpc("ws.claim", { serverProfileId, dimension, position, botId, ttlMs }) as Promise<boolean>,
      renewClaim: (serverProfileId, dimension, position, botId, ttlMs) =>
        this.#rpc("ws.renewClaim", { serverProfileId, dimension, position, botId, ttlMs }) as Promise<boolean>,
      release: (serverProfileId, dimension, position, botId) =>
        this.#rpc("ws.release", { serverProfileId, dimension, position, botId }) as Promise<void>,
      invalidate: (serverProfileId, dimension, position) =>
        this.#rpc("ws.invalidate", { serverProfileId, dimension, position }) as Promise<void>,
      releaseAllClaims: (botId) =>
        this.#rpc("ws.releaseAllClaims", { botId }) as Promise<void>,
      clearServer: (serverProfileId) =>
        this.#rpc("ws.clearServer", { serverProfileId }) as Promise<void>,
    };
    this.facilities = {
      create: (params) => this.#rpc("fac.create", params as unknown as Record<string, unknown>) as Promise<Facility>,
      get: (facilityId) => this.#rpc("fac.get", { facilityId }) as Promise<Facility | null>,
      findCandidates: (serverProfileId, dimension, facilityType, reference) =>
        this.#rpc("fac.findCandidates", { serverProfileId, dimension, facilityType, reference }) as Promise<readonly Facility[]>,
      findByBase: (baseId) =>
        this.#rpc("fac.findByBase", { baseId }) as Promise<readonly Facility[]>,
      nextPlannableSlot: (facilityId) =>
        this.#rpc("fac.nextPlannableSlot", { facilityId }) as Promise<FacilitySlot | null>,
      reserveSlot: (facilityId, slotIndex, botId, ttlMs) =>
        this.#rpc("fac.reserveSlot", { facilityId, slotIndex, botId, ttlMs }) as Promise<boolean>,
      releaseReservation: (facilityId, slotIndex, reason, botId) =>
        this.#rpc("fac.releaseReservation", { facilityId, slotIndex, reason, botId }) as Promise<boolean>,
      renewSlotReservation: (facilityId, slotIndex, botId, ttlMs) =>
        this.#rpc("fac.renewSlotReservation", { facilityId, slotIndex, botId, ttlMs }) as Promise<boolean>,
      markSlotOccupied: (facilityId, slotIndex, workstationEntryKey, opts) =>
        this.#rpc("fac.markSlotOccupied", { facilityId, slotIndex, workstationEntryKey, reservationOwner: opts?.reservationOwner }) as Promise<boolean>,
      markPlacementFailed: (facilityId, slotIndex, reason, botId) =>
        this.#rpc("fac.markPlacementFailed", { facilityId, slotIndex, reason, botId }) as Promise<boolean>,
      markSlotMissing: (facilityId, slotIndex, reason) =>
        this.#rpc("fac.markSlotMissing", { facilityId, slotIndex, reason }) as Promise<boolean>,
      markSlotTemporarilyBlocked: (facilityId, slotIndex, reason) =>
        this.#rpc("fac.markSlotTemporarilyBlocked", { facilityId, slotIndex, reason }) as Promise<boolean>,
      markSlotInvalid: (facilityId, slotIndex, reason) =>
        this.#rpc("fac.markSlotInvalid", { facilityId, slotIndex, reason }) as Promise<boolean>,
      replanSlot: (facilityId, slotIndex) =>
        this.#rpc("fac.replanSlot", { facilityId, slotIndex }) as Promise<boolean>,
      observeSlot: (facilityId, slotIndex, observation) =>
        this.#rpc("fac.observeSlot", { facilityId, slotIndex, ...observation }) as Promise<boolean>,
      expireReservations: (facilityId) =>
        this.#rpc("fac.expireReservations", { facilityId }) as Promise<number>,
    };
  }

  async #rpc(op: string, args?: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await this.doFetch(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers,
        body: JSON.stringify({ op, args }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        throw new SharedStateError("unauthorized");
      }
      if (!response.ok) {
        throw new SharedStateError(`http_${response.status}`);
      }
      const envelope = (await response.json()) as SharedStateResponse;
      if (!envelope.ok) throw new SharedStateError(envelope.error);
      return envelope.result;
    } catch (error) {
      if (error instanceof SharedStateError) throw error;
      if (this.logger) this.logger.warn("shared_state_rpc_failed", { op });
      throw new SharedStateError(`rpc_failed:${op}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async snapshot(): Promise<SharedStateSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = {};
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      const response = await this.doFetch(`${this.baseUrl}/snapshot`, { headers, signal: controller.signal });
      if (!response.ok) throw new SharedStateError(`http_${response.status}`);
      return (await response.json()) as SharedStateSnapshot;
    } finally {
      clearTimeout(timer);
    }
  }

  // -- workstations ----------------------------------------------------------
  register(serverProfileId: string, dimension: string, type: WorkstationType, position: { x: number; y: number; z: number }, confidence?: number) {
    return this.#rpc("ws.register", { serverProfileId, dimension, type, position, confidence });
  }
  get(serverProfileId: string, dimension: string, position: BlockPosition) {
    return this.#rpc("ws.get", { serverProfileId, dimension, position });
  }
  findCandidates(serverProfileId: string, dimension: string, type: WorkstationType, from: { x: number; y: number; z: number }, maxDistance?: number) {
    return this.#rpc("ws.findCandidates", { serverProfileId, dimension, type, from, maxDistance });
  }
  claim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number) {
    return this.#rpc("ws.claim", { serverProfileId, dimension, position, botId, ttlMs }) as Promise<boolean>;
  }
  renewClaim(serverProfileId: string, dimension: string, position: BlockPosition, botId: string, ttlMs?: number) {
    return this.#rpc("ws.renewClaim", { serverProfileId, dimension, position, botId, ttlMs }) as Promise<boolean>;
  }
  release(serverProfileId: string, dimension: string, position: BlockPosition, botId: string) {
    return this.#rpc("ws.release", { serverProfileId, dimension, position, botId });
  }
  invalidate(serverProfileId: string, dimension: string, position: BlockPosition) {
    return this.#rpc("ws.invalidate", { serverProfileId, dimension, position });
  }
  releaseAllClaims(botId: string) {
    return this.#rpc("ws.releaseAllClaims", { botId });
  }
  clearServer(serverProfileId: string) {
    return this.#rpc("ws.clearServer", { serverProfileId });
  }

  // -- facilities -------------------------------------------------------------
  create(params: {
    facilityType: FacilityType;
    serverProfileId: string;
    dimension: string;
    anchor: BlockPosition;
    orientation: Orientation;
    layoutVersion: string;
    patternSlots: readonly PatternSlot[];
    discovery?: "planned" | "observed_existing";
  }) {
    return this.#rpc("fac.create", params as unknown as Record<string, unknown>) as Promise<Facility>;
  }
  getFacility(facilityId: string) {
    return this.#rpc("fac.get", { facilityId }) as Promise<Facility | null>;
  }
  findFacilities(serverProfileId: string, dimension: string, facilityType: FacilityType, reference: BlockPosition) {
    return this.#rpc("fac.findCandidates", { serverProfileId, dimension, facilityType, reference }) as Promise<readonly Facility[]>;
  }
  nextPlannableSlot(facilityId: string) {
    return this.#rpc("fac.nextPlannableSlot", { facilityId }) as Promise<FacilitySlot | null>;
  }
  reserveSlot(facilityId: string, slotIndex: number, botId: string, ttlMs?: number) {
    return this.#rpc("fac.reserveSlot", { facilityId, slotIndex, botId, ttlMs }) as Promise<boolean>;
  }
  releaseReservation(facilityId: string, slotIndex: number, reason: string, botId?: string) {
    return this.#rpc("fac.releaseReservation", { facilityId, slotIndex, reason, botId }) as Promise<boolean>;
  }
  renewSlotReservation(facilityId: string, slotIndex: number, botId: string, ttlMs?: number) {
    return this.#rpc("fac.renewSlotReservation", { facilityId, slotIndex, botId, ttlMs }) as Promise<boolean>;
  }
  markSlotOccupied(facilityId: string, slotIndex: number, workstationEntryKey: string, opts?: { reservationOwner?: string }) {
    return this.#rpc("fac.markSlotOccupied", { facilityId, slotIndex, workstationEntryKey, reservationOwner: opts?.reservationOwner }) as Promise<boolean>;
  }
  markPlacementFailed(facilityId: string, slotIndex: number, reason: string, botId: string) {
    return this.#rpc("fac.markPlacementFailed", { facilityId, slotIndex, reason, botId }) as Promise<boolean>;
  }
  findByBase(baseId: string) {
    return this.#rpc("fac.findByBase", { baseId }) as Promise<readonly Facility[]>;
  }
  markSlotMissing(facilityId: string, slotIndex: number, reason: string) {
    return this.#rpc("fac.markSlotMissing", { facilityId, slotIndex, reason }) as Promise<boolean>;
  }
  markSlotTemporarilyBlocked(facilityId: string, slotIndex: number, reason: string) {
    return this.#rpc("fac.markSlotTemporarilyBlocked", { facilityId, slotIndex, reason }) as Promise<boolean>;
  }
  markSlotInvalid(facilityId: string, slotIndex: number, reason: string) {
    return this.#rpc("fac.markSlotInvalid", { facilityId, slotIndex, reason }) as Promise<boolean>;
  }
  replanSlot(facilityId: string, slotIndex: number) {
    return this.#rpc("fac.replanSlot", { facilityId, slotIndex }) as Promise<boolean>;
  }
  observeSlot(facilityId: string, slotIndex: number, observation: { blockPresent: boolean; blockName: string | null }) {
    return this.#rpc("fac.observeSlot", { facilityId, slotIndex, ...observation }) as Promise<boolean>;
  }
  expireReservations(facilityId: string) {
    return this.#rpc("fac.expireReservations", { facilityId }) as Promise<number>;
  }
}

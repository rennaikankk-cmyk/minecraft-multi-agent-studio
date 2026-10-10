import type { SpatialQuery, SpatialResult } from "@minecraft-studio/pathfinder-rs";
import type { WorldSyncQueryContext } from "./world-sync-adapter.js";
import type { WorldPosition } from "./world-state.js";

export type WorldQueryRequest = Readonly<{
  origin: WorldPosition;
  radius: number;
  count: number;
  selectors: number;
  matching: SpatialQuery["matching"];
}>;
export type WorldQueryStatus = "FRESH" | "STALE_ALLOWED" | "INCOMPLETE" | "DESYNCED" | "UNAVAILABLE";
export type WorldQueryReason = "pendingUpdates" | "notReady" | "scopeChanged" | "cancelled" | "timeout" |
  "queueFull" | "workerError" | "incomplete" | "budgetExceeded" | "invalidQuery" | "stale" | null;
export type WorldQueryView = Readonly<{
  status: WorldQueryStatus;
  reason: WorldQueryReason;
  source: "rust-spatial-index";
  capturedAtMs: number | null;
  staleAgeMs: number | null;
  dirtySinceMs: number | null;
  sourceRevision: number | null;
  generation: number | null;
  complete: boolean;
  bounds: WorldQueryRequest;
  result: SpatialResult | null;
}>;
type QueryPort = {
  context(): WorldSyncQueryContext | null;
  query(input: Omit<SpatialQuery, "scope" | "sessionEpoch" | "dimensionEpoch">, signal: AbortSignal): Promise<SpatialResult>;
  now(): number;
  onFailure?(reason: WorldQueryReason): void;
  onCompleted?(view: WorldQueryView): void;
  span?(name: string, ms: number): void;
};
type Cached = { identity: string; revision: number; capturedAtMs: number; request: WorldQueryRequest; result: SpatialResult };
type Job = { key: string; request: WorldQueryRequest; context: WorldSyncQueryContext; identity: string; epoch: number;
  promise: Promise<WorldQueryView>; resolve(value: WorldQueryView): void };
// 复合键用 NUL 分隔：字段类型均为标识符/数字/三值枚举，不可能含 NUL，
// 拼接与 JSON.stringify 等价无碰撞。identity/key 在评估链每拍多次调用，
// 省掉小对象序列化。
const identity = (context: WorldSyncQueryContext) =>
  `${context.scope.selectorRevision}\u0000${context.scope.botSessionId}\u0000${context.scope.serverProfileId}` +
  `\u0000${context.scope.dimension}\u0000${context.scope.minecraftVersion}\u0000${context.sessionEpoch}\u0000${context.dimensionEpoch}`;
const canonical = (request: WorldQueryRequest): WorldQueryRequest => ({ ...request, origin: { ...request.origin,
  x: Math.floor(request.origin.x), y: Math.floor(request.origin.y), z: Math.floor(request.origin.z) } });

/** Shared bounded worker admission. Reading never waits or invokes a legacy scan. */
export class WorldQueryProvider {
  private epoch = 0;
  private querySequence = 0;
  private active: { job: Job; controller: AbortController } | null = null;
  private queue: Job[] = [];
  private shared = new Map<string, Job>();
  private cache = new Map<string, Cached>();
  private retryAfterMs = 0;
  private lastFailure: WorldQueryReason = null;
  private stopped = false;
  private metrics = { requests: 0, cacheHits: 0, sharedRequests: 0, workerQueries: 0, failures: 0,
    invalidated: 0, cancelled: 0, queueMax: 0, completed: 0 };

  constructor(private readonly port: QueryPort, private readonly options: {
    freshMs?: number; maxStaleMs?: number; timeoutMs?: number; maxQueue?: number; maxCache?: number;
  } = {}) {}

  getMetrics() { return { ...this.metrics, queueDepth: this.queue.length, inFlight: this.active === null ? 0 : 1,
    cacheEntries: this.cache.size, lastFailure: this.lastFailure }; }

  private key(request: WorldQueryRequest): string {
    const { origin } = request;
    return `${origin.x}\u0000${origin.y}\u0000${origin.z}\u0000${origin.dimension}\u0000${origin.serverProfileId}` +
      `\u0000${request.radius}\u0000${request.count}\u0000${request.selectors}\u0000${request.matching}`;
  }

  private unavailable(request: WorldQueryRequest, reason: WorldQueryReason, context = this.port.context()): WorldQueryView {
    return { status: reason === "incomplete" ? "INCOMPLETE" : context?.state === "desynced" || context?.state === "degraded" ? "DESYNCED" : "UNAVAILABLE",
      reason, source: "rust-spatial-index", capturedAtMs: null, staleAgeMs: null, dirtySinceMs: context?.changedAtMs || null,
      sourceRevision: context?.sourceRevision ?? null, generation: null, complete: false, bounds: request, result: null };
  }

  private matches(context: WorldSyncQueryContext | null, request: WorldQueryRequest): context is WorldSyncQueryContext {
    return context !== null && context.scope.serverProfileId === request.origin.serverProfileId &&
      context.scope.dimension === request.origin.dimension && !["stopped", "stopping", "degraded", "desynced"].includes(context.state);
  }

  private cachedView(request: WorldQueryRequest): WorldQueryView | null {
    const context = this.port.context();
    const cached = this.cache.get(this.key(request));
    if (!cached || !this.matches(context, request) || cached.identity !== identity(context)) return null;
    const age = this.port.now() - cached.capturedAtMs;
    if (age < 0 || age > (this.options.maxStaleMs ?? 3_000)) return null;
    const clean = context.settled && cached.revision === context.sourceRevision;
    const fresh = clean && age <= (this.options.freshMs ?? 1_000);
    return { status: cached.result.status !== "complete" ? "INCOMPLETE" : fresh ? "FRESH" : "STALE_ALLOWED",
      reason: cached.result.status !== "complete" ? "incomplete" : fresh ? null : clean ? "stale" : "pendingUpdates",
      source: "rust-spatial-index", capturedAtMs: cached.capturedAtMs, staleAgeMs: age,
      dirtySinceMs: clean ? null : context.changedAtMs, sourceRevision: cached.revision,
      generation: cached.result.generation, complete: fresh && cached.result.status === "complete", bounds: request, result: cached.result };
  }

  private reusable(view: WorldQueryView | null): boolean {
    return view !== null && view.dirtySinceMs === null && view.staleAgeMs !== null &&
      view.staleAgeMs <= (this.options.freshMs ?? 1_000) && ["FRESH", "INCOMPLETE"].includes(view.status);
  }

  read(input: WorldQueryRequest): WorldQueryView {
    const request = canonical(input);
    const cached = this.cachedView(request);
    if (this.reusable(cached)) { this.metrics.cacheHits++; return cached!; }
    void this.query(request);
    return cached ?? this.unavailable(request, this.lastFailure ?? "notReady");
  }

  /** Identical callers receive the same underlying Promise; one cancellation detaches only that caller. */
  query(input: WorldQueryRequest, signal?: AbortSignal): Promise<WorldQueryView> {
    const request = canonical(input);
    this.metrics.requests++;
    if (signal?.aborted) return Promise.resolve(this.unavailable(request, "cancelled"));
    const cached = this.cachedView(request);
    if (this.reusable(cached)) { this.metrics.cacheHits++; return Promise.resolve(cached!); }
    const key = this.key(request);
    const previous = this.shared.get(key);
    if (previous) { this.metrics.sharedRequests++; return this.detachOnCancel(previous.promise, request, signal); }
    const context = this.port.context();
    if (this.stopped || !this.matches(context, request)) return Promise.resolve(this.unavailable(request, "notReady", context));
    if (!context.settled) return Promise.resolve(this.unavailable(request, "pendingUpdates", context));
    if (this.port.now() < this.retryAfterMs) return Promise.resolve(this.unavailable(request, this.lastFailure, context));
    if (this.queue.length >= (this.options.maxQueue ?? 8)) return Promise.resolve(this.unavailable(request, "queueFull", context));
    let resolve!: Job["resolve"];
    const promise = new Promise<WorldQueryView>((done) => { resolve = done; });
    const job: Job = { key, request, context, identity: identity(context), epoch: this.epoch, promise, resolve };
    this.shared.set(key, job);
    this.queue.push(job);
    this.metrics.queueMax = Math.max(this.metrics.queueMax, this.queue.length);
    void this.drain();
    return this.detachOnCancel(promise, request, signal);
  }

  private detachOnCancel(promise: Promise<WorldQueryView>, request: WorldQueryRequest, signal?: AbortSignal): Promise<WorldQueryView> {
    if (!signal) return promise;
    return new Promise((resolve) => {
      const abort = () => { this.metrics.cancelled++; resolve(this.unavailable(request, "cancelled")); };
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
      void promise.then(resolve).finally(() => signal.removeEventListener("abort", abort));
    });
  }

  reset(stopped = false): void {
    this.epoch++;
    this.stopped = stopped;
    this.cache.clear();
    this.active?.job.resolve(this.unavailable(this.active.job.request, "scopeChanged"));
    this.active?.controller.abort();
    for (const job of this.queue) job.resolve(this.unavailable(job.request, "scopeChanged"));
    this.queue = [];
    this.shared.clear();
    this.retryAfterMs = 0;
    this.lastFailure = null;
  }

  private async drain(): Promise<void> {
    if (this.active || this.stopped) return;
    const job = this.queue.shift();
    if (!job) return;
    const controller = new AbortController();
    this.active = { job, controller };
    const began = this.port.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      const before = this.port.context();
      if (!this.matches(before, job.request) || identity(before) !== job.identity || !before.settled || before.sourceRevision !== job.context.sourceRevision) {
        this.metrics.invalidated++;
        job.resolve(this.unavailable(job.request, "pendingUpdates"));
        return;
      }
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => { timedOut = true; reject(new Error("timeout")); controller.abort(); }, this.options.timeoutMs ?? 2_000);
      });
      this.metrics.workerQueries++;
      const result = await Promise.race([this.port.query({ queryId: `provider-${this.epoch}-${++this.querySequence}`,
        x: job.request.origin.x, y: job.request.origin.y, z: job.request.origin.z,
        radius: job.request.radius, count: job.request.count, selectors: job.request.selectors, matching: job.request.matching,
        maxVisits: 131_072, maxMs: 10 }, controller.signal), timeout]);
      const after = this.port.context();
      if (job.epoch !== this.epoch || !this.matches(after, job.request) || identity(after) !== job.identity ||
          !after.settled || after.sourceRevision !== before.sourceRevision) {
        this.metrics.invalidated++;
        job.resolve(this.unavailable(job.request, "scopeChanged"));
        return;
      }
      if (!["complete", "incomplete"].includes(result.status)) {
        const reason: WorldQueryReason = result.status === "budgetExceeded" ? "budgetExceeded" : result.status === "invalidQuery" ? "invalidQuery" : "notReady";
        this.recordFailure(reason);
        job.resolve(this.unavailable(job.request, reason));
        return;
      }
      this.cache.delete(job.key);
      for (const point of result.points) Object.freeze(point);
      for (const chunk of result.consultedChunks) Object.freeze(chunk);
      Object.freeze(result.points); Object.freeze(result.consultedChunks);
      if (result.scope) Object.freeze(result.scope);
      Object.freeze(result);
      this.cache.set(job.key, { identity: job.identity, revision: before.sourceRevision, capturedAtMs: began, request: job.request, result });
      while (this.cache.size > (this.options.maxCache ?? 16)) this.cache.delete(this.cache.keys().next().value!);
      this.metrics.completed++;
      this.lastFailure = null;
      const view = this.cachedView(job.request) ?? this.unavailable(job.request, "stale");
      job.resolve(view);
      this.port.onCompleted?.(view);
    } catch (error) {
      const reason: WorldQueryReason = job.epoch !== this.epoch ? "scopeChanged" :
        timedOut || error instanceof Error && /timeout/u.test(error.message) ? "timeout" : "workerError";
      if (job.epoch === this.epoch) this.recordFailure(reason);
      job.resolve(this.unavailable(job.request, reason));
    } finally {
      clearTimeout(timer);
      this.port.span?.("world.query.worker_round_trip", this.port.now() - began);
      if (this.shared.get(job.key) === job) this.shared.delete(job.key);
      this.active = null;
      void this.drain();
    }
  }

  private recordFailure(reason: WorldQueryReason): void {
    this.metrics.failures++;
    this.lastFailure = reason;
    this.retryAfterMs = this.port.now() + 1_000;
    this.port.onFailure?.(reason);
  }
}

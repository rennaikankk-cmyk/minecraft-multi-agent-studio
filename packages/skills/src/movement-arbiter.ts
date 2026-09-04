/**
 * Single-owner movement arbitration.
 *
 * Mineflayer exposes several APIs that can move a bot (pathfinder,
 * collectblock, combat/flee controllers, and direct control states).  This
 * module deliberately has no Mineflayer dependency: the runtime owns the
 * driver, while this class owns the one movement lease and its cancellation
 * token.  A lower numeric priority wins (P0 is the highest priority).
 */

/** 租约 TTL：超龄的旧租约在下次 acquire 时过期释放（防泄漏永久化）。 */
const MOVEMENT_LEASE_TTL_MS = 60_000;

export const MOVEMENT_PRIORITIES = Object.freeze({
  EMERGENCY: 0,
  COMBAT: 10,
  ESCAPE: 20,
  RECOVERY: 30,
  TASK_NAVIGATION: 40,
  FOLLOW: 50,
  EXPLORE: 60,
  IDLE: 80,
} as const);

/** Lower numeric values represent higher priority. */
export const movementPriorities = MOVEMENT_PRIORITIES;

export type MovementPriorityName = keyof typeof MOVEMENT_PRIORITIES;
export type MovementPriority = number;
export type MovementPriorityInput = MovementPriority | MovementPriorityName;

export type MovementLeaseState =
  | "active"
  | "released"
  | "cancelled"
  | "preempted";

export type MovementLeaseEndReason =
  | "released"
  | "completed"
  | "cancelled"
  | "parent_cancelled"
  | "preempted"
  | "shutdown"
  | (string & {});

export type MovementLeaseSnapshot = Readonly<{
  leaseId: string;
  token: string;
  owner: string;
  priority: number;
  taskId?: string;
  goal?: unknown;
  metadata?: Readonly<Record<string, unknown>>;
  acquiredAt: number;
  state: MovementLeaseState;
}>;

export type MovementLeaseEvent = Readonly<{
  lease: MovementLeaseSnapshot;
  reason: MovementLeaseEndReason;
  at: number;
  replacement?: MovementLeaseSnapshot;
}>;

export type MovementLeasePreemptHandler = (event: MovementLeaseEvent) => void;
export type MovementLeaseReleaseHandler = (event: MovementLeaseEvent) => void;

export type MovementLeaseRequest = Readonly<{
  /** Stable owner name, for example `task:abc` or `combat:reflex`. */
  owner: string;
  /** Lower values win. Use MOVEMENT_PRIORITIES for standard owners. */
  priority: MovementPriorityInput;
  taskId?: string;
  goal?: unknown;
  metadata?: Readonly<Record<string, unknown>>;
  /** Aborting this signal releases the lease and invalidates its token. */
  signal?: AbortSignal;
  /** Synchronous cleanup invoked before a higher-priority owner takes over. */
  onPreempt?: MovementLeasePreemptHandler;
  /** Synchronous cleanup invoked for cancellation/release as well. */
  onRelease?: MovementLeaseReleaseHandler;
}>;

export type MovementArbiterOptions = Readonly<{
  now?: () => number;
  leaseId?: () => string;
  token?: () => string;
  onPreempt?: MovementLeasePreemptHandler;
  onRelease?: MovementLeaseReleaseHandler;
  onChange?: (lease: MovementLeaseSnapshot | null) => void;
}>;

export interface MovementLease {
  readonly leaseId: string;
  readonly token: string;
  readonly owner: string;
  readonly priority: number;
  readonly taskId: string | undefined;
  readonly goal: unknown;
  readonly metadata: Readonly<Record<string, unknown>> | undefined;
  readonly acquiredAt: number;
  readonly signal: AbortSignal;
  readonly state: MovementLeaseState;
  /** True only while this exact token owns the arbiter. */
  isCurrent(): boolean;
  /** Throws when a callback belongs to a preempted/released movement. */
  assertCurrent(): void;
  /** Releases this lease when it is still the current owner. */
  release(reason?: MovementLeaseEndReason): boolean;
  /** Alias for release with a cancellation reason. */
  cancel(reason?: MovementLeaseEndReason): boolean;
}

export class MovementLeaseUnavailableError extends Error {
  readonly code = "MOVEMENT_LEASE_UNAVAILABLE" as const;

  constructor(
    readonly requestedOwner: string,
    readonly requestedPriority: number,
    readonly currentOwner: string | null,
    readonly currentPriority: number | null,
  ) {
    super(
      currentOwner === null
        ? "Movement lease is unavailable."
        : `Movement is owned by ${currentOwner} at priority ${currentPriority}.`,
    );
    this.name = "MovementLeaseUnavailableError";
  }
}

export class StaleMovementLeaseError extends Error {
  readonly code = "STALE_MOVEMENT_LEASE" as const;

  constructor() {
    super("Movement lease is no longer current.");
    this.name = "StaleMovementLeaseError";
  }
}

type LeaseEndState = Exclude<MovementLeaseState, "active">;

function priorityValue(priority: MovementPriorityInput): number {
  if (typeof priority === "string") {
    const value = MOVEMENT_PRIORITIES[priority];
    if (value === undefined) {
      throw new TypeError(`Unknown movement priority: ${priority}.`);
    }
    return value;
  }
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw new TypeError("Movement priority must be an integer between 0 and 100.");
  }
  return priority;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${field} must be a non-empty string.`);
  }
  return value;
}

let sequence = 0;

function defaultId(prefix: string, now: number): string {
  sequence += 1;
  return `${prefix}-${now.toString(36)}-${sequence.toString(36)}`;
}

class MovementLeaseHandle implements MovementLease {
  readonly controller: AbortController;
  private parentAbortListener: (() => void) | undefined;
  private leaseState: MovementLeaseState = "active";

  constructor(
    private readonly arbiter: MovementArbiter,
    readonly leaseId: string,
    readonly token: string,
    readonly owner: string,
    readonly priority: number,
    readonly acquiredAt: number,
    readonly taskId: string | undefined,
    readonly goal: unknown,
    readonly metadata: Readonly<Record<string, unknown>> | undefined,
    private readonly parentSignal: AbortSignal | undefined,
    readonly onPreempt: MovementLeasePreemptHandler | undefined,
    readonly onRelease: MovementLeaseReleaseHandler | undefined,
  ) {
    this.controller = new AbortController();
    if (parentSignal !== undefined) {
      this.parentAbortListener = () => {
        this.arbiter.release(this, "parent_cancelled");
      };
      parentSignal.addEventListener("abort", this.parentAbortListener, {
        once: true,
      });
      if (parentSignal.aborted) {
        this.parentAbortListener();
      }
    }
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get state(): MovementLeaseState {
    return this.leaseState;
  }

  setEndState(state: LeaseEndState): void {
    this.leaseState = state;
    if (this.parentAbortListener !== undefined) {
      this.parentSignal?.removeEventListener(
        "abort",
        this.parentAbortListener,
      );
    }
    this.parentAbortListener = undefined;
    // Abort listeners are intentionally notified for every end state.  A
    // preempted callback must stop pathfinding before another owner starts.
    this.controller.abort();
  }

  isCurrent(): boolean {
    return this.arbiter.isCurrent(this);
  }

  assertCurrent(): void {
    if (!this.isCurrent()) throw new StaleMovementLeaseError();
  }

  release(reason: MovementLeaseEndReason = "released"): boolean {
    return this.arbiter.release(this, reason);
  }

  cancel(reason: MovementLeaseEndReason = "cancelled"): boolean {
    return this.arbiter.release(this, reason);
  }

  snapshot(): MovementLeaseSnapshot {
    return Object.freeze({
      leaseId: this.leaseId,
      token: this.token,
      owner: this.owner,
      priority: this.priority,
      ...(this.taskId === undefined ? {} : { taskId: this.taskId }),
      ...(this.goal === undefined ? {} : { goal: this.goal }),
      ...(this.metadata === undefined ? {} : { metadata: this.metadata }),
      acquiredAt: this.acquiredAt,
      state: this.leaseState,
    });
  }
}

/**
 * Arbitrates the sole primary movement owner for one bot.
 *
 * `acquire` returns null for a request that cannot preempt the current owner.
 * Use `require` when a caller prefers an exception.  All release paths are
 * token checked, so a late callback from an old skill cannot release or
 * mutate a newer lease.
 */
export class MovementArbiter {
  private readonly now: () => number;
  private readonly makeLeaseId: () => string;
  private readonly makeToken: () => string;
  private readonly onPreempt: MovementLeasePreemptHandler | undefined;
  private readonly onRelease: MovementLeaseReleaseHandler | undefined;
  private readonly onChange:
    | ((lease: MovementLeaseSnapshot | null) => void)
    | undefined;
  private current: MovementLeaseHandle | null = null;
  private tokenGeneration = 0;

  constructor(options: MovementArbiterOptions = {}) {
    this.now = options.now ?? (() => Date.now());
    this.makeLeaseId =
      options.leaseId ?? (() => defaultId("movement-lease", this.now()));
    this.makeToken =
      options.token ?? (() => defaultId("movement-token", this.now()));
    this.onPreempt = options.onPreempt;
    this.onRelease = options.onRelease;
    this.onChange = options.onChange;
  }

  /** Returns the current immutable lease snapshot, or null when idle. */
  currentLease(): MovementLeaseSnapshot | null {
    return this.current?.snapshot() ?? null;
  }

  /** Alias useful to telemetry and runtime integrations. */
  snapshot(): MovementLeaseSnapshot | null {
    return this.currentLease();
  }

  hasActiveLease(): boolean {
    return this.current !== null && this.current.state === "active";
  }

  /** Acquire if idle or if this request has a strictly higher priority. */
  acquire(request: MovementLeaseRequest): MovementLease | null {
    const owner = requiredText(request.owner, "Movement owner");
    const priority = priorityValue(request.priority);
    if (request.taskId !== undefined) requiredText(request.taskId, "taskId");
    if (request.signal?.aborted) return null;

    const previous = this.current;
    if (previous !== null) {
      // TTL 防泄漏（2026-09-04 闭环轮实测：战斗/追击持走租约后不还，
      // collect.block 全 BOT_MOVEMENT_BUSY 饿死——租约无过期=泄漏永久化）。
      // 超过 TTL 的旧租约视同过期释放，同优先级新请求可接管。
      if (this.now() - previous.acquiredAt >= MOVEMENT_LEASE_TTL_MS) {
        this.release(previous, "ttl_expired");
      } else {
        // Lower number wins. Equal priority is intentionally rejected to avoid
        // two peer skills interleaving pathfinder goals nondeterministically.
        if (priority >= previous.priority) return null;
      }
    }

    this.tokenGeneration += 1;
    const token = `${requiredText(this.makeToken(), "token")}:${this.tokenGeneration.toString(36)}`;

    const lease = new MovementLeaseHandle(
      this,
      requiredText(this.makeLeaseId(), "leaseId"),
      token,
      owner,
      priority,
      this.now(),
      request.taskId,
      request.goal,
      request.metadata === undefined
        ? undefined
        : Object.freeze({ ...request.metadata }),
      request.signal,
      request.onPreempt,
      request.onRelease,
    );

    if (previous !== null) {
      this.end(previous, "preempted", lease.snapshot());
    }
    this.current = lease;
    this.notifyChange();
    return lease;
  }

  /** Explicit alias for callers that prefer try-acquire terminology. */
  tryAcquire(request: MovementLeaseRequest): MovementLease | null {
    return this.acquire(request);
  }

  /** Acquire or throw a stable, inspectable conflict error. */
  require(request: MovementLeaseRequest): MovementLease {
    const lease = this.acquire(request);
    if (lease !== null) return lease;
    const priority = priorityValue(request.priority);
    throw new MovementLeaseUnavailableError(
      request.owner,
      priority,
      this.current?.owner ?? null,
      this.current?.priority ?? null,
    );
  }

  /** Release only when the supplied lease/token is still current. */
  release(
    leaseOrToken: MovementLease | string,
    reason: MovementLeaseEndReason = "released",
  ): boolean {
    const current = this.current;
    if (
      current === null ||
      (typeof leaseOrToken === "string"
        ? current.token !== leaseOrToken
        : current !== leaseOrToken)
    ) {
      return false;
    }
    this.end(
      current,
      reason === "preempted"
        ? "preempted"
        : reason === "cancelled" || reason === "parent_cancelled" || reason === "shutdown"
          ? "cancelled"
          : "released",
      undefined,
      reason,
    );
    return true;
  }

  /** Cancel the current movement and invalidate its token. */
  cancel(reason: MovementLeaseEndReason = "cancelled"): boolean {
    if (this.current === null) return false;
    return this.release(this.current, reason);
  }

  /** Alias for cancellation from safety/recovery paths. */
  stop(reason: MovementLeaseEndReason = "shutdown"): boolean {
    return this.cancel(reason);
  }

  /** Token guard for asynchronous driver callbacks. */
  isCurrent(leaseOrToken: MovementLease | string): boolean {
    return (
      this.current !== null &&
      this.current.state === "active" &&
      (typeof leaseOrToken === "string"
        ? this.current.token === leaseOrToken
        : this.current === leaseOrToken)
    );
  }

  assertCurrent(leaseOrToken: MovementLease | string): void {
    if (!this.isCurrent(leaseOrToken)) throw new StaleMovementLeaseError();
  }

  private end(
    lease: MovementLeaseHandle,
    state: LeaseEndState,
    replacement: MovementLeaseSnapshot | undefined,
    reason: MovementLeaseEndReason = state,
  ): void {
    if (this.current !== lease) return;
    lease.setEndState(state);
    const event: MovementLeaseEvent = Object.freeze({
      lease: lease.snapshot(),
      reason,
      at: this.now(),
      ...(replacement === undefined ? {} : { replacement }),
    });

    // Cleanup runs while the old owner is still the arbiter's current entry;
    // this gives a Mineflayer adapter a deterministic point to stop its old
    // path before the replacement is installed.
    if (state === "preempted") {
      this.invoke(lease.onPreempt, event);
      this.invoke(this.onPreempt, event);
    } else {
      this.invoke(lease.onRelease, event);
      this.invoke(this.onRelease, event);
    }
    this.current = null;
    this.notifyChange();
  }

  private notifyChange(): void {
    if (this.onChange === undefined) return;
    try {
      this.onChange(this.current?.snapshot() ?? null);
    } catch {
      // Telemetry must never prevent movement cleanup or a lease transfer.
    }
  }

  private invoke(
    callback: MovementLeasePreemptHandler | MovementLeaseReleaseHandler | undefined,
    event: MovementLeaseEvent,
  ): void {
    if (callback === undefined) return;
    try {
      callback(event);
    } catch {
      // A faulty cleanup hook cannot leave the old token valid.
    }
  }
}

export type MovementOperation<T> = (
  lease: MovementLease,
) => Promise<T> | T;

export type MovementControllerOptions = MovementArbiterOptions;

/**
 * Small execution facade around MovementArbiter.  It is useful for runtime
 * adapters that want one `run` scope and guaranteed release in a finally
 * block, while still exposing the arbiter for preemption and telemetry.
 */
export class MovementController {
  readonly arbiter: MovementArbiter;

  constructor(options: MovementControllerOptions = {}) {
    this.arbiter = new MovementArbiter(options);
  }

  acquire(request: MovementLeaseRequest): MovementLease | null {
    return this.arbiter.acquire(request);
  }

  tryAcquire(request: MovementLeaseRequest): MovementLease | null {
    return this.arbiter.tryAcquire(request);
  }

  require(request: MovementLeaseRequest): MovementLease {
    return this.arbiter.require(request);
  }

  release(
    leaseOrToken: MovementLease | string,
    reason?: MovementLeaseEndReason,
  ): boolean {
    return this.arbiter.release(leaseOrToken, reason);
  }

  cancel(reason?: MovementLeaseEndReason): boolean {
    return this.arbiter.cancel(reason);
  }

  stop(reason?: MovementLeaseEndReason): boolean {
    return this.arbiter.stop(reason);
  }

  currentLease(): MovementLeaseSnapshot | null {
    return this.arbiter.currentLease();
  }

  snapshot(): MovementLeaseSnapshot | null {
    return this.arbiter.snapshot();
  }

  isCurrent(leaseOrToken: MovementLease | string): boolean {
    return this.arbiter.isCurrent(leaseOrToken);
  }

  assertCurrent(leaseOrToken: MovementLease | string): void {
    this.arbiter.assertCurrent(leaseOrToken);
  }

  async run<T>(
    request: MovementLeaseRequest,
    operation: MovementOperation<T>,
  ): Promise<T> {
    const lease = this.require(request);
    try {
      lease.assertCurrent();
      const result = await operation(lease);
      lease.assertCurrent();
      return result;
    } finally {
      lease.release(lease.signal.aborted ? "cancelled" : "completed");
    }
  }
}

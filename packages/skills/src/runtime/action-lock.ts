/**
 * Small, deterministic lock manager for Bot actions.  A lock is deliberately
 * lease based: a forgotten async callback cannot hold a resource forever.
 * Callers should normally use `withLock`, which releases only after the
 * protected work settles. An AbortSignal prevents acquisition, but it must
 * not release an in-flight Mineflayer side effect early: most Mineflayer
 * write APIs cannot actually cancel the server operation they already sent.
 */

export const actionLockKinds = [
  "movement",
  "look",
  "inventory",
  "crafting",
  "container",
  "blockInteraction",
  "combat",
] as const;

export type ActionLockKind = (typeof actionLockKinds)[number];

export type ActionLockSnapshot = Readonly<{
  kind: ActionLockKind;
  owner: string;
  acquiredAt: number;
  expiresAt: number;
}>;

export type ActionLockAcquireOptions = Readonly<{
  owner: string;
  ttlMs: number;
  signal?: AbortSignal;
}>;

export class ActionLockError extends Error {
  constructor(
    readonly code:
      | "INVALID_TTL"
      | "INVALID_OWNER"
      | "LOCK_BUSY"
      | "LOCK_CANCELLED"
      | "LOCK_EXPIRED"
      | "LOCK_NOT_OWNER",
    message: string,
  ) {
    super(message);
    this.name = "ActionLockError";
  }
}

type HeldLock = ActionLockSnapshot & {
  timer: ReturnType<typeof setTimeout> | null;
};

export class ActionLockManager {
  private readonly locks = new Map<ActionLockKind, HeldLock>();

  tryAcquire(
    kind: ActionLockKind,
    options: ActionLockAcquireOptions,
    expireAbandoned = true,
  ): () => void {
    return this.acquire(kind, options, expireAbandoned);
  }

  private acquire(
    kind: ActionLockKind,
    options: ActionLockAcquireOptions,
    expireAbandoned: boolean,
  ): () => void {
    this.validate(kind, options);
    this.expire(kind, Date.now());
    if (options.signal?.aborted) {
      throw new ActionLockError("LOCK_CANCELLED", "Lock acquisition was cancelled.");
    }
    const current = this.locks.get(kind);
    if (current !== undefined) {
      throw new ActionLockError("LOCK_BUSY", `Action lock '${kind}' is held.`);
    }
    const acquiredAt = Date.now();
    const expiresAt = expireAbandoned
      ? acquiredAt + options.ttlMs
      : Number.MAX_SAFE_INTEGER;
    const timer = expireAbandoned
      ? setTimeout(() => this.release(kind, options.owner), options.ttlMs)
      : null;
    const held: HeldLock = { kind, owner: options.owner, acquiredAt, expiresAt, timer };
    this.locks.set(kind, held);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.release(kind, options.owner);
    };
  }

  async withLock<T>(
    kind: ActionLockKind,
    options: ActionLockAcquireOptions,
    work: () => Promise<T> | T,
  ): Promise<T> {
    // Mineflayer writes generally cannot be cancelled after their packet is
    // sent. Keep the lock for the full lifetime of the returned Promise even
    // when the nominal lease TTL or AbortSignal fires.
    const release = this.tryAcquire(kind, options, false);
    try {
      if (options.signal?.aborted) {
        throw new ActionLockError("LOCK_CANCELLED", "Locked action was cancelled.");
      }
      return await work();
    } finally {
      release();
    }
  }

  release(kind: ActionLockKind, owner: string): boolean {
    const current = this.locks.get(kind);
    if (current === undefined) return false;
    if (current.owner !== owner) {
      throw new ActionLockError("LOCK_NOT_OWNER", `Action lock '${kind}' has another owner.`);
    }
    if (current.timer !== null) clearTimeout(current.timer);
    this.locks.delete(kind);
    return true;
  }

  clear(owner?: string): void {
    for (const [kind, lock] of this.locks) {
      if (owner === undefined || lock.owner === owner) {
        if (lock.timer !== null) clearTimeout(lock.timer);
        this.locks.delete(kind);
      }
    }
  }

  snapshot(now = Date.now()): readonly ActionLockSnapshot[] {
    for (const kind of actionLockKinds) this.expire(kind, now);
    return Object.freeze(
      [...this.locks.values()]
        .map(({ timer: _timer, ...snapshot }) => Object.freeze(snapshot))
        .sort((left, right) => left.kind.localeCompare(right.kind)),
    );
  }

  ownerOf(kind: ActionLockKind, now = Date.now()): string | null {
    this.expire(kind, now);
    return this.locks.get(kind)?.owner ?? null;
  }

  private expire(kind: ActionLockKind, now: number): void {
    const current = this.locks.get(kind);
    if (current !== undefined && current.expiresAt <= now) {
      if (current.timer !== null) clearTimeout(current.timer);
      this.locks.delete(kind);
    }
  }

  private validate(kind: ActionLockKind, options: ActionLockAcquireOptions): void {
    if (!actionLockKinds.includes(kind)) {
      throw new ActionLockError("INVALID_OWNER", "Unknown action lock kind.");
    }
    if (!options.owner || options.owner.length > 128) {
      throw new ActionLockError("INVALID_OWNER", "Action lock owner is invalid.");
    }
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1 || options.ttlMs > 5 * 60_000) {
      throw new ActionLockError("INVALID_TTL", "Action lock TTL is outside the safe range.");
    }
  }
}

export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Rate limit must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
      throw new TypeError("Rate limit window must be a positive safe integer.");
    }
  }

  allow(key: string, nowMs: number): boolean {
    const existing = this.entries.get(key);
    if (!existing || nowMs - existing.windowStart >= this.windowMs) {
      this.entries.set(key, { windowStart: nowMs, count: 1 });
      this.sweep(nowMs);
      return true;
    }
    if (existing.count >= this.limit) return false;
    existing.count += 1;
    return true;
  }

  private sweep(nowMs: number): void {
    if (this.entries.size <= 10_000) return;
    for (const [key, entry] of this.entries) {
      if (nowMs - entry.windowStart >= this.windowMs) this.entries.delete(key);
    }
  }
}

export class ConnectionLimiter {
  private readonly counts = new Map<string, number>();

  constructor(private readonly limit: number) {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError("Connection limit must be a positive safe integer.");
    }
  }

  acquire(key: string): boolean {
    const current = this.counts.get(key) ?? 0;
    if (current >= this.limit) return false;
    this.counts.set(key, current + 1);
    return true;
  }

  release(key: string): void {
    const current = this.counts.get(key) ?? 0;
    if (current <= 1) this.counts.delete(key);
    else this.counts.set(key, current - 1);
  }
}

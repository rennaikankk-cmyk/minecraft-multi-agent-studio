export class PhysicsCadence {
  private lastAt: number | null = null;
  private intervals: number[] = [];
  private cursor = 0;

  reset(): void { this.lastAt = null; this.intervals = []; this.cursor = 0; }

  record(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return;
    if (this.lastAt !== null && nowMs >= this.lastAt) {
      this.intervals[this.cursor] = nowMs - this.lastAt;
      this.cursor = (this.cursor + 1) % 256;
    }
    this.lastAt = nowMs;
  }

  snapshot(observedAt: string, nowMs = this.lastAt ?? 0): { observedAt: string; samples: number; p95IntervalMs: number; maxIntervalMs: number } | null {
    if (this.intervals.length < 16 || this.lastAt === null || nowMs - this.lastAt > 1_000) return null;
    const ordered = [...this.intervals].sort((a, b) => a - b);
    return { observedAt, samples: ordered.length,
      p95IntervalMs: Math.round(ordered[Math.ceil(ordered.length * 0.95) - 1]! * 100) / 100,
      maxIntervalMs: Math.round(ordered[ordered.length - 1]! * 100) / 100 };
  }
}

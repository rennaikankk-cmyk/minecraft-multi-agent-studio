import { importantBlockNames, type NearbyBlockState, type WorldPosition } from "./world-state.js";

/** Publish complete scans atomically while yielding between block-type queries. */
export class NearbyBlockScanner {
  private generation = 0;
  private context: string | null = null;
  private pending = false;
  private completedAtMs = -Infinity;
  private blocks: readonly NearbyBlockState[] = [];

  constructor(private readonly port: {
    query(name: string, origin: WorldPosition): readonly NearbyBlockState[];
    scopeMatches(origin: WorldPosition): boolean;
    now(): number;
  }, private readonly intervalMs: number) {}

  reset(): void {
    this.generation++;
    this.context = null;
    this.pending = false;
    this.completedAtMs = -Infinity;
    this.blocks = [];
  }

  read(origin: WorldPosition): readonly NearbyBlockState[] {
    const context = JSON.stringify([origin.serverProfileId, origin.dimension]);
    if (context !== this.context) { this.reset(); this.context = context; }
    const nowMs = this.port.now();
    if (!this.pending && (nowMs < this.completedAtMs || nowMs - this.completedAtMs >= this.intervalMs)) {
      this.pending = true;
      void this.refresh(origin, this.generation);
    }
    return this.blocks;
  }

  private async refresh(origin: WorldPosition, generation: number): Promise<void> {
    const blocks: NearbyBlockState[] = [];
    try {
      for (const name of importantBlockNames) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (generation !== this.generation || !this.port.scopeMatches(origin)) return;
        blocks.push(...this.port.query(name, origin));
      }
      if (generation === this.generation && this.port.scopeMatches(origin)) {
        this.blocks = Object.freeze(blocks);
        this.completedAtMs = this.port.now();
      }
    } catch {
      // Retain timestamps on the last complete observations after a failed query.
      if (generation === this.generation) this.completedAtMs = this.port.now();
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }
}

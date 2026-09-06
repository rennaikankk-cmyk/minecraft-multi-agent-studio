import type { SpatialResult } from "@minecraft-studio/pathfinder-rs";
import type { WorldQueryView } from "./world-query-provider.js";
import type { WorldSyncQueryContext } from "./world-sync-adapter.js";

type Point = SpatialResult["points"][number];
export type ShadowEvidence = {
  query: WorldQueryView["bounds"];
  scope: WorldSyncQueryContext;
  indexed: Point[];
  oracle: Point[];
  coverage: Pick<SpatialResult, "status" | "consultedChunks">;
  outcome: "match" | "mismatch" | "worldChanged" | "incomplete" | "oracleLimited" | "oracleError";
  startedAtMs: number;
  elapsedMs: number;
};
const sameObservation = (a: WorldSyncQueryContext, b: WorldSyncQueryContext | null) => b !== null && b.settled &&
  a.sourceRevision === b.sourceRevision && a.sessionEpoch === b.sessionEpoch && a.dimensionEpoch === b.dimensionEpoch &&
  JSON.stringify(a.scope) === JSON.stringify(b.scope);
const order = (a: Point, b: Point) => a.distanceSquared - b.distanceSquared || a.x - b.x || a.y - b.y || a.z - b.z;

/** Test-only observer. A legacy truncation or changed observation cannot establish a mismatch. */
export class WorldQueryShadow {
  private running = false;
  private lastStarted = -Infinity;
  private evidence: ShadowEvidence[] = [];
  private counts = { match: 0, mismatch: 0, worldChanged: 0, incomplete: 0, oracleLimited: 0, oracleError: 0 };
  readonly enabled: boolean;

  constructor(private readonly port: {
    mode: string | undefined;
    enabled: boolean;
    context(): WorldSyncQueryContext | null;
    oracle(query: WorldQueryView["bounds"], selector: number, limit: number): Promise<Point[]>;
    now(): number;
    completed?(outcome: ShadowEvidence["outcome"], elapsedMs: number): void;
  }) {
    this.enabled = port.enabled && ["LOCAL_TEST", "E2E"].includes(port.mode ?? "NORMAL");
  }

  diagnostics() { return { enabled: this.enabled, running: this.running, counts: { ...this.counts } }; }
  replayEvidence(): ShadowEvidence[] { return structuredClone(this.evidence); }

  async observe(view: WorldQueryView): Promise<void> {
    if (!this.enabled || this.running || !view.result || this.port.now() - this.lastStarted < 1_000) return;
    const current = this.port.context();
    if (!current?.settled || current.sourceRevision !== view.sourceRevision) return;
    const scope = structuredClone(current);
    this.running = true;
    this.lastStarted = this.port.now();
    const frame: ShadowEvidence = { query: view.bounds, scope, indexed: [...view.result.points], oracle: [],
      coverage: { status: view.result.status, consultedChunks: view.result.consultedChunks },
      outcome: "match", startedAtMs: this.lastStarted, elapsedMs: 0 };
    try {
      const all: Point[] = [];
      const masks = view.bounds.matching === "each" ? Array.from({ length: 24 }, (_, i) => 2 ** i)
        .filter((mask) => (view.bounds.selectors & mask) !== 0) : [view.bounds.selectors];
      for (const selector of masks) {
        const hits = await this.port.oracle(view.bounds, selector, 257);
        if (!sameObservation(scope, this.port.context())) { frame.outcome = "worldChanged"; break; }
        if (hits.length >= 257) { frame.outcome = "oracleLimited"; break; }
        all.push(...hits.sort(order).slice(0, view.bounds.count));
      }
      frame.oracle = [...new Map(all.map((p) => [`${p.x},${p.y},${p.z}`, p])).values()].sort(order);
      if (frame.outcome === "match") {
        const canonical = (points: Point[]) => points.map((p) => [p.x, p.y, p.z, p.distanceSquared, p.selectors]);
        frame.outcome = view.complete ? JSON.stringify(canonical(frame.indexed)) === JSON.stringify(canonical(frame.oracle))
          ? "match" : "mismatch" : "incomplete";
      }
    } catch {
      frame.outcome = "oracleError";
    } finally {
      frame.elapsedMs = this.port.now() - frame.startedAtMs;
      this.counts[frame.outcome]++;
      this.evidence.push(frame);
      if (this.evidence.length > 8) this.evidence.shift();
      this.running = false;
      this.port.completed?.(frame.outcome, frame.elapsedMs);
    }
  }
}

import { mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { exploreInputSchema, exploreOutputSchema } from "@minecraft-studio/skills";

const scopeSchema = exploreInputSchema.pick({ serverProfileId: true, dimension: true });
const chunkSchema = exploreInputSchema.shape.center;
const entrySchema = scopeSchema.extend({ chunk: chunkSchema, observedAt: z.string().datetime() }).strict();
const snapshotSchema = z.object({ schemaVersion: z.literal("1.0"), entries: z.array(entrySchema).max(20_000) }).strict();
type Entry = z.infer<typeof entrySchema>;
type Chunk = z.infer<typeof chunkSchema>;
const TTL_MS = 86_400_000;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const key = (scope: z.infer<typeof scopeSchema>, chunk: Chunk) => JSON.stringify([scope.serverProfileId, scope.dimension, chunk.x, chunk.z]);

/** Revisit hints only. The runtime must still read live blocks before moving. */
export class ExplorationJournal {
  private readonly entries = new Map<string, Entry>();
  private initialization: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private errorCode: string | null = null;
  private writable = true;
  constructor(private readonly filePath: string | null = null, private readonly now: () => number = Date.now) {}

  async initialize(): Promise<void> {
    this.initialization ??= this.load();
    return this.initialization;
  }
  health() { return { mode: this.filePath ? "file" as const : "memory" as const, entries: this.entries.size, errorCode: this.errorCode }; }
  private async load(): Promise<void> {
    if (!this.filePath) return;
    try {
      const handle = await open(this.filePath, "r");
      let raw: string;
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > MAX_CACHE_BYTES) throw new Error("EXPLORATION_CACHE_TOO_LARGE");
        // Bound the read itself as well: a concurrently growing file cannot bypass stat().
        const buffer = Buffer.alloc(Math.min(MAX_CACHE_BYTES + 1, stats.size + 1));
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > stats.size) throw new Error("EXPLORATION_CACHE_CHANGED");
        raw = buffer.subarray(0, offset).toString("utf8");
      } finally { await handle.close(); }
      const snapshot = snapshotSchema.parse(JSON.parse(raw));
      for (const entry of snapshot.entries) if (this.fresh(entry)) {
        const id = key(entry, entry.chunk), previous = this.entries.get(id);
        if (!previous || Date.parse(entry.observedAt) > Date.parse(previous.observedAt)) this.entries.set(id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.errorCode = "EXPLORATION_CACHE_LOAD_FAILED";
      this.writable = false;
    }
  }
  has(serverProfileId: string, dimension: string, x: number, z: number): boolean {
    const scope = scopeSchema.parse({ serverProfileId, dimension });
    const entry = this.entries.get(key(scope, chunkSchema.parse({ x, z })));
    return !!entry && this.fresh(entry);
  }
  list(serverProfileId: string, dimension: string, center: Chunk, radiusChunks: number): Chunk[] {
    const input = exploreInputSchema.parse({ serverProfileId, dimension, center, radiusChunks });
    const chunks: Chunk[] = [];
    for (let x = center.x - input.radiusChunks; x <= center.x + input.radiusChunks; x++) {
      for (let z = center.z - input.radiusChunks; z <= center.z + input.radiusChunks; z++) {
        if (this.has(serverProfileId, dimension, x, z)) chunks.push({ x, z });
      }
    }
    return chunks;
  }
  async recordReceipt(rawInput: unknown, rawOutput: unknown): Promise<void> {
    const input = exploreInputSchema.parse(rawInput), output = exploreOutputSchema.parse(rawOutput);
    const observed = Date.parse(output.observedAt), now = this.now();
    if (observed > now || now - observed > 120_000) throw new Error("EXPLORATION_RECEIPT_STALE");
    const excluded = new Set(input.excluded.map((p) => key(input, p)));
    for (const chunk of output.visited) {
      if (Math.abs(chunk.x - input.center.x) > input.radiusChunks || Math.abs(chunk.z - input.center.z) > input.radiusChunks || excluded.has(key(input, chunk))) {
        throw new Error("EXPLORATION_RECEIPT_SCOPE_MISMATCH");
      }
    }
    await this.initialize();
    for (const chunk of output.visited) {
      const id = key(input, chunk), previous = this.entries.get(id);
      if (previous && Date.parse(previous.observedAt) >= observed) continue;
      this.entries.delete(id);
      this.entries.set(id, { serverProfileId: input.serverProfileId, dimension: input.dimension, chunk, observedAt: output.observedAt });
    }
    for (const [id, entry] of this.entries) if (!this.fresh(entry)) this.entries.delete(id);
    while (this.entries.size > 20_000) this.entries.delete(this.entries.keys().next().value!);
    if (!this.filePath || !this.writable || output.visited.length === 0) return;
    this.writes = this.writes.then(async () => {
      const filePath = this.filePath!;
      try {
        await mkdir(path.dirname(filePath), { recursive: true });
        const temporary = `${filePath}.tmp-${process.pid}`;
        const handle = await open(temporary, "w", 0o600);
        try {
          await handle.writeFile(JSON.stringify({ schemaVersion: "1.0", entries: [...this.entries.values()] }));
          await handle.sync();
        } finally { await handle.close(); }
        await rename(temporary, filePath);
        this.errorCode = null;
      } catch { this.errorCode = "EXPLORATION_CACHE_WRITE_FAILED"; }
    });
    await this.writes;
  }
  private fresh(entry: Entry): boolean {
    const age = this.now() - Date.parse(entry.observedAt);
    return age >= 0 && age <= TTL_MS;
  }
}

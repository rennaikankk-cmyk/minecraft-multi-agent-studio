import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resourceStateSchema, type ResourceState } from "./schema.js";

export function emptyResourceState(): ResourceState { return { schemaVersion: "2.0", revision: 0,
  observations: [], reservations: [], transfers: [], receipts: [], demands: [], outbox: [] }; }
export interface ResourceStateStore {
  readonly durability: "memory" | "file";
  load(): ResourceState;
  /** Must either persist the complete snapshot or leave the previous revision unchanged. */
  save(state: ResourceState, expectedRevision: number): void;
}
export class MemoryResourceStateStore implements ResourceStateStore {
  readonly durability = "memory" as const;
  private state = emptyResourceState();
  load(): ResourceState { return structuredClone(this.state); }
  save(state: ResourceState, expectedRevision: number): void {
    if (this.state.revision !== expectedRevision) throw new Error("RESOURCE_REVISION_CONFLICT");
    this.state = resourceStateSchema.parse(state);
  }
}
/** Desktop adapter. CAS under a short exclusive file lock; no worker or recurring loop. */
export class FileResourceStateStore implements ResourceStateStore {
  readonly durability = "file" as const;
  constructor(private readonly filename: string) {}
  load(): ResourceState {
    try { return resourceStateSchema.parse(JSON.parse(readFileSync(this.filename, "utf8"))); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return emptyResourceState(); throw new Error("RESOURCE_STATE_READ_FAILED"); }
  }
  /** CAS 复核只需 revision：同一事务的 load() 刚做过完整 schema 校验，复核
   *  的目的是捕获并发写入者的 revision 变化。schemaVersion 是本 store 自有
   *  格式的廉价指纹——缺失/不符即非本 store 的文件，按损坏 fail-closed
   *  （维持"损坏文件不被静默覆盖"的口径）。文件缺失按空状态（revision 0）；
   *  JSON 损坏/非对象/revision 非法同样抛 RESOURCE_STATE_READ_FAILED。 */
  private readCurrentRevision(): number {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.filename, "utf8"));
      const record = typeof parsed === "object" && parsed !== null
        ? (parsed as { schemaVersion?: unknown; revision?: unknown })
        : undefined;
      if (
        record?.schemaVersion === "2.0" &&
        typeof record.revision === "number" &&
        Number.isSafeInteger(record.revision) &&
        record.revision >= 0
      ) {
        return record.revision;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    }
    throw new Error("RESOURCE_STATE_READ_FAILED");
  }
  save(input: ResourceState, expectedRevision: number): void {
    const state = resourceStateSchema.parse(input);
    if (state.revision !== expectedRevision + 1) throw new Error("RESOURCE_REVISION_CONFLICT");
    const dir = path.dirname(this.filename), lockPath = `${this.filename}.lock`, temporary = `${this.filename}.${randomUUID()}.tmp`;
    let lock: number | undefined, file: number | undefined;
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try { lock = openSync(lockPath, "wx", 0o600); } catch { throw new Error("RESOURCE_STORE_BUSY"); }
      if (this.readCurrentRevision() !== expectedRevision) throw new Error("RESOURCE_REVISION_CONFLICT");
      file = openSync(temporary, "wx", 0o600); writeFileSync(file, JSON.stringify(state)); fsyncSync(file); closeSync(file); file = undefined;
      renameSync(temporary, this.filename);
      if (process.platform !== "win32") { file = openSync(dir, "r"); fsyncSync(file); closeSync(file); file = undefined; }
    } catch (e) {
      if (e instanceof Error && ["RESOURCE_STORE_BUSY", "RESOURCE_REVISION_CONFLICT", "RESOURCE_STATE_READ_FAILED"].includes(e.message)) throw e;
      throw new Error("RESOURCE_STATE_WRITE_FAILED");
    } finally {
      if (file !== undefined) closeSync(file);
      try { unlinkSync(temporary); } catch { /* Only this operation's temporary file. */ }
      if (lock !== undefined) { closeSync(lock); unlinkSync(lockPath); }
    }
  }
}

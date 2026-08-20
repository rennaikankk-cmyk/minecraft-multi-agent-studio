import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileWorldMemoryIngestionOutbox,
  WorldMemoryError,
  type RecordWorldMemoryResult,
  type WorldMemoryWriteCommand,
  type WorldMemoryWriterLike,
} from "../src/index.js";

const NOW = "2026-08-20T12:00:00.000Z";
const BATCH_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function command(
  overrides: Partial<WorldMemoryWriteCommand> = {},
): WorldMemoryWriteCommand {
  return {
    schemaVersion: "1.0",
    operationId: randomUUID(),
    memoryId: randomUUID(),
    serverProfileId: "isolated-local",
    dimension: "minecraft:overworld",
    position: { x: 2, y: 62, z: 1 },
    kind: "resource",
    summary: "Authorized scout scan observed iron_ore.",
    tags: ["iron_ore", "source:scout.scan-blocks"],
    confidence: 1,
    visibility: "team",
    allowedSubjectIds: [],
    modelAccess: true,
    sourceBotId: "scout-01",
    sourceTaskId: "task-scout-01",
    traceId: "trace-memory-outbox",
    observedAt: NOW,
    expiresAt: "2026-08-21T12:00:00.000Z",
    supersedesMemoryId: null,
    embedding: null,
    ...overrides,
  };
}

function recordResult(
  input: WorldMemoryWriteCommand,
  created: boolean,
): RecordWorldMemoryResult {
  return {
    created,
    memory: {
      schemaVersion: input.schemaVersion,
      operationId: input.operationId,
      memoryId: input.memoryId,
      serverProfileId: input.serverProfileId,
      dimension: input.dimension,
      position: input.position,
      kind: input.kind,
      summary: input.summary,
      tags: input.tags,
      confidence: input.confidence,
      visibility: input.visibility,
      allowedSubjectIds: input.allowedSubjectIds,
      modelAccess: input.modelAccess,
      sourceBotId: input.sourceBotId,
      sourceTaskId: input.sourceTaskId,
      traceId: input.traceId,
      observedAt: input.observedAt,
      expiresAt: input.expiresAt,
      supersedesMemoryId: input.supersedesMemoryId,
      embeddingModel: input.embedding?.model ?? null,
      embeddingDimensions: input.embedding?.values.length ?? null,
      createdAt: NOW,
    },
  };
}

class ToggleWriter implements WorldMemoryWriterLike {
  readonly stored: Map<string, WorldMemoryWriteCommand>;
  unavailable = false;
  failOnCall: number | null = null;
  calls = 0;

  constructor(stored = new Map<string, WorldMemoryWriteCommand>()) {
    this.stored = stored;
  }

  async record(
    input: WorldMemoryWriteCommand,
  ): Promise<RecordWorldMemoryResult> {
    this.calls += 1;
    if (this.unavailable || this.calls === this.failOnCall) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_INGESTION_FAILED",
        "simulated PostgreSQL outage",
      );
    }
    const created = !this.stored.has(input.operationId);
    if (created) this.stored.set(input.operationId, input);
    return recordResult(input, created);
  }
}

const temporaryRoots: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "studio-memory-outbox-"));
  temporaryRoots.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("durable world-memory ingestion outbox", () => {
  it("atomically enqueues one protected batch and removes it only after delivery", async () => {
    const directory = await temporaryDirectory();
    const writer = new ToggleWriter();
    const outbox = new FileWorldMemoryIngestionOutbox({ directory, writer });
    const input = command();

    await expect(outbox.enqueue(BATCH_ID, [input])).resolves.toEqual({
      batchId: BATCH_ID,
      created: true,
      pendingBatchCount: 1,
    });
    await expect(outbox.enqueue(BATCH_ID, [input])).resolves.toEqual({
      batchId: BATCH_ID,
      created: false,
      pendingBatchCount: 1,
    });
    const files = await readdir(directory);
    expect(files).toEqual([`${BATCH_ID}.pending.json`]);
    if (process.platform !== "win32") {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(directory, files[0]!))).mode & 0o777).toBe(0o600);
    }

    await expect(outbox.deliverBatch(BATCH_ID, { force: true })).resolves.toEqual({
      batchId: BATCH_ID,
      commandCount: 1,
      delivered: true,
      createdCount: 1,
      replayedCount: 0,
      deferredCount: 0,
      errorCode: null,
    });
    await expect(outbox.pendingCount()).resolves.toBe(0);
  });

  it("survives a writer outage and drains through a new process instance", async () => {
    const directory = await temporaryDirectory();
    const unavailable = new ToggleWriter();
    unavailable.unavailable = true;
    const first = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: unavailable,
    });
    const input = command();
    await first.enqueue(BATCH_ID, [input]);
    await expect(first.deliverBatch(BATCH_ID, { force: true })).resolves.toMatchObject({
      delivered: false,
      deferredCount: 1,
      errorCode: "WORLD_MEMORY_INGESTION_FAILED",
    });
    await expect(first.pendingCount()).resolves.toBe(1);

    const recovered = new ToggleWriter();
    const restarted = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: recovered,
    });
    await restarted.start();
    await restarted.stop();
    await expect(restarted.pendingCount()).resolves.toBe(0);
    expect(recovered.stored.get(input.operationId)).toEqual(input);
  });

  it("retries a retained batch in the background with bounded backoff", async () => {
    const directory = await temporaryDirectory();
    const writer = new ToggleWriter();
    writer.unavailable = true;
    const cycles: number[] = [];
    const outbox = new FileWorldMemoryIngestionOutbox({
      directory,
      writer,
      pollIntervalMs: 50,
      retryBaseMs: 10,
      retryMaxMs: 100,
      onReconcile: ({ pendingBatchCount }) =>
        cycles.push(pendingBatchCount),
    });
    await outbox.enqueue(BATCH_ID, [command()]);
    await outbox.start();
    await expect(outbox.pendingCount()).resolves.toBe(1);
    writer.unavailable = false;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        if ((await outbox.pendingCount()) === 0) break;
        await delay(25);
      }
      await expect(outbox.pendingCount()).resolves.toBe(0);
      expect(cycles).toContain(1);
      expect(cycles).toContain(0);
    } finally {
      await outbox.stop();
    }
  });

  it("replays a partially delivered batch without duplicating facts", async () => {
    const directory = await temporaryDirectory();
    const firstCommand = command();
    const secondCommand = command({
      position: { x: 4, y: 60, z: 2 },
      summary: "Authorized scout scan observed diamond_ore.",
      tags: ["diamond_ore", "source:scout.scan-blocks"],
    });
    const firstWriter = new ToggleWriter();
    firstWriter.failOnCall = 2;
    const first = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: firstWriter,
    });
    await first.enqueue(BATCH_ID, [firstCommand, secondCommand]);
    await expect(first.deliverBatch(BATCH_ID, { force: true })).resolves.toMatchObject({
      delivered: false,
      createdCount: 1,
      replayedCount: 0,
      deferredCount: 1,
    });

    const recoveredWriter = new ToggleWriter(firstWriter.stored);
    const restarted = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: recoveredWriter,
    });
    await expect(restarted.reconcileOnce()).resolves.toMatchObject({
      delivered: 1,
      failed: 0,
      createdCount: 1,
      replayedCount: 1,
      pendingBatchCount: 0,
    });
    expect(recoveredWriter.stored.size).toBe(2);
  });

  it("rejects batch-ID content conflicts and retains malformed files", async () => {
    const directory = await temporaryDirectory();
    const errors: WorldMemoryError[] = [];
    const outbox = new FileWorldMemoryIngestionOutbox({
      directory,
      writer: new ToggleWriter(),
      onError: (error) => errors.push(error),
    });
    const input = command();
    await outbox.enqueue(BATCH_ID, [input]);
    await expect(
      outbox.enqueue(BATCH_ID, [{ ...input, summary: "different content" }]),
    ).rejects.toMatchObject({ code: "WORLD_MEMORY_OUTBOX_CONFLICT" });

    const pending = join(directory, `${BATCH_ID}.pending.json`);
    await writeFile(pending, "{}\n", "utf8");
    if (process.platform !== "win32") await chmod(pending, 0o600);
    await expect(outbox.reconcileOnce()).resolves.toMatchObject({
      examined: 1,
      delivered: 0,
      failed: 1,
      pendingBatchCount: 1,
    });
    expect(errors).toEqual([
      expect.objectContaining({ code: "WORLD_MEMORY_OUTBOX_INVALID" }),
    ]);
    await expect(outbox.reconcileOnce()).resolves.toMatchObject({
      examined: 0,
      failed: 0,
      pendingBatchCount: 1,
    });
    expect(errors).toHaveLength(1);
    await expect(outbox.pendingCount()).resolves.toBe(1);
  });

  it("recovers a fully synced orphan temporary file on startup", async () => {
    const directory = await temporaryDirectory();
    const writer = new ToggleWriter();
    const first = new FileWorldMemoryIngestionOutbox({ directory, writer });
    const input = command();
    await first.enqueue(BATCH_ID, [input]);
    await rename(
      join(directory, `${BATCH_ID}.pending.json`),
      join(directory, `.tmp-${BATCH_ID}-${randomUUID()}.json`),
    );

    const restarted = new FileWorldMemoryIngestionOutbox({ directory, writer });
    await expect(restarted.pendingCount()).resolves.toBe(1);
    await expect(restarted.reconcileOnce()).resolves.toMatchObject({
      delivered: 1,
      pendingBatchCount: 0,
    });
  });

  it("rejects relative, root, and symbolic-link spool directories", async () => {
    expect(
      () =>
        new FileWorldMemoryIngestionOutbox({
          directory: "runtime-data/memory",
          writer: new ToggleWriter(),
        }),
    ).toThrow(/non-root absolute path/u);
    expect(
      () =>
        new FileWorldMemoryIngestionOutbox({
          directory: "/",
          writer: new ToggleWriter(),
        }),
    ).toThrow(/non-root absolute path/u);
    if (process.platform === "win32") return;

    const root = await temporaryDirectory();
    const target = join(root, "target");
    const linked = join(root, "linked");
    const targetOutbox = new FileWorldMemoryIngestionOutbox({
      directory: target,
      writer: new ToggleWriter(),
    });
    await targetOutbox.pendingCount();
    await symlink(target, linked, "dir");
    const linkedOutbox = new FileWorldMemoryIngestionOutbox({
      directory: linked,
      writer: new ToggleWriter(),
    });
    await expect(linkedOutbox.pendingCount()).rejects.toMatchObject({
      code: "WORLD_MEMORY_OUTBOX_INVALID",
    });
  });
});

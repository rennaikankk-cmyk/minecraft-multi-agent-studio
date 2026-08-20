import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";

import { z } from "zod";

import { WorldMemoryError } from "./errors.js";
import {
  worldMemoryWriteCommandSchema,
  type WorldMemoryWriteCommand,
} from "./model.js";
import type { WorldMemoryWriterLike } from "./repository.js";

export const MAX_WORLD_MEMORY_OUTBOX_COMMANDS = 64;
export const MAX_WORLD_MEMORY_OUTBOX_FILE_BYTES = 1024 * 1024;
export const MAX_WORLD_MEMORY_OUTBOX_BATCH_SIZE = 100;
export const MAX_WORLD_MEMORY_OUTBOX_PENDING_BATCHES = 100_000;

const DEFAULT_BATCH_SIZE = 25;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 60_000;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
const PENDING_FILE_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.pending\.json$/u;
const TEMP_FILE_PATTERN =
  /^\.tmp-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})-[0-9a-f-]{36}\.json$/u;
const READ_FLAGS =
  constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);
const WRITE_FLAGS =
  constants.O_CREAT |
  constants.O_EXCL |
  constants.O_WRONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

const timestampSchema = z.string().datetime({ offset: true });
const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

const durableWorldMemoryOutboxEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    batchId: z.string().uuid(),
    payloadFingerprint: fingerprintSchema,
    commands: z
      .array(worldMemoryWriteCommandSchema)
      .min(1)
      .max(MAX_WORLD_MEMORY_OUTBOX_COMMANDS),
    enqueuedAt: timestampSchema,
  })
  .strict()
  .superRefine((envelope, context) => {
    const operationIds = envelope.commands.map(({ operationId }) => operationId);
    const memoryIds = envelope.commands.map(({ memoryId }) => memoryId);
    if (
      new Set(operationIds).size !== operationIds.length ||
      new Set(memoryIds).size !== memoryIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["commands"],
        message: "Outbox commands must have unique operation and memory IDs.",
      });
    }
  });

export type DurableWorldMemoryOutboxEnvelope = z.infer<
  typeof durableWorldMemoryOutboxEnvelopeSchema
>;

export type WorldMemoryOutboxEnqueueResult = Readonly<{
  batchId: string;
  created: boolean;
  pendingBatchCount: number;
}>;

export type WorldMemoryOutboxDeliveryResult = Readonly<{
  batchId: string;
  commandCount: number;
  delivered: boolean;
  createdCount: number;
  replayedCount: number;
  deferredCount: number;
  errorCode: string | null;
}>;

export type WorldMemoryOutboxReconcileResult = Readonly<{
  examined: number;
  delivered: number;
  failed: number;
  createdCount: number;
  replayedCount: number;
  deferredCount: number;
  pendingBatchCount: number;
}>;

export interface WorldMemoryIngestionOutboxLike {
  enqueue(
    batchId: string,
    commands: readonly WorldMemoryWriteCommand[],
  ): Promise<WorldMemoryOutboxEnqueueResult>;
  deliverBatch(
    batchId: string,
    options?: Readonly<{ force?: boolean }>,
  ): Promise<WorldMemoryOutboxDeliveryResult | null>;
  pendingCount(): Promise<number>;
}

export type FileWorldMemoryIngestionOutboxOptions = Readonly<{
  directory: string;
  writer: WorldMemoryWriterLike;
  batchSize?: number;
  maxPendingBatches?: number;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => Date;
  randomId?: () => string;
  onReconcile?: (result: WorldMemoryOutboxReconcileResult) => void;
  onError?: (error: WorldMemoryError) => void;
}>;

type ResolvedOptions = Readonly<{
  directory: string;
  writer: WorldMemoryWriterLike;
  batchSize: number;
  maxPendingBatches: number;
  pollIntervalMs: number;
  retryBaseMs: number;
  retryMaxMs: number;
  now: () => Date;
  randomId: () => string;
  onReconcile?: (result: WorldMemoryOutboxReconcileResult) => void;
  onError?: (error: WorldMemoryError) => void;
}>;

type RetryState = Readonly<{
  attemptCount: number;
  availableAtMs: number;
}>;

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function validNow(now: () => Date): Date {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new WorldMemoryError(
      "WORLD_MEMORY_OUTBOX_IO_FAILED",
      "World-memory outbox clock is invalid.",
    );
  }
  return value;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

function normalizedCommands(
  commands: readonly WorldMemoryWriteCommand[],
): readonly WorldMemoryWriteCommand[] {
  return Object.freeze(
    z
      .array(worldMemoryWriteCommandSchema)
      .min(1)
      .max(MAX_WORLD_MEMORY_OUTBOX_COMMANDS)
      .parse(commands)
      .map((command) => Object.freeze(command)),
  );
}

function payloadFingerprint(
  batchId: string,
  commands: readonly WorldMemoryWriteCommand[],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonicalize({ schemaVersion: "1.0", batchId, commands }),
      ),
      "utf8",
    )
    .digest("hex");
}

function outboxError(
  code:
    | "WORLD_MEMORY_OUTBOX_CONFLICT"
    | "WORLD_MEMORY_OUTBOX_FULL"
    | "WORLD_MEMORY_OUTBOX_INVALID"
    | "WORLD_MEMORY_OUTBOX_IO_FAILED",
  message: string,
  cause?: unknown,
): WorldMemoryError {
  return new WorldMemoryError(
    code,
    message,
    cause === undefined ? {} : { cause },
  );
}

function isNodeError(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

function stableErrorCode(error: unknown): string {
  return error instanceof Error &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "WORLD_MEMORY_INGESTION_FAILED";
}

function pendingFileName(batchId: string): string {
  return `${z.string().uuid().parse(batchId)}.pending.json`;
}

export class FileWorldMemoryIngestionOutbox
  implements WorldMemoryIngestionOutboxLike
{
  private readonly options: ResolvedOptions;
  private readonly retryState = new Map<string, RetryState>();
  private initializePromise: Promise<void> | null = null;
  private runPromise: Promise<void> | null = null;
  private startPromise: Promise<void> | null = null;
  private sleepTimer: NodeJS.Timeout | null = null;
  private wakeSleep: (() => void) | null = null;
  private stopping = false;

  constructor(options: FileWorldMemoryIngestionOutboxOptions) {
    const directory = resolve(options.directory);
    if (
      options.directory.trim().length === 0 ||
      options.directory.length > 1_024 ||
      !isAbsolute(options.directory) ||
      directory === parse(directory).root
    ) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_OUTBOX_INVALID",
        "World-memory outbox directory must be a non-root absolute path.",
      );
    }
    const resolved: ResolvedOptions = {
      directory,
      writer: options.writer,
      batchSize: boundedInteger(
        options.batchSize ?? DEFAULT_BATCH_SIZE,
        1,
        MAX_WORLD_MEMORY_OUTBOX_BATCH_SIZE,
        "World-memory outbox batch size",
      ),
      maxPendingBatches: boundedInteger(
        options.maxPendingBatches ?? 10_000,
        1,
        MAX_WORLD_MEMORY_OUTBOX_PENDING_BATCHES,
        "World-memory outbox capacity",
      ),
      pollIntervalMs: boundedInteger(
        options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
        50,
        60_000,
        "World-memory outbox poll interval",
      ),
      retryBaseMs: boundedInteger(
        options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS,
        10,
        60_000,
        "World-memory outbox retry base",
      ),
      retryMaxMs: boundedInteger(
        options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS,
        100,
        MAX_RETRY_DELAY_MS,
        "World-memory outbox retry maximum",
      ),
      now: options.now ?? (() => new Date()),
      randomId: options.randomId ?? randomUUID,
      ...(options.onReconcile === undefined
        ? {}
        : { onReconcile: options.onReconcile }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    };
    if (resolved.retryBaseMs > resolved.retryMaxMs) {
      throw new RangeError(
        "World-memory outbox retry base must not exceed its maximum.",
      );
    }
    this.options = resolved;
  }

  async enqueue(
    batchIdInput: string,
    inputCommands: readonly WorldMemoryWriteCommand[],
  ): Promise<WorldMemoryOutboxEnqueueResult> {
    await this.initialize();
    const batchId = z.string().uuid().parse(batchIdInput);
    const commands = normalizedCommands(inputCommands);
    const envelope = durableWorldMemoryOutboxEnvelopeSchema.parse({
      schemaVersion: "1.0",
      batchId,
      payloadFingerprint: payloadFingerprint(batchId, commands),
      commands,
      enqueuedAt: validNow(this.options.now).toISOString(),
    });
    const target = this.pendingPath(batchId);
    const existing = await this.readEnvelopeIfPresent(target, batchId);
    if (existing !== null) {
      this.assertSamePayload(existing, envelope);
      return {
        batchId,
        created: false,
        pendingBatchCount: await this.pendingCount(),
      };
    }
    const pending = await this.pendingCount();
    if (pending >= this.options.maxPendingBatches) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_OUTBOX_FULL",
        "World-memory ingestion outbox reached its configured capacity.",
      );
    }

    const temporary = join(
      this.options.directory,
      `.tmp-${batchId}-${z.string().uuid().parse(this.options.randomId())}.json`,
    );
    const serialized = `${JSON.stringify(envelope)}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_WORLD_MEMORY_OUTBOX_FILE_BYTES) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_OUTBOX_INVALID",
        "World-memory ingestion batch exceeds its durable file boundary.",
      );
    }
    try {
      const handle = await open(temporary, WRITE_FLAGS, 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      const created = await this.promoteTemporary(temporary, envelope);
      return {
        batchId,
        created,
        pendingBatchCount: await this.pendingCount(),
      };
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        await unlink(temporary).catch(() => undefined);
      }
      if (error instanceof WorldMemoryError) throw error;
      throw outboxError(
        "WORLD_MEMORY_OUTBOX_IO_FAILED",
        "World-memory ingestion batch could not be durably enqueued.",
        error,
      );
    }
  }

  async deliverBatch(
    batchIdInput: string,
    options: Readonly<{ force?: boolean }> = {},
  ): Promise<WorldMemoryOutboxDeliveryResult | null> {
    await this.initialize();
    const batchId = z.string().uuid().parse(batchIdInput);
    const retry = this.retryState.get(batchId);
    if (
      !options.force &&
      retry !== undefined &&
      retry.availableAtMs > validNow(this.options.now).getTime()
    ) {
      return {
        batchId,
        commandCount: 0,
        delivered: false,
        createdCount: 0,
        replayedCount: 0,
        deferredCount: 0,
        errorCode: "WORLD_MEMORY_OUTBOX_BACKOFF",
      };
    }
    const target = this.pendingPath(batchId);
    const envelope = await this.readEnvelopeIfPresent(target, batchId);
    if (envelope === null) return null;

    let createdCount = 0;
    let replayedCount = 0;
    for (const command of envelope.commands) {
      try {
        const recorded = await this.options.writer.record(command);
        if (recorded.created) createdCount += 1;
        else replayedCount += 1;
      } catch (error) {
        this.scheduleRetry(batchId);
        return {
          batchId,
          commandCount: envelope.commands.length,
          delivered: false,
          createdCount,
          replayedCount,
          deferredCount:
            envelope.commands.length - createdCount - replayedCount,
          errorCode: stableErrorCode(error),
        };
      }
    }

    try {
      await unlink(target);
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) {
        this.scheduleRetry(batchId);
        return {
          batchId,
          commandCount: envelope.commands.length,
          delivered: false,
          createdCount,
          replayedCount,
          deferredCount: 0,
          errorCode: "WORLD_MEMORY_OUTBOX_IO_FAILED",
        };
      }
    }
    await this.syncDirectory();
    this.retryState.delete(batchId);
    return {
      batchId,
      commandCount: envelope.commands.length,
      delivered: true,
      createdCount,
      replayedCount,
      deferredCount: 0,
      errorCode: null,
    };
  }

  async reconcileOnce(): Promise<WorldMemoryOutboxReconcileResult> {
    await this.initialize();
    const names = (await this.pendingFileNames()).slice(0, this.options.batchSize);
    let delivered = 0;
    let failed = 0;
    let createdCount = 0;
    let replayedCount = 0;
    let deferredCount = 0;
    let examined = 0;
    for (const name of names) {
      const match = PENDING_FILE_PATTERN.exec(name);
      if (!match?.[1]) continue;
      if (this.retryPending(match[1])) continue;
      examined += 1;
      try {
        const result = await this.deliverBatch(match[1]);
        if (result === null) continue;
        createdCount += result.createdCount;
        replayedCount += result.replayedCount;
        deferredCount += result.deferredCount;
        if (result.delivered) delivered += 1;
        else if (result.errorCode !== "WORLD_MEMORY_OUTBOX_BACKOFF") failed += 1;
      } catch (error) {
        failed += 1;
        this.scheduleRetry(match[1]);
        const failure =
          error instanceof WorldMemoryError
            ? error
            : outboxError(
                "WORLD_MEMORY_OUTBOX_IO_FAILED",
                "World-memory outbox reconciliation failed.",
                error,
              );
        this.options.onError?.(failure);
      }
    }
    const result = Object.freeze({
      examined,
      delivered,
      failed,
      createdCount,
      replayedCount,
      deferredCount,
      pendingBatchCount: await this.pendingCount(),
    });
    this.options.onReconcile?.(result);
    return result;
  }

  async pendingCount(): Promise<number> {
    await this.initialize();
    return (await this.pendingFileNames()).length;
  }

  async start(): Promise<void> {
    if (this.runPromise !== null) return;
    if (this.startPromise !== null) return await this.startPromise;
    this.stopping = false;
    this.startPromise = (async () => {
      await this.initialize();
      await this.reconcileOnce();
      this.runPromise = this.runLoop();
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async stop(): Promise<void> {
    if (this.startPromise !== null) await this.startPromise.catch(() => undefined);
    this.stopping = true;
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.wakeSleep?.();
    this.wakeSleep = null;
    const running = this.runPromise;
    if (running !== null) await running;
    this.runPromise = null;
  }

  private async initialize(): Promise<void> {
    if (this.initializePromise === null) {
      this.initializePromise = this.initializeOnce();
    }
    await this.initializePromise;
  }

  private async initializeOnce(): Promise<void> {
    try {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      const status = await lstat(this.options.directory);
      if (!status.isDirectory() || status.isSymbolicLink()) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox path must be a real directory.",
        );
      }
      if (
        process.platform !== "win32" &&
        typeof process.getuid === "function" &&
        status.uid !== process.getuid()
      ) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox directory must be owned by the Coordinator user.",
        );
      }
      if (process.platform !== "win32") {
        await chmod(this.options.directory, 0o700);
      }
      await this.recoverTemporaryFiles();
    } catch (error) {
      if (error instanceof WorldMemoryError) throw error;
      throw outboxError(
        "WORLD_MEMORY_OUTBOX_IO_FAILED",
        "World-memory outbox directory could not be initialized.",
        error,
      );
    }
  }

  private async recoverTemporaryFiles(): Promise<void> {
    const entries = await readdir(this.options.directory, { withFileTypes: true });
    for (const entry of entries) {
      const match = TEMP_FILE_PATTERN.exec(entry.name);
      if (!match?.[1]) continue;
      if (!entry.isFile()) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox temporary entry is not a regular file.",
        );
      }
      const temporary = join(this.options.directory, entry.name);
      const envelope = await this.readEnvelope(temporary, match[1]);
      await this.promoteTemporary(temporary, envelope);
    }
  }

  private async promoteTemporary(
    temporary: string,
    envelope: DurableWorldMemoryOutboxEnvelope,
  ): Promise<boolean> {
    const target = this.pendingPath(envelope.batchId);
    let created = true;
    try {
      await link(temporary, target);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      const existing = await this.readEnvelope(target, envelope.batchId);
      this.assertSamePayload(existing, envelope);
      created = false;
    }
    await this.syncFile(target);
    await unlink(temporary).catch((error: unknown) => {
      if (!isNodeError(error, "ENOENT")) throw error;
    });
    await this.syncDirectory();
    return created;
  }

  private assertSamePayload(
    existing: DurableWorldMemoryOutboxEnvelope,
    proposed: DurableWorldMemoryOutboxEnvelope,
  ): void {
    if (existing.payloadFingerprint !== proposed.payloadFingerprint) {
      throw new WorldMemoryError(
        "WORLD_MEMORY_OUTBOX_CONFLICT",
        "World-memory ingestion batch ID was reused with different content.",
      );
    }
  }

  private async readEnvelopeIfPresent(
    path: string,
    expectedBatchId: string,
  ): Promise<DurableWorldMemoryOutboxEnvelope | null> {
    try {
      return await this.readEnvelope(path, expectedBatchId);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return null;
      throw error;
    }
  }

  private async readEnvelope(
    path: string,
    expectedBatchId: string,
  ): Promise<DurableWorldMemoryOutboxEnvelope> {
    let handle;
    try {
      handle = await open(path, READ_FLAGS);
      const status = await handle.stat();
      if (
        !status.isFile() ||
        status.size <= 0 ||
        status.size > MAX_WORLD_MEMORY_OUTBOX_FILE_BYTES ||
        (process.platform !== "win32" && (status.mode & 0o077) !== 0) ||
        (process.platform !== "win32" &&
          typeof process.getuid === "function" &&
          status.uid !== process.getuid())
      ) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox file failed ownership, mode, type, or size checks.",
        );
      }
      const raw = await handle.readFile("utf8");
      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch (error) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox file is not valid JSON.",
          error,
        );
      }
      const parsed = durableWorldMemoryOutboxEnvelopeSchema.safeParse(decoded);
      if (!parsed.success) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox envelope failed strict schema validation.",
          parsed.error,
        );
      }
      const envelope = parsed.data;
      if (
        envelope.batchId !== expectedBatchId ||
        envelope.payloadFingerprint !==
          payloadFingerprint(envelope.batchId, envelope.commands)
      ) {
        throw outboxError(
          "WORLD_MEMORY_OUTBOX_INVALID",
          "World-memory outbox identity or payload fingerprint is invalid.",
        );
      }
      return envelope;
    } catch (error) {
      if (
        error instanceof WorldMemoryError ||
        isNodeError(error, "ENOENT")
      ) {
        throw error;
      }
      throw outboxError(
        "WORLD_MEMORY_OUTBOX_IO_FAILED",
        "World-memory outbox file could not be read safely.",
        error,
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private pendingPath(batchId: string): string {
    return join(this.options.directory, pendingFileName(batchId));
  }

  private async pendingFileNames(): Promise<readonly string[]> {
    const entries = await readdir(this.options.directory, { withFileTypes: true });
    return entries
      .filter((entry) => PENDING_FILE_PATTERN.test(entry.name))
      .map(({ name }) => name)
      .sort();
  }

  private scheduleRetry(batchId: string): void {
    const previous = this.retryState.get(batchId)?.attemptCount ?? 0;
    const attemptCount = previous + 1;
    const delay = Math.min(
      this.options.retryMaxMs,
      this.options.retryBaseMs * 2 ** Math.min(attemptCount - 1, 20),
    );
    this.retryState.set(batchId, {
      attemptCount,
      availableAtMs: validNow(this.options.now).getTime() + delay,
    });
  }

  private retryPending(batchId: string): boolean {
    const retry = this.retryState.get(batchId);
    return (
      retry !== undefined &&
      retry.availableAtMs > validNow(this.options.now).getTime()
    );
  }

  private async runLoop(): Promise<void> {
    while (!this.stopping) {
      await this.sleep();
      if (this.stopping) break;
      try {
        await this.reconcileOnce();
      } catch (error) {
        const failure =
          error instanceof WorldMemoryError
            ? error
            : outboxError(
                "WORLD_MEMORY_OUTBOX_IO_FAILED",
                "World-memory outbox polling failed.",
                error,
              );
        this.options.onError?.(failure);
      }
    }
  }

  private async sleep(): Promise<void> {
    await new Promise<void>((resolveSleep) => {
      this.wakeSleep = resolveSleep;
      this.sleepTimer = setTimeout(resolveSleep, this.options.pollIntervalMs);
      this.sleepTimer.unref?.();
    });
    this.sleepTimer = null;
    this.wakeSleep = null;
  }

  private async syncDirectory(): Promise<void> {
    let handle;
    try {
      handle = await open(this.options.directory, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      if (
        !isNodeError(error, "EINVAL") &&
        !isNodeError(error, "ENOTSUP") &&
        !isNodeError(error, "EPERM") &&
        !isNodeError(error, "EISDIR")
      ) {
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async syncFile(path: string): Promise<void> {
    const handle = await open(path, READ_FLAGS);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

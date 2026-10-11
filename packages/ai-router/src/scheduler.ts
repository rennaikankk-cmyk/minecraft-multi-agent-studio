import { botIdentitySchema } from "@minecraft-studio/protocol";
import { AIError } from './errors.js';

export const aiRequestPriorities = {
  systemCritical: 0,
  combat: 10,
  recovery: 20,
  planning: 30,
  exploration: 50,
  chat: 80,
  background: 100,
} as const;

/**
 * P0-4 purpose-aware deadline ceilings（单一事实源）。
 *
 * 语义：effective timeout = min(调用方显式 timeout ?? defaultTimeoutMs, 本档上限)。
 * - 调用方更紧的 deadline 永远生效（安全反射不等 LLM）。
 * - 档位是"按用途永不超时"的硬顶：chat 不该占住并发槽 10 分钟，即使调用方没写。
 * - planning 档刻意宽（真实 Spark 高层规划实测 ~13s；45s 顶仍是有界承诺，
 *   绝不无限调大单一全局 timeout——过期/取消/被替代的响应由 planner 的
 *   语义 revalidation 拒绝，而不是靠超短 deadline 碰运气）。
 */
export const aiDeadlineProfileCeilingsMs: Readonly<Record<keyof typeof aiRequestPriorities, number>> = {
  systemCritical: 3_000,
  combat: 5_000,
  recovery: 8_000,
  planning: 45_000,
  exploration: 20_000,
  chat: 15_000,
  background: 120_000,
};

/** 就近档位（priority 数值最接近且不超过的档；超过 background 归 background）。 */
export function deadlineCeilingForPriority(priority: number): number {
  // 只在 value <= priority 的档里取最大者（"不超过"语义）。
  // 旧实现的 Math.abs 双向取最近档：priority=16 会错取 recovery 的 8s
  // 而非 combat 的 5s，上限比文档语义更宽松。
  let ceiling = aiDeadlineProfileCeilingsMs.background;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (const [name, value] of Object.entries(aiRequestPriorities) as Array<[keyof typeof aiRequestPriorities, number]>) {
    if (value <= priority && value > bestValue) {
      bestValue = value;
      ceiling = aiDeadlineProfileCeilingsMs[name];
    }
  }
  return ceiling;
}

export type AIRequestPriority = number;

export type AISchedulerErrorCode =
  | 'AI_DUPLICATE_REQUEST_ID'
  | 'AI_QUEUE_FULL'
  | 'AI_REQUEST_CANCELLED'
  | 'AI_REQUEST_FAILED'
  | 'AI_REQUEST_SUPERSEDED'
  | 'AI_REQUEST_TIMEOUT'
  | 'AI_SCHEDULER_CLOSED';

export class AISchedulerError extends Error {
  constructor(
    readonly code: AISchedulerErrorCode,
    message: string,
    readonly requestId: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'AISchedulerError';
  }
}

export type AIRetryPolicy = Readonly<{
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio?: number;
  retryable?: (error: unknown) => boolean;
}>;

export type AIRequestExecutionContext = Readonly<{
  requestId: string;
  botId: string;
  attempt: number;
  signal: AbortSignal;
}>;

export type AIScheduledRequest<T> = Readonly<{
  requestId: string;
  botId: string;
  priority: AIRequestPriority;
  timeoutMs?: number;
  deduplicationKey?: string;
  supersedeKey?: string;
  retry?: AIRetryPolicy;
  signal?: AbortSignal;
  execute: (context: AIRequestExecutionContext) => Promise<T>;
}>;

export type AIScheduledResult<T> = Readonly<{
  requestId: string;
  botId: string;
  priority: AIRequestPriority;
  value: T;
  attempts: number;
  enqueuedAt: string;
  startedAt: string;
  completedAt: string;
  queueTimeMs: number;
  executionTimeMs: number;
  totalTimeMs: number;
}>;

export type AISchedulerEventType =
  | 'cancelled'
  | 'completed'
  | 'deduplicated'
  | 'enqueued'
  | 'failed'
  | 'rejected'
  | 'retrying'
  | 'started';

export type AISchedulerEvent = Readonly<{
  type: AISchedulerEventType;
  timestamp: string;
  requestId: string;
  botId: string;
  priority: AIRequestPriority;
  attempt?: number;
  delayMs?: number;
  errorCode?: AISchedulerErrorCode;
  queueTimeMs?: number;
}>;

export type AISchedulerBotSnapshot = Readonly<{
  botId: string;
  queued: number;
  running: number;
}>;

export type AISchedulerSnapshot = Readonly<{
  accepting: boolean;
  queued: number;
  running: number;
  maxConcurrency: number;
  maxQueue: number;
  perBotConcurrency: number;
  bots: readonly AISchedulerBotSnapshot[];
}>;

export type AIRequestSchedulerOptions = Readonly<{
  defaultRetry?: AIRetryPolicy;
  maxConcurrency?: number;
  maxQueue?: number;
  perBotConcurrency?: number;
  defaultTimeoutMs?: number;
  now?: () => number;
  random?: () => number;
  onEvent?: (event: AISchedulerEvent) => void;
}>;

type RequestState = 'queued' | 'running' | 'settled';

type QueueEntry<T> = {
  request: AIScheduledRequest<T>;
  sequence: number;
  enqueuedAtMs: number;
  startedAtMs: number | null;
  attempts: number;
  state: RequestState;
  controller: AbortController;
  terminalError: AISchedulerError | null;
  timeout: ReturnType<typeof setTimeout> | null;
  removeExternalAbortListener: (() => void) | null;
  promise: Promise<AIScheduledResult<T>>;
  resolve: (result: AIScheduledResult<T>) => void;
  reject: (error: AISchedulerError) => void;
};

type AnyQueueEntry = QueueEntry<unknown>;

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;

export class AIRequestScheduler {
  private readonly maxConcurrency: number;
  private readonly maxQueue: number;
  /** 多 Bot 公平调度：同优先级下优先最久未获调度的 bot（防单 bot 洪泛饿死他人）。 */
  private readonly lastDispatchSequenceByBot = new Map<string, number>();
  private dispatchClock = 0;
  private readonly perBotConcurrency: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultRetry: AIRetryPolicy | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onEvent: (event: AISchedulerEvent) => void;
  private readonly queue: AnyQueueEntry[] = [];
  private readonly active = new Map<string, AnyQueueEntry>();
  private readonly deduplication = new Map<string, AnyQueueEntry>();
  private readonly runningByBot = new Map<string, number>();
  private running = 0;
  private sequence = 0;
  private accepting = true;

  constructor(options: AIRequestSchedulerOptions = {}) {
    if (options.defaultRetry) normalizedRetry(options.defaultRetry);
    this.defaultRetry = options.defaultRetry;
    this.maxConcurrency = boundedInteger(
      options.maxConcurrency ?? 12,
      1,
      64,
      'maxConcurrency',
    );
    this.maxQueue = boundedInteger(options.maxQueue ?? 64, 1, 10_000, 'maxQueue');
    this.perBotConcurrency = boundedInteger(
      options.perBotConcurrency ?? 1,
      1,
      this.maxConcurrency,
      'perBotConcurrency',
    );
    this.defaultTimeoutMs = boundedInteger(
      options.defaultTimeoutMs ?? 30_000,
      10,
      10 * 60_000,
      'defaultTimeoutMs',
    );
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent ?? (() => undefined);
  }

  schedule<T>(request: AIScheduledRequest<T>): Promise<AIScheduledResult<T>> {
    validateRequest(request, this.defaultTimeoutMs);

    if (!this.accepting) {
      return Promise.reject(
        this.error('AI_SCHEDULER_CLOSED', request, 'AI request scheduler is closed.'),
      );
    }
    if (request.signal?.aborted) {
      return Promise.reject(
        this.error('AI_REQUEST_CANCELLED', request, 'AI request was already cancelled.'),
      );
    }

    if (this.active.has(request.requestId)) {
      const error = this.error(
        'AI_DUPLICATE_REQUEST_ID',
        request,
        `AI request ${request.requestId} is already active.`,
      );
      this.emit('rejected', request, { errorCode: error.code });
      return Promise.reject(error);
    }

    if (request.deduplicationKey) {
      const duplicate = this.deduplication.get(request.deduplicationKey);
      if (duplicate) {
        this.emit('deduplicated', request);
        return duplicate.promise as Promise<AIScheduledResult<T>>;
      }
    }

    const superseded = request.supersedeKey
      ? [...this.active.values()].filter(
          (entry) =>
            entry.request.botId === request.botId &&
            entry.request.supersedeKey === request.supersedeKey,
        )
      : [];
    const supersededQueued = superseded.filter((entry) => entry.state === 'queued').length;

    if (this.queue.length >= this.maxQueue && supersededQueued === 0) {
      const error = this.error(
        'AI_QUEUE_FULL',
        request,
        `AI request queue reached its limit of ${this.maxQueue}.`,
      );
      this.emit('rejected', request, { errorCode: error.code });
      return Promise.reject(error);
    }

    for (const entry of superseded) {
      this.cancelEntry(
        entry,
        this.error(
          'AI_REQUEST_SUPERSEDED',
          entry.request,
          `AI request was superseded by ${request.requestId}.`,
        ),
      );
    }

    if (this.queue.length >= this.maxQueue) {
      const error = this.error(
        'AI_QUEUE_FULL',
        request,
        `AI request queue reached its limit of ${this.maxQueue}.`,
      );
      this.emit('rejected', request, { errorCode: error.code });
      return Promise.reject(error);
    }

    const entry = this.createEntry(request);
    this.queue.push(entry as AnyQueueEntry);
    this.active.set(request.requestId, entry as AnyQueueEntry);
    if (request.deduplicationKey) {
      this.deduplication.set(request.deduplicationKey, entry as AnyQueueEntry);
    }
    this.emit('enqueued', request);
    this.drain();
    return entry.promise;
  }

  cancel(requestId: string, reason = 'operator request'): boolean {
    const entry = this.active.get(requestId);
    if (!entry) return false;
    return this.cancelEntry(
      entry,
      this.error(
        'AI_REQUEST_CANCELLED',
        entry.request,
        `AI request was cancelled: ${boundedReason(reason)}.`,
      ),
    );
  }

  cancelBot(botId: string, reason = 'bot request cancellation'): number {
    validateIdentifier(botId, 'botId');
    let cancelled = 0;
    for (const entry of [...this.active.values()]) {
      if (entry.request.botId === botId && this.cancel(entry.request.requestId, reason)) {
        cancelled += 1;
      }
    }
    return cancelled;
  }

  close(reason = 'scheduler shutdown'): void {
    if (!this.accepting) return;
    this.accepting = false;
    for (const entry of [...this.active.values()]) {
      this.cancelEntry(
        entry,
        this.error(
          'AI_SCHEDULER_CLOSED',
          entry.request,
          `AI request scheduler closed: ${boundedReason(reason)}.`,
        ),
      );
    }
  }

  snapshot(): AISchedulerSnapshot {
    const botIds = new Set<string>();
    for (const entry of this.active.values()) botIds.add(entry.request.botId);
    const bots = [...botIds]
      .map((botId) => ({
        botId,
        queued: this.queue.filter((entry) => entry.request.botId === botId).length,
        running: this.runningByBot.get(botId) ?? 0,
      }))
      .sort((left, right) => left.botId.localeCompare(right.botId));
    return {
      accepting: this.accepting,
      queued: this.queue.length,
      running: this.running,
      maxConcurrency: this.maxConcurrency,
      maxQueue: this.maxQueue,
      perBotConcurrency: this.perBotConcurrency,
      bots,
    };
  }

  private createEntry<T>(request: AIScheduledRequest<T>): QueueEntry<T> {
    let resolve!: (result: AIScheduledResult<T>) => void;
    let reject!: (error: AISchedulerError) => void;
    const promise = new Promise<AIScheduledResult<T>>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    const entry: QueueEntry<T> = {
      request,
      sequence: this.sequence++,
      enqueuedAtMs: this.now(),
      startedAtMs: null,
      attempts: 0,
      state: 'queued',
      controller: new AbortController(),
      terminalError: null,
      timeout: null,
      removeExternalAbortListener: null,
      promise,
      resolve,
      reject,
    };

    // P0-4：purpose-aware 硬顶——调用方显式值/default 中较紧者，再被档位上限封顶。
    const timeoutMs = Math.min(
      request.timeoutMs ?? this.defaultTimeoutMs,
      deadlineCeilingForPriority(request.priority),
    );
    entry.timeout = setTimeout(() => {
      this.cancelEntry(
        entry as AnyQueueEntry,
        this.error(
          'AI_REQUEST_TIMEOUT',
          request,
          `AI request exceeded its ${timeoutMs}ms total timeout.`,
        ),
      );
    }, timeoutMs);
    // background 档上限 120s：不 unref 会拖住进程退出（该包 tsconfig 无 node
    // 类型，DOM lib 下定时器是 number——用结构化转型调用 unref）。
    (entry.timeout as unknown as { unref?: () => void }).unref?.();

    if (request.signal) {
      const abort = () => {
        this.cancelEntry(
          entry as AnyQueueEntry,
          this.error('AI_REQUEST_CANCELLED', request, 'AI request was cancelled by its caller.'),
        );
      };
      request.signal.addEventListener('abort', abort, { once: true });
      entry.removeExternalAbortListener = () =>
        request.signal?.removeEventListener('abort', abort);
    }
    return entry;
  }

  private drain(): void {
    while (this.running < this.maxConcurrency) {
      const index = this.nextDispatchableIndex();
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (!entry || entry.state !== 'queued') continue;
      entry.state = 'running';
      entry.startedAtMs = this.now();
      this.running += 1;
      this.runningByBot.set(
        entry.request.botId,
        (this.runningByBot.get(entry.request.botId) ?? 0) + 1,
      );
      this.emit('started', entry.request, {
        queueTimeMs: Math.max(0, entry.startedAtMs - entry.enqueuedAtMs),
      });
      void this.runEntry(entry);
    }
  }

  private nextDispatchableIndex(): number {
    let selectedIndex = -1;
    let selected: AnyQueueEntry | null = null;
    for (let index = 0; index < this.queue.length; index += 1) {
      const candidate = this.queue[index];
      if (!candidate || candidate.state !== 'queued') continue;
      if ((this.runningByBot.get(candidate.request.botId) ?? 0) >= this.perBotConcurrency) {
        continue;
      }
      if (!selected) {
        selected = candidate;
        selectedIndex = index;
        continue;
      }
      if (candidate.request.priority < selected.request.priority) {
        selected = candidate;
        selectedIndex = index;
        continue;
      }
      if (candidate.request.priority === selected.request.priority) {
        // 公平性：同优先级先比 per-bot 最近调度序（小者优先），再比 FIFO sequence
        const candidateBotSeq = this.lastDispatchSequenceByBot.get(candidate.request.botId) ?? -1;
        const selectedBotSeq = this.lastDispatchSequenceByBot.get(selected.request.botId) ?? -1;
        if (candidateBotSeq < selectedBotSeq ||
            (candidateBotSeq === selectedBotSeq && candidate.sequence < selected.sequence)) {
          selected = candidate;
          selectedIndex = index;
        }
      }
    }
    return selectedIndex;
  }

  private async runEntry(entry: AnyQueueEntry): Promise<void> {
    this.dispatchClock += 1;
    this.lastDispatchSequenceByBot.set(entry.request.botId, this.dispatchClock);
    try {
      const retry = normalizedRetry(entry.request.retry ?? this.defaultRetry);
      for (;;) {
        if (entry.controller.signal.aborted) throw this.abortError(entry);
        entry.attempts += 1;
        try {
          const value = await raceWithAbort(
            Promise.resolve().then(() =>
              entry.request.execute({
                requestId: entry.request.requestId,
                botId: entry.request.botId,
                attempt: entry.attempts,
                signal: entry.controller.signal,
              }),
            ),
            entry.controller.signal,
            () => this.abortError(entry),
          );
          this.complete(entry, value);
          return;
        } catch (error) {
          if (entry.controller.signal.aborted) throw this.abortError(entry);
          if (entry.attempts >= retry.maxAttempts || (error instanceof AIError && !error.retryable) || !retry.retryable(error)) {
            throw error;
          }
          const retryAfterMs = error instanceof AIError ? error.retryAfterMs ?? 0 : 0;
          // A provider's longer cooldown is never shortened to fit our retry
          // policy: fail this request when the configured budget cannot honor it.
          if (retryAfterMs > retry.maxDelayMs) throw error;
          const delayMs = Math.max(retryAfterMs, retryDelay(retry, entry.attempts, this.random));
          this.emit('retrying', entry.request, {
            attempt: entry.attempts,
            delayMs,
          });
          await abortableDelay(delayMs, entry.controller.signal, () => this.abortError(entry));
        }
      }
    } catch (error) {
      this.fail(entry, this.normalizeFailure(entry, error));
    } finally {
      this.running -= 1;
      const botRunning = (this.runningByBot.get(entry.request.botId) ?? 1) - 1;
      if (botRunning <= 0) {
        this.runningByBot.delete(entry.request.botId);
        // 公平序号随 bot 生命周期清理：该 bot 既无运行也无排队条目时即为
        // 死数据（fleet 经 studio 管理器增删 botId 时 Map 无界增长）。队列
        // 非空时不得删——排队中的 bot 的调度年龄必须保留，否则下次选择会
        // 按"最久未调度"获得不正当优势。队列有界（maxQueue ≤10k），全扫
        // 成本可接受。
        if (
          !this.queue.some(
            (queued) => queued.request.botId === entry.request.botId,
          )
        ) {
          this.lastDispatchSequenceByBot.delete(entry.request.botId);
        }
      } else {
        this.runningByBot.set(entry.request.botId, botRunning);
      }
      this.drain();
    }
  }

  private complete(entry: AnyQueueEntry, value: unknown): void {
    if (entry.state === 'settled') return;
    const completedAtMs = this.now();
    const startedAtMs = entry.startedAtMs ?? completedAtMs;
    entry.state = 'settled';
    this.cleanup(entry);
    entry.resolve({
      requestId: entry.request.requestId,
      botId: entry.request.botId,
      priority: entry.request.priority,
      value,
      attempts: entry.attempts,
      enqueuedAt: new Date(entry.enqueuedAtMs).toISOString(),
      startedAt: new Date(startedAtMs).toISOString(),
      completedAt: new Date(completedAtMs).toISOString(),
      queueTimeMs: Math.max(0, startedAtMs - entry.enqueuedAtMs),
      executionTimeMs: Math.max(0, completedAtMs - startedAtMs),
      totalTimeMs: Math.max(0, completedAtMs - entry.enqueuedAtMs),
    });
    this.emit('completed', entry.request, { attempt: entry.attempts });
  }

  private fail(entry: AnyQueueEntry, error: AISchedulerError): void {
    if (entry.state === 'settled') return;
    entry.state = 'settled';
    this.cleanup(entry);
    entry.reject(error);
    this.emit(
      error.code === 'AI_REQUEST_CANCELLED' ||
        error.code === 'AI_REQUEST_SUPERSEDED' ||
        error.code === 'AI_REQUEST_TIMEOUT' ||
        error.code === 'AI_SCHEDULER_CLOSED'
        ? 'cancelled'
        : 'failed',
      entry.request,
      { attempt: entry.attempts, errorCode: error.code },
    );
  }

  private cancelEntry(entry: AnyQueueEntry, error: AISchedulerError): boolean {
    if (entry.state === 'settled' || entry.terminalError) return false;
    entry.terminalError = error;
    entry.controller.abort(error);
    if (entry.state === 'queued') {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
      this.fail(entry, error);
      this.drain();
    }
    return true;
  }

  private cleanup(entry: AnyQueueEntry): void {
    if (entry.timeout) clearTimeout(entry.timeout);
    entry.timeout = null;
    entry.removeExternalAbortListener?.();
    entry.removeExternalAbortListener = null;
    this.active.delete(entry.request.requestId);
    if (
      entry.request.deduplicationKey &&
      this.deduplication.get(entry.request.deduplicationKey) === entry
    ) {
      this.deduplication.delete(entry.request.deduplicationKey);
    }
  }

  private abortError(entry: AnyQueueEntry): AISchedulerError {
    return (
      entry.terminalError ??
      this.error('AI_REQUEST_CANCELLED', entry.request, 'AI request was cancelled.')
    );
  }

  private normalizeFailure(entry: AnyQueueEntry, error: unknown): AISchedulerError {
    if (error instanceof AISchedulerError) return error;
    return this.error(
      'AI_REQUEST_FAILED',
      entry.request,
      error instanceof Error ? error.message : 'AI request failed.',
      error,
    );
  }

  private error(
    code: AISchedulerErrorCode,
    request: Pick<AIScheduledRequest<unknown>, 'requestId'>,
    message: string,
    cause?: unknown,
  ): AISchedulerError {
    return new AISchedulerError(
      code,
      boundedReason(message),
      request.requestId,
      cause === undefined ? undefined : { cause },
    );
  }

  private emit(
    type: AISchedulerEventType,
    request: Pick<AIScheduledRequest<unknown>, 'requestId' | 'botId' | 'priority'>,
    fields: Partial<
      Pick<AISchedulerEvent, 'attempt' | 'delayMs' | 'errorCode' | 'queueTimeMs'>
    > = {},
  ): void {
    try {
      this.onEvent({
        type,
        timestamp: new Date(this.now()).toISOString(),
        requestId: request.requestId,
        botId: request.botId,
        priority: request.priority,
        ...fields,
      });
    } catch {
      // Observability callbacks must never break request scheduling.
    }
  }
}

type NormalizedRetry = Readonly<{
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitterRatio: number;
  retryable: (error: unknown) => boolean;
}>;

function normalizedRetry(retry: AIRetryPolicy | undefined): NormalizedRetry {
  if (!retry) {
    return {
      maxAttempts: 1,
      baseDelayMs: 0,
      maxDelayMs: 0,
      jitterRatio: 0,
      retryable: () => false,
    };
  }
  const maxAttempts = boundedInteger(retry.maxAttempts, 1, 5, 'retry.maxAttempts');
  const baseDelayMs = boundedInteger(retry.baseDelayMs, 0, 60_000, 'retry.baseDelayMs');
  const maxDelayMs = boundedInteger(retry.maxDelayMs, 0, 60_000, 'retry.maxDelayMs');
  if (maxDelayMs < baseDelayMs) {
    throw new TypeError('retry.maxDelayMs must be greater than or equal to baseDelayMs.');
  }
  const jitterRatio = retry.jitterRatio ?? 0.2;
  if (!Number.isFinite(jitterRatio) || jitterRatio < 0 || jitterRatio > 1) {
    throw new TypeError('retry.jitterRatio must be between 0 and 1.');
  }
  return {
    maxAttempts,
    baseDelayMs,
    maxDelayMs,
    jitterRatio,
    retryable: retry.retryable ?? (() => true),
  };
}

function retryDelay(
  retry: NormalizedRetry,
  completedAttempts: number,
  random: () => number,
): number {
  const exponential = Math.min(
    retry.maxDelayMs,
    retry.baseDelayMs * 2 ** Math.max(0, completedAttempts - 1),
  );
  if (exponential === 0 || retry.jitterRatio === 0) return exponential;
  const sample = Math.min(1, Math.max(0, random()));
  const multiplier = 1 - retry.jitterRatio + 2 * retry.jitterRatio * sample;
  return Math.max(0, Math.round(exponential * multiplier));
}

function validateRequest<T>(request: AIScheduledRequest<T>, defaultTimeoutMs: number): void {
  validateIdentifier(request.requestId, 'requestId');
  validateIdentifier(request.botId, 'botId');
  if (!Number.isSafeInteger(request.priority) || request.priority < 0 || request.priority > 1000) {
    throw new TypeError('priority must be a safe integer between 0 and 1000.');
  }
  boundedInteger(
    request.timeoutMs ?? defaultTimeoutMs,
    10,
    10 * 60_000,
    'timeoutMs',
  );
  if (request.deduplicationKey) validateKey(request.deduplicationKey, 'deduplicationKey');
  if (request.supersedeKey) validateKey(request.supersedeKey, 'supersedeKey');
  if (typeof request.execute !== 'function') {
    throw new TypeError('execute must be a function.');
  }
  normalizedRetry(request.retry);
}

function validateIdentifier(value: string, field: string): void {
  if (!(field === 'botId' ? botIdentitySchema.safeParse(value).success : IDENTIFIER_PATTERN.test(value))) {
    throw new TypeError(`${field} is invalid.`);
  }
}

function validateKey(value: string, field: string): void {
  if (!KEY_PATTERN.test(value)) throw new TypeError(`${field} is invalid.`);
}

function boundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new TypeError(`${field} must be a safe integer between ${min} and ${max}.`);
  }
  return value;
}

function boundedReason(reason: string): string {
  return reason.replace(/[\r\n\t]+/gu, ' ').slice(0, 500);
}

async function raceWithAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortError: () => AISchedulerError,
): Promise<T> {
  if (signal.aborted) throw abortError();
  let removeAbortListener: () => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', abort);
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    removeAbortListener();
  }
}

async function abortableDelay(
  delayMs: number,
  signal: AbortSignal,
  abortError: () => AISchedulerError,
): Promise<void> {
  if (delayMs === 0) return;
  if (signal.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(abortError());
    };
    signal.addEventListener('abort', abort, { once: true });
  });
}

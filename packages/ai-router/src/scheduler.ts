import { AIError, asAIError } from "./errors.js";
import { parseAIRequest, type AIRequest } from "./request.js";
import type { AIRouter } from "./router.js";
import type { AIRouterResponse } from "./types/provider.js";

export type AISchedulerConfig = Readonly<{
  maxConcurrency: number;
  maxQueue: number;
  perBotConcurrency: number;
  staleAfterMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  retryMaxDelayMs: number;
}>;

export type AISchedulerSnapshot = Readonly<{
  running: number;
  waiting: number;
  maxConcurrency: number;
  maxQueue: number;
  perBotConcurrency: number;
  accepted: number;
  completed: number;
  failed: number;
  cancelled: number;
  stale: number;
}>;

export type AIScheduledResult<T = unknown> = AIRouterResponse<T> &
  Readonly<{
    requestId: string;
    botId: string;
    taskType: AIRequest<T>["taskType"];
    stateVersion: number;
    taskVersion: number;
    attempts: number;
    queueTimeMs: number;
    totalLatencyMs: number;
  }>;

export type AIScheduledHandle<T = unknown> = Readonly<{
  requestId: string;
  promise: Promise<AIScheduledResult<T>>;
  cancel(reason?: string): boolean;
}>;

type BotVersion = Readonly<{ stateVersion: number; taskVersion: number }>;

type QueueEntry = {
  request: AIRequest;
  sequence: number;
  acceptedAt: number;
  controller: AbortController;
  resolve: (result: AIScheduledResult) => void;
  reject: (error: AIError) => void;
  staleTimer: ReturnType<typeof setTimeout> | null;
  externalSignal?: AbortSignal;
  externalAbort?: () => void;
  state: "queued" | "running" | "settled";
};

function positiveInteger(value: number, name: string, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AIError("AI_CONFIG_INVALID", `${name} must be a safe positive integer.`);
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function combinedAttemptSignal(
  parent: AbortSignal,
  timeoutMs: number,
): Readonly<{ signal: AbortSignal; cleanup(): void }> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onAbort, { once: true });
  if (parent.aborted) onAbort();
  const timer = setTimeout(
    () => controller.abort(new AIError("AI_REQUEST_TIMEOUT", "AI request timed out.", {
      retryable: true,
    })),
    timeoutMs,
  );
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent.removeEventListener("abort", onAbort);
    },
  };
}

export class AIRequestScheduler {
  private readonly queue: QueueEntry[] = [];
  private readonly entries = new Map<string, QueueEntry>();
  private readonly activeByBot = new Map<string, number>();
  private readonly latestBotVersion = new Map<string, BotVersion>();
  private sequence = 0;
  private running = 0;
  private closed = false;
  private counters = {
    accepted: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    stale: 0,
  };

  constructor(
    private readonly router: AIRouter,
    private readonly config: AISchedulerConfig,
    private readonly now: () => number = Date.now,
  ) {
    positiveInteger(config.maxConcurrency, "maxConcurrency");
    positiveInteger(config.maxQueue, "maxQueue");
    positiveInteger(config.perBotConcurrency, "perBotConcurrency");
    positiveInteger(config.staleAfterMs, "staleAfterMs");
    positiveInteger(config.maxRetries, "maxRetries", true);
    positiveInteger(config.retryBaseDelayMs, "retryBaseDelayMs");
    positiveInteger(config.retryMaxDelayMs, "retryMaxDelayMs");
    if (config.retryBaseDelayMs > config.retryMaxDelayMs) {
      throw new AIError(
        "AI_CONFIG_INVALID",
        "retryBaseDelayMs cannot exceed retryMaxDelayMs.",
      );
    }
  }

  submit<T>(
    input: AIRequest<T>,
    options: Readonly<{ signal?: AbortSignal }> = {},
  ): AIScheduledHandle<T> {
    if (this.closed) {
      return this.rejectedHandle(
        input.requestId,
        new AIError("AI_QUEUE_CLOSED", "AI scheduler is closed."),
      );
    }
    let request: AIRequest<T>;
    try {
      request = parseAIRequest(input);
    } catch (error) {
      return this.rejectedHandle(
        input.requestId,
        new AIError("AI_REQUEST_INVALID", "AI request failed validation.", {
          cause: error,
        }),
      );
    }
    if (this.entries.has(request.requestId)) {
      return this.rejectedHandle(
        request.requestId,
        new AIError("AI_REQUEST_INVALID", "AI requestId is already active."),
      );
    }
    const timestamp = Date.parse(request.timestamp);
    if (this.now() - timestamp > this.config.staleAfterMs) {
      this.counters.stale += 1;
      return this.rejectedHandle(
        request.requestId,
        new AIError("AI_REQUEST_STALE", "AI request was stale before enqueue."),
      );
    }
    const latest = this.latestBotVersion.get(request.botId);
    if (
      latest !== undefined &&
      (request.stateVersion < latest.stateVersion ||
        request.taskVersion < latest.taskVersion)
    ) {
      this.counters.stale += 1;
      return this.rejectedHandle(
        request.requestId,
        new AIError("AI_REQUEST_STALE", "AI request carries an obsolete Bot version."),
      );
    }
    this.invalidateBot(request.botId, request.stateVersion, request.taskVersion);
    if (this.queue.length >= this.config.maxQueue) {
      return this.rejectedHandle(
        request.requestId,
        new AIError("AI_QUEUE_FULL", "AI request queue is full."),
      );
    }
    if (options.signal?.aborted) {
      return this.rejectedHandle(
        request.requestId,
        new AIError("AI_CANCELLED", "AI request was cancelled before enqueue."),
      );
    }

    const controller = new AbortController();
    let resolvePromise!: (result: AIScheduledResult<T>) => void;
    let rejectPromise!: (error: AIError) => void;
    const promise = new Promise<AIScheduledResult<T>>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const entry: QueueEntry = {
      request: request as AIRequest,
      sequence: this.sequence++,
      acceptedAt: this.now(),
      controller,
      resolve: (result) => resolvePromise(result as AIScheduledResult<T>),
      reject: rejectPromise,
      staleTimer: null,
      ...(options.signal === undefined ? {} : { externalSignal: options.signal }),
      state: "queued",
    };
    if (options.signal !== undefined) {
      const onAbort = () => this.cancel(request.requestId, "external_abort");
      entry.externalAbort = onAbort;
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
    entry.staleTimer = setTimeout(
      () => this.markQueuedStale(request.requestId),
      Math.max(1, this.config.staleAfterMs - (this.now() - timestamp)),
    );
    this.queue.push(entry);
    this.entries.set(request.requestId, entry);
    this.counters.accepted += 1;
    this.sortQueue();
    this.pump();
    return Object.freeze({
      requestId: request.requestId,
      promise,
      cancel: (reason?: string) => this.cancel(request.requestId, reason),
    });
  }

  invalidateBot(botId: string, stateVersion: number, taskVersion: number): number {
    const current = this.latestBotVersion.get(botId);
    if (
      current !== undefined &&
      stateVersion <= current.stateVersion &&
      taskVersion <= current.taskVersion
    ) {
      return 0;
    }
    this.latestBotVersion.set(botId, { stateVersion, taskVersion });
    let cancelled = 0;
    for (const entry of [...this.entries.values()]) {
      if (entry.request.botId !== botId) continue;
      if (
        entry.request.stateVersion < stateVersion ||
        entry.request.taskVersion < taskVersion
      ) {
        if (this.cancelAsStale(entry, "Bot state or task version advanced.")) {
          cancelled += 1;
        }
      }
    }
    return cancelled;
  }

  cancel(requestId: string, reason = "cancelled"): boolean {
    const entry = this.entries.get(requestId);
    if (entry === undefined || entry.state === "settled") return false;
    const error = new AIError("AI_CANCELLED", `AI request was cancelled: ${reason}.`);
    if (entry.state === "queued") {
      this.counters.cancelled += 1;
      this.settleRejected(entry, error);
    } else {
      entry.controller.abort(error);
    }
    return true;
  }

  close(reason = "scheduler_closed"): void {
    if (this.closed) return;
    this.closed = true;
    for (const requestId of [...this.entries.keys()]) this.cancel(requestId, reason);
  }

  snapshot(): AISchedulerSnapshot {
    return Object.freeze({
      running: this.running,
      waiting: this.queue.length,
      maxConcurrency: this.config.maxConcurrency,
      maxQueue: this.config.maxQueue,
      perBotConcurrency: this.config.perBotConcurrency,
      ...this.counters,
    });
  }

  private pump(): void {
    while (this.running < this.config.maxConcurrency) {
      const index = this.queue.findIndex(
        (entry) =>
          (this.activeByBot.get(entry.request.botId) ?? 0) <
          this.config.perBotConcurrency,
      );
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      if (entry === undefined || entry.state !== "queued") continue;
      if (this.isEntryStale(entry)) {
        this.cancelAsStale(entry, "AI request became stale while queued.");
        continue;
      }
      this.startEntry(entry);
    }
  }

  private startEntry(entry: QueueEntry): void {
    entry.state = "running";
    if (entry.staleTimer !== null) clearTimeout(entry.staleTimer);
    entry.staleTimer = null;
    this.running += 1;
    this.activeByBot.set(
      entry.request.botId,
      (this.activeByBot.get(entry.request.botId) ?? 0) + 1,
    );
    void this.execute(entry).then(
      (result) => {
        this.counters.completed += 1;
        this.settleResolved(entry, result);
      },
      (error: unknown) => {
        const failure = this.classifyExecutionFailure(error, entry);
        if (failure.code === "AI_CANCELLED") this.counters.cancelled += 1;
        else if (
          failure.code === "AI_REQUEST_STALE" ||
          failure.code === "AI_STALE_RESPONSE"
        ) this.counters.stale += 1;
        else this.counters.failed += 1;
        this.settleRejected(entry, failure);
      },
    ).finally(() => {
      this.running -= 1;
      const active = (this.activeByBot.get(entry.request.botId) ?? 1) - 1;
      if (active <= 0) this.activeByBot.delete(entry.request.botId);
      else this.activeByBot.set(entry.request.botId, active);
      this.pump();
    });
  }

  private async execute(entry: QueueEntry): Promise<AIScheduledResult> {
    const startedAt = this.now();
    let attempts = 0;
    while (attempts <= this.config.maxRetries) {
      attempts += 1;
      const attempt = combinedAttemptSignal(
        entry.controller.signal,
        entry.request.timeoutMs,
      );
      try {
        const response = await this.router.route(entry.request, attempt.signal);
        if (entry.controller.signal.aborted) throw entry.controller.signal.reason;
        if (this.isEntryStale(entry)) {
          throw new AIError(
            "AI_STALE_RESPONSE",
            "AI response was discarded because the Bot state changed.",
          );
        }
        return {
          ...response,
          requestId: entry.request.requestId,
          botId: entry.request.botId,
          taskType: entry.request.taskType,
          stateVersion: entry.request.stateVersion,
          taskVersion: entry.request.taskVersion,
          attempts,
          queueTimeMs: startedAt - entry.acceptedAt,
          totalLatencyMs: this.now() - entry.acceptedAt,
        };
      } catch (error) {
        const failure = attempt.signal.aborted && attempt.signal.reason instanceof AIError
          ? attempt.signal.reason
          : asAIError(error);
        if (
          entry.controller.signal.aborted ||
          !failure.retryable ||
          attempts > this.config.maxRetries ||
          this.isEntryStale(entry)
        ) {
          throw failure;
        }
        const retryDelay = Math.min(
          this.config.retryMaxDelayMs,
          this.config.retryBaseDelayMs * 2 ** (attempts - 1),
        );
        await delay(retryDelay, entry.controller.signal);
      } finally {
        attempt.cleanup();
      }
    }
    throw new AIError("AI_PROVIDER_FAILED", "AI request exhausted retries.");
  }

  private isEntryStale(entry: QueueEntry): boolean {
    const latest = this.latestBotVersion.get(entry.request.botId);
    return latest !== undefined &&
      (entry.request.stateVersion < latest.stateVersion ||
        entry.request.taskVersion < latest.taskVersion);
  }

  private cancelAsStale(entry: QueueEntry, message: string): boolean {
    if (entry.state === "settled") return false;
    const error = new AIError("AI_REQUEST_STALE", message);
    if (entry.state === "queued") {
      this.counters.stale += 1;
      this.settleRejected(entry, error);
    } else {
      entry.controller.abort(error);
    }
    return true;
  }

  private markQueuedStale(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (entry?.state === "queued") {
      this.cancelAsStale(entry, "AI request exceeded maximum queue age.");
      this.pump();
    }
  }

  private classifyExecutionFailure(error: unknown, entry: QueueEntry): AIError {
    if (entry.controller.signal.reason instanceof AIError) {
      return entry.controller.signal.reason;
    }
    if (error instanceof AIError) return error;
    return asAIError(error);
  }

  private settleResolved(entry: QueueEntry, result: AIScheduledResult): void {
    if (entry.state === "settled") return;
    this.cleanupEntry(entry);
    entry.resolve(result);
  }

  private settleRejected(entry: QueueEntry, error: AIError): void {
    if (entry.state === "settled") return;
    this.cleanupEntry(entry);
    entry.reject(error);
  }

  private cleanupEntry(entry: QueueEntry): void {
    if (entry.state === "queued") {
      const index = this.queue.indexOf(entry);
      if (index >= 0) this.queue.splice(index, 1);
    }
    entry.state = "settled";
    if (entry.staleTimer !== null) clearTimeout(entry.staleTimer);
    if (entry.externalSignal !== undefined && entry.externalAbort !== undefined) {
      entry.externalSignal.removeEventListener("abort", entry.externalAbort);
    }
    this.entries.delete(entry.request.requestId);
  }

  private sortQueue(): void {
    this.queue.sort(
      (left, right) =>
        left.request.priority - right.request.priority ||
        left.sequence - right.sequence,
    );
  }

  private rejectedHandle<T>(requestId: string, error: AIError): AIScheduledHandle<T> {
    const promise = Promise.reject(error) as Promise<AIScheduledResult<T>>;
    return Object.freeze({ requestId, promise, cancel: () => false });
  }
}

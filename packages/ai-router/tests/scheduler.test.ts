import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AIRequestScheduler,
  AISchedulerError,
  aiRequestPriorities,
  type AIScheduledRequest,
} from '../src/scheduler.js';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function request<T>(
  requestId: string,
  botId: string,
  execute: AIScheduledRequest<T>['execute'],
  overrides: Partial<Omit<AIScheduledRequest<T>, 'requestId' | 'botId' | 'execute'>> = {},
): AIScheduledRequest<T> {
  return {
    requestId,
    botId,
    priority: aiRequestPriorities.planning,
    execute,
    ...overrides,
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('AIRequestScheduler', () => {
  it('dispatches queued requests by priority and preserves FIFO within a priority', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1 });
    const gate = deferred<string>();
    const order: string[] = [];
    const first = scheduler.schedule(request('first', 'bot-a', () => gate.promise));
    const low = scheduler.schedule(
      request('low', 'bot-b', async () => {
        order.push('low');
        return 'low';
      }, { priority: aiRequestPriorities.chat }),
    );
    const highOne = scheduler.schedule(
      request('high-1', 'bot-c', async () => {
        order.push('high-1');
        return 'high-1';
      }, { priority: aiRequestPriorities.combat }),
    );
    const highTwo = scheduler.schedule(
      request('high-2', 'bot-d', async () => {
        order.push('high-2');
        return 'high-2';
      }, { priority: aiRequestPriorities.combat }),
    );

    gate.resolve('first');
    await Promise.all([first, low, highOne, highTwo]);

    expect(order).toEqual(['high-1', 'high-2', 'low']);
  });

  it('enforces global and per-bot concurrency while exposing a consistent snapshot', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 2, perBotConcurrency: 1 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const started: string[] = [];
    const scheduled = [
      scheduler.schedule(request('a-1', 'bot-a', () => {
        started.push('a-1');
        return gates[0]!.promise;
      })),
      scheduler.schedule(request('a-2', 'bot-a', () => {
        started.push('a-2');
        return gates[1]!.promise;
      })),
      scheduler.schedule(request('b-1', 'bot-b', () => {
        started.push('b-1');
        return gates[2]!.promise;
      })),
    ];

    await flush();
    expect(started).toEqual(['a-1', 'b-1']);
    expect(scheduler.snapshot()).toMatchObject({
      accepting: true,
      queued: 1,
      running: 2,
      maxConcurrency: 2,
      perBotConcurrency: 1,
      bots: [
        { botId: 'bot-a', queued: 1, running: 1 },
        { botId: 'bot-b', queued: 0, running: 1 },
      ],
    });

    gates[0]!.resolve('a-1');
    await scheduled[0]!;
    await flush();
    expect(started).toEqual(['a-1', 'b-1', 'a-2']);
    gates[1]!.resolve('a-2');
    gates[2]!.resolve('b-1');
    await Promise.all(scheduled);
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0, bots: [] });
  });

  it.each([1, 3, 5, 10])(
    'drains planning work for %i Bots within the configured concurrency boundary',
    async (botCount) => {
      const scheduler = new AIRequestScheduler({
        maxConcurrency: 4,
        maxQueue: 64,
        perBotConcurrency: 1,
      });
      let active = 0;
      let maximumActive = 0;
      const scheduled = Array.from({ length: botCount }, (_, index) =>
        scheduler.schedule(request(
          `matrix-${botCount}-${index}`,
          `bot-${index}`,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            await Promise.resolve();
            active -= 1;
            return index;
          },
        )),
      );

      const results = await Promise.all(scheduled);

      expect(results).toHaveLength(botCount);
      expect(maximumActive).toBe(Math.min(4, botCount));
      expect(scheduler.snapshot()).toMatchObject({
        accepting: true,
        queued: 0,
        running: 0,
        bots: [],
      });
    },
  );

  it('rejects backpressure and duplicate request identifiers without replacing active work', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1, maxQueue: 1 });
    const gate = deferred<string>();
    const active = scheduler.schedule(request('active', 'bot-a', () => gate.promise));
    const queued = scheduler.schedule(request('queued', 'bot-b', async () => 'queued'));

    await expect(
      scheduler.schedule(request('overflow', 'bot-c', async () => 'overflow')),
    ).rejects.toMatchObject({ code: 'AI_QUEUE_FULL', requestId: 'overflow' });
    await expect(
      scheduler.schedule(request('active', 'bot-d', async () => 'duplicate')),
    ).rejects.toMatchObject({ code: 'AI_DUPLICATE_REQUEST_ID', requestId: 'active' });

    gate.resolve('active');
    await Promise.all([active, queued]);
  });

  it('cancels queued and running requests and propagates an AbortSignal to execution', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1 });
    let runningSignal: AbortSignal | undefined;
    const running = scheduler.schedule(
      request('running', 'bot-a', ({ signal }) => {
        runningSignal = signal;
        return new Promise<string>(() => undefined);
      }),
    );
    const queued = scheduler.schedule(request('queued', 'bot-b', async () => 'never'));
    const runningRejection = expect(running).rejects.toMatchObject({
      code: 'AI_REQUEST_CANCELLED',
    });
    const queuedRejection = expect(queued).rejects.toMatchObject({
      code: 'AI_REQUEST_CANCELLED',
    });

    expect(scheduler.cancel('queued', 'stale world state')).toBe(true);
    expect(scheduler.cancel('running', 'combat ended')).toBe(true);
    await Promise.all([runningRejection, queuedRejection]);
    expect(runningSignal?.aborted).toBe(true);
    expect(scheduler.cancel('running')).toBe(false);
  });

  it('cancels every request belonging to one bot without affecting other bots', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 2 });
    const gateA = deferred<string>();
    const gateB = deferred<string>();
    const botA = scheduler.schedule(request('bot-a-running', 'bot-a', () => gateA.promise));
    const botAQueued = scheduler.schedule(request('bot-a-queued', 'bot-a', async () => 'never'));
    const botB = scheduler.schedule(request('bot-b-running', 'bot-b', () => gateB.promise));
    const botARejected = Promise.all([
      expect(botA).rejects.toBeInstanceOf(AISchedulerError),
      expect(botAQueued).rejects.toBeInstanceOf(AISchedulerError),
    ]);

    expect(scheduler.cancelBot('bot-a')).toBe(2);
    gateB.resolve('bot-b');
    await botARejected;
    await expect(botB).resolves.toMatchObject({ value: 'bot-b' });
  });

  it('applies one total timeout across queueing, retries, and execution', async () => {
    vi.useFakeTimers();
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1, defaultTimeoutMs: 25 });
    const scheduled = scheduler.schedule(
      request('timeout', 'bot-a', async () => new Promise<string>(() => undefined)),
    );
    const rejection = expect(scheduled).rejects.toMatchObject({ code: 'AI_REQUEST_TIMEOUT' });

    await vi.advanceTimersByTimeAsync(26);
    await rejection;
    expect(scheduler.snapshot()).toMatchObject({ queued: 0, running: 0 });
  });

  it('supersedes stale work and admits a replacement for a queued request at capacity', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1, maxQueue: 1 });
    const gate = deferred<string>();
    const blocker = scheduler.schedule(request('blocker', 'bot-x', () => gate.promise));
    const stale = scheduler.schedule(
      request('stale', 'bot-a', async () => 'stale', { supersedeKey: 'world-state' }),
    );
    const staleRejection = expect(stale).rejects.toMatchObject({ code: 'AI_REQUEST_SUPERSEDED' });
    const replacement = scheduler.schedule(
      request('replacement', 'bot-a', async () => 'fresh', { supersedeKey: 'world-state' }),
    );

    await staleRejection;
    gate.resolve('blocker');
    await blocker;
    await expect(replacement).resolves.toMatchObject({ value: 'fresh' });
  });

  it('does not cancel running stale work when a full queue cannot admit its replacement', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1, maxQueue: 1 });
    const gate = deferred<string>();
    const running = scheduler.schedule(
      request('running', 'bot-a', () => gate.promise, { supersedeKey: 'world-state' }),
    );
    const queued = scheduler.schedule(request('queued', 'bot-b', async () => 'queued'));

    await expect(
      scheduler.schedule(
        request('replacement', 'bot-a', async () => 'fresh', { supersedeKey: 'world-state' }),
      ),
    ).rejects.toMatchObject({ code: 'AI_QUEUE_FULL' });
    expect(gate.promise).toBeDefined();
    gate.resolve('running');
    await expect(running).resolves.toMatchObject({ value: 'running' });
    await queued;
  });

  it('deduplicates equivalent active work and executes it once', async () => {
    const scheduler = new AIRequestScheduler();
    const execute = vi.fn(async () => 'shared');
    const first = scheduler.schedule(
      request('first', 'bot-a', execute, { deduplicationKey: 'shared-plan' }),
    );
    const duplicate = scheduler.schedule(
      request('duplicate', 'bot-b', execute, { deduplicationKey: 'shared-plan' }),
    );

    expect(duplicate).toBe(first);
    await expect(duplicate).resolves.toMatchObject({ requestId: 'first', value: 'shared' });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retries retryable failures with bounded exponential backoff', async () => {
    vi.useFakeTimers();
    const delays: number[] = [];
    const scheduler = new AIRequestScheduler({
      onEvent: (event) => {
        if (event.type === 'retrying') delays.push(event.delayMs ?? -1);
      },
    });
    const execute = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('temporary-1'))
      .mockRejectedValueOnce(new Error('temporary-2'))
      .mockResolvedValue('ok');
    const scheduled = scheduler.schedule(
      request('retry', 'bot-a', execute, {
        retry: {
          maxAttempts: 3,
          baseDelayMs: 10,
          maxDelayMs: 20,
          jitterRatio: 0,
          retryable: () => true,
        },
      }),
    );

    await vi.runAllTimersAsync();
    await expect(scheduled).resolves.toMatchObject({ value: 'ok', attempts: 3 });
    expect(delays).toEqual([10, 20]);
  });

  it('closes gracefully by rejecting queued, running, and future work', async () => {
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1 });
    const running = scheduler.schedule(
      request('running', 'bot-a', async () => new Promise<string>(() => undefined)),
    );
    const queued = scheduler.schedule(request('queued', 'bot-b', async () => 'never'));
    const rejections = Promise.all([
      expect(running).rejects.toMatchObject({ code: 'AI_SCHEDULER_CLOSED' }),
      expect(queued).rejects.toMatchObject({ code: 'AI_SCHEDULER_CLOSED' }),
    ]);

    scheduler.close('test shutdown');
    await rejections;
    await expect(
      scheduler.schedule(request('future', 'bot-c', async () => 'never')),
    ).rejects.toMatchObject({ code: 'AI_SCHEDULER_CLOSED' });
    expect(scheduler.snapshot()).toMatchObject({ accepting: false, queued: 0, running: 0 });
  });
});

describe("multi-bot fair scheduling (Round 6)", () => {
  it("same priority rotates across bots instead of letting one bot's FIFO flood starve others", async () => {
    const gate = new Map<string, () => void>();
    const order: string[] = [];
    const scheduler = new AIRequestScheduler({ maxConcurrency: 1, maxQueue: 32, perBotConcurrency: 1 });
    const releases: Array<Promise<void>> = [];
    // bot A 灌 4 个请求，bot B 只有 1 个 —— 全部同优先级
    for (let i = 0; i < 4; i += 1) {
      releases.push(scheduler.schedule({
        requestId: `a${i}`,
        botId: "bot-a",
        priority: 30,
        execute: async () => { order.push(`a${i}`); await new Promise<void>((resolve) => gate.set(`a${i}`, resolve)); },
      }).then(() => undefined, () => undefined));
    }
    const bDone = scheduler.schedule({
      requestId: "b0",
      botId: "bot-b",
      priority: 30,
      execute: async () => { order.push("b0"); },
    });
    // 第一个（a0）占住唯一并发位；等待队列稳定后放行
    const releaseWhenReady = async (id: string) => {
      while (!gate.get(id)) await new Promise((resolve) => setTimeout(resolve, 5));
      gate.get(id)!();
    };
    await releaseWhenReady("a0");
    await bDone; // bot-b 必须在 a1..a3 之前获得调度（最久未调度的 bot 优先）
    expect(order).toEqual(["a0", "b0"]);
    for (let i = 1; i < 4; i += 1) await releaseWhenReady(`a${i}`);
    await Promise.all(releases);
  });
});

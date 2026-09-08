import type { GenerateOptions, GenerateResult } from './types/adapter.js';
import { AIRouter } from './router.js';
import { AIError } from './errors.js';
import { AICircuitBreaker, type CircuitBreakerOptions, type CircuitBreakerSnapshot } from './circuit-breaker.js';
import {
  AIRequestScheduler,
  type AIRetryPolicy,
  type AIScheduledResult,
  type AIRequestPriority,
} from './scheduler.js';

export type ScheduledGenerateOptions = GenerateOptions &
  Readonly<{
    requestId: string;
    botId: string;
    priority: AIRequestPriority;
    deduplicationKey?: string;
    supersedeKey?: string;
    retry?: AIRetryPolicy;
  }>;

/**
 * Scheduler + Router + CircuitBreaker 的组合入口。
 * 熔断只作用于真实网络调用（execute 内）：open 状态快速失败，不带网络
 * 延迟；半开探测成功自动恢复 closed。scheduler 的排队/取消/超时语义不变。
 */
export class ScheduledAIRouter {
  readonly breaker: AICircuitBreaker;

  constructor(
    private readonly router: AIRouter,
    private readonly scheduler: AIRequestScheduler,
    breakerOptions: Partial<CircuitBreakerOptions> = {},
  ) {
    this.breaker = new AICircuitBreaker(breakerOptions);
  }

  generate(options: ScheduledGenerateOptions): Promise<AIScheduledResult<GenerateResult>> {
    const {
      requestId,
      botId,
      priority,
      deduplicationKey,
      supersedeKey,
      retry,
      signal,
      ...generateOptions
    } = options;

    return this.scheduler.schedule({
      requestId,
      botId,
      priority,
      timeoutMs: options.timeoutMs,
      ...(deduplicationKey ? { deduplicationKey } : {}),
      ...(supersedeKey ? { supersedeKey } : {}),
      ...(retry ? { retry } : {}),
      ...(signal ? { signal } : {}),
      execute: ({ signal: scheduledSignal }) => {
        // 排队等待不算熔断失败；只在真正要打网络前准入
        this.breaker.beforeCall();
        return this.router
          .generate({
            ...generateOptions,
            timeoutMs: options.timeoutMs,
            signal: scheduledSignal,
          })
          .then(
            (result) => {
              this.breaker.recordSuccess();
              return result;
            },
            (error: unknown) => {
              if (scheduledSignal.aborted || (error instanceof AIError && error.code === 'AI_CANCELLED')) this.breaker.recordCancellation();
              else this.breaker.recordFailure(error instanceof AIError ? error.code : 'AI_PROVIDER_FAILED');
              throw error;
            },
          );
      },
    });
  }

  /** Spark 连接健康快照（调度器 + 熔断器；Dashboard/日志用）。 */
  healthSnapshot(): Readonly<{
    scheduler: ReturnType<AIRequestScheduler["snapshot"]>;
    breaker: CircuitBreakerSnapshot;
  }> {
    return { scheduler: this.scheduler.snapshot(), breaker: this.breaker.snapshot() };
  }
}

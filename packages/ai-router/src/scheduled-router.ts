import type { GenerateOptions, GenerateResult } from './types/adapter.js';
import { AIRouter } from './router.js';
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

export class ScheduledAIRouter {
  constructor(
    private readonly router: AIRouter,
    private readonly scheduler: AIRequestScheduler,
  ) {}

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
      execute: ({ signal: scheduledSignal }) =>
        this.router.generate({
          ...generateOptions,
          timeoutMs: options.timeoutMs,
          signal: scheduledSignal,
        }),
    });
  }
}

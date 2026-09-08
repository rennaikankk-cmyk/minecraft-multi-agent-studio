import type { z } from 'zod';

export interface AIAdapter {
  readonly name: string;
  readonly type: 'local' | 'cloud';
  /** Providers with no health contract are attempted through generate directly. */
  readonly requiresHealthCheck?: boolean;
  
  health(): Promise<HealthResult>;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export interface HealthResult {
  available: boolean;
  status?: 'unverified' | 'available' | 'unavailable';
  latencyMs?: number;
  error?: string;
}

export interface GenerateOptions {
  prompt: string;
  systemPrompt?: string;
  maxTokens: number;
  temperature: number;
  schema?: z.ZodSchema;
  timeoutMs: number;
  traceId: string;
  signal?: AbortSignal;
}

export interface GenerateResult {
  content: string;
  finishReason?: string | null;
  /** Omitted when the provider does not report usage; never synthesized as zero. */
  usage?: {
    promptTokens: number;
    completionTokens: number;
  };
  validated?: unknown;
}

import type { z } from 'zod';

export interface AIAdapter {
  readonly name: string;
  readonly type: 'local' | 'cloud';
  
  health(): Promise<HealthResult>;
  generate(opts: GenerateOptions): Promise<GenerateResult>;
}

export interface HealthResult {
  available: boolean;
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
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  validated?: unknown;
}

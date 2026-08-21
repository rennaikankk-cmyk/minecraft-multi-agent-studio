import { z } from "zod";

import type {
  AIAdapter,
  GenerateOptions,
  GenerateResult,
  HealthResult,
} from "../types/adapter.js";

const ollamaModelsResponseSchema = z
  .object({
    models: z
      .array(
        z
          .object({
            name: z.string().min(1),
            model: z.string().min(1).optional(),
          })
          .loose(),
      )
      .min(1),
  })
  .loose();

const ollamaChatResponseSchema = z
  .object({
    message: z.object({ content: z.string().min(1) }).loose(),
    prompt_eval_count: z.number().int().nonnegative(),
    eval_count: z.number().int().nonnegative(),
  })
  .loose();

/**
 * Ollama's native API exposes `think: false`, which prevents reasoning-model
 * tokens from consuming the bounded planning budget before the JSON decision.
 */
export class OllamaAdapter implements AIAdapter {
  readonly name = "ollama";
  readonly type = "local" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
  ) {}

  async health(): Promise<HealthResult> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        return {
          available: false,
          latencyMs: Date.now() - start,
          error: `HTTP ${response.status}`,
        };
      }
      const models = ollamaModelsResponseSchema.parse(await response.json());
      const modelAvailable = models.models.some(
        ({ name, model }) => name === this.model || model === this.model,
      );
      return {
        available: modelAvailable,
        latencyMs: Date.now() - start,
        ...(modelAvailable ? {} : { error: `Model ${this.model} is not advertised.` }),
      };
    } catch (error) {
      return {
        available: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async generate(request: GenerateOptions): Promise<GenerateResult> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`Ollama request exceeded ${request.timeoutMs}ms.`)),
      request.timeoutMs,
    );
    const abortFromCaller = () => controller.abort(request.signal?.reason);
    if (request.signal?.aborted) abortFromCaller();
    else request.signal?.addEventListener("abort", abortFromCaller, { once: true });

    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          think: false,
          messages: [
            ...(request.systemPrompt
              ? [{ role: "system", content: request.systemPrompt }]
              : []),
            { role: "user", content: request.prompt },
          ],
          options: {
            temperature: request.temperature,
            num_predict: request.maxTokens,
          },
          ...(request.schema ? { format: z.toJSONSchema(request.schema) } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Ollama error: ${response.status} ${response.statusText}`);
      }

      const data = ollamaChatResponseSchema.parse(await response.json());
      return {
        content: data.message.content,
        usage: {
          promptTokens: data.prompt_eval_count,
          completionTokens: data.eval_count,
        },
      };
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

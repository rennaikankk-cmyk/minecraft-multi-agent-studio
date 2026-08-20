export type AIErrorCode =
  | "AI_CANCELLED"
  | "AI_CONFIG_INVALID"
  | "AI_NO_PROVIDER"
  | "AI_OUTPUT_INVALID"
  | "AI_PROVIDER_UNAVAILABLE"
  | "AI_PROVIDER_FAILED"
  | "AI_QUEUE_CLOSED"
  | "AI_QUEUE_FULL"
  | "AI_REQUEST_INVALID"
  | "AI_REQUEST_STALE"
  | "AI_REQUEST_TIMEOUT"
  | "AI_STALE_RESPONSE";

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly retryable: boolean;
  readonly provider?: string;

  constructor(
    code: AIErrorCode,
    message: string,
    options: Readonly<{
      retryable?: boolean;
      provider?: string;
      cause?: unknown;
    }> = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AIError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.provider !== undefined) this.provider = options.provider;
  }
}

export function asAIError(error: unknown, provider?: string): AIError {
  if (error instanceof AIError) return error;
  if (error instanceof DOMException && error.name === "AbortError") {
    return new AIError("AI_CANCELLED", "AI request was cancelled.", {
      ...(provider === undefined ? {} : { provider }),
      cause: error,
    });
  }
  return new AIError("AI_PROVIDER_FAILED", "AI provider request failed.", {
    retryable: true,
    ...(provider === undefined ? {} : { provider }),
    cause: error,
  });
}

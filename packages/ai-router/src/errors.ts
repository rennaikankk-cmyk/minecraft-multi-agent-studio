/**
 * Provider-layer AI error taxonomy.
 *
 * Scope boundary: `AISchedulerError` in `scheduler.ts` owns queueing, request
 * identity, supersession and scheduler-level cancellation. This module owns
 * only what happens once a request reaches a provider — transport failure,
 * provider abort, and structured-output contract violations. Codes are
 * deliberately disjoint from `AISchedulerErrorCode` so a caller never has to
 * guess which layer produced a given string, and so the two taxonomies cannot
 * drift into competing definitions of the same condition.
 */
export type AIErrorCode =
  | "AI_CANCELLED"
  | "AI_CONFIG_INVALID"
  | "AI_NO_PROVIDER"
  | "AI_OUTPUT_INVALID"
  | "AI_PROVIDER_FAILED"
  | "AI_PROVIDER_TIMEOUT"
  | "AI_PROVIDER_UNAVAILABLE";

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
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "AIError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    if (options.provider !== undefined) this.provider = options.provider;
  }
}

/**
 * Normalises an unknown throw into an `AIError`. Abort is classified as
 * non-retryable: a cancelled request was cancelled deliberately, and retrying
 * it would defeat the caller's own timeout or abort decision. Everything else
 * unrecognised is treated as a retryable transport failure.
 */
export function asAIError(error: unknown, provider?: string): AIError {
  if (error instanceof AIError) return error;
  if (isAbortError(error)) {
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

/**
 * `DOMException` alone is not sufficient: `AbortController.abort(reason)` with a
 * custom reason surfaces that reason verbatim, and the adapters in this package
 * abort with a plain `Error` on their own timeout path.
 */
function isAbortError(error: unknown): boolean {
  if (typeof DOMException !== "undefined" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return error instanceof Error && error.name === "AbortError";
}

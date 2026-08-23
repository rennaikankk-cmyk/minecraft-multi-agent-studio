import { describe, expect, it } from "vitest";

import { AIError, asAIError } from "../src/errors.js";

describe("AIError", () => {
  it("defaults to non-retryable", () => {
    expect(new AIError("AI_CONFIG_INVALID", "bad config").retryable).toBe(false);
  });

  it("preserves code, provider and cause", () => {
    const cause = new Error("socket hang up");
    const error = new AIError("AI_PROVIDER_FAILED", "failed", {
      retryable: true,
      provider: "ollama",
      cause,
    });
    expect(error.code).toBe("AI_PROVIDER_FAILED");
    expect(error.provider).toBe("ollama");
    expect(error.retryable).toBe(true);
    expect(error.cause).toBe(cause);
    expect(error.name).toBe("AIError");
  });

  it("leaves provider undefined when not supplied", () => {
    expect(new AIError("AI_NO_PROVIDER", "none").provider).toBeUndefined();
  });
});

describe("asAIError", () => {
  it("passes an AIError through unchanged", () => {
    const original = new AIError("AI_OUTPUT_INVALID", "invalid");
    expect(asAIError(original, "ollama")).toBe(original);
  });

  it("classifies a DOMException abort as non-retryable cancellation", () => {
    const error = asAIError(
      new DOMException("aborted", "AbortError"),
      "ollama",
    );
    expect(error.code).toBe("AI_CANCELLED");
    expect(error.retryable).toBe(false);
    expect(error.provider).toBe("ollama");
  });

  it("classifies a plain AbortError as cancellation", () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    expect(asAIError(abort).code).toBe("AI_CANCELLED");
  });

  it("treats an unrecognised failure as a retryable provider failure", () => {
    const error = asAIError(new Error("ECONNRESET"), "ollama");
    expect(error.code).toBe("AI_PROVIDER_FAILED");
    expect(error.retryable).toBe(true);
  });

  it("wraps non-Error throws", () => {
    const error = asAIError("string failure");
    expect(error.code).toBe("AI_PROVIDER_FAILED");
    expect(error.cause).toBe("string failure");
  });
});

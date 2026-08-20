import { AIError } from "./errors.js";
import type { AISchedulerConfig } from "./scheduler.js";

function integerFromEnv(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback?: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") {
    if (fallback !== undefined) return fallback;
    throw new AIError("AI_CONFIG_INVALID", `${name} must be configured.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new AIError("AI_CONFIG_INVALID", `${name} must be an integer.`);
  }
  return value;
}

export function loadAISchedulerConfig(
  env: NodeJS.ProcessEnv = process.env,
): AISchedulerConfig {
  return Object.freeze({
    // Deliberately required: benchmark selects this for each inference node.
    maxConcurrency: integerFromEnv(env, "AI_MAX_CONCURRENCY"),
    maxQueue: integerFromEnv(env, "AI_MAX_QUEUE", 64),
    perBotConcurrency: integerFromEnv(env, "AI_PER_BOT_CONCURRENCY", 1),
    staleAfterMs: integerFromEnv(env, "AI_STALE_AFTER_MS", 30_000),
    maxRetries: integerFromEnv(env, "AI_MAX_RETRIES", 1),
    retryBaseDelayMs: integerFromEnv(env, "AI_RETRY_BASE_DELAY_MS", 250),
    retryMaxDelayMs: integerFromEnv(env, "AI_RETRY_MAX_DELAY_MS", 2_000),
  });
}

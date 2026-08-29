export type AutonomousConfig = Readonly<{
  enabled: boolean;
  intervalMs: number;
  goalTimeoutMs: number;
  failureCooldownMs: number;
  terminalRetentionMs: number;
}>;

export type AutonomousConfigErrorCode = "AUTONOMY_CONFIG_INVALID";

export class AutonomousConfigError extends Error {
  constructor(readonly code: AutonomousConfigErrorCode, message: string) {
    super(message);
    this.name = "AutonomousConfigError";
  }
}

const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_GOAL_TIMEOUT_MS = 120_000;
const DEFAULT_FAILURE_COOLDOWN_MS = 30_000;
const DEFAULT_TERMINAL_RETENTION_MS = 15_000;

export function loadAutonomousConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): AutonomousConfig {
  return {
    enabled: booleanFlag(env.STUDIO_AUTONOMY_ENABLED, true),
    intervalMs: boundedInteger(
      env.STUDIO_AUTONOMY_INTERVAL_MS,
      DEFAULT_INTERVAL_MS,
      1_000,
      600_000,
      "STUDIO_AUTONOMY_INTERVAL_MS",
    ),
    goalTimeoutMs: boundedInteger(
      env.STUDIO_AUTONOMY_GOAL_TIMEOUT_MS,
      DEFAULT_GOAL_TIMEOUT_MS,
      1_000,
      120_000,
      "STUDIO_AUTONOMY_GOAL_TIMEOUT_MS",
    ),
    failureCooldownMs: boundedInteger(
      env.STUDIO_AUTONOMY_FAILURE_COOLDOWN_MS,
      DEFAULT_FAILURE_COOLDOWN_MS,
      1_000,
      600_000,
      "STUDIO_AUTONOMY_FAILURE_COOLDOWN_MS",
    ),
    terminalRetentionMs: boundedInteger(
      env.STUDIO_AUTONOMY_TERMINAL_RETENTION_MS,
      DEFAULT_TERMINAL_RETENTION_MS,
      1_000,
      300_000,
      "STUDIO_AUTONOMY_TERMINAL_RETENTION_MS",
    ),
  };
}

function booleanFlag(
  raw: string | undefined,
  fallback: boolean,
): boolean {
  const value = raw?.trim();
  if (!value) return fallback;
  if (value === "1") return true;
  if (value === "0") return false;
  throw new AutonomousConfigError(
    "AUTONOMY_CONFIG_INVALID",
    "STUDIO_AUTONOMY_ENABLED must be 0 or 1.",
  );
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new AutonomousConfigError(
      "AUTONOMY_CONFIG_INVALID",
      `${name} must be between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

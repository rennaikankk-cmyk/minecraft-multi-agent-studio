import { describe, expect, it } from "vitest";

import {
  AutonomousConfigError,
  loadAutonomousConfig,
} from "../src/autonomous-config.js";

describe("loadAutonomousConfig", () => {
  it("enables the local autonomous director with bounded defaults", () => {
    expect(loadAutonomousConfig({})).toEqual({
      enabled: true,
      intervalMs: 15_000,
      goalTimeoutMs: 120_000,
      failureCooldownMs: 30_000,
      terminalRetentionMs: 15_000,
    });
  });

  it("loads explicit desktop autonomy limits", () => {
    expect(
      loadAutonomousConfig({
        STUDIO_AUTONOMY_ENABLED: "0",
        STUDIO_AUTONOMY_INTERVAL_MS: "5000",
        STUDIO_AUTONOMY_GOAL_TIMEOUT_MS: "60000",
        STUDIO_AUTONOMY_FAILURE_COOLDOWN_MS: "10000",
        STUDIO_AUTONOMY_TERMINAL_RETENTION_MS: "3000",
      }),
    ).toEqual({
      enabled: false,
      intervalMs: 5_000,
      goalTimeoutMs: 60_000,
      failureCooldownMs: 10_000,
      terminalRetentionMs: 3_000,
    });
  });

  it.each([
    // Round 6.6 配置 SSOT：true/false 是 1/0 的等价词形（合法），
    // 只有真正的 garbage（如 "enabled"/"nope"）才 fail-closed。
    { STUDIO_AUTONOMY_ENABLED: "enabled" },
    { STUDIO_AUTONOMY_ENABLED: "nope" },
    { STUDIO_AUTONOMY_INTERVAL_MS: "999" },
    { STUDIO_AUTONOMY_GOAL_TIMEOUT_MS: "120001" },
    { STUDIO_AUTONOMY_FAILURE_COOLDOWN_MS: "not-a-number" },
  ])("rejects an invalid autonomy setting", (env) => {
    expect(() => loadAutonomousConfig(env)).toThrow(AutonomousConfigError);
  });

  it.each([
    { STUDIO_AUTONOMY_ENABLED: "true" },
    { STUDIO_AUTONOMY_ENABLED: "FALSE" },
    { STUDIO_AUTONOMY_ENABLED: "0" },
    { STUDIO_AUTONOMY_ENABLED: "1" },
  ])("accepts standard boolean spellings (config SSOT)", (env) => {
    expect(() => loadAutonomousConfig(env)).not.toThrow();
  });
});

import { describe, expect, it } from "vitest";

import {
  resolveStudioStartupPlan,
  studioDeploymentModeSchema,
  studioStartupModeSchema,
} from "../src/studio-startup.js";

describe("startup mode schema", () => {
  it("accepts exactly the three new values", () => {
    expect(studioStartupModeSchema.parse("normal")).toBe("normal");
    expect(studioStartupModeSchema.parse("local_test")).toBe("local_test");
    expect(studioStartupModeSchema.parse("e2e")).toBe("e2e");
    expect(studioStartupModeSchema.safeParse("standard").success).toBe(false);
    expect(studioStartupModeSchema.safeParse("docker").success).toBe(false);
  });

  it("deployment mode accepts the four legacy values under the new variable", () => {
    for (const value of ["standard", "docker", "portable", "netcafe"]) {
      expect(studioDeploymentModeSchema.parse(value)).toBe(value);
    }
    expect(studioDeploymentModeSchema.safeParse("local_test").success).toBe(false);
  });
});

describe("resolveStudioStartupPlan precedence", () => {
  it("default is NORMAL: local MC server NOT started", () => {
    const plan = resolveStudioStartupPlan({ env: {} });
    expect(plan.startupMode).toBe("normal");
    expect(plan.resolvedFrom).toBe("default");
    expect(plan.localMinecraftServer.desired).toBe("not_started");
    expect(plan.localMinecraftServer.startReason).toBe("none");
    expect(plan.deploymentMode).toBe("standard");
  });

  it("CLI explicit mode wins over env", () => {
    const plan = resolveStudioStartupPlan({ cliMode: "e2e", env: { STUDIO_MODE: "normal" } });
    expect(plan.startupMode).toBe("e2e");
    expect(plan.resolvedFrom).toBe("cli");
    expect(plan.localMinecraftServer.desired).toBe("ephemeral");
    expect(plan.localMinecraftServer.shutdownPolicy).toBe("cleanup_after_run");
  });

  it("invalid CLI mode throws (no silent fallback)", () => {
    expect(() => resolveStudioStartupPlan({ cliMode: "everything" })).toThrow(/--mode/);
  });

  it("new STUDIO_MODE=local_test starts session-owned local server", () => {
    const plan = resolveStudioStartupPlan({ env: { STUDIO_MODE: "local_test" } });
    expect(plan.startupMode).toBe("local_test");
    expect(plan.resolvedFrom).toBe("studio_mode_env");
    expect(plan.localMinecraftServer.desired).toBe("session");
    expect(plan.localMinecraftServer.shutdownPolicy).toBe("stop_on_studio_stop");
    expect(plan.localMinecraftServer.startReason).toBe("local_test_mode");
  });

  it("legacy STUDIO_MODE=docker maps to deployment mode with deprecation warning, startup stays NORMAL", () => {
    const plan = resolveStudioStartupPlan({ env: { STUDIO_MODE: "docker" } });
    expect(plan.startupMode).toBe("normal");
    expect(plan.deploymentMode).toBe("docker");
    expect(plan.resolvedFrom).toBe("legacy_compat");
    expect(plan.localMinecraftServer.desired).toBe("not_started");
    expect(plan.warnings.some((warning) => warning.includes("legacy deployment-mode value"))).toBe(true);
  });

  it("explicit STUDIO_DEPLOYMENT_MODE wins over legacy STUDIO_MODE conflict", () => {
    const plan = resolveStudioStartupPlan({
      env: { STUDIO_MODE: "portable", STUDIO_DEPLOYMENT_MODE: "netcafe" },
    });
    expect(plan.deploymentMode).toBe("netcafe");
    expect(plan.startupMode).toBe("normal");
    expect(plan.warnings.some((warning) => warning.includes("conflicts"))).toBe(true);
  });

  it("new STUDIO_MODE value coexists with deployment mode", () => {
    const plan = resolveStudioStartupPlan({
      env: { STUDIO_MODE: "local_test", STUDIO_DEPLOYMENT_MODE: "portable" },
    });
    expect(plan.startupMode).toBe("local_test");
    expect(plan.deploymentMode).toBe("portable");
  });

  it("garbage STUDIO_MODE throws instead of guessing", () => {
    expect(() => resolveStudioStartupPlan({ env: { STUDIO_MODE: "yolo" } })).toThrow(/STUDIO_MODE/);
  });

  it("control-plane components are on in every mode", () => {
    for (const mode of ["normal", "local_test", "e2e"] as const) {
      const plan = resolveStudioStartupPlan({ cliMode: mode });
      expect(plan.components).toEqual({
        dashboard: true, coordinator: true, sharedState: true, persistence: true, botManager: true,
      });
    }
  });
});

import { describe, expect, it } from "vitest";

import {
  ANARCHY_FIRST_DEFAULT_POLICY,
  GameplayPolicyError,
  isStudioGameplayProfile,
  resolveGameplayPolicy,
  STANDARD_DEFAULT_POLICY,
  STUDIO_GAMEPLAY_PROFILES,
} from "../src/gameplay-policy.js";

// ---------------------------------------------------------------------------
// Round 8 —— Gameplay Policy SSOT 契约测试（Anarchy-First 产品定位迁移）
// ---------------------------------------------------------------------------

describe("resolveGameplayPolicy — defaults", () => {
  it("project default is anarchy_first with hostile unknowns and proactive combat", () => {
    const policy = resolveGameplayPolicy({ environment: {} });
    expect(policy).toEqual(ANARCHY_FIRST_DEFAULT_POLICY);
    expect(policy.profile).toBe("anarchy_first");
    expect(policy.unknownPlayerDisposition).toBe("hostile");
    expect(policy.proactiveCombat).toBe(true);
    expect(policy.propertyInteraction).toBe("unrestricted");
    expect(policy.resourceAcquisition).toBe("unrestricted");
    expect(policy.highIntensityCapabilities).toBe(true);
    expect(policy.source).toBe("project-default");
  });

  it("operator env selects the standard comparison profile", () => {
    const policy = resolveGameplayPolicy({
      environment: { STUDIO_GAMEPLAY_PROFILE: "standard" },
    });
    expect(policy.profile).toBe("standard");
    expect(policy.unknownPlayerDisposition).toBe("neutral");
    expect(policy.proactiveCombat).toBe(false);
    expect(policy.source).toBe("operator-env");
  });
});

describe("resolveGameplayPolicy — fail-closed", () => {
  it("a garbage env value refuses to start instead of silently falling back", () => {
    expect(() =>
      resolveGameplayPolicy({ environment: { STUDIO_GAMEPLAY_PROFILE: "pacifist" } }),
    ).toThrowError(GameplayPolicyError);
  });

  it("custom without a complete server-profile override is a config error", () => {
    expect(() =>
      resolveGameplayPolicy({
        environment: { STUDIO_GAMEPLAY_PROFILE: "custom" },
        serverProfileOverride: null,
      }),
    ).toThrowError(/custom gameplay profile requires/iu);
  });

  it("an invalid server-profile override profile string is rejected", () => {
    expect(() =>
      resolveGameplayPolicy({
        environment: {},
        serverProfileOverride: { profile: "yolo" as never },
      }),
    ).toThrowError(GameplayPolicyError);
  });
});

describe("resolveGameplayPolicy — priority chain", () => {
  it("server-profile override beats operator env and the project default", () => {
    const policy = resolveGameplayPolicy({
      environment: { STUDIO_GAMEPLAY_PROFILE: "standard" },
      serverProfileOverride: {
        profile: "anarchy_first",
        unknownPlayerDisposition: "hostile",
        revision: "luv_mc6_22936_anarchy",
      },
    });
    expect(policy.profile).toBe("anarchy_first");
    expect(policy.source).toBe("server-profile");
    expect(policy.revision).toBe("luv_mc6_22936_anarchy");
    // 未覆盖字段继承 anarchy 基线
    expect(policy.proactiveCombat).toBe(true);
  });

  it("a standard-profile server override can tighten even under anarchy env", () => {
    const policy = resolveGameplayPolicy({
      environment: { STUDIO_GAMEPLAY_PROFILE: "anarchy_first" },
      serverProfileOverride: { profile: "standard" },
    });
    expect(policy.profile).toBe("standard");
    expect(policy.unknownPlayerDisposition).toBe("neutral");
    expect(policy.source).toBe("server-profile");
  });

  it("custom override with the full field set resolves", () => {
    const policy = resolveGameplayPolicy({
      environment: {},
      serverProfileOverride: {
        profile: "custom",
        unknownPlayerDisposition: "avoid",
        proactiveCombat: false,
        propertyInteraction: "owned_only",
        resourceAcquisition: "unclaimed_only",
        highIntensityCapabilities: false,
        antiCheatAdaptation: "conservative",
        multiBotMode: "solo_first",
        revision: "lab-v1",
      },
    });
    expect(policy.profile).toBe("custom");
    expect(policy.unknownPlayerDisposition).toBe("avoid");
  });
});

describe("profile vocabulary", () => {
  it("exports the three profiles with anarchy_first first", () => {
    expect([...STUDIO_GAMEPLAY_PROFILES]).toEqual(["anarchy_first", "standard", "custom"]);
  });

  it("narrows the profile type guard", () => {
    expect(isStudioGameplayProfile("anarchy_first")).toBe(true);
    expect(isStudioGameplayProfile("peaceful")).toBe(false);
  });

  it("standard default stays a coherent comparison baseline", () => {
    expect(STANDARD_DEFAULT_POLICY.profile).toBe("standard");
    expect(STANDARD_DEFAULT_POLICY.propertyInteraction).toBe("owned_only");
  });
});

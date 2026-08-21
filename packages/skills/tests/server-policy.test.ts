import { describe, expect, it } from "vitest";

import {
  baselineLimits,
  baselineServerPolicy,
  intersectLimits,
  isAtLeastAsConservative,
  profileIsAtLeastAsConservative,
  serverPolicySchema,
  ServerPolicyStore,
  VANILLA_BLOCK_INTERACTION_REACH,
  VANILLA_ENTITY_ATTACK_REACH,
} from "../src/index.js";

describe("ServerPolicy baselines", () => {
  it("never exceeds vanilla interaction mechanics in any baseline profile", () => {
    for (const profile of ["STRICT", "VANILLA_COMPATIBLE", "NORMAL"] as const) {
      const limits = baselineLimits(profile);
      expect(limits.blockInteractionReach).toBeLessThanOrEqual(
        VANILLA_BLOCK_INTERACTION_REACH,
      );
      expect(limits.entityAttackReach).toBeLessThanOrEqual(
        VANILLA_ENTITY_ATTACK_REACH,
      );
    }
  });

  it("orders STRICT as the most conservative baseline", () => {
    const strict = baselineLimits("STRICT");
    for (const profile of ["VANILLA_COMPATIBLE", "NORMAL"] as const) {
      expect(isAtLeastAsConservative(strict, baselineLimits(profile))).toBe(
        true,
      );
      expect(isAtLeastAsConservative(baselineLimits(profile), strict)).toBe(
        false,
      );
    }
    expect(profileIsAtLeastAsConservative("STRICT", "NORMAL")).toBe(true);
    expect(profileIsAtLeastAsConservative("NORMAL", "STRICT")).toBe(false);
  });

  it("refuses to treat a hand-written policy as verified", () => {
    const handWritten = {
      schemaVersion: "1.0",
      serverProfileId: "local-isolated-test",
      profile: "CUSTOM_VERIFIED",
      limits: baselineLimits("NORMAL"),
      origin: "baseline",
      evidenceIds: [],
    };
    expect(serverPolicySchema.safeParse(handWritten).success).toBe(false);

    const probedWithoutEvidence = { ...handWritten, origin: "probed" };
    expect(serverPolicySchema.safeParse(probedWithoutEvidence).success).toBe(
      false,
    );

    const baselineClaimingEvidence = {
      ...handWritten,
      profile: "NORMAL",
      evidenceIds: ["probe-1"],
    };
    expect(serverPolicySchema.safeParse(baselineClaimingEvidence).success).toBe(
      false,
    );
  });

  it("marks baseline policies as unverified rather than probed", () => {
    const policy = baselineServerPolicy("local-isolated-test");
    expect(policy).toMatchObject({
      profile: "STRICT",
      origin: "baseline",
      evidenceIds: [],
    });
  });

  it("intersects limits field-by-field toward the conservative side", () => {
    const merged = intersectLimits(
      baselineLimits("NORMAL"),
      baselineLimits("STRICT"),
    );
    expect(merged).toEqual(baselineLimits("STRICT"));
    expect(merged.minActionIntervalMs).toBe(
      baselineLimits("STRICT").minActionIntervalMs,
    );
  });
});

describe("ServerPolicyStore isolation", () => {
  const probed = (serverProfileId: string) =>
    serverPolicySchema.parse({
      schemaVersion: "1.0",
      serverProfileId,
      profile: "CUSTOM_VERIFIED",
      limits: baselineLimits("STRICT"),
      origin: "probed",
      evidenceIds: ["probe-1"],
    });

  it("defaults unknown servers to the most conservative profile", () => {
    const store = new ServerPolicyStore();
    expect(store.resolve("never-probed")).toMatchObject({
      profile: "STRICT",
      origin: "baseline",
    });
    expect(store.hasVerifiedPolicy("never-probed")).toBe(false);
    expect(store.knownServerProfileIds()).toEqual([]);
  });

  it("never leaks one server's verified bounds into another server", () => {
    const store = new ServerPolicyStore();
    expect(store.upsert(probed("server-a")).accepted).toBe(true);

    expect(store.hasVerifiedPolicy("server-a")).toBe(true);
    expect(store.hasVerifiedPolicy("server-b")).toBe(false);
    expect(store.resolve("server-b")).toMatchObject({
      serverProfileId: "server-b",
      profile: "STRICT",
      origin: "baseline",
    });
    expect(store.knownServerProfileIds()).toEqual(["server-a"]);
  });

  it("rejects writes that would relax an existing verified boundary", () => {
    const store = new ServerPolicyStore();
    store.upsert(probed("server-a"));

    const relaxed = serverPolicySchema.parse({
      schemaVersion: "1.0",
      serverProfileId: "server-a",
      profile: "CUSTOM_VERIFIED",
      limits: baselineLimits("NORMAL"),
      origin: "probed",
      evidenceIds: ["probe-2"],
    });
    expect(store.upsert(relaxed)).toMatchObject({
      accepted: false,
      errorCode: "SERVER_POLICY_WOULD_RELAX",
    });
    expect(store.resolve("server-a").limits).toEqual(baselineLimits("STRICT"));
  });

  it("allows relaxing only through an explicit reset", () => {
    const store = new ServerPolicyStore();
    store.upsert(probed("server-a"));
    const relaxed = serverPolicySchema.parse({
      schemaVersion: "1.0",
      serverProfileId: "server-a",
      profile: "CUSTOM_VERIFIED",
      limits: baselineLimits("NORMAL"),
      origin: "probed",
      evidenceIds: ["probe-2"],
    });

    expect(store.reset("server-a", relaxed).accepted).toBe(true);
    expect(store.resolve("server-a").limits).toEqual(baselineLimits("NORMAL"));

    expect(store.reset("server-a").accepted).toBe(true);
    expect(store.resolve("server-a")).toMatchObject({
      profile: "STRICT",
      origin: "baseline",
    });
  });

  it("rejects malformed policies and mismatched reset targets", () => {
    const store = new ServerPolicyStore();
    expect(store.upsert({ schemaVersion: "1.0" })).toMatchObject({
      accepted: false,
      errorCode: "SERVER_POLICY_INVALID",
    });
    expect(store.reset("server-a", probed("server-b"))).toMatchObject({
      accepted: false,
      errorCode: "SERVER_POLICY_INVALID",
    });
  });

  it("returns frozen copies so callers cannot mutate stored bounds", () => {
    const store = new ServerPolicyStore();
    store.upsert(probed("server-a"));
    const resolved = store.resolve("server-a");
    expect(() => {
      (resolved.limits as { entityAttackReach: number }).entityAttackReach = 6;
    }).toThrow();
    expect(store.resolve("server-a").limits.entityAttackReach).toBe(
      baselineLimits("STRICT").entityAttackReach,
    );
  });
});

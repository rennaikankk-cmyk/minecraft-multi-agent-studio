import { describe, expect, it, vi } from "vitest";
import { DEFAULT_UNVERIFIED_SITE_POLICY, assessSite, shelterDigSkill, siteAssessSkill, sitePolicySchema } from "../src/planning/site-assessor.js";

const serverProfileId = "isolated-local";
const dimension = "minecraft:overworld";
const candidate = { x: 12_345, y: 40, z: 15_678, dimension, serverProfileId };
const policy = { ...DEFAULT_UNVERIFIED_SITE_POLICY };
const safeFacts = { complete: true, spawnDistance: 20_000, nearestHighwayDistance: 3_000, nearestPortalLineDistance: 900, nearestHazardDistance: 200, resources: { wood: 1, stone: 1, water: 1, animals: 1 }, burialDepth: 30, escapeRouteCount: 3, playerTraffic01: 0.05 };

describe("N2 site assessment", () => {
  it("rejects incomplete observations before scoring", () => {
    const result = assessSite({ candidate, worldFacts: { ...safeFacts, complete: false, spawnDistance: null }, ownRecords: [], policy });
    expect(result).toMatchObject({ verdict: "REJECT", score01: 0, exposureFactors: [] });
    expect(result.hardRuleFailures).toContain("WORLD_FACTS_INCOMPLETE");
  });
  it("enforces hard rules before scoring", () => {
    const exposed = { ...candidate, x: 1_000, z: 1_000 };
    const result = assessSite({ candidate: exposed, worldFacts: { ...safeFacts, spawnDistance: 1_500, nearestHighwayDistance: 10, nearestPortalLineDistance: 10, nearestHazardDistance: 2 }, ownRecords: [{ ...exposed, kind: "OWN_HIDEOUT" }], policy });
    expect(result.verdict).toBe("REJECT");
    expect(result.exposureFactors).toEqual([]);
    expect(result.hardRuleFailures).toEqual(expect.arrayContaining(["SPAWN_EXCLUSION", "AXIS_EXCLUSION", "HIGHWAY_EXCLUSION", "OVERWORLD_PORTAL_LINE", "CONSPICUOUS_GRID_COORDINATE", "SYMMETRIC_COORDINATE", "KNOWN_HAZARD_NEARBY", "OWN_HIDEOUT_TOO_CLOSE"]));
  });
  it("keeps another server's hideout out of the rule set", () => {
    const result = assessSite({ candidate, worldFacts: safeFacts, ownRecords: [{ ...candidate, serverProfileId: "other-server", kind: "OWN_HIDEOUT" }], policy });
    expect(result.verdict).toBe("ACCEPT");
    expect(result.hardRuleFailures).toEqual([]);
  });
  it("scores burialDepth as an upward-cover block ratio capped at the target", () => {
    const value = (burialDepth: number) => assessSite({ candidate, worldFacts: { ...safeFacts, burialDepth }, ownRecords: [], policy })
      .exposureFactors.find(({ factor }) => factor === "burial")?.value01;

    expect(DEFAULT_UNVERIFIED_SITE_POLICY.burialDepthTarget).toBe(24);
    expect(sitePolicySchema.safeParse({ ...policy, burialDepthTarget: 0 }).success).toBe(false);
    expect(value(0)).toBe(0);
    expect(value(24)).toBe(1);
    expect(value(30)).toBe(1);
  });
  it("emits an N0-scoped SAFE_SITE memory record", async () => {
    const callCapability = vi.fn(async () => safeFacts);
    const output = await siteAssessSkill.execute({ invocationId: "inv", traceId: "trace", taskId: "task", botId: "bot", signal: new AbortController().signal, deadlineMs: Date.now() + 10_000, compatibility: { minecraftVersion: null, protocolVersion: null, variantId: "portable", verification: "unverified" }, callCapability }, { ownRecords: [], policy, observedAt: "2026-08-23T00:00:00.000Z", staleAfterMs: 60_000, candidate }, { online: true, normalActionsAllowed: true, serverProfileId, position: candidate });
    expect(callCapability).toHaveBeenCalledWith("world.read", "site.observe-safe", { candidate, policy });
    expect(output.memoryRecord).toMatchObject({ serverProfileId, dimension, kind: "SAFE_SITE" });
  });
});

describe("shelter.dig", () => {
  it("hard rejects straight down", () => {
    expect(shelterDigSkill.preconditions.at(-1)?.failureCode).toBe("POLICY_STRAIGHT_DOWN_FORBIDDEN");
    expect(shelterDigSkill.preconditions.at(-1)?.check({ direction: "down", depth: 2, sealItemName: "cobblestone", dimension, serverProfileId }, { online: true, normalActionsAllowed: true, serverProfileId, position: candidate }, {} as never)).toBe(false);
  });
  it("uses one bounded runtime operation", async () => {
    const expected = { dugBlocks: 4, movedInside: true, sealed: true, shelterPosition: { ...candidate, x: candidate.x + 2 } };
    const callCapability = vi.fn(async () => expected);
    const input = { direction: "east" as const, depth: 2, sealItemName: "cobblestone", dimension, serverProfileId };
    const output = await shelterDigSkill.execute({ invocationId: "inv", traceId: "trace", taskId: "task", botId: "bot", signal: new AbortController().signal, deadlineMs: Date.now() + 30_000, compatibility: { minecraftVersion: null, protocolVersion: null, variantId: "portable", verification: "unverified" }, callCapability }, input, { online: true, normalActionsAllowed: true, serverProfileId, position: candidate });
    expect(output).toEqual(expected);
    expect(callCapability).toHaveBeenCalledWith("world.interact", "shelter.dig-safe", input);
  });
});

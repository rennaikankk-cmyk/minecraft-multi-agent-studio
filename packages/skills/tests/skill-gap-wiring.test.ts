import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { FileSkillGapStore } from "../src/skill-gap-persistence.js";
import { suggestComposition } from "../src/skill-gap-composition.js";
import { classifyGap, gapFingerprint, SkillGapStore } from "../src/skill-gap.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skill-gap-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const PROJECT = { gitCommit: "abc1234", branch: "main", buildVersion: "test", dirty: false };

function gapInput(overrides: Record<string, unknown> = {}) {
  return {
    fingerprint: gapFingerprint({
      kind: "blueprint_missing",
      actionFamily: "build",
      terminalFailureCode: "BUILD_MATERIAL_MISSING",
    }),
    kind: "blueprint_missing",
    severity: "warning",
    project: PROJECT,
    runtime: { botId: "bot-01", serverProfileId: "profile-a" },
    goal: { goalText: "build a wall", requestedOutcome: "goal-completion" },
    gap: { actionFamily: "build", terminalFailureCode: "BUILD_MATERIAL_MISSING", causedByFailureCodes: [] },
    linkedIncidentIds: [],
    ...overrides,
  };
}

describe("FileSkillGapStore persistence", () => {
  it("survives a restart with occurrence counts and timestamps intact", () => {
    const dir = tempDir();
    const first = new FileSkillGapStore(dir);
    first.record(gapInput());
    first.record(gapInput()); // 同 fingerprint 聚合
    const persisted = first.list()[0]!;
    expect(persisted.occurrenceCount).toBe(2);

    const restarted = new FileSkillGapStore(dir);
    const restored = restarted.list()[0]!;
    expect(restored.occurrenceCount).toBe(2);
    expect(restored.firstSeenAtMs).toBe(persisted.firstSeenAtMs);
    expect(restored.gapId).toBe(persisted.gapId);
    // 重启后再聚合继续累计。
    restarted.record(gapInput());
    expect(restarted.list()[0]!.occurrenceCount).toBe(3);
  });
  it("quarantines a corrupt store and starts clean without deleting evidence", () => {
    const dir = tempDir();
    const file = path.join(dir, "skill-gaps.json");
    writeFileSync(file, "{not-json");
    const store = new FileSkillGapStore(dir);
    expect(store.size).toBe(0);
    const quarantined = readdirSync(dir).find((name) => name.startsWith("skill-gaps.json.corrupt-"));
    expect(quarantined).toBeDefined();
    expect(readFileSync(path.join(dir, quarantined!), "utf8")).toBe("{not-json");
    expect(store.durability).toBe("file");
  });
  it("drops schema-invalid entries on restore but keeps valid ones", () => {
    const dir = tempDir();
    const good = new FileSkillGapStore(dir);
    good.record(gapInput());
    const raw = JSON.parse(readFileSync(path.join(dir, "skill-gaps.json"), "utf8")) as { gaps: unknown[] };
    raw.gaps.push({ nonsense: true });
    writeFileSync(path.join(dir, "skill-gaps.json"), JSON.stringify(raw));
    const restarted = new FileSkillGapStore(dir);
    expect(restarted.size).toBe(1);
  });
});

describe("suggestComposition", () => {
  const catalog = [
    { skillId: "build.blueprint" },
    { skillId: "build.wall" },
    { skillId: "collect.dug" },
  ];

  it("suggests catalog skills for a composition-family gap", () => {
    const suggestion = suggestComposition(
      { kind: "existing_skill_composition_missing", actionFamily: "build" },
      catalog,
    );
    expect(suggestion).not.toBeNull();
    expect(suggestion!.skillIds).toEqual(["build.blueprint", "build.wall"]);
    expect(suggestion!.resolverKind).toBe("existing_composition");
  });
  it("returns null when the family has no catalog skills (no false composition)", () => {
    expect(suggestComposition(
      { kind: "existing_skill_composition_missing", actionFamily: "terraform" },
      catalog,
    )).toBeNull();
  });
  it("returns null for kinds whose recommended resolver is higher-order", () => {
    expect(suggestComposition({ kind: "blueprint_missing", actionFamily: "build" }, catalog)).toBeNull();
    expect(suggestComposition({ kind: "capability_backend_missing", actionFamily: "build" }, catalog)).toBeNull();
  });
  it("matches via requestedCapability keywords", () => {
    const suggestion = suggestComposition(
      { kind: "planner_decomposition_gap", actionFamily: "general", requestedCapability: "blueprint" },
      catalog,
    );
    expect(suggestion?.skillIds).toContain("build.blueprint");
  });
});

describe("classifyGap mapping sanity (recorder input shapes)", () => {
  it("maps three real failure codes to distinct gap kinds and filters non-gap codes", () => {
    expect(classifyGap({
      terminalFailureCode: "BUILD_MATERIAL_MISSING", causedByFailureCodes: [], actionFamily: "build",
      skillExists: false, skillCompatible: true, hasCompositionCandidate: false,
      capabilityAvailable: true, policyDenied: false,
    })).toBe("blueprint_missing");
    expect(classifyGap({
      terminalFailureCode: "PLANNER_INPUT_UNGROUNDED", causedByFailureCodes: [], actionFamily: "general",
      skillExists: false, skillCompatible: true, hasCompositionCandidate: false,
      capabilityAvailable: true, policyDenied: false,
    })).toBe("grounding_fact_missing");
    expect(classifyGap({
      terminalFailureCode: "SKILL_VERIFY_FAILED", causedByFailureCodes: [], actionFamily: "movement",
      skillExists: false, skillCompatible: true, hasCompositionCandidate: false,
      capabilityAvailable: true, policyDenied: false,
    })).toBe("skill_contract_mismatch");
    expect(classifyGap({
      terminalFailureCode: "PATHFINDER_GOTO_FAILED", causedByFailureCodes: [], actionFamily: "movement",
      skillExists: false, skillCompatible: true, hasCompositionCandidate: false,
      capabilityAvailable: true, policyDenied: false,
    })).toBeNull();
  });
  it("in-memory store keeps its original aggregation semantics", () => {
    const store = new SkillGapStore({ now: () => 1_000 });
    store.record(gapInput());
    store.record(gapInput());
    expect(store.list()[0]!.occurrenceCount).toBe(2);
  });
});

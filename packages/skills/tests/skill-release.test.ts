import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { generateGapBundle, type SkillGapRequest } from "../src/gap-bundle.js";
import {
  FileSkillReleaseStore,
  SkillReleaseError,
  SkillReleasePipeline,
} from "../src/skill-release.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "skill-release-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** fluid.place 同级复杂度假想技能的完整管线演练（完成门槛）。 */
function hypotheticalGap(): SkillGapRequest {
  return {
    gapId: "gap-abc123def456",
    fingerprint: "a".repeat(32),
    kind: "capability_not_available",
    status: "detected",
    severity: "error",
    createdAtMs: 1, firstSeenAtMs: 1, lastSeenAtMs: 1, occurrenceCount: 4,
    project: { gitCommit: "abc1234", branch: "main", buildVersion: "test", dirty: false },
    runtime: { botId: "bot-01", serverProfileId: "profile-a", minecraftVersion: "1.21.11" },
    goal: { goalText: "drain the pond with a bucket", requestedOutcome: "water-removed" },
    gap: {
      requestedSkillId: "fluid.pump",
      actionFamily: "fluid",
      terminalFailureCode: "CAPABILITY_NOT_AVAILABLE",
      causedByFailureCodes: [],
    },
    linkedIncidentIds: [],
  };
}

describe("skill release pipeline — full drill (draft → verified parking)", () => {
  it("runs bundle→draft→sandboxed→verified and parks at verified without operator input", () => {
    const bundle = generateGapBundle(hypotheticalGap());
    expect(bundle).not.toBeNull();

    const pipeline = new SkillReleasePipeline({ now: () => 1_000 });
    const draft = pipeline.createDraftRelease({
      skillId: "fluid.pump",
      gapFingerprint: hypotheticalGap().fingerprint,
      bundleContentHash: bundle!.contentHash,
    });
    expect(draft.status).toBe("draft");
    expect(draft.evidence[0]!.kind).toBe("bundle-exported");

    const sandboxed = pipeline.promoteToSandboxed(draft.releaseId);
    expect(sandboxed.status).toBe("sandboxed");

    // fixture 自动验收：rcon 真值检查全过 → 自动推进 verified（停车点）。
    const verified = pipeline.recordFixtureRun(draft.releaseId, {
      fixtureId: "vanilla-1.21.11",
      passed: true,
      rconChecks: [
        { label: "execute if block <bucket-target> minecraft:air", passed: true },
        { label: "bucket item consumed from inventory", passed: true },
      ],
      failures: [],
    });
    expect(verified.status).toBe("verified");
    expect(verified.evidence.some((e) => e.kind === "fixture-run" && e.passed)).toBe(true);
  });

  it("a failing fixture run keeps evidence but does not advance", () => {
    const pipeline = new SkillReleasePipeline({ now: () => 1_000 });
    const draft = pipeline.createDraftRelease({ skillId: "x.y", gapFingerprint: "b".repeat(32), bundleContentHash: "c".repeat(64) });
    pipeline.promoteToSandboxed(draft.releaseId);
    const after = pipeline.recordFixtureRun(draft.releaseId, {
      fixtureId: "vanilla-1.21.11", passed: false,
      rconChecks: [{ label: "check", passed: false }], failures: ["block still water"],
    });
    expect(after.status).toBe("sandboxed");
    expect(after.evidence).toHaveLength(2); // bundle + fixture(失败仍留证)
  });

  it("verified→canary and canary→active both require operator decisions", () => {
    const pipeline = new SkillReleasePipeline({ now: () => 1_000 });
    const draft = pipeline.createDraftRelease({ skillId: "x.y", gapFingerprint: "b".repeat(32), bundleContentHash: "c".repeat(64) });
    pipeline.promoteToSandboxed(draft.releaseId);
    pipeline.recordFixtureRun(draft.releaseId, { fixtureId: "f", passed: true, rconChecks: [], failures: [] });

    // verified→canary：operator 决策是唯一入口（transitionWithEvidence 强制
    // operator-decision 证据，缺失即 RELEASE_OPERATOR_APPROVAL_REQUIRED）。
    const canary = pipeline.operatorDecision(draft.releaseId, "promote-canary", "renna", "gray on luv next");
    expect(canary.status).toBe("canary");
    const active = pipeline.operatorDecision(draft.releaseId, "promote-active", "renna", "12h canary clean");
    expect(active.status).toBe("active");
  });

  it("rejects illegal jumps (draft→verified, draft→canary, sandboxed→active)", () => {
    const pipeline = new SkillReleasePipeline({ now: () => 1_000 });
    const draft = pipeline.createDraftRelease({ skillId: "x.y", gapFingerprint: "b".repeat(32), bundleContentHash: "c".repeat(64) });
    expect(() => pipeline.operatorDecision(draft.releaseId, "promote-canary", "renna")).toThrow(/RELEASE_TRANSITION_ILLEGAL|OPERATOR_APPROVAL/);
    // sandboxed 直接 promote-active 是非法跳跃。
    pipeline.promoteToSandboxed(draft.releaseId);
    expect(() => pipeline.operatorDecision(draft.releaseId, "promote-active", "renna")).toThrow(SkillReleaseError);
    // draft 期 fixture 证据只记录不推进（draft→verified 无此路径）。
    const draft2 = pipeline.createDraftRelease({ skillId: "a.b", gapFingerprint: "d".repeat(32), bundleContentHash: "e".repeat(64) });
    const parked = pipeline.recordFixtureRun(draft2.releaseId, { fixtureId: "f", passed: true, rconChecks: [], failures: [] });
    expect(parked.status).toBe("draft");
  });

  it("revocation ends the lifecycle from any live state", () => {
    const pipeline = new SkillReleasePipeline({ now: () => 1_000 });
    const draft = pipeline.createDraftRelease({ skillId: "x.y", gapFingerprint: "b".repeat(32), bundleContentHash: "c".repeat(64) });
    const revoked = pipeline.operatorDecision(draft.releaseId, "revoke", "renna", "wrong approach");
    expect(revoked.status).toBe("revoked");
    // revoked 后再无合法转换。
    expect(() => pipeline.operatorDecision(draft.releaseId, "promote-canary", "renna")).toThrow(SkillReleaseError);
  });

  it("evidence is bounded to 32 entries (oldest dropped)", () => {
    const pipeline = new SkillReleasePipeline({ now: () => 1_000 });
    const draft = pipeline.createDraftRelease({ skillId: "x.y", gapFingerprint: "b".repeat(32), bundleContentHash: "c".repeat(64) });
    for (let index = 0; index < 40; index++) {
      pipeline.recordFixtureRun(draft.releaseId, { fixtureId: `f-${index}`, passed: false, rconChecks: [], failures: [] });
    }
    expect(pipeline.get(draft.releaseId)!.evidence.length).toBeLessThanOrEqual(32);
  });
});

describe("FileSkillReleaseStore", () => {
  it("persists releases across restart", () => {
    const dir = tempDir();
    const store = new FileSkillReleaseStore(dir);
    const draft = store.createDraftRelease({ skillId: "fluid.pump", gapFingerprint: "b".repeat(32), bundleContentHash: "c".repeat(64) });
    store.pipeline.promoteToSandboxed(draft.releaseId);
    store.persist(draft.releaseId);

    const restarted = new FileSkillReleaseStore(dir);
    const restored = restarted.pipeline.get(draft.releaseId);
    expect(restored?.status).toBe("sandboxed");
    expect(restored?.evidence[0]?.kind).toBe("bundle-exported");
  });
});

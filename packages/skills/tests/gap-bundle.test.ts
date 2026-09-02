// Gap Bundle 测试：redaction、secret scan fail-closed、bundle 结构、hash。
import { describe, expect, it } from "vitest";
import { gapFingerprint } from "../src/skill-gap.js";
import {
  generateGapBundle,
  redactText,
  scanResidualSecrets,
} from "../src/gap-bundle.js";
import type { SkillGapRequest } from "../src/skill-gap.js";

function makeGap(overrides: Partial<SkillGapRequest> = {}): SkillGapRequest {
  return {
    gapId: "gap-test",
    fingerprint: gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "X" }),
    kind: "unknown_gap",
    status: "detected",
    severity: "info",
    createdAtMs: 1_000,
    firstSeenAtMs: 1_000,
    lastSeenAtMs: 1_000,
    occurrenceCount: 1,
    project: { gitCommit: "abc1234", branch: "main", buildVersion: "1.0", dirty: false },
    runtime: { botId: "bot-1", serverProfileId: "sp-1" },
    goal: { requestedOutcome: "test outcome" },
    gap: { actionFamily: "test", terminalFailureCode: "X", causedByFailureCodes: [] },
    linkedIncidentIds: [],
    ...overrides,
  };
}

describe("redactText", () => {
  it("api_key=... 被 redact", () => {
    expect(redactText("api_key=abc123secret")).not.toContain("abc123secret");
    expect(redactText("api_key=abc123secret")).toContain("[REDACTED]");
  });

  it("Bearer token 被 redact", () => {
    expect(redactText("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9")).toContain("[REDACTED]");
  });

  it("GitHub PAT 被 redact", () => {
    expect(redactText("token: ghp_abcdef1234567890abcdef1234567890abcdef12")).toContain("[REDACTED]");
  });

  it("正常文本不受影响", () => {
    expect(redactText("hello world")).toBe("hello world");
  });
});

describe("scanResidualSecrets", () => {
  it("无 secret → true", () => {
    expect(scanResidualSecrets("hello world")).toBe(true);
  });

  it("有 secret → false", () => {
    expect(scanResidualSecrets("api_key=abc123")).toBe(false);
  });
});

describe("generateGapBundle", () => {
  it("正常 gap 生成 bundle", () => {
    const bundle = generateGapBundle(makeGap(), { now: () => 2_000 });
    expect(bundle).not.toBeNull();
    expect(bundle!.schemaVersion).toBe("1.0");
    expect(bundle!.implementationPrompt).toContain("Skill Gap Development Request");
    expect(bundle!.implementationPrompt).toContain("unknown_gap");
    expect(bundle!.securityReport.residualSecretScanPassed).toBe(true);
    expect(bundle!.contentHash).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("gap 含 secret 的 goalText → redact 后通过", () => {
    const gap = makeGap({
      goal: { requestedOutcome: "api_key=super_secret_value do something" },
    });
    const bundle = generateGapBundle(gap);
    // goalText 进 prompt → redact 后应无 secret
    expect(bundle).not.toBeNull();
    expect(bundle!.implementationPrompt).not.toContain("super_secret_value");
  });

  it("同 gap 同 options → 同 contentHash（deterministic）", () => {
    const gap = makeGap();
    const a = generateGapBundle(gap, { now: () => 2_000 });
    const b = generateGapBundle(gap, { now: () => 2_000 });
    expect(a!.contentHash).toBe(b!.contentHash);
  });

  it("不同 now → 不同 hash", () => {
    const gap = makeGap();
    const a = generateGapBundle(gap, { now: () => 1_000 });
    const b = generateGapBundle(gap, { now: () => 2_000 });
    expect(a!.contentHash).not.toBe(b!.contentHash);
  });

  it("含 existing skills 列表", () => {
    const bundle = generateGapBundle(makeGap(), {
      existingSkills: [{ skillId: "movement.goto", capabilities: ["pathfinder"] }],
    });
    expect(bundle!.implementationPrompt).toContain("movement.goto");
    expect(bundle!.implementationPrompt).toContain("pathfinder");
  });

  it("prompt 含安全纪律", () => {
    const bundle = generateGapBundle(makeGap());
    expect(bundle!.implementationPrompt).toContain("DO NOT modify policy");
    expect(bundle!.implementationPrompt).toContain("UNTRUSTED_EXTERNAL_TEXT");
  });
});

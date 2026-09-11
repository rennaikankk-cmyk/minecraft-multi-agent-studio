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

  it("跨调用不复用 lastIndex（fail-open 回归）", () => {
    // 第一次命中位置靠后的 secret，会把带 g 标志的模块级正则 lastIndex
    // 推进到命中之后（200 + 1 + 14 = 215）。
    const far = `${"a".repeat(200)} api_key=LEAKED`;
    expect(scanResidualSecrets(far)).toBe(false);

    // 第二次的 secret 位于更靠前的位置，且文本总长恰好等于残留的
    // lastIndex。若未复位，test() 会从 215 起步、越过整个字符串而漏检，
    // 从而误报 true（安全）。修复后必须仍判定为不安全。
    const near = `api_key=LEAKED ${"b".repeat(200)}`;
    expect(scanResidualSecrets(near)).toBe(false);
  });

  it("反复调用同一文本结果稳定", () => {
    const text = "token: ghp_abcdef1234567890abcdef1234567890abcdef12";
    for (let i = 0; i < 4; i += 1) {
      expect(scanResidualSecrets(text)).toBe(false);
    }
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

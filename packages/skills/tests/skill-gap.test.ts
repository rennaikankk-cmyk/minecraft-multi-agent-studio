// Skill Gap 域模型测试：分类器、fingerprint、去重、lifecycle、resolver。
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DEVELOPMENT_MODE,
  SkillGapStore,
  capabilityGapKindSchema,
  canTransitionRelease,
  classifyGap,
  gapFingerprint,
  recommendedResolver,
  skillGapRequestSchema,
  type GapFingerprintInput,
} from "../src/skill-gap.js";

describe("Gap taxonomy", () => {
  it("16 种合法 kind", () => {
    const kinds = [
      "existing_skill_composition_missing", "skill_not_advertised", "skill_not_compatible",
      "skill_contract_mismatch", "capability_not_available", "capability_backend_missing",
      "server_profile_missing", "server_behavior_unknown", "blueprint_missing",
      "template_version_unverified", "observation_insufficient", "grounding_fact_missing",
      "policy_denied", "resource_dependency_missing", "planner_decomposition_gap",
      "unknown_gap",
    ];
    for (const kind of kinds) {
      expect(capabilityGapKindSchema.safeParse(kind).success, kind).toBe(true);
    }
    expect(capabilityGapKindSchema.safeParse("not_a_gap").success).toBe(false);
  });
});

describe("Fingerprint", () => {
  it("deterministic：同输入同输出", () => {
    const input: GapFingerprintInput = {
      kind: "capability_backend_missing",
      actionFamily: "fluid.place",
      terminalFailureCode: "CAPABILITY_NOT_AVAILABLE",
      minecraftVersion: "1.21.11",
    };
    expect(gapFingerprint(input)).toBe(gapFingerprint(input));
  });

  it("排除 botId/时间戳/坐标——它们不在 fingerprint 输入里", () => {
    const a = gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "X" });
    const b = gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "X" });
    expect(a).toBe(b); // 同 gap 不同 bot/时间 → 同 fingerprint
  });

  it("不同 kind/.failureCode → 不同 fingerprint", () => {
    const a = gapFingerprint({ kind: "policy_denied", actionFamily: "test", terminalFailureCode: "X" });
    const b = gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "X" });
    const c = gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "Y" });
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it("32 字符 hex", () => {
    const fp = gapFingerprint({ kind: "unknown_gap", actionFamily: "x", terminalFailureCode: "Y" });
    expect(fp).toMatch(/^[a-f0-9]{32}$/u);
  });
});

describe("确定性分类器", () => {
  const base = {
    terminalFailureCode: "UNKNOWN_FAILURE",
    causedByFailureCodes: [] as string[],
    actionFamily: "generic",
    skillExists: false,
    skillCompatible: false,
    hasCompositionCandidate: false,
    capabilityAvailable: false,
    policyDenied: false,
  };

  it("路径故障不产生 Gap", () => {
    expect(classifyGap({ ...base, terminalFailureCode: "PATH_NO_PROGRESS" })).toBeNull();
    expect(classifyGap({ ...base, terminalFailureCode: "PATHFINDER_GOTO_FAILED" })).toBeNull();
  });

  it("生命周期故障不产生 Gap", () => {
    expect(classifyGap({ ...base, terminalFailureCode: "GOAL_EXPIRED_WAITING_FOR_BOT" })).toBeNull();
    expect(classifyGap({ ...base, terminalFailureCode: "BOT_READINESS_TIMEOUT" })).toBeNull();
  });

  it("AI 不可用不产生 Gap", () => {
    expect(classifyGap({ ...base, terminalFailureCode: "AI_NODE_UNREACHABLE" })).toBeNull();
    expect(classifyGap({ ...base, terminalFailureCode: "LLM_REQUEST_TIMEOUT" })).toBeNull();
  });

  it("causedBy 含非 gap 码也不产生 Gap", () => {
    expect(classifyGap({ ...base, causedByFailureCodes: ["PATH_NO_PROGRESS"] })).toBeNull();
  });

  it("policy denied → policy_denied（不 bypass）", () => {
    expect(classifyGap({ ...base, policyDenied: true })).toBe("policy_denied");
  });

  it("catalog 不可用 → skill_not_advertised", () => {
    expect(classifyGap({ ...base, terminalFailureCode: "PLANNER_SKILL_CATALOG_UNAVAILABLE" }))
      .toBe("skill_not_advertised");
  });

  it("blueprint 缺失 → blueprint_missing", () => {
    expect(classifyGap({ ...base, terminalFailureCode: "BLUEPRINT_ANCHOR_INVALID" }))
      .toBe("blueprint_missing");
  });

  it("grounding 缺失 → grounding_fact_missing", () => {
    expect(classifyGap({ ...base, terminalFailureCode: "PLANNER_INPUT_UNGROUNDED" }))
      .toBe("grounding_fact_missing");
  });

  it("现有 skill 有组合方案 → existing_skill_composition_missing", () => {
    expect(classifyGap({
      ...base,
      skillExists: true,
      skillCompatible: true,
      hasCompositionCandidate: true,
    })).toBe("existing_skill_composition_missing");
  });

  it("skill 存在不兼容 → skill_not_compatible", () => {
    expect(classifyGap({ ...base, skillExists: true, skillCompatible: false }))
      .toBe("skill_not_compatible");
  });

  it("skill 存在兼容但 capability 缺 → capability_not_available", () => {
    expect(classifyGap({
      ...base,
      skillExists: true,
      skillCompatible: true,
      capabilityAvailable: false,
      hasCompositionCandidate: false,
    })).toBe("capability_not_available");
  });

  it("skill 和 capability 都缺 → capability_backend_missing", () => {
    expect(classifyGap({ ...base, skillExists: false, capabilityAvailable: false }))
      .toBe("capability_backend_missing");
  });

  it("skill 缺但 capability 在 → skill_not_advertised（新 Skill 候选）", () => {
    expect(classifyGap({ ...base, skillExists: false, capabilityAvailable: true }))
      .toBe("skill_not_advertised");
  });
});

describe("Resolver 分流", () => {
  it("composition kind → existing_composition resolver", () => {
    expect(recommendedResolver("existing_skill_composition_missing")).toBe("existing_composition");
  });

  it("blueprint kind → blueprint resolver", () => {
    expect(recommendedResolver("blueprint_missing")).toBe("blueprint");
  });

  it("observation kind → observation resolver", () => {
    expect(recommendedResolver("grounding_fact_missing")).toBe("observation");
  });

  it("capability_backend_missing → new_capability resolver", () => {
    expect(recommendedResolver("capability_backend_missing")).toBe("new_capability");
  });

  it("policy_denied 不产生 bypass（走 composition 标记）", () => {
    expect(recommendedResolver("policy_denied")).toBe("existing_composition");
  });
});

describe("Release lifecycle", () => {
  it("draft 不直接到 active", () => {
    expect(canTransitionRelease("draft", "active")).toBe(false);
  });

  it("正常链路 draft→sandboxed→verified→canary→active", () => {
    expect(canTransitionRelease("draft", "sandboxed")).toBe(true);
    expect(canTransitionRelease("sandboxed", "verified")).toBe(true);
    expect(canTransitionRelease("verified", "canary")).toBe(true);
    expect(canTransitionRelease("canary", "active")).toBe(true);
  });

  it("任何状态都可 revoke", () => {
    expect(canTransitionRelease("draft", "revoked")).toBe(true);
    expect(canTransitionRelease("canary", "revoked")).toBe(true);
    expect(canTransitionRelease("active", "revoked")).toBe(true);
  });

  it("revoked 是终态", () => {
    expect(canTransitionRelease("revoked", "draft")).toBe(false);
    expect(canTransitionRelease("revoked", "active")).toBe(false);
  });
});

describe("SkillGapStore（去重与 bounded）", () => {
  it("同 fingerprint 聚合不重复创建", () => {
    const store = new SkillGapStore({ now: () => 1_000 });
    const fp = gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "X" });
    const input = {
      fingerprint: fp,
      kind: "unknown_gap" as const,
      severity: "info" as const,
      project: { gitCommit: "abc1234", branch: "main", buildVersion: "1.0", dirty: false },
      runtime: { botId: "bot-1", serverProfileId: "sp-1" },
      goal: { requestedOutcome: "test" },
      gap: { actionFamily: "test", terminalFailureCode: "X", causedByFailureCodes: [] },
      linkedIncidentIds: [],
    };
    const first = store.record(input);
    expect(first.occurrenceCount).toBe(1);
    expect(first.status).toBe("detected");
    const second = store.record(input);
    expect(second.occurrenceCount).toBe(2);
    expect(second.status).toBe("deduplicated");
    expect(store.size).toBe(1);
  });

  it("不同 fingerprint 各自存储", () => {
    const store = new SkillGapStore();
    const fpA = gapFingerprint({ kind: "unknown_gap", actionFamily: "a", terminalFailureCode: "X" });
    const fpB = gapFingerprint({ kind: "policy_denied", actionFamily: "a", terminalFailureCode: "X" });
    store.record(makeGap(fpA));
    store.record(makeGap(fpB));
    expect(store.size).toBe(2);
  });

  it("满时驱逐最低 severity 最旧条目", () => {
    const store = new SkillGapStore({ maxGaps: 2, now: () => 1_000 });
    const fp1 = gapFingerprint({ kind: "unknown_gap", actionFamily: "a", terminalFailureCode: "X" });
    const fp2 = gapFingerprint({ kind: "unknown_gap", actionFamily: "b", terminalFailureCode: "X" });
    const fp3 = gapFingerprint({ kind: "unknown_gap", actionFamily: "c", terminalFailureCode: "X" });
    store.record(makeGap(fp1, "info"));
    store.record(makeGap(fp2, "error"));
    store.record(makeGap(fp3, "info")); // 满了，驱逐 fp1 (info)
    expect(store.size).toBe(2);
    expect(store.get(fp1)).toBeNull(); // 被驱逐
    expect(store.get(fp2)).not.toBeNull(); // error 保留
  });

  it("schema 验证 gap request 形状", () => {
    const fp = gapFingerprint({ kind: "unknown_gap", actionFamily: "test", terminalFailureCode: "X" });
    const gap = makeGap(fp);
    expect(skillGapRequestSchema.safeParse({ ...gap, gapId: "g1", occurrenceCount: 1, createdAtMs: 1, firstSeenAtMs: 1, lastSeenAtMs: 1, status: "detected" }).success).toBe(true);
  });
});

describe("Development mode", () => {
  it("默认 export_only（安全）", () => {
    expect(DEFAULT_DEVELOPMENT_MODE).toBe("export_only");
  });
});

function makeGap(fingerprint: string, severity: "info" | "error" = "info") {
  return {
    fingerprint,
    kind: "unknown_gap" as const,
    severity,
    project: { gitCommit: "abc1234", branch: "main", buildVersion: "1.0", dirty: false },
    runtime: { botId: "bot-1", serverProfileId: "sp-1" },
    goal: { requestedOutcome: "test" },
    gap: { actionFamily: "test", terminalFailureCode: "X", causedByFailureCodes: [] },
    linkedIncidentIds: [],
  };
}

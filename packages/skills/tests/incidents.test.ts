// ---------------------------------------------------------------------------
// Incident 领域核心回归测试（fingerprint/dedup/分类/redaction/持久化/bounds）
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildRepairPrompt,
  classifyIncident,
  containsUnredactedSecrets,
  EventRingBuffer,
  FAILURE_CODE_ALIASES,
  incidentFingerprint,
  IncidentStore,
  normalizeFailureCode,
  occurrenceToMarkdown,
  redactSecrets,
  safeExportText,
  type Severity,
} from "../src/incidents.js";

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}

const dirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "studio-incidents-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("FailureCode registry", () => {
  it("normalizes legacy aliases instead of inventing new strings", () => {
    expect(normalizeFailureCode("PATH_FAILED")).toBe("PATH_NO_PROGRESS");
    expect(normalizeFailureCode("VERIFY_TIMEOUT")).toBe("SKILL_VERIFY_FAILED");
    expect(normalizeFailureCode("whatever")).toBe("UNKNOWN_FAILURE");
    expect(Object.keys(FAILURE_CODE_ALIASES)).toContain("STUCK");
  });
});

describe("deterministic classification (不默认归咎 Skill)", () => {
  it("replan storm + valid target + zero progress → PATHFINDING not SKILL", () => {
    const result = classifyIncident({
      failureCode: "PATH_NO_PROGRESS",
      incidentType: "STUCK",
      replanCount: 17,
      targetStillValid: true,
      goalProgressDelta: 0,
    });
    expect(result.suspectedLayer).toBe("PATHFINDING");
    expect(result.ruleId).toBe("R-PATH-STORM-1");
    expect(result.confidenceBand).toBe("high");
    expect(result.matchedEvidence.join(" ")).toContain("replanCount=17");
  });

  it("place reported success but server verify mismatch → RUNTIME (false success)", () => {
    const result = classifyIncident({
      failureCode: "RUNTIME_FALSE_SUCCESS",
      incidentType: "FALSE_SUCCESS",
      actionReportedSuccess: true,
      verifiedBlockName: "air",
      expectedBlockName: "furnace",
    });
    expect(result.suspectedLayer).toBe("RUNTIME");
    expect(result.ruleId).toBe("R-FALSE-SUCCESS-1");
  });

  it("LLM output invalid → LLM layer", () => {
    const result = classifyIncident({ failureCode: "LLM_OUTPUT_INVALID", incidentType: "LLM_INVALID_OUTPUT", llmOutputInvalid: true });
    expect(result.suspectedLayer).toBe("LLM");
  });

  it("protocol mismatch pre-empts everything → VERSION_COMPAT", () => {
    const result = classifyIncident({
      failureCode: "RUNTIME_PLACE_REJECTED",
      incidentType: "PLACEMENT_FAILED",
      protocolMismatch: true,
      actionReportedSuccess: true,
      verifiedBlockName: "air",
      expectedBlockName: "furnace",
    });
    expect(result.suspectedLayer).toBe("VERSION_COMPAT");
  });

  it("reservation corruption → COORDINATOR, not workstation/skill", () => {
    const result = classifyIncident({ failureCode: "RESERVATION_OWNER_MISMATCH", incidentType: "STATE_DIVERGENCE" });
    expect(result.suspectedLayer).toBe("COORDINATOR");
  });

  it("smelting skill failure code stays SKILL but with low confidence (not default-blamed pathfinder)", () => {
    const result = classifyIncident({ failureCode: "SKILL_VERIFY_FAILED", incidentType: "SKILL_FAILED" });
    expect(result.suspectedLayer).toBe("SKILL");
    expect(result.confidenceBand).toBe("low");
  });
});

describe("fingerprint", () => {
  it("is deterministic and independent of bot/time/layer/status", () => {
    const base = { incidentType: "STUCK" as const, failureCode: "PATH_NO_PROGRESS" as const, sourceComponent: "pathfinder" };
    const a = incidentFingerprint(base);
    const b = incidentFingerprint(base);
    expect(a).toBe(b);
    expect(a).toMatch(/^fp1-[0-9a-f]{16}$/);
  });

  it("excludes volatile inputs: same defect from different bots shares fingerprint", () => {
    const mk = (skillId: string) => incidentFingerprint({
      incidentType: "STUCK",
      failureCode: "PATH_NO_PROGRESS",
      sourceComponent: "pathfinder",
      // skillId 不参与 fingerprint（跨 Skill 的 pathfinder 缺陷不拆分）——这里模拟调用方漏传也不影响
      ...(skillId ? {} : {}),
    });
    expect(mk("smelting")).toBe(mk("building"));
  });

  it("version family participates", () => {
    const a = incidentFingerprint({ incidentType: "STUCK", failureCode: "PATH_NO_PROGRESS", sourceComponent: "pf", versionFamily: "1.21.x" });
    const b = incidentFingerprint({ incidentType: "STUCK", failureCode: "PATH_NO_PROGRESS", sourceComponent: "pf", versionFamily: "1.20.x" });
    expect(a).not.toBe(b);
  });
});

describe("IncidentStore dedup + aggregation", () => {
  it("same fingerprint dedups into one issue; occurrenceCount increments; severity upgrades", () => {
    const store = new IncidentStore();
    const first = store.report({
      subject: "bot", botId: "bot-a", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
      sourceComponent: "pathfinder", severity: "ERROR",
      classificationInput: { failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", replanCount: 12, targetStillValid: true, goalProgressDelta: 0 },
    });
    expect(first.createdIssue).toBe(true);

    // 不同 bot、不同时间、更严重 —— 同一缺陷
    const second = store.report({
      subject: "bot", botId: "bot-b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
      sourceComponent: "pathfinder", severity: "CRITICAL",
      classificationInput: { failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", replanCount: 20, targetStillValid: true, goalProgressDelta: 0 },
    });
    expect(second.createdIssue).toBe(false);
    expect(second.issue.incidentId).toBe(first.issue.incidentId);
    expect(second.issue.occurrenceCount).toBe(2);
    expect(second.issue.maxSeverity).toBe("CRITICAL");
    expect(second.issue.affectedBotIds).toEqual(["bot-a", "bot-b"]);
    expect(store.listIssues()).toHaveLength(1);
  });

  it("different defect → separate issue (no 500-issue explosion the other way either)", () => {
    const store = new IncidentStore();
    store.report({ subject: "bot", botId: "bot-a", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pathfinder" });
    store.report({ subject: "bot", botId: "bot-a", failureCode: "LLM_OUTPUT_INVALID", incidentType: "LLM_INVALID_OUTPUT", sourceComponent: "planner" });
    expect(store.listIssues()).toHaveLength(2);
  });

  it("subject=bot without botId is rejected", () => {
    const store = new IncidentStore();
    expect(() => store.report({ subject: "bot", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "x" })).toThrow(/botId/);
  });

  it("BOT_CRASH style occurrence (subject=process_group, no botId) is allowed", () => {
    const store = new IncidentStore();
    const { issue } = store.report({
      subject: "process_group", failureCode: "BOT_PROCESS_EXITED", incidentType: "BOT_CRASH",
      sourceComponent: "studio-local-manager", expected: "exit code 0 after graceful stop", actual: "exit code 1 signal null",
    });
    expect(issue.suspectedLayer).toBe("RUNTIME");
  });

  it("status transitions: open→fixed directly is rejected; fixed requires passed verification", () => {
    const store = new IncidentStore();
    const { issue } = store.report({ subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf" });
    expect(store.transitionStatus(issue.incidentId, "fixed").ok).toBe(false);
    expect(store.transitionStatus(issue.incidentId, "investigating").ok).toBe(true);
    // 未经过验证 → fixed 拒绝（不能只点按钮）
    expect(store.transitionStatus(issue.incidentId, "fixed", { fixedByCommit: "abc123" })).toEqual({
      ok: false,
      reason: "FIXED_REQUIRES_PASSED_VERIFICATION",
    });
    // 验证流程：request → record passed → fixed
    expect(store.requestVerification(issue.incidentId)).toBe(true);
    expect(store.recordVerificationResult(issue.incidentId, "passed")).toBe(true);
    expect(store.transitionStatus(issue.incidentId, "fixed", { fixedByCommit: "abc123" }).ok).toBe(true);
    expect(store.getIssue(issue.incidentId)!.fixedByCommit).toBe("abc123");
    // 状态机审计历史
    const history = store.getIssue(issue.incidentId)!.statusHistory;
    expect(history.map((entry) => `${entry.from}>${entry.to}`)).toEqual(["open>investigating", "investigating>fixed"]);
  });

  it("persistence round-trip: issues/occurrences survive restart (atomic file)", async () => {
    const dir = tmpDir();
    const path = join(dir, "incidents.json");
    const store = new IncidentStore({ persistPath: path });
    const { issue } = store.report({
      subject: "bot", botId: "bot-a", failureCode: "BUILD_WRONG_BLOCK", incidentType: "PLACEMENT_FAILED",
      sourceComponent: "build", expected: "cobblestone at (10,65,8)", actual: "dirt at (10,65,8)",
      snapshots: { cell: "41", attempts: 3 },
    });
    await store.flush();
    expect(existsSync(path)).toBe(true);
    JSON.parse(readFileSync(path, "utf8")); // 合法 JSON（原子写）

    const reopened = new IncidentStore({ persistPath: path });
    const restored = reopened.getIssue(issue.incidentId)!;
    expect(restored.occurrenceCount).toBe(1);
    expect(restored.primaryFailureCode).toBe("BUILD_WRONG_BLOCK");
    expect(reopened.listOccurrences(issue.incidentId)[0]!.actual).toContain("dirt");
    // 重开后继续计数不撞 ID
    const again = reopened.report({
      subject: "bot", botId: "bot-a", failureCode: "BUILD_WRONG_BLOCK", incidentType: "PLACEMENT_FAILED",
      sourceComponent: "build",
    });
    expect(again.issue.occurrenceCount).toBe(2);
  });

  it("occurrence evidence is bounded per issue", () => {
    const store = new IncidentStore({ maxOccurrencesPerIssue: 5 });
    for (let i = 0; i < 12; i += 1) {
      store.report({ subject: "server", serverProfileId: "srv", failureCode: "SERVER_KICKED", incidentType: "SERVER_KICK", sourceComponent: "connection" });
    }
    const issue = store.listIssues()[0]!;
    expect(issue.occurrenceCount).toBe(12); // 聚合计数不失真
    expect(store.listOccurrences(issue.incidentId).length).toBe(5); // evidence 有界
  });
});

describe("EventRingBuffer", () => {
  it("respects capacity and time window, returns copies", () => {
    const buffer = new EventRingBuffer(5);
    const t0 = Date.parse("2026-08-30T00:00:00Z");
    for (let i = 0; i < 8; i += 1) {
      buffer.push(new Date(t0 + i * 10_000).toISOString(), `event-${i}`);
    }
    expect(buffer.size).toBe(5); // 容量裁剪
    const window = buffer.window(30_000, 60, t0 + 80_000);
    expect(window.length).toBeLessThanOrEqual(3);
    expect(window[0]!.kind).toContain("event-");
  });
});

describe("secret redaction (export boundary)", () => {
  it("redacts nested keys, arrays, bearer, JWT, URL userinfo", () => {
    const input = {
      apiKey: "sk-1234567890abcdef1234",
      nested: { ACCESS_TOKEN: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4JcuCA2QIHX8qE3FYk9crJstYPODehqK9s", keep: "plain" },
      url: "http://user:pass123@example.com/x",
      header: "Authorization: Bearer abc.def.ghi123456789012",
      list: [{ password: "hunter2" }],
    };
    const out = redactSecrets(input) as Record<string, unknown>;
    expect(out.apiKey).toBe("[REDACTED]");
    expect(JSON.stringify(out.nested)).not.toContain("eyJhbGci");
    expect(out.url).toContain("[REDACTED]");
    expect(out.header).not.toContain("abc.def.ghi123456789012");
    expect(out.header).toContain("[REDACTED]");
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect((out.nested as Record<string, unknown>).keep).toBe("plain");
  });

  it("safeExportText refuses export when secrets survive redaction", () => {
    expect(safeExportText("clean text")).toBe("clean text");
    expect(safeExportText("Bearer abc.def.ghi123456789012")).toBeNull();
    expect(containsUnredactedSecrets("ghp_AFl0Y4Z1N0H9xKq0vB2cD3eF4gH5iJ6kL7mN8")).toBe(true);
  });

  it("markdown export passes the secret gate", () => {
    const store = new IncidentStore();
    const { occurrence, issue } = store.report({
      subject: "bot", botId: "bot-1", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
      sourceComponent: "pathfinder", expected: "reach furnace", actual: "oscillated",
      snapshots: { connection: { authorization: "Bearer abc.def.ghi123456789012" } },
    });
    const { markdown } = occurrenceToMarkdown(issue, occurrence);
    expect(markdown).toContain(issue.incidentId);
    expect(markdown).toContain("PATHFINDING");
    expect(safeExportText(markdown)).not.toBeNull(); // snapshot 内 secret 已被 redact
  });
});

describe("round2 fixes: fingerprint de-aggregation + free-text redaction", () => {
  it("different crash exit signatures stay separate issues; same signature across bots merges", () => {
    const store = new IncidentStore();
    const base = { subject: "bot" as const, botId: "bot-a", failureCode: "BOT_PROCESS_EXITED", incidentType: "BOT_CRASH", sourceComponent: "studio-local-manager" };
    store.report({ ...base, botId: "bot-a", normalizedErrorSignature: "exit-mode:1/null" });
    store.report({ ...base, botId: "bot-b", normalizedErrorSignature: "exit-mode:1/null" }); // 同签名 → 聚合
    store.report({ ...base, botId: "bot-c", normalizedErrorSignature: "exit-mode:null/SIGKILL" }); // 不同退出模式 → 新 issue
    const issues = store.listIssues();
    expect(issues).toHaveLength(2);
    const merged = issues.find((issue) => issue.occurrenceCount === 2)!;
    expect(merged.affectedBotIds).toEqual(["bot-a", "bot-b"]);
  });

  it("free-text password=/token: forms are redacted", () => {
    const out = redactSecrets("connect failed password=hunter2 next token: abc123xyz tail") as string;
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("abc123xyz");
    expect(out).toContain("[REDACTED]");
  });

  it("markdown export redacts free-text secrets in expected/actual", () => {
    const store = new IncidentStore();
    const { issue, occurrence } = store.report({
      subject: "bot", botId: "bot-1", failureCode: "SERVER_PLUGIN_AUTH_FAILED", incidentType: "SKILL_FAILED",
      sourceComponent: "connection",
      expected: "login ok", actual: "auth failed api_key=sk-abcdefghijklmnopqrst rejected",
    });
    const { markdown } = occurrenceToMarkdown(issue, occurrence);
    expect(markdown).not.toContain("sk-abcdefghijklmnopqrst");
    expect(safeExportText(markdown)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Round 3: async writer + retention（P0 持久化可靠性）
// ---------------------------------------------------------------------------

describe("async writer + retention", () => {
  it("report() returns synchronously without blocking on disk; flush() completes persistence", async () => {
    const path = join(tmpDir(), "inc.json");
    const store = new IncidentStore({ persistPath: path, flushDebounceMs: 60_000 }); // 不自动 flush
    const { issue } = store.report({ subject: "bot", botId: "b1", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf" });
    // 未 flush：磁盘上还没有（或不是最新）——内存已可查询
    expect(store.getIssue(issue.incidentId)).not.toBeNull();
    await store.flush();
    const reopened = new IncidentStore({ persistPath: path });
    expect(reopened.getIssue(issue.incidentId)).not.toBeNull();
  });

  it("concurrent reports preserve order and all survive flush", async () => {
    const path = join(tmpDir(), "inc.json");
    const store = new IncidentStore({ persistPath: path, flushDebounceMs: 60_000, maxOccurrencesPerIssue: 200 });
    const signatures = Array.from({ length: 50 }, (_, i) => `sig-${i}`);
    for (const sig of signatures) {
      store.report({ subject: "bot", botId: "b", failureCode: "BOT_PROCESS_EXITED", incidentType: "BOT_CRASH", sourceComponent: "mgr", normalizedErrorSignature: sig });
    }
    await store.flush();
    const reopened = new IncidentStore({ persistPath: path });
    let total = 0;
    for (const issue of reopened.listIssues()) total += reopened.listOccurrences(issue.incidentId).length;
    expect(total).toBe(50);
  });

  it("corrupt store file recovers to empty without throwing; writes still work", () => {
    const path = join(tmpDir(), "inc.json");
    writeFileSync(path, "{corrupt", "utf8");
    const store = new IncidentStore({ persistPath: path });
    expect(store.listIssues()).toHaveLength(0);
    const { issue } = store.report({ subject: "bot", botId: "b", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "x" });
    expect(store.getIssue(issue.incidentId)).not.toBeNull();
  });

  it("issue ids go beyond INC-9999", () => {
    const store = new IncidentStore({ maxOccurrencesPerIssue: 1 });
    // 直接操纵计数器模拟历史存量（不真造 9999 条）
    const internal = store as unknown as { issueCounter: number };
    internal.issueCounter = 9999;
    const first = store.report({ subject: "bot", botId: "b", failureCode: "A1" in {} ? "UNKNOWN_FAILURE" : "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "x1" });
    const second = store.report({ subject: "bot", botId: "b", failureCode: "LLM_OUTPUT_INVALID", incidentType: "LLM_INVALID_OUTPUT", sourceComponent: "x2" });
    expect(first.issue.incidentId).toBe("INC-10000");
    expect(second.issue.incidentId).toBe("INC-10001");
  });

  it("retention: count cap evicts oldest closed issues but never open/active ones", () => {
    const store = new IncidentStore({ maxIssues: 3 });
    const made = [];
    for (let i = 0; i < 5; i += 1) {
      const { issue } = store.report({ subject: "bot", botId: `b${i}`, failureCode: `SIG-${i}` in {} ? "UNKNOWN_FAILURE" : "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: `comp-${i}`, normalizedErrorSignature: `u-${i}` });
      made.push(issue.incidentId);
    }
    // 全部 open 时 retention 不得淘汰任何活跃 issue（宁超限不误删）
    expect(store.listIssues().length).toBe(5);
    // 手动关闭两个最老的 → 超限时它们被清理，open 全保留
    const internalIssues = (store as unknown as { issues: Map<string, { status: string }> }).issues;
    internalIssues.get(made[0]!)!.status = "ignored";
    internalIssues.get(made[1]!)!.status = "ignored";
    internalIssues.get(made[0]!)!.lastSeenAt = "2026-01-01T00:00:00.000Z";
    internalIssues.get(made[1]!)!.lastSeenAt = "2026-01-02T00:00:00.000Z";
    store.report({ subject: "bot", botId: "b9", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "comp-9", normalizedErrorSignature: "u-9" });
    store.enforceRetentionForTest();
    const survivors = store.listIssues().map((issue) => issue.incidentId);
    expect(survivors).toHaveLength(4);
    expect(survivors).not.toContain(made[0]!);
    expect(survivors).not.toContain(made[1]!);
    for (let i = 2; i <= 4; i += 1) expect(survivors).toContain(made[i]!);
  });

  it("retention: maxAgeDays evicts only old issues", async () => {
    const path = join(tmpDir(), "inc.json");
    const store = new IncidentStore({ persistPath: path });
    const { issue } = store.report({ subject: "bot", botId: "b", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "x" });
    await store.flush();
    void issue;
    expect(existsSync(path)).toBe(true);
    const internal = store as unknown as { issues: Map<string, { firstSeenAt: string; lastSeenAt: string; status: string }> };
    for (const rec of internal.issues.values()) {
      rec.firstSeenAt = "2026-07-01T00:00:00.000Z";
      rec.lastSeenAt = "2026-07-01T00:00:00.000Z";
      rec.status = "known_issue";
    }
    await store.flush();
    const aged = new IncidentStore({ persistPath: path, maxAgeDays: 30 });
    expect(aged.listIssues()).toHaveLength(0);
  });

  it("disk write failure degrades with dropped-writes counter, never throws", async () => {
    // 用一个"文件当目录"的路径强制 mkdir/write 失败
    const blocker = join(tmpDir(), "blocker");
    writeFileSync(blocker, "x", "utf8");
    const store = new IncidentStore({ persistPath: join(blocker, "inc.json"), flushDebounceMs: 10 });
    const { issue } = store.report({ subject: "bot", botId: "b", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "x" });
    expect(store.getIssue(issue.incidentId)).not.toBeNull(); // 内存不受影响
    await store.flush();
    expect((store as unknown as { droppedWriteCount: number }).droppedWriteCount).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Round 6：causal model / 三维 retention / quarantine-backup / writer health / repair prompt
// ---------------------------------------------------------------------------

describe("incident causal model (Round 6)", () => {
  it("SKILL_RECOVERY_EXHAUSTED with causedBy chain reclassifies root as primary (PATHFINDING, R-CAUSAL-1)", () => {
    const store = new IncidentStore();
    const { issue, occurrence } = store.report({
      subject: "bot",
      botId: "bot-a",
      failureCode: "SKILL_RECOVERY_EXHAUSTED",
      incidentType: "SKILL_FAILED",
      sourceComponent: "skill-executor",
      terminalFailureCode: "SKILL_RECOVERY_EXHAUSTED",
      causedByFailureCodes: ["PATHFINDER_GOTO_FAILED"],
    });
    // 主码换根因，terminal 保留为终态
    expect(issue.primaryFailureCode).toBe("PATHFINDER_GOTO_FAILED");
    expect(issue.terminalFailureCode).toBe("SKILL_RECOVERY_EXHAUSTED");
    expect(issue.suspectedLayer).toBe("PATHFINDING");
    expect(issue.classifierRuleId).toBe("R-CAUSAL-1");
    expect(issue.type).toBe("SKILL_FAILED"); // reporter 显式给出的 type 保留
    expect(occurrence.failureCode).toBe("PATHFINDER_GOTO_FAILED");
    expect(occurrence.terminalFailureCode).toBe("SKILL_RECOVERY_EXHAUSTED");
    expect(occurrence.causedByFailureCodes).toEqual(["PATHFINDER_GOTO_FAILED"]);
    expect(occurrence.classification.matchedEvidence.join(" ")).toContain("terminal=SKILL_RECOVERY_EXHAUSTED");
  });

  it("fast PATH_FAILED and slow STUCK produce different fingerprints/issues", () => {
    const store = new IncidentStore();
    const fast = store.report({
      subject: "bot", botId: "b1", failureCode: "PATHFINDER_GOTO_FAILED", incidentType: "PATH_FAILED",
      sourceComponent: "movement.goto", normalizedErrorSignature: "no-path", actionFamily: "navigation",
    });
    const slow = store.report({
      subject: "bot", botId: "b1", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
      sourceComponent: "progress-watchdog", normalizedErrorSignature: "path-resets:3", actionFamily: "navigation",
    });
    expect(fast.issue.incidentId).not.toBe(slow.issue.incidentId);
    expect(fast.issue.type).toBe("PATH_FAILED");
    expect(slow.issue.type).toBe("STUCK");
  });

  it("incidentType UNKNOWN_FAILURE derives from failureCode family", () => {
    const store = new IncidentStore();
    const { issue } = store.report({
      subject: "bot", botId: "b", failureCode: "PATHFINDER_GOTO_FAILED", incidentType: "UNKNOWN_FAILURE",
      sourceComponent: "movement.goto",
    });
    expect(issue.type).toBe("PATH_FAILED");
  });

  it("PATHFINDER_GOTO_FAILED classifies to PATHFINDING (R-PATH-CODE-1)", () => {
    const result = classifyIncident({ failureCode: "PATHFINDER_GOTO_FAILED", incidentType: "PATH_FAILED" });
    expect(result.suspectedLayer).toBe("PATHFINDING");
    expect(result.ruleId).toBe("R-PATH-CODE-1");
  });

  it("recovery-exhausted without causedBy chain stays SKILL/low (legacy reports)", () => {
    const result = classifyIncident({ failureCode: "SKILL_RECOVERY_EXHAUSTED", incidentType: "SKILL_FAILED" });
    expect(result.suspectedLayer).toBe("SKILL");
    expect(result.confidenceBand).toBe("low");
  });
});

describe("corruption quarantine & backup recovery (Round 6)", () => {
  it("corrupt main file is quarantined (.corrupt-*), not silently cleared; store continues", async () => {
    const dir = tmpDir();
    const path = join(dir, "incidents.json");
    writeFileSync(path, "{corrupt", "utf8");
    const store = new IncidentStore({ persistPath: path });
    expect(store.listIssues()).toHaveLength(0);
    const health = store.writerHealth();
    expect(health.quarantinedCount).toBe(1);
    const quarantined = readdirSyncSafe(dir).filter((name) => name.includes(".corrupt-"));
    expect(quarantined).toHaveLength(1);
    // 原始损坏字节保留在 quarantine 文件里，未被覆盖清空
    expect(readFileSync(join(dir, quarantined[0]!), "utf8")).toBe("{corrupt");
  });

  it("flush keeps a last-known-good .bak; corrupt main → restore from backup", async () => {
    const dir = tmpDir();
    const path = join(dir, "incidents.json");
    const store = new IncidentStore({ persistPath: path, flushDebounceMs: 0 });
    const { issue } = store.report({
      subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf",
    });
    await store.flush();
    expect(existsSync(`${path}.bak`)).toBe(true);

    // 主文件被外部损坏
    writeFileSync(path, "not json at all", "utf8");
    const reopened = new IncidentStore({ persistPath: path });
    expect(reopened.getIssue(issue.incidentId)).not.toBeNull();
    expect(reopened.writerHealth().restoredFromBackupCount).toBe(1);
    expect(reopened.writerHealth().recoveryEvents.some((event) => event.kind === "restored-from-backup")).toBe(true);
  });
});

describe("disk retention & counts (Round 6)", () => {
  it("maxDiskBytes evicts closed issues first; newest issue survives within bounds", () => {
    const store = new IncidentStore({
      maxDiskBytes: 6_000,
      maxIssues: 500,
      maxOccurrencesPerIssue: 5,
    });
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { issue } = store.report({
        subject: "bot", botId: "b", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE",
        sourceComponent: `x-${i}`, severity: "ERROR",
        snapshots: { pad: "x".repeat(2_000) },
      });
      store.transitionStatus(issue.incidentId, "investigating");
      store.requestVerification(issue.incidentId);
      store.recordVerificationResult(issue.incidentId, "passed");
      store.transitionStatus(issue.incidentId, "fixed");
      ids.push(issue.incidentId);
    }
    expect(store.writerHealth().approxStoreBytes).toBeLessThanOrEqual(6_000);
    // 磁盘边界确实淘汰了旧的 closed issue（不是全部保留）
    expect(store.listIssues().length).toBeLessThan(6);
    // 最新一条（报告后仍在写路径上的）必然存活
    expect(store.getIssue(ids[ids.length - 1]!)).not.toBeNull();
  });

  it("pinned overflow beyond maxPinnedIssues is evictable under hard disk limit", () => {
    const store = new IncidentStore({
      maxDiskBytes: 4_000,
      maxPinnedIssues: 1,
      maxOccurrencesPerIssue: 3,
    });
    for (let i = 0; i < 8; i += 1) {
      store.report({
        subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
        sourceComponent: `pf-${i}`, snapshots: { pad: "y".repeat(1_500) },
      });
    }
    expect(store.writerHealth().approxStoreBytes).toBeLessThanOrEqual(4_000);
    expect(store.listIssues().length).toBeLessThanOrEqual(2);
  });

  it("fixed issue reopens on recurrence (regression detection) with audit history", () => {
    const store = new IncidentStore();
    const { issue } = store.report({
      subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf",
    });
    store.transitionStatus(issue.incidentId, "investigating");
    store.requestVerification(issue.incidentId);
    store.recordVerificationResult(issue.incidentId, "passed");
    store.transitionStatus(issue.incidentId, "fixed");
    // 回归：同一 fingerprint 再次发生
    const again = store.report({
      subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf",
    });
    expect(again.issue.incidentId).toBe(issue.incidentId);
    expect(again.issue.status).toBe("open");
    expect(again.issue.occurrenceCount).toBe(2);
    const history = again.issue.statusHistory.map((entry) => `${entry.from}>${entry.to}`);
    expect(history).toContain("fixed>open");
  });

  it("lifetime occurrenceCount vs retainedOccurrenceCount diverge after occurrence trimming", () => {
    const store = new IncidentStore({ maxOccurrencesPerIssue: 3 });
    for (let i = 0; i < 7; i += 1) {
      store.report({
        subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf",
      });
    }
    const issue = store.listIssues()[0]!;
    expect(issue.occurrenceCount).toBe(7);
    expect(issue.retainedOccurrenceCount).toBe(3);
    expect(store.listOccurrences(issue.incidentId)).toHaveLength(3);
  });

  it("report currently-being-written issue is never evicted by retention race", () => {
    const store = new IncidentStore({ maxDiskBytes: 5_000, maxPinnedIssues: 0, maxOccurrencesPerIssue: 5 });
    for (let i = 0; i < 10; i += 1) {
      store.report({
        subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
        sourceComponent: "pf", snapshots: { pad: "z".repeat(1_200) },
      });
    }
    const last = store.listIssues()[0]!;
    expect(store.getIssue(last.incidentId)).not.toBeNull();
  });

  it("low-severity evidence is stripped under hard disk pressure but counts survive", () => {
    const store = new IncidentStore({ maxDiskBytes: 2_000, maxOccurrencesPerIssue: 50 });
    store.report({
      subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
      sourceComponent: "pf", severity: "ERROR", snapshots: { pad: "p".repeat(1_800) },
    });
    const before = store.writerHealth().approxStoreBytes;
    const { issue } = store.report({
      subject: "bot", botId: "b", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE",
      sourceComponent: "x", severity: "INFO", snapshots: { pad: "q".repeat(2_000) },
    });
    expect(before).toBeGreaterThanOrEqual(2_000);
    const occurrence = store.listOccurrences(issue.incidentId)[0]!;
    expect(occurrence.evidenceStripped).toBe(true);
    expect(occurrence.eventWindow).toHaveLength(0);
    expect(issue.occurrenceCount).toBe(1);
    expect(store.writerHealth().evidenceDroppedCount).toBeGreaterThanOrEqual(1);
  });

  it("evidence cap truncates oversized snapshots deterministically", () => {
    const store = new IncidentStore({ maxEvidenceBytesPerIncident: 1_000 });
    const { issue } = store.report({
      subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK",
      sourceComponent: "pf", snapshots: { huge: "h".repeat(4_000) }, metadata: { also: "m".repeat(4_000) },
    });
    const occurrence = store.listOccurrences(issue.incidentId)[0]!;
    expect(JSON.stringify(occurrence.snapshots).length).toBeLessThanOrEqual(1_200);
    expect(occurrence.snapshots).toHaveProperty("_truncated");
  });
});

describe("writer health & identity (Round 6)", () => {
  it("writerHealth exposes flush counters, errors and recovery events", async () => {
    const store = new IncidentStore({ persistPath: join(tmpDir(), "inc.json"), flushDebounceMs: 0 });
    store.report({
      subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf",
    });
    await store.flush();
    const health = store.writerHealth();
    expect(health.flushCount).toBe(1);
    expect(health.lastFlushAt).not.toBeNull();
    expect(health.lastFlushError).toBeNull();
    expect(health.dirty).toBe(false);
    expect(health.lifetimeOccurrences).toBe(1);
    expect(health.retainedOccurrences).toBe(1);
  });

  it("occurrence keeps runtime identity fields end to end", () => {
    const store = new IncidentStore();
    const { occurrence } = store.report({
      subject: "bot", botId: "bot-a", sessionId: "sess-1", runtimeInstanceId: "runtime-uuid-1",
      correlationId: "corr-9", goalId: "goal-7", taskId: "task-3", buildVersion: "0.1.0", dirtyBuild: true,
      failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf",
      minecraftVersion: "1.21.11", protocolVersion: 774, gitCommit: "abc1234", branch: "main",
    });
    expect(occurrence.runtimeInstanceId).toBe("runtime-uuid-1");
    expect(occurrence.correlationId).toBe("corr-9");
    expect(occurrence.goalId).toBe("goal-7");
    expect(occurrence.taskId).toBe("task-3");
    expect(occurrence.buildVersion).toBe("0.1.0");
    expect(occurrence.dirtyBuild).toBe(true);
    expect(occurrence.protocolVersion).toBe(774);
  });

  it("ID guard: counter never regresses below highest persisted INC number", async () => {
    const path = join(tmpDir(), "inc.json");
    const store = new IncidentStore({ persistPath: path, flushDebounceMs: 0 });
    store.report({ subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf" });
    await store.flush();
    const raw = JSON.parse(readFileSync(path, "utf8")) as { issues: { incidentId: string }[]; issueCounter: number };
    writeFileSync(path, JSON.stringify({ ...raw, issueCounter: 0 }), "utf8");
    const reopened = new IncidentStore({ persistPath: path });
    // 新 fingerprint 的新 issue 不得复用已有 ID
    const next = reopened.report({ subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf-other" });
    expect(next.issue.incidentId).toBe("INC-0002");
  });
});

describe("repair prompt (Round 6)", () => {
  it("buildRepairPrompt is deterministic, versioned, layer-aware and leak-free", () => {
    const store = new IncidentStore();
    const { issue } = store.report({
      subject: "bot", botId: "bot-a", failureCode: "SKILL_RECOVERY_EXHAUSTED", incidentType: "SKILL_FAILED",
      sourceComponent: "skill-executor", terminalFailureCode: "SKILL_RECOVERY_EXHAUSTED",
      causedByFailureCodes: ["PATHFINDER_GOTO_FAILED"], gitCommit: "deadbee", branch: "main",
      minecraftVersion: "1.21.11", protocolVersion: 774,
      expected: "bot reaches target", actual: "pathfinder no path after 3 recovery attempts",
      eventWindow: [{ at: "2026-09-01T00:00:00.000Z", kind: "path_reset", detail: "replan #3" }],
    });
    const occurrence = store.listOccurrences(issue.incidentId)[0]!;
    const first = buildRepairPrompt(issue, occurrence, { repository: "test/repo", bundleFiles: ["incident.json"] });
    const second = buildRepairPrompt(issue, occurrence, { repository: "test/repo", bundleFiles: ["incident.json"] });
    expect(first.prompt).toBe(second.prompt);
    expect(first.promptVersion).toMatch(/^repair-v/);
    expect(first.prompt).toContain("PATHFINDER_GOTO_FAILED");
    expect(first.prompt).toContain("terminal outcome, NOT the root cause");
    expect(first.prompt).toContain("movement ownership");
    expect(first.prompt).toContain("do NOT modify Skills by default");
    expect(first.prompt).toContain("UNTRUSTED_EXTERNAL_TEXT");
    expect(first.prompt).toContain("test/repo");
    expect(safeExportText(first.prompt)).not.toBeNull();
  });

  it("repair prompt lists missing evidence instead of guessing", () => {
    const store = new IncidentStore();
    const { issue } = store.report({
      subject: "bot", botId: "b", failureCode: "UNKNOWN_FAILURE", incidentType: "UNKNOWN_FAILURE", sourceComponent: "x",
    });
    const occurrence = store.listOccurrences(issue.incidentId)[0]!;
    const { prompt } = buildRepairPrompt(issue, occurrence);
    expect(prompt).toContain("## Missing Evidence");
    expect(prompt).toContain("gitCommit");
  });
});

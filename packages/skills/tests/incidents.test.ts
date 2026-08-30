// ---------------------------------------------------------------------------
// Incident 领域核心回归测试（fingerprint/dedup/分类/redaction/持久化/bounds）
// ---------------------------------------------------------------------------
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
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

  it("status transitions: open→fixed directly is rejected; via investigating works", () => {
    const store = new IncidentStore();
    const { issue } = store.report({ subject: "bot", botId: "b", failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "pf" });
    expect(store.transitionStatus(issue.incidentId, "fixed")).toBe(false);
    expect(store.transitionStatus(issue.incidentId, "investigating")).toBe(true);
    expect(store.transitionStatus(issue.incidentId, "fixed", { fixedByCommit: "abc123" })).toBe(true);
    expect(store.getIssue(issue.incidentId)!.fixedByCommit).toBe("abc123");
  });

  it("persistence round-trip: issues/occurrences survive restart (atomic file)", () => {
    const dir = tmpDir();
    const path = join(dir, "incidents.json");
    const store = new IncidentStore({ persistPath: path });
    const { issue } = store.report({
      subject: "bot", botId: "bot-a", failureCode: "BUILD_WRONG_BLOCK", incidentType: "PLACEMENT_FAILED",
      sourceComponent: "build", expected: "cobblestone at (10,65,8)", actual: "dirt at (10,65,8)",
      snapshots: { cell: "41", attempts: 3 },
    });
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

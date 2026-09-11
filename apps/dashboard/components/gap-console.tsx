"use client";

// Gap Console（自我改善闭环 D4）——只读渲染 + 两个人审动作面：
//   1. gap → 开发 bundle 导出（export_only，draft release 停车）
//   2. release 的 canary/active/revoke operator 决策
// 展示纪律（capability honesty）：composition 建议/lesson 卡/证据计数全部
// 来自后端结构化数据；后端不可达如实显示 unavailable，不伪造空态。

import { useCallback, useEffect, useState } from "react";

import { Badge, Card, CardContent, CardHeader, CardTitle, DataTable, PageHeader } from "@/components/ui/primitives";

interface SkillGapView {
  fingerprint: string;
  kind: string;
  severity: string;
  occurrenceCount: number;
  actionFamily: string;
  terminalFailureCode: string;
  requestedSkillId: string | null;
  serverProfileId: string;
  lastSeenAtMs: number;
}

interface CompositionSuggestionView {
  fingerprint: string;
  skillIds: string[];
  rationale: string | null;
}

interface SkillReleaseView {
  releaseId: string;
  skillId: string;
  status: string;
  gapFingerprint: string;
  evidenceCount: number;
  updatedAtMs: number;
}

type ConsoleData =
  | { status: "ok"; gaps: SkillGapView[]; suggestions: CompositionSuggestionView[]; releases: SkillReleaseView[] }
  | { status: "not_configured" | "unreachable"; detail?: string }
  | { status: "loading" };

export function GapConsole() {
  const [data, setData] = useState<ConsoleData>({ status: "loading" });
  const [prompt, setPrompt] = useState<string | null>(null);
  const [operator, setOperator] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/studio/skill-gaps", { cache: "no-store" });
      const json = (await response.json()) as Exclude<ConsoleData, { status: "loading" }>;
      setData(json);
    } catch (error) {
      setData({ status: "unreachable", detail: error instanceof Error ? error.message : "unknown" });
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const createDraft = async (fingerprint: string) => {
    setBusy(fingerprint);
    setNotice(null);
    try {
      const response = await fetch("/api/studio/skill-releases", {
        method: "POST",
        headers: { "x-studio-action": "skill-release", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create-draft", gapFingerprint: fingerprint }),
      });
      const json = (await response.json()) as { status: string; releaseId?: string; implementationPrompt?: string; detail?: string };
      if (json.status === "ok") {
        setPrompt(json.implementationPrompt ?? "(no prompt returned)");
        setNotice(`draft release created: ${json.releaseId ?? "?"}`);
      } else {
        setNotice(`创建失败：${json.detail ?? json.status}`);
      }
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  const decide = async (releaseId: string, decision: "promote-canary" | "promote-active" | "revoke") => {
    if (operator.trim().length === 0) {
      setNotice("审批需要先填写 operator 名（人审证据）。");
      return;
    }
    setBusy(`${releaseId}:${decision}`);
    setNotice(null);
    try {
      const response = await fetch("/api/studio/skill-releases", {
        method: "POST",
        headers: { "x-studio-action": "skill-release", "Content-Type": "application/json" },
        body: JSON.stringify({ action: "operator-decision", releaseId, decision, operator: operator.trim() }),
      });
      const json = (await response.json()) as { status: string; releaseStatus?: string; detail?: string };
      setNotice(json.status === "ok" ? `release ${releaseId.slice(0, 16)} → ${json.releaseStatus}` : `决策被拒：${json.detail ?? json.status}`);
      await refresh();
    } finally {
      setBusy(null);
    }
  };

  if (data.status === "loading") {
    return <p className="text-subtle-foreground">加载中…</p>;
  }
  if (data.status !== "ok") {
    return (
      <Card>
        <CardContent>
          <p className="text-red-400">Shared State {data.status === "not_configured" ? "未配置" : "不可达"}</p>
          {data.detail ? <p className="text-sm text-muted-foreground">{data.detail}</p> : null}
          <p className="text-sm text-muted-foreground">gap/lesson/release 数据来自 Coordinator Shared State（需 STUDIO_SHARED_STATE_URL/TOKEN）。</p>
        </CardContent>
      </Card>
    );
  }

  const suggestionByFingerprint = new Map(data.suggestions.map((s) => [s.fingerprint, s]));

  return (
    <div className="space-y-4">
      {notice ? <p className="text-sm text-sky-400" data-testid="gap-console-notice">{notice}</p> : null}

      <Card>
        <CardHeader>
          <CardTitle>Skill Gaps（{data.gaps.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          {data.gaps.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="gap-empty">暂无 gap：任务失败终态会自动分类入册（证据门槛：catalog 依赖型结论必须有具名技能）。</p>
          ) : (
            <DataTable>
              <thead>
                <tr>
                  <th>Kind</th><th>失败码</th><th>动作族</th><th>次数</th><th>服务器</th><th>Composition 建议</th><th></th>
                </tr>
              </thead>
              <tbody>
                {data.gaps.map((gap) => {
                  const suggestion = suggestionByFingerprint.get(gap.fingerprint);
                  return (
                    <tr key={gap.fingerprint} data-testid={`gap-row-${gap.fingerprint.slice(0, 8)}`}>
                      <td><Badge tone="info">{gap.kind}</Badge></td>
                      <td className="font-mono text-xs">{gap.terminalFailureCode}</td>
                      <td>{gap.actionFamily}{gap.requestedSkillId ? ` (${gap.requestedSkillId})` : ""}</td>
                      <td>{gap.occurrenceCount}</td>
                      <td className="font-mono text-xs">{gap.serverProfileId}</td>
                      <td className="text-xs">
                        {suggestion && suggestion.skillIds.length > 0
                          ? `先组合：${suggestion.skillIds.join(", ")}`
                          : "—（真缺能力）"}
                      </td>
                      <td>
                        <button
                          type="button"
                          className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50"
                          disabled={busy === gap.fingerprint}
                          onClick={() => void createDraft(gap.fingerprint)}
                        >
                          导出开发 bundle
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Skill Releases（{data.releases.length}）</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="mb-3 flex items-center gap-2">
            <label className="text-xs text-subtle-foreground" htmlFor="gap-operator">operator（人审签名）</label>
            <input
              id="gap-operator"
              className="rounded border border-border bg-background px-2 py-1 text-sm"
              value={operator}
              onChange={(event) => setOperator(event.target.value)}
              placeholder="renna"
              maxLength={64}
            />
          </div>
          {data.releases.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无 release：从上方 gap 导出开发 bundle 后出现（draft → sandboxed → verified 自动，canary/active 人审）。</p>
          ) : (
            <DataTable>
              <thead>
                <tr><th>Release</th><th>技能</th><th>状态</th><th>证据</th><th></th></tr>
              </thead>
              <tbody>
                {data.releases.map((release) => (
                  <tr key={release.releaseId} data-testid={`release-row-${release.releaseId.slice(0, 12)}`}>
                    <td className="font-mono text-xs">{release.releaseId.slice(0, 16)}</td>
                    <td>{release.skillId}</td>
                    <td><Badge tone={release.status === "active" ? "online" : release.status === "canary" ? "info" : release.status === "verified" ? "degraded" : "neutral"}>{release.status}</Badge></td>
                    <td>{release.evidenceCount} 条</td>
                    <td className="space-x-1">
                      {release.status === "verified" ? (
                        <button type="button" className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={busy !== null} onClick={() => void decide(release.releaseId, "promote-canary")}>升 canary</button>
                      ) : null}
                      {release.status === "canary" ? (
                        <button type="button" className="rounded border border-border px-2 py-1 text-xs disabled:opacity-50" disabled={busy !== null} onClick={() => void decide(release.releaseId, "promote-active")}>转正 active</button>
                      ) : null}
                      {release.status !== "revoked" ? (
                        <button type="button" className="rounded border border-border px-2 py-1 text-xs text-red-400 disabled:opacity-50" disabled={busy !== null} onClick={() => void decide(release.releaseId, "revoke")}>吊销</button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          )}
        </CardContent>
      </Card>

      {prompt ? (
        <Card>
          <CardHeader>
            <CardTitle>实施提示词（复制给人 / Codex 实现）</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-80 overflow-auto rounded border border-border bg-muted/40 p-3 text-xs whitespace-pre-wrap" data-testid="gap-implementation-prompt">{prompt}</pre>
            <button type="button" className="mt-2 rounded border border-border px-2 py-1 text-xs" onClick={() => setPrompt(null)}>关闭</button>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

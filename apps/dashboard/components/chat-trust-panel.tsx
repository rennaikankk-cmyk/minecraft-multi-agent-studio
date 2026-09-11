"use client";

// 白名单（Chat Trust）管理面板：读写 manager /v1/chat-trust（与 coordinator
// 同一配置文件）。保存后需重启 Studio 生效——旁边就是重启按钮。

import { useCallback, useEffect, useState } from "react";

import { Badge, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";

interface TrustPolicy {
  serverProfileId: string;
  worldId: string | null;
  revision: number;
  authMode: "online" | "offline";
  usernames: string[];
  uuids: string[];
  offlineTrust: "disabled" | "server-player-list";
  allowUnsignedOnline: boolean;
}

type LoadState =
  | { status: "loading" }
  | { status: "ok"; policies: TrustPolicy[]; path: string }
  | { status: "unavailable"; detail?: string };

export function ChatTrustPanel() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const response = await fetch("/api/studio/chat-trust", { cache: "no-store" });
      const body = (await response.json()) as { policies?: TrustPolicy[]; path?: string; detail?: string };
      if (!response.ok) {
        setState({ status: "unavailable", detail: body.detail ?? `HTTP ${response.status}` });
        return;
      }
      setState({ status: "ok", policies: body.policies ?? [], path: body.path ?? "" });
    } catch (error) {
      setState({ status: "unavailable", detail: error instanceof Error ? error.message : "unknown" });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async (policies: TrustPolicy[]) => {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/studio/chat-trust", {
        method: "PUT",
        headers: { "Content-Type": "application/json", "x-studio-action": "chat-trust" },
        body: JSON.stringify(policies.map((policy) => ({ schemaVersion: "1.0", ...policy }))),
      });
      const body = (await response.json().catch(() => null)) as { saved?: number; detail?: string } | null;
      if (!response.ok) {
        setMessage(`保存失败：${body?.detail ?? `HTTP ${response.status}`}`);
        return;
      }
      setMessage(`已保存 ${body?.saved ?? policies.length} 条策略。重启 Studio 后生效（右上按钮）。`);
      await load();
    } finally {
      setBusy(false);
    }
  }, [load]);

  if (state.status === "loading") {
    return <p className="text-sm text-subtle-foreground">白名单加载中…</p>;
  }
  if (state.status === "unavailable") {
    return <p className="text-sm text-red-400">白名单接口不可用：{state.detail ?? "manager 未响应"}</p>;
  }

  const policies = state.policies;

  const updatePolicy = (index: number, patch: Partial<TrustPolicy>) => {
    setState({ ...state, policies: policies.map((policy, i) => (i === index ? { ...policy, ...patch } : policy)) });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>白名单（Chat Trust · 聊天指挥与友军识别）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-xs text-subtle-foreground">
          文件：<span className="data-mono">{state.path}</span>。UUID 白名单是权威（在线服冒名不救）；离线服可切换 server-player-list 信任。
        </p>
        {policies.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="chat-trust-empty">尚无策略；为每个服务器添加一条。</p>
        ) : (
          policies.map((policy, index) => (
            <div key={`${policy.serverProfileId}:${policy.worldId ?? ""}`} className="space-y-2 rounded-[8px] border border-border-subtle bg-elevated p-3" data-testid={`chat-trust-policy-${index}`}>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  className="w-52 data-mono"
                  value={policy.serverProfileId}
                  aria-label="server-profile"
                  onChange={(event) => updatePolicy(index, { serverProfileId: event.target.value })}
                />
                <Input
                  className="w-36 data-mono"
                  value={policy.worldId ?? ""}
                  placeholder="worldId（可空）"
                  aria-label="world-id"
                  onChange={(event) => updatePolicy(index, { worldId: event.target.value.length === 0 ? null : event.target.value })}
                />
                <select
                  className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                  value={policy.authMode}
                  aria-label="auth-mode"
                  onChange={(event) => updatePolicy(index, { authMode: event.target.value as TrustPolicy["authMode"] })}
                >
                  <option value="online">online（正版）</option>
                  <option value="offline">offline（离线服）</option>
                </select>
                {policy.authMode === "offline" ? (
                  <select
                    className="rounded border border-border bg-background px-2 py-1.5 text-sm"
                    value={policy.offlineTrust}
                    aria-label="offline-trust"
                    onChange={(event) => updatePolicy(index, { offlineTrust: event.target.value as TrustPolicy["offlineTrust"] })}
                  >
                    <option value="disabled">离线信任关闭</option>
                    <option value="server-player-list">信任服务器玩家列表</option>
                  </select>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setState({ ...state, policies: policies.filter((_, i) => i !== index) })}
                  aria-label="删除策略"
                >
                  删除
                </Button>
              </div>
              <label className="flex flex-col gap-1 text-xs text-subtle-foreground">
                用户名白名单（逗号分隔）
                <Input
                  className="data-mono"
                  value={policy.usernames.join(",")}
                  aria-label="usernames"
                  onChange={(event) => updatePolicy(index, { usernames: event.target.value.split(",").map((name) => name.trim()).filter((name) => name.length > 0) })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-subtle-foreground">
                UUID 白名单（逗号分隔，权威）
                <Input
                  className="data-mono"
                  value={policy.uuids.join(",")}
                  aria-label="uuids"
                  onChange={(event) => updatePolicy(index, { uuids: event.target.value.split(",").map((uuid) => uuid.trim()).filter((uuid) => uuid.length > 0) })}
                />
              </label>
            </div>
          ))
        )}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setState({
              ...state,
              policies: [...policies, {
                serverProfileId: "profile-a", worldId: null, revision: 1, authMode: "online",
                usernames: [], uuids: [], offlineTrust: "disabled", allowUnsignedOnline: false,
              }],
            })}
            data-testid="chat-trust-add"
          >
            添加策略
          </Button>
          <Button size="sm" disabled={busy} onClick={() => void save(policies)} data-testid="chat-trust-save">
            保存全部
          </Button>
          {message ? <span className="text-xs text-sky-400" data-testid="chat-trust-message">{message}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}

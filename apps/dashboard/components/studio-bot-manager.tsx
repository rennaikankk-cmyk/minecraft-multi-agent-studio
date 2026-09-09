"use client";

// 创建本地 Bot（manager 档案 + 槽位）——已迁移到 v4 primitives 体系。
// 逻辑与旧版完全一致（同一 manager API/动作头），仅视觉层从 gen2 类迁移。
import {
  studioManagedBotResponseV1Schema,
  studioManagerErrorV1Schema,
  studioManagerStatusV1Schema,
  type StudioManagedBotV1,
  type StudioManagerStatusV1,
} from "@minecraft-studio/protocol";
import { Bot, RefreshCw } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { useBotStore } from "@/stores/bot-store";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Badge,
  DataTable,
  Input,
  Skeleton,
  Td,
  Th,
} from "@/components/ui/primitives";

const POLL_INTERVAL_MS = 3_000;

const processLabels: Record<StudioManagedBotV1["processState"], string> = {
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  error: "异常",
};

const processTones: Record<StudioManagedBotV1["processState"], "online" | "starting" | "warning" | "neutral" | "failed"> = {
  starting: "starting",
  running: "online",
  stopping: "warning",
  stopped: "neutral",
  error: "failed",
};

const connectionLabels = {
  connecting: "连接中",
  online: "在线",
  stopping: "停止中",
  offline: "离线",
  stale: "失联",
  error: "异常",
} as const;

const connectionTones: Record<string, "online" | "starting" | "warning" | "neutral" | "failed"> = {
  connecting: "starting",
  online: "online",
  stopping: "warning",
  offline: "neutral",
  stale: "warning",
  error: "failed",
};

export function StudioBotManager() {
  const telemetryBots = useBotStore((state) => state.bots);
  const [status, setStatus] = useState<StudioManagerStatusV1 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [username, setUsername] = useState("StudioBot1");
  const [accountRef, setAccountRef] = useState("");
  const [serverHost, setServerHost] = useState("127.0.0.1");
  const [serverPort, setServerPort] = useState("25565");
  const [worldId, setWorldId] = useState("");
  const [minecraftVersion, setMinecraftVersion] = useState("auto");
  const [auth, setAuth] = useState<"offline" | "online">("offline");
  const [purpose, setPurpose] = useState<"managed" | "anarchy">("managed");
  const [submitting, setSubmitting] = useState(false);
  const [restartingBotId, setRestartingBotId] = useState<string | null>(null);
  const [deletingBotId, setDeletingBotId] = useState<string | null>(null);
  const [confirmDeleteBotId, setConfirmDeleteBotId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/studio/status", { cache: "no-store" });
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Studio Manager 不可用。");
      const parsed = studioManagerStatusV1Schema.safeParse(value);
      if (!parsed.success) throw new Error("Studio Manager 返回了无效数据。");
      setStatus(parsed.data);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Studio Manager 不可用。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const telemetryById = useMemo(
    () => new Map(telemetryBots.map((bot) => [bot.botId, bot])),
    [telemetryBots],
  );

  const createBot = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setActionMessage(null);
    try {
      const port = Number(serverPort);
      const response = await fetch("/api/studio/bots", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Action": "create-bot",
        },
        body: JSON.stringify({
          schemaVersion: "1.0",
          ...(auth === "offline" ? { username } : { accountRef }),
          serverHost,
          serverPort: port,
          ...(worldId.trim() ? { worldId: worldId.trim() } : {}),
          minecraftVersion,
          auth,
          ...(purpose === "anarchy" ? { purpose: "anarchy" } : {}),
        }),
      });
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Bot 创建失败。");
      const parsed = studioManagedBotResponseV1Schema.safeParse(value);
      if (!parsed.success) throw new Error("Bot 创建接口返回了无效数据。");
      setActionMessage({ tone: "ok", text: `${parsed.data.bot.botId} 已创建并启动。` });
      setUsername(`StudioBot${Math.min(16, (status?.bots.length ?? 0) + 2)}`);
      await Promise.all([refresh(), useBotStore.getState().refresh()]);
    } catch (cause) {
      setActionMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Bot 创建失败。" });
    } finally {
      setSubmitting(false);
    }
  };

  const restartBot = async (botId: string) => {
    setRestartingBotId(botId);
    setActionMessage(null);
    try {
      const response = await fetch(
        `/api/studio/bots/${encodeURIComponent(botId)}/restart`,
        { method: "POST", headers: { "X-Studio-Action": "restart-bot" } },
      );
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Bot 重启失败。");
      const parsed = studioManagedBotResponseV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.bot.botId !== botId) {
        throw new Error("Bot 重启接口返回了无效数据。");
      }
      setActionMessage({ tone: "ok", text: `${botId} 已重新启动。` });
      await refresh();
    } catch (cause) {
      setActionMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Bot 重启失败。" });
    } finally {
      setRestartingBotId(null);
    }
  };

  const deleteBot = async (botId: string) => {
    setDeletingBotId(botId);
    setActionMessage(null);
    try {
      const response = await fetch(
        `/api/studio/bots/${encodeURIComponent(botId)}`,
        { method: "DELETE", headers: { "X-Studio-Action": "delete-bot" } },
      );
      const value = (await response.json()) as unknown;
      if (!response.ok) throw managerResponseError(value, "Bot 删除失败。");
      setConfirmDeleteBotId(null);
      setActionMessage({ tone: "ok", text: `${botId} 已删除，槽位已释放。` });
      await Promise.all([refresh(), useBotStore.getState().refresh()]);
    } catch (cause) {
      setActionMessage({ tone: "error", text: cause instanceof Error ? cause.message : "Bot 删除失败。" });
    } finally {
      setDeletingBotId(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-4 text-primary" />
          创建本地 Bot
          {status ? (
            <Badge tone={error ? "failed" : "info"}>
              {status.bots.length}/{status.capabilities.maxBots} 个槽位
            </Badge>
          ) : loading ? (
            <Badge tone="unknown">连接中</Badge>
          ) : (
            <Badge tone="failed">Manager 不可用</Badge>
          )}
        </CardTitle>
        <Button variant="ghost" size="icon" aria-label="刷新" onClick={() => void refresh()}>
          <RefreshCw />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="grid gap-3 md:grid-cols-3" onSubmit={(event) => void createBot(event)}>
          <Field label="连接目标">
            <select
              className="h-9 w-full rounded-[6px] border border-border-subtle bg-background px-2.5 text-[12.5px] text-foreground"
              value={purpose}
              onChange={(event) => setPurpose(event.target.value as "managed" | "anarchy")}
            >
              <option value="managed">本地 / 局域网服务器</option>
              <option value="anarchy">外部公网服务器（无规则服）</option>
            </select>
          </Field>
          <Field label="登录方式">
            <select
              className="h-9 w-full rounded-[6px] border border-border-subtle bg-background px-2.5 text-[12.5px] text-foreground"
              value={auth}
              onChange={(event) => setAuth(event.target.value as "offline" | "online")}
            >
              <option value="offline">离线登录</option>
              <option value="online">正版在线登录</option>
            </select>
          </Field>
          {auth === "offline" ? (
            <Field label="离线用户名 / BotID">
              <Input
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                minLength={3}
                maxLength={16}
                pattern="[A-Za-z0-9_]+"
                required
                autoComplete="off"
              />
            </Field>
          ) : (
            <Field label="已配置的正版账号引用">
              <Input
                value={accountRef}
                onChange={(event) => setAccountRef(event.target.value)}
                maxLength={64}
                pattern={"[A-Za-z0-9][A-Za-z0-9_\\-]*"}
                required
                autoComplete="off"
                placeholder="例如 account-one"
              />
            </Field>
          )}
          <Field label={purpose === "anarchy" ? "服务器地址（公网域名或 IP）" : "服务器地址"}>
            <Input
              value={serverHost}
              onChange={(event) => setServerHost(event.target.value)}
              maxLength={253}
              required
              autoComplete="off"
              placeholder={purpose === "anarchy" ? "例如 luv.mc6.cn" : "127.0.0.1"}
            />
          </Field>
          <Field label="端口">
            <Input
              type="number"
              value={serverPort}
              onChange={(event) => setServerPort(event.target.value)}
              min={1}
              max={65535}
              required
            />
          </Field>
          <Field label="Minecraft 版本">
            <Input
              value={minecraftVersion}
              onChange={(event) => setMinecraftVersion(event.target.value)}
              pattern="auto|[0-9]+\.[0-9]+(\.[0-9]+)?"
              required
              autoComplete="off"
            />
          </Field>
          <Field label="世界存档标识（可选）">
            <Input
              value={worldId}
              onChange={(event) => setWorldId(event.target.value)}
              maxLength={128}
              pattern={"[A-Za-z0-9][A-Za-z0-9._:\\-]*"}
              autoComplete="off"
              placeholder="未知时留空；重置存档后更换"
            />
          </Field>
          <div className="flex items-end">
            <Button type="submit" disabled={submitting || !status?.capabilities.createBot} className="w-full md:w-auto">
              {submitting ? "创建中…" : "创建并启动"}
            </Button>
          </div>
        </form>

        {auth === "online" ? (
          <p className="text-[11.5px] text-subtle-foreground">
            验证正版账号后，自动使用真实游戏用户名作为 BotID。账号凭据由本机管理。
          </p>
        ) : (
          <p className="text-[11.5px] text-subtle-foreground">
            离线用户名即 BotID。每个 Bot 在各服务器的背包、出生点和个人状态单独记录。
          </p>
        )}
        {purpose === "anarchy" ? (
          <p className="text-[11.5px] text-warning">
            外部公网模式：按章程 ANARCHY_FIRST 运行（unknown 玩家视为敌对、导航默认沿途挖掘/疾跑档）。仅连接你有权使用的服务器。
          </p>
        ) : null}

        {error ? (
          <div className="rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2 text-[12.5px] text-danger" role="alert">
            {error}
          </div>
        ) : null}
        {actionMessage ? (
          <div
            className={`rounded-[6px] border px-3 py-2 text-[12.5px] ${
              actionMessage.tone === "ok"
                ? "border-success/30 bg-success/10 text-success"
                : "border-danger/30 bg-danger/10 text-danger"
            }`}
            role="status"
          >
            {actionMessage.text}
          </div>
        ) : null}

        {status?.bots.length ? (
          <DataTable>
            <thead>
              <tr>
                <Th>Bot</Th>
                <Th>服务器</Th>
                <Th>Runtime</Th>
                <Th>遥测</Th>
                <Th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {status.bots.map((bot) => {
                const telemetry = telemetryById.get(bot.botId);
                return (
                  <tr key={bot.botId}>
                    <Td>
                      <div className="font-medium">{bot.username}</div>
                      <div className="data-mono text-[11px] text-subtle-foreground">{bot.botId}</div>
                      {bot.lastError ? (
                        <div className="text-[11px] text-danger">{bot.lastError}</div>
                      ) : null}
                    </Td>
                    <Td>
                      <div className="data-mono">{bot.serverHost}:{bot.serverPort}</div>
                      <div className="text-[11px] text-subtle-foreground">
                        {bot.minecraftVersion}
                        {bot.purpose === "anarchy" ? " · 无规则服" : ""}
                      </div>
                    </Td>
                    <Td>
                      <Badge tone={processTones[bot.processState]}>{processLabels[bot.processState]}</Badge>
                      {bot.pid ? <div className="mt-1 text-[11px] text-subtle-foreground">PID {bot.pid}</div> : null}
                    </Td>
                    <Td>
                      {telemetry ? (
                        <Badge tone={connectionTones[telemetry.connectionState] ?? "neutral"}>
                          {connectionLabels[telemetry.connectionState]}
                        </Badge>
                      ) : bot.processState === "running" ? (
                        <Badge tone="unknown">等待遥测</Badge>
                      ) : (
                        <Badge tone="neutral">未连接</Badge>
                      )}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => void restartBot(bot.botId)}
                          disabled={restartingBotId !== null}
                        >
                          {restartingBotId === bot.botId ? "重启中…" : "重启"}
                        </Button>
                        {bot.processState === "stopped" ? (
                          confirmDeleteBotId === bot.botId ? (
                            <Button
                              size="sm"
                              variant="destructive"
                              onClick={() => void deleteBot(bot.botId)}
                              disabled={deletingBotId !== null}
                            >
                              {deletingBotId === bot.botId ? "删除中…" : "确认删除"}
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmDeleteBotId(bot.botId)}
                              disabled={deletingBotId !== null}
                            >
                              删除
                            </Button>
                          )
                        ) : null}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </DataTable>
        ) : status && !error ? (
          <div className="rounded-[6px] border border-border-subtle bg-elevated px-3 py-6 text-center text-[12.5px] text-subtle-foreground">
            尚未创建本地 Bot。
          </div>
        ) : !status ? (
          <Skeleton className="h-20 w-full" />
        ) : null}
      </CardContent>
    </Card>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label className="text-[11.5px] font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

function managerResponseError(value: unknown, fallback: string): Error {
  const parsed = studioManagerErrorV1Schema.safeParse(value);
  return new Error(parsed.success ? parsed.data.error.message : fallback);
}

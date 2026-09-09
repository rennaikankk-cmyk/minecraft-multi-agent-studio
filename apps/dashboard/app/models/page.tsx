"use client";

// 模型与 API 页 —— 统一的推理接入面：本地推理（vLLM / Ollama / DGX Spark）、
// OpenAI 兼容云端 API（GLM Coding Plan / DeepSeek 等）与第三方中转站。
// 档案持久化在 Studio Manager（runtime-data/ai-providers.json，密钥 0600 落盘、
// API 响应只回 hasApiKey）；「激活」把所选档案写入 .env.local 的托管键段，
// 重启 Studio 后对协调器全面生效 —— 页面如实标注，不假装热切换。
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Boxes,
  Cloud,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Server,
  Sparkles,
  Trash2,
  Waypoints,
  Zap,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  PageHeader,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Badge,
  Input,
  Skeleton,
  UiEmptyState,
  UiErrorState,
} from "@/components/ui/primitives";
import { SparkStatusBadge } from "@/components/ui/spark-status";

interface AiStatusView {
  state: "connected" | "degraded" | "unavailable" | "misconfigured" | "disabled" | string;
  source: string;
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  models: string[];
  latencyMs: number | null;
  lastCheckedAt: string;
  message: string;
}

interface ProviderProfileView {
  id: string;
  name: string;
  type: "local-vllm" | "local-ollama" | "openai-compatible";
  baseUrl: string;
  model: string | null;
  hasApiKey: boolean;
  structuredOutput: string;
}

type FormState = {
  id: string | null;
  name: string;
  type: ProviderProfileView["type"];
  baseUrl: string;
  model: string;
  apiKey: string;
  structuredOutput: string;
};

const EMPTY_FORM: FormState = {
  id: null,
  name: "",
  type: "openai-compatible",
  baseUrl: "",
  model: "",
  apiKey: "",
  structuredOutput: "none",
};

const TYPE_META: Record<
  ProviderProfileView["type"],
  { label: string; icon: typeof Server; tone: "localtest" | "manual" | "ai"; hint: string }
> = {
  "local-vllm": {
    label: "本地 vLLM",
    icon: Server,
    tone: "localtest",
    hint: "DGX Spark / 自托管 vLLM 推理，URL-only 时按 /v1/models 发现选型",
  },
  "local-ollama": {
    label: "本地 Ollama",
    icon: Boxes,
    tone: "manual",
    hint: "Ollama 守护进程，模型经 /api/tags 发现",
  },
  "openai-compatible": {
    label: "云端 / 中转 API",
    icon: Cloud,
    tone: "ai",
    hint: "OpenAI 兼容 Chat Completions：GLM Coding Plan、DeepSeek、第三方中转站等",
  },
};

const PRESETS: readonly {
  key: string;
  label: string;
  form: Partial<FormState> & { type: ProviderProfileView["type"] };
  note?: string;
}[] = [
  {
    key: "glm",
    label: "GLM 开放平台 / Coding Plan",
    form: { type: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/paas/v4", model: "" },
    note: "Coding Plan 订阅请按智谱文档核对端点路径与套餐模型名",
  },
  {
    key: "deepseek",
    label: "DeepSeek",
    form: { type: "openai-compatible", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  },
  {
    key: "relay",
    label: "第三方中转站",
    form: { type: "openai-compatible", baseUrl: "", model: "" },
    note: "填中转站给的 Base URL（支持带路径前缀）与模型名",
  },
  {
    key: "spark",
    label: "本地 DGX Spark",
    form: { type: "local-vllm", baseUrl: "http://192.168.100.2:18300", model: "" },
    note: "局域网推理节点；模型留空 = 启动时自动发现",
  },
];

export default function ModelsPage() {
  const [status, setStatus] = useState<AiStatusView | null>(null);
  const [profiles, setProfiles] = useState<ProviderProfileView[] | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pending, setPending] = useState(false);
  const [form, setForm] = useState<FormState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setPending(true);
    try {
      const [statusResponse, providersResponse] = await Promise.all([
        fetch("/api/studio/status", { cache: "no-store" }),
        fetch("/api/studio/ai-providers", { cache: "no-store" }),
      ]);
      const statusBody = await statusResponse.json();
      if (statusBody?.ai) setStatus(statusBody.ai as AiStatusView);
      if (providersResponse.ok) {
        const body = await providersResponse.json();
        setProfiles(Array.isArray(body?.profiles) ? body.profiles : []);
        setActiveProfileId(body?.activeProfileId ?? null);
        setLoadError(null);
      } else {
        setProfiles([]);
        setLoadError(`HTTP ${providersResponse.status}`);
      }
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "unknown");
    } finally {
      setLoaded(true);
      setPending(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(timer);
  }, [refresh]);

  const saveForm = useCallback(
    async (submit: FormState) => {
      setBusyId(submit.id ?? "new");
      try {
        const response = await fetch("/api/studio/ai-providers", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-studio-action": "ai-provider-save" },
          body: JSON.stringify({
            id: submit.id ?? undefined,
            name: submit.name,
            type: submit.type,
            baseUrl: submit.baseUrl,
            model: submit.model,
            ...(submit.apiKey.trim() ? { apiKey: submit.apiKey.trim() } : {}),
            ...(submit.type === "openai-compatible" ? { structuredOutput: submit.structuredOutput } : {}),
          }),
        });
        const body = await response.json();
        if (!response.ok) {
          setNotice({ tone: "error", text: body?.error?.message ?? `保存失败（HTTP ${response.status}）` });
          return;
        }
        setForm(null);
        setNotice({ tone: "ok", text: `已保存「${body?.name ?? submit.name}」。` });
        await refresh();
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "保存失败" });
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const activate = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const response = await fetch("/api/studio/ai-providers/activate", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-studio-action": "ai-provider-activate" },
          body: JSON.stringify({ id }),
        });
        const body = await response.json();
        if (!response.ok) {
          setNotice({ tone: "error", text: body?.error?.message ?? `激活失败（HTTP ${response.status}）` });
          return;
        }
        setNotice({
          tone: "ok",
          text: "已写入 .env.local。重启 Studio（关闭 Studio Services 窗口后重新双击启动器）后对协调器全面生效。",
        });
        await refresh();
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "激活失败" });
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      setBusyId(id);
      try {
        const response = await fetch(`/api/studio/ai-providers?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: { "x-studio-action": "ai-provider-delete" },
        });
        if (!response.ok) {
          const body = await response.json().catch(() => null);
          setNotice({ tone: "error", text: body?.error?.message ?? `删除失败（HTTP ${response.status}）` });
          return;
        }
        setConfirmDeleteId(null);
        setNotice({ tone: "ok", text: "档案已删除（不影响已写入的 .env.local）。" });
        await refresh();
      } catch (error) {
        setNotice({ tone: "error", text: error instanceof Error ? error.message : "删除失败" });
      } finally {
        setBusyId(null);
      }
    },
    [refresh],
  );

  const activeProfile = useMemo(
    () => profiles?.find((profile) => profile.id === activeProfileId) ?? null,
    [profiles, activeProfileId],
  );

  return (
    <div className="space-y-4">
      <PageHeader eyebrow="INTELLIGENCE · MODELS & API" title="模型与 API">
        统一的推理接入面：本地推理节点、OpenAI 兼容云端 API（GLM Coding Plan / DeepSeek 等）与第三方中转站。
        激活 = 写入 .env.local 托管键段，重启 Studio 后生效。
      </PageHeader>

      {!loaded ? (
        <Skeleton className="h-64 w-full" />
      ) : (
        <>
          {/* 当前连接 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="size-4 text-ai" />
                当前连接
                {activeProfile ? (
                  <Badge tone="ai">{activeProfile.name}</Badge>
                ) : null}
              </CardTitle>
              <div className="flex items-center gap-2">
                {status ? <SparkStatusBadge state={status.state} /> : null}
                <Button variant="ghost" size="icon" aria-label="刷新" onClick={() => void refresh()} disabled={pending}>
                  <RefreshCw className={pending ? "animate-spin" : undefined} />
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              {loadError && !status ? (
                <UiErrorState title="AI 状态不可用" detail={loadError} />
              ) : !status || status.state === "disabled" ? (
                <UiEmptyState
                  title="未配置模型接入"
                  hint="在下方新建供应商档案并激活；也可直接编辑 .env.local（AI_BASE_URL / LOCAL_AI_HUB_URL）。"
                />
              ) : (
                <div className="space-y-3">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <StatusStat label="模型" value={status.model ?? "—"} mono />
                    <StatusStat label="探测延迟" value={status.latencyMs !== null ? `${status.latencyMs} ms` : "—"} />
                    <StatusStat label="上次探测" value={status.lastCheckedAt || "—"} />
                    <StatusStat label="Provider" value={status.provider ?? "—"} mono />
                  </div>
                  {status.baseUrl ? (
                    <div className="data-mono truncate rounded-[6px] border border-border-subtle bg-elevated px-3 py-2 text-[12px] text-muted-foreground">
                      {status.baseUrl}
                    </div>
                  ) : null}
                  {status.message ? (
                    <p className="text-[12px] leading-relaxed text-subtle-foreground">{status.message}</p>
                  ) : null}
                  {status.models.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5">
                      {status.models.map((model) => (
                        <span
                          key={model}
                          className="data-mono rounded-[5px] border border-border-subtle bg-elevated px-2 py-0.5 text-[11px]"
                        >
                          {model}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>

          {notice ? (
            <div
              className={`flex items-start gap-2 rounded-[8px] border px-3 py-2 text-[12.5px] leading-relaxed ${
                notice.tone === "ok"
                  ? "border-success/30 bg-success/10 text-success"
                  : "border-danger/30 bg-danger/10 text-danger"
              }`}
            >
              <span className="mt-0.5">{notice.tone === "ok" ? "✓" : "✕"}</span>
              <span className="flex-1">{notice.text}</span>
              <button className="text-subtle-foreground hover:text-foreground" onClick={() => setNotice(null)}>
                关闭
              </button>
            </div>
          ) : null}

          {/* 供应商档案 */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Waypoints className="size-4 text-primary" />
                供应商档案
                {profiles ? (
                  <span className="text-[11.5px] font-normal text-subtle-foreground">{profiles.length} 个</span>
                ) : null}
              </CardTitle>
              <Button size="sm" onClick={() => setForm({ ...EMPTY_FORM })} disabled={form !== null}>
                <Plus className="mr-1" /> 新建档案
              </Button>
            </CardHeader>
            <CardContent>
              {loadError ? (
                <UiErrorState title="档案列表不可用" detail={`${loadError}（Studio Manager 未就绪或未配置）`} />
              ) : !profiles ? (
                <Skeleton className="h-24 w-full" />
              ) : profiles.length === 0 && form === null ? (
                <UiEmptyState
                  title="还没有供应商档案"
                  hint="点击「新建档案」或从下方预设一键开始：本地推理 / 云端 API / 中转站。"
                />
              ) : (
                <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  {profiles.map((profile) => {
                    const meta = TYPE_META[profile.type];
                    const Icon = meta.icon;
                    const isActive = profile.id === activeProfileId;
                    return (
                      <div
                        key={profile.id}
                        className={`flex flex-col gap-3 rounded-[8px] border bg-elevated p-3 transition-colors ${
                          isActive ? "border-primary/60 ring-1 ring-primary/30" : "border-border-subtle"
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="flex items-center gap-2">
                            <span className={`flex size-8 shrink-0 items-center justify-center rounded-[6px] border p-1.5 ${meta.tone === "ai" ? "border-ai/30 bg-ai/10 text-ai" : meta.tone === "localtest" ? "border-localtest/30 bg-localtest/10 text-localtest" : "border-manual/30 bg-manual/10 text-manual"}`}>
                              <Icon className="size-full" />
                            </span>
                            <div className="min-w-0">
                              <div className="truncate text-[13px] font-medium">{profile.name}</div>
                              <div className="text-[11px] text-subtle-foreground">{meta.label}</div>
                            </div>
                          </div>
                          {isActive ? <Badge tone="ai">ACTIVE</Badge> : null}
                        </div>
                        <div className="data-mono truncate rounded-[5px] bg-background px-2 py-1.5 text-[11px] text-muted-foreground" title={profile.baseUrl}>
                          {profile.baseUrl}
                        </div>
                        <div className="flex flex-wrap items-center gap-1.5">
                          {profile.model ? (
                            <Badge tone="neutral">model: {profile.model}</Badge>
                          ) : (
                            <Badge tone="info">模型自动发现</Badge>
                          )}
                          {profile.type === "openai-compatible" ? (
                            profile.hasApiKey ? (
                              <Badge tone="neutral"><KeyRound className="size-3" /> 密钥已存</Badge>
                            ) : (
                              <Badge tone="warning">缺密钥</Badge>
                            )
                          ) : null}
                          {profile.structuredOutput && profile.structuredOutput !== "none" ? (
                            <Badge tone="info">{profile.structuredOutput}</Badge>
                          ) : null}
                        </div>
                        <div className="mt-auto flex items-center gap-2 pt-1">
                          <Button
                            size="sm"
                            variant={isActive ? "secondary" : "default"}
                            disabled={busyId !== null || isActive}
                            onClick={() => void activate(profile.id)}
                          >
                            <Zap className="mr-1" />
                            {isActive ? "已激活" : busyId === profile.id ? "激活中…" : "激活"}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busyId !== null}
                            onClick={() =>
                              setForm({
                                id: profile.id,
                                name: profile.name,
                                type: profile.type,
                                baseUrl: profile.baseUrl,
                                model: profile.model ?? "",
                                apiKey: "",
                                structuredOutput: profile.structuredOutput || "none",
                              })
                            }
                          >
                            <Pencil className="mr-1" /> 编辑
                          </Button>
                          <span className="flex-1" />
                          {confirmDeleteId === profile.id ? (
                            <Button size="sm" variant="destructive" disabled={busyId !== null} onClick={() => void remove(profile.id)}>
                              确认删除
                            </Button>
                          ) : (
                            <Button
                              size="icon"
                              variant="ghost"
                              aria-label="删除档案"
                              disabled={busyId !== null}
                              onClick={() => setConfirmDeleteId(profile.id)}
                            >
                              <Trash2 />
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 新建 / 编辑表单 */}
              {form ? (
                <div className="mt-4 rounded-[8px] border border-border bg-elevated p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <h4 className="text-[13px] font-semibold">{form.id ? "编辑档案" : "新建档案"}</h4>
                    <Button size="sm" variant="ghost" onClick={() => setForm(null)} disabled={busyId !== null}>
                      取消
                    </Button>
                  </div>
                  {form.id === null ? (
                    <div className="mb-4 space-y-2">
                      <div className="text-[11.5px] text-subtle-foreground">从预设开始（可再修改）：</div>
                      <div className="flex flex-wrap gap-1.5">
                        {PRESETS.map((preset) => (
                          <button
                            key={preset.key}
                            type="button"
                            className="rounded-[6px] border border-border-subtle bg-background px-2.5 py-1 text-[12px] transition-colors hover:border-ai/50 hover:text-ai"
                            onClick={() => setForm({ ...EMPTY_FORM, ...preset.form, name: preset.label })}
                            title={preset.note ?? ""}
                          >
                            {preset.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : null}
                  <div className="grid gap-3 md:grid-cols-2">
                    <Field label="名称">
                      <Input
                        value={form.name}
                        maxLength={64}
                        placeholder="如 GLM Coding Plan / DGX Spark"
                        onChange={(event) => setForm({ ...form, name: event.target.value })}
                      />
                    </Field>
                    <Field label="接入类型">
                      <div className="flex flex-wrap gap-1.5">
                        {(Object.keys(TYPE_META) as ProviderProfileView["type"][]).map((type) => {
                          const meta = TYPE_META[type];
                          const Icon = meta.icon;
                          const selected = form.type === type;
                          return (
                            <button
                              key={type}
                              type="button"
                              className={`inline-flex items-center gap-1.5 rounded-[6px] border px-2.5 py-1.5 text-[12px] transition-colors ${
                                selected
                                  ? "border-primary/60 bg-primary/10 text-primary"
                                  : "border-border-subtle bg-background text-muted-foreground hover:text-foreground"
                              }`}
                              onClick={() => setForm({ ...form, type, structuredOutput: type === "openai-compatible" ? form.structuredOutput : "none" })}
                              title={meta.hint}
                            >
                              <Icon className="size-3.5" />
                              {meta.label}
                            </button>
                          );
                        })}
                      </div>
                    </Field>
                    <Field label="Base URL" className="md:col-span-2">
                      <Input
                        value={form.baseUrl}
                        className="data-mono"
                        placeholder={
                          form.type === "openai-compatible"
                            ? "https://open.bigmodel.cn/api/paas/v4（支持带路径前缀，自动拼 /chat/completions）"
                            : "http://192.168.100.2:18300（本地地址必须带端口、不带路径）"
                        }
                        onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
                      />
                    </Field>
                    <Field
                      label="模型"
                      hint={
                        form.type === "openai-compatible"
                          ? "必填：云端/中转端点不依赖模型发现"
                          : "可留空：启动时经 /v1/models 按统一规则发现"
                      }
                    >
                      <Input
                        value={form.model}
                        className="data-mono"
                        placeholder={form.type === "openai-compatible" ? "如 glm-4.7 / deepseek-chat" : "留空 = 自动发现"}
                        onChange={(event) => setForm({ ...form, model: event.target.value })}
                      />
                    </Field>
                    {form.type === "openai-compatible" ? (
                      <>
                        <Field label="API Key" hint={form.id ? "留空 = 保持已保存的密钥" : "必填，仅存本机 runtime-data"}>
                          <Input
                            type="password"
                            value={form.apiKey}
                            autoComplete="off"
                            placeholder={form.id ? "••••••（不变）" : "sk-…"}
                            onChange={(event) => setForm({ ...form, apiKey: event.target.value })}
                          />
                        </Field>
                        <Field label="结构化输出契约" hint="供应商支持时用于 JSON 计划输出">
                          <select
                            className="h-9 w-full rounded-[6px] border border-border-subtle bg-background px-2.5 text-[12.5px] text-foreground"
                            value={form.structuredOutput}
                            onChange={(event) => setForm({ ...form, structuredOutput: event.target.value })}
                          >
                            <option value="none">none（默认）</option>
                            <option value="json_object">json_object</option>
                            <option value="json_schema">json_schema</option>
                            <option value="tool">tool</option>
                          </select>
                        </Field>
                      </>
                    ) : null}
                  </div>
                  <div className="mt-4 flex items-center gap-2">
                    <Button
                      disabled={
                        busyId !== null ||
                        form.name.trim() === "" ||
                        form.baseUrl.trim() === "" ||
                        (form.type === "openai-compatible" && form.model.trim() === "")
                      }
                      onClick={() => void saveForm(form)}
                    >
                      {busyId === (form.id ?? "new") ? "保存中…" : "保存档案"}
                    </Button>
                    <span className="text-[11.5px] text-subtle-foreground">
                      保存后点档案上的「激活」写入 .env.local，重启 Studio 生效。
                    </span>
                  </div>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}

function StatusStat({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <div className="text-[10.5px] uppercase tracking-wide text-subtle-foreground">{label}</div>
      <div className={`truncate text-[12.5px] ${mono ? "data-mono" : ""}`}>{value}</div>
    </div>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className ?? ""}`}>
      <label className="text-[11.5px] font-medium text-muted-foreground">{label}</label>
      {children}
      {hint ? <p className="text-[11px] leading-snug text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}

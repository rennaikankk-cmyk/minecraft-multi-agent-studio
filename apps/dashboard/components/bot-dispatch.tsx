"use client";

// 派遣面板（用户 2026-09-11 需求）：基地坐标启程 + 可开启的地狱顶层赶路。
// 两个动作面都走既有 /api/goals → control-api 提交链；移动走确定性模板
// （"移动到坐标 x= y= z="，coordinator 零 LLM 派发）；地狱赶路是分步
// 序列（每步一个 goal，逐步确认推进——链路可中断可续，不打包黑盒）。

import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, Card, CardContent, CardHeader, CardTitle, Input } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";

interface BotOption {
  botId: string;
  state: string;
}

interface NetherStep {
  label: string;
  goal: string | null;
  note: string;
}

const NETHER_MATERIALS = [
  { name: "obsidian", count: 20, note: "两道 4×5 门框（去程+回程）" },
  { name: "flint_and_steel", count: 1, note: "点燃两道门（铁锭+燧石可合成）" },
  { name: "cobblestone（或任意铺路方块）", count: 64, note: "柱子上升+顶面铺路" },
];

export function BotDispatchPanel() {
  const [bots, setBots] = useState<BotOption[]>([]);
  const [botId, setBotId] = useState("");
  const [x, setX] = useState("0");
  const [y, setY] = useState("64");
  const [z, setZ] = useState("0");
  const [netherMode, setNetherMode] = useState(false);
  const [netherStepIndex, setNetherStepIndex] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refreshBots = useCallback(async () => {
    try {
      const response = await fetch("/api/bots", { cache: "no-store" });
      const body = (await response.json()) as { bots?: Array<{ botId?: string; state?: string }> };
      const options = (body.bots ?? [])
        .filter((bot): bot is { botId: string; state: string } => typeof bot.botId === "string")
        .map((bot) => ({ botId: bot.botId, state: typeof bot.state === "string" ? bot.state : "unknown" }));
      setBots(options);
      if (options.length > 0 && !options.some((option) => option.botId === botId)) {
        setBotId(options[0]!.botId);
      }
    } catch {
      setBots([]);
    }
  }, [botId]);

  useEffect(() => {
    void refreshBots();
  }, [refreshBots]);

  const coordinateOk = /^-?\d{1,9}$/u.test(x.trim()) && /^-?\d{1,4}$/u.test(y.trim()) && /^-?\d{1,9}$/u.test(z.trim());

  // 地狱赶路分步序列：主世界坐标 → 地狱坐标（/8）。每步一个 goal，逐步推进。
  const netherSteps = useMemo<NetherStep[]>(() => {
    const tx = Number(x.trim() || "0");
    const tz = Number(z.trim() || "0");
    const nx = Math.floor(tx / 8);
    const nz = Math.floor(tz / 8);
    return [
      { label: "① 备料", goal: null, note: `核对材料：${NETHER_MATERIALS.map((m) => `${m.name}×${m.count}`).join("、")}（背包自备；缺项先采集/合成）` },
      { label: "② 造出发门框", goal: `施工蓝图行：锚点 x=0 y=64 z=0，沿 +x 放置 10 个 obsidian，每批最多 10 格，从第 0 格开始`, note: "锚点请按 bot 当前位置改写（10 格门框竖排后手动补成型；或直接人工摆门后跳过此步）" },
      { label: "③ 点燃", goal: `用打火石点燃坐标 x=0 y=64 z=0 的地狱门内格`, note: "goal 里的门内坐标按实际门框填写" },
      { label: "④ 穿门进地狱", goal: `走进坐标 x=0 y=64 z=0 的地狱门并确认到达 minecraft:the_nether`, note: "同上，坐标按实际门填写" },
      { label: "⑤ 上升到顶层", goal: `在 minecraft:the_nether 用 cobblestone 搭柱上升到 y=126`, note: "travel.ascend（基岩阻塞会如实报告，需换列重试）" },
      { label: "⑥ 顶层铺路赶路", goal: `在 minecraft:the_nether 顶面用 cobblestone 向 x=${nx} z=${nz} 搭路前进最多 128 格`, note: "travel.bridge（主世界目标/8 = 地狱坐标；距离>128 分多次）" },
      { label: "⑦ 造返回门+回家", goal: null, note: `重复②③④（门框 10 块+点燃+穿门）后，goal：移动到坐标 x=${tx} y=${y.trim() || 64} z=${tz}`, note2: "" },
    ] as NetherStep[];
  }, [x, y, z]);

  const submitGoal = useCallback(async (goal: string, stepLabel: string) => {
    if (botId.length === 0) {
      setMessage("请先选择 Bot。");
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/goals", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-studio-action": "submit-goal" },
        body: JSON.stringify({ schemaVersion: "1.0", botId, operatorGoal: goal }),
      });
      const body = (await response.json().catch(() => null)) as { error?: { message?: string }; data?: { taskId?: string } } | null;
      if (!response.ok) {
        setMessage(`${stepLabel} 提交失败：${body?.error?.message ?? `HTTP ${response.status}`}`);
        return;
      }
      setMessage(`${stepLabel} 已提交（任务 ${body?.data?.taskId ?? "?"}）；在 Goals / Plans 页跟踪完成后再执行下一步。`);
    } catch (error) {
      setMessage(`${stepLabel} 提交失败：${error instanceof Error ? error.message : "unknown"}`);
    } finally {
      setBusy(false);
    }
  }, [botId]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>派遣 Bot（坐标启程 / 地狱赶路）</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1 text-xs text-subtle-foreground">
            Bot
            <select
              className="rounded border border-border bg-background px-2 py-1.5 text-sm"
              value={botId}
              onChange={(event) => setBotId(event.target.value)}
              data-testid="dispatch-bot-select"
            >
              {bots.length === 0 ? <option value="">（无可用 Bot）</option> : null}
              {bots.map((bot) => (
                <option key={bot.botId} value={bot.botId}>{bot.botId}（{bot.state}）</option>
              ))}
            </select>
          </label>
          {[
            { label: "x", value: x, set: setX },
            { label: "y", value: y, set: setY },
            { label: "z", value: z, set: setZ },
          ].map((field) => (
            <label key={field.label} className="flex flex-col gap-1 text-xs text-subtle-foreground">
              {field.label}
              <Input
                className="w-28 data-mono"
                value={field.value}
                onChange={(event) => field.set(event.target.value)}
                aria-label={`dispatch-${field.label}`}
              />
            </label>
          ))}
          <Button
            size="sm"
            disabled={busy || !coordinateOk || botId.length === 0}
            onClick={() => void submitGoal(`移动到坐标 x=${x.trim()} y=${y.trim()} z=${z.trim()}`, "前往坐标")}
            data-testid="dispatch-goto"
          >
            前往坐标
          </Button>
          <Button
            size="sm"
            variant={netherMode ? "destructive" : "outline"}
            onClick={() => { setNetherMode((value) => !value); setNetherStepIndex(0); }}
            data-testid="dispatch-nether-toggle"
          >
            {netherMode ? "关闭地狱赶路" : "开启地狱赶路"}
          </Button>
        </div>

        {netherMode ? (
          <div className="space-y-2 rounded-[8px] border border-border-subtle bg-elevated p-3" data-testid="nether-plan">
            <p className="text-xs text-subtle-foreground">
              主世界目标 → 地狱坐标（÷8）＝ x={Math.floor(Number(x.trim() || "0") / 8)} z={Math.floor(Number(z.trim() || "0") / 8)}。
              材料清单：{NETHER_MATERIALS.map((material) => `${material.name}×${material.count}（${material.note}）`).join("；")}。
            </p>
            <ol className="space-y-1.5">
              {netherSteps.map((step, index) => (
                <li key={step.label} className="flex items-start gap-2 text-[12px]">
                  <Badge tone={index < netherStepIndex ? "online" : index === netherStepIndex ? "info" : "neutral"}>{step.label}</Badge>
                  <span className="flex-1 text-muted-foreground">{step.note}</span>
                  {step.goal !== null ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || index !== netherStepIndex || botId.length === 0}
                      onClick={() => {
                        void submitGoal(step.goal!, step.label);
                        setNetherStepIndex((current) => Math.min(current + 1, netherSteps.length - 1));
                      }}
                    >
                      执行此步
                    </Button>
                  ) : (
                    <span className="text-[11px] text-subtle-foreground">人工/自助步骤</span>
                  )}
                </li>
              ))}
            </ol>
          </div>
        ) : null}

        {message ? <p className="text-[12px] text-sky-400" data-testid="dispatch-message">{message}</p> : null}
      </CardContent>
    </Card>
  );
}

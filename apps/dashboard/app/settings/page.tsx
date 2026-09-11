"use client";

import { useCallback, useEffect, useState } from "react";

import { ThemeSwitcher } from "@/components/theme-switcher";
import { StudioRestartButton } from "@/components/studio-restart-button";
import { ChatTrustPanel } from "@/components/chat-trust-panel";
import {Badge, Card, CardContent, CardHeader, CardTitle, KeyValueRow, Skeleton, UiEmptyState , PageHeader } from "@/components/ui/primitives";

interface GameplayPolicyView {
  profile: string;
  unknownPlayerDisposition: string;
  proactiveCombat: boolean;
  propertyInteraction: string;
  resourceAcquisition: string;
  highIntensityCapabilities: boolean;
  antiCheatAdaptation: string;
  multiBotMode: string;
  source: string;
  revision: string;
}

interface StatusView {
  gameplayPolicy?: { desired: string; effective: string; source: string; policy?: GameplayPolicyView } | null;
}

export default function SettingsPage() {
  const [status, setStatus] = useState<StatusView | null>(null);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/studio/status", { cache: "no-store" });
      const body = await response.json();
      setStatus(body ?? null);
    } catch {
      setStatus(null);
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const policy = status?.gameplayPolicy ?? null;

  return (
    <main>
      <PageHeader eyebrow="SYSTEM · SETTINGS" title="Settings" actions={<StudioRestartButton />}></PageHeader>

      <Card className="mb-4">
        <CardHeader><CardTitle>Gameplay Policy（产品定位 · 单一事实源）</CardTitle></CardHeader>
        <CardContent>
          {!loaded ? (
            <Skeleton className="h-24 w-full" />
          ) : !policy ? (
            <UiEmptyState
              title="Gameplay Policy 状态不可用"
              hint="Manager 状态接口未返回 gameplayPolicy 字段（旧版 manager 或接口不可达）。"
            />
          ) : (
            <div className="space-y-2">
              <KeyValueRow
                label="Profile（desired / effective）"
                value={
                  <span className="data-mono">
                    {policy.desired} / {policy.effective}
                    <Badge tone={policy.effective === "anarchy_first" ? "failed" : "neutral"} className="ml-2">
                      {policy.effective === "anarchy_first" ? "ANARCHY-FIRST" : policy.effective.toUpperCase()}
                    </Badge>
                  </span>
                }
              />
              <KeyValueRow label="来源" value={<span className="data-mono">{policy.source}</span>} />
              {policy.policy ? (
                <>
                  <KeyValueRow label="未知玩家处置" value={policy.policy.unknownPlayerDisposition === "hostile" ? "HOSTILE（非白名单即可主动攻击）" : policy.policy.unknownPlayerDisposition} />
                  <KeyValueRow label="主动战斗" value={policy.policy.proactiveCombat ? "ON（可抢占普通任务；受存活/撤退更高优先级约束）" : "OFF"} />
                  <KeyValueRow label="财产 / 资源" value={<span className="data-mono">{policy.policy.propertyInteraction} / {policy.policy.resourceAcquisition}</span>} />
                  <KeyValueRow label="高强度能力规划位" value={policy.policy.highIntensityCapabilities ? "ON（实际生效仍走 capability gate）" : "OFF"} />
                  <KeyValueRow label="反作弊适配" value={<span className="data-mono">{policy.policy.antiCheatAdaptation}</span>} />
                  <KeyValueRow label="多 Bot 模式" value={<span className="data-mono">{policy.policy.multiBotMode}</span>} />
                  <KeyValueRow label="修订" value={<span className="data-mono">{policy.policy.revision}</span>} />
                </>
              ) : null}
              <p className="mt-2 text-[11px] leading-4 text-subtle-foreground">
                边界纪律：BotSurvivalSafety（图腾/防自伤/撤退）与 OperationalSecurity（主机/凭据/外部服务器管理边界）不受
                profile 影响永远保留。切换 profile 修改 .env 的 STUDIO_GAMEPLAY_PROFILE（ServerProfile 可按服覆盖）。
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="mb-4">
        <CardHeader><CardTitle>外观</CardTitle></CardHeader>
        <CardContent>
          <p className="mb-2 text-xs text-muted-foreground">旧版页面主题（迁移期间仍生效）：</p>
          <ThemeSwitcher />
        </CardContent>
      </Card>
      <UiEmptyState
        title="其余设置项：无浏览器可编辑的安全配置"
        hint="Studio 的运行时配置来自 .env / .env.local（服务端读取，含 secrets，不回传浏览器）。需要变更时修改配置文件并重启 Studio；secrets 在任何 UI 中只以 configured/not-configured 形式存在。"
      />
          <ChatTrustPanel />
    </main>
  );
}

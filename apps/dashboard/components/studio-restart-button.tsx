"use client";

// 重启 Studio 快捷按钮（models 页 restartRequired 提示 / Settings 页共用）。
// 生命周期：两击确认 → POST /api/studio/restart → manager 受理 → 整组服务
// 原地重启（dashboard 自身也在重启列表里，请求会开始失败）→ 轮询
// /api/studio/status 直到恢复 → 刷新页面拿到新配置的 UI。

import { useCallback, useEffect, useRef, useState } from "react";
import { RotateCw } from "lucide-react";

import { Button } from "@/components/ui/button";

type Phase = "idle" | "confirm" | "restarting" | "failed";

export function StudioRestartButton({ compact = false }: { compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
    };
  }, []);

  const waitUntilBack = useCallback(async () => {
    // dashboard 自身会掉线：轮询必须容忍网络错误，最多等 4 分钟。
    const deadline = Date.now() + 240_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      try {
        const response = await fetch("/api/studio/status", { cache: "no-store" });
        if (response.ok) {
          window.location.reload();
          return;
        }
      } catch {
        // 重启中：连接拒绝/502 都是预期路径，继续等。
      }
    }
    setPhase("failed");
  }, []);

  const trigger = useCallback(async () => {
    setPhase("restarting");
    try {
      const response = await fetch("/api/studio/restart", {
        method: "POST",
        headers: { "x-studio-action": "studio-restart" },
      });
      if (!response.ok && response.status !== 202) {
        setPhase("failed");
        return;
      }
    } catch {
      // 请求本身被重启打断也算受理路径，进入等待。
    }
    await waitUntilBack();
  }, [waitUntilBack]);

  const onClick = () => {
    if (phase === "restarting") return;
    if (phase === "confirm") {
      if (confirmTimer.current !== null) clearTimeout(confirmTimer.current);
      void trigger();
      return;
    }
    setPhase("confirm");
    confirmTimer.current = setTimeout(() => setPhase("idle"), 4_000);
  };

  return (
    <span className="inline-flex items-center gap-2" data-testid="studio-restart-button">
      <Button
        size="sm"
        variant={phase === "confirm" ? "destructive" : "outline"}
        onClick={onClick}
        disabled={phase === "restarting"}
        title={phase === "restarting" ? "重启进行中" : "原地重启全部 Studio 服务（重读 .env.local）"}
      >
        <RotateCw className={phase === "restarting" ? "animate-spin" : undefined} />
        {phase === "confirm" ? "确认重启" : phase === "restarting" ? "重启中…" : compact ? "重启 Studio" : "重启 Studio"}
      </Button>
      {phase === "restarting" ? (
        <span className="text-[11px] text-subtle-foreground">服务恢复后本页自动刷新…</span>
      ) : null}
      {phase === "failed" ? (
        <span className="text-[11px] text-red-400">等待恢复超时；请查看 Studio Services 窗口日志。</span>
      ) : null}
    </span>
  );
}

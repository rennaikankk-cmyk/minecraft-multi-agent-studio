"use client";

import { useState } from "react";

// ---------------------------------------------------------------------------
// BotLifecycleSwitch —— Bot 生命周期开关（启动/停止/重启 + 自动断联）。
//
// 自动断联开关：本地持久化（localStorage），读取后经环境变量
// BOT_EMERGENCY_RESTART_MAX=0 生效——0 预算即断线保号后不自动重连。
// 这是运维显式操作，与 L0 反射无关。
// ---------------------------------------------------------------------------

type LifecycleState = "idle" | "stopping" | "starting" | "error";

export function BotLifecycleSwitch({
  botId,
  running,
  onRestart,
  onStop,
  onStart,
}: {
  botId: string;
  running: boolean;
  onRestart: () => Promise<void>;
  onStop: () => Promise<void>;
  onStart: () => Promise<void>;
}) {
  const [state, setState] = useState<LifecycleState>("idle");
  const [error, setError] = useState<string | null>(null);

  const storageKey = `studio:autoDisconnect:${botId}`;
  const [autoDisconnect, setAutoDisconnect] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(storageKey) === "1";
  });

  const toggleAutoDisconnect = () => {
    const next = !autoDisconnect;
    setAutoDisconnect(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(storageKey, next ? "1" : "0");
    }
  };

  const run = async (action: () => Promise<void>, busy: LifecycleState) => {
    if (state !== "idle") return;
    setState(busy);
    setError(null);
    try {
      await action();
      setState("idle");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setState("error");
    }
  };

  const busy = state === "stopping" || state === "starting";

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
      }}
      data-testid={`bot-lifecycle-${botId}`}
    >
      <button
        type="button"
        disabled={busy || !running}
        onClick={() => void run(onStop, "stopping")}
        style={{
          padding: "6px 14px",
          borderRadius: 6,
          border: "1px solid rgba(255,92,74,0.4)",
          background: running ? "rgba(255,92,74,0.12)" : "transparent",
          color: running ? "var(--danger, #ff5c4a)" : "var(--muted)",
          cursor: busy || !running ? "not-allowed" : "pointer",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          opacity: busy ? 0.5 : 1,
        }}
      >
        {state === "stopping" ? "停止中…" : "断开"}
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => void run(onRestart, "starting")}
        style={{
          padding: "6px 14px",
          borderRadius: 6,
          border: "1px solid rgba(255,255,255,0.18)",
          background: "transparent",
          color: "var(--text, #f3ece8)",
          cursor: busy ? "not-allowed" : "pointer",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          opacity: busy ? 0.5 : 1,
        }}
      >
        {state === "starting" ? "启动中…" : "重启"}
      </button>

      {/* Auto-disconnect toggle */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginLeft: 8,
          cursor: "pointer",
          fontSize: 12,
          fontFamily: "ui-monospace, monospace",
          color: "var(--muted, #a29088)",
        }}
      >
        <span
          onClick={toggleAutoDisconnect}
          role="switch"
          aria-checked={autoDisconnect}
          data-testid={`auto-disconnect-${botId}`}
          style={{
            width: 34,
            height: 18,
            borderRadius: 9,
            background: autoDisconnect
              ? "var(--danger, #ff5c4a)"
              : "rgba(255,255,255,0.12)",
            position: "relative",
            transition: "background 200ms",
            flexShrink: 0,
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 2,
              left: autoDisconnect ? 18 : 2,
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#fff",
              transition: "left 200ms",
            }}
          />
        </span>
        断线保号后不自动重连
      </label>

      {error ? (
        <span
          style={{
            fontSize: 11,
            color: "var(--danger, #ff5c4a)",
            maxWidth: 220,
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={error}
        >
          {error}
        </span>
      ) : null}
    </div>
  );
}

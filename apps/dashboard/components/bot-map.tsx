"use client";

import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";
import { useEffect, useMemo, useRef } from "react";

// ---------------------------------------------------------------------------
// BotMap —— 实时位置地图（canvas 渲染）。
//
// 数据源：/api/bots 的 position 流（x/y/z + 可选 yaw/pitch）。
// 渲染：以首个 bot 为中心的自适应网格坐标系；每个 bot 一条渐隐轨迹线、
// 位置圆点、朝向楔形（yaw）。死亡点标记为红叉。
// ---------------------------------------------------------------------------

type TrailPoint = Readonly<{ x: number; z: number; t: number }>;

type BotTrack = Readonly<{
  botId: string;
  trail: TrailPoint[];
  last: TrailPoint | null;
  yaw: number | null;
  health: number;
  state: string;
}>;

const TRAIL_LIMIT = 240; // ~4 分钟 @ 1s 状态流
const TRAIL_FADE_MS = 180_000;

const BOT_COLORS = [
  "#ff5c4a",
  "#4ade80",
  "#60a5fa",
  "#facc15",
  "#c084fc",
  "#f472b6",
  "#34d399",
  "#fb923c",
  "#38bdf8",
  "#a3e635",
] as const;

export function BotMap({
  bots,
  height = 420,
}: {
  bots: readonly PublicBotDetailV1[];
  height?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tracksRef = useRef<Map<string, BotTrack>>(new Map());
  const frameRef = useRef(0);

  // Ingest positions into trail state (called on each bots update).
  const now = Date.now();
  for (const bot of bots) {
    if (!bot.position) continue;
    const existing = tracksRef.current.get(bot.botId);
    const point: TrailPoint = {
      x: bot.position.x,
      z: bot.position.z,
      t: now,
    };
    const trail = [...(existing?.trail ?? []), point].slice(-TRAIL_LIMIT);
    tracksRef.current.set(bot.botId, {
      botId: bot.botId,
      trail,
      last: point,
      yaw: bot.position.yaw ?? null,
      health: bot.health?.current ?? 20,
      state: bot.connectionState,
    });
  }
  // Forget bots that disappeared for a long time.
  for (const [botId, track] of tracksRef.current) {
    if (track.last && now - track.last.t > 300_000) {
      tracksRef.current.delete(botId);
    }
  }

  const center = useMemo(() => {
    const points = [...tracksRef.current.values()]
      .map((t) => t.last)
      .filter((p): p is TrailPoint => p !== null);
    if (points.length === 0) return { x: 0, z: 0, span: 64 };
    const minX = Math.min(...points.map((p) => p.x));
    const maxX = Math.max(...points.map((p) => p.x));
    const minZ = Math.min(...points.map((p) => p.z));
    const maxZ = Math.max(...points.map((p) => p.z));
    const span = Math.max(maxX - minX, maxZ - minZ, 48) * 1.25;
    return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, span };
  }, [bots]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let raf = 0;
    const render = () => {
      frameRef.current += 1;
      const { width, height: h } = canvas;
      const dpr = window.devicePixelRatio || 1;
      if (canvas.width !== width * dpr) {
        canvas.width = width * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
      ctx.clearRect(0, 0, width, h);

      const scale = Math.min(width, h) / center.span;
      const toScreen = (x: number, z: number) => ({
        sx: width / 2 + (x - center.x) * scale,
        sy: h / 2 + (z - center.z) * scale,
      });

      // Grid (every 16 blocks = chunk).
      ctx.strokeStyle = "rgba(255,255,255,0.06)";
      ctx.lineWidth = 1;
      const gridStep = 16 * scale;
      if (gridStep > 8) {
        const startX = width / 2 - ((center.x * scale) % gridStep);
        for (let gx = startX % gridStep; gx < width; gx += gridStep) {
          ctx.beginPath();
          ctx.moveTo(gx, 0);
          ctx.lineTo(gx, h);
          ctx.stroke();
        }
        const startZ = h / 2 - ((center.z * scale) % gridStep);
        for (let gz = startZ % gridStep; gz < h; gz += gridStep) {
          ctx.beginPath();
          ctx.moveTo(0, gz);
          ctx.lineTo(width, gz);
          ctx.stroke();
        }
      }

      // Axes.
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.beginPath();
      ctx.moveTo(0, h / 2);
      ctx.lineTo(width, h / 2);
      ctx.moveTo(width / 2, 0);
      ctx.lineTo(width / 2, h);
      ctx.stroke();

      const tNow = performance.now();

      let colorIndex = 0;
      for (const track of tracksRef.current.values()) {
        const color = BOT_COLORS[colorIndex % BOT_COLORS.length]!;
        colorIndex += 1;
        if (!track.last) continue;
        const { sx, sy } = toScreen(track.last.x, track.last.z);

        // Trail (fading polyline).
        if (track.trail.length > 1) {
          ctx.lineWidth = 2;
          for (let i = 1; i < track.trail.length; i += 1) {
            const a = track.trail[i - 1]!;
            const b = track.trail[i]!;
            const age = tNow - b.t;
            if (age > TRAIL_FADE_MS) continue;
            const alpha = Math.max(0.05, 1 - age / TRAIL_FADE_MS) * 0.6;
            const pa = toScreen(a.x, a.z);
            const pb = toScreen(b.x, b.z);
            ctx.strokeStyle = color;
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.moveTo(pa.sx, pa.sy);
            ctx.lineTo(pb.sx, pb.sy);
            ctx.stroke();
          }
          ctx.globalAlpha = 1;
        }

        // Yaw wedge (view direction).
        if (track.yaw !== null) {
          const yawScreen = -track.yaw - Math.PI / 2; // MC yaw → screen angle
          ctx.fillStyle = color;
          ctx.globalAlpha = 0.35;
          ctx.beginPath();
          ctx.moveTo(sx, sy);
          ctx.arc(sx, sy, 26, yawScreen - 0.35, yawScreen + 0.35);
          ctx.closePath();
          ctx.fill();
          ctx.globalAlpha = 1;
        }

        // Position dot + pulse for online bots.
        const online = track.state === "online";
        ctx.fillStyle = online ? color : "#666";
        ctx.beginPath();
        ctx.arc(sx, sy, online ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
        if (online) {
          const pulse = ((tNow / 900) % 1 + colorIndex * 0.13) % 1;
          ctx.strokeStyle = color;
          ctx.globalAlpha = (1 - pulse) * 0.5;
          ctx.beginPath();
          ctx.arc(sx, sy, 6 + pulse * 14, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Label.
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "11px ui-monospace, monospace";
        ctx.fillText(
          `${track.botId.replace("studio-", "")} (${Math.floor(track.last.x)}, ${Math.floor(track.last.z)})`,
          sx + 10,
          sy - 8,
        );
      }

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [center, bots]);

  return (
    <div className="botMapWrap" style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        style={{ width: "100%", height, borderRadius: 10, display: "block" }}
        data-testid="bot-map-canvas"
      />
      <div
        style={{
          position: "absolute",
          top: 8,
          left: 12,
          fontSize: 11,
          opacity: 0.6,
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {Math.round(center.span)} blk across · {tracksRef.current.size} tracked
      </div>
    </div>
  );
}

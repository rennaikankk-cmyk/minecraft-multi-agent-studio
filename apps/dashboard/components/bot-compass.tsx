"use client";

import type { PublicBotDetailV1 } from "@minecraft-studio/protocol";

// ---------------------------------------------------------------------------
// BotCompass —— 视角罗盘 + 生命/饥饿仪表。
//
// yaw 数据来自 position.yaw（本轮协议扩展）。弧度转度显示；罗盘盘面
// N/E/S/W 刻度随 yaw 旋转。pitch 以侧边小条显示俯仰。
// ---------------------------------------------------------------------------

function yawToDegrees(yaw: number): number {
  // Minecraft yaw: 0 = +Z (south), 90 = -X (west), 180/-180 = -Z (north).
  // 屏幕罗盘按北=0°顺时针：deg = -yaw * 180/PI - 180。
  let deg = (-yaw * 180) / Math.PI - 180;
  while (deg < 0) deg += 360;
  while (deg >= 360) deg -= 360;
  return deg;
}

function headingLabel(deg: number): string {
  const names = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"] as const;
  return names[Math.round(deg / 45) % 8]!;
}

export function BotCompass({ bot }: { bot: PublicBotDetailV1 }) {
  const yaw = bot.position?.yaw ?? null;
  const pitch = bot.position?.pitch ?? null;
  const health = bot.health?.current ?? null;
  const maxHealth = bot.health?.maximum ?? 20;
  const food = bot.food?.level ?? null;
  const deg = yaw !== null ? yawToDegrees(yaw) : null;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        gap: 14,
        alignItems: "center",
      }}
      data-testid={`bot-compass-${bot.botId}`}
    >
      {/* Compass dial */}
      <div
        style={{
          position: "relative",
          width: 84,
          height: 84,
          borderRadius: "50%",
          border: "1px solid var(--line, rgba(255,255,255,0.15))",
          background: "var(--panel-2, #191514)",
          overflow: "hidden",
        }}
      >
        {deg !== null ? (
          <div
            style={{
              position: "absolute",
              inset: 0,
              transform: `rotate(${-deg}deg)`,
              transition: "transform 120ms linear",
            }}
          >
            {["北", "东", "南", "西"].map((label, index) => (
              <span
                key={label}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: 6,
                  transform: `translateX(-50%) rotate(${index * 90}deg)`,
                  transformOrigin: "50% 36px",
                  fontSize: 11,
                  color: label === "北" ? "var(--danger, #ff5c4a)" : "var(--muted, #a29088)",
                  fontFamily: "ui-monospace, monospace",
                }}
              >
                {label}
              </span>
            ))}
            {/* Tick marks */}
            {Array.from({ length: 24 }, (_, i) => (
              <span
                key={i}
                style={{
                  position: "absolute",
                  left: "50%",
                  top: i % 6 === 0 ? 4 : 8,
                  width: i % 6 === 0 ? 2 : 1,
                  height: i % 6 === 0 ? 8 : 5,
                  background: "rgba(255,255,255,0.25)",
                  transform: `translateX(-50%) rotate(${i * 15}deg)`,
                  transformOrigin: "50% 38px",
                }}
              />
            ))}
          </div>
        ) : null}
        {/* Fixed needle */}
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 0,
            height: 0,
            transform: "translate(-50%, -100%)",
            borderLeft: "5px solid transparent",
            borderRight: "5px solid transparent",
            borderBottom: `18px solid var(--accent, #ff5c4a)`,
            filter: "drop-shadow(0 0 4px var(--accent-glow, rgba(255,92,74,0.5)))",
          }}
        />
        <div
          style={{
            position: "absolute",
            left: "50%",
            top: "50%",
            width: 4,
            height: 4,
            borderRadius: "50%",
            background: "var(--accent, #ff5c4a)",
            transform: "translate(-50%, -50%)",
          }}
        />
      </div>

      {/* Readouts */}
      <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
        <div
          style={{
            fontFamily: "ui-monospace, monospace",
            fontSize: 18,
            fontWeight: 700,
            color: "var(--text, #f3ece8)",
          }}
        >
          {deg !== null ? `${Math.round(deg)}° ${headingLabel(deg)}` : "视角不可用"}
          {pitch !== null ? (
            <span style={{ fontSize: 12, opacity: 0.6, marginLeft: 8 }}>
              俯仰 {Math.round((pitch * 180) / Math.PI)}°
            </span>
          ) : null}
        </div>
        {health !== null ? (
          <Gauge
            label="生命"
            value={health}
            max={maxHealth}
            color={health / maxHealth < 0.35 ? "var(--danger, #ff5c4a)" : "var(--ok, #6ee7a2)"}
          />
        ) : null}
        {food !== null ? <Gauge label="饥饿" value={food} max={20} color="#facc15" /> : null}
      </div>
    </div>
  );
}

function Gauge({
  label,
  value,
  max,
  color,
}: {
  label: string;
  value: number;
  max: number;
  color: string;
}) {
  const ratio = Math.max(0, Math.min(1, value / max));
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span
        style={{
          fontSize: 11,
          width: 28,
          color: "var(--muted, #a29088)",
          fontFamily: "ui-monospace, monospace",
        }}
      >
        {label}
      </span>
      <div
        style={{
          flex: 1,
          height: 8,
          borderRadius: 4,
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: `${ratio * 100}%`,
            height: "100%",
            borderRadius: 4,
            background: color,
            transition: "width 300ms ease",
          }}
        />
      </div>
      <span
        style={{
          fontSize: 11,
          width: 44,
          textAlign: "right",
          fontFamily: "ui-monospace, monospace",
          color: "var(--text, #f3ece8)",
        }}
      >
        {Math.round(value)}/{max}
      </span>
    </div>
  );
}

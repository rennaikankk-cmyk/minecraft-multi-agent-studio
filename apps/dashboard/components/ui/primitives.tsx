// 通用基础组件：Card / Badge / Skeleton / Separator / Table / Input / EmptyState / ErrorState
// 视觉语言参考 shadcn/ui（MIT）；本项目 tokens 实现，无远程运行时资源。
import * as React from "react";

import { cn } from "@/lib/utils";

/* ---------------- Card ---------------- */

export function Card({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="card"
      className={cn(
        "rounded-[8px] border border-border-subtle bg-card shadow-[var(--shadow-panel)]",
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex items-center justify-between gap-2 px-4 py-3 border-b border-border-subtle", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: React.ComponentProps<"h3">) {
  return <h3 className={cn("text-[13px] font-semibold tracking-wide text-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("p-4", className)} {...props} />;
}

/* ---------------- Badge（语义状态词汇表唯一来源） ---------------- */

export type StatusTone =
  | "online" | "offline" | "starting" | "stopping" | "degraded"
  | "failed" | "unknown" | "notstarted" | "managed" | "external"
  | "ai" | "manual" | "autonomy" | "localtest" | "info" | "neutral";

export function Badge({
  tone = "neutral",
  className,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone?: StatusTone }) {
  return (
    <span
      data-slot="badge"
      className={cn(
        "inline-flex items-center gap-1 rounded-[5px] border px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap",
        toneClasses(tone),
        className,
      )}
      {...props}
    >
      {children}
    </span>
  );
}

function toneClasses(tone: StatusTone): string {
  switch (tone) {
    case "online": return "border-success/30 bg-success/10 text-success";
    case "offline": return "border-danger/30 bg-danger/10 text-danger";
    case "starting": return "border-warning/30 bg-warning/10 text-warning";
    case "stopping": return "border-warning/30 bg-warning/10 text-warning";
    case "degraded": return "border-warning/40 bg-warning/15 text-warning";
    case "failed": return "border-danger/40 bg-danger/15 text-danger";
    case "unknown": return "border-border-strong bg-elevated text-subtle-foreground";
    case "notstarted": return "border-border-strong bg-elevated text-subtle-foreground";
    case "managed": return "border-primary/30 bg-primary/10 text-primary";
    case "external": return "border-external/30 bg-external/10 text-external";
    case "ai": return "border-ai/30 bg-ai/10 text-ai";
    case "manual": return "border-manual/30 bg-manual/10 text-manual";
    case "autonomy": return "border-autonomy/30 bg-autonomy/10 text-autonomy";
    case "localtest": return "border-localtest/30 bg-localtest/10 text-localtest";
    case "info": return "border-primary/25 bg-primary/8 text-primary";
    default: return "border-border-subtle bg-elevated text-muted-foreground";
  }
}

/* ---------------- Skeleton / Separator ---------------- */

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("animate-pulse rounded-[6px] bg-elevated", className)} {...props} />;
}

export function Separator({ className, vertical = false }: { className?: string; vertical?: boolean }) {
  return (
    <div
      role="separator"
      aria-orientation={vertical ? "vertical" : "horizontal"}
      className={cn("bg-border-subtle", vertical ? "w-px self-stretch" : "h-px w-full", className)}
    />
  );
}

/* ---------------- Table primitives ---------------- */

export function DataTable({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div className="overflow-x-auto">
      <table className={cn("w-full text-left text-[12.5px]", className)} {...props} />
    </div>
  );
}

export function Th({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "sticky top-0 z-10 whitespace-nowrap border-b border-border-subtle bg-card px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-subtle-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function Td({ className, ...props }: React.ComponentProps<"td">) {
  return <td className={cn("whitespace-nowrap border-b border-border-subtle/50 px-3 py-1.5 align-middle", className)} {...props} />;
}

/* ---------------- Input ---------------- */

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      className={cn(
        "h-7 w-full rounded-[6px] border border-border-subtle bg-elevated px-2 text-[12.5px] text-foreground placeholder:text-subtle-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}

/* ---------------- PageHeader ---------------- */

export function PageHeader({ eyebrow, title, actions, children }: {
  eyebrow?: string;
  title: string;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        {eyebrow ? <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-subtle-foreground">{eyebrow}</p> : null}
        <h1 className="text-lg font-semibold tracking-tight text-foreground">{title}</h1>
        {children ? <div className="mt-1 max-w-3xl text-[12.5px] text-muted-foreground">{children}</div> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/* ---------------- KeyValueRow ---------------- */

export function KeyValueRow({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-border-subtle/40 py-1.5 last:border-0">
      <span className="shrink-0 text-[11.5px] text-subtle-foreground">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-[12.5px] text-foreground", mono !== false && "data-mono")}>{value ?? "—"}</span>
    </div>
  );
}

/* ---------------- Empty / Error（新 shell 版） ---------------- */

export function UiEmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-1 rounded-[8px] border border-dashed border-border-subtle bg-card/50 px-6 py-10 text-center">
      <p className="text-[13px] font-medium text-muted-foreground">{title}</p>
      {hint ? <p className="max-w-md text-xs text-subtle-foreground">{hint}</p> : null}
    </div>
  );
}

export function UiErrorState({ title, detail }: { title: string; detail?: string }) {
  return (
    <div role="alert" className="rounded-[8px] border border-danger/30 bg-danger/8 px-4 py-3">
      <p className="text-[13px] font-medium text-danger">{title}</p>
      {detail ? <p className="mt-0.5 break-all text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  );
}

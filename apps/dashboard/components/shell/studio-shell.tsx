"use client";

// Studio App Shell —— 可折叠侧边栏 + 紧凑全局状态栏 + Command Palette + 响应式 drawer。
// 视觉参考 shadcn-admin（MIT）；数据全部真实（useGlobalStatus 单点轮询）。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";
import { PanelLeftClose, PanelLeftOpen, Menu, Search, RefreshCw } from "lucide-react";

import { NAV_GROUPS } from "@/components/shell/nav-config";
import { useGlobalStatus } from "@/components/shell/use-global-status";
import { Badge, Separator } from "@/components/ui/primitives";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTrigger, Tooltip, TooltipProvider } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

const COLLAPSE_KEY = "studio-sidebar-collapsed";

export function StudioShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const status = useGlobalStatus();
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    setCollapsed(localStorage.getItem(COLLAPSE_KEY) === "1");
  }, []);
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      localStorage.setItem(COLLAPSE_KEY, current ? "0" : "1");
      return !current;
    });
  }, []);

  // Ctrl/Cmd+K → command palette
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // 路由切换关掉 drawer/palette
  useEffect(() => {
    setDrawerOpen(false);
    setPaletteOpen(false);
  }, [pathname]);

  const nav = (
    <SidebarNav
      collapsed={collapsed}
      pathname={pathname}
      status={status}
      onNavigate={() => setDrawerOpen(false)}
    />
  );

  return (
    <TooltipProvider>
      <div className="studio-ui flex min-h-screen bg-background">
        {/* 桌面侧边栏 */}
        <aside
          aria-label="主导航"
          className={cn(
            "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-border-subtle bg-sidebar anim-200 lg:flex",
            collapsed ? "w-[52px]" : "w-[208px]",
          )}
        >
          <div className={cn("flex h-11 items-center gap-2 border-b border-border-subtle px-3", collapsed && "justify-center px-0")}>
            <span className="grid size-6 shrink-0 place-items-center rounded-[5px] bg-primary/15 text-[11px] font-bold text-primary" aria-hidden>
              M
            </span>
            {!collapsed ? <span className="truncate text-[13px] font-semibold">Agent Studio</span> : null}
          </div>
          <nav className="flex-1 overflow-y-auto py-2">{nav}</nav>
          <div className="border-t border-border-subtle p-2">
            <Button variant="ghost" size="sm" className="w-full justify-center" onClick={toggleCollapsed} aria-label={collapsed ? "展开侧边栏" : "折叠侧边栏"}>
              {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
              {!collapsed ? <span className="text-xs">折叠</span> : null}
            </Button>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          {/* 紧凑全局状态栏 */}
          <header className="sticky top-0 z-40 flex h-11 items-center gap-2 border-b border-border-subtle bg-card/95 px-3 backdrop-blur">
            {/* 移动端菜单 */}
            <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label="打开导航">
                  <Menu />
                </Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-64 p-0" aria-label="导航抽屉">
                <div className="flex h-11 items-center gap-2 border-b border-border-subtle px-3">
                  <span className="grid size-6 place-items-center rounded-[5px] bg-primary/15 text-[11px] font-bold text-primary" aria-hidden>M</span>
                  <span className="text-[13px] font-semibold">Agent Studio</span>
                </div>
                <div className="py-2">{nav}</div>
              </SheetContent>
            </Sheet>

            <StatusPill label="Mode" value={status.studioMode} tone={status.studioMode === "UNKNOWN" ? "unknown" : "info"} />
            <StatusDot
              label="Local MC"
              tone={status.localTest?.status === "online" ? "localtest" : "notstarted"}
              text={status.localTest?.status === "online" ? "ON" : status.localTest?.status === "starting" ? "STARTING" : "OFF"}
            />
            <StatusPill label="Bots" value={`${status.bots.online}/${status.bots.total}`} tone={status.bots.online > 0 ? "online" : "neutral"} />
            <StatusPill
              label="Incidents"
              value={status.incidents.critical > 0 ? `${status.incidents.open} (${status.incidents.critical} crit)` : String(status.incidents.open)}
              tone={status.incidents.critical > 0 ? "failed" : status.incidents.open > 0 ? "warning" : "neutral"}
            />
            <StatusDot
              label="Spark"
              tone={status.spark?.state === "connected" ? "ai" : status.spark?.state === "misconfigured" ? "failed" : status.spark?.state === "disabled" ? "neutral" : "warning"}
              text={status.spark?.model ?? status.spark?.state?.toUpperCase() ?? "—"}
            />
            <div className="ml-auto flex items-center gap-1">
              {status.stale ? <Badge tone="warning">STALE</Badge> : null}
              <span className="hidden text-[11px] text-subtle-foreground sm:inline" title={status.lastRefreshAt ?? ""}>
                {status.lastRefreshAt ? new Date(status.lastRefreshAt).toLocaleTimeString("zh-CN") : "—"}
              </span>
              <Button variant="ghost" size="icon" aria-label="搜索（Ctrl+K）" onClick={() => setPaletteOpen(true)}>
                <Search />
              </Button>
            </div>
          </header>

          <main className="min-w-0 flex-1 px-4 py-4 lg:px-6">{children}</main>
        </div>

        <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      </div>
    </TooltipProvider>
  );
}

function SidebarNav({
  collapsed,
  pathname,
  status,
  onNavigate,
}: {
  collapsed: boolean;
  pathname: string;
  status: ReturnType<typeof useGlobalStatus>;
  onNavigate: () => void;
}) {
  return (
    <>
      {NAV_GROUPS.map((group) => (
        <div key={group.label} className="mb-1">
          {!collapsed ? (
            <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-subtle-foreground">{group.label}</p>
          ) : (
            <Separator className="mx-3 my-2 w-auto" />
          )}
          <ul>
            {group.items.map((item) => {
              const active = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href + "/"));
              const icon = <item.icon className="size-4 shrink-0" />;
              const link = (
                <a
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  onClick={onNavigate}
                  className={cn(
                    "flex h-8 items-center gap-2 rounded-[6px] px-2 text-[12.5px] anim-120",
                    collapsed && "justify-center px-0",
                    active
                      ? "bg-selected font-medium text-foreground"
                      : "text-muted-foreground hover:bg-hover hover:text-foreground",
                  )}
                >
                  {collapsed ? (
                    <Tooltip label={item.label}>{icon}</Tooltip>
                  ) : (
                    <>
                      {icon}
                      <span className="truncate">{item.label}</span>
                      {item.badge === "criticalIncidents" && status.incidents.critical > 0 ? (
                        <span className="ml-auto rounded-[4px] bg-critical/20 px-1.5 text-[10px] font-bold text-critical">
                          {status.incidents.critical}
                        </span>
                      ) : null}
                      {item.badge === "spark" ? (
                        <span
                          className={cn(
                            "ml-auto size-1.5 rounded-full",
                            status.spark?.state === "connected" ? "bg-ai" : status.spark?.state === "misconfigured" ? "bg-critical" : "bg-warning",
                          )}
                          aria-hidden
                        />
                      ) : null}
                      {item.badge === "localTest" && status.localTest?.status === "online" ? (
                        <span className="ml-auto size-1.5 rounded-full bg-localtest" aria-hidden />
                      ) : null}
                    </>
                  )}
                </a>
              );
              return <li key={item.href}>{link}</li>;
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

function StatusPill({ label, value, tone }: { label: string; value: string; tone: "info" | "online" | "warning" | "failed" | "neutral" | "unknown" }) {
  return (
    <span className="hidden items-center gap-1.5 rounded-[6px] border border-border-subtle bg-elevated px-2 py-1 md:inline-flex" title={label}>
      <span className="text-[10px] uppercase tracking-wider text-subtle-foreground">{label}</span>
      <span
        className={cn(
          "text-[11.5px] font-semibold data-mono",
          tone === "online" && "text-success",
          tone === "warning" && "text-warning",
          tone === "failed" && "text-critical",
          tone === "info" && "text-primary",
          (tone === "neutral" || tone === "unknown") && "text-muted-foreground",
        )}
      >
        {value}
      </span>
    </span>
  );
}

function StatusDot({ label, tone, text }: { label: string; tone: "ai" | "localtest" | "notstarted"; text: string }) {
  return (
    <span className="hidden items-center gap-1.5 rounded-[6px] border border-border-subtle bg-elevated px-2 py-1 lg:inline-flex" title={label}>
      <span
        className={cn(
          "size-1.5 rounded-full",
          tone === "ai" && "bg-ai",
          tone === "localtest" && "bg-localtest",
          tone === "notstarted" && "bg-subtle-foreground/50",
        )}
        aria-hidden
      />
      <span className="max-w-40 truncate text-[11.5px] font-semibold data-mono text-muted-foreground">{text}</span>
    </span>
  );
}

/* ---------------- Command Palette ---------------- */

interface PaletteAction {
  label: string;
  hint?: string;
  danger?: boolean;
  run: () => void | Promise<void>;
}

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const actions = useMemo<PaletteAction[]>(() => {
    const navigateActions = NAV_GROUPS.flatMap((group) =>
      group.items.map((item) => ({
        label: `前往 ${item.label}`,
        hint: `${group.label} · ${item.hint ?? ""} · ${item.href}`,
        run: () => router.push(item.href),
      })),
    );
    return [
      ...navigateActions,
      {
        label: "启动 Local Test Server（需确认）",
        hint: "Servers · 经安全代理 + operation 轮询",
        run: async () => {
          if (!window.confirm("启动 Local Test Server？将以 Studio ownership 启动隔离测试服。")) return;
          const response = await fetch("/api/servers/local-test/start", {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Studio-Action": "local-test-start" },
            body: "{}",
          }).catch(() => null);
          window.alert(response?.ok ? "操作已提交：请在 Servers 页轮询 observed 状态。" : "操作被拒绝或失败（详见 Servers 页）。");
          router.push("/servers");
        },
      },
    ];
  }, [router]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actions;
    return actions.filter((action) => `${action.label} ${action.hint ?? ""}`.toLowerCase().includes(q));
  }, [actions, query]);

  useEffect(() => {
    setCursor(0);
  }, [query]);
  useEffect(() => {
    if (open) {
      setQuery("");
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  const runIndex = (index: number) => {
    const action = filtered[index];
    if (!action) return;
    onOpenChange(false);
    void action.run();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-[12vh]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onOpenChange(false);
      }}
    >
      <div
        role="dialog"
        aria-label="命令面板"
        className="w-full max-w-md overflow-hidden rounded-[8px] border border-border-subtle bg-elevated shadow-[var(--shadow-pop)]"
      >
        <div className="flex items-center gap-2 border-b border-border-subtle px-3">
          <Search className="size-4 text-subtle-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") { event.preventDefault(); setCursor((c) => Math.min(c + 1, filtered.length - 1)); }
              if (event.key === "ArrowUp") { event.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); }
              if (event.key === "Enter") { event.preventDefault(); runIndex(cursor); }
              if (event.key === "Escape") { event.preventDefault(); onOpenChange(false); }
            }}
            placeholder="搜索页面或操作…（↑↓ 选择，Enter 执行）"
            className="h-10 w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-subtle-foreground"
            aria-label="搜索命令"
          />
        </div>
        <ul className="max-h-72 overflow-y-auto p-1" role="listbox">
          {filtered.length === 0 ? (
            <li className="px-3 py-6 text-center text-xs text-subtle-foreground">没有匹配的命令</li>
          ) : (
            filtered.map((action, index) => (
              <li key={action.label} role="option" aria-selected={index === cursor}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-[5px] px-2.5 py-2 text-left text-[12.5px]",
                    index === cursor ? "bg-hover text-foreground" : "text-muted-foreground",
                  )}
                  onMouseEnter={() => setCursor(index)}
                  onClick={() => runIndex(index)}
                >
                  <span className={cn("truncate", action.danger && "text-danger")}>{action.label}</span>
                  {action.hint ? <span className="hidden truncate text-[10.5px] text-subtle-foreground sm:block">{action.hint}</span> : null}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

export function RefreshButton({ onClick, pending }: { onClick: () => void; pending?: boolean }) {
  return (
    <Button variant="ghost" size="icon" aria-label="刷新" onClick={onClick} disabled={pending}>
      <RefreshCw className={pending ? "animate-spin" : undefined} />
    </Button>
  );
}

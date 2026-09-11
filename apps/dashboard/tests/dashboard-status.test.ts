// ---------------------------------------------------------------------------
// F-B4：Overview / 全局状态栏的「后端不可用」真值测试。
//
// 修前：每个 fetch 自带 `.catch(() => null)`，失败被降级成 `bots=[]`、`0/0`，
// 页面/状态栏显示健康零态，`failed` / `stale` 永不触发。
// 修后：无法确认必须是 `null` + `unavailable` + `failureMessage`；真实的空数据
// 仍照常显示（不允许把「真的没有 Bot」也标成不可用）。
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import { loadDashboardStatus, toGlobalStatusView } from "@/lib/dashboard-status";

const NOW = "2026-08-27T10:00:00.000Z";

type FetchRoute = () => Response | Promise<Response> | never;

function stubFetch(routes: Record<string, FetchRoute>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new Error(`unexpected url ${url}`);
    return await route();
  }) as typeof fetch;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const healthyStudio = {
  schemaVersion: "1.0",
  sessionId: "session-1",
  capabilities: { createBot: true },
  ai: { state: "connected", model: "glm-4.7", latencyMs: 12 },
};

const healthyLocal = { status: "ok", resource: { status: "not_running", desiredState: "off", managedByStudio: false } };

function healthyBots(bots: unknown[]): unknown {
  return {
    schemaVersion: "1.0",
    data: {
      source: "control-api",
      generatedAt: NOW,
      bots,
      capabilities: { stopConfirmationConfigured: true },
    },
  };
}

function healthyIncidents(issues: unknown[]): unknown {
  return { status: "ok", issues };
}

function healthyServers(servers: unknown[], controlApiReachable = true): unknown {
  return { schemaVersion: "1.0", generatedAt: NOW, servers, controlApiReachable, managerReachable: true, notes: [] };
}

const allHealthy: Record<string, FetchRoute> = {
  "/api/studio/status": () => json(healthyStudio),
  "/api/servers/local-test": () => json(healthyLocal),
  "/api/bots": () => json(healthyBots([
    { botId: "bot-1", connectionState: "online" },
    { botId: "bot-2", connectionState: "offline" },
  ])),
  "/api/incidents?limit=100": () => json(healthyIncidents([
    { incidentId: "INC-0001", status: "open", maxSeverity: "CRITICAL", occurrenceCount: 2 },
    { incidentId: "INC-0002", status: "fixed", maxSeverity: "WARNING", occurrenceCount: 1 },
  ])),
  "/api/servers": () => json(healthyServers([{ endpoint: "127.0.0.1:25565", counts: { ready: 1, failed: 0 } }])),
};

describe("loadDashboardStatus", () => {
  it("passes real data through and reports no failure", async () => {
    const snapshot = await loadDashboardStatus(stubFetch(allHealthy));
    expect(snapshot.bots?.map((bot) => bot.botId)).toEqual(["bot-1", "bot-2"]);
    expect(snapshot.incidents?.length).toBe(2);
    expect(snapshot.servers?.length).toBe(1);
    expect(snapshot.studio?.sessionId).toBe("session-1");
    expect(snapshot.localTest?.status).toBe("not_running");
    expect(snapshot.unavailable).toEqual([]);
    expect(snapshot.failureMessage).toBeNull();
  });

  it("keeps a genuinely empty backend as a real zero, not as unavailable", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      ...allHealthy,
      "/api/bots": () => json(healthyBots([])),
      "/api/incidents?limit=100": () => json(healthyIncidents([])),
      "/api/servers": () => json(healthyServers([])),
    }));
    expect(snapshot.bots).toEqual([]);
    expect(snapshot.incidents).toEqual([]);
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.unavailable).toEqual([]);
    expect(toGlobalStatusView(snapshot, NOW).stale).toBe(false);
    expect(toGlobalStatusView(snapshot, NOW).bots).toEqual({ online: 0, total: 0 });
  });

  it("never coerces an unreachable backend into 0/[] (all fetches reject)", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      "/api/studio/status": () => { throw new Error("ECONNREFUSED"); },
      "/api/servers/local-test": () => { throw new Error("ECONNREFUSED"); },
      "/api/bots": () => { throw new Error("ECONNREFUSED"); },
      "/api/incidents?limit=100": () => { throw new Error("ECONNREFUSED"); },
      "/api/servers": () => { throw new Error("ECONNREFUSED"); },
    }));
    expect(snapshot.bots).toBeNull();
    expect(snapshot.incidents).toBeNull();
    expect(snapshot.servers).toBeNull();
    expect(snapshot.studio).toBeNull();
    expect(snapshot.localTest).toBeNull();
    expect(snapshot.unavailable).toEqual([
      "Studio 状态",
      "Local Test",
      "Bot 列表",
      "Incident 列表",
      "Server 连接",
    ]);
    expect(snapshot.failureMessage).not.toBeNull();
    expect(snapshot.failureMessage).toContain("Bot 列表");

    const view = toGlobalStatusView(snapshot, NOW);
    expect(view.bots).toBeNull();
    expect(view.incidents).toBeNull();
    expect(view.stale).toBe(true);
    expect(view.studioMode).toBe("UNKNOWN");
  });

  it("detects the proxy's HTTP 200 'unreachable' bodies", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      ...allHealthy,
      "/api/servers/local-test": () => json({ status: "unreachable", message: "HTTP 502" }),
      "/api/incidents?limit=100": () => json({ status: "not_configured", message: "Studio Manager 未配置。" }),
      "/api/servers": () => json({ schemaVersion: "1.0", servers: [], controlApiReachable: true, managerReachable: false, notes: ["manager 不可达"] }),
    }));
    expect(snapshot.localTest).toBeNull();
    expect(snapshot.incidents).toBeNull();
    expect(snapshot.servers).toBeNull();
    expect(snapshot.unavailable).toEqual(["Local Test", "Incident 列表", "Server 连接"]);
    // 仍然可用的数据源必须保持真实
    expect(snapshot.bots?.length).toBe(2);
    expect(snapshot.studio?.sessionId).toBe("session-1");
  });

  it("isolates a failing bot list while keeping the other real sources", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      ...allHealthy,
      "/api/bots": () => json({ schemaVersion: "1.0", error: { code: "CONTROL_UNAVAILABLE", message: "down" } }, 502),
    }));
    expect(snapshot.bots).toBeNull();
    expect(snapshot.unavailable).toEqual(["Bot 列表"]);
    expect(snapshot.incidents?.length).toBe(2);
    const view = toGlobalStatusView(snapshot, NOW);
    expect(view.bots).toBeNull();
    expect(view.incidents).toEqual({ open: 1, critical: 1 });
    expect(view.stale).toBe(true);
  });

  it("flags an unreadable Control API connection state without discarding the server list", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      ...allHealthy,
      "/api/servers": () => json(healthyServers([{ endpoint: "127.0.0.1:25565", counts: { ready: 0, failed: 0 } }], false)),
    }));
    expect(snapshot.servers?.length).toBe(1);
    expect(snapshot.unavailable).toEqual(["Control API 连接态"]);
    expect(toGlobalStatusView(snapshot, NOW).stale).toBe(true);
  });

  it("rejects an unexpectedly shaped bot payload instead of showing 0/0", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      ...allHealthy,
      "/api/bots": () => json({ schemaVersion: "1.0" }),
    }));
    expect(snapshot.bots).toBeNull();
    expect(snapshot.unavailable).toEqual(["Bot 列表"]);
  });
});

describe("toGlobalStatusView", () => {
  it("derives mode, local test state and spark from a healthy snapshot", async () => {
    const snapshot = await loadDashboardStatus(stubFetch({
      ...allHealthy,
      "/api/servers/local-test": () => json({ status: "ok", resource: { status: "online", desiredState: "on", managedByStudio: true } }),
    }));
    const view = toGlobalStatusView(snapshot, NOW);
    expect(view.studioMode).toBe("LOCAL_TEST");
    expect(view.localTest).toEqual({ status: "online", managedByStudio: true });
    expect(view.spark).toEqual({ state: "connected", model: "glm-4.7", latencyMs: 12 });
    expect(view.lastRefreshAt).toBe(NOW);
    expect(view.stale).toBe(false);
  });
});

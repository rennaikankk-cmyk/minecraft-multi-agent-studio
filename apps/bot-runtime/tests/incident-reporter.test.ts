import { describe, expect, it, vi } from "vitest";

import { IncidentReporter, watchdogEventToSignal } from "../src/incident-reporter.js";

describe("IncidentReporter non-blocking semantics", () => {
  it("report() returns synchronously; endpoint absent → drop counted, no throw", () => {
    const reporter = new IncidentReporter({ botId: "bot-1" });
    reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "watchdog" });
    expect(reporter.stats.dropped).toBe(1);
    expect(reporter.stats.queued).toBe(0);
  });

  it("queues at most 32 signals; overflow dropped + counted", async () => {
    let requests = 0;
    const reporter = new IncidentReporter({
      botId: "bot-1",
      endpoint: "http://manager.test/v1/incidents",
      token: "tok",
    });
    // fetch 挂起不返回 → 队列积压
    const never = new Promise<Response>(() => undefined);
    vi.stubGlobal("fetch", vi.fn(() => { requests += 1; return never; }));
    for (let i = 0; i < 40; i += 1) {
      reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "watchdog" });
    }
    expect(requests).toBeGreaterThanOrEqual(1);
    expect(reporter.stats.queued).toBeLessThanOrEqual(32);
    expect(reporter.stats.dropped).toBeGreaterThanOrEqual(40 - 32 - 1);
    vi.unstubAllGlobals();
  });

  it("delivers with bearer token and counts success", async () => {
    const bodies: Array<{ headers: Record<string, string>; body: unknown }> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ incidentId: "INC-0001" }), { status: 201 });
    }));
    const reporter = new IncidentReporter({ botId: "bot-1", endpoint: "http://manager.test/v1/incidents", token: "secret-tok" });
    reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "watchdog" });
    await vi.waitFor(() => expect(reporter.stats.sent).toBe(1));
    expect(bodies[0]!.headers.Authorization).toBe("Bearer secret-tok");
    expect(bodies[0]!.body.botId).toBe("bot-1");
    vi.unstubAllGlobals();
  });

  it("failed delivery retries once then counts failure, never throws", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { attempts += 1; throw new Error("ECONNREFUSED"); }));
    const reporter = new IncidentReporter({ botId: "b", endpoint: "http://down.test/v1/incidents", logger: { warn: () => undefined } });
    reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "w" });
    await vi.waitFor(() => expect(reporter.stats.failed).toBe(1));
    expect(attempts).toBe(2);
    vi.unstubAllGlobals();
  });
});

describe("watchdogEventToSignal mapping", () => {
  it("stuck event → PATH_NO_PROGRESS with position/expected/actual/pathResets", () => {
    const signal = watchdogEventToSignal({
      event: { kind: "stuck", goalKey: "overworld:100,64,200", ageMs: 8_200, phaseKey: "move:furnace" },
      position: { x: 10.2, y: 65, z: -3.4 },
      dimension: "minecraft:overworld",
      skillId: "invoke-goto",
      replanCount: 16,
      expectedProgress: "target distance decreasing",
      actualProgress: "static position 45s; pathResets=16",
      eventWindow: [{ at: "2026-08-30T00:00:00Z", kind: "path_recalculated" }],
    });
    expect(signal.failureCode).toBe("PATH_NO_PROGRESS");
    expect(signal.position).toEqual({ x: 10.2, y: 65, z: -3.4 });
    expect(signal.expected).toContain("target distance");
    expect(signal.actual).toContain("pathResets=16");
    expect(signal.normalizedErrorSignature).toBe("path-resets:16");
  });
});

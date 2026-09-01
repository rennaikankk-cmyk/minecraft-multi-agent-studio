import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("failed delivery retries with bounded backoff then counts failure, never throws", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { attempts += 1; throw new Error("ECONNREFUSED"); }));
    const reporter = new IncidentReporter({ botId: "b", endpoint: "http://down.test/v1/incidents", retryBaseDelayMs: 1, logger: { warn: () => undefined } });
    reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "w" });
    await vi.waitFor(() => expect(reporter.stats.failed).toBe(1), { timeout: 5_000 });
    expect(attempts).toBe(3); // RETRY_MAX_ATTEMPTS：指数退避 + jitter，有界
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
    // replan 计数是诊断数值：stuck 事件不进 fingerprint（聚合到同一 Issue）
    expect(signal.normalizedErrorSignature).toBeUndefined();
  });
});

describe("IncidentReporter spool + idempotency (Round 6)", () => {
  it("failed delivery spills to bounded disk spool and replays on restart", async () => {
    const spoolPath = join(tmpdir(), `reporter-spool-${Date.now()}.jsonl`);
    let fail = true;
    vi.stubGlobal("fetch", vi.fn(async () => {
      if (fail) throw new Error("manager down");
      return new Response("{}", { status: 201 });
    }));
    const first = new IncidentReporter({ botId: "b", endpoint: "http://down.test/v1/incidents", spoolPath, retryBaseDelayMs: 1, logger: { warn: () => undefined } });
    first.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "w" });
    await vi.waitFor(() => expect(first.stats.spooled).toBe(1), { timeout: 5_000 });
    expect(existsSync(spoolPath)).toBe(true);

    // manager 恢复 → 新 reporter 实例重放 spool（幂等 eventId 透传）
    fail = false;
    const second = new IncidentReporter({ botId: "b", endpoint: "http://up.test/v1/incidents", spoolPath, retryBaseDelayMs: 1, logger: { warn: () => undefined } });
    await vi.waitFor(() => expect(second.stats.replayed).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(second.stats.sent).toBe(1), { timeout: 5_000 });
    vi.unstubAllGlobals();
    rmSync(spoolPath, { force: true });
  });

  it("queue drop warns (not silent) and counts", async () => {
    const warns: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
    const reporter = new IncidentReporter({ botId: "b", endpoint: "http://up.test/v1/incidents", logger: { warn: (m) => warns.push(m) } });
    // drain 是串行的：fetch mock 立即返回但 microtask 也要时间；灌满 32+ 条触发 drop
    for (let i = 0; i < 40; i += 1) {
      reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "w" });
    }
    expect(reporter.stats.dropped).toBeGreaterThan(0);
    expect(warns.some((m) => m.includes("queue_full"))).toBe(true);
    vi.unstubAllGlobals();
  });

  it("deadline-exceeded watchdog event maps to TASK_PROGRESS_TIMEOUT/TASK_TIMEOUT", () => {
    const signal = watchdogEventToSignal({
      event: { kind: "deadline-exceeded", goalKey: "overworld:1,64,2", ageMs: 45_000, phaseKey: "smelt:wait" },
      position: { x: 1, y: 64, z: 2 },
      dimension: "minecraft:overworld",
    });
    expect(signal.failureCode).toBe("TASK_PROGRESS_TIMEOUT");
    expect(signal.incidentType).toBe("TASK_TIMEOUT");
  });

  it("loop event keeps replan signature (identity essence of PATH_REPLAN_STORM)", () => {
    const signal = watchdogEventToSignal({
      event: { kind: "loop", goalKey: "overworld:1,64,2", ageMs: 20_000 },
      position: { x: 1, y: 64, z: 2 },
      dimension: "minecraft:overworld",
      replanCount: 6,
    });
    expect(signal.failureCode).toBe("PATH_REPLAN_STORM");
    expect(signal.normalizedErrorSignature).toBe("path-resets:6");
  });

  it("causal fields and runtime identity pass through", () => {
    const signal = watchdogEventToSignal({
      event: { kind: "stuck", goalKey: "overworld:1,64,2", ageMs: 8_000 },
      position: { x: 1, y: 64, z: 2 },
      dimension: "minecraft:overworld",
      runtimeInstanceId: "runtime-x",
      correlationId: "corr-x",
      goalId: "goal-x",
      buildVersion: "0.1.0",
      dirtyBuild: true,
    });
    expect(signal.runtimeInstanceId).toBe("runtime-x");
    expect(signal.correlationId).toBe("corr-x");
    expect(signal.goalId).toBe("goal-x");
    expect(signal.buildVersion).toBe("0.1.0");
    expect(signal.dirtyBuild).toBe(true);
  });
});

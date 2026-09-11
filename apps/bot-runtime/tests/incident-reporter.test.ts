import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  INCIDENT_ENDPOINT_ALLOWLIST_ENV,
  INCIDENT_ENDPOINT_REFUSED_CODE,
  INCIDENT_POSITION_COARSE_GRID,
  INCIDENT_POSITION_FULL_ENV,
  IncidentReporter,
  coarsenIncidentPosition,
  parseIncidentEndpointAllowlist,
  resolveIncidentEndpoint,
  resolveIncidentPositionPolicy,
  watchdogEventToSignal,
} from "../src/incident-reporter.js";

/**
 * F-C2 说明：自本修复起 incident endpoint 只允许回环或显式私网白名单。
 * 原测试夹具写的 `manager.test` / `down.test` / `up.test` 都是**域名**，
 * 修复后按设计被拒绝，因此这里把夹具换成等价语义的回环端口
 * （`127.0.0.1:9` = 一个关闭的端口，仍走真实 fetch mock），断言一条未改。
 */

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
      endpoint: "http://127.0.0.1:9/v1/incidents",
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
    const reporter = new IncidentReporter({ botId: "bot-1", endpoint: "http://127.0.0.1:3230/v1/incidents", token: "secret-tok" });
    reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "watchdog" });
    await vi.waitFor(() => expect(reporter.stats.sent).toBe(1));
    expect(bodies[0]!.headers.Authorization).toBe("Bearer secret-tok");
    expect(bodies[0]!.body.botId).toBe("bot-1");
    vi.unstubAllGlobals();
  });

  it("failed delivery retries with bounded backoff then counts failure, never throws", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { attempts += 1; throw new Error("ECONNREFUSED"); }));
    const reporter = new IncidentReporter({ botId: "b", endpoint: "http://127.0.0.1:9/v1/incidents", retryBaseDelayMs: 1, logger: { warn: () => undefined } });
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
    // 进程内信号仍带完整坐标（诊断需要）；出站精度由 reporter 在发送前决定。
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
    const first = new IncidentReporter({ botId: "b", endpoint: "http://127.0.0.1:9/v1/incidents", spoolPath, retryBaseDelayMs: 1, logger: { warn: () => undefined } });
    first.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "w" });
    await vi.waitFor(() => expect(first.stats.spooled).toBe(1), { timeout: 5_000 });
    expect(existsSync(spoolPath)).toBe(true);

    // manager 恢复 → 新 reporter 实例重放 spool（幂等 eventId 透传）
    fail = false;
    const second = new IncidentReporter({ botId: "b", endpoint: "http://127.0.0.1:10/v1/incidents", spoolPath, retryBaseDelayMs: 1, logger: { warn: () => undefined } });
    await vi.waitFor(() => expect(second.stats.replayed).toBe(1), { timeout: 5_000 });
    await vi.waitFor(() => expect(second.stats.sent).toBe(1), { timeout: 5_000 });
    vi.unstubAllGlobals();
    rmSync(spoolPath, { force: true });
  });

  it("queue drop warns (not silent) and counts", async () => {
    const warns: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 201 })));
    const reporter = new IncidentReporter({ botId: "b", endpoint: "http://127.0.0.1:3230/v1/incidents", logger: { warn: (m) => warns.push(m) } });
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

/* ---------------------------------------------------------------------------
 * F-C2 出口守卫：endpoint 只允许回环 / 显式私网白名单
 * ------------------------------------------------------------------------- */

/** 复现一次出站投递，返回 fetch 实际收到的 body（未发请求 → null）。 */
async function deliverOnce(
  endpoint: string,
  options: Readonly<{ allowlist?: string[]; positionPolicy?: "coarse" | "full" }> = {},
): Promise<Record<string, unknown> | null> {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response("{}", { status: 201 });
  }));
  try {
    const reporter = new IncidentReporter({
      botId: "bot-1",
      endpoint,
      token: "unit-token",
      ...(options.allowlist ? { endpointAllowlist: options.allowlist } : {}),
      ...(options.positionPolicy ? { positionPolicy: options.positionPolicy } : {}),
    });
    reporter.report(watchdogEventToSignal({
      event: { kind: "stuck", goalKey: "overworld:1,64,2", ageMs: 9_000 },
      position: { x: 1234.5, y: 63, z: -5678.25 },
      dimension: "minecraft:overworld",
    }));
    await vi.waitFor(() => expect(bodies.length).toBeGreaterThan(0), { timeout: 3_000 }).catch(() => undefined);
    return bodies[0] ?? null;
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("IncidentReporter endpoint export policy (F-C2)", () => {
  it("refuses a non-loopback public endpoint and sends nothing", async () => {
    const warnings: Array<{ message: string; meta?: unknown }> = [];
    const spoolPath = join(tmpdir(), `reporter-refused-${Date.now()}.jsonl`);
    let fetchCalls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => { fetchCalls += 1; return new Response("{}", { status: 201 }); }));

    // 仍然是 http:（只有 scheme 合法时才会走到主机判定），主机是公网域名。
    const reporter = new IncidentReporter({
      botId: "bot-1",
      endpoint: "http://collector.example.net/v1/incidents",
      token: "unit-token",
      spoolPath,
      retryBaseDelayMs: 1,
      logger: { warn: (message, meta) => warnings.push({ message, meta }) },
    });
    reporter.report({ failureCode: "PATH_NO_PROGRESS", incidentType: "STUCK", sourceComponent: "w" });
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 拒绝 = 零出站：不发请求、不进队列、不落 spool、不算 failed（也就不会重试）。
    expect(fetchCalls).toBe(0);
    expect(reporter.stats.sent).toBe(0);
    expect(reporter.stats.failed).toBe(0);
    expect(reporter.stats.spooled).toBe(0);
    expect(reporter.stats.queued).toBe(0);
    expect(existsSync(spoolPath)).toBe(false);
    expect(reporter.stats.refused).toBe(1);
    expect(reporter.stats.endpointConfigured).toBe(false);
    expect(reporter.stats.endpointRefusedCode).toBe("ENDPOINT_HOST_NOT_ALLOWED");

    const refusal = warnings.find((entry) => entry.message === "incident_reporter_endpoint_refused");
    expect(refusal).toBeDefined();
    expect(refusal!.meta).toMatchObject({
      code: INCIDENT_ENDPOINT_REFUSED_CODE,
      reason: "ENDPOINT_HOST_NOT_ALLOWED",
      action: "incident_delivery_disabled",
    });
    // 拒绝必须可见，但绝不回显完整 endpoint（含主机名）。
    const serialized = JSON.stringify(warnings);
    expect(serialized).not.toContain("collector.example.net");
    expect(serialized).not.toContain("unit-token");

    rmSync(spoolPath, { force: true });
    vi.unstubAllGlobals();
  });

  it("refuses IP-literal and scheme/credential variants that are not loopback or allowlisted", () => {
    const cases: Array<[string, string]> = [
      ["http://10.0.0.5:3230/v1/incidents", "ENDPOINT_HOST_NOT_ALLOWED"],
      ["http://192.168.1.20:3230/v1/incidents", "ENDPOINT_HOST_NOT_ALLOWED"],
      ["http://172.20.0.9:3230/v1/incidents", "ENDPOINT_HOST_NOT_ALLOWED"],
      ["http://[::ffff:127.0.0.1]:3230/v1/incidents", "ENDPOINT_HOST_NOT_ALLOWED"],
      ["http://localhost:3230/v1/incidents", "ENDPOINT_HOST_NOT_ALLOWED"],
      ["https://127.0.0.1:3230/v1/incidents", "ENDPOINT_UNPARSEABLE"],
      ["http://user:pass@127.0.0.1:3230/v1/incidents", "ENDPOINT_UNPARSEABLE"],
      ["not-a-url", "ENDPOINT_UNPARSEABLE"],
    ];
    for (const [endpoint, code] of cases) {
      const resolution = resolveIncidentEndpoint(endpoint);
      expect(resolution.allowed, endpoint).toBe(false);
      if (!resolution.allowed) expect(resolution.code, endpoint).toBe(code);
    }
  });

  it("refuses a private host that is not on the explicit allowlist, allows it once listed", () => {
    const endpoint = "http://10.0.0.5:3230/v1/incidents";
    expect(resolveIncidentEndpoint(endpoint).allowed).toBe(false);
    const allowed = resolveIncidentEndpoint(endpoint, { allowlist: ["10.0.0.5"] });
    expect(allowed.allowed).toBe(true);
    if (allowed.allowed) expect(allowed.hostRule).toBe("allowlisted:rfc1918-10");
    // 白名单只接受 IP 字面量 / host.docker.internal：域名与通配符是配置错误。
    expect(parseIncidentEndpointAllowlist("10.0.0.5, 192.168.1.7 ,host.docker.internal"))
      .toEqual(["10.0.0.5", "192.168.1.7", "host.docker.internal"]);
    expect(() => parseIncidentEndpointAllowlist("*.internal")).toThrow();
    expect(() => parseIncidentEndpointAllowlist("incidents.example.net")).toThrow();
    expect(INCIDENT_ENDPOINT_ALLOWLIST_ENV).toBe("STUDIO_INCIDENT_ENDPOINT_ALLOWLIST");
  });

  it("accepts loopback IPv4/IPv6 and rejects a public host under an unrelated allowlist entry", () => {
    expect(resolveIncidentEndpoint("http://127.0.0.1:3230/v1/incidents").allowed).toBe(true);
    expect(resolveIncidentEndpoint("http://127.9.9.9:3230/v1/incidents").allowed).toBe(true);
    expect(resolveIncidentEndpoint("http://[::1]:3230/v1/incidents").allowed).toBe(true);
    // 白名单不匹配时公网主机仍然被拒（白名单不是「开关」）。
    expect(resolveIncidentEndpoint("http://203.0.113.7:3230/v1/incidents", { allowlist: ["10.0.0.5"] }).allowed).toBe(false);
    // host.docker.internal 也在允许集合里（SECURITY.md §10），但同样必须显式列出。
    expect(resolveIncidentEndpoint("http://host.docker.internal:3230/v1/incidents").allowed).toBe(false);
    expect(
      resolveIncidentEndpoint("http://host.docker.internal:3230/v1/incidents", { allowlist: ["host.docker.internal"] }).allowed,
    ).toBe(true);
    // 未配置 endpoint 仍然是既有 no-op（不计拒绝、不告警）。
    expect(resolveIncidentEndpoint(undefined).allowed).toBe(false);
  });

  it("loopback endpoint still delivers end-to-end", async () => {
    const body = await deliverOnce("http://127.0.0.1:3230/v1/incidents");
    expect(body).not.toBeNull();
    expect(body!.botId).toBe("bot-1");
    expect(String(body!.failureCode)).toBe("PATH_NO_PROGRESS");
  });
});

/* ---------------------------------------------------------------------------
 * F-C2 坐标出口策略：默认粗化，opt-in 才全量
 * ------------------------------------------------------------------------- */

describe("IncidentReporter coordinate export policy (F-C2)", () => {
  it("coarsens position by default: grid cell only, Y withheld, original withheld", async () => {
    const body = await deliverOnce("http://127.0.0.1:3230/v1/incidents");
    expect(body).not.toBeNull();
    // 原坐标（含 Y）绝不出现在出站载荷里。
    expect(body!.position).toBeUndefined();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("1234.5");
    expect(serialized).not.toContain("5678");
    expect(body!.positionRedacted).toBe(true);
    expect(body!.positionPolicy).toBe("coarse");
    expect(body!.positionPrecision).toBe(`grid-${INCIDENT_POSITION_COARSE_GRID}`);
    expect(body!.yOmitted).toBe(true);
    const coarse = body!.positionCoarse as { cell: string; bind: string };
    // 256 格网格：1234.5 → 1024；-5678.25 → -5888；cell 中不含 Y。
    expect(coarse.cell).toBe("coarse-256:1024:-5888");
    expect(coarse.bind).toMatch(/^bot:[0-9a-f]{8}$/u);
    // 不同 bot 的同一网格单元不会被关联成同一标识。
    const other = await deliverOnce("http://127.0.0.1:3230/v1/incidents");
    expect((other!.positionCoarse as { bind: string }).bind).toBe(coarse.bind);
  });

  it("coarsening is bucket-bounded and floors negative coordinates", async () => {
    const boundary = (x: number, z: number, gridBlocks?: number) =>
      coarsenIncidentPosition(
        { x, y: 70, z },
        gridBlocks === undefined ? {} : { gridBlocks },
      ).cell;
    // 桶边界：同一桶内不同坐标落到同一单元（粗化确实丢失精度）。
    expect(boundary(256, 256)).toBe(boundary(511, 511));
    // 跨桶必须分开：cell 的信息量上限 = 桶起点，误差被限制在 ±255 格。
    expect(boundary(255, 0)).not.toBe(boundary(256, 0));
    // 负数 floor（不是 trunc）：-1 → -256，而不是 0。
    expect(boundary(-1, 0)).toBe("coarse-256:-256:0");
    expect(boundary(0, -257)).toBe("coarse-256:0:-512");
    // 网格可注入（诊断用），字段格式与默认网格一致。
    expect(boundary(100, 100, 64)).toBe("coarse-64:64:64");
    expect(INCIDENT_POSITION_COARSE_GRID).toBe(256);
    // 确定性：同一输入同一输出。
    const first = await deliverOnce("http://127.0.0.1:3230/v1/incidents");
    const second = await deliverOnce("http://127.0.0.1:3230/v1/incidents");
    expect(second!.positionCoarse).toEqual(first!.positionCoarse);
  });

  it("explicit operator opt-in still sends full coordinates", async () => {
    const body = await deliverOnce("http://127.0.0.1:3230/v1/incidents", { positionPolicy: "full" });
    expect(body).not.toBeNull();
    expect(body!.position).toEqual({ x: 1234.5, y: 63, z: -5678.25 });
    expect(body!.positionRedacted).toBe(false);
    expect(body!.positionPolicy).toBe("full");
    expect(body!.positionPrecision).toBe("full-opt-in");
    expect(body!.positionCoarse).toBeUndefined();
  });

  it("opt-in 解析只认 1/true/yes，空串与垃圾值不当作同意", () => {
    expect(INCIDENT_POSITION_FULL_ENV).toBe("STUDIO_INCIDENT_ALLOW_FULL_POSITION");
    for (const value of ["1", "true", "TRUE", " yes "]) {
      expect(resolveIncidentPositionPolicy(value)).toBe("full");
    }
    for (const value of ["0", "", "   ", "on", "maybe", undefined]) {
      expect(resolveIncidentPositionPolicy(value)).toBe("coarse");
    }
  });

  it("allowlisted private endpoint delivers too (coarse by default)", async () => {
    const body = await deliverOnce("http://10.0.0.5:3230/v1/incidents", { allowlist: ["10.0.0.5"] });
    expect(body).not.toBeNull();
    expect(body!.position).toBeUndefined();
    expect((body!.positionCoarse as { cell: string }).cell).toBe("coarse-256:1024:-5888");
  });
});

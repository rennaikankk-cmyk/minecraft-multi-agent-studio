// ---------------------------------------------------------------------------
// SharedStateServer 真 HTTP 集成测试（Phase 5）
//
// 真 node:http server + 真 fetch（非 mock）：
//   - RPC 信封往返（workstation claim race / facility 生命周期）
//   - token 鉴权（403 + 无 token 泄漏）
//   - GET/PUT snapshot 往返
//   - body 上限 / 坏 JSON / 未知路径
// ---------------------------------------------------------------------------
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SharedStateClient, SharedStateError } from "@minecraft-studio/skills";
import { smeltingLinePattern } from '@minecraft-studio/asset-policy';
import { SharedStateServer, loadSharedStateConfig } from "../src/shared-state-server.js";

const SERVER = "integration-profile";
const DIM = "minecraft:overworld";
const BOT_A = "studio-bot-01";
const BOT_B = "studio-bot-02";

describe("SharedStateServer real HTTP integration", () => {
  let server: SharedStateServer;
  let baseUrl: string;
  let client: SharedStateClient;

  beforeAll(async () => {
    server = new SharedStateServer({ host: "127.0.0.1", port: 0 });
    const address = await server.start();
    baseUrl = `http://127.0.0.1:${address.port}`;
    client = new SharedStateClient({ baseUrl });
  });

  afterAll(async () => {
    await server.stop();
  });

  it("starts on an ephemeral loopback port", () => {
    expect(baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("uses the same lease authority from an independent Node process", async () => {
    const position = { x: 80, y: 64, z: 80 };
    const owner = { ownerRuntimeId: "parent", ownerTaskId: "task", ownerAttemptId: "attempt" };
    await client.workstations.register(SERVER, DIM, "furnace", position);
    await client.workstations.claim(SERVER, DIM, position, BOT_A, undefined, owner);
    const { stdout } = await promisify(execFile)(process.execPath, ["--input-type=module", "--eval",
      `import { SharedStateClient } from '@minecraft-studio/skills';
       const c = new SharedStateClient({ baseUrl: process.argv[1] });
       const value = await c.workstations.claim(${JSON.stringify(SERVER)}, ${JSON.stringify(DIM)}, ${JSON.stringify(position)}, 'child', undefined,
         { ownerRuntimeId: 'child-runtime', ownerTaskId: 'task', ownerAttemptId: 'attempt' });
       process.stdout.write(JSON.stringify(value));`, baseUrl]);
    expect(JSON.parse(stdout)).toBe(false);
  });

  it("replays operation identities and rejects changed bodies and missing versions", async () => {
    const position = { x: 90, y: 64, z: 90 };
    await client.workstations.register(SERVER, DIM, "furnace", position);
    const request = { schemaVersion: "1.0", operationId: crypto.randomUUID(), issuedAtMs: Date.now(), op: "ws.claim",
      args: { serverProfileId: SERVER, dimension: DIM, position, botId: BOT_A,
        owner: { ownerRuntimeId: "parent", ownerTaskId: "task", ownerAttemptId: "attempt" } } };
    const rpc = async (body: unknown) => (await fetch(`${baseUrl}/rpc`, { method: "POST",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json();
    expect(await rpc(request)).toMatchObject({ ok: true, result: true, operationId: request.operationId });
    const lease = (await client.workstations.get(SERVER, DIM, position))!.lease!;
    expect(await rpc(request)).toMatchObject({ ok: true, result: true });
    expect((await client.workstations.get(SERVER, DIM, position))!.lease!.leaseId).toBe(lease.leaseId);
    expect(await rpc({ ...request, args: { ...request.args, botId: BOT_B } })).toMatchObject({ ok: false, error: "operation_conflict" });
    expect(await rpc({ op: "ws.claim", args: request.args })).toMatchObject({ ok: false, error: "bad_request" });
  });

  it("workstation register → get → claim race over real HTTP", async () => {
    const pos = { x: 10, y: 64, z: -20 };
    const entry = await client.workstations.register(SERVER, DIM, "furnace", pos);
    expect(entry.type).toBe("furnace");
    const got = await client.workstations.get(SERVER, DIM, pos);
    expect(got?.position).toEqual(pos);

    const owner = { ownerRuntimeId: "runtime-a", ownerTaskId: "task", ownerAttemptId: "attempt" };
    expect(await client.workstations.claim(SERVER, DIM, pos, BOT_A, undefined, owner)).toBe(true);
    expect(await client.workstations.claim(SERVER, DIM, pos, BOT_B, undefined, owner)).toBe(false);
    const lease = (await client.workstations.get(SERVER, DIM, pos))!.lease!;
    await client.workstations.release(SERVER, DIM, pos, BOT_A, lease);
    expect(await client.workstations.claim(SERVER, DIM, pos, BOT_B, undefined, owner)).toBe(true);
  });

  it("facility 7-state lifecycle over real HTTP", async () => {
    const facility = await client.facilities.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor: { x: 100, y: 64, z: 200 },
      orientation: "north",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(4),
    });
    expect(facility.slots.every((s) => s.status === "planned")).toBe(true);

    const slot = await client.facilities.nextPlannableSlot(facility.id);
    expect(slot?.index).toBe(0);
    expect(await client.facilities.reserveSlot(facility.id, 0, BOT_A)).toBe(true);
    expect(await client.facilities.reserveSlot(facility.id, 0, BOT_B)).toBe(false);
    expect(await client.facilities.markSlotOccupied(facility.id, 0, "ws-1")).toBe(true);
    expect(await client.facilities.markSlotMissing(facility.id, 0, "griefed")).toBe(true);

    const reloaded = await client.facilities.get(facility.id);
    expect(reloaded?.slots[0]!.status).toBe("missing");
    expect(reloaded?.slots[0]!.statusReason).toBe("griefed");
  });

  it("snapshot GET → PUT round-trip preserves state", async () => {
    const snap = await client.snapshot();
    expect(snap.workstations.entries.length).toBeGreaterThan(0);
    expect(snap.facilities.facilities.length).toBeGreaterThan(0);

    const put = await fetch(`${baseUrl}/snapshot`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(snap),
    });
    expect(put.ok).toBe(true);
    const body = (await put.json()) as { ok: boolean; result: { workstations: number; facilities: number } };
    expect(body.ok).toBe(true);
    expect(body.result.facilities).toBeGreaterThanOrEqual(snap.facilities.facilities.length);
  });

  it("unknown op returns protocol error envelope", async () => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schemaVersion: "1.0", operationId: crypto.randomUUID(), issuedAtMs: Date.now(), op: "ws.nope" }),
    });
    const envelope = (await response.json()) as { ok: boolean; error: string };
    expect(envelope.ok).toBe(false);
    expect(envelope.error).toBe("unknown_op:ws.nope");
  });

  it("bad JSON and unknown path are rejected without stack leakage", async () => {
    const badJson = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(badJson.status).toBe(400);
    const body = (await badJson.json()) as { error: string };
    expect(body.error).toBe("bad_request");

    const notFound = await fetch(`${baseUrl}/nope`);
    expect(notFound.status).toBe(404);
  });

  it("oversized body is refused (256KB cap)", async () => {
    await expect(fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "ws.register", args: { position: { x: 0, y: 0, z: 0 }, filler: "x".repeat(300_000) } }),
    })).rejects.toThrow(); // socket destroyed mid-upload
  });
});

describe("SharedStateServer token auth", () => {
  let server: SharedStateServer;
  let baseUrl: string;

  beforeAll(async () => {
    server = new SharedStateServer({ host: "127.0.0.1", port: 0, token: "secret-token-do-not-log" });
    const address = await server.start();
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await server.stop();
  });

  it("rejects unauthenticated RPC with 403", async () => {
    const response = await fetch(`${baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ op: "ws.clearServer", args: { serverProfileId: "x" } }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("accepts valid bearer token", async () => {
    const client = new SharedStateClient({ baseUrl, token: "secret-token-do-not-log" });
    const entry = await client.workstations.register(SERVER, DIM, "furnace", { x: 1, y: 2, z: 3 });
    expect(entry.type).toBe("furnace");
  });

  it("client surfaces unauthorized as SharedStateError", async () => {
    const client = new SharedStateClient({ baseUrl, logger: { warn: () => undefined } });
    await expect(client.workstations.claim(SERVER, DIM, { x: 1, y: 2, z: 3 }, BOT_A))
      .rejects.toBeInstanceOf(SharedStateError);
  });
});

describe("loadSharedStateConfig", () => {
  it("defaults to a loopback authority for local Runtime leases", () => {
    expect(loadSharedStateConfig({})).toMatchObject({ host: "127.0.0.1", port: 8791 });
  });

  it("parses port/host/token", () => {
    const config = loadSharedStateConfig({
      STUDIO_SHARED_STATE_PORT: "8791",
      STUDIO_SHARED_STATE_HOST: "0.0.0.0",
      STUDIO_SHARED_STATE_TOKEN: "t0ken",
    });
    expect(config).toEqual({ host: "0.0.0.0", port: 8791, token: "t0ken", persistPath: undefined });
  });

  it("rejects invalid port", () => {
    expect(() => loadSharedStateConfig({ STUDIO_SHARED_STATE_PORT: "not-a-port" })).toThrow();
    expect(() => loadSharedStateConfig({ STUDIO_SHARED_STATE_PORT: "70000" })).toThrow();
  });
});

describe("SharedStateServer network binding", () => {
  it("fails closed when a non-loopback host has no bearer token", async () => {
    const server = new SharedStateServer({ host: "0.0.0.0", port: 0 });
    await expect(server.start()).rejects.toThrow("SHARED_STATE_AUTH_REQUIRED");
    await server.stop();
  });
});

// ---------------------------------------------------------------------------
// Phase 6：durable persistence —— coordinator 重启后记得 Base/Facility/Workstation，
// 丢弃 lease/reservation（ephemeral）。这是四十三节 restart gate 的持久化前提。
// ---------------------------------------------------------------------------
describe("SharedStateServer durable persistence across restart", () => {
  let persistPath: string;
  let firstClient: SharedStateClient;
  let firstServer: SharedStateServer;

  beforeAll(async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    persistPath = join(mkdtempSync(join(tmpdir(), "studio-shared-state-")), "state.json");
    firstServer = new SharedStateServer({ host: "127.0.0.1", port: 0, persistPath });
    const address = await firstServer.start();
    firstClient = new SharedStateClient({ baseUrl: `http://127.0.0.1:${address.port}` });
  });

  afterAll(async () => {
    await firstServer.stop();
  });

  it("builds state, persists on stop, and a fresh server remembers durable knowledge", async () => {
    // Workstation + 观测 + lease（lease 是 ephemeral）
    await firstClient.workstations.register(SERVER, DIM, "furnace", { x: 9, y: 64, z: 9 });
    await firstClient.workstations.claim(SERVER, DIM, { x: 9, y: 64, z: 9 }, "studio-bot-01", undefined,
      { ownerRuntimeId: "runtime-a", ownerTaskId: "task", ownerAttemptId: "attempt" });

    // Facility + slot 生命周期
    const facility = await firstClient.facilities.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER,
      dimension: DIM,
      anchor: { x: 50, y: 64, z: 50 },
      orientation: "north",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(4),
      baseId: "base-restart-test",
    });
    await firstClient.facilities.reserveSlot(facility.id, 0, "studio-bot-01");
    await firstClient.facilities.markSlotOccupied(facility.id, 0, "ws-durable-1");
    // slot 1 预约但不完工（reservation 应被持久化剥离）
    await firstClient.facilities.reserveSlot(facility.id, 1, "studio-bot-01");

    // “进程重启”：stop（触发落盘）→ 同一路径新 server
    await firstServer.stop();
    const secondServer = new SharedStateServer({ host: "127.0.0.1", port: 0, persistPath });
    const secondAddress = await secondServer.start();
    try {
      const secondClient = new SharedStateClient({ baseUrl: `http://127.0.0.1:${secondAddress.port}` });

      // durable：workstation 观测还在，lease 没了
      const ws = await secondClient.workstations.get(SERVER, DIM, { x: 9, y: 64, z: 9 });
      expect(ws).not.toBeNull();
      expect(ws!.lease).toBeNull();

      // durable：facility slot 语义状态保留
      const f = await secondClient.facilities.get(facility.id);
      expect(f).not.toBeNull();
      expect(f!.slots[0]!.status).toBe("occupied");
      expect(f!.slots[0]!.workstationEntryKey).toBe("ws-durable-1");
      // ephemeral：placement reservation 被剥离 → planned，任何人可重新预约
      expect(f!.slots[1]!.status).toBe("planned");
      expect(await secondClient.facilities.reserveSlot(facility.id, 1, "studio-bot-02")).toBe(true);
      // baseId 绑定保留
      const byBase = await secondClient.facilities.findByBase("base-restart-test");
      expect(byBase.map((x) => x.id)).toContain(facility.id);
    } finally {
      await secondServer.stop();
    }
  });
});

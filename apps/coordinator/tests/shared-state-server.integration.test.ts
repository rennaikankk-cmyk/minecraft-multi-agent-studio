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

import { SharedStateClient, SharedStateError } from "@minecraft-studio/skills";
import { smeltingLinePattern } from "@minecraft-studio/skills";
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

  it("workstation register → get → claim race over real HTTP", async () => {
    const pos = { x: 10, y: 64, z: -20 };
    const entry = await client.workstations.register(SERVER, DIM, "furnace", pos);
    expect(entry.type).toBe("furnace");
    const got = await client.workstations.get(SERVER, DIM, pos);
    expect(got?.position).toEqual(pos);

    expect(await client.workstations.claim(SERVER, DIM, pos, BOT_A)).toBe(true);
    expect(await client.workstations.claim(SERVER, DIM, pos, BOT_B)).toBe(false);
    await client.workstations.release(SERVER, DIM, pos, BOT_A);
    expect(await client.workstations.claim(SERVER, DIM, pos, BOT_B)).toBe(true);
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
      body: JSON.stringify({ op: "ws.nope" }),
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
  it("returns undefined when no port is configured", () => {
    expect(loadSharedStateConfig({})).toBeUndefined();
  });

  it("parses port/host/token", () => {
    const config = loadSharedStateConfig({
      STUDIO_SHARED_STATE_PORT: "8791",
      STUDIO_SHARED_STATE_HOST: "0.0.0.0",
      STUDIO_SHARED_STATE_TOKEN: "t0ken",
    });
    expect(config).toEqual({ host: "0.0.0.0", port: 8791, token: "t0ken" });
  });

  it("rejects invalid port", () => {
    expect(() => loadSharedStateConfig({ STUDIO_SHARED_STATE_PORT: "not-a-port" })).toThrow();
    expect(() => loadSharedStateConfig({ STUDIO_SHARED_STATE_PORT: "70000" })).toThrow();
  });
});

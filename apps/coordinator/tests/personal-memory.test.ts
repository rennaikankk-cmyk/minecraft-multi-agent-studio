import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { botStatusV1Schema, type BotPersonalMemoryScope } from "@minecraft-studio/protocol";
import { BotRegistry } from "../src/bot-registry.js";
import { FilePersonalMemoryStore } from "../src/personal-memory-store.js";
import { SharedStateServer } from "../src/shared-state-server.js";

const AT = "2026-09-08T12:00:00.000Z";
const scope: BotPersonalMemoryScope = { botId: "MinerOne", serverProfileId: "server-a", worldId: "season-1" };
const position = { x: 40, y: 65, z: 20, dimension: "minecraft:overworld" };
const dirs: string[] = [];
function store() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "personal-memory-"));
  dirs.push(dir);
  return { dir, memory: new FilePersonalMemoryStore(dir) };
}
function status(identity = scope, sequence = 1, extra: Record<string, unknown> = {}) {
  return botStatusV1Schema.parse({
    schemaVersion: "1.0", messageId: randomUUID(), traceId: "personal-memory-test", timestamp: AT,
    source: { service: "bot-runtime", instanceId: `runtime-${identity.botId}-${identity.serverProfileId}-${identity.worldId}` },
    type: "bot.status.v1", botId: identity.botId,
    payload: {
      serverProfileId: identity.serverProfileId, runtimeInstanceId: `runtime-${identity.botId}-${identity.serverProfileId}-${identity.worldId}`,
      sequence, observedAt: AT, connectionState: "online", health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 }, armorPoints: 3,
      armorSlots: { head: "iron_helmet", chest: null, legs: null, feet: null },
      inventory: [{ itemName: "diamond", count: 5 }], position, latencyMs: null, currentTask: null,
      personalContext: { worldId: identity.worldId, worldSpawn: { position, observedAt: AT, source: "server_spawn_packet" }, verifiedRespawn: null },
      ...extra,
    },
  });
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("private personal memory production wiring", () => {
  it("uses opaque filenames for reserved Windows names instead of Bot IDs", () => {
    const { dir, memory } = store();
    for (const botId of ["CON", "AUX", "_Player"]) memory.observeStatus(status({ ...scope, botId }));
    expect(readdirSync(dir)).toHaveLength(3);
    expect(readdirSync(dir).every((name) => /^[a-f0-9]{64}\.json$/u.test(name))).toBe(true);
    expect(memory.get({ ...scope, botId: "CON" })?.scope.botId).toBe("CON");
    expect(memory.get({ ...scope, botId: "_Player" })?.scope.botId).toBe("_Player");
  });
  it("isolates Bot, server and world generation and survives a new Coordinator instance without restoring live readiness", () => {
    const { dir, memory } = store();
    const registry = new BotRegistry({ staleAfterMs: 5000, now: () => new Date(AT), personalMemory: memory });
    const identities = [scope, { ...scope, botId: "MinerTwo" }, { ...scope, serverProfileId: "server-b" },
      { ...scope, worldId: "season-2" }, { ...scope, worldId: null }];
    for (const [index, identity] of identities.entries()) {
      // Independent active Bots/runtimes write through the actual ingest path.
      const r = index === 0 ? registry : new BotRegistry({ staleAfterMs: 5000, now: () => new Date(AT), personalMemory: memory });
      r.ingest(status(identity, 1, { inventory: [{ itemName: "diamond", count: index + 1 }] }));
    }
    const restored = new FilePersonalMemoryStore(dir);
    const restarted = new BotRegistry({ staleAfterMs: 5000, now: () => new Date(AT), personalMemory: restored });
    expect(restarted.get(scope.botId)).toBeNull();
    expect(restarted.goalExecutionReady(scope.botId)).toBe(false);
    identities.forEach((identity, index) => expect(restored.get(identity)?.inventory?.value[0]?.count).toBe(index + 1));
    expect(restored.get({ ...scope, worldId: "new-reset" })).toBeNull();
    expect(restored.get(scope)?.equipment.value.armorSlots?.head).toBe("iron_helmet");
    expect(readdirSync(dir)).toHaveLength(5);
  });

  it("keeps missing inventory unknown, replaces a real empty inventory, and remembers death separately", () => {
    const { memory } = store();
    memory.observeStatus(status(scope, 1, { inventory: undefined, personalContext: undefined }));
    expect(memory.get({ ...scope, worldId: null })?.inventory).toBeNull();
    memory.observeStatus(status());
    memory.observeStatus(status(scope, 2, { inventory: [], lastDeath: { ...position, diedAt: AT, droppedItems: [{ itemId: "diamond", count: 5 }] } }));
    memory.observeStatus(status(scope, 3));
    expect(memory.get(scope)?.lastDeath?.value.droppedItems).toEqual([{ itemId: "diamond", count: 5 }]);
    memory.observeStatus(status(scope, 4, { inventory: [] }));
    expect(memory.get(scope)?.inventory?.value).toEqual([]);
    memory.observeStatus(status(scope, 5, { inventory: undefined }));
    expect(memory.get(scope)?.inventory?.value).toEqual([]);
  });

  it("rejects server and world scope changes by the same live Runtime before writing memory", () => {
    const { memory } = store();
    const registry = new BotRegistry({ staleAfterMs: 5000, now: () => new Date(AT), personalMemory: memory });
    registry.ingest(status());
    const wrongServer = status(scope, 2, { serverProfileId: "server-b" });
    expect(() => registry.ingest(wrongServer)).toThrow("server profile identity");
    const wrongWorld = status(scope, 2, { personalContext: { worldId: "forged", worldSpawn: null, verifiedRespawn: null } });
    expect(() => registry.ingest(wrongWorld)).toThrow("world generation identity");
    expect(memory.get({ ...scope, serverProfileId: "server-b" })).toBeNull();
    expect(memory.get({ ...scope, worldId: "forged" })).toBeNull();
    expect(registry.ingest(status(scope, 2)).accepted).toBe(true);
  });

  it("switches servers with a new Runtime and prevents retired telemetry from overwriting either memory", () => {
    const { memory } = store();
    const registry = new BotRegistry({ staleAfterMs: 5000, now: () => new Date(AT), personalMemory: memory });
    registry.ingest(status());
    const destination = { ...scope, serverProfileId: "server-b" };
    registry.ingest(status(destination, 1, { observedAt: "2026-09-08T12:00:01.000Z", inventory: [] }));
    const delayed = status(scope, 2, { observedAt: "2026-09-08T12:00:02.000Z", inventory: [] });
    expect(registry.ingest(delayed).reason).toBe("retired_runtime");
    expect(registry.get(scope.botId)?.serverProfileId).toBe("server-b");
    expect(memory.get(scope)?.inventory?.value[0]?.count).toBe(5);
    expect(memory.get(destination)?.inventory?.value).toEqual([]);
  });

  it("never treats world spawn or login position as a verified bed and retains timestamped confirmed facts only", () => {
    const { dir, memory } = store();
    memory.observeStatus(status());
    expect(memory.get(scope)?.worldSpawn?.position).toEqual(position);
    expect(memory.get(scope)?.verifiedRespawn).toBeNull();
    const bed = { position: { ...position, x: 80 }, observedAt: AT, kind: "bed", source: "server_confirmation" };
    memory.observeStatus(status(scope, 2, { personalContext: { worldId: scope.worldId, worldSpawn: null, verifiedRespawn: bed } }));
    const restored = new FilePersonalMemoryStore(dir);
    restored.observeStatus(status(scope, 3));
    expect(restored.get(scope)?.verifiedRespawn).toEqual(bed);
    expect(restored.get({ ...scope, serverProfileId: "elsewhere" })).toBeNull();
  });

  it("does not acknowledge a failed durable write as ingested and permits retry of the same message", () => {
    const { memory } = store();
    const message = status();
    let failed = true;
    const registry = new BotRegistry({ staleAfterMs: 5000, now: () => new Date(AT), personalMemory: {
      durability: "file", get: (scope) => memory.get(scope), observeStatus: (value) => {
        if (failed) throw new Error("disk unavailable");
        memory.observeStatus(value);
      },
    } });
    expect(() => registry.ingest(message)).toThrow("disk unavailable");
    expect(registry.get(scope.botId)?.currentStatus).toBeNull();
    failed = false;
    expect(registry.ingest(message).accepted).toBe(true);
    expect(memory.get(scope)?.inventory?.value[0]?.count).toBe(5);
    expect(registry.ingest(message).reason).toBe("duplicate_message");
  });

  it("rejects corrupt or transplanted files and cannot roll durable observations back after restart", () => {
    const { dir, memory } = store();
    memory.observeStatus(status(scope, 3));
    new FilePersonalMemoryStore(dir).observeStatus(status(scope, 2, { inventory: [] }));
    expect(memory.get(scope)?.sequence).toBe(3);
    const filename = path.join(dir, readdirSync(dir)[0]!);
    writeFileSync(filename, JSON.stringify({ ...memory.get(scope), scope: { ...scope, botId: "intruder" } }));
    expect(() => memory.get(scope)).toThrow("PERSONAL_MEMORY_READ_FAILED");
    writeFileSync(filename, "{bad");
    expect(() => memory.observeStatus(status(scope, 4))).toThrow("PERSONAL_MEMORY_READ_FAILED");
  });

  it("reads only an authenticated explicit Bot/server/world scope over HTTP and omits private memory from snapshots", async () => {
    const { memory } = store();
    memory.observeStatus(status());
    const server = new SharedStateServer({ personalMemory: memory, token: "test-private-token" });
    const address = await server.start();
    const url = `http://127.0.0.1:${address.port}`;
    const headers = { authorization: "Bearer test-private-token" };
    try {
      expect((await fetch(`${url}/personal-memory?botId=MinerOne&serverProfileId=server-a&worldId=season-1`)).status).toBe(403);
      expect((await fetch(`${url}/personal-memory?botId=MinerOne`, { headers })).status).toBe(400);
      const response = await fetch(`${url}/personal-memory?botId=MinerOne&serverProfileId=server-a&worldId=season-1`, { headers });
      expect(await response.json()).toMatchObject({ schemaVersion: "1.0", durability: "file", freshness: "historical", memory: { scope } });
      expect(await (await fetch(`${url}/personal-memory?botId=MinerTwo&serverProfileId=server-a&worldId=season-1`, { headers })).json()).toMatchObject({ memory: null });
      expect(JSON.stringify(await (await fetch(`${url}/snapshot`, { headers })).json())).not.toContain("diamond");
    } finally { await server.stop(); }
    const noToken = new SharedStateServer({ personalMemory: memory });
    const local = await noToken.start();
    try { expect((await fetch(`http://127.0.0.1:${local.port}/personal-memory?botId=MinerOne&serverProfileId=server-a`)).status).toBe(403); }
    finally { await noToken.stop(); }
  });
});

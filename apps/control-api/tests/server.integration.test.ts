import { createHash } from "node:crypto";

import { BotRegistry } from "@minecraft-studio/coordinator";
import type { BotStatusV1 } from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  ControlApiServer,
  type ApiPrincipalConfig,
  type ControlApiLogger,
} from "../src/index.js";

const READER_TOKEN = "control-api-reader-token-000000000001";
const POSITION_TOKEN = "control-api-position-token-000000001";
const DENIED_TOKEN = "control-api-position-only-token-00000001";

const principals: ApiPrincipalConfig[] = [
  {
    subject: "reader-01",
    tokenSha256: hash(READER_TOKEN),
    permissions: ["bot.read"],
  },
  {
    subject: "position-reader-01",
    tokenSha256: hash(POSITION_TOKEN),
    permissions: ["bot.read", "bot.position.read"],
  },
  {
    subject: "position-only-01",
    tokenSha256: hash(DENIED_TOKEN),
    permissions: ["bot.position.read"],
  },
];

const logger: ControlApiLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

const runningServers: ControlApiServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
  vi.clearAllMocks();
});

describe("Control API HTTP and WebSocket integration", () => {
  it("authenticates list/detail reads and redacts position without permission", async () => {
    const { registry, baseUrl } = await startServer();
    registry.ingest(statusMessage(1), new Date());

    const unauthorized = await fetch(`${baseUrl}/v1/bots`);
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()).error.code).toBe("AUTH_REQUIRED");
    const forbidden = await authenticatedFetch(`${baseUrl}/v1/bots`, DENIED_TOKEN);
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("PERMISSION_DENIED");

    const list = await authenticatedFetch(`${baseUrl}/v1/bots`, READER_TOKEN);
    const listBody = await list.json();
    expect(list.status).toBe(200);
    expect(listBody.data.bots).toEqual([
      expect.objectContaining({ botId: "worker-01", connectionState: "online" }),
    ]);
    expect(JSON.stringify(listBody)).not.toContain("serverProfileId");
    expect(JSON.stringify(listBody)).not.toContain("runtimeInstanceId");

    const redacted = await authenticatedFetch(
      `${baseUrl}/v1/bots/worker-01`,
      READER_TOKEN,
    );
    const redactedBody = await redacted.json();
    expect(redactedBody.data.bot).toMatchObject({
      position: null,
      positionRedacted: true,
      minecraftVersion: {
        selection: "auto",
        resolvedVersion: "1.21.8",
        supportLevel: "tested",
      },
    });
    expect(JSON.stringify(redactedBody)).not.toContain("isolated-test");

    const visible = await authenticatedFetch(
      `${baseUrl}/v1/bots/worker-01`,
      POSITION_TOKEN,
    );
    expect((await visible.json()).data.bot.position).toEqual({
      x: 10,
      y: 64,
      z: -5,
      dimension: "minecraft:overworld",
    });
  });

  it("rejects invalid input, unknown bots, and protocol mismatch", async () => {
    const { baseUrl } = await startServer();
    const invalid = await authenticatedFetch(
      `${baseUrl}/v1/bots/%2F`,
      READER_TOKEN,
    );
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error.code).toBe("INVALID_REQUEST");

    const missing = await authenticatedFetch(
      `${baseUrl}/v1/bots/missing-bot`,
      READER_TOKEN,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("BOT_NOT_FOUND");

    const incompatible = await fetch(`${baseUrl}/v1/bots`, {
      headers: {
        Authorization: `Bearer ${READER_TOKEN}`,
        "X-Studio-Schema-Version": "2.0",
      },
    });
    expect(incompatible.status).toBe(400);
    expect((await incompatible.json()).error.code).toBe(
      "UNSUPPORTED_SCHEMA_VERSION",
    );
  });

  it("enforces request rate limits", async () => {
    const { baseUrl } = await startServer({ requestLimitPerMinute: 1 });
    expect((await authenticatedFetch(`${baseUrl}/v1/bots`, READER_TOKEN)).status).toBe(
      200,
    );
    const limited = await authenticatedFetch(`${baseUrl}/v1/bots`, READER_TOKEN);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error.code).toBe("RATE_LIMITED");
  });

  it("sends a snapshot first and then ordered incremental events", async () => {
    const { registry, webSocketUrl } = await startServer();
    registry.ingest(statusMessage(1), new Date());
    const authProtocol = `auth.${Buffer.from(READER_TOKEN).toString("base64url")}`;
    const { webSocket, firstMessage } = await connectWebSocket(webSocketUrl, [
      "minecraft-studio.v1",
      authProtocol,
    ]);

    expect(firstMessage).toMatchObject({
      type: "bot.stream.snapshot.v1",
      payload: { bots: [expect.objectContaining({ botId: "worker-01" })] },
    });
    const eventPromise = nextMessage(webSocket);
    registry.ingest(heartbeatMessage(2), new Date());
    const event = await eventPromise;
    expect(event).toMatchObject({
      type: "bot.stream.event.v1",
      payload: {
        event: "upsert",
        bot: expect.objectContaining({ botId: "worker-01" }),
      },
    });
    expect(event.streamSequence).toBeGreaterThan(firstMessage.streamSequence);
    webSocket.close();
  });

  it("rejects incompatible WebSocket protocols and remains read-only", async () => {
    const { webSocketUrl } = await startServer();
    expect(await rejectedWebSocketStatus(webSocketUrl, ["minecraft-studio.v2"])).toBe(
      426,
    );
    expect(
      await rejectedWebSocketStatus(webSocketUrl, ["minecraft-studio.v1"]),
    ).toBe(401);

    const { webSocket } = await connectWebSocket(
      webSocketUrl,
      ["minecraft-studio.v1"],
      READER_TOKEN,
    );
    const closed = new Promise<number>((resolve) =>
      webSocket.once("close", (code) => resolve(code)),
    );
    webSocket.send(JSON.stringify({ command: "stop" }));
    expect(await closed).toBe(1008);
  });
});

async function startServer(
  overrides: Partial<{
    requestLimitPerMinute: number;
  }> = {},
): Promise<{
  registry: BotRegistry;
  baseUrl: string;
  webSocketUrl: string;
}> {
  const registry = new BotRegistry({ staleAfterMs: 30_000 });
  const server = new ControlApiServer({
    host: "127.0.0.1",
    port: 0,
    registry,
    principals,
    logger,
    staleSweepIntervalMs: 10_000,
    webSocketPingIntervalMs: 10_000,
    randomId: uuidSequence(),
    ...overrides,
  });
  runningServers.push(server);
  const address = await server.start();
  return {
    registry,
    baseUrl: `http://127.0.0.1:${address.port}`,
    webSocketUrl: `ws://127.0.0.1:${address.port}/v1/bots/stream`,
  };
}

function authenticatedFetch(url: string, token: string): Promise<Response> {
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
}

function connectWebSocket(
  url: string,
  protocols: string[],
  bearerToken?: string,
): Promise<{ webSocket: WebSocket; firstMessage: any }> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, protocols, {
      ...(bearerToken
        ? { headers: { Authorization: `Bearer ${bearerToken}` } }
        : {}),
    });
    let firstMessage: any;
    webSocket.once("message", (data) => {
      firstMessage = JSON.parse(data.toString());
      if (webSocket.readyState === WebSocket.OPEN) {
        resolve({ webSocket, firstMessage });
      }
    });
    webSocket.once("error", reject);
  });
}

function nextMessage(webSocket: WebSocket): Promise<any> {
  return new Promise((resolve, reject) => {
    webSocket.once("message", (data) => resolve(JSON.parse(data.toString())));
    webSocket.once("error", reject);
  });
}

function rejectedWebSocketStatus(url: string, protocols: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const webSocket = new WebSocket(url, protocols);
    webSocket.once("unexpected-response", (_request, response) => {
      const status = response.statusCode ?? 0;
      response.resume();
      resolve(status);
    });
    webSocket.once("error", () => undefined);
    webSocket.once("open", () => {
      webSocket.close();
      reject(new Error("Expected WebSocket upgrade rejection."));
    });
  });
}

function statusMessage(sequence: number): BotStatusV1 {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0",
    messageId: testUuid(sequence),
    traceId: "trace-api-test",
    timestamp: now,
    source: { service: "bot-runtime", instanceId: "runtime-api-test" },
    botId: "worker-01",
    type: "bot.status.v1",
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-api-test",
      sequence,
      observedAt: now,
      connectionState: "online",
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 10, y: 64, z: -5, dimension: "minecraft:overworld" },
      latencyMs: 15,
      currentTask: null,
      minecraftVersion: {
        selection: "auto",
        requestedVersion: null,
        resolvedVersion: "1.21.8",
        supportLevel: "tested",
        supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
      },
    },
  };
}

function heartbeatMessage(sequence: number) {
  const now = new Date().toISOString();
  return {
    schemaVersion: "1.0" as const,
    messageId: testUuid(sequence),
    traceId: "trace-api-test",
    timestamp: now,
    source: { service: "bot-runtime" as const, instanceId: "runtime-api-test" },
    botId: "worker-01",
    type: "bot.heartbeat.v1" as const,
    payload: {
      serverProfileId: "isolated-test",
      runtimeInstanceId: "runtime-api-test",
      sequence,
      observedAt: now,
      connectionState: "online" as const,
      uptimeMs: sequence * 1_000,
      lastStatusSequence: 1,
      currentTaskId: null,
    },
  };
}

function uuidSequence(): () => string {
  let value = 1_000;
  return () => testUuid(++value);
}

function testUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

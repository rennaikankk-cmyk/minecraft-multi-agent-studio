import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
  BotDisconnectInfo,
} from "../src/client.js";
import { SingleBotRuntime } from "../src/runtime.js";
import type { ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

const FIXED_UUID = "11111111-1111-4111-8111-111111111111";

const profile: ServerProfile = {
  schemaVersion: "1.0",
  id: "local-isolated-test",
  botId: "studio-bot-01",
  purpose: "isolated-test",
  networkScope: "loopback",
  host: "127.0.0.1",
  port: 25565,
  minecraftVersion: "1.21.8",
  username: "StudioBot",
  auth: "offline",
  statusIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
  stopGracePeriodMs: 5000,
  reconnect: {
    enabled: true,
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2000,
  },
};

const snapshot: BotClientSnapshot = {
  health: { current: 18, maximum: 20 },
  food: { level: 16, saturation: 4.5 },
  armorPoints: 7,
  position: { x: 10.25, y: 64, z: -20.5, dimension: "minecraft:overworld" },
  latencyMs: 45,
};

class FakeBotClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  closeCalls = 0;

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    return structuredClone(snapshot);
  }

  versionCompatibility() {
    return {
      selection: "fixed" as const,
      requestedVersion: "1.21.8",
      resolvedVersion: "1.21.8",
      supportLevel: "tested" as const,
      supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
    };
  }

  async close(): Promise<void> {
    this.closeCalls += 1;
    this.handlers?.onDisconnected({ reason: "requested_stop", expected: true });
  }

  spawn(): void {
    this.handlers?.onSpawn();
  }

  stateChanged(): void {
    this.handlers?.onStateChanged();
  }

  versionUnsupported(): void {
    this.handlers?.onVersionUnsupported();
  }

  disconnect(info: BotDisconnectInfo): void {
    this.handlers?.onDisconnected(info);
  }
}

const logger: RuntimeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe("SingleBotRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-19T10:00:00.000Z"));
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits connecting heartbeat and real snapshot after spawn", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => client,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    expect(messages[0]).toMatchObject({
      type: "bot.heartbeat.v1",
      payload: { connectionState: "connecting" },
    });

    client.spawn();
    const status = messages.find(
      (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
        message.type === "bot.status.v1",
    );
    expect(status?.payload).toMatchObject({
      connectionState: "online",
      health: snapshot.health,
      food: snapshot.food,
      armorPoints: snapshot.armorPoints,
      position: snapshot.position,
      latencyMs: snapshot.latencyMs,
      currentTask: null,
    });
    expect(runtime.getState()).toBe("online");
    expect(runtime.getMetricsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "bot_connection_attempts_total",
          value: 1,
        }),
        expect.objectContaining({ name: "bot_heartbeats_total", value: 2 }),
      ]),
    );

    client.stateChanged();
    await vi.advanceTimersByTimeAsync(1000);
    expect(messages.filter(({ type }) => type === "bot.status.v1").length).toBe(2);

    await runtime.stop();
    expect(client.closeCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
    expect(messages.at(-1)).toMatchObject({
      type: "bot.disconnected.v1",
      payload: { reason: "requested_stop", expected: true },
    });
  });

  it("reconnects with bounded backoff after an unexpected disconnect", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const clients = [new FakeBotClient(), new FakeBotClient()];
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => clients[factoryCalls++]!,
      messageSink: (message) => messages.push(message),
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    clients[0]!.disconnect({
      reason: "network_error",
      expected: false,
      detail: "isolated_test_disconnect",
    });
    expect(factoryCalls).toBe(1);
    expect(messages.some(({ type }) => type === "bot.disconnected.v1")).toBe(true);
    expect(runtime.getMetricsSnapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "bot_disconnects_total", value: 1 }),
        expect.objectContaining({
          name: "bot_reconnects_scheduled_total",
          value: 1,
        }),
      ]),
    );

    await vi.advanceTimersByTimeAsync(499);
    expect(factoryCalls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(factoryCalls).toBe(2);
    expect(runtime.getState()).toBe("connecting");
    expect(
      runtime.getMetricsSnapshot().find(
        ({ name }) => name === "bot_connection_attempts_total",
      )?.value,
    ).toBe(2);

    await runtime.stop();
    expect(clients[1]!.closeCalls).toBe(1);
  });

  it("does not retry after an explicit stop", async () => {
    const client = new FakeBotClient();
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(profile, {
      createClient: () => {
        factoryCalls += 1;
        return client;
      },
      messageSink: () => undefined,
      logger,
      now: () => new Date(Date.now()),
      randomId: () => FIXED_UUID,
    });

    runtime.start();
    client.spawn();
    await runtime.stop("SIGTERM");
    await vi.advanceTimersByTimeAsync(10_000);

    expect(factoryCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
  });

  it("reports an unsupported version and suppresses deterministic retries", async () => {
    const messages: BotTelemetryMessageV1[] = [];
    const client = new FakeBotClient();
    let factoryCalls = 0;
    const runtime = new SingleBotRuntime(
      { ...profile, minecraftVersion: "auto" },
      {
        createClient: () => {
          factoryCalls += 1;
          return client;
        },
        messageSink: (message) => messages.push(message),
        logger,
        now: () => new Date(Date.now()),
        randomId: () => FIXED_UUID,
      },
    );

    runtime.start();
    client.versionUnsupported();
    client.disconnect({
      reason: "runtime_error",
      expected: false,
      detail: "unsupported_minecraft_version",
    });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(factoryCalls).toBe(1);
    expect(runtime.getState()).toBe("offline");
    expect(messages).toContainEqual(
      expect.objectContaining({
        type: "bot.version.v1",
        payload: expect.objectContaining({
          compatibility: expect.objectContaining({
            selection: "auto",
            supportLevel: "unsupported",
          }),
        }),
      }),
    );
  });
});

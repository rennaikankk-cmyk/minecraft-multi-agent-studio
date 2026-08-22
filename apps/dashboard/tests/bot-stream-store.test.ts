import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useBotStore } from "../stores/bot-store";

const NOW = "2026-08-08T08:00:00.000Z";
const UUID = "33333333-3333-4333-8333-333333333333";

const instances: FakeEventSource[] = [];

class FakeEventSource {
  static CONNECTING = 0;
  readonly url: string;
  readonly listeners = new Map<string, Array<(event: unknown) => void>>();
  onerror: ((event: unknown) => void) | null = null;
  closed = false;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(name: string, listener: (event: unknown) => void): void {
    const existing = this.listeners.get(name) ?? [];
    existing.push(listener);
    this.listeners.set(name, existing);
  }

  close(): void {
    this.closed = true;
  }

  emit(name: string, data?: string): void {
    for (const listener of this.listeners.get(name) ?? []) {
      listener({ data });
    }
  }
}

function bot(botId: string, overrides: Record<string, unknown> = {}) {
  return {
    botId,
    connectionState: "online",
    lastMessageAt: NOW,
    lastHeartbeatAt: NOW,
    lastStatusAt: NOW,
    health: { current: 20, maximum: 20 },
    food: { level: 20, saturation: 5 },
    armorPoints: 20,
    latencyMs: 40,
    currentTask: null,
    position: null,
    positionRedacted: true,
    minecraftVersion: null,
    combat: null,
    ...overrides,
  };
}

function snapshotFrame(sequence: number, bots: unknown[]): string {
  return JSON.stringify({
    requestId: UUID,
    message: {
      schemaVersion: "1.0",
      messageId: UUID,
      timestamp: NOW,
      streamSequence: sequence,
      type: "bot.stream.snapshot.v1",
      payload: { bots },
    },
  });
}

function eventFrame(sequence: number, upserted: unknown): string {
  return JSON.stringify({
    requestId: UUID,
    message: {
      schemaVersion: "1.0",
      messageId: UUID,
      timestamp: NOW,
      streamSequence: sequence,
      type: "bot.stream.event.v1",
      payload: { event: "upsert", bot: upserted },
    },
  });
}

function listBody() {
  return {
    schemaVersion: "1.0",
    requestId: UUID,
    data: {
      source: "control-api",
      generatedAt: NOW,
      bots: [],
      capabilities: { stopConfirmationConfigured: false },
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  instances.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(listBody()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })),
  );
  useBotStore.setState({
    loadState: "idle",
    refreshing: false,
    streamState: "idle",
    bots: [],
    generatedAt: null,
    requestId: null,
    error: null,
    stopConfirmationConfigured: false,
    stopState: "idle",
    stopBotId: null,
    stopTraceId: null,
    stopMessage: null,
  });
});

afterEach(() => {
  useBotStore.getState().stopLive();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Bot store live stream", () => {
  it("applies a validated snapshot and goes live", async () => {
    useBotStore.getState().startLive();
    await vi.runOnlyPendingTimersAsync();
    const source = instances[0]!;
    source.emit("snapshot", snapshotFrame(5, [bot("worker-01")]));
    expect(useBotStore.getState()).toMatchObject({
      streamState: "live",
      loadState: "ready",
      bots: [expect.objectContaining({ botId: "worker-01" })],
    });
  });

  it("applies in-order upserts and drops stale ones", async () => {
    useBotStore.getState().startLive();
    await vi.runOnlyPendingTimersAsync();
    const source = instances[0]!;
    source.emit("snapshot", snapshotFrame(5, [bot("worker-01")]));
    source.emit(
      "event",
      eventFrame(6, bot("worker-01", { connectionState: "stopping" })),
    );
    expect(useBotStore.getState().bots[0]).toMatchObject({
      connectionState: "stopping",
    });
    // A replayed/out-of-order delta must not regress the state.
    source.emit(
      "event",
      eventFrame(6, bot("worker-01", { connectionState: "online" })),
    );
    expect(useBotStore.getState().bots[0]).toMatchObject({
      connectionState: "stopping",
    });
  });

  it("adds a new bot from an upsert", async () => {
    useBotStore.getState().startLive();
    await vi.runOnlyPendingTimersAsync();
    const source = instances[0]!;
    source.emit("snapshot", snapshotFrame(1, [bot("worker-01")]));
    source.emit("event", eventFrame(2, bot("worker-02")));
    expect(useBotStore.getState().bots.map((entry) => entry.botId)).toEqual([
      "worker-01",
      "worker-02",
    ]);
  });

  it("falls back to explicit polling when the stream reports an error", async () => {
    useBotStore.getState().startLive();
    await vi.runOnlyPendingTimersAsync();
    const source = instances[0]!;
    source.emit("stream-error", JSON.stringify({ code: "UPSTREAM_UNAVAILABLE" }));
    expect(useBotStore.getState().streamState).toBe("fallback-polling");
    expect(source.closed).toBe(true);
  });

  it("fails closed on a schema-invalid stream frame", async () => {
    useBotStore.getState().startLive();
    await vi.runOnlyPendingTimersAsync();
    const source = instances[0]!;
    source.emit(
      "snapshot",
      JSON.stringify({ requestId: UUID, message: { type: "bot.stream.snapshot.v1" } }),
    );
    expect(useBotStore.getState().streamState).toBe("fallback-polling");
    expect(source.closed).toBe(true);
  });

  it("stopLive tears the stream down", async () => {
    useBotStore.getState().startLive();
    await vi.runOnlyPendingTimersAsync();
    const source = instances[0]!;
    useBotStore.getState().stopLive();
    expect(source.closed).toBe(true);
    expect(useBotStore.getState().streamState).toBe("idle");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { FakeSocket, sockets } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");

  class FakeSocket extends EventEmitter {
    readonly url: string;
    readonly protocols: readonly string[];
    readonly options: Record<string, unknown>;
    terminated = false;

    constructor(url: URL, protocols: string[], options: Record<string, unknown>) {
      super();
      this.url = url.toString();
      this.protocols = protocols;
      this.options = options;
      sockets.push(this);
    }

    terminate(): void {
      this.terminated = true;
    }
  }

  const sockets: FakeSocket[] = [];

  return { FakeSocket, sockets };
});

vi.mock("ws", () => ({ WebSocket: FakeSocket }));

import { openBotStreamProxy } from "../lib/bot-stream-proxy";

const NOW = "2026-08-08T08:00:00.000Z";
const UUID = "22222222-2222-4222-8222-222222222222";

const config = {
  baseUrl: "http://127.0.0.1:3210",
  token: "a".repeat(64),
  stopConfirmationSha256: null,
} as const;

function snapshotMessage(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    messageId: UUID,
    timestamp: NOW,
    streamSequence: 1,
    type: "bot.stream.snapshot.v1",
    payload: { bots: [] },
  };
}

function collectEvents() {
  const events: unknown[] = [];
  let closed = false;
  return {
    events,
    isClosed: () => closed,
    callbacks: {
      onEvent(event: unknown) {
        events.push(event);
      },
      onClose() {
        closed = true;
      },
    },
  };
}

beforeEach(() => {
  sockets.length = 0;
});

describe("openBotStreamProxy", () => {
  it("connects with the bearer token in headers only", () => {
    const sink = collectEvents();
    openBotStreamProxy(config, sink.callbacks);
    const socket = sockets[0]!;
    expect(socket.url).toBe("ws://127.0.0.1:3210/v1/bots/stream");
    expect(socket.protocols).toEqual(["minecraft-studio.v1"]);
    expect(
      (socket.options.headers as Record<string, string>).authorization,
    ).toBe(`Bearer ${config.token}`);
  });

  it("forwards a schema-valid snapshot then upsert events", () => {
    const sink = collectEvents();
    openBotStreamProxy(config, sink.callbacks);
    const socket = sockets[0]!;
    socket.emit("message", Buffer.from(JSON.stringify(snapshotMessage())), false);
    expect(sink.events).toEqual([
      expect.objectContaining({ kind: "snapshot" }),
    ]);
    expect(sink.isClosed()).toBe(false);
  });

  it("fails closed on a schema-invalid first frame without forwarding it", () => {
    const sink = collectEvents();
    openBotStreamProxy(config, sink.callbacks);
    const socket = sockets[0]!;
    socket.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "bot.stream.snapshot.v1", fake: true })),
      false,
    );
    expect(sink.events).toEqual([
      { kind: "stream-error", code: "INVALID_STREAM_MESSAGE" },
    ]);
    expect(sink.isClosed()).toBe(true);
    expect(socket.terminated).toBe(true);
  });

  it("fails closed on non-JSON and on binary frames", () => {
    for (const frame of [
      { data: Buffer.from("not-json"), binary: false },
      { data: Buffer.from([1, 2, 3]), binary: true },
    ]) {
      sockets.length = 0;
      const sink = collectEvents();
      openBotStreamProxy(config, sink.callbacks);
      sockets[0]!.emit("message", frame.data, frame.binary);
      expect(sink.events).toEqual([
        { kind: "stream-error", code: "INVALID_STREAM_MESSAGE" },
      ]);
      expect(sink.isClosed()).toBe(true);
    }
  });

  it("maps upstream auth rejection and unavailability to distinct codes", () => {
    const rejected = collectEvents();
    openBotStreamProxy(config, rejected.callbacks);
    sockets[0]!.emit("unexpected-response", {}, { statusCode: 401 });
    expect(rejected.events).toEqual([
      { kind: "stream-error", code: "UPSTREAM_REJECTED" },
    ]);

    sockets.length = 0;
    const unavailable = collectEvents();
    openBotStreamProxy(config, unavailable.callbacks);
    sockets[0]!.emit("error", new Error("connect ECONNREFUSED"));
    expect(unavailable.events).toEqual([
      { kind: "stream-error", code: "UPSTREAM_UNAVAILABLE" },
    ]);
  });

  it("reports a close after snapshot as STREAM_CLOSED and stops forwarding", () => {
    const sink = collectEvents();
    const handle = openBotStreamProxy(config, sink.callbacks);
    const socket = sockets[0]!;
    socket.emit("message", Buffer.from(JSON.stringify(snapshotMessage())), false);
    socket.emit("close");
    expect(sink.events[1]).toEqual({ kind: "stream-error", code: "STREAM_CLOSED" });
    expect(sink.isClosed()).toBe(true);
    // Further frames after close are ignored.
    socket.emit("message", Buffer.from(JSON.stringify(snapshotMessage())), false);
    expect(sink.events).toHaveLength(2);
    handle.close();
  });

  it("close() tears down silently without emitting an error", () => {
    const sink = collectEvents();
    const handle = openBotStreamProxy(config, sink.callbacks);
    handle.close();
    expect(sink.events).toEqual([]);
    expect(sink.isClosed()).toBe(true);
    expect(sockets[0]!.terminated).toBe(true);
  });

  it("never places the token in forwarded events", () => {
    const sink = collectEvents();
    openBotStreamProxy(config, sink.callbacks);
    sockets[0]!.emit("message", Buffer.from(JSON.stringify(snapshotMessage())), false);
    expect(JSON.stringify(sink.events)).not.toContain(config.token);
  });
});

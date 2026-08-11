import {
  botStreamEventV1Schema,
  botStreamSnapshotV1Schema,
  type BotStreamEventV1,
  type BotStreamSnapshotV1,
} from "@minecraft-studio/protocol";
import { WebSocket } from "ws";

import type { DashboardControlConfig } from "@/lib/control-api-client";

const APPLICATION_PROTOCOL = "minecraft-studio.v1";
const MAX_UPSTREAM_MESSAGE_BYTES = 1_048_576;
const UPSTREAM_CONNECT_TIMEOUT_MS = 8_000;

export type BotStreamProxyEvent =
  | Readonly<{ kind: "snapshot"; message: BotStreamSnapshotV1 }>
  | Readonly<{ kind: "event"; message: BotStreamEventV1 }>
  | Readonly<{ kind: "stream-error"; code: BotStreamProxyErrorCode }>;

export type BotStreamProxyErrorCode =
  | "UPSTREAM_UNAVAILABLE"
  | "UPSTREAM_REJECTED"
  | "INVALID_STREAM_MESSAGE"
  | "STREAM_CLOSED";

export type BotStreamProxyHandle = Readonly<{
  close(): void;
}>;

export type BotStreamProxyCallbacks = Readonly<{
  onEvent(event: BotStreamProxyEvent): void;
  onClose(): void;
}>;

/**
 * Bridges the Control API bot WebSocket stream into validated events for an
 * SSE response. Every upstream frame is re-validated against the versioned
 * protocol schema before it is forwarded; the first invalid frame terminates
 * the stream (fail-closed) instead of forwarding unverified data. The Control
 * API token stays inside this server-side connection and never appears in any
 * forwarded event.
 */
export function openBotStreamProxy(
  config: DashboardControlConfig,
  callbacks: BotStreamProxyCallbacks,
): BotStreamProxyHandle {
  const streamUrl = new URL("/v1/bots/stream", config.baseUrl);
  streamUrl.protocol = "ws:";

  let settled = false;
  let sawSnapshot = false;

  const socket = new WebSocket(streamUrl, [APPLICATION_PROTOCOL], {
    headers: { authorization: `Bearer ${config.token}` },
    maxPayload: MAX_UPSTREAM_MESSAGE_BYTES,
    handshakeTimeout: UPSTREAM_CONNECT_TIMEOUT_MS,
  });

  const finish = (errorCode: BotStreamProxyErrorCode | null) => {
    if (settled) return;
    settled = true;
    if (errorCode !== null) {
      callbacks.onEvent({ kind: "stream-error", code: errorCode });
    }
    try {
      socket.terminate();
    } catch {
      // The socket may already be closed; closing twice is harmless.
    }
    callbacks.onClose();
  };

  socket.on("unexpected-response", (_request, response) => {
    finish(
      response.statusCode === 401 || response.statusCode === 403
        ? "UPSTREAM_REJECTED"
        : "UPSTREAM_UNAVAILABLE",
    );
  });

  socket.on("error", () => {
    finish("UPSTREAM_UNAVAILABLE");
  });

  socket.on("close", () => {
    finish(sawSnapshot ? "STREAM_CLOSED" : "UPSTREAM_UNAVAILABLE");
  });

  socket.on("message", (data, isBinary) => {
    if (settled) return;
    if (isBinary) {
      finish("INVALID_STREAM_MESSAGE");
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString("utf8"));
    } catch {
      finish("INVALID_STREAM_MESSAGE");
      return;
    }
    if (!sawSnapshot) {
      const snapshot = botStreamSnapshotV1Schema.safeParse(parsed);
      if (!snapshot.success) {
        finish("INVALID_STREAM_MESSAGE");
        return;
      }
      sawSnapshot = true;
      callbacks.onEvent({ kind: "snapshot", message: snapshot.data });
      return;
    }
    const event = botStreamEventV1Schema.safeParse(parsed);
    if (!event.success) {
      finish("INVALID_STREAM_MESSAGE");
      return;
    }
    callbacks.onEvent({ kind: "event", message: event.data });
  });

  return {
    close() {
      finish(null);
    },
  };
}

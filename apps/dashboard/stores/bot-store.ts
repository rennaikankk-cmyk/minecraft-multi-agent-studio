"use client";

import {
  botStreamEventV1Schema,
  botStreamSnapshotV1Schema,
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  dashboardStopResponseV1Schema,
  type PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import { create } from "zustand";

type LoadState = "idle" | "loading" | "ready" | "error";
type StopState = "idle" | "submitting" | "completed" | "failed";
export type StreamState =
  | "idle"
  | "connecting"
  | "live"
  | "fallback-polling"
  | "error";

type BotStore = {
  loadState: LoadState;
  refreshing: boolean;
  streamState: StreamState;
  bots: PublicBotDetailV1[];
  generatedAt: string | null;
  requestId: string | null;
  error: { code: string; message: string } | null;
  stopConfirmationConfigured: boolean;
  stopState: StopState;
  stopBotId: string | null;
  stopTraceId: string | null;
  stopMessage: string | null;
  refresh(): Promise<void>;
  startLive(): void;
  stopLive(): void;
  stopBot(botId: string, confirmationCode: string): Promise<boolean>;
  resetStopResult(): void;
};

const POLL_INTERVAL_MS = 3_000;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS = 60_000;

let refreshSequence = 0;

// Live-stream connection state lives outside the zustand store: it is
// process-wide plumbing (sockets, timers), not renderable state.
let eventSource: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
let lastStreamSequence = -1;
let liveClients = 0;

function upsertBot(
  bots: readonly PublicBotDetailV1[],
  bot: PublicBotDetailV1,
): PublicBotDetailV1[] {
  const index = bots.findIndex((existing) => existing.botId === bot.botId);
  if (index === -1) return [...bots, bot];
  const next = [...bots];
  next[index] = bot;
  return next;
}

export const useBotStore = create<BotStore>((set, get) => ({
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

  async refresh() {
    const sequence = ++refreshSequence;
    const initial = get().loadState === "idle";
    set({
      ...(initial ? { loadState: "loading" as const } : {}),
      refreshing: !initial,
      error: null,
    });
    try {
      const response = await fetch("/api/bots", { cache: "no-store" });
      const value = await safeJson(response);
      if (!response.ok) throw apiError(value, "机器人状态后端不可用。");
      const parsed = dashboardBotListResponseV1Schema.safeParse(value);
      if (!parsed.success) throw new Error("机器人状态接口返回了无法识别的数据。");
      if (sequence !== refreshSequence) return;
      set({
        loadState: "ready",
        refreshing: false,
        bots: parsed.data.data.bots,
        generatedAt: parsed.data.data.generatedAt,
        requestId: parsed.data.requestId,
        stopConfirmationConfigured:
          parsed.data.data.capabilities.stopConfirmationConfigured,
        error: null,
      });
    } catch (cause) {
      if (sequence !== refreshSequence) return;
      const normalized = cause instanceof Error
        ? { code: "BOT_STATUS_UNAVAILABLE", message: cause.message }
        : { code: "BOT_STATUS_UNAVAILABLE", message: "机器人状态后端不可用。" };
      set({
        loadState: "error",
        refreshing: false,
        bots: [],
        generatedAt: null,
        requestId: null,
        stopConfirmationConfigured: false,
        error: normalized,
      });
    }
  },

  startLive() {
    liveClients += 1;
    if (liveClients > 1) return;
    // Capabilities (stop confirmation) only travel on the list endpoint, so
    // always take one polled snapshot before switching to the stream.
    void get().refresh();
    openStream(set, get);
  },

  stopLive() {
    liveClients = Math.max(0, liveClients - 1);
    if (liveClients > 0) return;
    teardownStream();
    stopFallbackPolling();
    set({ streamState: "idle" });
  },

  async stopBot(botId, confirmationCode) {
    const requestId = crypto.randomUUID();
    set({
      stopState: "submitting",
      stopBotId: botId,
      stopTraceId: requestId,
      stopMessage: null,
    });
    try {
      const response = await fetch(`/api/bots/${encodeURIComponent(botId)}/stop`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Studio-Action": "stop-bot",
        },
        body: JSON.stringify({
          schemaVersion: "1.0",
          requestId,
          confirmationCode,
        }),
      });
      const value = await safeJson(response);
      if (!response.ok) throw apiError(value, "停止操作未能完成。");
      const parsed = dashboardStopResponseV1Schema.safeParse(value);
      if (!parsed.success || parsed.data.data.botId !== botId) {
        throw new Error("停止接口返回了无法识别的结果。");
      }
      const completed = parsed.data.data.outcome === "completed";
      set({
        stopState: completed ? "completed" : "failed",
        stopBotId: botId,
        stopTraceId: parsed.data.data.traceId,
        stopMessage: completed
          ? `机器人 ${botId} 已确认停止。`
          : `机器人 ${botId} 返回 ${parsed.data.data.outcome}（${parsed.data.data.errorCode ?? "UNKNOWN"}）。`,
      });
      await get().refresh();
      return completed;
    } catch (cause) {
      set({
        stopState: "failed",
        stopBotId: botId,
        stopTraceId: requestId,
        stopMessage: cause instanceof Error ? cause.message : "停止操作未能完成。",
      });
      return false;
    }
  },

  resetStopResult() {
    set({ stopState: "idle", stopBotId: null, stopTraceId: null, stopMessage: null });
  },
}));

type StoreSet = (partial: Partial<BotStore>) => void;
type StoreGet = () => BotStore;

function openStream(set: StoreSet, get: StoreGet): void {
  if (typeof EventSource === "undefined") {
    // No EventSource in this environment (SSR/test without polyfill):
    // stay on the polled path and say so explicitly.
    enterFallback(set, get);
    return;
  }
  teardownStream();
  lastStreamSequence = -1;
  set({ streamState: "connecting" });

  const source = new EventSource("/api/bots/stream");
  eventSource = source;

  const fail = () => {
    if (eventSource !== source) return;
    teardownStream();
    enterFallback(set, get);
  };

  source.addEventListener("snapshot", (event) => {
    if (eventSource !== source) return;
    const message = parseStreamData(event, botStreamSnapshotV1Schema);
    if (!message) {
      fail();
      return;
    }
    lastStreamSequence = message.streamSequence;
    reconnectAttempts = 0;
    stopFallbackPolling();
    set({
      streamState: "live",
      loadState: "ready",
      refreshing: false,
      bots: [...message.payload.bots],
      generatedAt: message.timestamp,
      requestId: message.messageId,
      error: null,
    });
  });

  source.addEventListener("event", (event) => {
    if (eventSource !== source) return;
    const message = parseStreamData(event, botStreamEventV1Schema);
    if (!message) {
      fail();
      return;
    }
    // Out-of-order or replayed deltas are dropped instead of applied.
    if (message.streamSequence <= lastStreamSequence) return;
    lastStreamSequence = message.streamSequence;
    set({
      bots: upsertBot(get().bots, message.payload.bot),
      generatedAt: message.timestamp,
    });
  });

  source.addEventListener("stream-error", fail);
  source.onerror = fail;
}

function enterFallback(set: StoreSet, get: StoreGet): void {
  set({ streamState: "fallback-polling" });
  if (pollTimer === null) {
    pollTimer = setInterval(() => {
      void get().refresh();
    }, POLL_INTERVAL_MS);
  }
  void get().refresh();
  scheduleReconnect(set, get);
}

function scheduleReconnect(set: StoreSet, get: StoreGet): void {
  if (reconnectTimer !== null || typeof EventSource === "undefined") return;
  const delay = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * 2 ** Math.min(reconnectAttempts, 10),
  );
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (liveClients > 0) openStream(set, get);
  }, delay);
}

function teardownStream(): void {
  if (eventSource !== null) {
    eventSource.close();
    eventSource = null;
  }
  if (reconnectTimer !== null) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function stopFallbackPolling(): void {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function parseStreamData<TData>(
  event: Event,
  schema: {
    safeParse(value: unknown):
      | { success: true; data: TData }
      | { success: false };
  },
): TData | null {
  const raw = (event as MessageEvent<string>).data;
  if (typeof raw !== "string") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  const envelope = value as { message?: unknown };
  const parsed = schema.safeParse(envelope.message);
  return parsed.success ? parsed.data : null;
}

async function safeJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    throw new Error("接口返回了非 JSON 响应。");
  }
}

function apiError(value: unknown, fallback: string): Error {
  const parsed = dashboardApiErrorV1Schema.safeParse(value);
  return new Error(parsed.success ? parsed.data.error.message : fallback);
}

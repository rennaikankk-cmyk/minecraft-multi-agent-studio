"use client";

import {
  dashboardApiErrorV1Schema,
  dashboardBotListResponseV1Schema,
  dashboardStopResponseV1Schema,
  type PublicBotDetailV1,
} from "@minecraft-studio/protocol";
import { create } from "zustand";

type LoadState = "idle" | "loading" | "ready" | "error";
type StopState = "idle" | "submitting" | "completed" | "failed";

type BotStore = {
  loadState: LoadState;
  refreshing: boolean;
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
  stopBot(botId: string, confirmationCode: string): Promise<boolean>;
  resetStopResult(): void;
};

let refreshSequence = 0;

export const useBotStore = create<BotStore>((set, get) => ({
  loadState: "idle",
  refreshing: false,
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

import { beforeEach, describe, expect, it, vi } from "vitest";

import { useBotStore } from "../stores/bot-store";

const NOW = "2026-07-20T08:00:00.000Z";
const UUID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  useBotStore.setState({
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
  });
  vi.unstubAllGlobals();
});

describe("Bot Zustand store", () => {
  it("stores only a validated Control API response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(successBody())));
    await useBotStore.getState().refresh();
    expect(useBotStore.getState()).toMatchObject({
      loadState: "ready",
      generatedAt: NOW,
      bots: [expect.objectContaining({ botId: "worker-01" })],
    });
  });

  it("clears prior online Bots when the backend becomes unavailable", async () => {
    useBotStore.setState({
      loadState: "ready",
      bots: successBody().data.bots,
      generatedAt: NOW,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse({
        schemaVersion: "1.0",
        requestId: UUID,
        error: { code: "CONTROL_API_UNAVAILABLE", message: "后端不可用。" },
      }, 503)),
    );
    await useBotStore.getState().refresh();
    expect(useBotStore.getState()).toMatchObject({
      loadState: "error",
      bots: [],
      generatedAt: null,
      error: { message: "后端不可用。" },
    });
  });
});

function successBody() {
  return {
    schemaVersion: "1.0" as const,
    requestId: UUID,
    data: {
      source: "control-api" as const,
      generatedAt: NOW,
      capabilities: { stopConfirmationConfigured: true },
      bots: [
        {
          botId: "worker-01",
          connectionState: "online" as const,
          lastMessageAt: NOW,
          lastHeartbeatAt: NOW,
          lastStatusAt: NOW,
          health: { current: 20, maximum: 20 },
          food: { level: 20, saturation: 5 },
          armorPoints: 0,
          latencyMs: 15,
          currentTask: null,
          position: null,
          positionRedacted: true,
          minecraftVersion: null,
        },
      ],
    },
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

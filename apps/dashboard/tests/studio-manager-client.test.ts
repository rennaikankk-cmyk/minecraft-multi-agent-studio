import { describe, expect, it, vi } from "vitest";

import {
  createStudioManagedBot,
  fetchStudioManagerStatus,
  loadStudioManagerConfig,
  StudioManagerClientError,
} from "../lib/studio-manager-client";

const TOKEN = "studio-manager-dashboard-token-000000000000001";
const NOW = "2026-08-27T10:00:00.000Z";

describe("Studio Manager client", () => {
  it("only accepts a loopback endpoint with a server-only token", () => {
    expect(
      loadStudioManagerConfig({
        DASHBOARD_STUDIO_MANAGER_URL: "http://127.0.0.1:3230",
        DASHBOARD_STUDIO_MANAGER_TOKEN: TOKEN,
      }),
    ).toEqual({ baseUrl: "http://127.0.0.1:3230", token: TOKEN });
    expect(() =>
      loadStudioManagerConfig({
        DASHBOARD_STUDIO_MANAGER_URL: "http://192.168.100.2:3230",
        DASHBOARD_STUDIO_MANAGER_TOKEN: TOKEN,
      }),
    ).toThrowError(StudioManagerClientError);
  });

  it("reads and validates Spark and managed Bot status", async () => {
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      return jsonResponse(status());
    });
    await expect(fetchStudioManagerStatus(config(), fetcher)).resolves.toEqual(
      status(),
    );
  });

  it("creates a Bot without exposing Manager authentication", async () => {
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe("http://127.0.0.1:3230/v1/bots");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "1.0",
        username: "StudioBot1",
        serverHost: "127.0.0.1",
        serverPort: 25565,
        minecraftVersion: "auto",
      });
      return jsonResponse({ schemaVersion: "1.0", generatedAt: NOW, bot: bot() });
    });
    await expect(
      createStudioManagedBot(
        config(),
        {
          schemaVersion: "1.0",
          username: "StudioBot1",
          serverHost: "127.0.0.1",
          serverPort: 25565,
          minecraftVersion: "auto",
        },
        fetcher,
      ),
    ).resolves.toMatchObject({ bot: { botId: "studio-bot-01" } });
  });
});

function config() {
  return { baseUrl: "http://127.0.0.1:3230", token: TOKEN } as const;
}

function status() {
  return {
    schemaVersion: "1.0" as const,
    generatedAt: NOW,
    ai: {
      state: "connected" as const,
      source: "discovered" as const,
      provider: "vllm" as const,
      baseUrl: "http://192.168.100.2:18100",
      model: "ornith-sm121-v5",
      models: ["ornith-sm121-v5"],
      latencyMs: 7,
      lastCheckedAt: NOW,
      message: "Spark 推理服务在线。",
    },
    bots: [bot()],
    capabilities: { createBot: true, maxBots: 16 },
  };
}

function bot() {
  return {
    botId: "studio-bot-01",
    username: "StudioBot1",
    serverHost: "127.0.0.1",
    serverPort: 25565,
    minecraftVersion: "auto" as const,
    processState: "running" as const,
    pid: 1234,
    createdAt: NOW,
    updatedAt: NOW,
    lastError: null,
  };
}

function jsonResponse(value: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(value), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

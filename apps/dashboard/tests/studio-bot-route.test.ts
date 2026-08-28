import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "../app/api/studio/bots/route";

const TOKEN = "studio-manager-route-token-00000000000000001";
const NOW = "2026-08-27T10:00:00.000Z";

afterEach(() => {
  delete process.env.DASHBOARD_STUDIO_MANAGER_URL;
  delete process.env.DASHBOARD_STUDIO_MANAGER_TOKEN;
  vi.unstubAllGlobals();
});

describe("Studio managed Bot route", () => {
  it("rejects cross-origin creation before contacting Manager", async () => {
    configureEnvironment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(createRequest("http://attacker.example"));
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a same-origin validated request with server-only auth", async () => {
    configureEnvironment();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({ Authorization: `Bearer ${TOKEN}` });
      return new Response(
        JSON.stringify({
          schemaVersion: "1.0",
          generatedAt: NOW,
          bot: {
            botId: "studio-bot-01",
            username: "StudioBot1",
            serverHost: "127.0.0.1",
            serverPort: 25565,
            minecraftVersion: "auto",
            processState: "running",
            pid: 1234,
            createdAt: NOW,
            updatedAt: NOW,
            lastError: null,
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(createRequest("http://localhost:3000"));
    expect(response.status).toBe(201);
    expect((await response.json()).bot.botId).toBe("studio-bot-01");
  });
});

function configureEnvironment(): void {
  process.env.DASHBOARD_STUDIO_MANAGER_URL = "http://127.0.0.1:3230";
  process.env.DASHBOARD_STUDIO_MANAGER_TOKEN = TOKEN;
}

function createRequest(origin: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/studio/bots", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: origin,
      "Sec-Fetch-Site":
        origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "X-Studio-Action": "create-bot",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      username: "StudioBot1",
      serverHost: "127.0.0.1",
      serverPort: 25565,
      minecraftVersion: "auto",
    }),
  });
}

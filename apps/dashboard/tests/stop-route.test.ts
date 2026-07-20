import { createHash } from "node:crypto";

import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "../app/api/bots/[botId]/stop/route";

const TOKEN = "dashboard-route-test-token-00000000000001";
const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const CONFIRMATION_CODE = "safe-stop-123";

afterEach(() => {
  delete process.env.DASHBOARD_CONTROL_API_URL;
  delete process.env.DASHBOARD_CONTROL_API_TOKEN;
  delete process.env.DASHBOARD_STOP_CONFIRMATION_SHA256;
  vi.unstubAllGlobals();
});

describe("Dashboard stop route", () => {
  it("rejects a cross-origin stop before contacting Control API", async () => {
    configureEnvironment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(
      stopRequest("http://attacker.example"),
      { params: Promise.resolve({ botId: "worker-01" }) },
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("CONFIRMATION_REQUIRED");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies the confirmation hash and forwards a fixed graceful stop", async () => {
    configureEnvironment();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-Studio-Schema-Version": "1.0",
      });
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "1.0",
        requestId: COMMAND_ID,
        confirmation: "confirmed",
      });
      return new Response(JSON.stringify({
        schemaVersion: "1.0",
        requestId: "22222222-2222-4222-8222-222222222222",
        data: {
          botId: "worker-01",
          commandId: COMMAND_ID,
          outcome: "completed",
          errorCode: null,
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(
      stopRequest("http://localhost:3000"),
      { params: Promise.resolve({ botId: "worker-01" }) },
    );
    expect(response.status).toBe(200);
    expect((await response.json()).data.outcome).toBe("completed");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

function configureEnvironment(): void {
  process.env.DASHBOARD_CONTROL_API_URL = "http://127.0.0.1:3210";
  process.env.DASHBOARD_CONTROL_API_TOKEN = TOKEN;
  process.env.DASHBOARD_STOP_CONFIRMATION_SHA256 = createHash("sha256")
    .update(CONFIRMATION_CODE)
    .digest("hex");
}

function stopRequest(origin: string): NextRequest {
  return new NextRequest("http://localhost:3000/api/bots/worker-01/stop", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: origin,
      "Sec-Fetch-Site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "X-Studio-Action": "stop-bot",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId: COMMAND_ID,
      confirmationCode: CONFIRMATION_CODE,
    }),
  });
}

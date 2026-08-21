import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { POST } from "../app/api/goals/route";

const TOKEN = "dashboard-goal-route-token-000000000000001";
const REQUEST_ID = "11111111-1111-4111-8111-111111111111";

afterEach(() => {
  delete process.env.DASHBOARD_CONTROL_API_URL;
  delete process.env.DASHBOARD_CONTROL_API_TOKEN;
  vi.unstubAllGlobals();
});

describe("Dashboard goal route", () => {
  it("rejects a cross-origin goal before contacting Control API", async () => {
    configureEnvironment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(goalRequest("http://attacker.example"));

    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("forwards a same-origin goal without exposing the server token", async () => {
    configureEnvironment();
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-Studio-Schema-Version": "1.0",
      });
      expect(init?.headers).not.toHaveProperty("X-Studio-Operator-Token");
      expect(JSON.parse(String(init?.body))).toEqual({
        schemaVersion: "1.0",
        requestId: REQUEST_ID,
        botId: "worker-01",
        operatorGoal: "采集附近的木材",
        timeoutMs: 120_000,
      });
      return new Response(JSON.stringify({
        schemaVersion: "1.0",
        requestId: "22222222-2222-4222-8222-222222222222",
        data: {
          action: "noop",
          botId: "worker-01",
          taskId: REQUEST_ID,
          reasonCode: "NO_SAFE_SKILL",
          ai: {
            attempts: 1,
            queueTimeMs: 2,
            executionTimeMs: 98,
            totalTimeMs: 100,
          },
        },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await POST(goalRequest("http://localhost:3000"));

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      action: "noop",
      taskId: REQUEST_ID,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports missing server configuration as unavailable", async () => {
    const response = await POST(goalRequest("http://localhost:3000"));

    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe(
      "DASHBOARD_CONTROL_NOT_CONFIGURED",
    );
  });

  it("rejects a streaming body above the byte limit before forwarding it", async () => {
    configureEnvironment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await POST(goalRequest(
      "http://localhost:3000",
      JSON.stringify({ value: "x".repeat(17_000) }),
    ));

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("preserves a full Local AI queue response as HTTP 429", async () => {
    configureEnvironment();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        schemaVersion: "1.0",
        requestId: "22222222-2222-4222-8222-222222222222",
        error: { code: "AI_QUEUE_FULL", message: "queue full" },
      }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    )));

    const response = await POST(goalRequest("http://localhost:3000"));

    expect(response.status).toBe(429);
    expect((await response.json()).error.code).toBe("RATE_LIMITED");
  });
});

function configureEnvironment(): void {
  process.env.DASHBOARD_CONTROL_API_URL = "http://127.0.0.1:3210";
  process.env.DASHBOARD_CONTROL_API_TOKEN = TOKEN;
}

function goalRequest(
  origin: string,
  body = JSON.stringify({
    schemaVersion: "1.0",
    requestId: REQUEST_ID,
    botId: "worker-01",
    operatorGoal: "采集附近的木材",
  }),
): NextRequest {
  return new NextRequest("http://localhost:3000/api/goals", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Host: "localhost:3000",
      Origin: origin,
      "Sec-Fetch-Site": origin === "http://localhost:3000" ? "same-origin" : "cross-site",
      "X-Studio-Action": "submit-goal",
    },
    body,
  });
}

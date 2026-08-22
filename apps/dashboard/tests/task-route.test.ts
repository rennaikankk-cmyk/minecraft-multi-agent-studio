import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as GET_TASKS } from "../app/api/tasks/route";
import { GET as GET_TASK_DETAIL } from "../app/api/tasks/[taskId]/route";

const TOKEN = "dashboard-task-route-token-000000000000001";
const TASK_ID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-07-20T08:00:00.000Z";

afterEach(() => {
  delete process.env.DASHBOARD_CONTROL_API_URL;
  delete process.env.DASHBOARD_CONTROL_API_TOKEN;
  vi.unstubAllGlobals();
});

describe("Dashboard task history routes", () => {
  it("forwards a bounded list query with the token kept server-side", async () => {
    configureEnvironment();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(
        "http://127.0.0.1:3210/v1/tasks?limit=20&status=running&botId=worker-01",
      );
      expect(init?.method).toBe("GET");
      expect(init?.headers).toMatchObject({
        Authorization: `Bearer ${TOKEN}`,
        "X-Studio-Schema-Version": "1.0",
      });
      return controlResponse({
        generatedAt: NOW,
        tasks: [taskSummary()],
        nextCursor: null,
      });
    });
    vi.stubGlobal("fetch", fetcher);

    const response = await GET_TASKS(new Request(
      "http://localhost:3000/api/tasks?limit=20&status=running&botId=worker-01",
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.data).toEqual({
      source: "control-api",
      generatedAt: NOW,
      tasks: [taskSummary()],
      nextCursor: null,
    });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("rejects unknown, repeated, and out-of-range list parameters", async () => {
    configureEnvironment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    for (const query of [
      "limit=33",
      "limit=10&limit=20",
      "unknown=value",
      "status=not-a-status",
    ]) {
      const response = await GET_TASKS(
        new Request(`http://localhost:3000/api/tasks?${query}`),
      );
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports missing configuration and explicit upstream unavailability", async () => {
    const missing = await GET_TASKS(
      new Request("http://localhost:3000/api/tasks"),
    );
    expect(missing.status).toBe(503);
    expect((await missing.json()).error.code).toBe(
      "DASHBOARD_CONTROL_NOT_CONFIGURED",
    );

    configureEnvironment();
    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        schemaVersion: "1.0",
        requestId: TASK_ID,
        error: {
          code: "TASK_HISTORY_UNAVAILABLE",
          message: "private upstream detail",
        },
      }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    )));
    const unavailable = await GET_TASKS(
      new Request("http://localhost:3000/api/tasks"),
    );
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error).toEqual({
      code: "TASK_HISTORY_UNAVAILABLE",
      message: "任务历史后端当前不可用。",
    });
  });

  it("returns strict task detail and preserves a bounded 404", async () => {
    configureEnvironment();
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      expect(String(input)).toBe(`http://127.0.0.1:3210/v1/tasks/${TASK_ID}`);
      return controlResponse({
        generatedAt: NOW,
        task: { ...taskSummary(), operatorGoal: "采集附近的木材" },
      });
    });
    vi.stubGlobal("fetch", fetcher);
    const detail = await GET_TASK_DETAIL(
      new Request(`http://localhost:3000/api/tasks/${TASK_ID}`),
      { params: Promise.resolve({ taskId: TASK_ID }) },
    );
    expect(detail.status).toBe(200);
    expect((await detail.json()).data.task).toEqual({
      ...taskSummary(),
      operatorGoal: "采集附近的木材",
    });

    vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({
        schemaVersion: "1.0",
        requestId: TASK_ID,
        error: { code: "TASK_NOT_FOUND", message: "private upstream detail" },
      }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    )));
    const missing = await GET_TASK_DETAIL(
      new Request(`http://localhost:3000/api/tasks/${TASK_ID}`),
      { params: Promise.resolve({ taskId: TASK_ID }) },
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toEqual({
      code: "TASK_NOT_FOUND",
      message: "未找到该任务。",
    });
  });

  it("rejects an invalid task ID before contacting Control API", async () => {
    configureEnvironment();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await GET_TASK_DETAIL(
      new Request("http://localhost:3000/api/tasks/not-a-task"),
      { params: Promise.resolve({ taskId: "not-a-task" }) },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("INVALID_REQUEST");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function configureEnvironment(): void {
  process.env.DASHBOARD_CONTROL_API_URL = "http://127.0.0.1:3210";
  process.env.DASHBOARD_CONTROL_API_TOKEN = TOKEN;
}

function taskSummary() {
  return {
    taskId: TASK_ID,
    taskType: "operator.goal",
    title: "采集木材",
    status: "running" as const,
    priority: 50,
    riskLevel: "R1" as const,
    botId: "worker-01",
    failureReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    startedAt: NOW,
    finishedAt: null,
    revision: 1,
  };
}

function controlResponse(data: unknown): Response {
  return new Response(JSON.stringify({
    schemaVersion: "1.0",
    requestId: TASK_ID,
    data,
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

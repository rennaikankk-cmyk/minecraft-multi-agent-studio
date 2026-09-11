// ---------------------------------------------------------------------------
// F-B3 附带缺陷：`loadStudioManagerConfig()` 未配置时抛错而非返回 null，
// 旧 `if (!config)` 是死分支 —— 未配置的 chat-trust 读写会退化成 500，
// 而不是契约要求的 503（前端据此显示「未配置」而不是「内部错误」）。
// ---------------------------------------------------------------------------
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";

import { GET, PUT } from "../app/api/studio/chat-trust/route";

const SAVED_URL = process.env.DASHBOARD_STUDIO_MANAGER_URL;
const SAVED_TOKEN = process.env.DASHBOARD_STUDIO_MANAGER_TOKEN;

afterEach(() => {
  delete process.env.DASHBOARD_STUDIO_MANAGER_URL;
  delete process.env.DASHBOARD_STUDIO_MANAGER_TOKEN;
  if (SAVED_URL !== undefined) process.env.DASHBOARD_STUDIO_MANAGER_URL = SAVED_URL;
  if (SAVED_TOKEN !== undefined) process.env.DASHBOARD_STUDIO_MANAGER_TOKEN = SAVED_TOKEN;
});

describe("chat-trust route configuration failures", () => {
  it("reports an unconfigured manager as 503 for reads instead of throwing", async () => {
    delete process.env.DASHBOARD_STUDIO_MANAGER_URL;
    delete process.env.DASHBOARD_STUDIO_MANAGER_TOKEN;
    const response = await GET();
    expect(response.status).toBe(503);
    expect((await response.json()).detail).toContain("Studio Manager");
  });

  it("reports an unconfigured manager as 503 for writes instead of throwing", async () => {
    delete process.env.DASHBOARD_STUDIO_MANAGER_URL;
    delete process.env.DASHBOARD_STUDIO_MANAGER_TOKEN;
    const response = await PUT(sameOriginRequest());
    expect(response.status).toBe(503);
    expect((await response.json()).detail).toContain("Studio Manager");
  });

  it("rejects a cross-site write before touching configuration (F-B3)", async () => {
    process.env.DASHBOARD_STUDIO_MANAGER_URL = "http://127.0.0.1:3230";
    process.env.DASHBOARD_STUDIO_MANAGER_TOKEN = "studio-manager-route-token-00000000000000001";
    const response = await PUT(new NextRequest("http://studio.local/api/studio/chat-trust", {
      method: "PUT",
      headers: {
        "x-studio-action": "chat-trust",
        "Content-Type": "application/json",
        Origin: "http://attacker.example",
        Host: "studio.local",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify([]),
    }));
    expect(response.status).toBe(403);
  });
});

function sameOriginRequest(): NextRequest {
  return new NextRequest("http://studio.local/api/studio/chat-trust", {
    method: "PUT",
    headers: {
      "x-studio-action": "chat-trust",
      "Content-Type": "application/json",
      Origin: "http://studio.local",
      Host: "studio.local",
      "Sec-Fetch-Site": "same-origin",
    },
    body: JSON.stringify([]),
  });
}

// ---------------------------------------------------------------------------
// F-B3：破坏性写路由的同源守卫回归测试。
//
// 修前：这 6 条路由只检查 `x-studio-action` 自定义头，跨站页面（DNS-rebinding /
// 恶意页面）只要能触发请求就会直达后端；修后：必须与 stop-bot / goals 同等强度，
// 缺少同源 Origin+Host 一律 403，且绝不下发上游请求。
// ---------------------------------------------------------------------------
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DELETE as deleteManagedBot } from "../app/api/studio/bots/[botId]/route";
import { POST as stopManagedBot } from "../app/api/studio/bots/[botId]/stop/route";
import { PUT as putChatTrust } from "../app/api/studio/chat-trust/route";
import { POST as postLessons } from "../app/api/studio/lessons/route";
import { POST as postStudioRestart } from "../app/api/studio/restart/route";
import { POST as postSkillReleases } from "../app/api/studio/skill-releases/route";

const MANAGER_URL = "http://127.0.0.1:3230";
const MANAGER_TOKEN = "studio-manager-route-token-00000000000000001";
const SHARED_STATE_URL = "http://shared-state.local";
const SHARED_STATE_TOKEN = "shared-state-test-token-0000000000001";
const SITE = "http://studio.local";
const HOST = "studio.local";

interface GuardedRoute {
  readonly name: string;
  readonly action: string;
  readonly invoke: (request: NextRequest) => Promise<Response>;
  readonly path: string;
  readonly body?: string;
  readonly method: string;
  readonly expectedStatus: number;
}

const botPayload = {
  schemaVersion: "1.0",
  generatedAt: "2026-08-27T10:00:00.000Z",
  bot: {
    botId: "studio-bot-01",
    username: "StudioBot1",
    serverHost: "127.0.0.1",
    serverPort: 25565,
    minecraftVersion: "auto",
    processState: "running",
    pid: 1234,
    createdAt: "2026-08-27T10:00:00.000Z",
    updatedAt: "2026-08-27T10:00:00.000Z",
    lastError: null,
  },
};

const routes: readonly GuardedRoute[] = [
  {
    name: "POST /api/studio/restart（整组重启 Studio）",
    action: "studio-restart",
    path: "/api/studio/restart",
    method: "POST",
    invoke: (request) => postStudioRestart(request),
    expectedStatus: 202,
  },
  {
    name: "DELETE /api/studio/bots/:botId（删除受管 Bot）",
    action: "delete-bot",
    path: "/api/studio/bots/studio-bot-01",
    method: "DELETE",
    invoke: (request) => deleteManagedBot(request, { params: Promise.resolve({ botId: "studio-bot-01" }) }),
    expectedStatus: 200,
  },
  {
    name: "POST /api/studio/bots/:botId/stop（停止受管 Bot 进程）",
    action: "stop-bot",
    path: "/api/studio/bots/studio-bot-01/stop",
    method: "POST",
    invoke: (request) => stopManagedBot(request, { params: Promise.resolve({ botId: "studio-bot-01" }) }),
    expectedStatus: 200,
  },
  {
    name: "POST /api/studio/skill-releases（技能发布决策）",
    action: "skill-release",
    path: "/api/studio/skill-releases",
    method: "POST",
    body: JSON.stringify({ action: "create-draft", gapFingerprint: "a".repeat(32) }),
    invoke: (request) => postSkillReleases(request),
    expectedStatus: 200,
  },
  {
    name: "PUT /api/studio/chat-trust（改写白名单）",
    action: "chat-trust",
    path: "/api/studio/chat-trust",
    method: "PUT",
    body: JSON.stringify([]),
    invoke: (request) => putChatTrust(request),
    expectedStatus: 200,
  },
  {
    name: "POST /api/studio/lessons（触发复盘）",
    action: "lesson-review",
    path: "/api/studio/lessons",
    method: "POST",
    body: JSON.stringify({ serverProfileId: "sp-local" }),
    invoke: (request) => postLessons(request),
    expectedStatus: 202,
  },
];

afterEach(() => {
  delete process.env.DASHBOARD_STUDIO_MANAGER_URL;
  delete process.env.DASHBOARD_STUDIO_MANAGER_TOKEN;
  delete process.env.STUDIO_SHARED_STATE_URL;
  delete process.env.STUDIO_SHARED_STATE_TOKEN;
  vi.unstubAllGlobals();
});

describe("destructive write routes share the strong same-origin guard (F-B3)", () => {
  for (const route of routes) {
    it(`${route.name}: rejects a cross-site request before any upstream call`, async () => {
      configure();
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const response = await route.invoke(createRequest(route, {
        origin: "http://attacker.example",
        "sec-fetch-site": "cross-site",
      }));
      expect(response.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it(`${route.name}: rejects a request with no Origin at all`, async () => {
      configure();
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      const response = await route.invoke(createRequest(route, {}));
      expect(response.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    });

    it(`${route.name}: still forwards a same-origin request`, async () => {
      configure();
      const fetcher = vi.fn(async () => upstreamResponse(route));
      vi.stubGlobal("fetch", fetcher);
      const response = await route.invoke(createRequest(route, {
        origin: SITE,
        "sec-fetch-site": "same-origin",
      }));
      expect(response.status).toBe(route.expectedStatus);
      expect(fetcher).toHaveBeenCalledTimes(1);
    });
  }
});

function configure(): void {
  process.env.DASHBOARD_STUDIO_MANAGER_URL = MANAGER_URL;
  process.env.DASHBOARD_STUDIO_MANAGER_TOKEN = MANAGER_TOKEN;
  process.env.STUDIO_SHARED_STATE_URL = SHARED_STATE_URL;
  process.env.STUDIO_SHARED_STATE_TOKEN = SHARED_STATE_TOKEN;
}

function createRequest(
  route: GuardedRoute,
  headers: Record<string, string>,
): NextRequest {
  return new NextRequest(`${SITE}${route.path}`, {
    method: route.method,
    headers: {
      "x-studio-action": route.action,
      ...(route.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...("Host" in headers ? {} : { Host: HOST }),
      ...headers,
    },
    ...(route.body === undefined ? {} : { body: route.body }),
  });
}

function upstreamResponse(route: GuardedRoute): Response {
  if (route.action === "studio-restart") {
    return jsonResponse(202, { restart: { status: "accepted" } });
  }
  if (route.action === "skill-release") {
    return jsonResponse(200, { ok: true, releaseId: "rel-abc123" });
  }
  if (route.action === "lesson-review") {
    return jsonResponse(202, { ok: true, review: { queued: true } });
  }
  if (route.action === "chat-trust") {
    return jsonResponse(200, { schemaVersion: "1.0", saved: 0, restartRequired: true });
  }
  if (route.action === "delete-bot") {
    return jsonResponse(200, { schemaVersion: "1.0", deleted: "studio-bot-01" });
  }
  return jsonResponse(200, botPayload);
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

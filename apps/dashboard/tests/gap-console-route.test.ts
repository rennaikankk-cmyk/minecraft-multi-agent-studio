import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GET as getSkillGaps } from "../app/api/studio/skill-gaps/route";
import { POST as postSkillReleases } from "../app/api/studio/skill-releases/route";

const BASE_URL = "http://shared-state.local";
const TOKEN = "shared-state-test-token-0000000000001";

function gapConsolePayload() {
  return {
    ok: true,
    gaps: [{
      fingerprint: "a".repeat(32),
      kind: "blueprint_missing",
      severity: "warning",
      occurrenceCount: 3,
      gap: { actionFamily: "build", terminalFailureCode: "BUILD_MATERIAL_MISSING", requestedSkillId: null },
      runtime: { serverProfileId: "profile-a" },
      lastSeenAtMs: 1,
    }],
    compositionSuggestions: [
      { fingerprint: "a".repeat(32), suggestion: { skillIds: ["build.blueprint"], rationale: "compose first" } },
    ],
  };
}

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): NextRequest {
  return new NextRequest(`http://studio.local${path}`, {
    ...(init.method !== undefined ? { method: init.method } : {}),
    // F-B3：写面路由要求同源请求（Origin + Host + Sec-Fetch-Site）；
    // 单测默认按浏览器同源请求构造，需要跨站场景时由用例显式覆盖。
    headers: {
      Origin: "http://studio.local",
      Host: "studio.local",
      "Sec-Fetch-Site": "same-origin",
      ...init.headers,
    },
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

afterEach(() => {
  delete process.env.STUDIO_SHARED_STATE_URL;
  delete process.env.STUDIO_SHARED_STATE_TOKEN;
  vi.unstubAllGlobals();
});

describe("skill-gaps route", () => {
  it("reports not_configured without leaking a fetch", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await getSkillGaps();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("maps the shared-state payload into console views", async () => {
    configure();
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/skill-gaps")) return jsonResponse(200, gapConsolePayload());
      if (url.endsWith("/skill-releases")) return jsonResponse(200, { ok: true, releases: [] });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch);
    const response = await getSkillGaps();
    const json = (await response.json()) as { status: string; gaps?: unknown[]; suggestions?: unknown[] };
    expect(json.status).toBe("ok");
    expect(json.gaps![0]).toMatchObject({ kind: "blueprint_missing", occurrenceCount: 3, actionFamily: "build" });
    expect(json.suggestions![0]).toMatchObject({ skillIds: ["build.blueprint"] });
  });
});

describe("skill-releases route", () => {
  it("rejects writes without the x-studio-action header", async () => {
    configure();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await postSkillReleases(request("/api/studio/skill-releases", {
      method: "POST",
      body: JSON.stringify({ action: "create-draft", gapFingerprint: "a".repeat(32) }),
    }));
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects a cross-site write even when the action header is present (F-B3)", async () => {
    configure();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await postSkillReleases(request("/api/studio/skill-releases", {
      method: "POST",
      headers: {
        "x-studio-action": "skill-release",
        "Content-Type": "application/json",
        Origin: "http://attacker.example",
        "Sec-Fetch-Site": "cross-site",
      },
      body: JSON.stringify({ action: "create-draft", gapFingerprint: "a".repeat(32) }),
    }));
    expect(response.status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("proxies create-draft with the shared-state token", async () => {
    configure();
    const seen: Array<{ url: string; body: unknown; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({
        url: String(input),
        body: JSON.parse(String(init?.body)),
        authorization: (init?.headers as Record<string, string>)?.Authorization ?? null,
      });
      return jsonResponse(201, { ok: true, releaseId: "rel-abc123", implementationPrompt: "# prompt" });
    }) as unknown as typeof fetch);
    const response = await postSkillReleases(request("/api/studio/skill-releases", {
      method: "POST",
      headers: { "x-studio-action": "skill-release", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create-draft", gapFingerprint: "a".repeat(32) }),
    }));
    expect(response.status).toBe(200);
    const json = (await response.json()) as { status: string; releaseId?: string };
    expect(json).toMatchObject({ status: "ok", releaseId: "rel-abc123" });
    expect(seen[0]!.url).toBe(`${BASE_URL}/skill-releases`);
    expect(seen[0]!.body).toEqual({ action: "create-draft", gapFingerprint: "a".repeat(32) });
    expect(seen[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("rejects operator decisions without an operator name", async () => {
    configure();
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const response = await postSkillReleases(request("/api/studio/skill-releases", {
      method: "POST",
      headers: { "x-studio-action": "skill-release", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "operator-decision", releaseId: "rel-1", decision: "promote-canary", operator: "  " }),
    }));
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function configure(): void {
  process.env.STUDIO_SHARED_STATE_URL = BASE_URL;
  process.env.STUDIO_SHARED_STATE_TOKEN = TOKEN;
}

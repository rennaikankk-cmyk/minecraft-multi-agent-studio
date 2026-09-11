// ---------------------------------------------------------------------------
// F-B3：共享同源守卫的单元测试（唯一实现）。
//
// 默认形态 = 既有强守卫（goals / stop-bot / create-bot / ai-provider…）：
//   Origin 与 Host 必须存在且同源，Sec-Fetch-Site 存在时必须是 same-origin。
// 严格形态（requireFetchSite）= 既有 incidents / local-test 调用点：
//   必须显式携带 Sec-Fetch-Site: same-origin —— 重构不得放松这些调用点。
// ---------------------------------------------------------------------------
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";

import { isSameOriginAction } from "@/lib/same-origin-guard";

function request(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://studio.local/api/x", { method: "POST", headers });
}

describe("isSameOriginAction", () => {
  it("accepts a browser same-origin write", () => {
    expect(
      isSameOriginAction(
        request({
          "x-studio-action": "stop-bot",
          Origin: "http://studio.local",
          Host: "studio.local",
          "Sec-Fetch-Site": "same-origin",
        }),
        "stop-bot",
      ),
    ).toBe(true);
  });

  it("accepts non-browser style clients that omit Sec-Fetch-Site (默认形态不改既有强度)", () => {
    expect(
      isSameOriginAction(
        request({
          "x-studio-action": "stop-bot",
          Origin: "http://studio.local:3000",
          Host: "studio.local:3000",
        }),
        "stop-bot",
      ),
    ).toBe(true);
  });

  it("rejects a wrong action header", () => {
    expect(
      isSameOriginAction(
        request({
          "x-studio-action": "delete-bot",
          Origin: "http://studio.local",
          Host: "studio.local",
          "Sec-Fetch-Site": "same-origin",
        }),
        "stop-bot",
      ),
    ).toBe(false);
  });

  it("rejects missing Origin or missing Host", () => {
    expect(
      isSameOriginAction(request({ "x-studio-action": "stop-bot", Host: "studio.local" }), "stop-bot"),
    ).toBe(false);
    expect(
      isSameOriginAction(request({ "x-studio-action": "stop-bot", Origin: "http://studio.local" }), "stop-bot"),
    ).toBe(false);
  });

  it("rejects a cross-site Origin and an origin/host mismatch", () => {
    expect(
      isSameOriginAction(
        request({
          "x-studio-action": "stop-bot",
          Origin: "http://attacker.example",
          Host: "studio.local",
          "Sec-Fetch-Site": "cross-site",
        }),
        "stop-bot",
      ),
    ).toBe(false);
    expect(
      isSameOriginAction(
        request({
          "x-studio-action": "stop-bot",
          Origin: "http://attacker.example",
          Host: "studio.local",
        }),
        "stop-bot",
      ),
    ).toBe(false);
  });

  it("rejects any non same-origin Sec-Fetch-Site value", () => {
    for (const value of ["cross-site", "same-site", "none", ""]) {
      expect(
        isSameOriginAction(
          request({
            "x-studio-action": "stop-bot",
            Origin: "http://studio.local",
            Host: "studio.local",
            "Sec-Fetch-Site": value,
          }),
          "stop-bot",
        ),
      ).toBe(false);
    }
  });

  it("rejects an unparsable Origin", () => {
    expect(
      isSameOriginAction(
        request({
          "x-studio-action": "stop-bot",
          Origin: "not-a-url",
          Host: "studio.local",
        }),
        "stop-bot",
      ),
    ).toBe(false);
  });

  describe("requireFetchSite (既有严格调用点)", () => {
    it("requires an explicit same-origin Sec-Fetch-Site", () => {
      expect(
        isSameOriginAction(
          request({
            "x-studio-action": "incident-status",
            Origin: "http://studio.local",
            Host: "studio.local",
          }),
          "incident-status",
          { requireFetchSite: true },
        ),
      ).toBe(false);
      expect(
        isSameOriginAction(
          request({
            "x-studio-action": "incident-status",
            Origin: "http://studio.local",
            Host: "studio.local",
            "Sec-Fetch-Site": "same-origin",
          }),
          "incident-status",
          { requireFetchSite: true },
        ),
      ).toBe(true);
    });
  });
});

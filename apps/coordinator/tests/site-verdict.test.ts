// site-verdict 纯函数单测：schema 严格性、prompt 保密纪律（无绝对坐标）。
import { describe, expect, it } from "vitest";
import {
  buildSiteVerdictPrompt,
  sanitizeSiteVerdict,
  SITE_VERDICT_REJECT_LIMIT,
} from "../src/site-verdict.js";

describe("sanitizeSiteVerdict", () => {
  it("accepts a well-formed verdict", () => {
    expect(
      sanitizeSiteVerdict({ verdict: "accept", confidence: 0.8, reasons: ["村庄很近"] }),
    ).toEqual({ verdict: "accept", confidence: 0.8, reasons: ["村庄很近"] });
  });

  it("rejects malformed payloads (fail-closed → null)", () => {
    expect(sanitizeSiteVerdict(null)).toBeNull();
    expect(sanitizeSiteVerdict("accept")).toBeNull();
    expect(sanitizeSiteVerdict({ verdict: "maybe" })).toBeNull();
    // 越界 confidence / 空理由 / 理由过多 / 多余字段全部拒绝
    expect(sanitizeSiteVerdict({ verdict: "accept", confidence: 1.5, reasons: ["x"] })).toBeNull();
    expect(sanitizeSiteVerdict({ verdict: "accept", confidence: 0.5, reasons: [] })).toBeNull();
    expect(
      sanitizeSiteVerdict({ verdict: "accept", confidence: 0.5, reasons: ["a", "b", "c", "d"] }),
    ).toBeNull();
    expect(
      sanitizeSiteVerdict({ verdict: "accept", confidence: 0.5, reasons: ["x"], anchor: { x: 1 } }),
    ).toBeNull();
  });

  it("caps the reject ladder at a small constant", () => {
    expect(SITE_VERDICT_REJECT_LIMIT).toBe(3);
  });
});

describe("buildSiteVerdictPrompt", () => {
  it("states facts as relative distances only — never absolute coordinates", () => {
    const prompt = buildSiteVerdictPrompt({
      village: { nearestDistance: 22, count: 4 },
      water: { nearestDistance: 8, count: 1 },
      lava: { nearestDistance: 3, count: 2 },
      wood: null,
    });
    expect(prompt).toContain("最近 22 格");
    expect(prompt).toContain("岩浆");
    expect(prompt).toContain("64 格内未观测到");
    // 保密纪律：prompt 里不许出现绝对坐标形态
    expect(prompt).not.toMatch(/x\s*[:=]\s*-?\d+/);
    expect(prompt).not.toMatch(/y\s*[:=]\s*-?\d+/);
    expect(prompt).not.toMatch(/z\s*[:=]\s*-?\d+/);
    // 菜单纪律：只许 accept/reject
    expect(prompt).toContain('"verdict":"accept"|"reject"');
  });
});

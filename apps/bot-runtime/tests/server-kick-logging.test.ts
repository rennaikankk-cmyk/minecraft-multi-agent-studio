// SERVER_KICK 结构化证据字段（2026-09-03 canary 修正）—— 纯函数单测。
import { describe, expect, it } from "vitest";

import { normalizeKickReason, sanitizeServerText } from "../src/runtime.js";

describe("normalizeKickReason（机器可归类摘要；不下根因结论）", () => {
  it("Forge/FML 原文 → forge_or_modded_server（simpfun 实测 kick 文本）", () => {
    const simpfunKick =
      '{"text":"This server has mods that require FML/Forge to be installed on the client. Contact your server admin for more details."}';
    expect(normalizeKickReason(simpfunKick)).toBe("forge_or_modded_server");
  });

  it("常见 kick 家族各自归类", () => {
    expect(normalizeKickReason("Outdated client! Please use 1.20")).toBe("outdated_client");
    expect(normalizeKickReason("You are banned from this server")).toBe("banned");
    expect(normalizeKickReason("You are not whitelisted on this server")).toBe("whitelist");
    expect(normalizeKickReason("You logged in from another location")).toBe("duplicate_session");
    expect(normalizeKickReason("Server is full")).toBe("server_full");
  });

  it("未知文本如实标 unclassified；undefined 标 unknown", () => {
    expect(normalizeKickReason("Something odd happened")).toBe("server_kick_unclassified");
    expect(normalizeKickReason(undefined)).toBe("unknown");
  });
});

describe("sanitizeServerText（服务器文本安全转纯文本）", () => {
  it("去除控制字符并折叠空白，语义不丢", () => {
    expect(sanitizeServerText("line1\nline2\r\n\ttabbed")).toBe("line1 line2 tabbed");
  });

  it("超长文本限幅 2000（原始全文由探针证据文件保存）", () => {
    expect(sanitizeServerText("x".repeat(5000)).length).toBe(2000);
  });

  it("undefined → 空串", () => {
    expect(sanitizeServerText(undefined)).toBe("");
  });
});

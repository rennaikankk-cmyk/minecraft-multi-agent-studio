// host/connectHost 分离（2026-09-03 canary 修正）—— 单测 + 链路断言。
// 纪律：serverHost（=profile.host）是逻辑/握手地址；connectHost 只覆盖 TCP
// 目的地址。mineflayer 映射依据锁定依赖 minecraft-protocol@1.66.2
// src/client/setProtocol.js:19（options.fakeHost 覆盖 set_protocol.serverHost）。
import { describe, expect, it } from "vitest";

import { createMineflayerOptions } from "../src/mineflayer-client.js";
import {
  serverProfileSchema,
  type ServerProfile,
} from "../src/server-profile.js";

const baseProfile: ServerProfile = {
  schemaVersion: "1.0",
  id: "gray-test",
  botId: "studio-bot-01",
  purpose: "anarchy",
  networkScope: "public",
  host: "play.example-gray.cn",
  port: 16377,
  minecraftVersion: "auto",
  username: "StudioGray01",
  auth: "offline",
  statusIntervalMs: 1_000,
  heartbeatIntervalMs: 5_000,
  stopGracePeriodMs: 5_000,
  reconnect: {
    enabled: true,
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
  },
};

describe("host/connectHost separation (Server Profile SSOT)", () => {
  it("无 connectHost：TCP 与握手都是 host，不设 fakeHost", () => {
    const options = createMineflayerOptions(baseProfile);
    expect(options.host).toBe("play.example-gray.cn");
    expect("fakeHost" in options).toBe(false);
    expect(options.auth).toBe("offline");
    expect(options.username).toBe(baseProfile.username);
  });

  it("有 connectHost：TCP 目的=connectHost，握手域名=fakeHost=host", () => {
    const options = createMineflayerOptions({
      ...baseProfile,
      connectHost: "203.0.113.10",
    });
    expect(options.host).toBe("203.0.113.10");
    expect(options.fakeHost).toBe("play.example-gray.cn");
  });

  it("connectHost 绝不改变 auth/username/version 等其它字段", () => {
    const without = createMineflayerOptions(baseProfile);
    const withOverride = createMineflayerOptions({
      ...baseProfile,
      connectHost: "203.0.113.10",
    });
    expect(withOverride.username).toBe(without.username);
    expect(withOverride.auth).toBe(without.auth);
    expect(withOverride.port).toBe(without.port);
  });

  it("profile schema：connectHost 接受裸 IP/DNS 名，拒绝带协议前缀", () => {
    const valid = serverProfileSchema.safeParse({
      ...baseProfile,
      connectHost: "203.0.113.10",
    });
    expect(valid.success).toBe(true);

    const dns = serverProfileSchema.safeParse({
      ...baseProfile,
      connectHost: "direct.example-gray.cn",
    });
    expect(dns.success).toBe(true);

    const schemed = serverProfileSchema.safeParse({
      ...baseProfile,
      connectHost: "http://203.0.113.10",
    });
    expect(schemed.success).toBe(false);
  });

  it("profile schema：_profileStatus 批注字段可通过校验（SSOT 文档可加载）", () => {
    const parsed = serverProfileSchema.safeParse({
      ...baseProfile,
      connectHost: "203.0.113.10",
      _profileStatus: {
        probedAt: "2026-09-03T05:00:00Z",
        tcpReachable: true,
        notes: "annotation fields are never consumed by runtime",
      },
    });
    expect(parsed.success).toBe(true);
  });
});

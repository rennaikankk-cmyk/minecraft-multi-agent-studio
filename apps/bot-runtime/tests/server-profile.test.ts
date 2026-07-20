import { describe, expect, it } from "vitest";

import {
  loadServerProfile,
  ServerProfileError,
  serverProfileSchema,
} from "../src/server-profile.js";

const validProfile = {
  schemaVersion: "1.0",
  id: "local-isolated-test",
  botId: "studio-bot-01",
  purpose: "isolated-test",
  networkScope: "loopback",
  host: "127.0.0.1",
  port: 25565,
  minecraftVersion: "1.21.8",
  username: "StudioBot",
  auth: "offline",
  statusIntervalMs: 1000,
  heartbeatIntervalMs: 5000,
  stopGracePeriodMs: 5000,
  reconnect: {
    enabled: true,
    maxAttempts: 5,
    baseDelayMs: 2000,
    maxDelayMs: 30000,
  },
};

describe("ServerProfile", () => {
  it("accepts an explicit loopback isolated-test profile", () => {
    expect(serverProfileSchema.parse(validProfile)).toEqual(validProfile);
  });

  it("accepts auto detection and rejects untested fixed versions", () => {
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        minecraftVersion: "auto",
      }).success,
    ).toBe(true);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        minecraftVersion: "1.21.10",
      }).success,
    ).toBe(false);
  });

  it("accepts RFC1918 hosts only when private-lan is explicit", () => {
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        networkScope: "private-lan",
        host: "192.168.10.20",
      }).success,
    ).toBe(true);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        networkScope: "loopback",
        host: "192.168.10.20",
      }).success,
    ).toBe(false);
  });

  it("rejects public hosts, production purpose, passwords, and invalid retries", () => {
    expect(
      serverProfileSchema.safeParse({ ...validProfile, host: "8.8.8.8" }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        purpose: "production",
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        password: "must-not-be-in-profile",
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        reconnect: { ...validProfile.reconnect, baseDelayMs: 10_000, maxDelayMs: 500 },
      }).success,
    ).toBe(false);
  });

  it("refuses to load without an explicit profile path", async () => {
    await expect(loadServerProfile({})).rejects.toMatchObject<ServerProfileError>({
      code: "SERVER_PROFILE_REQUIRED",
    });
  });

  it("returns a stable error for an unreadable profile", async () => {
    await expect(
      loadServerProfile({
        BOT_SERVER_PROFILE_PATH: "Z:\\path-that-does-not-exist\\profile.json",
      }),
    ).rejects.toMatchObject<ServerProfileError>({
      code: "SERVER_PROFILE_UNREADABLE",
    });
  });
});

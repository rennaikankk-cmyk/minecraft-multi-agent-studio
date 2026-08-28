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

  it("accepts an explicit bounded combat configuration", () => {
    const combat = {
      enabled: true,
      stance: "preserve-life",
      whitelist: {
        usernames: ["AlliedBot", "NeutralUser"],
        uuids: [
          "11111111111141118111111111111111",
          "22222222-2222-4222-8222-222222222222",
        ],
      },
    } as const;

    expect(serverProfileSchema.parse({ ...validProfile, combat })).toEqual({
      ...validProfile,
      combat,
    });
  });

  it("allows combat to remain absent or explicitly disabled", () => {
    expect(serverProfileSchema.parse(validProfile)).not.toHaveProperty("combat");
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          enabled: false,
          stance: "expendable",
          whitelist: { usernames: [], uuids: [] },
        },
      }).success,
    ).toBe(true);
  });

  it("rejects malformed or non-explicit combat configuration", () => {
    const combat = {
      enabled: true,
      stance: "preserve-life",
      whitelist: { usernames: ["AlliedBot"], uuids: [] },
    };

    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: { ...combat, stance: "ignore-survival" },
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: { enabled: true, stance: "preserve-life" },
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: { ...combat, targetUsername: "Enemy" },
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          ...combat,
          whitelist: { usernames: ["x"], uuids: [] },
        },
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          ...combat,
          whitelist: { usernames: [], uuids: ["not-a-uuid"] },
        },
      }).success,
    ).toBe(false);
  });

  it("rejects normalized duplicate combat whitelist entries", () => {
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          enabled: true,
          stance: "preserve-life",
          whitelist: {
            usernames: ["AlliedBot", "alliedbot"],
            uuids: [],
          },
        },
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          enabled: true,
          stance: "preserve-life",
          whitelist: {
            usernames: [],
            uuids: [
              "11111111111141118111111111111111",
              "11111111-1111-4111-8111-111111111111",
            ],
          },
        },
      }).success,
    ).toBe(false);
  });

  it("caps each combat whitelist identity class", () => {
    const usernames = Array.from(
      { length: 257 },
      (_, index) => `Bot${index.toString().padStart(3, "0")}`,
    );
    const uuids = Array.from(
      { length: 257 },
      (_, index) => index.toString(16).padStart(32, "0"),
    );
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          enabled: true,
          stance: "preserve-life",
          whitelist: { usernames, uuids: [] },
        },
      }).success,
    ).toBe(false);
    expect(
      serverProfileSchema.safeParse({
        ...validProfile,
        combat: {
          enabled: true,
          stance: "preserve-life",
          whitelist: { usernames: [], uuids },
        },
      }).success,
    ).toBe(false);
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

  it("accepts a Desktop Manager real-server profile without granting test probing", () => {
    expect(
      serverProfileSchema.parse({
        ...validProfile,
        purpose: "managed",
        networkScope: "private-lan",
        host: "192.168.10.20",
      }),
    ).toMatchObject({
      purpose: "managed",
      networkScope: "private-lan",
      host: "192.168.10.20",
    });
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
        auth: "microsoft",
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

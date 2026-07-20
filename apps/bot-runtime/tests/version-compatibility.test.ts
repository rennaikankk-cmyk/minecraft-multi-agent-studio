import { describe, expect, it } from "vitest";

import { createMineflayerOptions } from "../src/mineflayer-client.js";
import type { ServerProfile } from "../src/server-profile.js";
import {
  isMineflayerTestedVersion,
  mineflayerVersionSupport,
  resolvedVersionCompatibility,
  unsupportedVersionCompatibility,
} from "../src/version-compatibility.js";

const baseProfile: ServerProfile = {
  schemaVersion: "1.0",
  id: "local-isolated-test",
  botId: "studio-bot-01",
  purpose: "isolated-test",
  networkScope: "loopback",
  host: "127.0.0.1",
  port: 25565,
  minecraftVersion: "auto",
  username: "StudioBot",
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

describe("Mineflayer version compatibility", () => {
  it("reads the real supported range from the installed adapter", () => {
    expect(mineflayerVersionSupport).toMatchObject({
      oldest: "1.8.8",
      latest: "1.21.11",
    });
    expect(mineflayerVersionSupport.testedVersions).toContain("1.21.8");
    expect(isMineflayerTestedVersion("1.21.8")).toBe(true);
    expect(isMineflayerTestedVersion("1.21.10")).toBe(false);
  });

  it("uses Mineflayer auto detection only for explicit auto selection", () => {
    expect(createMineflayerOptions(baseProfile).version).toBeUndefined();
    expect(
      createMineflayerOptions({
        ...baseProfile,
        minecraftVersion: "1.21.8",
      }).version,
    ).toBe("1.21.8");
  });

  it("distinguishes tested, compatible-untested, and unsupported results", () => {
    expect(resolvedVersionCompatibility("auto", "1.21.8")).toMatchObject({
      selection: "auto",
      resolvedVersion: "1.21.8",
      supportLevel: "tested",
    });
    expect(resolvedVersionCompatibility("auto", "1.21.10")).toMatchObject({
      supportLevel: "compatible-untested",
    });
    expect(unsupportedVersionCompatibility("auto")).toMatchObject({
      resolvedVersion: null,
      supportLevel: "unsupported",
    });
    expect(() => resolvedVersionCompatibility("auto", "1.99.0")).toThrow();
  });
});

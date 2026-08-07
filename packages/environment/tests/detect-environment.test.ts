import { describe, expect, it } from "vitest";

import {
  captureMemorySample,
  detectEnvironment,
  resolveDeploymentMode,
  type CommandRunner,
} from "../src/index.js";

describe("resolveDeploymentMode", () => {
  it("honors an explicitly configured supported mode", () => {
    expect(resolveDeploymentMode({ STUDIO_MODE: "netcafe" }, false)).toEqual({
      value: "netcafe",
      source: "environment",
    });
  });

  it("detects Docker without binding to a host model", () => {
    expect(resolveDeploymentMode({}, true)).toEqual({
      value: "docker",
      source: "container-marker",
    });
  });

  it("falls back to standard for an invalid value", () => {
    expect(resolveDeploymentMode({ STUDIO_MODE: "fixed-host" }, false)).toEqual({
      value: "standard",
      source: "default",
    });
  });
});

describe("detectEnvironment", () => {
  it("returns schema-validated detected values and honest unavailable probes", async () => {
    const runner: CommandRunner = async (executable) => {
      if (executable === "lspci") {
        return {
          stdout:
            '00:02.0 "VGA compatible controller" "Example Vendor" "Example Adapter"',
          stderr: "",
        };
      }
      if (executable === "java") {
        const error = new Error("not found") as Error & { code: string };
        error.code = "ENOENT";
        throw error;
      }
      return { stdout: `${executable} version`, stderr: "" };
    };

    const snapshot = await detectEnvironment({
      env: { STUDIO_MODE: "portable" },
      platform: "linux",
      commandRunner: runner,
      dockerMarkerExists: async () => false,
      now: () => new Date("2026-07-19T10:00:00.000Z"),
      memoryReader: () => ({ totalBytes: 16_000, freeBytes: 8_000 }),
    });

    expect(snapshot.mode.value).toBe("portable");
    expect(snapshot.hardware.gpu).toEqual({
      status: "detected",
      source: "linux-lspci",
      devices: [{ name: "Example Adapter", vendor: "Example Vendor" }],
    });
    expect(snapshot.software.find(({ id }) => id === "java")?.status).toBe(
      "unavailable",
    );
    expect(snapshot.capturedAt).toBe("2026-07-19T10:00:00.000Z");
    expect(snapshot.hardware.memory).toEqual({
      totalBytes: 16_000,
      freeBytes: 8_000,
    });
  });
});

describe("captureMemorySample", () => {
  it("captures a fresh schema-validated OS memory reading", () => {
    let freeBytes = 8_000;
    const memoryReader = () => ({ totalBytes: 16_000, freeBytes });

    const first = captureMemorySample({
      memoryReader,
      now: () => new Date("2026-07-19T10:00:00.000Z"),
    });
    freeBytes = 7_000;
    const second = captureMemorySample({
      memoryReader,
      now: () => new Date("2026-07-19T10:00:05.000Z"),
    });

    expect(first).toEqual({
      schemaVersion: "1.0",
      capturedAt: "2026-07-19T10:00:00.000Z",
      source: "node-os",
      memory: { totalBytes: 16_000, freeBytes: 8_000 },
    });
    expect(second.memory.freeBytes).toBe(7_000);
    expect(second.capturedAt).toBe("2026-07-19T10:00:05.000Z");
  });

  it("rejects a reading whose free memory exceeds total memory", () => {
    expect(() =>
      captureMemorySample({
        memoryReader: () => ({ totalBytes: 8_000, freeBytes: 8_001 }),
      })
    ).toThrow();
  });
});

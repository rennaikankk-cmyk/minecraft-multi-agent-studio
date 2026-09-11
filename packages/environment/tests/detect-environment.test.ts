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

  it("reports unknown CPU cores as unavailable instead of fabricating one core", async () => {
    // AGENTS.md §1.9：探测失败必须显示不可用，不能补造状态。旧代码
    // Math.max(1, cpuList.length) 会把"一个核都没探到"发布成 logicalCores: 1。
    const snapshot = await detectEnvironment({
      env: {},
      platform: "linux",
      commandRunner: async () => ({ stdout: "", stderr: "" }),
      dockerMarkerExists: async () => false,
      now: () => new Date("2026-07-19T10:00:00.000Z"),
      memoryReader: () => ({ totalBytes: 16_000, freeBytes: 8_000 }),
      cpuReader: () => [],
    });

    expect(snapshot.hardware.cpu.logicalCores).toBeUndefined();
    expect(snapshot.hardware.cpu).not.toHaveProperty("logicalCores");
    expect(snapshot.hardware.cpu.logicalCores).not.toBe(1);
    expect(snapshot.hardware.cpu.cpuProbe).toEqual({
      source: "node-os-cpus",
      probeReason: "os_cpus_reported_no_logical_processors",
    });
    // 探测到真实核数时照常如实上报。
    const measured = await detectEnvironment({
      env: {},
      platform: "linux",
      commandRunner: async () => ({ stdout: "", stderr: "" }),
      dockerMarkerExists: async () => false,
      memoryReader: () => ({ totalBytes: 16_000, freeBytes: 8_000 }),
      cpuReader: () => [{ model: "Fixture CPU" }, { model: "Fixture CPU" }],
    });
    expect(measured.hardware.cpu.logicalCores).toBe(2);
    expect(measured.hardware.cpu.cpuProbe).toEqual({ source: "node-os-cpus" });
  });

  it("never publishes a zero or absent GPU memory reading as a measurement", async () => {
    // Number(null) === 0 会通过旧的 >= 0 守卫，把"驱动没给 AdapterRAM"发布成
    // memoryBytes: 0 —— 那是伪造的测量值。只有真实正整数才算测到。
    const snapshot = await detectEnvironment({
      env: {},
      platform: "win32",
      commandRunner: async (_executable, args) => {
        if (args.some((arg) => arg.includes("Win32_VideoController"))) {
          return {
            stdout: JSON.stringify([
              {
                Name: "Measured Adapter",
                AdapterRAM: 4_294_967_296,
                DriverVersion: "1.2.3",
              },
              { Name: "Null Adapter", AdapterRAM: null, DriverVersion: "" },
              { Name: "Wrapped Adapter", AdapterRAM: 0, DriverVersion: "" },
            ]),
            stderr: "",
          };
        }
        return { stdout: "", stderr: "" };
      },
      dockerMarkerExists: async () => false,
      memoryReader: () => ({ totalBytes: 16_000, freeBytes: 8_000 }),
      cpuReader: () => [{ model: "Fixture CPU" }],
    });

    const devices = snapshot.hardware.gpu.devices;
    expect(devices[0]).toEqual({
      name: "Measured Adapter",
      memoryBytes: 4_294_967_296,
      driverVersion: "1.2.3",
    });
    // 旧行为会给这两台发布 memoryBytes: 0。
    expect(devices[1]).toEqual({
      name: "Null Adapter",
      probeReason: "adapter_memory_not_reported",
    });
    expect(devices[2]).toEqual({
      name: "Wrapped Adapter",
      probeReason: "adapter_memory_not_a_positive_integer",
    });
    for (const device of devices) {
      expect(device.memoryBytes ?? null).not.toBe(0);
    }
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

import { describe, expect, it } from "vitest";

import { environmentSnapshotSchema } from "../src/index.js";

describe("environmentSnapshotSchema", () => {
  it("accepts a valid real-environment snapshot", () => {
    const result = environmentSnapshotSchema.safeParse({
      schemaVersion: "1.0",
      capturedAt: "2026-07-19T10:00:00.000Z",
      mode: { value: "standard", source: "default" },
      hardware: {
        platform: "linux",
        release: "6.8.0",
        architecture: "x64",
        cpu: { model: "Detected CPU", logicalCores: 8 },
        memory: { totalBytes: 16_000_000_000, freeBytes: 8_000_000_000 },
        gpu: { status: "not_detected", source: "lspci", devices: [] },
      },
      software: [
        {
          id: "node",
          status: "available",
          version: "v24.0.0",
          source: "local-process-probe",
        },
      ],
      warnings: [],
    });

    expect(result.success).toBe(true);
  });

  it("rejects impossible memory and unknown modes", () => {
    const result = environmentSnapshotSchema.safeParse({
      schemaVersion: "1.0",
      capturedAt: "2026-07-19T10:00:00.000Z",
      mode: { value: "fixed-host", source: "default" },
      hardware: {
        platform: "linux",
        release: "6.8.0",
        architecture: "x64",
        cpu: { model: "CPU", logicalCores: 8 },
        memory: { totalBytes: -1, freeBytes: 0 },
        gpu: { status: "not_detected", source: "probe", devices: [] },
      },
      software: [],
      warnings: [],
    });

    expect(result.success).toBe(false);
  });
});

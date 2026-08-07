import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureMemorySample = vi.hoisted(() => vi.fn());

vi.mock("@minecraft-studio/environment", () => ({ captureMemorySample }));

import { GET } from "../app/api/environment/memory/route";

const FIRST_SAMPLE = {
  schemaVersion: "1.0",
  capturedAt: "2026-07-19T10:00:00.000Z",
  source: "node-os",
  memory: { totalBytes: 16_000, freeBytes: 8_000 },
} as const;

beforeEach(() => {
  captureMemorySample.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Dashboard environment memory route", () => {
  it("captures a new no-store memory sample for every request", async () => {
    captureMemorySample
      .mockReturnValueOnce(FIRST_SAMPLE)
      .mockReturnValueOnce({
        ...FIRST_SAMPLE,
        capturedAt: "2026-07-19T10:00:05.000Z",
        memory: { totalBytes: 16_000, freeBytes: 7_000 },
      });

    const firstResponse = await GET();
    const secondResponse = await GET();
    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();

    expect(firstResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(secondResponse.headers.get("Cache-Control")).toBe("no-store");
    expect(firstBody.sample).toEqual(FIRST_SAMPLE);
    expect(secondBody.sample.memory.freeBytes).toBe(7_000);
    expect(firstBody.requestId).not.toBe(secondBody.requestId);
    expect(captureMemorySample).toHaveBeenCalledTimes(2);
  });

  it("returns a generic no-store failure without inventing memory values", async () => {
    captureMemorySample.mockImplementation(() => {
      throw new Error("invalid_os_reading");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body.error.code).toBe("ENVIRONMENT_MEMORY_CAPTURE_FAILED");
    expect(body).not.toHaveProperty("sample");
    expect(consoleError).toHaveBeenCalledWith(
      "Environment memory capture failed",
      expect.objectContaining({ code: "ENVIRONMENT_MEMORY_CAPTURE_FAILED" }),
    );
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { startPerfTelemetry } from "../src/perf-spans.js";

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("performance timer evidence", () => {
  it("reports timer lateness without subtracting the observation window twice", () => {
    vi.useFakeTimers();
    let wall = 100_000;
    vi.spyOn(Date, "now").mockImplementation(() => wall);
    const info = vi.fn();
    const stop = startPerfTelemetry({ logger: { info }, windowMs: 1000 });
    try {
      wall = 101_075;
      vi.advanceTimersByTime(1000);
      expect(info).toHaveBeenCalledWith("runtime_perf_window", expect.objectContaining({ timerDriftMs: 75 }));
    } finally { stop(); }
  });
});

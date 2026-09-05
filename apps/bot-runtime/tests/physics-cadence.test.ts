import { describe, expect, it } from "vitest";
import { PhysicsCadence } from "../src/physics-cadence.js";

describe("physical tick cadence", () => {
  it("measures intervals independently of network ping and resets across spawns", () => {
    const cadence = new PhysicsCadence();
    expect(cadence.snapshot("2026-09-06T00:00:00Z")).toBeNull();
    for (let i = 0; i <= 30; i++) cadence.record(i * 50);
    cadence.record(2_000);
    expect(cadence.snapshot("2026-09-06T00:00:00Z")).toMatchObject({ samples: 31, p95IntervalMs: 50, maxIntervalMs: 500 });
    for (let i = 1; i <= 300; i++) cadence.record(2_000 + i * 50);
    expect(cadence.snapshot("2026-09-06T00:00:00Z")).toMatchObject({ samples: 256, maxIntervalMs: 50 });
    cadence.reset();
    expect(cadence.snapshot("2026-09-06T00:00:00Z")).toBeNull();
  });
});

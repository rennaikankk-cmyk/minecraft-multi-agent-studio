import { describe, expect, it } from "vitest";
import { botStatusV1Schema } from "../src/bot-messages.js";
import { publicBotDetailV1Schema } from "../src/control-api.js";

describe("autonomy telemetry boundaries", () => {
  it("shares the measured performance contract across runtime and public detail", () => {
    const performance = { physics: { observedAt: "2026-09-06T00:00:00Z", samples: 32, p95IntervalMs: 50, maxIntervalMs: 100 }, eventLoop: null };
    expect(botStatusV1Schema.shape.payload.shape.performance.parse(performance)).toEqual(performance);
    expect(publicBotDetailV1Schema.shape.performance.parse(performance)).toEqual(performance);
    expect(publicBotDetailV1Schema.shape.performance.safeParse({ ...performance, physics: { ...performance.physics, p95IntervalMs: -1 } }).success).toBe(false);
    expect(publicBotDetailV1Schema.shape.performance.safeParse({ ...performance, physics: { ...performance.physics, samples: 0 } }).success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { advanceCompositeTask, compositeTaskSchema } from "../src/composite-task.js";

const base = compositeTaskSchema.parse({
  schemaVersion: "1.0", taskId: "00000000-0000-4000-8000-000000000001", kind: "FOOD_FACILITY", status: "RUNNING",
  serverProfileId: "isolated", dimension: "minecraft:overworld", botIds: ["bot-1"], currentPhase: "prepare",
  completedPhases: [], checkpoint: { revision: 0, cursor: 0, evidence: [], updatedAtMs: 1_000 }, dependencies: [],
  leaseOwner: "coord-a", fencingToken: 1, lastErrorCode: null, createdAtMs: 1_000, updatedAtMs: 1_000,
});

describe("recoverable composite task protocol", () => {
  it("advances with an evidence checkpoint and preserves the cursor", () => {
    const next = advanceCompositeTask(base, { phase: "plant", status: "WAITING", nowMs: 2_000, cursor: 4, evidence: ["plant-readback"] });
    expect(next.checkpoint).toMatchObject({ revision: 1, cursor: 4, evidence: ["plant-readback"] });
    expect(next.status).toBe("WAITING");
  });

  it("rejects backwards clocks", () => {
    expect(() => advanceCompositeTask(base, { phase: "prepare", status: "RECOVERING", nowMs: 999 })).toThrow("clock moved backwards");
  });
});

import { describe, expect, it } from "vitest";
import { ResourceLedger, resourceObservationInputSchema } from "../src/planning/resource-management.js";
import { ResourceLedger as Authority } from "@minecraft-studio/resource-management";

describe("resource management compatibility entry", () => {
  it("exports the single resource authority; reservation/receipt scenarios live in its package", () => {
    expect(ResourceLedger).toBe(Authority);
  });
  it("rejects the old unversioned inventory fixture with a fabricated timestamp", () => {
    expect(resourceObservationInputSchema.safeParse({ scope: { serverProfileId: "s", worldId: "w", dimension: "minecraft:overworld" },
      containerId: "c", itemId: "iron", quantity: 8, status: "observed", revision: 1, observedAt: "t" }).success).toBe(false);
  });
});

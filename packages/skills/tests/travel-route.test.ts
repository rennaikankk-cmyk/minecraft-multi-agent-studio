import { describe, expect, it, vi } from "vitest";

import {
  estimateTravelRouteSegments,
  nextTravelRouteSegment,
  travelRouteCapabilityInputSchema,
  travelRouteInputSchema,
  travelRouteOutputSchema,
  travelRouteSkill,
} from "../src/index.js";

const serverProfileId = "isolated-local";
const dimension = "minecraft:overworld";
const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId,
  position: { x: 0, y: 64, z: 0, dimension, serverProfileId },
};

describe("travel.route@1.0.0", () => {
  it("splits a long path into bounded independent segments", () => {
    const destination = { x: 150, y: 64, z: 0 };
    expect(
      estimateTravelRouteSegments(state.position, destination, "pathfinder"),
    ).toBe(3);
    let cursor = { x: 0, y: 64, z: 0 };
    const segments = [];
    while (cursor.x !== destination.x || cursor.y !== destination.y || cursor.z !== destination.z) {
      const next = nextTravelRouteSegment(cursor, destination, "pathfinder");
      expect(Math.hypot(next.x - cursor.x, next.y - cursor.y, next.z - cursor.z)).toBeLessThanOrEqual(64);
      segments.push(next);
      cursor = next;
    }
    expect(segments).toHaveLength(3);
    expect(cursor).toEqual(destination);
  });

  it("keeps axis-aligned corridor segments on one axis", () => {
    const next = nextTravelRouteSegment(
      { x: 0, y: 64, z: 0 },
      { x: 80, y: 64, z: 80 },
      "axis-aligned",
    );
    expect(next).toEqual({ x: 64, y: 64, z: 0 });
  });

  it("keeps the required fail-closed rejection order", () => {
    expect(travelRouteSkill.preconditions.map(({ failureCode }) => failureCode)).toEqual([
      "BOT_NOT_ONLINE",
      "NORMAL_ACTIONS_PAUSED",
      "BOT_POSITION_UNAVAILABLE",
      "TARGET_SERVER_PROFILE_MISMATCH",
      "TARGET_DIMENSION_MISMATCH",
      "POLICY_ROUTE_SEGMENT_LIMIT",
    ]);
  });

  it("calls one bounded movement operation per segment and audits actual readback", async () => {
    const invoke = vi.fn(async (request: { input: unknown }) => {
      const input = travelRouteCapabilityInputSchema.parse(request.input);
      return {
        reached: true,
        finalPosition: input.target,
        distanceToTarget: 0,
      };
    });
    const output = await travelRouteSkill.execute(
      {
        invocationId: "22222222-2222-4222-8222-222222222222",
        traceId: "trace-route",
        taskId: "task-route",
        botId: "bot-route",
        signal: new AbortController().signal,
        deadlineMs: Date.now() + 60_000,
        compatibility: {
          minecraftVersion: null,
          protocolVersion: null,
          variantId: "portable",
          verification: "unverified",
        },
        callCapability: async (_capability, _operation, input) => invoke({ input }),
      },
      {
        destination: { x: 130, y: 64, z: 0 },
        dimension,
        serverProfileId,
        maxSegments: 3,
        corridorPolicy: "pathfinder",
      },
      state,
    );
    const parsed = travelRouteOutputSchema.parse(output);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(parsed.segmentCount).toBe(3);
    expect(parsed.segmentAudits[0]).toMatchObject({
      requested: { x: 64, y: 64, z: 0, dimension, serverProfileId },
      executed: { x: 64, y: 64, z: 0, dimension, serverProfileId },
      l0Interrupted: false,
      status: "executed",
      reasonCode: null,
    });
    expect(parsed.finalPosition.x).toBe(130);
  });

  it("rejects invalid route budgets and corridor modes", () => {
    expect(
      travelRouteInputSchema.safeParse({
        destination: { x: 1, y: 64, z: 1 },
        dimension,
        serverProfileId,
        maxSegments: 0,
        corridorPolicy: "pathfinder",
      }).success,
    ).toBe(false);
    expect(
      travelRouteInputSchema.safeParse({
        destination: { x: 1, y: 64, z: 1 },
        dimension,
        serverProfileId,
        maxSegments: 1,
        corridorPolicy: "unknown",
      }).success,
    ).toBe(false);
  });
});

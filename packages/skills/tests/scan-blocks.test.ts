import { describe, expect, it, vi } from "vitest";

import {
  SCAN_BLOCKS_TIMEOUT_MS,
  SCAN_MAX_COUNT,
  SCAN_MAX_DISTANCE,
  scanBlocksInputSchema,
  scanBlocksOutputSchema,
  scanBlocksSkill,
} from "../src/index.js";

const serverProfileId = "isolated-local";
const dimension = "minecraft:overworld";
const position = { x: 10, y: 64, z: -20, dimension, serverProfileId };
const input = {
  blockName: "oak_log",
  maxCount: 4,
  maxDistance: 32,
  dimension,
  serverProfileId,
};
const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId,
  position,
};

function context(callCapability: (...args: never[]) => Promise<unknown>) {
  return {
    invocationId: "inv",
    traceId: "trace",
    taskId: "task",
    botId: "bot",
    signal: new AbortController().signal,
    deadlineMs: Date.now() + SCAN_BLOCKS_TIMEOUT_MS,
    compatibility: {
      minecraftVersion: null,
      protocolVersion: null,
      variantId: "portable",
      verification: "unverified" as const,
    },
    callCapability,
  } as never;
}

function checkPrecondition(id: string, override: Partial<typeof state>): boolean {
  const precondition = scanBlocksSkill.preconditions.find(
    (candidate) => candidate.id === id,
  );
  expect(precondition, `precondition ${id} must exist`).toBeDefined();
  return precondition!.check(input, { ...state, ...override }, {} as never);
}

describe("world.scan", () => {
  it("is a read-only, idempotent perception skill", () => {
    // The whole point of this skill is that it cannot change the world: it is
    // what lets the planner look before it digs. A drift to world.interact or
    // to idempotent: false would silently make it a mutating step.
    expect(scanBlocksSkill.id).toBe("world.scan");
    expect(scanBlocksSkill.requiredCapabilities).toEqual(["world.read"]);
    expect(scanBlocksSkill.idempotent).toBe(true);
    expect(scanBlocksSkill.retryPolicy.maxAttempts).toBe(1);
  });

  it("refuses to scan when offline, paused, or aimed elsewhere", () => {
    expect(checkPrecondition("bot.online", {})).toBe(true);
    expect(checkPrecondition("bot.online", { online: false })).toBe(false);
    // Read-only does not exempt it from the L0 pause: an exception here would
    // be a detour around the pause for anything that only needs to observe.
    expect(
      checkPrecondition("l0.normal-actions-allowed", {
        normalActionsAllowed: false,
      }),
    ).toBe(false);
    expect(
      checkPrecondition("target.server-profile-matches", {
        serverProfileId: "other-server",
      }),
    ).toBe(false);
    expect(
      checkPrecondition("target.dimension-matches", {
        position: { ...position, dimension: "minecraft:the_nether" },
      }),
    ).toBe(false);
    // No observed position is not "assume the current dimension": fail closed.
    expect(checkPrecondition("target.dimension-matches", { position: null })).toBe(
      false,
    );
  });

  it("does not gate on inventory space", () => {
    // Scanning produces no drops, so an INVENTORY_FULL rejection here would
    // block an honest observation for a reason that cannot affect it.
    expect(
      scanBlocksSkill.preconditions.map((precondition) => precondition.id),
    ).not.toContain("inventory.has-room");
  });

  it("calls exactly one bounded read operation and returns its parsed output", async () => {
    const expected = {
      blockName: "oak_log",
      dimension,
      matches: [
        { x: 11, y: 64, z: -20, distance: 1 },
        { x: 14, y: 64, z: -20, distance: 4 },
      ],
      targetsFound: 2,
      complete: true,
    };
    const callCapability = vi.fn(async () => expected);

    const output = await scanBlocksSkill.execute(
      context(callCapability),
      input,
      state,
    );

    expect(callCapability).toHaveBeenCalledWith(
      "world.read",
      "world.scan-blocks-safe",
      input,
    );
    expect(output).toEqual(expected);
  });

  it("rejects an adapter result that claims more matches than it found", async () => {
    // targetsFound is the findBlocks hit count, so matches can never exceed it;
    // if it does, the adapter invented a location.
    const callCapability = vi.fn(async () => ({
      blockName: "oak_log",
      dimension,
      matches: Array.from({ length: SCAN_MAX_COUNT + 1 }, (_, index) => ({
        x: index,
        y: 64,
        z: 0,
        distance: index,
      })),
      targetsFound: 1,
      complete: true,
    }));

    await expect(
      scanBlocksSkill.execute(context(callCapability), input, state),
    ).rejects.toThrow();
  });

  it("bounds the request and rejects unknown or namespaced block names", () => {
    expect(scanBlocksInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, maxCount: SCAN_MAX_COUNT + 1 },
      { ...input, maxCount: 0 },
      { ...input, maxDistance: SCAN_MAX_DISTANCE + 1 },
      { ...input, maxDistance: 1 },
      { ...input, blockName: "minecraft:oak_log" },
      { ...input, blockName: "Oak_Log" },
      { ...input, extra: true },
    ]) {
      expect(
        scanBlocksInputSchema.safeParse(invalid).success,
        `${JSON.stringify(invalid)} must be rejected`,
      ).toBe(false);
    }
  });

  it("requires integer coordinates and a non-negative distance per match", () => {
    const base = {
      blockName: "oak_log",
      dimension,
      matches: [{ x: 1, y: 64, z: 2, distance: 3.5 }],
      targetsFound: 1,
      complete: true,
    };
    expect(scanBlocksOutputSchema.safeParse(base).success).toBe(true);
    for (const invalid of [
      { ...base, matches: [{ x: 1.5, y: 64, z: 2, distance: 3.5 }] },
      { ...base, matches: [{ x: 1, y: 64, z: 2, distance: -1 }] },
      // Per-match dimension/profile would be a second copy that can drift from
      // the top-level pair; the schema refuses to carry one.
      { ...base, matches: [{ x: 1, y: 64, z: 2, distance: 3.5, dimension }] },
    ]) {
      expect(
        scanBlocksOutputSchema.safeParse(invalid).success,
        `${JSON.stringify(invalid)} must be rejected`,
      ).toBe(false);
    }
  });
});

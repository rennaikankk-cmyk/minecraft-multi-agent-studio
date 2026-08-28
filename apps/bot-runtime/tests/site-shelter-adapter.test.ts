import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { Vec3 } from "vec3";
import { DEFAULT_UNVERIFIED_SITE_POLICY, assessSite } from "@minecraft-studio/skills";

import { digShelter, observeSite } from "../src/site-shelter-adapter.js";

function fakeBot(overrides: Record<string, unknown> = {}) {
  const emitter = new EventEmitter();
  const bot = Object.assign(emitter, {
    game: { dimension: "overworld" },
    entity: { position: new Vec3(12_345, 40, 15_678), type: "player" },
    entities: {},
    blockAt: vi.fn((position: Vec3) => ({ name: "stone", boundingBox: "block", position })),
    inventory: { items: vi.fn(() => []) },
    canDigBlock: vi.fn(() => true),
    pathfinder: { goto: vi.fn(), stop: vi.fn() },
    ...overrides,
  });
  return bot as never;
}

describe("N2 site-shelter runtime adapter", () => {
  it("returns incomplete when any loaded-chunk sample is unavailable", () => {
    const bot = fakeBot({ blockAt: vi.fn(() => null) });
    const result = observeSite(bot, "isolated-local", {
      candidate: { x: 12_345, y: 40, z: 15_678, dimension: "minecraft:overworld", serverProfileId: "isolated-local" },
      policy: { minHighwayDistance: 1_000, minPortalLineDistance: 512, hazardClearance: 64, burialDepthTarget: 24 },
    });
    expect(result.complete).toBe(false);
    expect(result.nearestHazardDistance).toBe(32);
  });

  it("rejects straight down before inspecting or mutating the world", async () => {
    const bot = fakeBot({ dig: vi.fn(), placeBlock: vi.fn() });
    await expect(digShelter(bot, "isolated-local", {
      direction: "down", depth: 2, sealItemName: "cobblestone", dimension: "minecraft:overworld", serverProfileId: "isolated-local",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "POLICY_STRAIGHT_DOWN_FORBIDDEN" });
    expect((bot as { dig: ReturnType<typeof vi.fn> }).dig).not.toHaveBeenCalled();
    expect((bot as { placeBlock: ReturnType<typeof vi.fn> }).placeBlock).not.toHaveBeenCalled();
  });

  it("rejects cross-server observations fail-closed", () => {
    const bot = fakeBot();
    try {
      observeSite(bot, "isolated-local", {
        candidate: { x: 0, y: 40, z: 0, dimension: "minecraft:overworld", serverProfileId: "other-server" },
        policy: { minHighwayDistance: 1_000, minPortalLineDistance: 512, hazardClearance: 64, burialDepthTarget: 24 },
      });
      throw new Error("expected scope mismatch");
    } catch (error) {
      expect(error).toMatchObject({ code: "TARGET_SERVER_PROFILE_MISMATCH" });
    }
  });

  it("rejects a deep foundation with exposed overhead cover", () => {
    const calls: Vec3[] = [];
    const candidate = { x: 12_345, y: 40, z: 15_678, dimension: "minecraft:overworld", serverProfileId: "isolated-local" };
    const policy = {
      ...DEFAULT_UNVERIFIED_SITE_POLICY,
      minPortalLineDistance: 0,
      hazardClearance: 0,
      burialDepthTarget: 2,
      acceptanceScore: 0.4,
    };
    const bot = fakeBot({
      blockAt: vi.fn((position: Vec3) => {
        calls.push(position);
        if (position.x === candidate.x && position.z === candidate.z && position.y > candidate.y) {
          return { name: "air", boundingBox: "empty", position };
        }
        // The foundation is solid at every depth below the candidate. It must
        // not contribute to the upward-cover burialDepth contract.
        return { name: "stone", boundingBox: "block", position };
      }),
    });
    const worldFacts = observeSite(bot, "isolated-local", { candidate, policy });
    const assessment = assessSite({ candidate, worldFacts, ownRecords: [], policy });

    expect(worldFacts).toMatchObject({ complete: true, burialDepth: 0 });
    expect(calls).toContainEqual(new Vec3(12_345, 41, 15_678));
    expect(calls).not.toContainEqual(new Vec3(12_345, 39, 15_678));
    expect(assessment).toMatchObject({ verdict: "REJECT", hardRuleFailures: [] });
  });

  it("caps upward cover sampling at the ceiling of burialDepthTarget", () => {
    const calls: Vec3[] = [];
    const bot = fakeBot({
      blockAt: vi.fn((position: Vec3) => {
        calls.push(position);
        return { name: "stone", boundingBox: "block", position };
      }),
    });
    const result = observeSite(bot, "isolated-local", {
      candidate: { x: 12_345, y: 40, z: 15_678, dimension: "minecraft:overworld", serverProfileId: "isolated-local" },
      policy: { minHighwayDistance: 1_000, minPortalLineDistance: 512, hazardClearance: 64, burialDepthTarget: 2.25 },
    });

    expect(result.burialDepth).toBe(3);
    expect(calls).toEqual(expect.arrayContaining([
      new Vec3(12_345, 41, 15_678),
      new Vec3(12_345, 42, 15_678),
      new Vec3(12_345, 43, 15_678),
    ]));
    expect(calls).not.toContainEqual(new Vec3(12_345, 44, 15_678));
    expect(calls).not.toContainEqual(new Vec3(12_345, 39, 15_678));
  });

  it("marks the observation incomplete when an overhead sample is unavailable", () => {
    const bot = fakeBot({
      blockAt: vi.fn((position: Vec3) => {
        if (position.x === 12_345 && position.z === 15_678 && position.y === 42) return null;
        return { name: "stone", boundingBox: "block", position };
      }),
    });
    const result = observeSite(bot, "isolated-local", {
      candidate: { x: 12_345, y: 40, z: 15_678, dimension: "minecraft:overworld", serverProfileId: "isolated-local" },
      policy: { minHighwayDistance: 1_000, minPortalLineDistance: 512, hazardClearance: 64, burialDepthTarget: 3 },
    });

    expect(result).toMatchObject({ complete: false, burialDepth: 1 });
  });

  it("does not claim movedInside until pathfinder reaches the shelter", async () => {
    const bot = fakeBot({
      dig: vi.fn(async () => undefined),
      placeBlock: vi.fn(async () => undefined),
      equip: vi.fn(async () => undefined),
      inventory: { items: vi.fn(() => [{ name: "cobblestone" }]) },
      pathfinder: { goto: vi.fn(async () => undefined), stop: vi.fn() },
    });
    await expect(digShelter(bot, "isolated-local", {
      direction: "east", depth: 2, sealItemName: "cobblestone", dimension: "minecraft:overworld", serverProfileId: "isolated-local",
    }, new AbortController().signal)).rejects.toMatchObject({ code: "SHELTER_STEP_BLOCKED" });
    expect((bot as { placeBlock: ReturnType<typeof vi.fn> }).placeBlock).not.toHaveBeenCalled();
  });

  it("equips a harvestable tool before digging a stone shelter", async () => {
    const equip = vi.fn(async () => undefined);
    const pickaxe = { name: "iron_pickaxe", type: 1 };
    const entity = { position: new Vec3(12_345, 40, 15_678), type: "player" };
    const dug = new Set<string>();
    const bot = fakeBot({
      entity,
      dig: vi.fn(async (block: { position?: Vec3 }) => {
        if (block.position) dug.add(block.position.toString());
      }),
      placeBlock: vi.fn(async () => undefined),
      equip,
      inventory: { items: vi.fn(() => [pickaxe, { name: "cobblestone", type: 2 }]) },
      blockAt: vi.fn((position: Vec3) => ({
        name: position.x < 12_347 ? "stone" : "air",
        boundingBox: dug.has(position.toString()) || position.x >= 12_347 ? "empty" : "block",
        position,
        canHarvest: (itemType: number | null) => itemType === 1,
      })),
      pathfinder: {
        goto: vi.fn(async () => {
          entity.position = new Vec3(12_347, 40, 15_678);
        }),
        stop: vi.fn(),
      },
    });
    await expect(digShelter(bot, "isolated-local", {
      direction: "east", depth: 2, sealItemName: "cobblestone", dimension: "minecraft:overworld", serverProfileId: "isolated-local",
    }, new AbortController().signal)).resolves.toMatchObject({ dugBlocks: 2, movedInside: true, sealed: true });
    expect(equip).toHaveBeenCalledWith(pickaxe, "hand");
  });

  it("seals the original standing cell from inside the shelter", async () => {
    const origin = new Vec3(12_345, 40, 15_678);
    const shelter = origin.offset(2, 0, 0);
    const entity = { position: origin, type: "player" };
    const dug = new Set<string>();
    const placeBlock = vi.fn(async () => undefined);
    const bot = fakeBot({
      entity,
      dig: vi.fn(async (block: { position?: Vec3 }) => {
        if (block.position) dug.add(block.position.toString());
      }),
      placeBlock,
      equip: vi.fn(async () => undefined),
      inventory: { items: vi.fn(() => [{ name: "cobblestone", type: 2 }]) },
      blockAt: vi.fn((position: Vec3) => {
        const key = position.toString();
        const inTunnel = position.x >= origin.x + 1 && position.x <= shelter.x &&
          (position.y === origin.y || position.y === origin.y + 1) && position.z === origin.z;
        if (inTunnel && dug.has(key)) return { name: "air", boundingBox: "empty", position };
        return { name: "stone", boundingBox: "block", position };
      }),
      pathfinder: {
        goto: vi.fn(async () => {
          entity.position = shelter;
        }),
        stop: vi.fn(),
      },
    });

    await expect(digShelter(bot, "isolated-local", {
      direction: "east", depth: 2, sealItemName: "cobblestone", dimension: "minecraft:overworld", serverProfileId: "isolated-local",
    }, new AbortController().signal)).resolves.toMatchObject({
      shelterPosition: { x: shelter.x, y: shelter.y, z: shelter.z },
      sealed: true,
    });

    expect(placeBlock).toHaveBeenCalledTimes(1);
    const [support, face] = placeBlock.mock.calls[0] as [
      { position: Vec3 },
      Vec3,
    ];
    expect(support.position).toEqual(origin.offset(0, -1, 0));
    expect(face).toEqual(new Vec3(0, 1, 0));
  });

  it("falls back to a bounded forward walk when pathfinder entry times out", async () => {
    vi.useFakeTimers();
    try {
      const origin = new Vec3(12_345, 40, 15_678);
      const shelter = origin.offset(2, 0, 0);
      const entity = { position: origin, type: "player" };
      const dug = new Set<string>();
      const goto = vi.fn(() => new Promise<void>(() => {}));
      const setGoal = vi.fn();
      const setControlState = vi.fn((state: string, enabled: boolean) => {
        if (state === "forward" && enabled) entity.position = shelter;
      });
      const bot = fakeBot({
        entity,
        dig: vi.fn(async (block: { position?: Vec3 }) => {
          if (block.position) dug.add(block.position.toString());
        }),
        placeBlock: vi.fn(async () => undefined),
        equip: vi.fn(async () => undefined),
        setControlState,
        look: vi.fn(async () => undefined),
        clearControlStates: vi.fn(),
        inventory: { items: vi.fn(() => [{ name: "cobblestone", type: 2 }]) },
        blockAt: vi.fn((position: Vec3) => {
          const key = position.toString();
          const inTunnel = position.x >= origin.x + 1 && position.x <= shelter.x &&
            (position.y === origin.y || position.y === origin.y + 1) && position.z === origin.z;
          if (inTunnel && dug.has(key)) return { name: "air", boundingBox: "empty", position };
          return { name: "stone", boundingBox: "block", position };
        }),
        pathfinder: { goto, setGoal, stop: vi.fn() },
      });

      const completion = digShelter(bot, "isolated-local", {
        direction: "east", depth: 2, sealItemName: "cobblestone", dimension: "minecraft:overworld", serverProfileId: "isolated-local",
      }, new AbortController().signal);
      await vi.advanceTimersByTimeAsync(8_000);

      await expect(completion).resolves.toMatchObject({ movedInside: true, sealed: true });
      expect(goto).toHaveBeenCalledTimes(1);
      expect(setGoal).toHaveBeenCalledWith(null);
      expect(setControlState).toHaveBeenCalledWith("forward", true);
    } finally {
      vi.useRealTimers();
    }
  });
});

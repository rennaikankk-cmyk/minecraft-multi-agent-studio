import { describe, expect, it } from "vitest";

import {
  SURROUND_BLAST_RESISTANCE,
  SurroundPlanner,
  type CombatSurroundOccupancy,
  type CombatSurroundSnapshot,
} from "../src/surround-planner.js";
import type { CombatVector3 } from "../src/threat-analyzer.js";

const SELF = { x: 0, y: 64, z: 0 };
const BASE_COVERAGE = 5 / 14;
const REPLACEABLE: CombatSurroundOccupancy = {
  state: "replaceable",
  blastResistance: null,
};

function key(position: CombatVector3): string {
  return `${position.x}:${position.y}:${position.z}`;
}

function occupancy(
  values: Readonly<Record<string, CombatSurroundOccupancy>> = {},
): CombatSurroundSnapshot["occupancy"] {
  return (position) => values[key(position)] ?? REPLACEABLE;
}

function snapshot(
  overrides: Partial<CombatSurroundSnapshot> = {},
): CombatSurroundSnapshot {
  return {
    selfFootPosition: SELF,
    occupancy: occupancy(),
    inventoryBlocks: [{ blockClass: "obsidian", count: 14 }],
    reachDistance: 5,
    threatDirections: [],
    coverageObjective01: BASE_COVERAGE,
    retreatInProgress: false,
    explosiveCombat: {
      mode: "CRYSTAL",
      inventoryVerified: true,
      candidateVerified: true,
    },
    ...overrides,
  };
}

describe("SurroundPlanner", () => {
  it("keeps retreat first and gates non-explosive combat", () => {
    const planner = new SurroundPlanner();
    expect(planner.plan(snapshot({
      retreatInProgress: true,
      explosiveCombat: {
        mode: "NONE",
        inventoryVerified: false,
        candidateVerified: false,
      },
      inventoryBlocks: [],
    })).refusal).toBe("RETREAT_IN_PROGRESS");

    expect(planner.plan(snapshot({
      explosiveCombat: {
        mode: "NONE",
        inventoryVerified: false,
        candidateVerified: false,
      },
    })).refusal).toBe("EXPLOSIVE_COMBAT_NOT_READY");
    expect(planner.plan(snapshot({
      explosiveCombat: {
        mode: "ANCHOR",
        inventoryVerified: true,
        candidateVerified: false,
      },
    })).refusal).toBe("EXPLOSIVE_COMBAT_NOT_READY");
  });

  it("preserves the remaining refusal order", () => {
    const planner = new SurroundPlanner();
    expect(planner.plan(snapshot({ inventoryBlocks: [] })).refusal).toBe(
      "NO_BLAST_RESISTANT_BLOCKS",
    );
    expect(planner.plan(snapshot({ reachDistance: 0.1 })).refusal).toBe(
      "ALL_OFFSETS_OUT_OF_REACH",
    );
    expect(planner.plan(snapshot({
      occupancy: occupancy(new Proxy({}, {
        get: () => ({ state: "occupied", blastResistance: 1 }),
      }) as Readonly<Record<string, CombatSurroundOccupancy>>),
    })).refusal).toBe("ALL_OFFSETS_OCCUPIED");
  });

  it("prioritizes the side facing the strongest threat", () => {
    const plan = new SurroundPlanner().plan(snapshot({
      coverageObjective01: 1 / 14,
      threatDirections: [{ direction: { x: 1, y: 0, z: 0 }, weight: 4 }],
    }));
    expect(plan.placements[0]?.position).toEqual({ x: 1, y: 64, z: 0 });
  });

  it("covers the four cardinal feet and floor at the base objective", () => {
    const plan = new SurroundPlanner().plan(snapshot());
    expect(plan.objectiveMet).toBe(true);
    expect(plan.coverageAchieved01).toBeCloseTo(BASE_COVERAGE, 10);
    expect(plan.placements.map(({ position }) => key(position))).toEqual([
      "0:64:-1",
      "1:64:0",
      "0:64:1",
      "-1:64:0",
      "0:63:0",
    ]);
  });

  it("includes head-height sides and the roof for anchor denial", () => {
    const plan = new SurroundPlanner().plan(snapshot({
      coverageObjective01: 10 / 14,
    }));
    expect(plan.placements.map(({ position }) => key(position))).toEqual(
      expect.arrayContaining([
        "0:65:-1",
        "1:65:0",
        "0:65:1",
        "-1:65:0",
        "0:66:0",
      ]),
    );
  });

  it("counts existing 1200-resistance structure toward coverage", () => {
    const plan = new SurroundPlanner().plan(snapshot({
      occupancy: occupancy({
        "1:64:0": {
          state: "occupied",
          blastResistance: SURROUND_BLAST_RESISTANCE,
        },
      }),
    }));
    expect(plan.existingProtectedCount).toBe(1);
    expect(plan.placements).toHaveLength(4);
    expect(plan.objectiveMet).toBe(true);
  });

  it("does not treat weak or unknown occupancy as air", () => {
    const plan = new SurroundPlanner().plan(snapshot({
      occupancy: occupancy({
        "0:64:-1": { state: "occupied", blastResistance: 10 },
        "1:64:0": { state: "unknown", blastResistance: null },
      }),
    }));
    expect(plan.placements.map(({ position }) => key(position))).not.toContain(
      "0:64:-1",
    );
    expect(plan.placements.map(({ position }) => key(position))).not.toContain(
      "1:64:0",
    );
    expect(plan.exposedOffsets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        position: { x: 0, y: 64, z: -1 },
        reason: "OCCUPIED_WEAK",
      }),
      expect.objectContaining({
        position: { x: 1, y: 64, z: 0 },
        reason: "OCCUPANCY_UNKNOWN",
      }),
    ]));
  });

  it("reports reach and inventory-limited exposure separately", () => {
    const outOfReach = new SurroundPlanner().plan(snapshot({
      reachDistance: 1.5,
      coverageObjective01: 1,
    }));
    expect(outOfReach.exposedOffsets.some(({ reason }) =>
      reason === "OUT_OF_REACH"
    )).toBe(true);

    const exhausted = new SurroundPlanner().plan(snapshot({
      inventoryBlocks: [{ blockClass: "obsidian", count: 1 }],
    }));
    expect(exhausted.objectiveMet).toBe(false);
    expect(exhausted.exposedOffsets.some(({ reason }) =>
      reason === "INVENTORY_EXHAUSTED"
    )).toBe(true);
  });

  it("prefers inert materials and consumes respawn anchors last", () => {
    const plan = new SurroundPlanner().plan(snapshot({
      inventoryBlocks: [
        { blockClass: "respawn_anchor", count: 1 },
        { blockClass: "netherite_block", count: 1 },
        { blockClass: "ancient_debris", count: 1 },
        { blockClass: "crying_obsidian", count: 1 },
        { blockClass: "obsidian", count: 1 },
      ],
    }));
    expect(plan.placements.map(({ blockClass }) => blockClass)).toEqual([
      "obsidian",
      "crying_obsidian",
      "ancient_debris",
      "netherite_block",
      "respawn_anchor",
    ]);
  });

  it("reports shared crystal and anchor entity ranges", () => {
    expect(new SurroundPlanner().plan(snapshot()).blastRangesUsed).toEqual({
      crystal: 12,
      anchor: 10,
    });
  });

  it("labels surplus offsets as intentionally unselected", () => {
    const plan = new SurroundPlanner().plan(snapshot({
      coverageObjective01: 1 / 14,
    }));
    expect(plan.objectiveMet).toBe(true);
    expect(plan.exposedOffsets.every(({ reason }) =>
      reason === "OBJECTIVE_NOT_SELECTED"
    )).toBe(true);
  });

  it("rejects malformed readiness instead of enabling surround", () => {
    expect(() => new SurroundPlanner().plan(snapshot({
      explosiveCombat: {
        mode: "NONE",
        inventoryVerified: true,
        candidateVerified: false,
      } as never,
    }))).toThrowError(TypeError);
  });
});

import { describe, expect, it } from "vitest";

import {
  CombatIdentityRegistry,
  type CombatWhitelistSource,
} from "../src/identity.js";
import {
  ThreatAnalyzer,
  type CombatEntityObservation,
  type CombatThreatSnapshot,
} from "../src/threat-analyzer.js";

const SERVER = "local-isolated-test";

const whitelist: CombatWhitelistSource = {
  provenance: "operator-config",
  serverProfileId: SERVER,
  selfUsername: "StudioBot",
  usernames: ["Renna"],
  uuids: [],
};

function analyzer(): ThreatAnalyzer {
  return new ThreatAnalyzer(
    CombatIdentityRegistry.fromOperatorConfig(whitelist),
  );
}

function observation(
  overrides: Partial<CombatEntityObservation> = {},
): CombatEntityObservation {
  return {
    entity: { entityId: 1, kind: "player", username: "Stranger", uuid: null },
    position: { x: 30, y: 64, z: 0 },
    velocity: null,
    health: 20,
    armorPoints: 0,
    wieldingWeapon: false,
    crystalNearby: false,
    anchorNearby: false,
    ...overrides,
  };
}

function snapshot(
  overrides: Partial<CombatThreatSnapshot> = {},
): CombatThreatSnapshot {
  return {
    observedAtMs: 1_000,
    serverProfileId: SERVER,
    selfPosition: { x: 0, y: 64, z: 0 },
    selfHealth: 20,
    totemCount: 2,
    entities: [],
    ...overrides,
  };
}

describe("ThreatAnalyzer", () => {
  it("reports no threat when only whitelisted players are present", () => {
    const assessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            entity: {
              entityId: 7,
              kind: "player",
              username: "Renna",
              uuid: null,
            },
            position: { x: 1, y: 64, z: 0 },
          }),
        ],
      }),
    );
    expect(assessment).toMatchObject({
      level: "none",
      hostileCount: 0,
      threats: [],
      evaluatedAtMs: 1_000,
    });
  });

  it("ignores animals and calm endermen but reports an angry enderman", () => {
    const neutralAssessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            entity: {
              entityId: 2,
              kind: "animal",
              username: null,
              uuid: null,
            },
            position: { x: 1, y: 64, z: 0 },
          }),
          observation({
            entity: {
              entityId: 3,
              kind: "monster",
              username: null,
              uuid: null,
              mobType: "enderman",
              endermanState: "calm",
            },
            position: { x: 1, y: 64, z: 1 },
          }),
        ],
      }),
    );
    expect(neutralAssessment.hostileCount).toBe(0);

    const angryAssessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            entity: {
              entityId: 4,
              kind: "monster",
              username: null,
              uuid: null,
              mobType: "minecraft:enderman",
              endermanState: "angry",
            },
            position: { x: 2, y: 64, z: 0 },
          }),
        ],
      }),
    );
    expect(angryAssessment.hostileCount).toBe(1);
    expect(angryAssessment.threats[0]?.entityId).toBe(4);
  });

  it("escalates to critical for an armed hostile inside crystal range", () => {
    const assessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            position: { x: 2, y: 64, z: 0 },
            velocity: { x: -5, y: 0, z: 0 },
            wieldingWeapon: true,
            crystalNearby: true,
          }),
        ],
      }),
    );
    expect(assessment.level).toBe("critical");
    expect(assessment.threats[0]?.reasons).toEqual([
      "WITHIN_CRYSTAL_RANGE",
      "WITHIN_MELEE_RANGE",
      "CLOSING_FAST",
      "CRYSTAL_PLACED",
      "ARMED",
    ]);
    expect(assessment.threats[0]?.closingSpeed).toBeCloseTo(5, 6);
  });

  it("scores a distant unarmed hostile as low without inventing danger", () => {
    const assessment = analyzer().assess(
      snapshot({ entities: [observation()] }),
    );
    expect(assessment.level).toBe("low");
    expect(assessment.threats[0]).toMatchObject({
      score: 0,
      reasons: [],
      closingSpeed: null,
    });
    expect(assessment.threats[0]?.distance).toBeCloseTo(30, 6);
  });

  it("uses the 12-block crystal range without over-escalating its outer edge", () => {
    const outer = analyzer().assess(
      snapshot({
        entities: [observation({ position: { x: 11.5, y: 64, z: 0 } })],
      }),
    );
    expect(outer.level).toBe("low");
    expect(outer.threats[0]).toMatchObject({
      score: 15,
      reasons: ["WITHIN_CRYSTAL_RANGE"],
    });

    const placed = analyzer().assess(
      snapshot({
        entities: [
          observation({
            position: { x: 11.5, y: 64, z: 0 },
            crystalNearby: true,
          }),
        ],
      }),
    );
    expect(placed.level).toBe("elevated");
    expect(placed.threats[0]?.score).toBe(40);
  });

  it("keeps hostile anchors on their independent 10-block range", () => {
    const atEdge = analyzer().assess(
      snapshot({
        entities: [observation({
          position: { x: 10, y: 64, z: 0 },
          anchorNearby: true,
        })],
      }),
    );
    expect(atEdge.threats[0]).toMatchObject({
      score: 40,
      reasons: ["WITHIN_CRYSTAL_RANGE", "ANCHOR_PLACED"],
    });

    const outside = analyzer().assess(
      snapshot({
        entities: [observation({
          position: { x: 10.01, y: 64, z: 0 },
          anchorNearby: true,
        })],
      }),
    );
    expect(outside.threats[0]).toMatchObject({
      score: 15,
      reasons: ["WITHIN_CRYSTAL_RANGE"],
    });
  });

  it("treats an unobservable velocity as stationary, not as worst case", () => {
    const assessment = analyzer().assess(
      snapshot({
        entities: [observation({ position: { x: 2, y: 64, z: 0 } })],
      }),
    );
    expect(assessment.threats[0]?.reasons).not.toContain("CLOSING_FAST");
  });

  it("does not credit a retreating hostile with closing speed", () => {
    const assessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            position: { x: 2, y: 64, z: 0 },
            velocity: { x: 6, y: 0, z: 0 },
          }),
        ],
      }),
    );
    expect(assessment.threats[0]?.closingSpeed).toBeCloseTo(-6, 6);
    expect(assessment.threats[0]?.reasons).not.toContain("CLOSING_FAST");
  });

  it("orders threats deterministically by score, then distance, then id", () => {
    const assessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            entity: { entityId: 9, kind: "player", username: "A", uuid: null },
            position: { x: 40, y: 64, z: 0 },
          }),
          observation({
            entity: { entityId: 3, kind: "player", username: "B", uuid: null },
            position: { x: 40, y: 64, z: 0 },
          }),
          observation({
            entity: { entityId: 5, kind: "player", username: "C", uuid: null },
            position: { x: 4, y: 64, z: 0 },
          }),
        ],
      }),
    );
    expect(assessment.threats.map(({ entityId }) => entityId)).toEqual([5, 3, 9]);
    expect(assessment.hostileCount).toBe(3);
  });

  it("prioritizes a recently popped hostile without changing allegiance", () => {
    const assessment = analyzer().assess(
      snapshot({
        entities: [
          observation({
            entity: { entityId: 10, kind: "player", username: "Older", uuid: null },
            position: { x: 4, y: 64, z: 0 },
          }),
          observation({
            entity: { entityId: 11, kind: "player", username: "Popped", uuid: null },
            position: { x: 4, y: 64, z: 0 },
            recentlyPopped: true,
          }),
        ],
      }),
    );

    expect(assessment.threats.map(({ entityId }) => entityId)).toEqual([11, 10]);
    expect(assessment.threats[0]).toMatchObject({
      allegiance: "hostile",
      reasons: ["WITHIN_CRYSTAL_RANGE", "TARGET_RECENTLY_POPPED"],
    });
  });

  it("flags a depleted totem reserve as the §1 downgrade signal", () => {
    const assessment = analyzer().assess(snapshot({ totemCount: 0 }));
    expect(assessment.totemDepleted).toBe(true);
    expect(analyzer().assess(snapshot()).totemDepleted).toBe(false);
  });

  it("rejects a snapshot without a server profile or with broken numbers", () => {
    expect(() => analyzer().assess(snapshot({ serverProfileId: " " }))).toThrowError(
      TypeError,
    );
    expect(() =>
      analyzer().assess(snapshot({ totemCount: -1 })),
    ).toThrowError(TypeError);
    expect(() =>
      analyzer().assess(
        snapshot({
          entities: [observation({ position: { x: Number.NaN, y: 64, z: 0 } })],
        }),
      ),
    ).toThrowError(TypeError);
    expect(() => analyzer().assess(snapshot({
      entities: [observation({ anchorNearby: "unknown" as never })],
    }))).toThrowError(TypeError);
  });

  it("refuses to assess entities observed on a different server", () => {
    expect(() =>
      analyzer().assess(
        snapshot({ serverProfileId: "other", entities: [observation()] }),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "IDENTITY_SERVER_PROFILE_MISMATCH" }),
    );
  });
});

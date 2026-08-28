import { describe, expect, it } from "vitest";

import {
  AnchorEngine,
  DEFAULT_ANCHOR_POLICY,
  anchorChargeFromLightLevel,
  type CombatAnchorCandidate,
  type CombatAnchorSelfState,
} from "../src/anchor-engine.js";

const TARGET = { x: 1, y: 64, z: 0 };

function candidate(
  overrides: Partial<CombatAnchorCandidate> = {},
): CombatAnchorCandidate {
  return {
    position: { x: 0, y: 64, z: 0 },
    placeable: true,
    anchorPresent: false,
    chargeLevel: 0,
    targetOcclusion: 0,
    selfOcclusion: 0,
    ...overrides,
  };
}

function self(
  overrides: Partial<CombatAnchorSelfState> = {},
): CombatAnchorSelfState {
  return {
    position: { x: 10, y: 64, z: 0 },
    health: 20,
    totemMarginHealth: 20,
    glowstoneCount: 1,
    ...overrides,
  };
}

describe("AnchorEngine offense", () => {
  it("refuses Nether offense before all tactical candidate reasons", () => {
    expect(
      new AnchorEngine().plan(
        [],
        TARGET,
        self({ glowstoneCount: 0 }),
        "minecraft:the_nether",
      ),
    ).toMatchObject({
      chosen: null,
      refusal: "DIMENSION_IS_NETHER",
    });
  });

  it("distinguishes no candidates from candidates that cannot be placed", () => {
    const engine = new AnchorEngine();
    expect(
      engine.plan([], TARGET, self(), "minecraft:overworld").refusal,
    ).toBe("NO_CANDIDATES");
    expect(
      engine.plan(
        [candidate({ placeable: false })],
        TARGET,
        self(),
        "minecraft:overworld",
      ).refusal,
    ).toBe("ALL_UNPLACEABLE");
  });

  it("applies the shared self-damage red line before scoring", () => {
    const atSelf = candidate({ position: { x: 0, y: 64, z: 0 } });
    const plan = new AnchorEngine({
      ...DEFAULT_ANCHOR_POLICY,
      selfDamageCeiling: 100,
      minimumNetGain: 0.01,
    }).plan(
      [atSelf],
      TARGET,
      self({
        position: atSelf.position,
        health: 1,
        totemMarginHealth: 0,
      }),
      "minecraft:overworld",
    );
    expect(plan).toMatchObject({
      chosen: null,
      refusal: "SELF_DAMAGE_RED_LINE",
      redLineRejections: 1,
      survivalMarginUsed: 1,
    });
  });

  it("keeps the absolute ceiling distinct from the lethal red line", () => {
    const plan = new AnchorEngine().plan(
      [candidate()],
      TARGET,
      self({ position: { x: 8, y: 64, z: 0 } }),
      "minecraft:overworld",
    );
    expect(plan).toMatchObject({
      chosen: null,
      refusal: "SELF_DAMAGE_ABOVE_CEILING",
      redLineRejections: 0,
    });
  });

  it("requires glowstone only for an uncharged anchor", () => {
    const engine = new AnchorEngine();
    expect(
      engine.plan(
        [candidate()],
        TARGET,
        self({ glowstoneCount: 0 }),
        "minecraft:overworld",
      ).refusal,
    ).toBe("NO_GLOWSTONE_TO_ARM");

    const precharged = engine.plan(
      [candidate({ anchorPresent: true, chargeLevel: 4 })],
      TARGET,
      self({ glowstoneCount: 0 }),
      "minecraft:overworld",
    );
    expect(precharged).toMatchObject({
      refusal: null,
      chargeStepsRequired: 0,
      estimatedArmMs: 200,
    });
  });

  it("reports the cold placement chain separately from a pre-existing anchor", () => {
    const cold = new AnchorEngine().plan(
      [candidate()],
      TARGET,
      self(),
      "minecraft:the_end",
    );
    expect(cold).toMatchObject({
      chargeStepsRequired: 1,
      estimatedArmMs: 400,
    });
    expect(cold.chosen).toMatchObject({
      chargeStepsRequired: 1,
      estimatedArmMs: 400,
    });

    const existing = new AnchorEngine().plan(
      [candidate({ anchorPresent: true })],
      TARGET,
      self(),
      "minecraft:the_end",
    );
    expect(existing).toMatchObject({
      chargeStepsRequired: 1,
      estimatedArmMs: 200,
    });
  });

  it("uses verified mitigation but defaults missing mitigation to zero", () => {
    const engine = new AnchorEngine({
      ...DEFAULT_ANCHOR_POLICY,
      selfDamageCeiling: 100,
    });
    const spot = candidate({ position: { x: 0, y: 64, z: 0 } });
    const unverified = engine.plan(
      [spot],
      TARGET,
      self({ position: { x: 5, y: 64, z: 0 } }),
      "minecraft:overworld",
    );
    const verified = engine.plan(
      [spot],
      TARGET,
      self({
        position: { x: 5, y: 64, z: 0 },
        explosionMitigation01: 0.5,
      }),
      "minecraft:overworld",
    );
    expect(verified.chosen?.selfDamage).toBeCloseTo(
      (unverified.chosen?.selfDamage ?? 0) / 2,
      10,
    );
  });

  it("selects by net gain, then arming time, then position", () => {
    const engine = new AnchorEngine({
      ...DEFAULT_ANCHOR_POLICY,
      selfDamageCeiling: 100,
    });
    const cold = candidate({ position: { x: 1, y: 64, z: 0 } });
    const charged = candidate({
      position: { x: 1, y: 64, z: 0 },
      anchorPresent: true,
      chargeLevel: 1,
    });
    const plan = engine.plan(
      [cold, charged],
      TARGET,
      self({ position: { x: 10, y: 64, z: 0 } }),
      "minecraft:overworld",
    );
    expect(plan.chosen?.candidate).toBe(charged);
  });

  it("reports low net gain after all hard constraints pass", () => {
    expect(
      new AnchorEngine().plan(
        [candidate({ position: { x: 200, y: 64, z: 200 } })],
        TARGET,
        self(),
        "minecraft:overworld",
      ).refusal,
    ).toBe("NET_GAIN_TOO_LOW");
  });

  it("rejects malformed state and policy values", () => {
    expect(() =>
      new AnchorEngine().plan(
        [candidate({ anchorPresent: false, chargeLevel: 1 })],
        TARGET,
        self(),
        "minecraft:overworld",
      ),
    ).toThrowError(TypeError);
    expect(() =>
      new AnchorEngine().plan(
        [candidate()],
        TARGET,
        self({ glowstoneCount: -1 }),
        "minecraft:overworld",
      ),
    ).toThrowError(TypeError);
    expect(() =>
      new AnchorEngine({ ...DEFAULT_ANCHOR_POLICY, blastRadius: 9 }),
    ).toThrowError(TypeError);
  });
});

describe("AnchorEngine defense", () => {
  it("maps emitted light to charge without inventing a damage curve", () => {
    expect([0, 3, 7, 11, 15].map((light) =>
      anchorChargeFromLightLevel(light as 0 | 3 | 7 | 11 | 15)
    )).toEqual([0, 1, 2, 3, 4]);
    expect(() => anchorChargeFromLightLevel(4 as never)).toThrowError(
      TypeError,
    );

    const engine = new AnchorEngine();
    const damages = ([3, 7, 11, 15] as const).map((lightLevel) =>
      engine.assessHostileAnchor(
        {
          position: { x: 0, y: 64, z: 0 },
          lightLevel,
          selfOcclusion: 0,
        },
        { x: 0, y: 64, z: 0 },
        "minecraft:overworld",
      ).estimatedIncomingDamage
    );
    expect(new Set(damages).size).toBe(1);
    expect(damages[0]).toBe(71);
  });

  it("distinguishes a placed anchor from an armed one-click threat", () => {
    const engine = new AnchorEngine();
    const placed = engine.assessHostileAnchor(
      {
        position: { x: 0, y: 64, z: 0 },
        lightLevel: 0,
        selfOcclusion: 0,
      },
      { x: 1, y: 64, z: 0 },
      "minecraft:overworld",
    );
    expect(placed).toMatchObject({
      armed: false,
      chargeLevel: 0,
      armLevel: "PLACED",
      estimatedIncomingDamage: 0,
      entityRangeUsed: 10,
    });

    const armed = engine.assessHostileAnchor(
      {
        position: { x: 0, y: 64, z: 0 },
        lightLevel: 3,
        selfOcclusion: 0,
      },
      { x: 1, y: 64, z: 0 },
      "minecraft:overworld",
    );
    expect(armed).toMatchObject({
      armed: true,
      chargeLevel: 1,
      armLevel: "ARMED_ONE_CLICK",
    });
    expect(armed.estimatedIncomingDamage).toBeGreaterThan(0);
  });

  it("uses an independent 10-block entity range", () => {
    const engine = new AnchorEngine();
    const atEdge = engine.assessHostileAnchor(
      {
        position: { x: 0, y: 64, z: 0 },
        lightLevel: 15,
        selfOcclusion: 0,
      },
      { x: 10, y: 64, z: 0 },
      "minecraft:the_end",
    );
    const outside = engine.assessHostileAnchor(
      {
        position: { x: 0, y: 64, z: 0 },
        lightLevel: 15,
        selfOcclusion: 0,
      },
      { x: 10.01, y: 64, z: 0 },
      "minecraft:the_end",
    );
    expect(atEdge).toMatchObject({
      withinEntityRange: true,
      entityRangeUsed: 10,
    });
    expect(outside).toMatchObject({
      withinEntityRange: false,
      estimatedIncomingDamage: 0,
    });
  });

  it("never labels a Nether anchor as an explosive threat", () => {
    expect(
      new AnchorEngine().assessHostileAnchor(
        {
          position: { x: 0, y: 64, z: 0 },
          lightLevel: 15,
          selfOcclusion: 0,
        },
        { x: 0, y: 64, z: 0 },
        "minecraft:the_nether",
      ),
    ).toMatchObject({
      armed: false,
      armLevel: "ARMED_ONE_CLICK",
      estimatedIncomingDamage: 0,
    });
  });
});

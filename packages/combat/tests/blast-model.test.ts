import { describe, expect, it } from "vitest";

import {
  BLAST_POWER,
  blastDamage,
  entityRangeFor,
  redLineBreached,
} from "../src/blast-model.js";

const CENTER = { x: 0, y: 64, z: 0 };

function input(
  overrides: Partial<Parameters<typeof blastDamage>[0]> = {},
): Parameters<typeof blastDamage>[0] {
  return {
    power: BLAST_POWER.crystal,
    blastCenter: CENTER,
    victimPosition: CENTER,
    victimEyeHeight: 0,
    exposure01: 1,
    difficulty: "normal",
    mitigation01: 0,
    ...overrides,
  };
}

describe("blastDamage", () => {
  it("uses the crystal power and public impact curve at the center", () => {
    expect(blastDamage(input())).toMatchObject({
      rawDamage: 85,
      mitigatedDamage: 85,
      distance: 0,
      withinEntityRange: true,
    });
    expect(entityRangeFor(BLAST_POWER.crystal)).toBe(12);
    expect(entityRangeFor(BLAST_POWER.anchor)).toBe(10);
  });

  it("uses eye height in distance and returns zero beyond the entity range", () => {
    const withEyeHeight = blastDamage(
      input({ victimPosition: { x: 0, y: 63, z: 0 }, victimEyeHeight: 1 }),
    );
    expect(withEyeHeight.distance).toBe(0);
    expect(
      blastDamage(
        input({ victimPosition: { x: 12.1, y: 64, z: 0 } }),
      ),
    ).toMatchObject({ rawDamage: 0, mitigatedDamage: 0, withinEntityRange: false });
  });

  it("applies exposure, difficulty, and mitigation in that order", () => {
    expect(blastDamage(input({ exposure01: 0 })).rawDamage).toBe(0);
    expect(blastDamage(input({ difficulty: "easy" })).rawDamage).toBe(43.5);
    expect(blastDamage(input({ difficulty: "hard" })).rawDamage).toBe(127.5);
    expect(
      blastDamage(input({ mitigation01: 0.8 })).mitigatedDamage,
    ).toBeCloseTo(17, 10);
  });

  it("rejects malformed inputs and keeps the red line inclusive", () => {
    expect(() => blastDamage(input({ exposure01: 1.1 }))).toThrowError(TypeError);
    expect(() => blastDamage(input({ mitigation01: -0.1 }))).toThrowError(TypeError);
    expect(() => blastDamage(input({ power: 0 }))).toThrowError(TypeError);
    expect(redLineBreached(20, 20, 0)).toBe(true);
    expect(redLineBreached(19.99, 20, 0)).toBe(false);
    expect(redLineBreached(20, 1, 20)).toBe(false);
  });
});

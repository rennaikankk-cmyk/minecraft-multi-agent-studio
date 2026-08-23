import { describe, expect, it } from "vitest";
import type { Movements } from "mineflayer-pathfinder";

import { baselineLimits } from "@minecraft-studio/skills";
import { configurePathfinderMovements } from "../src/mineflayer-client.js";

function movements(): Movements {
  return {
    canDig: true,
    canOpenDoors: true,
    dontCreateFlow: false,
    dontMineUnderFallingBlock: false,
    allow1by1towers: true,
    allowFreeMotion: true,
    allowParkour: false,
    allowSprinting: false,
    scafoldingBlocks: [],
    maxDropDown: 8,
    infiniteLiquidDropdownDistance: true,
    exclusionAreasBreak: [],
    exclusionAreasPlace: [],
  } as unknown as Movements;
}

describe("runtime movement profile gate", () => {
  it("keeps SAFE configuration conservative", () => {
    const result = configurePathfinderMovements(movements(), "SAFE");
    expect(result).toMatchObject({ allowParkour: false, allowSprinting: false, maxDropDown: 2 });
  });

  it("requires an isolated policy-approved PARKOUR profile", () => {
    try { configurePathfinderMovements(movements(), "PARKOUR"); throw new Error("expected policy rejection"); } catch (error) { expect(error).toMatchObject({ code: "POLICY_PARKOUR_FORBIDDEN" }); }
    const result = configurePathfinderMovements(movements(), "PARKOUR", baselineLimits("NORMAL"), true);
    expect(result).toMatchObject({ allowParkour: true, allowSprinting: true, maxDropDown: 3 });
  });
});


import { describe, expect, it } from "vitest";

import { baselineLimits, resolveMovementProfile } from "../src/index.js";

describe("movement profiles", () => {
  it("defaults to a non-parkour safe profile", () => {
    const result = resolveMovementProfile("SAFE", baselineLimits("STRICT"), false);
    expect(result).toMatchObject({ allowed: true, config: { allowParkour: false, allowSprinting: false, maxFallBlocks: 2 } });
  });

  it("requires both isolated-test context and a policy-approved sprint jump", () => {
    expect(resolveMovementProfile("PARKOUR", baselineLimits("STRICT"), true)).toEqual({ allowed: false, errorCode: "POLICY_PARKOUR_FORBIDDEN" });
    const result = resolveMovementProfile("PARKOUR", baselineLimits("NORMAL"), true);
    expect(result).toMatchObject({ allowed: true, config: { allowParkour: true, allowSprintJumpCombo: true, verified: false, verificationNote: "未实测" } });
    expect(resolveMovementProfile("PARKOUR", baselineLimits("NORMAL"), false)).toEqual({ allowed: false, errorCode: "POLICY_PARKOUR_FORBIDDEN" });
  });
});


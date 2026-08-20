import { describe, expect, it } from "vitest";

import {
  builtinSkillVerificationManifestsV1,
  skillScenarioCategories,
  skillVerificationManifestV1Schema,
} from "../src/index.js";

describe("versioned Minecraft skill verification manifests", () => {
  it("strictly validates all eighteen built-in and optional skill matrices", () => {
    expect(builtinSkillVerificationManifestsV1).toHaveLength(18);
    for (const manifest of builtinSkillVerificationManifestsV1) {
      expect(skillVerificationManifestV1Schema.parse(manifest)).toEqual(manifest);
      expect(new Set(manifest.scenarios.map(({ category }) => category))).toEqual(
        new Set(skillScenarioCategories),
      );
    }
  });

  it("rejects a manifest that omits a mandatory failure category", () => {
    const manifest = builtinSkillVerificationManifestsV1[0]!;
    const incomplete = {
      ...manifest,
      scenarios: manifest.scenarios.filter(({ category }) => category !== "disconnect"),
    };
    expect(skillVerificationManifestV1Schema.safeParse(incomplete).success).toBe(false);
  });

  it("rejects unknown fields and duplicate scenario IDs", () => {
    const manifest = builtinSkillVerificationManifestsV1[0]!;
    expect(
      skillVerificationManifestV1Schema.safeParse({ ...manifest, untrustedCommand: "op StudioBot" }).success,
    ).toBe(false);
    expect(
      skillVerificationManifestV1Schema.safeParse({
        ...manifest,
        scenarios: manifest.scenarios.map((entry, index) =>
          index === 1 ? { ...entry, scenarioId: manifest.scenarios[0]!.scenarioId } : entry,
        ),
      }).success,
    ).toBe(false);
  });
});

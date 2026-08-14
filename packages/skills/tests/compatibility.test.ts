import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  SkillRegistry,
  defineSkill,
  type SkillCompatibilityEnvironment,
  type SkillResourceKind,
} from "../src/index.js";

function environment(input: {
  minecraftVersion: string;
  protocolVersion: number;
  features?: readonly string[];
  items?: readonly string[];
  blocks?: readonly string[];
  entities?: readonly string[];
  serverCapabilities?: Readonly<Record<string, boolean>>;
}): SkillCompatibilityEnvironment {
  const resources: Record<SkillResourceKind, ReadonlySet<string>> = {
    item: new Set(input.items ?? []),
    block: new Set(input.blocks ?? []),
    entity: new Set(input.entities ?? []),
  };
  const features = new Set(input.features ?? []);
  return {
    minecraftVersion: input.minecraftVersion,
    protocolVersion: input.protocolVersion,
    supportsFeature: (name) => features.has(name),
    hasResource: (kind, name) => resources[kind].has(name),
    serverCapability: (name) => input.serverCapabilities?.[name],
  };
}

function skill(input: {
  id: string;
  compatibility: Parameters<typeof defineSkill>[0]["compatibility"];
}) {
  return defineSkill({
    id: input.id,
    version: "1.0.0",
    inputSchema: z.object({}).strict(),
    outputSchema: z.object({ variantId: z.string() }).strict(),
    stateSchema: z.object({}).strict(),
    compatibility: input.compatibility,
    requiredCapabilities: [],
    timeoutMs: 100,
    idempotent: true,
    retryPolicy: {
      maxAttempts: 1,
      baseDelayMs: 10,
      maxDelayMs: 10,
      retryableErrorCodes: [],
    },
    preconditions: [],
    execute: async (context) => ({
      variantId: context.compatibility.variantId,
    }),
  });
}

describe("Skill multi-version compatibility", () => {
  it("keeps portable skills available instead of binding them to one version", () => {
    const registry = new SkillRegistry();
    registry.register(
      skill({
        id: "movement.portable",
        compatibility: {
          variants: [
            {
              id: "portable",
              requirements: [],
              verifiedMinecraftVersions: [],
            },
          ],
        },
      }),
    );

    for (const facts of [
      environment({ minecraftVersion: "1.8.8", protocolVersion: 47 }),
      environment({ minecraftVersion: "1.21.11", protocolVersion: 774 }),
    ]) {
      expect(
        registry.resolveCompatibility("movement.portable", "1.0.0", facts),
      ).toMatchObject({
        availability: "available",
        verification: "unverified",
        selectedVariantId: "portable",
      });
    }
  });

  it("selects legacy and modern resource variants from negotiated registry facts", () => {
    const registry = new SkillRegistry();
    registry.register(
      skill({
        id: "collect.logs",
        compatibility: {
          variants: [
            {
              id: "modern-oak-log",
              requirements: [
                {
                  kind: "resource",
                  resource: "block",
                  names: ["oak_log"],
                  match: "any",
                },
              ],
              verifiedMinecraftVersions: ["1.21.11"],
            },
            {
              id: "legacy-log",
              requirements: [
                {
                  kind: "resource",
                  resource: "block",
                  names: ["log"],
                  match: "any",
                },
              ],
              verifiedMinecraftVersions: ["1.12.2"],
            },
          ],
        },
      }),
    );

    expect(
      registry.resolveCompatibility(
        "collect.logs",
        "1.0.0",
        environment({
          minecraftVersion: "1.12.2",
          protocolVersion: 340,
          blocks: ["log"],
        }),
      ),
    ).toMatchObject({
      availability: "available",
      verification: "verified",
      selectedVariantId: "legacy-log",
    });
    expect(
      registry.resolveCompatibility(
        "collect.logs",
        "1.0.0",
        environment({
          minecraftVersion: "1.21.11",
          protocolVersion: 774,
          blocks: ["oak_log"],
        }),
      ),
    ).toMatchObject({
      availability: "available",
      verification: "verified",
      selectedVariantId: "modern-oak-log",
    });
  });

  it("keeps new-version features available only when facts and server probes agree", () => {
    const registry = new SkillRegistry();
    registry.register(
      skill({
        id: "combat.mace",
        compatibility: {
          variants: [
            {
              id: "mace-native",
              requirements: [
                {
                  kind: "resource",
                  resource: "item",
                  names: ["mace"],
                  match: "all",
                },
                { kind: "server-capability", name: "combat.mace-enabled" },
              ],
              verifiedMinecraftVersions: [],
            },
          ],
        },
      }),
    );

    const oldVersion = registry.resolveCompatibility(
      "combat.mace",
      "1.0.0",
      environment({ minecraftVersion: "1.16.5", protocolVersion: 754 }),
    );
    expect(oldVersion).toMatchObject({ availability: "unavailable" });
    expect(oldVersion?.variants[0]?.unmetRequirements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "missing",
          requirement: expect.objectContaining({ kind: "resource" }),
        }),
      ]),
    );

    const notProbed = registry.resolveCompatibility(
      "combat.mace",
      "1.0.0",
      environment({
        minecraftVersion: "1.21.11",
        protocolVersion: 774,
        items: ["mace"],
      }),
    );
    expect(notProbed).toMatchObject({ availability: "unavailable" });
    expect(notProbed?.variants[0]?.unmetRequirements).toContainEqual(
      expect.objectContaining({
        status: "unknown",
        requirement: expect.objectContaining({ kind: "server-capability" }),
      }),
    );

    expect(
      registry.resolveCompatibility(
        "combat.mace",
        "1.0.0",
        environment({
          minecraftVersion: "1.21.11",
          protocolVersion: 774,
          items: ["mace"],
          serverCapabilities: { "combat.mace-enabled": true },
        }),
      ),
    ).toMatchObject({
      availability: "available",
      selectedVariantId: "mace-native",
    });
  });
});

import { describe, expect, it } from "vitest";

import {
  combatEntityFromMineflayer,
  type MineflayerCombatRegistryView,
} from "../src/combat-entity-adapter.js";

const ENDERMAN_METADATA_KEYS = [
  "shared_flags",
  "health",
  "carry_state",
  "creepy",
  "stared_at",
] as const;

const registry: MineflayerCombatRegistryView = {
  entitiesByName: {
    enderman: { metadataKeys: ENDERMAN_METADATA_KEYS },
  },
};

describe("combatEntityFromMineflayer", () => {
  it("maps Mineflayer player, hostile, animal, and object types", () => {
    expect(
      combatEntityFromMineflayer(
        { id: 1, type: "player", name: "player", username: "Enemy", uuid: "u" },
        registry,
      ),
    ).toMatchObject({ kind: "player", username: "Enemy", uuid: "u" });
    expect(
      combatEntityFromMineflayer(
        { id: 2, type: "hostile", name: "zombie" },
        registry,
      ),
    ).toMatchObject({ kind: "monster", mobType: "zombie" });
    expect(
      combatEntityFromMineflayer(
        { id: 3, type: "animal", name: "cow" },
        registry,
      ),
    ).toMatchObject({ kind: "animal", mobType: "cow" });
    expect(
      combatEntityFromMineflayer(
        { id: 4, type: "projectile", name: "arrow" },
        registry,
      ),
    ).toMatchObject({ kind: "object", mobType: null });
    expect(
      combatEntityFromMineflayer(
        { id: 5, type: "passive", name: "villager" },
        registry,
      ),
    ).toMatchObject({ kind: "unknown", mobType: null });
  });

  it("reads Enderman aggression through version-selected metadata keys", () => {
    expect(
      combatEntityFromMineflayer(
        {
          id: 6,
          type: "hostile",
          name: "enderman",
          metadata: { 3: false, 4: false },
        },
        registry,
      ).endermanState,
    ).toBe("calm");
    expect(
      combatEntityFromMineflayer(
        {
          id: 7,
          type: "hostile",
          name: "enderman",
          metadata: { 3: true, 4: false },
        },
        registry,
      ).endermanState,
    ).toBe("angry");
    expect(
      combatEntityFromMineflayer(
        { id: 8, type: "hostile", name: "enderman", metadata: {} },
        registry,
      ).endermanState,
    ).toBe("unknown");
  });

  it("fails closed to unknown state when metadata names are unavailable", () => {
    expect(
      combatEntityFromMineflayer(
        {
          id: 9,
          type: "hostile",
          name: "enderman",
          metadata: { 3: true },
        },
        {},
      ).endermanState,
    ).toBe("unknown");
  });

  it("rejects an invalid Mineflayer entity ID", () => {
    expect(() =>
      combatEntityFromMineflayer(
        { id: Number.NaN, type: "hostile", name: "zombie" },
        registry,
      ),
    ).toThrowError(TypeError);
  });
});

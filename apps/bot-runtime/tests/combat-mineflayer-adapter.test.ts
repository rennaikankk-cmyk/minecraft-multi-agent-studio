import type { Bot } from "mineflayer";
import { describe, expect, it, vi } from "vitest";

import { MineflayerCombatAdapter } from "../src/combat-mineflayer-adapter.js";
import type { CombatPrimitiveAction } from "../src/combat-driver.js";

const SERVER = "local-isolated-test";

function fakeBot(overrides: Record<string, unknown> = {}): Bot {
  const self = {
    id: 1,
    type: "player",
    username: "StudioBot",
    uuid: "11111111-1111-4111-8111-111111111111",
    position: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    equipment: [
      { name: "iron_helmet", slot: 5 },
      { name: "iron_chestplate", slot: 6 },
      { name: "iron_leggings", slot: 7 },
      { name: "iron_boots", slot: 8 },
    ],
  };
  const enemy = {
    id: 42,
    type: "player",
    username: "Enemy",
    uuid: "22222222-2222-4222-8222-222222222222",
    position: { x: 2, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    health: 20,
    equipment: [
      { name: "diamond_helmet" },
      { name: "diamond_chestplate" },
      { name: "diamond_leggings" },
      { name: "diamond_boots" },
      { name: "diamond_sword" },
    ],
  };
  const controls = new Map<string, boolean>();
  const bot = {
    entity: self,
    health: 20,
    entities: { "1": self, "42": enemy },
    game: { dimension: "overworld" },
    player: { ping: 25 },
    registry: {},
    inventory: {
      items: () => [
        { name: "iron_sword", slot: 0, maxDurability: 250, durabilityUsed: 0 },
        { name: "totem_of_undying", slot: 45 },
      ],
      slots: [{ name: "iron_sword", slot: 0 }],
    },
    getEquipmentDestSlot: () => 45,
    clearControlStates: vi.fn(() => controls.clear()),
    setControlState: vi.fn((name: string, value: boolean) => controls.set(name, value)),
    pathfinder: { stop: vi.fn() },
    attack: vi.fn(async () => undefined),
    ...overrides,
  };
  return bot as unknown as Bot;
}

describe("MineflayerCombatAdapter", () => {
  it("normalizes dimensions and preserves complete enemy gear facts", () => {
    const adapter = new MineflayerCombatAdapter(fakeBot(), SERVER, true);
    const snapshot = adapter.observation(1_000);

    expect(snapshot?.dimension).toBe("minecraft:overworld");
    expect(snapshot?.entities).toHaveLength(1);
    expect(snapshot?.entities[0]?.entity.kind).toBe("player");
    expect(snapshot?.entities[0]?.gear).toMatchObject({
      armorMaterial: "diamond",
      weaponDamage: 6,
      health: 20,
    });
  });

  it("drops a malformed entity without invalidating the remaining snapshot", () => {
    const malformed = { id: 99, type: "player", position: { x: Number.NaN, y: 64, z: 0 } };
    const bot = fakeBot();
    const view = bot as unknown as { entity: unknown; entities: Record<string, unknown> };
    view.entities = { "1": view.entity, "99": malformed };
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    const snapshot = adapter.observation(1_000);
    expect(snapshot?.entities).toHaveLength(0);
  });

  it("keeps calm endermen neutral but exposes an angry enderman to identity rules", () => {
    const bot = fakeBot();
    const view = bot as unknown as {
      entities: Record<string, unknown>;
      registry: unknown;
    };
    const enderman = {
      id: 77,
      type: "mob",
      name: "minecraft:enderman",
      position: { x: 2, y: 64, z: 0 },
      health: 40,
      equipment: [],
      metadata: [],
    };
    view.entities = { "1": (bot as unknown as { entity: unknown }).entity, "77": enderman };
    view.registry = {
      entitiesByName: {
        "minecraft:enderman": { metadataKeys: ["creepy"] },
      },
    };

    const calm = new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000);
    expect(calm?.entities[0]?.entity.kind).toBe("monster");
    expect(calm?.entities[0]?.entity.endermanState).toBe("unknown");

    (enderman as { metadata: unknown[] }).metadata = [true];
    const angry = new MineflayerCombatAdapter(bot, SERVER, true).observation(1_001);
    expect(angry?.entities[0]?.entity.kind).toBe("monster");
    expect(angry?.entities[0]?.entity.endermanState).toBe("angry");
  });

  it.each(["breeze", "bogged", "piglin", "zombified_piglin", "creaking"])(
    "classifies the 1.21 hostile mob %s as a monster",
    (name) => {
      const bot = fakeBot();
      const view = bot as unknown as {
        entity: unknown;
        entities: Record<string, unknown>;
      };
      view.entities = {
        "1": view.entity,
        "100": {
          id: 100,
          type: "mob",
          name,
          position: { x: 2, y: 64, z: 0 },
          health: 20,
          equipment: [],
        },
      };

      const snapshot = new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000);
      expect(snapshot?.entities).toHaveLength(1);
      expect(snapshot?.entities[0]?.entity.kind).toBe("monster");
      expect(snapshot?.entities[0]?.entity.mobType).toBe(name);
    },
  );

  it("filters a self clone by entity id as well as object identity", () => {
    const bot = fakeBot();
    const view = bot as unknown as {
      entity: Record<string, unknown>;
      entities: Record<string, unknown>;
    };
    view.entities = {
      "1": view.entity,
      "2": { ...view.entity, id: 1 },
      "42": {
        id: 42,
        type: "player",
        username: "Enemy",
        uuid: "22222222-2222-4222-8222-222222222222",
        position: { x: 2, y: 64, z: 0 },
        health: 20,
        equipment: [],
      },
    };

    const snapshot = new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000);
    expect(snapshot?.entities.map(({ entity }) => entity.entityId)).toEqual([42]);
  });

  it.each([
    ["health", (bot: Bot) => {
      const view = bot as unknown as { health: unknown };
      view.health = undefined;
    }],
    ["yaw", (bot: Bot) => {
      const view = bot as unknown as { entity: Record<string, unknown> };
      view.entity.yaw = undefined;
    }],
    ["pitch", (bot: Bot) => {
      const view = bot as unknown as { entity: Record<string, unknown> };
      view.entity.pitch = undefined;
    }],
    ["onGround", (bot: Bot) => {
      const view = bot as unknown as { entity: Record<string, unknown> };
      view.entity.onGround = undefined;
    }],
    ["inventory", (bot: Bot) => {
      const view = bot as unknown as { inventory: unknown };
      view.inventory = undefined;
    }],
    ["inventory.items", (bot: Bot) => {
      const view = bot as unknown as { inventory: Record<string, unknown> };
      view.inventory.items = undefined;
    }],
  ] as const)("returns no combat snapshot when %s is unavailable", (_field, removeField) => {
    const bot = fakeBot();
    removeField(bot);
    expect(new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000)).toBeNull();
  });

  it("uses the injected clock for acknowledged primitive actions", async () => {
    const bot = fakeBot();
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    adapter.setClock(() => 1_234);
    const action: CombatPrimitiveAction = {
      kind: "MELEE_ATTACK",
      targetEntityId: 42,
      weaponSlot: 0,
    };
    await expect(adapter.execute(action, new AbortController().signal)).resolves.toEqual({
      outcome: "executed",
      executedAtMs: 1_234,
    });
  });
});

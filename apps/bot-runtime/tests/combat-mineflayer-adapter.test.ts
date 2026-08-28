import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
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
      { name: "iron_helmet", slot: 5, enchants: [] },
      { name: "iron_chestplate", slot: 6, enchants: [] },
      { name: "iron_leggings", slot: 7, enchants: [] },
      { name: "iron_boots", slot: 8, enchants: [] },
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
      { name: "diamond_helmet", enchants: [] },
      { name: "diamond_chestplate", enchants: [] },
      { name: "diamond_leggings", enchants: [] },
      { name: "diamond_boots", enchants: [] },
      { name: "diamond_sword" },
    ],
  };
  const controls = new Map<string, boolean>();
  const bot = {
    entity: self,
    health: 20,
    version: "1.21.8",
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
    expect(snapshot?.entities[0]).toMatchObject({
      crystalNearby: false,
      anchorNearby: false,
    });
    expect(snapshot?.entities[0]?.gear).toMatchObject({
      armorMaterial: "diamond",
      weaponDamage: 6,
      health: 20,
    });
  });

  it("exposes the held non-weapon tool as a last-resort melee candidate", () => {
    const pickaxe = {
      name: "wooden_pickaxe",
      slot: 0,
      maxDurability: 59,
      durabilityUsed: 0,
    };
    const bot = fakeBot({
      inventory: {
        items: () => [pickaxe],
        slots: [pickaxe],
      },
      getEquipmentDestSlot: (destination: string) =>
        destination === "hand" ? 0 : 45,
    });

    expect(
      new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000)
        ?.weapons,
    ).toContainEqual(
      expect.objectContaining({
        slot: 0,
        itemName: "wooden_pickaxe",
        kind: "other",
        baseDamage: 1,
      }),
    );
  });

  it("reports ranged-use state and executes bow draw and release primitives", async () => {
    const bow = {
      name: "bow",
      slot: 1,
      count: 1,
      maxDurability: 384,
      durabilityUsed: 0,
    };
    const activateItem = vi.fn();
    const deactivateItem = vi.fn();
    const bot = fakeBot({
      usingHeldItem: true,
      inventory: {
        items: () => [bow, { name: "arrow", slot: 2, count: 12 }],
        slots: [null, bow, { name: "arrow", slot: 2, count: 12 }],
      },
      getEquipmentDestSlot: (destination: string) =>
        destination === "hand" ? 1 : 45,
      activateItem,
      deactivateItem,
    });
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    adapter.setClock(() => 1_234);

    expect(adapter.observation(1_000)).toMatchObject({
      self: { heldItemSlot: 1, usingHeldItem: true },
      weapons: [expect.objectContaining({
        kind: "bow",
        ammoRemaining: 12,
      })],
    });
    await expect(
      adapter.execute(
        { kind: "DRAW_RANGED_WEAPON", weaponSlot: 1 },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: "executed", executedAtMs: 1_234 });
    await expect(
      adapter.execute(
        {
          kind: "RELEASE_RANGED_WEAPON",
          targetEntityId: 42,
          weaponSlot: 1,
        },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ outcome: "executed", executedAtMs: 1_234 });
    expect(activateItem).toHaveBeenCalledWith(false);
    expect(deactivateItem).toHaveBeenCalledTimes(1);
  });

  it("reports an empty hazard set when the loaded-area scan is clear", () => {
    const blockAt = vi.fn(() => ({ name: "stone" }));
    const bot = fakeBot({ blockAt });
    const snapshot = new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000);
    expect(snapshot?.hazards).toEqual([]);
    // blockAt 现在先被水晶候选枚举调用（combat 包的结构化向量），后才是
    // 危险扫描（Vec3）。断言弱化为"至少有一次调用且参数有 xyz"。
    expect(blockAt.mock.calls.length).toBeGreaterThan(0);
    expect(blockAt.mock.calls.some(([arg]) => arg && typeof arg.x === "number")).toBe(true);
  });

  it("reports lava and fire positions from the local hazard scan", () => {
    const bot = fakeBot({
      blockAt: (position: { x: number; y: number; z: number }) =>
        position.x === 1 && position.y === 64 && position.z === 0
          ? { name: "minecraft:lava" }
          : position.x === -1 && position.y === 64 && position.z === 0
            ? { name: "fire" }
            : { name: "stone" },
    });
    const snapshot = new MineflayerCombatAdapter(bot, SERVER, true).observation(1_000);
    expect(snapshot?.hazards).toEqual(expect.arrayContaining([
      { x: 1, y: 64, z: 0 },
      { x: -1, y: 64, z: 0 },
    ]));
  });

  it("keeps hazards unknown when block geometry is unavailable", () => {
    const snapshot = new MineflayerCombatAdapter(fakeBot(), SERVER, true).observation(1_000);
    expect(snapshot?.hazards).toBeNull();
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

  it("uses the server totem POP event to prioritize a target only during punish", () => {
    const wire = new EventEmitter();
    const bot = fakeBot({ _client: wire });
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    let nowMs = 10_000;
    adapter.setClock(() => nowMs);

    wire.emit("entity_status", { entityId: 42, entityStatus: 35 });
    const punish = adapter.observation(nowMs);
    expect(punish?.entities[0]?.recentlyPopped).toBe(true);

    nowMs += 5_000;
    const regen = adapter.observation(nowMs);
    expect(regen?.entities[0]).not.toHaveProperty("recentlyPopped");

    wire.emit("entity_status", { entityId: 42, entityStatus: 34 });
    nowMs += 1;
    const ignoredStatus = adapter.observation(nowMs);
    expect(ignoredStatus?.entities[0]).not.toHaveProperty("recentlyPopped");
  });

  it("forwards its own POP before equipment sync and does not let a foreign POP stop drawing", () => {
    const wire = new EventEmitter();
    const bot = fakeBot({ _client: wire, usingHeldItem: true });
    const mutableBot = bot as unknown as { usingHeldItem: boolean };
    // Simulate Mineflayer's inventory listener. The adapter must preserve this
    // library behavior for self events while repairing it for foreign events.
    wire.on("entity_status", () => {
      mutableBot.usingHeldItem = false;
    });
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    let nowMs = 30_000;
    adapter.setClock(() => nowMs);

    wire.emit("entity_status", { entityId: 1, entityStatus: 35 });
    expect(adapter.observation(nowMs)?.self.totemPopObservedAtMs).toBe(nowMs);
    expect(mutableBot.usingHeldItem).toBe(false);

    mutableBot.usingHeldItem = true;
    nowMs += 1;
    wire.emit("entity_status", { entityId: 42, entityStatus: 35 });
    expect(mutableBot.usingHeldItem).toBe(true);
  });

  it("does not reuse a POP record after a dimension change or adapter reset", () => {
    const wire = new EventEmitter();
    const bot = fakeBot({ _client: wire });
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    let nowMs = 20_000;
    adapter.setClock(() => nowMs);

    wire.emit("entity_status", { entityId: 42, entityStatus: 35 });
    expect(adapter.observation(nowMs)?.entities[0]?.recentlyPopped).toBe(true);

    const view = bot as unknown as { game: { dimension: string } };
    view.game.dimension = "the_nether";
    nowMs += 1;
    expect(adapter.observation(nowMs)?.entities[0]).not.toHaveProperty("recentlyPopped");

    adapter.reset();
    view.game.dimension = "overworld";
    nowMs += 1;
    expect(adapter.observation(nowMs)?.entities[0]).not.toHaveProperty("recentlyPopped");
  });

  it("tracks target hurt and swing windows from server wire events", () => {
    const wire = new EventEmitter();
    const bot = fakeBot({ _client: wire });
    const adapter = new MineflayerCombatAdapter(bot, SERVER, true);
    let nowMs = 40_000;
    adapter.setClock(() => nowMs);

    wire.emit("entity_status", { entityId: 42, entityStatus: 2 });
    expect(adapter.observation(nowMs)?.entities[0]).toMatchObject({
      invulnerableRemainingMs: 500,
      targetCooldownRatio01: 1,
    });
    nowMs += 250;
    expect(adapter.observation(nowMs)?.entities[0]?.invulnerableRemainingMs).toBe(250);

    wire.emit("animation", { entityId: 42, animation: 0 });
    expect(adapter.observation(nowMs)?.entities[0]?.targetCooldownRatio01).toBe(0);
    nowMs += 625;
    expect(adapter.observation(nowMs)?.entities[0]).toMatchObject({
      invulnerableRemainingMs: 0,
      targetCooldownRatio01: 1,
    });

    wire.emit("damage_event", { entityId: 42 });
    expect(adapter.observation(nowMs)?.entities[0]?.invulnerableRemainingMs).toBe(500);
  });

  it("normalizes explosion packets through the negotiated schema", () => {
    const wire = new EventEmitter();
    const adapter = new MineflayerCombatAdapter(
      fakeBot({ _client: wire, version: "1.21.8" }),
      SERVER,
      true,
    );
    adapter.setClock(() => 50_000);
    wire.emit("explosion", {
      x: 1,
      y: 65,
      z: 2,
      playerKnockback: { x: 0.1, y: 0.2, z: -0.1 },
    });
    expect(adapter.drainExplosionObservations()).toEqual([{
      center: { x: 1, y: 65, z: 2 },
      knockback: { x: 0.1, y: 0.2, z: -0.1 },
      radiusIfPresent: null,
      blockCountIfPresent: null,
      observedAtMs: 50_000,
      serverProfileId: SERVER,
      dimension: "minecraft:overworld",
    }]);
    expect(adapter.drainExplosionObservations()).toEqual([]);
  });

  it("rejects an unsupported explosion schema before combat starts", () => {
    expect(() => new MineflayerCombatAdapter(
      fakeBot({ version: "1.19.4" }),
      SERVER,
      true,
    )).toThrowError(expect.objectContaining({
      code: "EXPLOSION_PACKET_SCHEMA_UNSUPPORTED",
    }));
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

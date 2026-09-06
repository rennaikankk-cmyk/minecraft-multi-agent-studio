import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import {
  ActionLockError,
  ActionLockManager,
  type SkillCapabilityRequest,
} from "@minecraft-studio/skills";
import { Vec3 } from "vec3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MineflayerBotClient } from "./fixtures/in-memory-client.js";
import { InMemoryWorkstationRegistry } from "@minecraft-studio/skills";

const SERVER_PROFILE_ID = "isolated-local";
const DIMENSION = "minecraft:overworld";

type InventoryItem = { name: string; count: number };

function makeFixture() {
  const emitter = new EventEmitter();
  const items: InventoryItem[] = [
    { name: "bread", count: 1 },
    { name: "coal", count: 1 },
    { name: "cobblestone", count: 1 },
    { name: "dirt", count: 1 },
    { name: "iron_helmet", count: 1 },
    { name: "oak_log", count: 1 },
    { name: "raw_iron", count: 1 },
  ];
  const slots: Array<InventoryItem | null> = Array.from(
    { length: 46 },
    () => null,
  );
  const inventory = Object.assign(new EventEmitter(), {
    inventoryStart: 0,
    inventoryEnd: 36,
    slots,
    items: () => items,
  });
  const findItem = (name: string) =>
    items.find((candidate) => candidate.name === name);
  const addItem = (name: string, count: number) => {
    const existing = findItem(name);
    if (existing) existing.count += count;
    else items.push({ name, count });
  };
  const removeItem = (name: string, count: number) => {
    const existing = findItem(name);
    if (existing) existing.count = Math.max(0, existing.count - count);
  };

  const recipe = { result: { count: 4 }, requiresTable: false };
  const craft = vi.fn(async () => {
    addItem("oak_planks", 4);
  });
  let equippedHand: InventoryItem | null = null;
  const equip = vi.fn(async (item: InventoryItem, destination: string) => {
    if (destination === "head") slots[40] = item;
    if (destination === "hand") equippedHand = item;
  });
  let placedBlockName: string | null = null;
  const blockAt = vi.fn((position: Vec3) => {
    if (position.x === 2 && position.y === 64 && position.z === 0) {
      return { name: "furnace", position: position.clone(), boundingBox: "block" };
    }
    if (position.x === 3 && position.y === 64 && position.z === 0) {
      return { name: "chest", position: position.clone(), boundingBox: "block", getProperties: () => ({ type: "single" }) };
    }
    if (position.x === 0 && position.y === 63 && position.z === 0) {
      return { name: "stone", position: position.clone(), boundingBox: "block" };
    }
    if (position.x === 0 && position.y === 64 && position.z === 0) {
      return {
        name: placedBlockName ?? "air",
        position: position.clone(),
        boundingBox: placedBlockName ? "block" : "empty",
      };
    }
    return { name: "air", position: position.clone(), boundingBox: "empty" };
  });
  const placeBlock = vi.fn(async () => {
    placedBlockName = equippedHand?.name ?? null;
  });

  let furnaceReady = false;
  let furnaceOutputTaken = false;
  const furnace = Object.assign(new EventEmitter(), {
    inputItem: vi.fn(() => null),
    fuelItem: vi.fn(() => null),
    outputItem: vi.fn(() =>
      furnaceReady && !furnaceOutputTaken
        ? { name: "iron_ingot", count: 1 }
        : null,
    ),
    putInput: vi.fn(async () => undefined),
    putFuel: vi.fn(async () => {
      furnaceReady = true;
    }),
    takeOutput: vi.fn(async () => {
      furnaceOutputTaken = true;
      addItem("iron_ingot", 1);
      return { name: "iron_ingot", count: 1 };
    }),
    close: vi.fn(),
  });
  let storedCobblestone = 0;
  const container = {
    items: () => items,
    containerItems: () => [{ name: "cobblestone", count: storedCobblestone }],
    deposit: vi.fn(async (_itemType: number, _metadata: null, count: number) => {
      removeItem("cobblestone", count);
      storedCobblestone += count;
    }),
    withdraw: vi.fn(async () => undefined),
    close: vi.fn(() => { bot.currentWindow = null; }),
  };

  const bot = emitter as unknown as Bot;
  Object.assign(bot, {
    health: 20,
    food: 12,
    foodSaturation: 2,
    oxygenLevel: 20,
    player: { ping: 0 },
    entity: {
      position: new Vec3(0, 64, 1),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
    },
    game: { dimension: "overworld" },
    inventory,
    registry: {
      itemsByName: {
        coal: { id: 1 },
        cobblestone: { id: 2 },
        dirt: { id: 3 },
        oak_planks: { id: 4 },
        raw_iron: { id: 5 },
      },
      foodsByName: { bread: { foodPoints: 5, effectiveQuality: 6 } },
    },
    entities: {},
    blockAt,
    recipesAll: vi.fn(() => [recipe]),
    recipesFor: vi.fn(() => [recipe]),
    craft,
    equip,
    placeBlock,
    openFurnace: vi.fn(async () => furnace),
    openContainer: vi.fn(async () => {
      bot.currentWindow = container as unknown as NonNullable<Bot["currentWindow"]>;
      return container;
    }),
    consume: vi.fn(async () => undefined),
    getEquipmentDestSlot: vi.fn(() => 40),
    clearControlStates: vi.fn(),
    getControlState: vi.fn(() => false),
  });

  return {
    bot,
    client: new MineflayerBotClient(bot, "auto", SERVER_PROFILE_ID, false, undefined, "safe", null, undefined, new InMemoryWorkstationRegistry()),
    craft,
  };
}

function capabilityRequest(
  capability: SkillCapabilityRequest["capability"],
  operation: string,
  skillId: string,
  input: unknown,
  signal = new AbortController().signal,
): SkillCapabilityRequest {
  return {
    invocationId: crypto.randomUUID(),
    traceId: crypto.randomUUID(),
    taskId: "task-action-lock-001",
    botId: "worker-01",
    skillId,
    skillVersion: "1.0.0",
    capability,
    operation,
    input,
    signal,
  };
}

function armorRequest(signal?: AbortSignal): SkillCapabilityRequest {
  return capabilityRequest(
    "inventory.write",
    "armor.equip",
    "inventory.equip-armor",
    {
      serverProfileId: SERVER_PROFILE_ID,
      slot: "head",
      itemName: "iron_helmet",
    },
    signal,
  );
}

function craftRequest(signal?: AbortSignal): SkillCapabilityRequest {
  return capabilityRequest(
    "craft.execute",
    "craft.item-safe",
    "craft.item",
    {
      itemName: "oak_planks",
      count: 4,
      craftingTable: null,
      dimension: DIMENSION,
      serverProfileId: SERVER_PROFILE_ID,
    },
    signal,
  );
}

function smeltRequest(): SkillCapabilityRequest {
  return capabilityRequest(
    "craft.execute",
    "smelt.item-safe",
    "smelt.item",
    {
      inputItemName: "raw_iron",
      fuelItemName: "coal",
      fuelCount: 1,
      count: 1,
      furnace: { x: 2, y: 64, z: 0 },
      dimension: DIMENSION,
      serverProfileId: SERVER_PROFILE_ID,
    },
  );
}

function containerRequest(): SkillCapabilityRequest {
  return capabilityRequest(
    "container.write",
    "container.transfer-safe",
    "container.transfer",
    {
      direction: "deposit",
      itemName: "cobblestone",
      count: 1,
      container: { x: 3, y: 64, z: 0 },
      dimension: DIMENSION,
      serverProfileId: SERVER_PROFILE_ID,
    },
  );
}

function placeRequest(): SkillCapabilityRequest {
  return capabilityRequest(
    "world.interact",
    "block.place-safe",
    "world.place-block",
    {
      itemName: "dirt",
      referenceBlock: { x: 0, y: 63, z: 0 },
      face: { x: 0, y: 1, z: 0 },
      dimension: DIMENSION,
      serverProfileId: SERVER_PROFILE_ID,
    },
  );
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("MineflayerBotClient action locks", () => {
  it("acquires the declared resources for every mutable Mineflayer primitive", async () => {
    const fixture = makeFixture();
    const acquire = vi.spyOn(ActionLockManager.prototype, "tryAcquire");

    await fixture.client.invokeSkillCapability(armorRequest());
    expect(acquire.mock.calls.map(([kind]) => kind)).toEqual(["inventory"]);
    acquire.mockClear();

    await fixture.client.invokeSkillCapability(craftRequest());
    expect(acquire.mock.calls.map(([kind]) => kind)).toEqual([
      "blockInteraction",
      "crafting",
      "inventory",
    ]);
    acquire.mockClear();

    await fixture.client.invokeSkillCapability(smeltRequest());
    expect(acquire.mock.calls.map(([kind]) => kind)).toEqual([
      "blockInteraction",
      "crafting",
      "container",
      "inventory",
    ]);
    acquire.mockClear();

    await fixture.client.invokeSkillCapability(containerRequest());
    expect(acquire.mock.calls.map(([kind]) => kind)).toEqual([
      "container",
      "inventory",
    ]);
    acquire.mockClear();

    await fixture.client.invokeSkillCapability(placeRequest());
    expect(acquire.mock.calls.map(([kind]) => kind)).toEqual([
      "blockInteraction",
      "inventory",
    ]);
    acquire.mockClear();

    await fixture.client.executeSafetyAction({
      kind: "CONSUME_SAFE_FOOD",
      risk: "HUNGER",
    });
    expect(acquire.mock.calls.map(([kind]) => kind)).toEqual(["inventory"]);
  });

  it("maps contention to ACTION_LOCK_BUSY and releases after completion", async () => {
    const fixture = makeFixture();
    const pendingCraft = deferred();
    fixture.craft.mockImplementationOnce(() => pendingCraft.promise);
    const first = fixture.client.invokeSkillCapability(craftRequest());
    await vi.waitFor(() => expect(fixture.craft).toHaveBeenCalledTimes(1));

    await expect(
      fixture.client.invokeSkillCapability(armorRequest()),
    ).rejects.toMatchObject({ code: "ACTION_LOCK_BUSY" });

    pendingCraft.resolve();
    await first;
    await expect(
      fixture.client.invokeSkillCapability(armorRequest()),
    ).resolves.toMatchObject({ equipped: true });
  });

  it("releases every lock when a Mineflayer primitive throws", async () => {
    const fixture = makeFixture();
    fixture.craft.mockRejectedValueOnce(new Error("simulated craft failure"));

    await expect(
      fixture.client.invokeSkillCapability(craftRequest()),
    ).rejects.toMatchObject({ code: "CRAFT_FAILED" });
    await expect(
      fixture.client.invokeSkillCapability(armorRequest()),
    ).resolves.toMatchObject({ equipped: true });
  });

  it("maps cancellation and releases locks after an in-flight call settles", async () => {
    const fixture = makeFixture();
    const controller = new AbortController();
    const pendingCraft = deferred();
    fixture.craft.mockImplementationOnce(() => pendingCraft.promise);
    const first = fixture.client.invokeSkillCapability(
      craftRequest(controller.signal),
    );
    await vi.waitFor(() => expect(fixture.craft).toHaveBeenCalledTimes(1));

    controller.abort();
    await expect(
      fixture.client.invokeSkillCapability(armorRequest()),
    ).rejects.toMatchObject({ code: "ACTION_LOCK_BUSY" });
    pendingCraft.resolve();
    await expect(first).rejects.toMatchObject({ code: "SKILL_CANCELLED" });
    await expect(
      fixture.client.invokeSkillCapability(armorRequest()),
    ).resolves.toMatchObject({ equipped: true });
  });

  it("normalizes non-contention ActionLockError values", async () => {
    const fixture = makeFixture();
    vi.spyOn(ActionLockManager.prototype, "tryAcquire").mockImplementationOnce(
      () => {
        throw new ActionLockError("LOCK_EXPIRED", "simulated expired lock");
      },
    );

    await expect(
      fixture.client.invokeSkillCapability(armorRequest()),
    ).rejects.toMatchObject({ code: "ACTION_LOCK_FAILED" });
  });
});

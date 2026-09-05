import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import { InMemoryWorkstationRegistry, type SkillCapabilityRequest } from "@minecraft-studio/skills";
import { Vec3 } from "vec3";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("mineflayer-pathfinder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("mineflayer-pathfinder")>();
  class TestMovements {
    canDig = true;
    canOpenDoors = true;
    dontCreateFlow = false;
    dontMineUnderFallingBlock = false;
    allow1by1towers = true;
    allowFreeMotion = true;
    allowParkour = true;
    allowSprinting = true;
    scafoldingBlocks = [1, 2];
    maxDropDown = 4;
    infiniteLiquidDropdownDistance = true;
    exclusionAreasBreak: ((block: unknown) => number)[] = [];
    exclusionAreasPlace: ((block: unknown) => number)[] = [];
  }
  return { ...actual, Movements: TestMovements };
});

import type { BotClientHandlers } from "../src/client.js";
import { MineflayerBotClient } from "./fixtures/in-memory-client.js";
import { importantBlockNames } from "../src/world-state.js";

const SERVER_PROFILE_ID = "isolated-local";
const NOW = new Date("2026-08-28T10:00:00.000Z");

type FixtureOptions = Readonly<{
  furnacePositions?: readonly Vec3[];
  craftingTablePositions?: readonly Vec3[];
  furnaceInInventory?: boolean;
  inventoryItems?: readonly Readonly<{ name: string; count: number }>[];
  placementFails?: boolean;
  pathfinderFails?: boolean;
  registeredBlockNames?: readonly string[];
  workstationRegistry?: InMemoryWorkstationRegistry;
}>;

function key(position: Vec3): string {
  return `${position.x}|${position.y}|${position.z}`;
}

function makeBlock(name: string, position: Vec3, boundingBox = "block") {
  return { name, position: position.clone(), boundingBox };
}

function makeFixture(options: FixtureOptions = {}) {
  const emitter = new EventEmitter();
  const initialFurnaces = new Map(
    (options.furnacePositions ?? []).map((position) => [
      key(position),
      position.clone(),
    ]),
  );
  const initialCraftingTables = new Map(
    (options.craftingTablePositions ?? []).map((position) => [
      key(position),
      position.clone(),
    ]),
  );
  const placedFurnaces = new Map<string, Vec3>();
  const inventoryItems = [
    ...(options.inventoryItems ?? [
      { name: "raw_iron", count: 1 },
      { name: "coal", count: 1 },
    ]),
    ...(options.furnaceInInventory
      ? [{ name: "furnace", count: 1 }]
      : []),
  ].map((item) => ({ ...item }));
  const inventory = Object.assign(new EventEmitter(), {
    inventoryStart: 0,
    inventoryEnd: 36,
    slots: Array.from({ length: 36 }, () => null),
    items: () => inventoryItems,
  });
  const registeredBlockNames = options.registeredBlockNames ?? [
    "furnace",
    "crafting_table",
  ];
  const blocksByName = Object.fromEntries(
    registeredBlockNames.map((name, index) => [name, { id: 61 + index }]),
  );
  const findBlocks = vi.fn((request: { matching: number | readonly number[] }) => {
    const matching = new Set(
      Array.isArray(request.matching) ? request.matching : [request.matching],
    );
    const positions: Vec3[] = [];
    if (matching.has(blocksByName.furnace?.id ?? -1)) {
      positions.push(...initialFurnaces.values(), ...placedFurnaces.values());
    }
    if (matching.has(blocksByName.crafting_table?.id ?? -1)) {
      positions.push(...initialCraftingTables.values());
    }
    return positions;
  });
  const blockAt = vi.fn((position: Vec3) => {
    if (initialFurnaces.has(key(position)) || placedFurnaces.has(key(position))) {
      return makeBlock("furnace", position);
    }
    if (initialCraftingTables.has(key(position))) {
      return makeBlock("crafting_table", position);
    }
    if (position.y === 63) return makeBlock("stone", position);
    return makeBlock("air", position, "empty");
  });
  const equip = vi.fn(async () => undefined);
  const placeBlock = vi.fn(async (reference: { position: Vec3 }, face: Vec3) => {
    if (options.placementFails) throw new Error("simulated placement failure");
    const target = reference.position.plus(face);
    placedFurnaces.set(key(target), target);
  });
  const furnaceWindow = Object.assign(new EventEmitter(), {
    ready: false,
    taken: false,
    inputItem: vi.fn(() => null),
    fuelItem: vi.fn(() => null),
    outputItem: vi.fn(function (this: { ready: boolean; taken: boolean }) {
      return this.ready && !this.taken
        ? { name: "iron_ingot", count: 1 }
        : null;
    }),
    putInput: vi.fn(async () => undefined),
    putFuel: vi.fn(async function (this: { ready: boolean }) {
      this.ready = true;
    }),
    takeOutput: vi.fn(async function (this: { taken: boolean }) {
      this.taken = true;
      return { name: "iron_ingot", count: 1 };
    }),
    close: vi.fn(),
  });
  const openFurnace = vi.fn(async () => furnaceWindow);
  const recipesAll = vi.fn(
    (itemId: number, _metadata: unknown, requiresTable: boolean) =>
      itemId === 4 && requiresTable
        ? [{ requiresTable: true, result: { name: "wooden_pickaxe", count: 1 } }]
        : [],
  );
  const recipesFor = vi.fn(
    (itemId: number, _metadata: unknown, _count: number, table: unknown) =>
      itemId === 4 && table
        ? [{ requiresTable: true, result: { name: "wooden_pickaxe", count: 1 } }]
        : [],
  );
  const craft = vi.fn(async (recipe: { result: { name: string; count: number } }) => {
    const current = inventoryItems.find(({ name }) => name === recipe.result.name);
    if (current) current.count += recipe.result.count;
    else inventoryItems.push({ ...recipe.result });
  });
  const bot = emitter as unknown as Bot;
  const pathfinderGoto = vi.fn(async () => {
    if (options.pathfinderFails) {
      bot.entity.position = new Vec3(100, 64, 0);
      throw new Error("simulated path failure");
    }
    const target =
      options.furnacePositions?.[0] ?? options.craftingTablePositions?.[0];
    if (target) {
      bot.entity.position = target.offset(-2, 0, 0);
    }
  });
  Object.assign(bot, {
    health: 20,
    food: 20,
    foodSaturation: 5,
    oxygenLevel: 20,
    player: { ping: 0 },
    entity: {
      position: new Vec3(0, 64, 0),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
    },
    game: { dimension: "overworld" },
    inventory,
    registry: {
      itemsByName: {
        raw_iron: { id: 1 },
        coal: { id: 2 },
        furnace: { id: 3 },
        wooden_pickaxe: { id: 4 },
        oak_planks: { id: 5 },
        stick: { id: 6 },
        crafting_table: { id: 7 },
      },
      blocksByName,
    },
    entities: {},
    findBlocks,
    blockAt,
    equip,
    placeBlock,
    openFurnace,
    recipesAll,
    recipesFor,
    craft,
    pathfinder: {
      goto: pathfinderGoto,
      setMovements: vi.fn(),
      stop: vi.fn(),
      thinkTimeout: 0,
      tickTimeout: 0,
    },
    clearControlStates: vi.fn(),
    getControlState: vi.fn(() => false),
  });
  const client = new MineflayerBotClient(bot, "auto", SERVER_PROFILE_ID, false, undefined, "safe", null, undefined,
    options.workstationRegistry ?? new InMemoryWorkstationRegistry());
  return {
    bot,
    client,
    emitter,
    findBlocks,
    equip,
    placeBlock,
    openFurnace,
    furnaceWindow,
    pathfinderGoto,
    placedFurnaces,
    inventoryItems,
  };
}

function smeltRequest(
  furnace: { x: number; y: number; z: number } | null = null,
): SkillCapabilityRequest {
  return {
    invocationId: crypto.randomUUID(),
    traceId: "trace-smelt-001",
    taskId: "task-smelt-001",
    botId: "worker-01",
    skillId: "smelt.item",
    skillVersion: "1.0.0",
    capability: "craft.execute",
    operation: "smelt.item-safe",
    input: {
      inputItemName: "raw_iron",
      fuelItemName: "coal",
      fuelCount: 1,
      count: 1,
      furnace,
      dimension: "minecraft:overworld",
      serverProfileId: SERVER_PROFILE_ID,
    },
    signal: new AbortController().signal,
  };
}

function inventoryRequest(): SkillCapabilityRequest {
  return {
    invocationId: crypto.randomUUID(),
    traceId: "trace-inventory-001",
    taskId: "task-inventory-001",
    botId: "worker-01",
    skillId: "goal.ensure-item",
    skillVersion: "1.0.0",
    capability: "inventory.read",
    operation: "inventory.snapshot",
    input: {
      dimension: "minecraft:overworld",
      serverProfileId: SERVER_PROFILE_ID,
      maxItemTypes: 128,
    },
    signal: new AbortController().signal,
  };
}

function craftRequest(count: number): SkillCapabilityRequest {
  return {
    invocationId: crypto.randomUUID(),
    traceId: "trace-craft-001",
    taskId: `task-craft-${count}`,
    botId: "worker-01",
    skillId: "craft.item",
    skillVersion: "1.0.0",
    capability: "craft.execute",
    operation: "craft.item-safe",
    input: {
      itemName: "wooden_pickaxe",
      count,
      craftingTable: null,
      dimension: "minecraft:overworld",
      serverProfileId: SERVER_PROFILE_ID,
    },
    signal: new AbortController().signal,
  };
}

function handlers(
  overrides: Partial<BotClientHandlers>,
): BotClientHandlers {
  return {
    onSpawn: () => undefined,
    onStateChanged: () => undefined,
    onDisconnected: () => undefined,
    onError: () => undefined,
    onVersionUnsupported: () => undefined,
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("MineflayerBotClient utility-station guard", () => {
  it.each([null, { x: 2, y: 64, z: 0 }])("fences busy furnaces on automatic and explicit paths (%j)", async (target) => {
    const registry = new InMemoryWorkstationRegistry();
    const position = new Vec3(2, 64, 0);
    registry.register(SERVER_PROFILE_ID, "minecraft:overworld", "furnace", position);
    registry.claim(SERVER_PROFILE_ID, "minecraft:overworld", position, "other", 30_000,
      { ownerRuntimeId: "runtime-other", ownerTaskId: "task-other", ownerAttemptId: "attempt-other" });
    const fixture = makeFixture({ furnacePositions: [position], furnaceInInventory: true, workstationRegistry: registry });
    await expect(fixture.client.invokeSkillCapability(smeltRequest(target))).rejects.toMatchObject({ code: "WORKSTATION_BUSY" });
    expect(fixture.openFurnace).not.toHaveBeenCalled();
    expect(fixture.placeBlock).not.toHaveBeenCalled();
  });

  it("keeps the furnace lease beyond 30 seconds and closes on renewal failure before taking output", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryWorkstationRegistry();
    const position = new Vec3(2, 64, 0);
    const fixture = makeFixture({ furnacePositions: [position], workstationRegistry: registry });
    fixture.furnaceWindow.putFuel.mockImplementation(async () => {});
    const pending = fixture.client.invokeSkillCapability(smeltRequest()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(40_000);
    expect(fixture.furnaceWindow.putFuel).toHaveBeenCalledOnce();
    expect(registry.claim(SERVER_PROFILE_ID, "minecraft:overworld", position, "other")).toBe(false);
    vi.spyOn(registry, "renewClaim").mockImplementation(() => { throw new Error("authority disconnected"); });
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).code).toBe("SKILL_CANCELLED");
    expect(fixture.furnaceWindow.close).toHaveBeenCalled();
    expect(fixture.furnaceWindow.takeOutput).not.toHaveBeenCalled();
  });

  it("returns a bounded real inventory snapshot for the closed-loop goal", async () => {
    const fixture = makeFixture({ furnaceInInventory: true });

    const result = await fixture.client.invokeSkillCapability(inventoryRequest());

    expect(result).toMatchObject({
      dimension: "minecraft:overworld",
      serverProfileId: SERVER_PROFILE_ID,
      items: [
        { itemName: "coal", count: 1 },
        { itemName: "furnace", count: 1 },
        { itemName: "raw_iron", count: 1 },
      ],
    });
    expect(result).toHaveProperty("worldStateVersion", expect.any(Number));
  });

  it("reuses a nearby furnace when smelt.item leaves the station nullable", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = makeFixture({
      furnacePositions: [new Vec3(2, 64, 0)],
      furnaceInInventory: true,
    });

    const result = await fixture.client.invokeSkillCapability(smeltRequest());

    expect(result).toMatchObject({
      outputItemName: "iron_ingot",
      smeltedCount: 1,
    });
    expect(fixture.openFurnace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "furnace",
        position: expect.objectContaining({ x: 2, y: 64, z: 0 }),
      }),
    );
    expect(fixture.placeBlock).not.toHaveBeenCalled();
  });

  it("moves through the shared movement controller to reuse a scanned furnace", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = makeFixture({
      furnacePositions: [new Vec3(10, 64, 0)],
      furnaceInInventory: true,
    });

    const result = await fixture.client.invokeSkillCapability(smeltRequest());

    expect(result).toMatchObject({ smeltedCount: 1 });
    expect(fixture.pathfinderGoto).toHaveBeenCalledTimes(1);
    expect(fixture.placeBlock).not.toHaveBeenCalled();
    expect(fixture.openFurnace).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "furnace",
        position: expect.objectContaining({ x: 10, y: 64, z: 0 }),
      }),
    );
    expect(fixture.client.movementController.currentLease()).toBeNull();
  });

  it("adds no crafting table across 20 tasks when ten are already nearby", async () => {
    const fixture = makeFixture({
      craftingTablePositions: Array.from(
        { length: 10 },
        (_, index) => new Vec3(8 + index, 64, 0),
      ),
      inventoryItems: [
        { name: "oak_planks", count: 64 },
        { name: "stick", count: 64 },
      ],
    });

    for (let count = 1; count <= 20; count += 1) {
      await expect(
        fixture.client.invokeSkillCapability(craftRequest(count)),
      ).resolves.toMatchObject({
        itemName: "wooden_pickaxe",
        requestedCount: count,
        craftedCount: 1,
        usedCraftingTable: true,
      });
    }

    expect(fixture.pathfinderGoto).toHaveBeenCalledTimes(1);
    expect(fixture.placeBlock).not.toHaveBeenCalled();
    expect(
      fixture.inventoryItems.find(({ name }) => name === "wooden_pickaxe")
        ?.count,
    ).toBe(20);
  });

  it("places one inventory furnace through the guarded nullable path", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = makeFixture({ furnaceInInventory: true });

    const result = await fixture.client.invokeSkillCapability(smeltRequest());

    expect(result).toMatchObject({ smeltedCount: 1 });
    expect(fixture.equip).toHaveBeenCalledWith(
      expect.objectContaining({ name: "furnace" }),
      "hand",
    );
    expect(fixture.placeBlock).toHaveBeenCalledTimes(1);
    expect(fixture.placedFurnaces.size).toBe(1);
  });

  it("reuses one of many scanned furnaces without adding another", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = makeFixture({
      furnacePositions: Array.from(
        { length: 10 },
        (_, index) => new Vec3(8 + index, 64, 0),
      ),
      furnaceInInventory: true,
    });

    await expect(
      fixture.client.invokeSkillCapability(smeltRequest()),
    ).resolves.toMatchObject({ smeltedCount: 1 });
    expect(fixture.placeBlock).not.toHaveBeenCalled();
    expect(fixture.placedFurnaces.size).toBe(0);
  });

  it("does not place a duplicate when a scanned furnace is unreachable", async () => {
    const fixture = makeFixture({
      furnacePositions: [new Vec3(10, 64, 0)],
      furnaceInInventory: true,
      pathfinderFails: true,
    });

    await expect(
      fixture.client.invokeSkillCapability(smeltRequest()),
    ).rejects.toMatchObject({ code: "FURNACE_UNAVAILABLE" });
    expect(fixture.placeBlock).not.toHaveBeenCalled();
  });

  it("rate-limits a retry after an unconfirmed non-idempotent placement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = makeFixture({
      furnaceInInventory: true,
      placementFails: true,
    });

    await expect(
      fixture.client.invokeSkillCapability(smeltRequest()),
    ).rejects.toMatchObject({ code: "FURNACE_PLACEMENT_FAILED" });
    await expect(
      fixture.client.invokeSkillCapability(smeltRequest()),
    ).rejects.toMatchObject({ code: "FURNACE_PLACEMENT_COOLDOWN" });
    expect(fixture.placeBlock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when neither an observed nor inventory furnace exists", async () => {
    const fixture = makeFixture();

    await expect(
      fixture.client.invokeSkillCapability(smeltRequest()),
    ).rejects.toMatchObject({ code: "FURNACE_NOT_IN_INVENTORY" });
    expect(fixture.placeBlock).not.toHaveBeenCalled();
  });
});

describe("MineflayerBotClient world-state block scan throttling", () => {
  it("runs one important-block scan across repeated physics ticks", () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const fixture = makeFixture({ registeredBlockNames: importantBlockNames });
    fixture.client.setHandlers(
      handlers({
        onStateChanged: () => {
          fixture.client.worldStateSnapshot();
        },
      }),
    );

    fixture.emitter.emit("physicsTick");
    fixture.emitter.emit("physicsTick");
    fixture.emitter.emit("physicsTick");

    expect(fixture.findBlocks).toHaveBeenCalledTimes(importantBlockNames.length);
    vi.advanceTimersByTime(fixture.client.worldStateBlockScanIntervalMs - 1);
    fixture.emitter.emit("physicsTick");
    expect(fixture.findBlocks).toHaveBeenCalledTimes(importantBlockNames.length);
    vi.advanceTimersByTime(1);
    fixture.emitter.emit("physicsTick");
    expect(fixture.findBlocks).toHaveBeenCalledTimes(
      importantBlockNames.length * 2,
    );
  });
});

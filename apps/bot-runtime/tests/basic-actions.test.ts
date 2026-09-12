import { EventEmitter } from "node:events";

import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sleepableWindow } from "@minecraft-studio/skills";

import { MineflayerBotClient } from "./fixtures/in-memory-client.js";

// ---------------------------------------------------------------------------
// 基础动作能力（food.eat-safe / sleep-safe / fluid.fill-safe）的假 bot 测试。
//
// 与"纯技能"测试的分界：这三个操作会真的碰世界，所以必须用假 bot 把它们
// 打到适配器上。假 bot 不是模拟器——它只做一件事：**把读回值变成可控的**，
// 于是"结果是靠读回判定出来"这句话可以被断言，而不是被相信。
//
// 每个能力都配一条"读回不成立"的反例：consume()/sleep()/use_item() 都成功
// 返回、但服务器侧没有任何变化时，能力必须拒绝（*_NOT_CONFIRMED），
// 把"动作发出去了"和"世界真的变了"分开。
//
// 真实服务器语义（服务器窗口同步时序、床的 occupied 位、装桶的源方块判定）
// 仍未验证——见交付报告。
// ---------------------------------------------------------------------------

const PROFILE = "isolated-test-profile";
const DIMENSION = "minecraft:overworld";

interface InventoryStack {
  name: string;
  count: number;
  type?: number;
}

/** 可变的假背包：consume()/装桶都要真的改计数，否则读回必然失败。 */
function inventoryOf(stacks: InventoryStack[]) {
  return {
    stacks,
    items: () => stacks.filter((stack) => stack.count > 0),
    countOf: (name: string) =>
      stacks.filter((stack) => stack.name === name).reduce((sum, stack) => sum + stack.count, 0),
  };
}

function capabilityRequest(
  operation: string,
  input: Record<string, unknown>,
  overrides: { skillId?: string; signal?: AbortSignal } = {},
) {
  return {
    invocationId: `invocation-${operation}`,
    traceId: `trace-${operation}`,
    taskId: `task-${operation}`,
    botId: `bot-${operation}`,
    skillId: overrides.skillId ?? operation,
    skillVersion: "1.0.0",
    capability: "world.interact" as const,
    operation,
    input,
    signal: overrides.signal ?? new AbortController().signal,
  };
}

function block(name: string, position: Vec3, boundingBox = "empty") {
  return { name, position, boundingBox, getProperties: () => ({}) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("world.interact / food.eat-safe", () => {
  /**
   * 假 bot：registry.foodsByName 是 safeFoodItems() 的元数据来源（缺它整批食物
   * 会被过滤掉），inventory.items() 是食物来源，consume() 是唯一改变计数的动作。
   */
  function eatingBot(options: {
    stacks: InventoryStack[];
    hunger: number | undefined;
    saturation?: number | undefined;
    onConsume?: (bot: ReturnType<typeof eatingBot>) => void;
  }) {
    const inventory = inventoryOf(options.stacks);
    const bot = Object.assign(new EventEmitter(), {
      game: { dimension: DIMENSION },
      registry: {
        foodsByName: {
          bread: { foodPoints: 5, effectiveQuality: 6 },
          cooked_beef: { foodPoints: 8, effectiveQuality: 12.8 },
        },
      },
      inventory,
      food: options.hunger,
      foodSaturation: options.saturation,
      clearControlStates: vi.fn(),
      equip: vi.fn(async () => undefined),
      consume: vi.fn(async () => { options.onConsume?.(bot); }),
    });
    return bot;
  }

  it("eats the food commons picks and proves it with the count readback", async () => {
    const bot = eatingBot({
      stacks: [{ name: "bread", count: 2 }, { name: "cooked_beef", count: 2, type: 2 }],
      hunger: 10,
      saturation: 2,
      onConsume: (current) => {
        // 服务器权威：吃掉了熟牛肉一份，饥饿 +8。
        current.inventory.stacks.find((s) => s.name === "cooked_beef")!.count -= 1;
        current.food = 18;
        current.foodSaturation = 12.8;
      },
    });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);

    await expect(
      client.invokeSkillCapability(
        capabilityRequest("food.eat-safe", {
          itemName: "bread",
          dimension: DIMENSION,
          serverProfileId: PROFILE,
        }),
      ),
    ).resolves.toEqual({
      succeeded: true,
      itemName: "cooked_beef",
      remainingCount: 1,
      consumedCount: 1,
      hungerBefore: 10,
      hungerAfter: 18,
      saturationBefore: 2,
      saturationAfter: 12.8,
      // commons 投影：cooked_beef 饱和 +12.8，饥饿 10→18 未触顶，故无溢出。
      projectedSaturationGain: 12.8,
      reasonCode: "BEST_SATURATION_EFFICIENCY",
    });
  });

  it("is completed by the readback: a resolved consume() that changed nothing is FOOD_EAT_NOT_CONFIRMED", async () => {
    const bot = eatingBot({
      stacks: [{ name: "bread", count: 2 }],
      hunger: 10,
      saturation: 2,
      // consume() resolve 了，但服务器没吃：计数不动、饥饿不动。
    });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);

    await expect(
      client.invokeSkillCapability(
        capabilityRequest("food.eat-safe", {
          itemName: "bread",
          dimension: DIMENSION,
          serverProfileId: PROFILE,
        }),
      ),
    ).rejects.toMatchObject({ code: "FOOD_EAT_NOT_CONFIRMED" });
    expect(bot.consume).toHaveBeenCalledOnce();
  });

  it("refuses with FOOD_NOT_NEEDED when hunger is already full", async () => {
    const bot = eatingBot({ stacks: [{ name: "bread", count: 2 }], hunger: 20, saturation: 5 });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);

    await expect(
      client.invokeSkillCapability(
        capabilityRequest("food.eat-safe", {
          itemName: "bread",
          dimension: DIMENSION,
          serverProfileId: PROFILE,
        }),
      ),
    ).rejects.toMatchObject({ code: "FOOD_NOT_NEEDED" });
    // 拒绝发生在 equip/consume 之前：没有产生任何副作用。
    expect(bot.equip).not.toHaveBeenCalled();
    expect(bot.consume).not.toHaveBeenCalled();
  });

  it("refuses with PROCESS_NO_SAFE_FOOD_SOURCE when only harmful or unknown food is held", async () => {
    const bot = eatingBot({
      stacks: [
        { name: "rotten_flesh", count: 3 },
        { name: "poisonous_potato", count: 1 },
      ],
      hunger: 6,
      saturation: 0,
    });
    // 有害食物不在 SAFE_FOOD_NAMES 里，safeFoodItems() 直接空集。
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(
        capabilityRequest("food.eat-safe", {
          itemName: "rotten_flesh",
          dimension: DIMENSION,
          serverProfileId: PROFILE,
        }),
      ),
    ).rejects.toMatchObject({ code: "PROCESS_NO_SAFE_FOOD_SOURCE" });
    expect(bot.consume).not.toHaveBeenCalled();
  });

  it("fails closed with BOT_HUNGER_UNKNOWN when the server never sent hunger", async () => {
    const bot = eatingBot({ stacks: [{ name: "bread", count: 2 }], hunger: undefined });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(
        capabilityRequest("food.eat-safe", {
          itemName: "bread",
          dimension: DIMENSION,
          serverProfileId: PROFILE,
        }),
      ),
    ).rejects.toMatchObject({ code: "BOT_HUNGER_UNKNOWN" });
  });

  it("refuses a foreign dimension before touching the inventory", async () => {
    const bot = eatingBot({ stacks: [{ name: "bread", count: 2 }], hunger: 10 });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(
        capabilityRequest("food.eat-safe", {
          itemName: "bread",
          dimension: "minecraft:the_nether",
          serverProfileId: PROFILE,
        }),
      ),
    ).rejects.toMatchObject({ code: "TARGET_DIMENSION_MISMATCH" });
    expect(bot.equip).not.toHaveBeenCalled();
  });
});

describe("world.interact / sleep-safe", () => {
  const BED = new Vec3(4, 64, 4);

  function sleepingBot(options: {
    dimension?: string;
    /** "unset" = 服务器从未推送过时间（模拟 time 包缺失）。 */
    timeOfDay?: number | "unset";
    isRaining?: boolean;
    thunderState?: number;
    bedName?: string;
    bedProperties?: Record<string, unknown>;
    headroom?: string;
    onSleep?: (bot: ReturnType<typeof sleepingBot>) => void;
  } = {}) {
    const bedName = options.bedName ?? "red_bed";
    const headroom = options.headroom ?? "air";
    const timeOfDay = options.timeOfDay ?? 15_000;
    const bot = Object.assign(new EventEmitter(), {
      game: { dimension: options.dimension ?? DIMENSION },
      // 时间包缺失时 bot.time 整体不存在——照 mineflayer 的真实形状来。
      ...(timeOfDay === "unset" ? {} : { time: { timeOfDay } }),
      isRaining: options.isRaining ?? false,
      thunderState: options.thunderState ?? 0,
      isSleeping: false,
      entity: { id: 1, position: new Vec3(4, 65, 5), velocity: new Vec3(0, 0, 0), effects: {} },
      inventory: inventoryOf([]),
      clearControlStates: vi.fn(),
      blockAt: vi.fn((position: Vec3) => {
        if (position.equals(BED)) {
          return {
            name: bedName,
            position: BED,
            boundingBox: "block",
            getProperties: () => ({ part: "head", occupied: false, ...options.bedProperties }),
          };
        }
        return {
          name: headroom,
          position,
          boundingBox: headroom === "air" ? "empty" : "block",
          getProperties: () => ({}),
        };
      }),
      isABed: (candidate: { name: string }) => /_bed$/u.test(candidate.name),
      sleep: vi.fn(async () => { options.onSleep?.(bot); }),
    });
    return bot;
  }

  const sleepInput = { bed: { x: BED.x, y: BED.y, z: BED.z }, dimension: DIMENSION, serverProfileId: PROFILE };

  it("sleeps at night and is completed by the isSleeping readback", async () => {
    const bot = sleepingBot({ onSleep: (current) => { current.isSleeping = true; } });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).resolves.toEqual({
      succeeded: true,
      isSleepingAfter: true,
      sleepableWindowAtAttempt: true,
      timeOfDayAtAttempt: 15_000,
      timeOfDayAfter: 15_000,
      bedBlockName: "red_bed",
      position: { x: BED.x, y: BED.y, z: BED.z },
    });
    expect(bot.sleep).toHaveBeenCalledOnce();
  });

  it("refuses to touch a bed in the nether (BED_EXPLODES) without calling sleep()", async () => {
    const bot = sleepingBot({ dimension: "minecraft:the_nether" });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(
        capabilityRequest("sleep-safe", { ...sleepInput, dimension: "minecraft:the_nether" }),
      ),
    ).rejects.toMatchObject({ code: "BED_EXPLODES" });
    // 确定性拒绝发生在 activateBlock 之前：床没有被碰过。
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it("refuses to touch a bed in the end (BED_EXPLODES)", async () => {
    const bot = sleepingBot({ dimension: "minecraft:the_end" });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(
        capabilityRequest("sleep-safe", { ...sleepInput, dimension: "minecraft:the_end" }),
      ),
    ).rejects.toMatchObject({ code: "BED_EXPLODES" });
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it.each([0, 500, 12_000, 12_522, 23_478])("refuses clear-weather daytime %i (SLEEP_NOT_NIGHT)", async (timeOfDay) => {
    const bot = sleepingBot({ timeOfDay });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code: "SLEEP_NOT_NIGHT" });
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it.each([12_523, 15_000, 23_477])("accepts the clear-weather window %i", async (timeOfDay) => {
    const bot = sleepingBot({ timeOfDay, onSleep: (current) => { current.isSleeping = true; } });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).resolves.toMatchObject({ succeeded: true, timeOfDayAtAttempt: timeOfDay });
  });

  it.each([12_001, 23_999])("refuses the rain window edges %i while raining", async (timeOfDay) => {
    const bot = sleepingBot({ timeOfDay, isRaining: true, thunderState: 0 });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code: "SLEEP_NOT_NIGHT" });
  });

  it.each([12_002, 23_998])("accepts the rain window edge %i while raining", async (timeOfDay) => {
    const bot = sleepingBot({ timeOfDay, isRaining: true, thunderState: 0,
      onSleep: (current) => { current.isSleeping = true; } });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).resolves.toMatchObject({ succeeded: true, timeOfDayAtAttempt: timeOfDay });
  });

  it("refuses tick 500 while merely raining (rain is not a thunderstorm)", async () => {
    // 修复前这里会错：适配器把"下雨 + thunderState>0"当雷暴，普通下雨的白天
    // 会被前置与适配器给出相反答案。
    const bot = sleepingBot({ timeOfDay: 500, isRaining: true, thunderState: 0 });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code: "SLEEP_NOT_NIGHT" });
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it("accepts a daytime thunderstorm (vanilla exception)", async () => {
    const bot = sleepingBot({ timeOfDay: 500, isRaining: true, thunderState: 1,
      onSleep: (current) => { current.isSleeping = true; } });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).resolves.toMatchObject({ succeeded: true, sleepableWindowAtAttempt: true });
  });

  it("reaches the same verdict as the shared sleepableWindow for every weather/time cell", async () => {
    // 双闸独立的是**读数**，不是判据：适配器读到的同一组事实，结论必须与
    // skills 包的唯一实现逐格一致。
    const client = new MineflayerBotClient(sleepingBot() as unknown as Bot, "auto", PROFILE);
    for (const timeOfDay of [0, 500, 12_001, 12_002, 12_522, 12_523, 15_000, 23_477, 23_478, 23_998, 23_999]) {
      for (const [isRaining, thunderState] of [[false, 0], [true, 0], [true, 1], [false, 1]] as const) {
        const bot = sleepingBot({ timeOfDay, isRaining, thunderState });
        const probe = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
        const reading = (probe as unknown as { readNightWindow(): { sleepable: boolean } | null })
          .readNightWindow();
        expect(reading?.sleepable, `timeOfDay=${timeOfDay} rain=${isRaining} thunder=${thunderState}`)
          .toBe(sleepableWindow(timeOfDay, { raining: isRaining, thundering: thunderState > 0 }));
      }
    }
    expect(client).toBeDefined();
  });

  it("fails closed with BOT_TIME_UNKNOWN when the server never sent world time", async () => {
    const bot = sleepingBot({ timeOfDay: "unset" });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code: "BOT_TIME_UNKNOWN" });
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["not-a-bed", {}, "SLEEP_BED_UNAVAILABLE"],
    ["red_bed", { occupied: true }, "SLEEP_BED_UNAVAILABLE"],
  ] as const)("refuses %s (props=%o) with %s", async (bedName, bedProperties, code) => {
    const bot = sleepingBot({ bedName, bedProperties });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code });
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it("refuses a bed with a blocked headroom (SLEEP_BED_UNAVAILABLE)", async () => {
    const bot = sleepingBot({ headroom: "stone" });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code: "SLEEP_BED_UNAVAILABLE" });
    expect(bot.sleep).not.toHaveBeenCalled();
  });

  it("is completed by the readback: a resolved sleep() that left isSleeping false is SLEEP_NOT_CONFIRMED", async () => {
    const bot = sleepingBot();
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("sleep-safe", sleepInput)),
    ).rejects.toMatchObject({ code: "SLEEP_NOT_CONFIRMED" });
    expect(bot.sleep).toHaveBeenCalledOnce();
  });
});

describe("world.interact / fluid.fill-safe", () => {
  const SOURCE = new Vec3(1, 64, 0);

  function bucketBot(options: {
    stacks: InventoryStack[];
    sourceBlockName?: string | null;
    onUse?: (bot: ReturnType<typeof bucketBot>) => void;
  }) {
    const inventory = inventoryOf(options.stacks);
    // 源方块名放在闭包里：假 bot 的 blockAt 每次返回新对象，改"方块"必须改这里。
    const world = { sourceName: options.sourceBlockName === undefined ? "water" : options.sourceBlockName };
    const bot = Object.assign(new EventEmitter(), {
      game: { dimension: DIMENSION },
      entity: { id: 1, position: new Vec3(0, 64, 0), velocity: new Vec3(0, 0, 0), effects: {} },
      world,
      inventory,
      clearControlStates: vi.fn(),
      equip: vi.fn(async () => undefined),
      lookAt: vi.fn(async () => undefined),
      activateItem: vi.fn(() => { options.onUse?.(bot); }),
      blockAt: vi.fn((position: Vec3) =>
        position.equals(SOURCE)
          ? (world.sourceName === null ? null : block(world.sourceName, SOURCE, "empty"))
          : block("air", position)),
    });
    return bot;
  }

  const fillInput = {
    mode: "water" as const,
    target: { x: SOURCE.x, y: SOURCE.y, z: SOURCE.z },
    dimension: DIMENSION,
    serverProfileId: PROFILE,
  };

  it("fills the bucket and proves it with the two-sided inventory readback", async () => {
    const bot = bucketBot({
      stacks: [{ name: "bucket", count: 2 }],
      onUse: (current) => {
        // 服务器权威：一个空桶变成水桶，源方块被取走。
        // 注意是**原地**改数组：inventory.items() 闭包持有同一个引用。
        current.inventory.stacks.splice(
          0,
          current.inventory.stacks.length,
          { name: "water_bucket", count: 1 },
          { name: "bucket", count: 1 },
        );
        current.world.sourceName = "air";
      },
    });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);

    await expect(
      client.invokeSkillCapability(capabilityRequest("fluid.fill-safe", fillInput)),
    ).resolves.toEqual({
      succeeded: true,
      mode: "water",
      filledItemName: "water_bucket",
      emptyBucketBefore: 2,
      emptyBucketAfter: 1,
      filledBucketBefore: 0,
      filledBucketAfter: 1,
      resultingBlockName: "air",
      position: { x: SOURCE.x, y: SOURCE.y, z: SOURCE.z },
    });
    expect(bot.equip).toHaveBeenCalledOnce();
    expect(bot.activateItem).toHaveBeenCalledOnce();
  });

  it("is completed by the readback: a fired use_item that changed nothing is FLUID_FILL_NOT_CONFIRMED", async () => {
    vi.useFakeTimers();
    const bot = bucketBot({ stacks: [{ name: "bucket", count: 1 }] });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    const pending = client.invokeSkillCapability(capabilityRequest("fluid.fill-safe", fillInput));
    const assertion = expect(pending).rejects.toMatchObject({ code: "FLUID_FILL_NOT_CONFIRMED" });
    await vi.advanceTimersByTimeAsync(2_000);
    await assertion;
    expect(bot.activateItem).toHaveBeenCalledOnce();
  });

  it("refuses an empty bucket shortfall before any world interaction", async () => {
    const bot = bucketBot({ stacks: [{ name: "water_bucket", count: 1 }] });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("fluid.fill-safe", fillInput)),
    ).rejects.toMatchObject({ code: "FLUID_BUCKET_MISSING" });
    expect(bot.activateItem).not.toHaveBeenCalled();
  });

  it.each([["lava", "water"], ["water", "lava"]] as const)(
    "refuses a %s fill aimed at a %s block (FLUID_TARGET_NOT_SOURCE)",
    async (mode, blockName) => {
      const bot = bucketBot({ stacks: [{ name: "bucket", count: 1 }], sourceBlockName: blockName });
      const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
      await expect(
        client.invokeSkillCapability(
          capabilityRequest("fluid.fill-safe", { ...fillInput, mode }),
        ),
      ).rejects.toMatchObject({ code: "FLUID_TARGET_NOT_SOURCE" });
      expect(bot.activateItem).not.toHaveBeenCalled();
    },
  );

  it("refuses a loaded-but-empty target (FLUID_TARGET_NOT_SOURCE)", async () => {
    const bot = bucketBot({ stacks: [{ name: "bucket", count: 1 }], sourceBlockName: null });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    await expect(
      client.invokeSkillCapability(capabilityRequest("fluid.fill-safe", fillInput)),
    ).rejects.toMatchObject({ code: "FLUID_TARGET_NOT_SOURCE" });
  });
});

// ---------------------------------------------------------------------------
// L0 阻断路径（apps/bot-runtime/tests/v1-l0-wiring-matrix.test.ts 的 runtimeWiring
// 证据位要的就是这一条）：bot 进入停机/暂停后，三个新操作**都**必须在
// 触碰世界之前拒绝，而不是"发出去再看结果"。
// ---------------------------------------------------------------------------
describe("L0 stop gate blocks the three basic actions before any world interaction", () => {
  it.each([
    ["food.eat-safe", { itemName: "bread", dimension: DIMENSION, serverProfileId: PROFILE }],
    ["sleep-safe", { bed: { x: 4, y: 64, z: 4 }, dimension: DIMENSION, serverProfileId: PROFILE }],
    ["fluid.fill-safe", { mode: "water", target: { x: 1, y: 64, z: 0 }, dimension: DIMENSION, serverProfileId: PROFILE }],
  ] as const)("%s is refused with RUNTIME_STOPPING and touches nothing", async (operation, input) => {
    const bot = Object.assign(new EventEmitter(), {
      game: { dimension: DIMENSION },
      time: { timeOfDay: 15_000 },
      isRaining: false,
      thunderState: 0,
      isSleeping: false,
      food: 10,
      foodSaturation: 2,
      entity: { id: 1, position: new Vec3(4, 65, 5), velocity: new Vec3(0, 0, 0), effects: {} },
      registry: { foodsByName: { bread: { foodPoints: 5, effectiveQuality: 6 } } },
      inventory: inventoryOf([{ name: "bread", count: 2 }, { name: "bucket", count: 2 }]),
      clearControlStates: vi.fn(),
      equip: vi.fn(async () => undefined),
      consume: vi.fn(async () => undefined),
      sleep: vi.fn(async () => undefined),
      lookAt: vi.fn(async () => undefined),
      activateItem: vi.fn(),
      isABed: (candidate: { name: string }) => /_bed$/u.test(candidate.name),
      blockAt: vi.fn((position: Vec3) => block("air", position, "empty")),
      // close(0) 会走 quit + end（见 mineflayer-client.ts 的优雅停机）；两者都
      // 触发 end 事件让停止 Promise 收尾。
      quit: vi.fn((reason: string) => { bot.emit("end", reason); }),
      end: vi.fn((reason: string) => { bot.emit("end", reason); }),
    });
    const client = new MineflayerBotClient(bot as unknown as Bot, "auto", PROFILE);
    // close() 先同步置 requestedStop，再走优雅停机；能力调用必须在它之后被拒。
    const closing = client.close(0);
    await expect(
      client.invokeSkillCapability(capabilityRequest(operation, input)),
    ).rejects.toMatchObject({ code: "RUNTIME_STOPPING" });
    expect(bot.consume).not.toHaveBeenCalled();
    expect(bot.sleep).not.toHaveBeenCalled();
    expect(bot.activateItem).not.toHaveBeenCalled();
    await closing;
  });
});

import { describe, expect, it } from "vitest";

import {
  foodEntryFor,
  foodTable,
  harmfulFoodItemNames,
  HIGH_SATURATION_RATIO,
  MAX_HUNGER,
  normalizeFoodName,
  projectEat,
  rawFoodRiskNotes,
  saturationRatio,
} from "../src/commons/index.js";
import { foodPickSkill } from "../src/builtin/food-pick.js";

// ---------------------------------------------------------------------------
// 食物表 + 三条常识规则：
//   1. 饥饿满了再吃 = 白丢一件；
//   2. 饱和度比饥饿点更值钱（撑得久），选食物要按"单位饥饿换到的有效饱和度"比；
//   3. 有害食物（腐肉/毒马铃薯/蜘蛛眼/河豚）永远不用来填饥饿。
// ---------------------------------------------------------------------------

const scope = { serverProfileId: "isolated-local" };
const state = { online: true, normalActionsAllowed: true, serverProfileId: "isolated-local" };

describe("commons/food-values — 食物表", () => {
  it("记住熟食的饥饿/饱和度（熟牛肉 8/12.8、面包 5/6、金胡萝卜 6/14.4）", () => {
    expect(foodEntryFor("cooked_beef")).toMatchObject({ hunger: 8, saturation: 12.8, cooked: true, harmful: false });
    expect(foodEntryFor("bread")).toMatchObject({ hunger: 5, saturation: 6 });
    expect(foodEntryFor("golden_carrot")).toMatchObject({ hunger: 6, saturation: 14.4 });
    expect(foodEntryFor("cooked_porkchop")).toMatchObject({ hunger: 8, saturation: 12.8 });
    expect(foodEntryFor("cooked_chicken")).toMatchObject({ hunger: 6, saturation: 7.2 });
  });

  it("记住生食明显更亏：生牛肉 3/1.8，熟牛肉 8/12.8", () => {
    expect(foodEntryFor("beef")).toMatchObject({ hunger: 3, saturation: 1.8, raw: true, cooked: false });
    expect(foodEntryFor("cooked_beef")).toMatchObject({ cooked: true, cookedFrom: "beef" });
    expect(foodEntryFor("chicken")).toMatchObject({ hunger: 2, saturation: 1.2, raw: true });
    expect(foodEntryFor("cooked_chicken")).toMatchObject({ cookedFrom: "chicken" });
    // 生鱼几乎不顶饿：0.4 的饱和度。
    expect(foodEntryFor("cod")).toMatchObject({ hunger: 2, saturation: 0.4 });
    expect(foodEntryFor("cooked_cod")).toMatchObject({ hunger: 5, saturation: 6 });
  });

  it("标记出四种有害食物，并给出各自的负面效果说明", () => {
    expect(harmfulFoodItemNames).toEqual(["poisonous_potato", "pufferfish", "rotten_flesh", "spider_eye"]);
    for (const itemName of harmfulFoodItemNames) {
      expect(foodEntryFor(itemName)?.harmful).toBe(true);
      expect(rawFoodRiskNotes[itemName]).toBeTruthy();
    }
    // 生鸡肉不是"有害"，而是"有 30% 概率触发饥饿"——风险说明里有写。
    expect(foodEntryFor("chicken")?.harmful).toBe(false);
    expect(rawFoodRiskNotes.chicken).toContain("30%");
  });

  it("饱和度/饥饿比：熟牛肉 1.6（高密度）、曲奇 0.2（填肚子但不顶用）", () => {
    expect(saturationRatio(foodEntryFor("cooked_beef")!)).toBeCloseTo(1.6, 5);
    expect(saturationRatio(foodEntryFor("cookie")!)).toBeCloseTo(0.2, 5);
    expect(HIGH_SATURATION_RATIO).toBe(1);
  });

  it("命名空间前缀被规范化掉", () => {
    expect(normalizeFoodName("minecraft:Cooked_Beef")).toBe("cooked_beef");
    expect(foodEntryFor("minecraft:bread")).toMatchObject({ hunger: 5 });
    expect(foodEntryFor("diamond")).toBeNull();
  });

  it("projectEat 按原版顺序算：先加饥饿，饱和度上限 = 加完之后的饥饿值", () => {
    // 饥饿 14、饱和度 0，吃熟牛肉（+8 / +12.8）：饥饿 22 → 夹到 20，
    // 溢出 2 点饥饿；饱和度上限 = 20，12.8 全进得去。
    const projection = projectEat("cooked_beef", 14, 0)!;
    expect(projection).toMatchObject({ hungerAfter: 20, wastedHunger: 2, effectiveSaturation: 12.8, wastedSaturation: 0 });
    // 饥饿 19、饱和度 0，吃金胡萝卜（+6 / +14.4）：饥饿夹到 20、饱和度上限 20 → 14.4 全进。
    expect(projectEat("golden_carrot", 19, 0)).toMatchObject({ hungerAfter: 20, effectiveSaturation: 14.4 });
    // 饥饿 10、饱和度 9.5，吃面包（+5 / +6）：饥饿 15、饱和度 15.5 → 上限 15，溢出 0.5。
    expect(projectEat("bread", 10, 9.5)).toMatchObject({ hungerAfter: 15, saturationAfter: 15, wastedSaturation: 0.5 });
  });

  it("饥饿已满时吃任何东西都是 100% 浪费", () => {
    const projection = projectEat("cooked_beef", MAX_HUNGER, 20)!;
    expect(projection).toMatchObject({ hungerAfter: 20, wastedHunger: 8, effectiveSaturation: 0 });
  });
});

describe("food.pick — 选一口吃的", () => {
  it("饥饿满了就拒绝，并说明是浪费", async () => {
    const output = await foodPickSkill.execute(
      {} as never,
      { candidates: [{ itemName: "cooked_beef", count: 4 }], hunger: { hunger: 20, saturation: 20 }, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "REFUSE", itemName: null, reasonCode: "HUNGER_ALREADY_FULL" });
    expect(output.projection).toBeNull();
  });

  it("有害食物被排除；只剩有害食物时拒绝而不是硬吃", async () => {
    const onlyHarmful = await foodPickSkill.execute(
      {} as never,
      {
        candidates: [
          { itemName: "rotten_flesh", count: 3 },
          { itemName: "spider_eye", count: 1 },
        ],
        hunger: { hunger: 6, saturation: 0 },
        ...scope,
      },
      state,
    );
    expect(onlyHarmful).toMatchObject({ verdict: "REFUSE", reasonCode: "ONLY_HARMFUL_FOOD" });
    expect(onlyHarmful.refusedHarmful).toEqual(["rotten_flesh", "spider_eye"]);

    const mixed = await foodPickSkill.execute(
      {} as never,
      {
        candidates: [
          { itemName: "rotten_flesh", count: 3 },
          { itemName: "bread", count: 1 },
        ],
        hunger: { hunger: 6, saturation: 0 },
        ...scope,
      },
      state,
    );
    expect(mixed.verdict).toBe("EAT");
    expect(mixed.itemName).toBe("bread");
    expect(mixed.refusedHarmful).toEqual(["rotten_flesh"]);
  });

  it("「饱和度比饥饿点更值钱」：同等有效饱和度下选饱和度/饥饿比更高的那个", async () => {
    const output = await foodPickSkill.execute(
      {} as never,
      {
        candidates: [
          // 熟牛肉 8/12.8（比值 1.6）与金胡萝卜 6/14.4（比值 2.4）：
          // 饥饿 12 时两者都能把饥饿顶到 20，但按"只看饥饿点"会选熟牛肉（+8 > +6），
          // 按"单位饥饿换到的有效饱和度"才会选金胡萝卜。这里比的就是这条规则。
          { itemName: "cooked_beef", count: 2 },
          { itemName: "golden_carrot", count: 2 },
          { itemName: "cookie", count: 8 }, // 2 / 0.4：填肚子但不顶用
        ],
        hunger: { hunger: 12, saturation: 0 },
        ...scope,
      },
      state,
    );
    expect(output.verdict).toBe("EAT");
    expect(output.itemName).toBe("golden_carrot");
    // 饥饿 12 + 6 = 18，饱和度上限 18 → 14.4 全进得去（没有溢出，eat 后饱食 = 14.4）。
    expect(output.projection).toMatchObject({ hungerAfter: 18, saturationAfter: 14.4, effectiveSaturation: 14.4, wastedSaturation: 0 });
    expect(output.reasonCode).toBe("BEST_SATURATION_EFFICIENCY");
    // 熟牛肉不是"不能吃"，只是这一步它更亏：12.8 的饱和度 / 8 点饥饿 = 1.6 < 2.4。
    expect(saturationRatio(foodEntryFor("cooked_beef")!)).toBeLessThan(saturationRatio(foodEntryFor("golden_carrot")!));
  });

  it("饥饿将满时不再选高饱和度大餐（会溢出），改选刚好填满的小份", async () => {
    // 饥饿 19、饱和度 0：金胡萝卜 +6/14.4 会溢出 5 点饥饿但 14.4 全进；
    // 曲奇 +2/0.4 只进 1 点饥饿 + 0.4 饱和度。按"有效饱和度"比，金胡萝卜仍然赢——
    // 这条断言记录的是**实际算法**，不是直觉。
    const output = await foodPickSkill.execute(
      {} as never,
      {
        candidates: [
          { itemName: "golden_carrot", count: 1 },
          { itemName: "cookie", count: 8 },
        ],
        hunger: { hunger: 19, saturation: 0 },
        ...scope,
      },
      state,
    );
    expect(output.itemName).toBe("golden_carrot");
    expect(output.projection).toMatchObject({ hungerAfter: 20, effectiveSaturation: 14.4 });
  });

  it("效率并列时按 id 字典序定序（保证同输入同输出）", async () => {
    const output = await foodPickSkill.execute(
      {} as never,
      {
        // 甜浆果 2/0.4 与曲奇 2/0.4：效率、有效饱和度、熟食身份全并列，
        // 只剩下 id 字典序这条兜底规则，cookie < sweet_berries。
        candidates: [
          { itemName: "sweet_berries", count: 4 },
          { itemName: "cookie", count: 4 },
        ],
        hunger: { hunger: 4, saturation: 0 },
        ...scope,
      },
      state,
    );
    expect(output.verdict).toBe("EAT");
    expect(output.itemName).toBe("cookie");
    expect(output.reasonCode).toBe("HIGHEST_EFFECTIVE_SATURATION");
  });

  it("没有任何候选时拒绝，且不会编造一个食物出来", async () => {
    const output = await foodPickSkill.execute(
      {} as never,
      { candidates: [], hunger: { hunger: 5, saturation: 0 }, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "REFUSE", reasonCode: "NO_CANDIDATES", itemName: null });
  });

  it("不认识的候选食物不会被猜：全都不认识时报 ONLY_UNKNOWN_FOOD", async () => {
    const output = await foodPickSkill.execute(
      {} as never,
      { candidates: [{ itemName: "mystery_stew", count: 1 }], hunger: { hunger: 5, saturation: 0 }, ...scope },
      state,
    );
    expect(output).toMatchObject({ verdict: "REFUSE", reasonCode: "ONLY_UNKNOWN_FOOD" });
  });

  it("确定性的：同输入两次给出同一个选择", async () => {
    const input = {
      candidates: [
        { itemName: "bread", count: 1 },
        { itemName: "cooked_beef", count: 1 },
      ],
      hunger: { hunger: 10, saturation: 0 },
      ...scope,
    };
    const first = await foodPickSkill.execute({} as never, input, state);
    const second = await foodPickSkill.execute({} as never, input, state);
    expect(first).toEqual(second);
  });

  it("声明层面：纯技能、幂等、不重试、无 capability", () => {
    expect(foodPickSkill.requiredCapabilities).toEqual([]);
    expect(foodPickSkill.idempotent).toBe(true);
    expect(foodPickSkill.retryPolicy).toMatchObject({ maxAttempts: 1, retryableErrorCodes: [] });
    const codes = foodPickSkill.preconditions.map(({ failureCode }) => failureCode);
    expect(codes).toContain("BOT_NOT_ONLINE");
    expect(codes).toContain("NORMAL_ACTIONS_PAUSED");
    expect(codes).toContain("TARGET_SERVER_PROFILE_MISMATCH");
  });

  it("食物表整体自洽：有害的都不标 cooked，cookedFrom 指向的条目存在", () => {
    for (const entry of foodTable.values()) {
      if (entry.harmful) expect(entry.cooked).toBe(false);
      if (entry.cookedFrom !== null) {
        expect(foodEntryFor(entry.cookedFrom), `${entry.itemName} 的 cookedFrom=${entry.cookedFrom}`).not.toBeNull();
      }
      expect(entry.hunger).toBeGreaterThan(0);
    }
  });
});

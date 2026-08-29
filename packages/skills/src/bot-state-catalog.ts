// ---------------------------------------------------------------------------
// BotStateCatalog —— 跨层共享的 Bot 状态语义目录。
//
// P0 审计发现的食物名册/工具等级/护甲槽位在 coordinator、runtime、skills
// 三处各自维护，导致跨层 contract 断裂（腐肉算不算储备、木镐+铁镐谁是
// 当前档、armorPoints=6 是不是穿了胸甲——三个层有三种答案）。
//
// 本文件是唯一事实来源：coordinator 的 survival-needs / autonomous-director、
// runtime 的 L0 安全层、skills 的 ensure/resource 查询全部从这里读。
// ---------------------------------------------------------------------------

/** 无副作用常规食物（长期安全储备——food.secure 目标物）。 */
export const SAFE_FOOD_ITEMS: ReadonlySet<string> = new Set([
  "bread",
  "apple",
  "cooked_beef",
  "cooked_porkchop",
  "cooked_chicken",
  "cooked_mutton",
  "cooked_rabbit",
  "cooked_cod",
  "cooked_salmon",
  "baked_potato",
  "beetroot",
  "carrot",
  "melon_slice",
  "sweet_berries",
]);

/**
 * 应急口粮（只在 L0 饥饿反射层吃，不算安全储备）。
 * 腐肉有 Hunger debuff（掉饱食度不掉血）——饿死面前值得吃，但不该
 * 作为 food.secure 的目标物，更不该在饱腹时算储备。
 */
export const EMERGENCY_FOOD_ITEMS: ReadonlySet<string> = new Set([
  "rotten_flesh",
  "beef", // Minecraft 生牛肉的 registry 名就是 "beef"，不是 "raw_beef"
  "porkchop",
  "chicken",
  "mutton",
  "rabbit",
  "cod",
  "salmon",
  "dried_kelp",
]);

/** 全部可吃物品 = 安全储备 + 应急。 */
export const ALL_EDIBLE_ITEMS: ReadonlySet<string> = new Set([
  ...SAFE_FOOD_ITEMS,
  ...EMERGENCY_FOOD_ITEMS,
]);

// ---------------------------------------------------------------------------
// 工具等级——唯一定义。
// ---------------------------------------------------------------------------

export const TOOL_TIERS = ["none", "wooden", "stone", "iron", "diamond"] as const;
export type ToolTier = (typeof TOOL_TIERS)[number];

export function toolTierRank(tier: ToolTier): number {
  return TOOL_TIERS.indexOf(tier);
}

/** 每档对应的镐。 */
export const PICKAXE_BY_TIER: Readonly<Record<Exclude<ToolTier, "none">, string>> = Object.freeze({
  wooden: "wooden_pickaxe",
  stone: "stone_pickaxe",
  iron: "iron_pickaxe",
  diamond: "diamond_pickaxe",
});

/** 物品名 → 它提供的工具档（反向查表）。 */
export const TOOL_TIER_BY_PICKAXE: Readonly<Record<string, ToolTier>> = Object.freeze({
  wooden_pickaxe: "wooden",
  stone_pickaxe: "stone",
  iron_pickaxe: "iron",
  diamond_pickaxe: "diamond",
});

/**
 * 从库存列表中取最高可用镐档。
 * P0-A1 修复的核心：从最高档往下找，不是 findIndex 从最低档往上。
 */
export function highestPickaxeTier(
  inventory: ReadonlyMap<string, number>,
): { tier: ToolTier; pickaxe: string | null } {
  for (let i = TOOL_TIERS.length - 1; i >= 1; i -= 1) {
    const tier = TOOL_TIERS[i]!;
    const pickaxe = PICKAXE_BY_TIER[tier as Exclude<ToolTier, "none">];
    if ((inventory.get(pickaxe) ?? 0) > 0) {
      return { tier, pickaxe };
    }
  }
  return { tier: "none", pickaxe: null };
}

// ---------------------------------------------------------------------------
// 护甲槽位——唯一映射。
// ---------------------------------------------------------------------------

export const BOT_ARMOR_SLOTS = ["head", "chest", "legs", "feet"] as const;
export type BotArmorSlot = (typeof BOT_ARMOR_SLOTS)[number];

/** 每槽对应的铁甲件名。 */
export const IRON_ARMOR_BY_SLOT: Readonly<Record<BotArmorSlot, string>> = Object.freeze({
  head: "iron_helmet",
  chest: "iron_chestplate",
  legs: "iron_leggings",
  feet: "iron_boots",
});

/** 每槽对应的钻石甲件名。 */
export const DIAMOND_ARMOR_BY_SLOT: Readonly<Record<BotArmorSlot, string>> = Object.freeze({
  head: "diamond_helmet",
  chest: "diamond_chestplate",
  legs: "diamond_leggings",
  feet: "diamond_boots",
});

/** 护甲件名 → 所在槽。 */
export const ARMOR_SLOT_BY_ITEM: Readonly<Record<string, BotArmorSlot>> = Object.freeze({
  iron_helmet: "head", diamond_helmet: "head",
  leather_helmet: "head", golden_helmet: "head", chainmail_helmet: "head",
  iron_chestplate: "chest", diamond_chestplate: "chest",
  leather_chestplate: "chest", golden_chestplate: "chest", chainmail_chestplate: "chest",
  iron_leggings: "legs", diamond_leggings: "legs",
  leather_leggings: "legs", golden_leggings: "legs", chainmail_leggings: "legs",
  iron_boots: "feet", diamond_boots: "feet",
  leather_boots: "feet", golden_boots: "feet", chainmail_boots: "feet",
});

/**
 * 逐槽判断护甲状态（"已装备 + 背包"双来源）。
 * 返回每槽是否满足（有装备或有库存）以及缺失件名。
 */
export function assessBotArmorSlots(input: Readonly<{
  equipped: Readonly<Record<BotArmorSlot, string | null>>;
  inventory: ReadonlyMap<string, number>;
}>): ReadonlyArray<Readonly<{ slot: BotArmorSlot; satisfied: boolean; equipped: string | null; carried: boolean; ironMissing: string | null }>> {
  return BOT_ARMOR_SLOTS.map((slot) => {
    const equipped = input.equipped[slot] ?? null;
    const ironItem = IRON_ARMOR_BY_SLOT[slot];
    const carried = (input.inventory.get(ironItem) ?? 0) > 0;
    const satisfied = equipped !== null || carried;
    return {
      slot,
      satisfied,
      equipped,
      carried,
      ironMissing: satisfied ? null : ironItem,
    };
  });
}

// ---------------------------------------------------------------------------
// 木材族——数据驱动，不再硬编码 oak。
// ---------------------------------------------------------------------------

export const WOOD_LOG_ITEMS = [
  "oak_log",
  "birch_log",
  "spruce_log",
  "jungle_log",
  "acacia_log",
  "dark_oak_log",
  "mangrove_log",
  "cherry_log",
] as const;

export type WoodLogItem = (typeof WOOD_LOG_ITEMS)[number];

/** log → 对应 planks。 */
export const PLANKS_BY_LOG: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    WOOD_LOG_ITEMS.map((log) => [log, log.replace("_log", "_planks")]),
  ),
);

/** planks → 对应 log（反向）。 */
export const LOG_BY_PLANKS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    WOOD_LOG_ITEMS.map((log) => [log.replace("_log", "_planks"), log]),
  ),
);

/**
 * 计算总木材单位（log=1, planks=1/4），跨全部木种。
 */
export function totalWoodUnits(inventory: ReadonlyMap<string, number>): number {
  let total = 0;
  for (const log of WOOD_LOG_ITEMS) {
    total += inventory.get(log) ?? 0;
    total += Math.floor((inventory.get(PLANKS_BY_LOG[log]!) ?? 0) / 4);
  }
  return total;
}

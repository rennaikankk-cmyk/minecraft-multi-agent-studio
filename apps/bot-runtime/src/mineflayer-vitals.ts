/**
 * 生命/护甲/耐久读数与护甲常量表（从 mineflayer-client.ts 拆出，2026-09-10 结构拆分批次 5）。
 */
import type { Bot } from "mineflayer";

export const ARMOR_POINTS: Readonly<Record<string, number>> = {
  leather_helmet: 1,
  leather_chestplate: 3,
  leather_leggings: 2,
  leather_boots: 1,
  golden_helmet: 2,
  golden_chestplate: 5,
  golden_leggings: 3,
  golden_boots: 1,
  chainmail_helmet: 2,
  chainmail_chestplate: 5,
  chainmail_leggings: 4,
  chainmail_boots: 1,
  iron_helmet: 2,
  iron_chestplate: 6,
  iron_leggings: 5,
  iron_boots: 2,
  diamond_helmet: 3,
  diamond_chestplate: 8,
  diamond_leggings: 6,
  diamond_boots: 3,
  netherite_helmet: 3,
  netherite_chestplate: 8,
  netherite_leggings: 6,
  netherite_boots: 3,
  turtle_helmet: 2,
};

/**
 * container.transfer 允许打开的容器方块。刻意不含漏斗/发射器等红石敏感容器，
 * 也不含潜影盒以外任何"打开会改变世界状态"的方块。
 */

export const ARMOR_SLOT_DESTINATIONS = [
  { slot: "head", destination: "head" },
  { slot: "torso", destination: "torso" },
  { slot: "legs", destination: "legs" },
  { slot: "feet", destination: "feet" },
] as const satisfies ReadonlyArray<{
  slot: "head" | "torso" | "legs" | "feet";
  destination: "head" | "torso" | "legs" | "feet";
}>;

/**
 * Map each known armor item to the slot it belongs in, derived from the item
 * name suffix. Only names present in ARMOR_POINTS are accepted, so the write
 * primitive can never be tricked into equipping a non-armor item.
 */
export const ARMOR_ITEM_SLOT: Readonly<Record<string, "head" | "torso" | "legs" | "feet">> =
  Object.fromEntries(
    Object.keys(ARMOR_POINTS).map((name) => {
      if (name.endsWith("_helmet") || name === "turtle_helmet") {
        return [name, "head"] as const;
      }
      if (name.endsWith("_chestplate")) return [name, "torso"] as const;
      if (name.endsWith("_leggings")) return [name, "legs"] as const;
      return [name, "feet"] as const;
    }),
  );

// P0-A5: 统一从 bot-state-catalog 消费（与 coordinator 的 survival-needs 同源）。

export function readMaximumHealth(bot: Bot): number | null {
  const entity = bot.entity as typeof bot.entity & {
    attributes?: Record<string, { value?: number }>;
  };
  const attributes = entity.attributes ?? {};
  const entry = Object.entries(attributes).find(([name]) =>
    name.endsWith("max_health"),
  )?.[1];
  const value = entry?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : null;
}

/**
 * 工具耐久读数（剩余值）。与 worldStateSnapshot 同一语义：mineflayer 的
 * Item 携带 maxDurability 与 durabilityUsed（已损耗），剩余 = max − used。
 * 非耐久物品返回 null。
 */
export function toolDurability(item: {
  maxDurability?: number;
  durabilityUsed?: number;
}): { durability: number; maxDurability: number } | null {
  const maxDurability = item.maxDurability;
  if (
    typeof maxDurability !== "number" ||
    !Number.isFinite(maxDurability) ||
    maxDurability <= 0
  ) {
    return null;
  }
  const used = item.durabilityUsed;
  const durability =
    typeof used === "number" && Number.isFinite(used) && used > 0
      ? Math.max(0, Math.round(maxDurability - used))
      : Math.round(maxDurability);
  return { durability, maxDurability: Math.round(maxDurability) };
}

export function readArmorSlots(bot: Bot): { head: string | null; chest: string | null; legs: string | null; feet: string | null } {
  try {
    const destinations = { head: "head", chest: "torso", legs: "legs", feet: "feet" } as const;
    const result: Record<string, string | null> = {};
    for (const [slot, destination] of Object.entries(destinations)) {
      const slotIndex = bot.getEquipmentDestSlot(destination);
      const item = bot.inventory.slots[slotIndex];
      result[slot] = item?.name ?? null;
    }
    return result as { head: string | null; chest: string | null; legs: string | null; feet: string | null };
  } catch {
    return { head: null, chest: null, legs: null, feet: null };
  }
}

export function readArmorPoints(bot: Bot): number | null {
  try {
    const destinations = ["head", "torso", "legs", "feet"] as const;
    return destinations.reduce((total, destination) => {
      const slot = bot.getEquipmentDestSlot(destination);
      const item = bot.inventory.slots[slot];
      return total + (item?.name ? (ARMOR_POINTS[item.name] ?? 0) : 0);
    }, 0);
  } catch {
    return null;
  }
}

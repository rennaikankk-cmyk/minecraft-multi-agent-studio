import { z } from "zod";

// ---------------------------------------------------------------------------
// 背包容量的**唯一**判定入口。
//
// runtime 早就在观测 `safety.inventory = { usedSlots, totalSlots }`（见
// bot-runtime/src/client.ts），但 `skillState()` 没往下传，于是所有"往背包里
// 加东西"的技能都不知道背包满没满：
//   - `collect.block` 背包满时照样跑满 60 秒超时，挖出来的东西掉在地上没人捡，
//     技能却报成功——这是**静默丢件**，比直接拒绝坏得多。
//   - `container.transfer` 取出方向同理：movedCount 会比请求量少，但要等到
//     操作完才知道。
//
// 所以容量怎么算放这里，判定"够不够"也放这里。与 reach.ts 一个思路：先集中，
// 再让每个技能只声明"我要往背包里加多少"。
//
// **fail-closed**：观测不到背包（position 为 null 的同一类情形）一律按"没位置"
// 处理，不按"大概还有空"放行。这与 capability `unknown` 的既有纪律一致——
// 不从缺失数据推出有利结论。
// ---------------------------------------------------------------------------

/** 观测到的背包占用。`usedSlots > totalSlots` 是坏数据，schema 层不拦，判定层按满处理。 */
export const observedInventorySchema = z
  .object({
    usedSlots: z.number().int().min(0).max(1_024),
    totalSlots: z.number().int().min(0).max(1_024),
  })
  .strict();

export type ObservedInventory = z.infer<typeof observedInventorySchema>;

/** 剩余空槽位。观测不到时返回 0（fail-closed），不返回 null 让调用方再判一次。 */
export function freeInventorySlots(
  inventory: ObservedInventory | null,
): number {
  if (inventory === null) return 0;
  return Math.max(0, inventory.totalSlots - inventory.usedSlots);
}

/**
 * 背包是否还能接住 `incomingSlots` 个槽位的新物品。
 *
 * 用槽位而不是件数：一次采集拿回 4 组不同方块占 4 个槽，拿回 64 个同种方块可能
 * 只占 1 个槽。技能层没法精确知道掉落映射（`collect.block` 的注释已经写明圆石
 * 问题），所以这里要的是调用方给出的**保守槽位数**，不是件数换算。
 *
 * `incomingSlots` 为 0 时永远放行——纯消耗型操作（存箱子、合成消耗）不占新槽。
 */
export function inventoryHasRoomFor(
  inventory: ObservedInventory | null,
  incomingSlots: number,
): boolean {
  if (!Number.isInteger(incomingSlots) || incomingSlots < 0) {
    throw new TypeError("incomingSlots 必须是非负整数。");
  }
  if (incomingSlots === 0) return true;
  return freeInventorySlots(inventory) >= incomingSlots;
}

/**
 * 一次采集/取货至少要预留几个槽位。
 *
 * 取 1 是刻意的下界而不是估算：只要还有一个空槽，动作就有意义（能装下第一组，
 * 之后由 movedCount / itemsCollected 如实上报实际结果）。把它写成"按件数除以
 * 64 向上取整"会假装知道堆叠上限与掉落映射，那是**编造精度**。
 */
export const MINIMUM_INCOMING_SLOTS = 1;

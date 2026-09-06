import type { Bot } from "mineflayer";
import { SkillFault } from "@minecraft-studio/skills";

/** Called while holding the barrel lease and inventory lock. Both sides must agree. */
export async function balanceFarmStorage(bot: Bot, window: Awaited<ReturnType<Bot["openContainer"]>>, retain: number, assertActive: () => Promise<void>) {
  const item = bot.registry.itemsByName.carrot;
  if (!item) throw new SkillFault("ITEM_NAME_UNKNOWN");
  const inBag = () => window.items().filter((i) => i.name === "carrot").reduce((n, i) => n + i.count, 0);
  const inStore = () => window.containerItems().filter((i) => i.name === "carrot").reduce((n, i) => n + i.count, 0);
  const before = inStore(), bagBefore = inBag();
  const excess = bagBefore - retain;
  const capacity = window.slots.slice(0, window.inventoryStart).reduce((n, i) => n + (!i ? 64 : i.name === "carrot" ? Math.max(0, 64 - i.count) : 0), 0);
  const count = excess > 0 ? Math.min(excess, capacity) : Math.min(-excess, before);
  await assertActive();
  if (count > 0) {
    try {
      if (excess > 0) await window.deposit(item.id, null, count);
      else await window.withdraw(item.id, null, count);
    } catch {
      await assertActive();
      throw new SkillFault("CONTAINER_TRANSFER_FAILED");
    }
  }
  await assertActive();
  const after = inStore(), bagAfter = inBag();
  const delta = after - before;
  if (delta !== bagBefore - bagAfter || delta !== (excess > 0 ? count : -count)) throw new SkillFault("FARM_STORAGE_READBACK_MISMATCH");
  return { before, after, deposited: Math.max(0, delta), withdrawn: Math.max(0, -delta), full: excess > capacity };
}

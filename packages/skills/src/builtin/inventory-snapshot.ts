import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 背包快照能力契约（inventory.read / inventory.snapshot）。
// 原先寄生在 ensure-item.ts（已删除的复合技能死代码）里，但 mineflayer-client
// 的 inventory.snapshot 操作一直真实使用——按归属拆到独立模块。
// ---------------------------------------------------------------------------

export const INVENTORY_SNAPSHOT_MAX_ITEM_TYPES = 128;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

export const inventorySnapshotCapabilityInputSchema = z
  .object({
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    maxItemTypes: z
      .number()
      .int()
      .min(1)
      .max(INVENTORY_SNAPSHOT_MAX_ITEM_TYPES),
  })
  .strict();

const inventorySnapshotItemSchema = z
  .object({
    itemName: itemNameSchema,
    count: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

export const inventorySnapshotCapabilityOutputSchema = z
  .object({
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    worldStateVersion: z.number().int().nonnegative(),
    items: z
      .array(inventorySnapshotItemSchema)
      .max(INVENTORY_SNAPSHOT_MAX_ITEM_TYPES)
      .refine(
        (items) =>
          new Set(items.map(({ itemName }) => itemName)).size === items.length,
        { message: "Inventory snapshot item names must be unique." },
      ),
  })
  .strict();

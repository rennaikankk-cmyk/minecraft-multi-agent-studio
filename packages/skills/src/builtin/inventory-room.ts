import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { freeInventorySlots, observedInventorySchema } from "./inventory-space.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// inventory.room —— "这次任务还塞得下吗"（纯函数技能）。
//
// 与 builtin/inventory-space.ts 的关系：那边是**容量算术的唯一入口**
// （freeInventorySlots），这边只是把算术包成一个可编排的技能：给出任务需要的
// 槽位数，回答"要不要先腾地方、腾几个"。
//
// 为什么单位是**槽位**不是件数：一次采集可能拿回 4 组不同方块（4 槽），
// 也可能拿回 64 个同种方块（1 槽）。技能层不知道掉落映射，按件数换算就是
// 编造精度（inventory-space.ts 已经写明这条纪律）。
//
// fail-closed：观测不到背包（state.inventory 为 null）时按"必须腾出全部所需槽位"
// 回答，并且明确标注 INTERINVENTORY_SNAPSHOT_UNAVAILABLE——不从缺失数据推出
// "大概还有空"这种有利结论。
// ---------------------------------------------------------------------------

export const INVENTORY_ROOM_TIMEOUT_MS = 2_000;
/** 单次任务需要的槽位上限：整背包是 36 槽 + 副手/护甲，取 64 已是宽松上界。 */
export const INVENTORY_ROOM_MAX_SLOTS = 64;

export const inventoryRoomInputSchema = z
  .object({
    /** 任务预计需要占用的**空槽位**数。 */
    slotsNeeded: z.number().int().min(0).max(INVENTORY_ROOM_MAX_SLOTS),
    serverProfileId: identifierSchema,
  })
  .strict();
export type InventoryRoomInput = z.infer<typeof inventoryRoomInputSchema>;

export const inventoryRoomOutputSchema = z
  .object({
    verdict: z.enum(["ROOM_AVAILABLE", "MUST_FREE_SLOTS", "INVENTORY_UNKNOWN"]),
    code: z.enum([
      "ROOM_AVAILABLE",
      "MUST_FREE_SLOTS",
      "INVENTORY_SNAPSHOT_UNAVAILABLE",
      "NO_SLOTS_REQUIRED",
    ]),
    slotsNeeded: z.number().int().min(0).max(INVENTORY_ROOM_MAX_SLOTS),
    usedSlots: z.number().int().min(0).max(1_024).nullable(),
    totalSlots: z.number().int().min(0).max(1_024).nullable(),
    freeSlots: z.number().int().min(0).max(1_024),
    /** 需要腾出的槽位数；够用时为 0。 */
    slotsToFree: z.number().int().min(0).max(1_024),
    /** 观测缺失时为 true：调用方据此决定"先重新观测"而不是"直接丢东西"。 */
    snapshotMissing: z.boolean(),
    rationale: z.string().min(1).max(512),
  })
  .strict();
export type InventoryRoomOutput = z.infer<typeof inventoryRoomOutputSchema>;

export const inventoryRoomStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    /** 运行时快照：只有占用/总量两个数字，没有物品级背包。 */
    inventory: observedInventorySchema.nullable(),
  })
  .strip();
export type InventoryRoomState = z.infer<typeof inventoryRoomStateSchema>;

export const inventoryRoomSkill = defineSkill({
  id: "inventory.room",
  version: "1.0.0",
  progressContract: "INVENTORY_CHANGE",
  inputSchema: inventoryRoomInputSchema,
  outputSchema: inventoryRoomOutputSchema,
  stateSchema: inventoryRoomStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  // 纯算术：不丢东西、不搬东西（丢/搬分别是 inventory.drop / container.transfer）。
  requiredCapabilities: [] as const,
  timeoutMs: INVENTORY_ROOM_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input, state) => state.normalActionsAllowed,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
  ],
  execute: async (_context, input, state) => {
    if (input.slotsNeeded === 0) {
      return inventoryRoomOutputSchema.parse({
        verdict: "ROOM_AVAILABLE",
        code: "NO_SLOTS_REQUIRED",
        slotsNeeded: 0,
        usedSlots: state.inventory?.usedSlots ?? null,
        totalSlots: state.inventory?.totalSlots ?? null,
        freeSlots: freeInventorySlots(state.inventory),
        slotsToFree: 0,
        snapshotMissing: state.inventory === null,
        rationale: "本次任务不占用新的背包槽位（纯消耗型操作），无需腾地方。",
      });
    }
    if (state.inventory === null) {
      return inventoryRoomOutputSchema.parse({
        verdict: "INVENTORY_UNKNOWN",
        code: "INVENTORY_SNAPSHOT_UNAVAILABLE",
        slotsNeeded: input.slotsNeeded,
        usedSlots: null,
        totalSlots: null,
        freeSlots: 0,
        slotsToFree: input.slotsNeeded,
        snapshotMissing: true,
        rationale: `观测不到背包占用：按 fail-closed 处理，先重新观测（或按"需要腾出全部 ${input.slotsNeeded} 个槽位"准备），不假设还有空位。`,
      });
    }
    const freeSlots = freeInventorySlots(state.inventory);
    const slotsToFree = Math.max(0, input.slotsNeeded - freeSlots);
    return inventoryRoomOutputSchema.parse({
      verdict: slotsToFree === 0 ? "ROOM_AVAILABLE" : "MUST_FREE_SLOTS",
      code: slotsToFree === 0 ? "ROOM_AVAILABLE" : "MUST_FREE_SLOTS",
      slotsNeeded: input.slotsNeeded,
      usedSlots: state.inventory.usedSlots,
      totalSlots: state.inventory.totalSlots,
      freeSlots,
      slotsToFree,
      snapshotMissing: false,
      rationale:
        slotsToFree === 0
          ? `需要 ${input.slotsNeeded} 槽，现有空位 ${freeSlots} 槽（${state.inventory.usedSlots}/${state.inventory.totalSlots} 已占用），够用。`
          : `需要 ${input.slotsNeeded} 槽，现有空位只有 ${freeSlots} 槽（${state.inventory.usedSlots}/${state.inventory.totalSlots} 已占用），需先腾出 ${slotsToFree} 槽。`,
    });
  },
});

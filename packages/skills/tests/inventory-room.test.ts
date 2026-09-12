import { describe, expect, it } from "vitest";

import { freeInventorySlots, inventoryHasRoomFor } from "../src/builtin/inventory-space.js";
import { inventoryRoomSkill } from "../src/builtin/inventory-room.js";

// ---------------------------------------------------------------------------
// inventory.room 的算术在**边界**上必须精确：正好够 vs 差一个。
// 运行时只给 { usedSlots, totalSlots }，所以这里只做槽位算术，不猜件数。
// ---------------------------------------------------------------------------

const scope = { serverProfileId: "isolated-local" };

function stateWith(inventory: { usedSlots: number; totalSlots: number } | null) {
  return { online: true, normalActionsAllowed: true, serverProfileId: "isolated-local", inventory };
}

describe("inventory.room — 槽位算术", () => {
  it("恰好够：需要 3 槽、空位正好 3 → ROOM_AVAILABLE，slotsToFree = 0", async () => {
    const output = await inventoryRoomSkill.execute(
      {} as never,
      { slotsNeeded: 3, ...scope },
      stateWith({ usedSlots: 33, totalSlots: 36 }),
    );
    expect(output).toMatchObject({ verdict: "ROOM_AVAILABLE", code: "ROOM_AVAILABLE", freeSlots: 3, slotsToFree: 0, snapshotMissing: false });
  });

  it("差一个：需要 4 槽、空位只有 3 → MUST_FREE_SLOTS，slotsToFree = 1", async () => {
    const output = await inventoryRoomSkill.execute(
      {} as never,
      { slotsNeeded: 4, ...scope },
      stateWith({ usedSlots: 33, totalSlots: 36 }),
    );
    expect(output).toMatchObject({ verdict: "MUST_FREE_SLOTS", code: "MUST_FREE_SLOTS", freeSlots: 3, slotsToFree: 1 });
    expect(output.rationale).toContain("腾出 1 槽");
  });

  it("背包全满：需要 1 槽、空位 0 → 必须腾 1 槽", async () => {
    const output = await inventoryRoomSkill.execute(
      {} as never,
      { slotsNeeded: 1, ...scope },
      stateWith({ usedSlots: 36, totalSlots: 36 }),
    );
    expect(output).toMatchObject({ verdict: "MUST_FREE_SLOTS", freeSlots: 0, slotsToFree: 1 });
  });

  it("需要 0 槽（纯消耗型操作）永远放行，且不算腾地方", async () => {
    const output = await inventoryRoomSkill.execute(
      {} as never,
      { slotsNeeded: 0, ...scope },
      stateWith({ usedSlots: 36, totalSlots: 36 }),
    );
    expect(output).toMatchObject({ verdict: "ROOM_AVAILABLE", code: "NO_SLOTS_REQUIRED", slotsToFree: 0 });
  });

  it("观测不到背包 → INVENTORY_UNKNOWN（fail-closed），按「要腾出全部所需槽位」回答", async () => {
    const output = await inventoryRoomSkill.execute(
      {} as never,
      { slotsNeeded: 2, ...scope },
      stateWith(null),
    );
    expect(output).toMatchObject({
      verdict: "INVENTORY_UNKNOWN",
      code: "INVENTORY_SNAPSHOT_UNAVAILABLE",
      snapshotMissing: true,
      usedSlots: null,
      totalSlots: null,
      slotsToFree: 2,
    });
  });

  it("坏数据（used > total）按满处理，不出现负空位", async () => {
    const output = await inventoryRoomSkill.execute(
      {} as never,
      { slotsNeeded: 1, ...scope },
      stateWith({ usedSlots: 40, totalSlots: 36 }),
    );
    expect(output.freeSlots).toBe(0);
    expect(output.slotsToFree).toBe(1);
  });

  it("与 builtin/inventory-space 的算术完全一致（同一条规则只有一份实现）", async () => {
    for (const inventory of [null, { usedSlots: 0, totalSlots: 36 }, { usedSlots: 36, totalSlots: 36 }, { usedSlots: 40, totalSlots: 36 }]) {
      for (const slotsNeeded of [0, 1, 3, 36, 64]) {
        const output = await inventoryRoomSkill.execute({} as never, { slotsNeeded, ...scope }, stateWith(inventory));
        expect(output.freeSlots, `freeSlots @${JSON.stringify(inventory)}`).toBe(freeInventorySlots(inventory));
        if (slotsNeeded === 0 || inventory === null) continue;
        const room = inventoryHasRoomFor(inventory, slotsNeeded);
        expect(output.verdict === "ROOM_AVAILABLE", `room @${JSON.stringify(inventory)} need ${slotsNeeded}`).toBe(room);
      }
    }
  });

  it("确定性的：同输入两次给出同样的裁决", async () => {
    const snapshot = stateWith({ usedSlots: 30, totalSlots: 36 });
    const input = { slotsNeeded: 7, ...scope };
    const first = await inventoryRoomSkill.execute({} as never, input, snapshot);
    const second = await inventoryRoomSkill.execute({} as never, input, snapshot);
    expect(first).toEqual(second);
  });

  it("声明层面：纯技能、幂等、不重试、无 capability、INVENTORY_CHANGE 进度契约", () => {
    expect(inventoryRoomSkill.requiredCapabilities).toEqual([]);
    expect(inventoryRoomSkill.idempotent).toBe(true);
    expect(inventoryRoomSkill.retryPolicy).toMatchObject({ maxAttempts: 1, retryableErrorCodes: [] });
    expect(inventoryRoomSkill.progressContract).toBe("INVENTORY_CHANGE");
    const codes = inventoryRoomSkill.preconditions.map(({ failureCode }) => failureCode);
    expect(codes).toContain("BOT_NOT_ONLINE");
    expect(codes).toContain("NORMAL_ACTIONS_PAUSED");
    expect(codes).toContain("TARGET_SERVER_PROFILE_MISMATCH");
  });

  it("超过槽位上限的请求在 schema 层就被拒（不静默截断）", async () => {
    await expect(
      inventoryRoomSkill.execute({} as never, { slotsNeeded: 65, ...scope }, stateWith({ usedSlots: 0, totalSlots: 36 })),
    ).rejects.toBeTruthy();
  });
});

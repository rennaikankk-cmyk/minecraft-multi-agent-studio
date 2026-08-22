import { describe, expect, it } from "vitest";

import {
  MINIMUM_INCOMING_SLOTS,
  freeInventorySlots,
  inventoryHasRoomFor,
  observedInventorySchema,
} from "../src/builtin/inventory-space.js";

describe("freeInventorySlots", () => {
  it("reports the remaining slots", () => {
    expect(freeInventorySlots({ usedSlots: 30, totalSlots: 36 })).toBe(6);
    expect(freeInventorySlots({ usedSlots: 36, totalSlots: 36 })).toBe(0);
  });

  it("reports zero room when the inventory was never observed", () => {
    // fail-closed：看不见背包按"没位置"算，不返回 null 让每个调用方再判一次。
    expect(freeInventorySlots(null)).toBe(0);
  });

  it("never reports negative room even if the counts are inconsistent", () => {
    // 服务端偶发的越界计数不该变成"负空间"，那会让下游的比较全部反过来。
    expect(freeInventorySlots({ usedSlots: 40, totalSlots: 36 })).toBe(0);
  });
});

describe("inventoryHasRoomFor", () => {
  it("allows a collect when there is room", () => {
    expect(
      inventoryHasRoomFor({ usedSlots: 4, totalSlots: 36 }, MINIMUM_INCOMING_SLOTS),
    ).toBe(true);
  });

  it("refuses a collect when the backpack is full", () => {
    expect(
      inventoryHasRoomFor({ usedSlots: 36, totalSlots: 36 }, MINIMUM_INCOMING_SLOTS),
    ).toBe(false);
  });

  it("fails closed when the inventory was never observed", () => {
    // 看不见背包不等于背包是空的 —— 与 capability unknown 的处理一致。
    expect(inventoryHasRoomFor(null, MINIMUM_INCOMING_SLOTS)).toBe(false);
  });

  it("always allows an action that needs no incoming slot", () => {
    // 存货方向即便背包满了也必须放行，否则唯一的自救路径也被堵死。
    expect(inventoryHasRoomFor({ usedSlots: 36, totalSlots: 36 }, 0)).toBe(true);
    // 未观测也放行：不占新槽的动作压根不依赖背包空间，这里 fail-closed 会把
    // "背包满了去存箱子"连同观测抖动一起拦死。
    expect(inventoryHasRoomFor(null, 0)).toBe(true);
  });

  it("requires strictly enough slots at the boundary", () => {
    expect(inventoryHasRoomFor({ usedSlots: 35, totalSlots: 36 }, 1)).toBe(true);
    expect(inventoryHasRoomFor({ usedSlots: 35, totalSlots: 36 }, 2)).toBe(false);
  });

  it("rejects a negative requirement instead of treating it as room", () => {
    expect(() =>
      inventoryHasRoomFor({ usedSlots: 0, totalSlots: 36 }, -1),
    ).toThrowError(TypeError);
  });
});

describe("observedInventorySchema", () => {
  it("accepts a well-formed observation", () => {
    expect(
      observedInventorySchema.parse({ usedSlots: 4, totalSlots: 36 }),
    ).toEqual({ usedSlots: 4, totalSlots: 36 });
  });

  it("rejects fractional or negative slot counts", () => {
    expect(
      observedInventorySchema.safeParse({ usedSlots: 1.5, totalSlots: 36 }).success,
    ).toBe(false);
    expect(
      observedInventorySchema.safeParse({ usedSlots: -1, totalSlots: 36 }).success,
    ).toBe(false);
    expect(
      observedInventorySchema.safeParse({ usedSlots: 0, totalSlots: 1_025 }).success,
    ).toBe(false);
    expect(
      observedInventorySchema.safeParse({
        usedSlots: 0,
        totalSlots: 36,
        extra: 1,
      }).success,
    ).toBe(false);
  });
});

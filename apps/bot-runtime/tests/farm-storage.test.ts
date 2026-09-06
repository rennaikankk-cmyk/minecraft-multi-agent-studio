import { describe, expect, it, vi } from "vitest";
import type { Bot } from "mineflayer";
import { balanceFarmStorage } from "../src/farm-storage.js";

function fixture(bag: number, stored: number, freeSlots = 1) {
  const items = (count: number) => count ? [{ name: "carrot", count }] : [];
  const bot = { registry: { itemsByName: { carrot: { id: 7 } } }, inventory: { items: () => items(bag) } } as unknown as Bot;
  const window = { inventoryStart: freeSlots + 1, slots: [...items(stored), ...Array(freeSlots).fill(null)],
    containerItems: () => items(stored),
    items: () => items(bag),
    deposit: vi.fn(async (_id: number, _meta: unknown, n: number) => { bag -= n; stored += n; }),
    withdraw: vi.fn(async (_id: number, _meta: unknown, n: number) => { bag += n; stored -= n; }) };
  const run = (retain: number) => balanceFarmStorage(bot, window as unknown as Awaited<ReturnType<Bot["openContainer"]>>, retain, async () => {});
  return { run, window };
}
describe("farm barrel inventory conservation", () => {
  it("measures both sides of a deposit and refill", async () => {
    const f = fixture(32, 10);
    expect(await f.run(16)).toEqual({ before: 10, after: 26, deposited: 16, withdrawn: 0, full: false });
    expect(await f.run(20)).toEqual({ before: 26, after: 22, deposited: 0, withdrawn: 4, full: false });
  });
  it("keeps overflow in the bag and reports a full barrel", async () => {
    expect(await fixture(32, 64, 0).run(16)).toEqual({ before: 64, after: 64, deposited: 0, withdrawn: 0, full: true });
  });
  it("rejects success without server inventory readback", async () => {
    const f = fixture(32, 10); f.window.deposit.mockImplementation(async () => {});
    await expect(f.run(16)).rejects.toMatchObject({ code: "FARM_STORAGE_READBACK_MISMATCH" });
  });
});

import { describe, expect, it, vi } from "vitest";
import { tradeVillagerInputSchema } from "@minecraft-studio/skills";
import { executeVillagerTrades, type VillagerTradingPort } from "../src/villager-trading.js";

function fixture() {
  const controller = new AbortController();
  const inventory = new Map([["emerald", 12], ["book", 3], ["diamond_helmet", 0]]);
  const offer = { inputItem1: { name: "emerald", count: 4 }, inputItem2: null as { name: string; count: number } | null,
    realPrice: 4, specialPrice: -2, outputItem: { name: "diamond_helmet", count: 1 }, nbTradeUses: 0, maximumNbTradeUses: 12 };
  const window = { trades: [offer] };
  const port: VillagerTradingPort = {
    signal: controller.signal,
    assertActive: async () => { if (controller.signal.aborted) throw new Error("cancelled"); },
    count: (name) => inventory.get(name) ?? 0,
    hasRoom: () => true, open: vi.fn(async () => window), close: vi.fn(),
    trade: vi.fn(async () => {
      inventory.set("emerald", inventory.get("emerald")! - offer.realPrice);
      if (offer.inputItem2) inventory.set("book", inventory.get("book")! - offer.inputItem2.count);
      inventory.set("diamond_helmet", inventory.get("diamond_helmet")! + 1);
      offer.nbTradeUses++;
    }),
  };
  const input = tradeVillagerInputSchema.parse({ villagerEntityId: "17", wantItem: "diamond_helmet", maxUnitPrice: 4,
    maxTrades: 8, serverProfileId: "isolated", dimension: "minecraft:overworld" });
  return { controller, inventory, offer, port, input, window };
}

describe("bounded merchant production", () => {
  it("stops at the affordable quantity and reconciles actual equipment and payments", async () => {
    const f = fixture();
    expect(await executeVillagerTrades(f.port, f.input, "17")).toMatchObject({ completedTrades: 3, receivedCount: 3, spentCount: 12 });
    expect(f.port.trade).toHaveBeenCalledTimes(3);
  });
  it("requires both payment items before the first transaction", async () => {
    const f = fixture(); f.offer.inputItem2 = { name: "book", count: 1 }; f.inventory.set("book", 0);
    await expect(executeVillagerTrades(f.port, f.input, "17")).rejects.toMatchObject({ code: "TRADE_ITEM_NOT_IN_INVENTORY" });
    expect(f.port.trade).not.toHaveBeenCalled();
    expect(f.port.close).toHaveBeenCalledOnce();
  });
  it("rechecks a rising price before sending the next trade", async () => {
    const f = fixture();
    f.port.close = () => { f.offer.realPrice = 8; };
    await expect(executeVillagerTrades(f.port, f.input, "17")).rejects.toMatchObject({ code: "TRADE_PRICE_UNACCEPTABLE" });
    expect(f.port.trade).toHaveBeenCalledOnce();
  });
  it("never reports success from payment loss without receiving equipment", async () => {
    const f = fixture();
    f.port.trade = async () => { f.inventory.set("emerald", 8); };
    await expect(executeVillagerTrades(f.port, f.input, "17")).rejects.toMatchObject({ code: "NON_IDEMPOTENT_RESULT_UNCERTAIN" });
  });
  it("cancels a late merchant open without trading and closes the owned window", async () => {
    const f = fixture();
    f.port.open = async () => { f.controller.abort(); return f.window; };
    await expect(executeVillagerTrades(f.port, f.input, "17")).rejects.toThrow("cancelled");
    expect(f.port.trade).not.toHaveBeenCalled();
    expect(f.port.close).toHaveBeenCalledWith(f.window);
  });
  it("does not initiate another trade after a cancellation during a transaction", async () => {
    const f = fixture();
    f.port.trade = vi.fn(async () => { f.controller.abort(); throw new Error("window closed"); });
    await expect(executeVillagerTrades(f.port, f.input, "17")).rejects.toMatchObject({ code: "NON_IDEMPOTENT_RESULT_UNCERTAIN" });
    expect(f.port.trade).toHaveBeenCalledOnce();
    expect(f.port.close).toHaveBeenCalledOnce();
  });
});

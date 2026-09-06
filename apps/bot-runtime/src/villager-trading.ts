import { z } from "zod";
import { SkillFault, tradeVillagerInputSchema } from "@minecraft-studio/skills";
type TradeVillagerInput = z.infer<typeof tradeVillagerInputSchema>;

const itemSchema = z.object({ name: z.string().regex(/^[a-z0-9_]+$/u), count: z.number().int().positive().max(64) }).strip();
const offerSchema = z.object({
  inputItem1: itemSchema, inputItem2: itemSchema.nullish(), outputItem: itemSchema,
  realPrice: z.number().int().positive().max(64), hasItem2: z.boolean().optional(),
  nbTradeUses: z.number().int().nonnegative(), maximumNbTradeUses: z.number().int().positive(),
  tradeDisabled: z.boolean().optional(),
}).strip();

export interface MerchantWindow { trades: unknown[]; }
export interface VillagerTradingPort {
  assertActive(): Promise<void>;
  open(): Promise<MerchantWindow>;
  close(window: MerchantWindow): void;
  trade(window: MerchantWindow, index: number): Promise<void>;
  count(itemName: string): number;
  hasRoom(itemName: string, count: number): boolean;
  readonly signal: AbortSignal;
}

/** One server trade per iteration, with a fresh offer and inventory reconciliation. */
export async function executeVillagerTrades(port: VillagerTradingPort, input: TradeVillagerInput, entityId: string) {
  let completedTrades = 0, spentCount = 0, receivedCount = 0;
  let window: MerchantWindow | null = null;
  const close = () => { const current = window; window = null; if (current) port.close(current); };
  const onAbort = () => { try { close(); } catch { /* The pending transaction remains uncertain. */ } };
  port.signal.addEventListener("abort", onAbort, { once: true });
  try {
    for (let iteration = 0; iteration < input.maxTrades; iteration++) {
      await port.assertActive();
      window = await port.open();
      await port.assertActive();
      const offers = window.trades.map((raw, index) => ({ parsed: offerSchema.safeParse(raw), index }));
      const matching = offers.filter(({ parsed }) => parsed.success && parsed.data.outputItem.name === input.wantItem);
      if (matching.length === 0) throw new SkillFault("TRADE_OFFER_NOT_FOUND");
      const available = matching.filter(({ parsed }) => parsed.success && !parsed.data.tradeDisabled && parsed.data.nbTradeUses < parsed.data.maximumNbTradeUses);
      if (available.length === 0) {
        if (completedTrades) break;
        throw new SkillFault("TRADE_DISABLED");
      }
      const selected = available.filter(({ parsed }) => parsed.success && parsed.data.realPrice <= input.maxUnitPrice)
        .sort((a, b) => a.parsed.data!.realPrice - b.parsed.data!.realPrice)[0];
      if (!selected?.parsed.success) throw new SkillFault("TRADE_PRICE_UNACCEPTABLE");
      const offer = selected.parsed.data;
      const payments = new Map([[offer.inputItem1.name, offer.realPrice]]);
      if (offer.hasItem2 && !offer.inputItem2) throw new SkillFault("TRADE_OFFER_INVALID");
      if (offer.inputItem2) payments.set(offer.inputItem2.name, (payments.get(offer.inputItem2.name) ?? 0) + offer.inputItem2.count);
      if (payments.has(input.wantItem)) throw new SkillFault("TRADE_OFFER_INVALID");
      if ([...payments].some(([name, amount]) => port.count(name) < amount)) {
        if (completedTrades) break;
        throw new SkillFault("TRADE_ITEM_NOT_IN_INVENTORY");
      }
      if (!port.hasRoom(input.wantItem, offer.outputItem.count)) {
        if (completedTrades) break;
        throw new SkillFault("INVENTORY_FULL");
      }
      const before = new Map([...payments].map(([name]) => [name, port.count(name)]));
      const beforeReceived = port.count(input.wantItem);
      await port.assertActive();
      try { await port.trade(window, selected.index); }
      catch { throw new SkillFault("NON_IDEMPOTENT_RESULT_UNCERTAIN"); }
      close();
      await port.assertActive();
      if ([...payments].some(([name, amount]) => before.get(name)! - port.count(name) !== amount) ||
          port.count(input.wantItem) - beforeReceived !== offer.outputItem.count) {
        throw new SkillFault("NON_IDEMPOTENT_RESULT_UNCERTAIN");
      }
      completedTrades++;
      spentCount += offer.realPrice;
      receivedCount += offer.outputItem.count;
    }
  } finally {
    port.signal.removeEventListener("abort", onAbort);
    close();
  }
  return { villagerEntityId: entityId, wantItem: input.wantItem, requestedTrades: input.maxTrades,
    completedTrades, spentCount, receivedCount, actualUnitPrice: Math.ceil(spentCount / Math.max(1, completedTrades)) };
}

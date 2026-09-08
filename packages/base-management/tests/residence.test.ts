import { describe, expect, it } from "vitest";
import { BaseRegistry } from "../src/base-registry.js";
import { bedSiteSchema, respawnMarkerLines } from "../src/residence.js";

const site = () => bedSiteSchema.parse({
  siteId: "11111111-1111-4111-8111-111111111111", baseId: "base-a",
  scope: { serverProfileId: "srv", worldId: "world", dimension: "minecraft:overworld", botId: "Bot_One" },
  head: { x: 1, y: 64, z: 0 }, foot: { x: 1, y: 64, z: 1 }, facing: "north",
  marker: { x: 2, y: 64, z: 1 }, standing: { x: 0, y: 64, z: 1 }, revision: 1, policyRevision: 1, source: "bot-built",
});

describe("residence contracts", () => {
  it("renders long BotIDs into bounded sign lines", () => {
    expect(respawnMarkerLines("Bot_One")).toBe("Bot_One\n的复活点");
    expect(respawnMarkerLines("1234567890123456").split("\n")[0]).toHaveLength(8);
  });
  it("requires both fresh server receipts before settling membership", () => {
    const registry = new BaseRegistry();
    const base = registry.create({ name: "A", serverProfileId: "srv", worldId: "world", dimension: "minecraft:overworld", anchor: { x: 0, y: 64, z: 0 }, blueprintId: "bp" });
    const persist = () => {};
    const reserved = registry.reserveResidence({ ...site(), baseId: base.id }, "22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333", persist);
    expect(reserved.status).toBe("SETTLING");
    const common = { schemaVersion: "1.0" as const, siteId: reserved.site.siteId, siteRevision: 1, operationId: reserved.operationId,
      botId: "Bot_One", serverProfileId: "srv", worldId: "world", dimension: "minecraft:overworld" as const,
      runtimeInstanceId: "rt", bedPresent: true, usable: true, markerPresent: true, observedAt: new Date().toISOString(), reason: null };
    registry.recordResidenceReceipt(reserved.taskId, { ...common, binding: "SERVER_CONFIRMED", bindingEvidence: { type: "server-translation", translation: "block.minecraft.bed.set_spawn", receivedAt: common.observedAt, interactionId: "44444444-4444-4444-8444-444444444444" }, marker: "UNVERIFIED", markerText: null, markerEvidence: null }, persist);
    expect(registry.residence("Bot_One", "srv", "world")?.status).toBe("SETTLING");
    registry.recordResidenceReceipt(reserved.taskId, { ...common, binding: "SERVER_CONFIRMED", bindingEvidence: { type: "server-translation", translation: "block.minecraft.bed.set_spawn", receivedAt: common.observedAt, interactionId: "55555555-5555-4555-8555-555555555555" }, marker: "SERVER_CONFIRMED", markerText: "Bot_One\n的复活点", markerEvidence: { type: "server-block-entity", receivedAt: common.observedAt } }, persist);
    expect(registry.residence("Bot_One", "srv", "world")?.status).toBe("SETTLED");
    registry.markFactsUnverified();
    expect(registry.residence("Bot_One", "srv", "world")?.status).toBe("RECONCILING");
  });
});

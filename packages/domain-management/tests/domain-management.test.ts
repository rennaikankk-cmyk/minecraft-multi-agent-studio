import { describe, expect, it } from "vitest";
import { AssetPolicy, BaseManagement, ResourceManagement, SurvivalManagement, type Scope } from "../src/index.js";
const scope: Scope = { serverProfileId: "srv", worldId: "world-1", dimension: "minecraft:overworld" };
const pos = { x: 10, y: 64, z: 20 };
describe("domain-management", () => {
  it("requires trusted invitation and both bed/sign confirmations", () => {
    const base = new BaseManagement({ verify: (_s, name, uuid) => name === "Alice" && uuid === "u1" }, () => "2026-01-01T00:00:00.000Z");
    expect(base.acceptInvitation({ invitationId: "i1", scope, senderName: "Mallory", senderUuid: "u2", center: pos, message: "base at 10 20" })).toBeUndefined();
    expect(base.acceptInvitation({ invitationId: "i2", scope, senderName: "Alice", senderUuid: "u1", center: pos, message: "搬来住，我的基地在这里" })).toBeTruthy();
    base.createBase({ baseId: "b1", scope, ownerId: "Alice", center: pos, stage: "candidate" });
    base.beginMove("b1", "bot-a");
    expect(base.confirmSign("b1", "bot-a", pos, "bot-a 的复活点").beds["bot-a"]?.status).toBe("sign_confirmed");
    expect(base.get("b1")?.stage).toBe("moving");
    expect(base.confirmBed("b1", "bot-a", pos).beds["bot-a"]?.status).toBe("bed_confirmed");
    expect(base.confirmSign("b1", "bot-a", pos, "bot-a 的复活点").stage).toBe("settled");
  });
  it("fails closed across scope and protects machines while allowing confirmed output", () => {
    const p = new AssetPolicy();
    p.register({ assetId: "machine", scope, kind: "machine", owner: "player", version: 1, protected: true });
    p.register({ assetId: "out", scope, kind: "output", role: "output", owner: "player", version: 1, protected: true });
    expect(p.grant({ subjectId: "bot", assetId: "machine", scope, action: "dig", policyRevision: 1 })).toBe(false);
    expect(p.authorize("bot", "machine", "dig", scope).reason).toBe("PROTECTED");
    expect(p.grant({ subjectId: "bot", assetId: "out", scope, action: "container-transfer", policyRevision: 1 })).toBe(true);
    expect(p.authorize("bot", "out", "container-transfer", scope).allowed).toBe(true);
    expect(p.authorize("bot", "out", "container-transfer", { ...scope, worldId: "other" }).reason).toBe("SCOPE_MISMATCH");
  });
  it("subtracts active reservations and makes transfer idempotent", () => {
    const r = new ResourceManagement();
    r.observe({ containerId: "c", itemId: "iron", quantity: 10, status: "observed", observedAt: "now", revision: 1 });
    r.reserve({ reservationId: "r1", subjectId: "bot-a", containerId: "c", itemId: "iron", quantity: 6, state: "active" });
    expect(r.available("c", "iron")).toBe(4);
    expect(() => r.reserve({ reservationId: "r2", subjectId: "bot-b", containerId: "c", itemId: "iron", quantity: 5, state: "active" })).toThrow("RESOURCE_UNAVAILABLE");
    const order = { operationId: "op", reservationId: "r1", taskId: "task", source: "c", target: "bot-a", itemId: "iron", quantity: 6, state: "planned" as const };
    expect(r.createTransfer(order)).toEqual(r.createTransfer(order));
    expect(r.updateTransfer("op", "completed").state).toBe("completed");
  });
  it("keeps survival checks deterministic and avoids same-slot downgrade", () => {
    const s = new SurvivalManagement(16);
    expect(s.needs({ food: 10, health: 20, armor: {} })).toEqual(["food", "armor:head", "armor:chest", "armor:legs", "armor:feet"]);
    const diamond = { slot: "head" as const, material: "diamond" as const, durability: 100, maxDurability: 100, enchantmentLevel: 2 };
    expect(s.shouldUpgrade(diamond, { ...diamond, material: "iron" })).toBe(false);
    expect(s.shouldUpgrade(diamond, { ...diamond, material: "netherite" })).toBe(true);
  });
});

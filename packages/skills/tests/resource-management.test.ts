import { describe, expect, it } from "vitest";
import { ResourceLedger, type ResourceScope } from "../src/planning/resource-management.js";
const scope: ResourceScope = { serverProfileId: "s", worldId: "w", dimension: "minecraft:overworld" };
describe("ResourceLedger", () => {
 it("keeps unknown/stale unavailable and subtracts reservations", () => { const l = new ResourceLedger(); l.observe({ scope, containerId: "c", itemId: "iron", quantity: 8, status: "observed", revision: 1, observedAt: "t" }); l.reserve({ reservationId: "r", scope, subjectId: "bot", containerId: "c", itemId: "iron", quantity: 5, state: "active" }); expect(l.available(scope,"c","iron")).toBe(3); l.markStale(scope,"c","iron"); expect(l.available(scope,"c","iron")).toBeUndefined(); });
 it("is idempotent and reconciles partial receipts", () => { const l = new ResourceLedger(); l.observe({ scope, containerId: "c", itemId: "iron", quantity: 8, status: "observed", revision: 1, observedAt: "t" }); l.reserve({ reservationId: "r", scope, subjectId: "bot", containerId: "c", itemId: "iron", quantity: 5, state: "active" }); const order = { operationId:"op",taskId:"task",reservationId:"r",scope,source:"c",target:"bot",itemId:"iron",quantity:5,state:"dispatched" as const}; expect(l.createTransfer(order)).toEqual(l.createTransfer(order)); expect(l.recordReceipt("op", 2, "t").state).toBe("partially-confirmed"); });
});

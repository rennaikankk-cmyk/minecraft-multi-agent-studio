import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { DurableResourceLedger, FileResourceStateStore, MemoryResourceStateStore, ResourceLedger,
  resourceObservationInputSchema, resourceIdentitySchema,
  type ResourceLocation, type ResourceReceipt, type TransferOrder } from "../src/index.js";

const scope = { serverProfileId: "server-a", worldId: "world-1", dimension: "minecraft:overworld" };
const item = { itemId: "minecraft:iron_ingot", minecraftVersion: "1.21.8", catalogId: 42, kind: "material" as const, variant: "plain" as const };
const source: ResourceLocation = { id: "chest-a", kind: "container", botId: null, role: "shared", position: { x: 1, y: 64, z: 2 } };
const target: ResourceLocation = { id: "inventory", kind: "inventory", botId: "BotA", role: "personal", position: null };
const at = Date.parse("2026-09-09T00:00:00Z");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture(store = new MemoryResourceStateStore()) {
  let now = at, sequence = 0;
  const ledger = new ResourceLedger({ store, now: () => now });
  const permission = { allowed: true, reachable: true, purpose: "resupply", policyRevision: 1, assetVersion: "asset-v1", minimumKeep: 2, expiresAt: new Date(at + 60_000).toISOString() };
  function observe(location: ResourceLocation, quantity: number | null, observedScope = scope) {
    return ledger.observe({ observationId: randomUUID(), scope: observedScope, location, identity: item, quantity,
      observedAt: new Date(now).toISOString(), observerBotId: location.botId ?? "BotA", runtimeInstanceId: `runtime-${location.botId ?? "BotA"}`,
      sequence: ++sequence, evidenceRef: "runtime-read" });
  }
  observe(source, 10); observe(target, 0);
  const demand = ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 5 });
  function plan(quantity = 5, override: Partial<Parameters<ResourceLedger["planTransfer"]>[0]> = {}) {
    return ledger.planTransfer({ operationId: randomUUID(), taskId: randomUUID(), demandId: demand.demandId,
      scope, botId: "BotA", source, target, identity: item, quantity, permission, ...override });
  }
  function dispatch(t: TransferOrder) { return ledger.beginDispatch({ operationId: t.operationId, scope, botId: "BotA", taskId: t.taskId,
    runtimeInstanceId: "runtime-BotA", leaseOwner: "worker-a", leaseExpiresAt: new Date(now + 10_000).toISOString(), permission }); }
  function receipt(t: TransferOrder, moved = 5, override: Partial<ResourceReceipt> = {}): ResourceReceipt {
    return { receiptId: randomUUID(), operationId: t.operationId, taskId: t.taskId, attemptId: t.attemptId!, fence: t.fence,
      scope, botId: "BotA", runtimeInstanceId: "runtime-BotA", identity: item, observedAt: new Date(now).toISOString(),
      outcome: "confirmed", moved, sourceRemaining: 99, evidenceRef: "runtime-transfer-receipt", ...override };
  }
  return { ledger, store, permission, observe, plan, dispatch, receipt, demand, advance: (ms: number) => { now += ms; } };
}

describe("durable resource transactions", () => {
  it("rejects malformed timestamps, unknown item components and scope metadata", () => {
    expect(resourceObservationInputSchema.safeParse({ observedAt: "t" }).success).toBe(false);
    expect(resourceIdentitySchema.safeParse({ ...item, kind: "equipment" }).success).toBe(false);
    const f = fixture();
    expect(f.ledger.available({ ...scope, worldId: null }, source, item, f.permission)).toBeNull();
    expect(f.ledger.available({ ...scope, serverProfileId: "server-b" }, source, item, f.permission)).toBeNull();
    expect(f.ledger.available(scope, source, { ...item, variant: "a".repeat(64) }, f.permission)).toBeNull();
  });
  it("subtracts reservations and minimum retained stock, rejects unknown/stale inventory and private containers", () => {
    const f = fixture(); f.plan();
    expect(f.ledger.available(scope, source, item, f.permission)).toBe(3);
    expect(f.ledger.available(scope, { ...source, role: "private" }, item, f.permission)).toBeNull();
    expect(f.ledger.available(scope, source, item, { ...f.permission, allowed: false })).toBeNull();
    f.advance(10_000); expect(f.ledger.available(scope, source, item, f.permission)).toBeNull();
    f.observe(source, null); expect(f.ledger.available(scope, source, item, f.permission)).toBeNull();
  });
  it("merges demands and checks own inventory/equipment before planning another transfer", () => {
    const f = fixture();
    expect(f.ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 5 }).demandId).toBe(f.demand.demandId);
    f.observe(target, 5); expect(f.ledger.demandBalance(f.demand.demandId, scope).deficit).toBe(0);
    expect(() => f.plan()).toThrow("RESOURCE_DEMAND_SATISFIED");
    f.observe(target, null); expect(() => f.plan()).toThrow("RESOURCE_OWN_INVENTORY_UNKNOWN");
  });
  it("commits reservation, operation and outbox atomically and replays stable operation identity", () => {
    const f = fixture(); const t = f.plan();
    const retry = { operationId: t.operationId, taskId: t.taskId };
    expect(f.plan(5, retry)).toEqual(t);
    expect(() => f.plan(4, retry)).toThrow("RESOURCE_OPERATION_CONFLICT");
    const state = f.ledger.snapshot(scope);
    expect([state.reservations.length, state.transfers.length, state.outbox.length]).toEqual([1, 1, 1]);
    expect(f.ledger.demandBalance(f.demand.demandId, scope)).toEqual({ owned: 0, pending: 5, deficit: 0 });
  });
  it("never publishes partial in-memory state after a failed durable transaction", () => {
    const store = new MemoryResourceStateStore(); const f = fixture(store);
    const before = store.load(); const original = store.save.bind(store);
    store.save = () => { throw new Error("disk-full"); };
    expect(() => f.plan()).toThrow("disk-full");
    expect(store.load()).toEqual(before);
    store.save = original; expect(f.plan().state).toBe("planned");
  });
  it("accepts distinct Bot demands without double reserving the same shared source", () => {
    const f = fixture(); f.plan(); const targetB = { ...target, botId: "BotB" }; f.observe(targetB, 0);
    const d = f.ledger.demand({ scope, botId: "BotB", identity: item, purpose: "resupply", targetQuantity: 5 });
    expect(() => f.plan(5, { botId: "BotB", demandId: d.demandId, target: targetB })).toThrow("RESOURCE_UNAVAILABLE");
    expect(f.plan(3, { botId: "BotB", demandId: d.demandId, target: targetB }).quantity).toBe(3);
  });
  it("fences dispatch and quarantines ambiguous effects even after newer source observations", () => {
    const f = fixture(), t = f.dispatch(f.plan());
    expect(() => f.dispatch(t)).toThrow("RESOURCE_RECONCILIATION_REQUIRED");
    f.ledger.recordReceipt(f.receipt(t, 0, { outcome: "ambiguous", moved: null }));
    f.observe(source, 500); expect(f.ledger.available(scope, source, item, f.permission)).toBeNull();
    f.advance(11_000); f.ledger.expireReservations();
    expect(f.ledger.snapshot(scope).reservations[0]?.state).toBe("held");
    expect(() => f.ledger.reconcile({ operationId: t.operationId, scope, receiptId: "invented", sourceObservationId: "x", targetObservationId: "y" })).toThrow("RESOURCE_RECONCILIATION_EVIDENCE_REQUIRED");
  });
  it("persists idempotent receipts and reconciles partial moves without attributing concurrent hopper deltas", () => {
    const f = fixture(), t = f.dispatch(f.plan()), receipt = f.receipt(t, 2);
    expect(f.ledger.recordReceipt(receipt).state).toBe("partially-confirmed");
    expect(f.ledger.recordReceipt(receipt).confirmedMoved).toBe(2);
    expect(() => f.ledger.recordReceipt({ ...receipt, moved: 3 })).toThrow("RESOURCE_RECEIPT_CONFLICT");
    const sourceRead = f.observe(source, 99), targetRead = f.observe(target, 2);
    const settled = f.ledger.reconcile({ operationId: t.operationId, scope, receiptId: receipt.receiptId,
      sourceObservationId: sourceRead.observationId, targetObservationId: targetRead.observationId });
    expect(settled.state).toBe("partially-confirmed"); expect(settled.settledAt).not.toBeNull();
    expect(f.ledger.available(scope, source, item, f.permission)).toBe(97);
    expect(f.ledger.demandBalance(f.demand.demandId, scope).deficit).toBe(3);
  });
  it("retains late effects after cancellation but rejects stale owner attempts and foreign receipts", () => {
    const f = fixture(), t = f.dispatch(f.plan()); f.ledger.interrupt(t.operationId, scope, "L0_PREEMPTED");
    const receipt = f.receipt(t);
    expect(() => f.ledger.recordReceipt({ ...receipt, fence: t.fence + 1 })).toThrow("RESOURCE_RECEIPT_MISMATCH");
    expect(() => f.ledger.recordReceipt({ ...receipt, scope: { ...scope, worldId: "other" } })).toThrow("RESOURCE_TRANSFER_NOT_FOUND");
    expect(f.ledger.recordReceipt(receipt).unresolvedReason).toBe("LATE_EFFECT_REQUIRES_RECONCILIATION");
    expect(f.ledger.snapshot(scope).receipts).toHaveLength(1);
  });
  it("releases expired unexecuted reservations and cancels their pending delivery", () => {
    const f = fixture(); f.plan(); f.advance(31_000); expect(f.ledger.expireReservations()).toBe(1);
    expect(f.ledger.snapshot(scope).outbox[0]?.state).toBe("cancelled");
    expect(f.ledger.snapshot(scope).transfers[0]?.state).toBe("cancelled");
  });
  it("restores pending outbox and receipt dedup across new Coordinator instances and rejects corrupt snapshots", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "resource-v2-")); dirs.push(dir); const file = path.join(dir, "state.json");
    const store = new FileResourceStateStore(file), f = fixture(store), t = f.dispatch(f.plan()), receipt = f.receipt(t, 2);
    f.ledger.recordReceipt(receipt);
    const restored = new DurableResourceLedger(file, { now: () => at });
    expect(restored.pendingOutbox()).toHaveLength(1); expect(restored.recordReceipt(receipt).confirmedMoved).toBe(2);
    expect(restored.snapshot({ ...scope, serverProfileId: "server-b" }).transfers).toHaveLength(0);
    const stale = store.load(); f.ledger.noteSubmission(restored.pendingOutbox()[0]!.messageId, true);
    expect(() => store.save({ ...stale, revision: stale.revision + 1 }, stale.revision)).toThrow("RESOURCE_REVISION_CONFLICT");
    writeFileSync(file, "{}"); expect(() => restored.snapshot(scope)).toThrow("RESOURCE_STATE_READ_FAILED");
  });
});

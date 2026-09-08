import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { taskRecordSchema } from "@minecraft-studio/task-system";
import { taskDispatchV1Schema } from "@minecraft-studio/protocol";
import { MemoryResourceStateStore, ResourceLedger, type ResourceLocation, type ResourcePermission } from "@minecraft-studio/resource-management";
import { CoordinatorResourceService, type ResourceTaskPort } from "../src/resource-service.js";

const scope = { serverProfileId: "server-a", worldId: "world-1", dimension: "minecraft:overworld" };
const item = { itemId: "minecraft:iron_ingot", minecraftVersion: "1.21.8", catalogId: 1, kind: "material" as const, variant: "plain" as const };
const source: ResourceLocation = { id: "chest", kind: "container", botId: null, role: "shared", position: { x: 1, y: 64, z: 2 } };
const target: ResourceLocation = { id: "inv", kind: "inventory", botId: "BotA", role: "personal", position: null };
const permission: ResourcePermission = { allowed: true, reachable: true, purpose: "resupply", policyRevision: 1, assetVersion: "v1", minimumKeep: 0, expiresAt: "2099-01-01T00:00:00Z" };
const principal = { botId: "BotA", runtimeInstanceId: "runtime-a", scope };
function service(port: ResourceTaskPort = { submitTask: async () => ({}), getTask: async () => null }) {
  const ledger = new ResourceLedger({ store: new MemoryResourceStateStore(), now: () => Date.parse("2026-09-09T00:00:00Z") });
  const s = new CoordinatorResourceService({ ledger, now: () => Date.parse("2026-09-09T00:00:00Z"), taskPort: port, currentRuntime: () => principal, validateItem: () => true, authorize: async () => permission,
    executeSkill: async () => ({ output: null, evidenceRef: "evidence" }) });
  s.observe({ observationId: "obs-1", scope, location: source, identity: item, quantity: 10, observedAt: "2026-09-09T00:00:00Z", observerBotId: "BotA", runtimeInstanceId: "runtime-a", sequence: 1, evidenceRef: "read" }, principal);
  s.observe({ observationId: "obs-2", scope, location: target, identity: item, quantity: 0, observedAt: "2026-09-09T00:00:00Z", observerBotId: "BotA", runtimeInstanceId: "runtime-a", sequence: 2, evidenceRef: "read" }, principal);
  return { s, ledger };
}
describe("Coordinator resource task bridge", () => {
  it("plans demand and submits through the injected task-system port", async () => {
    const calls: unknown[] = [], f = service({ submitTask: async c => { calls.push(c); }, getTask: async () => null });
    const demand = f.ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 4 });
    const order = await f.s.planTransfer({ operationId: randomUUID(), taskId: randomUUID(), demandId: demand.demandId, scope, botId: "BotA", source, target, identity: item, quantity: 4 });
    await f.s.drainOutbox(); expect(order.state).toBe("planned"); expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ taskType: "resource.transfer", executionIdempotent: false, maxRetries: 0,
      taskId: order.taskId, operationId: order.operationId, dispatchBotId: "BotA" });
    await f.s.drainOutbox(); expect(calls).toHaveLength(1);
  });
  it("keeps task outbox pending after submission uncertainty and does not regenerate a second operation", async () => {
    const f = service({ submitTask: async () => { throw new Error("timeout"); }, getTask: async () => null });
    const demand = f.ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 4 });
    const operationId = randomUUID();
    await f.s.planTransfer({ operationId, taskId: randomUUID(), demandId: demand.demandId, scope, botId: "BotA", source, target, identity: item, quantity: 4 });
    expect(await f.s.drainOutbox()).toEqual({ submitted: 0, pending: 1 });
    expect(f.ledger.snapshot(scope).transfers.map(t => t.operationId)).toEqual([operationId]); expect(f.ledger.snapshot(scope).outbox[0]?.attempts).toBe(1);
  });
  it("replays exactly the same task command when submit succeeded but the resource acknowledgement was lost", async () => {
    const submitted: unknown[] = [];
    const f = service({ submitTask: async command => { submitted.push(command); }, getTask: async () => null });
    const demand = f.ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 4 });
    await f.s.planTransfer({ operationId: randomUUID(), taskId: randomUUID(), demandId: demand.demandId,
      scope, botId: "BotA", source, target, identity: item, quantity: 4 });
    const acknowledge = f.ledger.noteSubmission.bind(f.ledger);
    f.ledger.noteSubmission = () => { throw new Error("disk acknowledgement failed"); };
    await expect(f.s.drainOutbox()).rejects.toThrow("disk acknowledgement failed");
    expect(f.ledger.pendingOutbox()).toHaveLength(1);
    f.ledger.noteSubmission = acknowledge;
    await f.s.drainOutbox(); expect(submitted).toHaveLength(2); expect(submitted[0]).toEqual(submitted[1]);
    expect(f.ledger.snapshot(scope).reservations).toHaveLength(1);
  });
  it("rejects forged Runtime observations, revoked permissions and unsupported component variants", async () => {
    const f = service();
    const observed = f.ledger.snapshot(scope).observations[0]!;
    const { revision: _revision, status: _status, expiresAt: _expires, ...input } = observed;
    expect(() => f.s.observe({ ...input, observerBotId: "BotB" }, principal)).toThrow("RESOURCE_OBSERVATION_SCOPE_DENIED");
    expect(() => f.s.observe(input, { ...principal, runtimeInstanceId: "retired" })).toThrow("RESOURCE_RUNTIME_SCOPE_MISMATCH");
    const demand = f.ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 4 });
    await expect(f.s.planTransfer({ operationId: randomUUID(), taskId: randomUUID(), demandId: demand.demandId,
      scope, botId: "BotA", source, target, identity: { ...item, variant: "a".repeat(64) }, quantity: 4 })).rejects.toThrow("RESOURCE_VARIANT_TRANSFER_UNSUPPORTED");
  });
  it("runs the existing task handler through leased skill execution and independent reconciliation, refusing duplicate withdrawal", async () => {
    const f = service(); const demand = f.ledger.demand({ scope, botId: "BotA", identity: item, purpose: "resupply", targetQuantity: 4 });
    const order = await f.s.planTransfer({ operationId: randomUUID(), taskId: randomUUID(), demandId: demand.demandId,
      scope, botId: "BotA", source, target, identity: item, quantity: 4 });
    const command = f.s.taskCommand(order);
    const { operationId: _operation, actorId: _actor, ...taskFields } = command;
    const task = taskRecordSchema.parse({ ...taskFields,
      schemaVersion: "1.0", requestFingerprint: "a".repeat(64), assignedBotId: "BotA", status: "running",
      createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z", startedAt: "2026-09-09T00:00:00Z", finishedAt: null,
      retryCount: 0, leaseOwner: "worker", leaseExpiresAt: "2026-09-09T00:00:10Z", failureReason: null, result: null, evidence: [], revision: 1 });
    let withdrawals = 0;
    const runtime = new CoordinatorResourceService({ ledger: f.ledger, now: () => Date.parse("2026-09-09T00:00:00Z"),
      currentRuntime: () => principal, validateItem: () => true, authorize: async () => permission,
      taskPort: { submitTask: async () => ({}), getTask: async () => task },
      reobserve: async () => ({
        source: { observationId: randomUUID(), scope, location: source, identity: item, quantity: 99,
          observedAt: "2026-09-09T00:00:00Z", observerBotId: "BotA", runtimeInstanceId: "runtime-a", sequence: 3, evidenceRef: "independent-read" },
        target: { observationId: randomUUID(), scope, location: target, identity: item, quantity: 4,
          observedAt: "2026-09-09T00:00:00Z", observerBotId: "BotA", runtimeInstanceId: "runtime-a", sequence: 4, evidenceRef: "independent-read" },
      }),
      executeSkill: async () => {
        withdrawals++; expect(f.ledger.snapshot(scope).transfers[0]?.state).toBe("dispatched");
        return { evidenceRef: "real-runtime-receipt", output: { direction: "withdraw", itemName: "iron_ingot", requestedCount: 4, movedCount: 4,
          verification: { inventoryBefore: 0, inventoryAfter: 4, containerBefore: 10, containerAfter: 6, observedAt: "2026-09-09T00:00:00Z" } } };
      } });
    const dispatch = taskDispatchV1Schema.parse({ schemaVersion: "1.0", messageId: randomUUID(), traceId: order.operationId,
      timestamp: "2026-09-09T00:00:00Z", source: { service: "coordinator", instanceId: "coordinator-test" },
      taskId: order.taskId, botId: "BotA", type: "task.dispatch.v1", payload: { expectedRevision: 1,
        taskType: "resource.transfer", handlerVersion: "1.0.0", executionIdempotent: false } });
    const result = await runtime.taskHandler().execute({ task, dispatch, signal: new AbortController().signal });
    expect(result.terminal?.status).toBe("completed");
    expect(result.result).toMatchObject({ confirmedMoved: 4, state: "completed", reconciliationRequired: false });
    await expect(runtime.executeTransfer(order.operationId, scope, "worker", new AbortController().signal)).rejects.toThrow("RESOURCE_RECONCILIATION_REQUIRED");
    expect(withdrawals).toBe(1);
  });
});

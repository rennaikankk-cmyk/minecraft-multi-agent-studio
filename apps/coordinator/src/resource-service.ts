import { randomUUID } from "node:crypto";
import { z } from "zod";
const containerTransferInputSchema = z.object({ direction: z.literal("withdraw"), itemName: z.string().min(1), count: z.number().int().positive(), container: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }), dimension: z.string(), serverProfileId: z.string() });
const containerTransferOutputSchema = z.object({ direction: z.literal("withdraw"), itemName: z.string(), requestedCount: z.number().int().positive(), movedCount: z.number().int().nonnegative(), verification: z.object({ inventoryBefore: z.number().int().nonnegative(), inventoryAfter: z.number().int().nonnegative(), containerBefore: z.number().int().nonnegative(), containerAfter: z.number().int().nonnegative(), observedAt: z.string() }).optional() });
import { taskSubmitCommandSchema, type TaskSubmitCommand, type TaskRecord, type TaskHandlerDefinition } from "@minecraft-studio/task-system";
import { DurableResourceLedger, ResourceLedger, resourceObservationInputSchema, resourceScopeKey,
  resourceItemKey, type ResourceReceipt, type ResourceObservationInput, type ResourceIdentity, type ResourceLocation,
  type ResourcePermission, type ResourceScope, type TransferOrder } from "@minecraft-studio/resource-management";

export interface ResourceTaskPort {
  /** PostgresTaskRepository.submitTask already commits its dispatch outbox idempotently. */
  submitTask(command: TaskSubmitCommand): Promise<unknown>;
  getTask(taskId: string): Promise<TaskRecord | null>;
}
export type ResourceRuntimePrincipal = { botId: string; runtimeInstanceId: string; scope: ResourceScope };
export type ResourceServiceOptions = {
  ledger?: ResourceLedger; persistPath?: string; taskPort: ResourceTaskPort; now?: () => number;
  currentRuntime(botId: string): ResourceRuntimePrincipal | null;
  /** Consult the versioned Minecraft catalog and canonical component identity. */
  validateItem(identity: ResourceIdentity): boolean;
  authorize(input: { botId: string; scope: ResourceScope; source: ResourceLocation; identity: ResourceIdentity; purpose: string }): Promise<ResourcePermission>;
  /** Execute through existing Coordinator skill/assignment path; Runtime still checks asset protection and action locks. */
  executeSkill(order: TransferOrder, input: { direction: "withdraw"; itemName: string; count: number;
    container: { x: number; y: number; z: number }; dimension: string; serverProfileId: string }, signal: AbortSignal): Promise<{ output: unknown; evidenceRef: string }>;
  /** Read actual container and Bot inventory after execution; no new transfer is allowed here. */
  reobserve?(order: TransferOrder, signal: AbortSignal): Promise<{ source: ResourceObservationInput; target: ResourceObservationInput }>;
};
const transferTaskInput = z.object({ schemaVersion: z.literal("1.0"), operationId: z.string().uuid(),
  scope: z.object({ serverProfileId: z.string(), worldId: z.string().nullable(), dimension: z.string() }).strict() }).strict();

export class CoordinatorResourceService {
  readonly ledger: ResourceLedger;
  private readonly now: () => number;
  constructor(private readonly options: ResourceServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ledger = options.ledger ?? (options.persistPath ? new DurableResourceLedger(options.persistPath, { now: this.now }) : new ResourceLedger({ now: this.now }));
  }
  /** Called only with the Runtime Link/HTTP adapter's authenticated principal, never a principal from the request body. */
  observe(input: ResourceObservationInput, principal: ResourceRuntimePrincipal): ReturnType<ResourceLedger["observe"]> {
    const observed = resourceObservationInputSchema.parse(input); this.requireRuntime(principal);
    if (observed.observerBotId !== principal.botId || observed.runtimeInstanceId !== principal.runtimeInstanceId ||
      resourceScopeKey(observed.scope) !== resourceScopeKey(principal.scope)) throw new Error("RESOURCE_OBSERVATION_SCOPE_DENIED");
    if (!this.options.validateItem(observed.identity)) throw new Error("RESOURCE_CATALOG_IDENTITY_INVALID");
    return this.ledger.observe(observed);
  }
  async planTransfer(input: Omit<Parameters<ResourceLedger["planTransfer"]>[0], "permission">): Promise<TransferOrder> {
    const runtime = this.options.currentRuntime(input.botId);
    if (!runtime || resourceScopeKey(runtime.scope) !== resourceScopeKey(input.scope)) throw new Error("RESOURCE_RUNTIME_SCOPE_MISMATCH");
    if (!this.options.validateItem(input.identity)) throw new Error("RESOURCE_CATALOG_IDENTITY_INVALID");
    // Existing name-based container.transfer cannot faithfully select a damaged,
    // enchanted or component-bearing stack. Fail before reserving such variants.
    if (input.identity.kind !== "material" || input.identity.variant !== "plain") throw new Error("RESOURCE_VARIANT_TRANSFER_UNSUPPORTED");
    z.string().uuid().parse(input.operationId); z.string().uuid().parse(input.taskId);
    containerTransferInputSchema.parse({ direction: "withdraw", itemName: input.identity.itemId.replace(/^minecraft:/u, ""),
      count: input.quantity, container: input.source.position, dimension: input.scope.dimension, serverProfileId: input.scope.serverProfileId });
    const demand = this.ledger.snapshot(input.scope).demands.find(d => d.demandId === input.demandId);
    if (!demand) throw new Error("RESOURCE_DEMAND_NOT_FOUND");
    const permission = await this.options.authorize({ botId: input.botId, scope: input.scope, source: input.source,
      identity: input.identity, purpose: demand.purpose });
    this.requireRuntime(runtime);
    return this.ledger.planTransfer({ ...input, permission });
  }
  /** Authenticated late Runtime effects remain admissible if they match the persisted attempt. */
  recordReceipt(receipt: ResourceReceipt, principal: ResourceRuntimePrincipal): TransferOrder {
    if (receipt.botId !== principal.botId || receipt.runtimeInstanceId !== principal.runtimeInstanceId ||
      resourceScopeKey(receipt.scope) !== resourceScopeKey(principal.scope)) throw new Error("RESOURCE_RECEIPT_SCOPE_DENIED");
    return this.ledger.recordReceipt(receipt);
  }
  /** Bounded pump invoked by the existing Coordinator tick/outbox recovery. Never starts a competing loop. */
  async drainOutbox(): Promise<{ submitted: number; pending: number }> {
    let submitted = 0, pending = 0;
    for (const { messageId, order } of this.ledger.pendingOutbox()) {
      const command = this.taskCommand(order);
      try { await this.options.taskPort.submitTask(command); }
      catch { this.ledger.noteSubmission(messageId, false); pending++; continue; }
      // A crash after submit but before this commit re-submits the same task ID,
      // operation ID and fingerprint to the existing transactional task outbox.
      this.ledger.noteSubmission(messageId, true); submitted++;
    }
    return { submitted, pending };
  }
  taskCommand(order: TransferOrder): TaskSubmitCommand {
    return taskSubmitCommandSchema.parse({ schemaVersion: "1.0", operationId: order.operationId, taskId: order.taskId,
      idempotencyScope: "resource-transfer-v2", idempotencyKey: order.operationId, taskType: "resource.transfer", handlerVersion: "1.0.0",
      executionIdempotent: false, title: "领取已预留物资", description: "通过已授权容器领取，执行后以回执和独立库存观测对账。",
      input: { schemaVersion: "1.0", operationId: order.operationId, scope: order.scope },
      dispatchBotId: order.botId, priority: 50, requiredSkills: [{ skillId: "container.transfer", skillVersion: "1.0.0" }], requiredItems: [],
      target: { ...order.source.position!, dimension: order.scope.dimension, serverProfileId: order.scope.serverProfileId },
      dependencyIds: [], parentTaskId: null, deadline: null, timeoutMs: 30_000, maxRetries: 0, riskLevel: "R1",
      traceId: order.operationId, actorId: "resource-management" });
  }
  /** Register this definition in the existing TaskHandlerRegistry/Coordinator bridge. */
  taskHandler(): TaskHandlerDefinition {
    return { taskType: "resource.transfer", handlerVersion: "1.0.0", idempotent: false,
      execute: async context => {
        const input = transferTaskInput.parse(context.task.input);
        let order = await this.executeTransfer(input.operationId, input.scope, context.task.leaseOwner!, context.signal);
        if (this.options.reobserve && !context.signal.aborted) {
          try {
            const reads = await this.options.reobserve(order, context.signal);
            const principal = this.options.currentRuntime(order.botId);
            if (!principal) throw new Error("RESOURCE_RUNTIME_SCOPE_MISMATCH");
            const source = this.observe(reads.source, principal), target = this.observe(reads.target, principal);
            const receipt = this.ledger.snapshot(order.scope).receipts.filter(r => r.operationId === order.operationId &&
              r.outcome === "confirmed" && r.moved === order.confirmedMoved).at(-1);
            if (!receipt) throw new Error("RESOURCE_RECONCILIATION_EVIDENCE_REQUIRED");
            order = this.ledger.reconcile({ operationId: order.operationId, scope: order.scope, receiptId: receipt.receiptId,
              sourceObservationId: source.observationId, targetObservationId: target.observationId });
          } catch { /* Persisted unresolved transfer remains quarantined; no replay. */ }
        }
        return { result: { operationId: order.operationId, state: order.state, confirmedMoved: order.confirmedMoved,
          reconciliationRequired: order.settledAt === null }, evidence: [], terminal: order.settledAt === null
            ? { status: "failed", failureReason: "RESOURCE_RECONCILIATION_REQUIRED" } : { status: "completed" } };
      } };
  }
  async executeTransfer(operationId: string, scope: ResourceScope, leaseOwner: string, signal: AbortSignal): Promise<TransferOrder> {
    const order = this.ledger.snapshot(scope).transfers.find(t => t.operationId === operationId);
    if (!order) throw new Error("RESOURCE_TRANSFER_NOT_FOUND");
    if (order.state !== "planned") throw new Error("RESOURCE_RECONCILIATION_REQUIRED");
    const task = await this.options.taskPort.getTask(order.taskId), runtime = this.options.currentRuntime(order.botId);
    if (!task || task.taskId !== order.taskId || task.taskType !== "resource.transfer" ||
      task.assignedBotId !== order.botId || task.leaseOwner !== leaseOwner || !task.leaseExpiresAt ||
      Date.parse(task.leaseExpiresAt) <= this.now() || !["assigned", "running"].includes(task.status)) throw new Error("RESOURCE_TASK_LEASE_INVALID");
    if (!runtime || resourceScopeKey(runtime.scope) !== resourceScopeKey(scope)) throw new Error("RESOURCE_RUNTIME_SCOPE_MISMATCH");
    const demand = this.ledger.snapshot(scope).demands.find(d => d.demandId === order.demandId)!;
    const permission = await this.options.authorize({ botId: order.botId, scope, source: order.source, identity: order.identity, purpose: demand.purpose });
    this.requireRuntime(runtime);
    const currentTask = await this.options.taskPort.getTask(order.taskId);
    if (signal.aborted || !currentTask || currentTask.leaseOwner !== leaseOwner || currentTask.assignedBotId !== order.botId ||
      !currentTask.leaseExpiresAt || Date.parse(currentTask.leaseExpiresAt) <= this.now() || !["assigned", "running"].includes(currentTask.status)) throw new Error("RESOURCE_TASK_LEASE_INVALID");
    const dispatched = this.ledger.beginDispatch({ operationId, scope, botId: order.botId, taskId: order.taskId,
      runtimeInstanceId: runtime.runtimeInstanceId, leaseOwner, leaseExpiresAt: currentTask.leaseExpiresAt, permission });
    // Cancellation already reaches Runtime through signal. Avoid throwing from
    // EventTarget; the awaited completion path retries persistence and reports failures.
    const interrupted = () => { try { this.ledger.interrupt(operationId, scope, "TASK_PREEMPTED"); } catch { /* handled on completion */ } };
    signal.addEventListener("abort", interrupted, { once: true });
    try {
      const result = await this.options.executeSkill(dispatched, { direction: "withdraw", itemName: order.identity.itemId.replace(/^minecraft:/u, ""),
        count: order.quantity, container: order.source.position!, dimension: scope.dimension, serverProfileId: scope.serverProfileId }, signal);
      const receipt = containerTransferOutputSchema.safeParse(result.output);
      const confirmed = receipt.success && receipt.data.verification && receipt.data.direction === "withdraw" &&
        receipt.data.itemName === order.identity.itemId.replace(/^minecraft:/u, "") && receipt.data.requestedCount === order.quantity;
      if (signal.aborted) this.ledger.interrupt(operationId, scope, "TASK_PREEMPTED");
      return this.ledger.recordReceipt({ receiptId: randomUUID(), operationId, taskId: order.taskId,
        attemptId: dispatched.attemptId!, fence: dispatched.fence, scope, botId: order.botId, runtimeInstanceId: runtime.runtimeInstanceId,
        identity: order.identity, outcome: confirmed ? "confirmed" : "ambiguous", moved: confirmed ? receipt.data.movedCount : null,
        observedAt: confirmed ? receipt.data.verification!.observedAt : new Date(this.now()).toISOString(), sourceRemaining: confirmed ? receipt.data.verification!.containerAfter : null,
        evidenceRef: result.evidenceRef });
    } catch (error) {
      this.ledger.interrupt(operationId, scope, signal.aborted ? "TASK_PREEMPTED" : "TRANSFER_OUTCOME_UNCERTAIN"); throw error;
    } finally { signal.removeEventListener("abort", interrupted); }
  }
  /** Supply choice only; caller retains the existing goal/task arbitration. */
  async chooseSupply(demandId: string, scope: ResourceScope): Promise<{ owned: number | null; pending: number; deficit: number | null;
    source: ResourceLocation | null; available: number | null }> {
    const snapshot = this.ledger.snapshot(scope), demand = snapshot.demands.find(d => d.demandId === demandId);
    if (!demand) throw new Error("RESOURCE_DEMAND_NOT_FOUND");
    const balance = this.ledger.demandBalance(demandId, scope);
    if (balance.deficit === null || balance.deficit === 0) return { ...balance, source: null, available: null };
    const observations = snapshot.observations.filter(o => o.location.kind === "container" && resourceItemKey(o.identity) === resourceItemKey(demand.identity))
      .sort((a, b) => Number(b.location.role === "output") - Number(a.location.role === "output"));
    for (const o of observations) {
      const permission = await this.options.authorize({ botId: demand.botId, scope, source: o.location, identity: demand.identity, purpose: demand.purpose });
      const available = this.ledger.available(scope, o.location, demand.identity, permission);
      if (available !== null && available > 0) return { ...balance, source: o.location, available };
    }
    return { ...balance, source: null, available: null };
  }
  private requireRuntime(principal: ResourceRuntimePrincipal): void {
    const current = this.options.currentRuntime(principal.botId);
    if (!current || current.runtimeInstanceId !== principal.runtimeInstanceId || resourceScopeKey(current.scope) !== resourceScopeKey(principal.scope)) throw new Error("RESOURCE_RUNTIME_SCOPE_MISMATCH");
  }
}

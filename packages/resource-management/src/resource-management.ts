import { randomUUID } from "node:crypto";
import { resourceDemandSchema, resourceIdentitySchema, resourceLocationSchema, resourceObservationInputSchema,
  resourcePermissionSchema, resourceReceiptSchema, resourceScopeSchema,
  type ResourceDemand, type ResourceIdentity, type ResourceLocation, type ResourceObservation,
  type ResourceObservationInput, type ResourcePermission, type ResourceReceipt, type ResourceScope,
  type ResourceState, type TransferOrder } from "./schema.js";
import { FileResourceStateStore, MemoryResourceStateStore, type ResourceStateStore } from "./store.js";
export * from "./schema.js";
export * from "./store.js";

export function resourceScopeKey(scope: ResourceScope): string { return JSON.stringify([scope.serverProfileId, scope.worldId, scope.dimension]); }
export function resourceItemKey(item: ResourceIdentity): string {
  const i = resourceIdentitySchema.parse(item); return JSON.stringify([i.itemId, i.minecraftVersion, i.catalogId, i.kind, i.variant]);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// Inventory/equipment are one disjoint pool each per Bot; changing a client
// label must not duplicate its count. Container identity includes its role.
const locationKey = (location: ResourceLocation) => location.kind === "container"
  ? JSON.stringify([location.kind, location.id, location.position, location.role]) : JSON.stringify([location.kind, location.botId]);
const sameItem = (a: ResourceIdentity, b: ResourceIdentity) => resourceItemKey(a) === resourceItemKey(b);
const scoped = (a: ResourceScope, b: ResourceScope) => resourceScopeKey(a) === resourceScopeKey(b);
const matches = (o: ResourceObservation, scope: ResourceScope, location: ResourceLocation, item: ResourceIdentity) =>
  scoped(o.scope, scope) && locationKey(o.location) === locationKey(location) && sameItem(o.identity, item);
const fresh = (o: ResourceObservation, now: number) => o.quantity !== null &&
  (o.status === "observed" || o.status === "confirmed") && Date.parse(o.observedAt) <= now && now < Date.parse(o.expiresAt);

export type ResourceLedgerOptions = { store?: ResourceStateStore; now?: () => number };
/** One authority for quantities and logistics. Every mutation commits a complete atomic snapshot before returning. */
export class ResourceLedger {
  private readonly store: ResourceStateStore;
  private readonly now: () => number;
  constructor(options: ResourceLedgerOptions = {}) { this.store = options.store ?? new MemoryResourceStateStore(); this.now = options.now ?? Date.now; }
  get durability(): ResourceStateStore["durability"] { return this.store.durability; }
  private mutate<T>(change: (state: ResourceState, now: number) => T): T {
    const state = this.store.load(), revision = state.revision;
    const result = change(state, this.now()); state.revision++;
    // save 内部先做权威 schema 校验再落盘（Memory/File 两个实现皆然）——
    // 此处不再重复 parse：校验失败时内存态/磁盘均不变，失败语义一致。
    this.store.save(state, revision);
    return structuredClone(result);
  }
  snapshot(scope: ResourceScope): ResourceState {
    resourceScopeSchema.parse(scope); const state = this.store.load();
    const transfers = state.transfers.filter(o => scoped(o.scope, scope));
    return { ...state, observations: state.observations.filter(o => scoped(o.scope, scope)).map(o => ({ ...o,
      status: fresh(o, this.now()) ? o.status : o.quantity === null ? "unknown" : "stale" })),
      reservations: state.reservations.filter(r => scoped(r.scope, scope)), transfers,
      demands: state.demands.filter(d => scoped(d.scope, scope)), receipts: state.receipts.filter(r => scoped(r.scope, scope)),
      outbox: state.outbox.filter(o => transfers.some(t => t.operationId === o.operationId)) };
  }
  observe(input: ResourceObservationInput): ResourceObservation {
    const o = resourceObservationInputSchema.parse(input);
    return this.mutate((state, now) => {
      if (Date.parse(o.observedAt) > now) throw new Error("RESOURCE_OBSERVATION_FROM_FUTURE");
      if (o.location.kind !== "container" && o.location.botId !== o.observerBotId) throw new Error("RESOURCE_OBSERVER_MISMATCH");
      const index = state.observations.findIndex(p => matches(p, o.scope, o.location, o.identity));
      const previous = state.observations[index];
      const duplicateId = state.observations.find(p => p.observationId === o.observationId);
      if (duplicateId && duplicateId !== previous) throw new Error("RESOURCE_OBSERVATION_CONFLICT");
      if (previous) {
        if (o.observationId === previous.observationId) {
          const { revision: _revision, expiresAt: _expiry, status: _status, ...original } = previous;
          if (!same(o, original)) throw new Error("RESOURCE_OBSERVATION_CONFLICT");
          return previous;
        }
        if (Date.parse(o.observedAt) < Date.parse(previous.observedAt) ||
          o.runtimeInstanceId === previous.runtimeInstanceId && o.sequence <= previous.sequence) throw new Error("RESOURCE_OBSERVATION_OUT_OF_ORDER");
      }
      const observation: ResourceObservation = { ...o, revision: (previous?.revision ?? 0) + 1,
        expiresAt: new Date(Date.parse(o.observedAt) + (o.location.kind === "container" ? 10_000 : 5_000)).toISOString(),
        status: o.quantity === null ? "unknown" : "observed" };
      if (index < 0) state.observations.push(observation); else state.observations[index] = observation;
      return observation;
    });
  }
  available(scope: ResourceScope, source: ResourceLocation, identity: ResourceIdentity, permission: ResourcePermission): number | null {
    return this.availableFrom(this.store.load(), scope, source, identity, resourcePermissionSchema.parse(permission), this.now());
  }
  private availableFrom(state: ResourceState, scope: ResourceScope, source: ResourceLocation, identity: ResourceIdentity, permission: ResourcePermission, now: number): number | null {
    if (scope.worldId === null || !permission.allowed || !permission.reachable || Date.parse(permission.expiresAt) <= now) return null;
    if (source.kind === "container" && !["shared", "output"].includes(source.role)) return null;
    if (state.transfers.some(t => scoped(t.scope, scope) && locationKey(t.source) === locationKey(source) &&
      sameItem(t.identity, identity) && t.dispatchedAt !== null && t.settledAt === null)) return null;
    const observed = state.observations.find(o => matches(o, scope, source, identity));
    if (!observed || !fresh(observed, now)) return null;
    const reserved = state.reservations.filter(r => scoped(r.scope, scope) && locationKey(r.source) === locationKey(source) &&
      sameItem(r.identity, identity) && (r.state === "held" || r.state === "active" && Date.parse(r.expiresAt) > now)).reduce((n, r) => n + r.quantity, 0);
    return Math.max(0, observed.quantity! - permission.minimumKeep - reserved);
  }
  demand(input: { scope: ResourceScope; botId: string; identity: ResourceIdentity; purpose: string; targetQuantity: number; maxAttempts?: number }): ResourceDemand {
    return this.mutate((s, now) => {
      const parsed = resourceDemandSchema.parse({ ...input, demandId: randomUUID(), attempts: 0, maxAttempts: input.maxAttempts ?? 3,
        state: "open", cooldownUntil: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
      const existing = s.demands.find(d => scoped(d.scope, parsed.scope) && d.botId === parsed.botId && sameItem(d.identity, parsed.identity) && d.purpose === parsed.purpose);
      if (existing) {
        const wasSatisfied = existing.state === "satisfied";
        existing.targetQuantity = Math.max(existing.targetQuantity, parsed.targetQuantity); existing.updatedAt = parsed.updatedAt;
        const balance = this.balance(s, existing.demandId, existing.scope, now);
        existing.state = balance.deficit === null ? "blocked" : balance.deficit === 0 && balance.pending === 0 ? "satisfied" : "open";
        if (wasSatisfied && existing.state === "open") { existing.attempts = 0; existing.cooldownUntil = parsed.cooldownUntil; }
        return existing;
      }
      s.demands.push(parsed);
      const balance = this.balance(s, parsed.demandId, parsed.scope, now);
      parsed.state = balance.deficit === null ? "blocked" : balance.deficit === 0 ? "satisfied" : "open";
      return parsed;
    });
  }
  /** Own inventory/equipment first. Pending transport is not counted as another spendable inventory. */
  demandBalance(demandId: string, scope: ResourceScope): { owned: number | null; pending: number; deficit: number | null } {
    return this.balance(this.store.load(), demandId, scope, this.now());
  }
  private balance(s: ResourceState, demandId: string, scope: ResourceScope, now: number) {
    const d = s.demands.find(d => d.demandId === demandId && scoped(d.scope, scope)); if (!d) throw new Error("RESOURCE_DEMAND_NOT_FOUND");
    const inventory = s.observations.filter(o => scoped(o.scope, scope) && o.location.botId === d.botId &&
      o.location.kind === "inventory" && sameItem(o.identity, d.identity));
    const owned = inventory.length === 0 || inventory.some(o => !fresh(o, now)) ? null :
      inventory.reduce((n, o) => n + o.quantity!, 0) + s.observations.filter(o => scoped(o.scope, scope) &&
        o.location.botId === d.botId && o.location.kind === "equipment" && sameItem(o.identity, d.identity) && fresh(o, now)).reduce((n, o) => n + o.quantity!, 0);
    const pending = s.transfers.filter(t => t.demandId === demandId && t.settledAt === null && t.state !== "cancelled").reduce((n, t) => n + t.quantity, 0);
    return { owned, pending, deficit: owned === null ? null : Math.max(0, d.targetQuantity - owned - pending) };
  }
  /** Reservation, transfer and delivery outbox are one durable transaction. */
  planTransfer(input: { operationId: string; taskId: string; demandId: string; scope: ResourceScope; botId: string;
    source: ResourceLocation; target: ResourceLocation; identity: ResourceIdentity; quantity: number; permission: ResourcePermission }): TransferOrder {
    const permission = resourcePermissionSchema.parse(input.permission), source = resourceLocationSchema.parse(input.source), target = resourceLocationSchema.parse(input.target);
    resourceScopeSchema.parse(input.scope); resourceIdentitySchema.parse(input.identity);
    return this.mutate((s, now) => {
      const existing = s.transfers.find(t => t.operationId === input.operationId);
      if (existing) {
        if (existing.taskId !== input.taskId || existing.demandId !== input.demandId || existing.botId !== input.botId ||
          existing.quantity !== input.quantity || !scoped(existing.scope, input.scope) || !sameItem(existing.identity, input.identity) ||
          !same(existing.source, source) || !same(existing.target, target)) throw new Error("RESOURCE_OPERATION_CONFLICT");
        return existing;
      }
      const demand = s.demands.find(d => d.demandId === input.demandId && scoped(d.scope, input.scope));
      if (!demand || demand.botId !== input.botId || !sameItem(demand.identity, input.identity) || demand.purpose !== permission.purpose) throw new Error("RESOURCE_DEMAND_MISMATCH");
      if (demand.attempts >= demand.maxAttempts || now < Date.parse(demand.cooldownUntil)) throw new Error("RESOURCE_DEMAND_COOLDOWN");
      const balance = this.balance(s, demand.demandId, input.scope, now);
      if (balance.deficit === null) throw new Error("RESOURCE_OWN_INVENTORY_UNKNOWN");
      if (balance.deficit === 0) throw new Error("RESOURCE_DEMAND_SATISFIED");
      if (source.kind !== "container" || target.kind !== "inventory" || target.botId !== input.botId) throw new Error("RESOURCE_TRANSFER_PATH_UNSUPPORTED");
      const available = this.availableFrom(s, input.scope, source, input.identity, permission, now);
      if (!Number.isSafeInteger(input.quantity) || input.quantity < 1 || input.quantity > balance.deficit || available === null || input.quantity > available) throw new Error("RESOURCE_UNAVAILABLE");
      const at = new Date(now).toISOString(), reservationId = randomUUID();
      s.reservations.push({ reservationId, taskId: input.taskId, scope: input.scope, subjectId: input.botId,
        source, identity: input.identity, quantity: input.quantity, state: "active", permission,
        expiresAt: new Date(Math.min(now + 30_000, Date.parse(permission.expiresAt))).toISOString(), reason: null });
      const order: TransferOrder = { operationId: input.operationId, taskId: input.taskId, reservationId, demandId: demand.demandId,
        scope: input.scope, botId: input.botId, source, target, identity: input.identity, quantity: input.quantity, confirmedMoved: 0,
        state: "planned", fence: 0, attemptId: null, runtimeInstanceId: null, leaseOwner: null, leaseExpiresAt: null,
        dispatchedAt: null, settledAt: null, cancelledAt: null, unresolvedReason: null, createdAt: at, updatedAt: at, checkpoint: "intent-persisted" };
      s.transfers.push(order); s.outbox.push({ messageId: randomUUID(), operationId: input.operationId, taskId: input.taskId,
        state: "pending", attempts: 0, lastError: null, availableAt: at, submittedAt: null });
      demand.attempts++; demand.cooldownUntil = new Date(now + 10_000).toISOString(); demand.updatedAt = at;
      return order;
    });
  }
  pendingOutbox(): Array<{ messageId: string; order: TransferOrder }> {
    const s = this.store.load(); return s.outbox.filter(o => o.state === "pending" && Date.parse(o.availableAt) <= this.now())
      .slice(0, 32).map(o => ({ messageId: o.messageId, order: s.transfers.find(t => t.operationId === o.operationId)! }));
  }
  noteSubmission(messageId: string, accepted: boolean, reason = "TASK_SUBMISSION_UNCERTAIN"): void {
    this.mutate((s, now) => { const o = s.outbox.find(o => o.messageId === messageId); if (!o || o.state !== "pending") return;
      o.attempts++; o.lastError = accepted ? null : reason;
      if (accepted) { o.state = "submitted"; o.submittedAt = new Date(now).toISOString(); }
      else o.availableAt = new Date(now + Math.min(60_000, 1000 * 2 ** Math.min(o.attempts, 6))).toISOString(); });
  }
  beginDispatch(input: { operationId: string; scope: ResourceScope; botId: string; taskId: string; runtimeInstanceId: string;
    leaseOwner: string; leaseExpiresAt: string; permission: ResourcePermission }): TransferOrder {
    return this.mutate((s, now) => {
      const t = this.requireOrder(s, input.operationId, input.scope);
      if (t.botId !== input.botId || t.taskId !== input.taskId) throw new Error("RESOURCE_EXECUTION_IDENTITY_MISMATCH");
      if (t.state !== "planned") throw new Error("RESOURCE_RECONCILIATION_REQUIRED");
      const r = s.reservations.find(r => r.reservationId === t.reservationId)!;
      const permission = resourcePermissionSchema.parse(input.permission);
      if (r.state !== "active" || Date.parse(r.expiresAt) <= now || !permission.allowed || !permission.reachable ||
        permission.policyRevision !== r.permission.policyRevision || permission.assetVersion !== r.permission.assetVersion ||
        permission.purpose !== r.permission.purpose || permission.minimumKeep !== r.permission.minimumKeep || Date.parse(permission.expiresAt) <= now) throw new Error("RESOURCE_PERMISSION_OR_RESERVATION_EXPIRED");
      if (!Number.isFinite(Date.parse(input.leaseExpiresAt)) || Date.parse(input.leaseExpiresAt) <= now) throw new Error("RESOURCE_EXECUTION_LEASE_EXPIRED");
      const observation = s.observations.find(o => matches(o, t.scope, t.source, t.identity));
      if (s.transfers.some(other => other.operationId !== t.operationId && other.dispatchedAt !== null && other.settledAt === null &&
        scoped(other.scope, t.scope) && locationKey(other.source) === locationKey(t.source) && sameItem(other.identity, t.identity))) throw new Error("RESOURCE_RECONCILIATION_REQUIRED");
      if (!observation || !fresh(observation, now) || observation.quantity! < t.quantity + permission.minimumKeep) throw new Error("RESOURCE_REOBSERVATION_REQUIRED");
      t.state = "dispatched"; t.fence++; t.attemptId = randomUUID(); t.runtimeInstanceId = input.runtimeInstanceId;
      t.leaseOwner = input.leaseOwner; t.leaseExpiresAt = input.leaseExpiresAt; t.dispatchedAt = new Date(now).toISOString();
      t.updatedAt = t.dispatchedAt; t.checkpoint = "dispatched"; r.state = "held"; observation.status = "stale";
      return t;
    });
  }
  interrupt(operationId: string, scope: ResourceScope, reason: string): TransferOrder {
    return this.mutate((s, now) => { const t = this.requireOrder(s, operationId, scope); if (t.settledAt !== null) return t;
      t.cancelledAt = new Date(now).toISOString(); t.unresolvedReason = reason; t.updatedAt = t.cancelledAt;
      const r = s.reservations.find(r => r.reservationId === t.reservationId)!;
      if (t.dispatchedAt === null) { t.state = "cancelled"; t.settledAt = t.cancelledAt; r.state = "released";
        for (const o of s.outbox.filter(o => o.operationId === operationId && o.state === "pending")) o.state = "cancelled";
      } else { t.state = "reconciling"; r.state = "held"; } r.reason = reason; return t; });
  }
  recordReceipt(input: ResourceReceipt): TransferOrder {
    const receipt = resourceReceiptSchema.parse(input);
    return this.mutate((s, now) => {
      const t = this.requireOrder(s, receipt.operationId, receipt.scope);
      if (t.attemptId !== receipt.attemptId || t.fence !== receipt.fence || t.taskId !== receipt.taskId ||
        t.botId !== receipt.botId || t.runtimeInstanceId !== receipt.runtimeInstanceId || !sameItem(t.identity, receipt.identity) ||
        receipt.moved !== null && receipt.moved > t.quantity || Date.parse(receipt.observedAt) > now ||
        Date.parse(receipt.observedAt) < Date.parse(t.dispatchedAt!)) throw new Error("RESOURCE_RECEIPT_MISMATCH");
      const previous = s.receipts.find(r => r.receiptId === receipt.receiptId);
      if (previous) { if (!same(previous, receipt)) throw new Error("RESOURCE_RECEIPT_CONFLICT"); return t; }
      if (receipt.moved !== null && receipt.moved < t.confirmedMoved) throw new Error("RESOURCE_RECEIPT_REGRESSION");
      s.receipts.push(receipt);
      if (t.settledAt !== null && receipt.outcome === "confirmed" && receipt.moved === t.confirmedMoved) return t;
      if (receipt.outcome === "confirmed") t.confirmedMoved = receipt.moved!;
      t.state = t.confirmedMoved > 0 ? "partially-confirmed" : "reconciling";
      t.unresolvedReason = t.cancelledAt !== null || now >= Date.parse(t.leaseExpiresAt!) ? "LATE_EFFECT_REQUIRES_RECONCILIATION" : "POST_TRANSFER_OBSERVATION_REQUIRED";
      t.settledAt = null; t.checkpoint = "receipt-recorded"; t.updatedAt = new Date(now).toISOString();
      // External hopper/player deltas are not attributed to this Bot. Invalidate
      // old inventory facts until an independent read observes the actual result.
      for (const o of s.observations) if (matches(o, t.scope, t.source, t.identity) || matches(o, t.scope, t.target, t.identity)) o.status = "stale";
      return t;
    });
  }
  reconcile(input: { operationId: string; scope: ResourceScope; receiptId: string; sourceObservationId: string; targetObservationId: string }): TransferOrder {
    return this.mutate((s, now) => {
      const t = this.requireOrder(s, input.operationId, input.scope);
      const receipt = s.receipts.find(r => r.receiptId === input.receiptId && r.operationId === t.operationId && r.outcome === "confirmed");
      const source = s.observations.find(o => o.observationId === input.sourceObservationId && matches(o, t.scope, t.source, t.identity));
      const target = s.observations.find(o => o.observationId === input.targetObservationId && matches(o, t.scope, t.target, t.identity));
      if (!receipt || receipt.moved !== t.confirmedMoved || !source || !target || !fresh(source, now) || !fresh(target, now) ||
        Date.parse(source.observedAt) < Date.parse(receipt.observedAt) || Date.parse(target.observedAt) < Date.parse(receipt.observedAt)) throw new Error("RESOURCE_RECONCILIATION_EVIDENCE_REQUIRED");
      t.state = t.confirmedMoved === t.quantity ? "completed" : "partially-confirmed"; t.settledAt = new Date(now).toISOString();
      t.updatedAt = t.settledAt; t.checkpoint = "reconciled"; t.unresolvedReason = null;
      source.status = "confirmed"; target.status = "confirmed";
      const r = s.reservations.find(r => r.reservationId === t.reservationId)!; r.state = t.confirmedMoved > 0 ? "consumed" : "released";
      const d = s.demands.find(d => d.demandId === t.demandId)!;
      const balance = this.balance(s, d.demandId, d.scope, now); d.state = balance.deficit === 0 ? "satisfied" : "open";
      return t;
    });
  }
  /** Called by existing Coordinator recovery/tick; expired actions remain quarantined. */
  expireReservations(): number {
    return this.mutate((s, now) => { let expired = 0;
      for (const r of s.reservations) if (r.state === "active" && Date.parse(r.expiresAt) <= now) {
        const t = s.transfers.find(t => t.reservationId === r.reservationId)!;
        r.state = "released"; r.reason = "RESERVATION_EXPIRED"; t.state = "cancelled";
        t.settledAt = new Date(now).toISOString(); t.unresolvedReason = r.reason;
        for (const o of s.outbox.filter(o => o.operationId === t.operationId && o.state === "pending")) o.state = "cancelled"; expired++;
      }
      for (const t of s.transfers) if (t.dispatchedAt !== null && t.settledAt === null && Date.parse(t.leaseExpiresAt!) <= now) {
        t.state = "reconciling"; t.unresolvedReason = "EXECUTION_LEASE_EXPIRED";
        const reservation = s.reservations.find(r => r.reservationId === t.reservationId)!;
        if (reservation.state === "held" && now >= Math.max(Date.parse(t.leaseExpiresAt!), Date.parse(reservation.expiresAt)) + 120_000) {
          reservation.state = "released"; reservation.reason = "UNRESOLVED_SOURCE_QUARANTINED";
        }
      }
      return expired;
    });
  }
  private requireOrder(s: ResourceState, operationId: string, scope: ResourceScope): TransferOrder {
    const t = s.transfers.find(t => t.operationId === operationId && scoped(t.scope, scope));
    if (!t) throw new Error("RESOURCE_TRANSFER_NOT_FOUND"); return t;
  }
}
export class DurableResourceLedger extends ResourceLedger {
  constructor(filename: string, options: Omit<ResourceLedgerOptions, "store"> = {}) { super({ ...options, store: new FileResourceStateStore(filename) }); }
}

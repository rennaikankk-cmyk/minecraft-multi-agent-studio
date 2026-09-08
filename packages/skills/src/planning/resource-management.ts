import { z } from "zod";

export const resourceStatusSchema = z.enum(["observed", "stale", "unknown", "reserved", "in-transit", "confirmed"]);
export type ResourceStatus = z.infer<typeof resourceStatusSchema>;
export const resourceScopeSchema = z.object({ serverProfileId: z.string().min(1), worldId: z.string().min(1), dimension: z.string().min(1) }).strict();
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export interface ResourceObservation { scope: ResourceScope; containerId: string; itemId: string; quantity: number; status: ResourceStatus; revision: number; observedAt: string; }
export interface ResourceReservation { reservationId: string; scope: ResourceScope; subjectId: string; containerId: string; itemId: string; quantity: number; state: "active" | "released" | "consumed"; }
export type TransferState = "planned" | "dispatched" | "partially-confirmed" | "reconciling" | "completed";
export interface TransferOrder { operationId: string; taskId: string; reservationId: string; scope: ResourceScope; source: string; target: string; itemId: string; quantity: number; state: TransferState; receipt?: { moved: number; observedAt: string }; }

/** Coordinator-owned resource ledger. Runtime reports observations; callers cannot invent inventory. */
export class ResourceLedger {
  private readonly observations = new Map<string, ResourceObservation>();
  private readonly reservations = new Map<string, ResourceReservation>();
  private readonly transfers = new Map<string, TransferOrder>();
  observe(input: ResourceObservation): void { if (!Number.isSafeInteger(input.quantity) || input.quantity < 0) throw new Error("INVALID_QUANTITY"); this.observations.set(this.key(input.scope, input.containerId, input.itemId), structuredClone(input)); }
  get(scope: ResourceScope, containerId: string, itemId: string): ResourceObservation | undefined { const value = this.observations.get(this.key(scope, containerId, itemId)); return value && structuredClone(value); }
  available(scope: ResourceScope, containerId: string, itemId: string): number | undefined { const value = this.get(scope, containerId, itemId); if (!value || value.status !== "observed" && value.status !== "confirmed") return undefined; const reserved = [...this.reservations.values()].filter(r => r.state === "active" && r.containerId === containerId && r.itemId === itemId && this.sameScope(r.scope, scope)).reduce((sum, r) => sum + r.quantity, 0); return Math.max(0, value.quantity - reserved); }
  markStale(scope: ResourceScope, containerId: string, itemId: string): void { const key = this.key(scope, containerId, itemId); const value = this.observations.get(key); if (value) value.status = "stale"; }
  reserve(input: ResourceReservation): ResourceReservation { if (input.quantity <= 0 || input.state !== "active") throw new Error("RESERVATION_INVALID"); if (this.reservations.has(input.reservationId)) return structuredClone(this.reservations.get(input.reservationId)!); const available = this.available(input.scope, input.containerId, input.itemId); if (available === undefined || input.quantity > available) throw new Error("RESOURCE_UNAVAILABLE"); this.reservations.set(input.reservationId, structuredClone(input)); return structuredClone(input); }
  release(reservationId: string): void { const value = this.reservations.get(reservationId); if (value?.state === "active") value.state = "released"; }
  createTransfer(input: TransferOrder): TransferOrder { if (!this.reservations.has(input.reservationId)) throw new Error("RESERVATION_NOT_FOUND"); const existing = this.transfers.get(input.operationId); if (existing) return structuredClone(existing); this.transfers.set(input.operationId, structuredClone(input)); return structuredClone(input); }
  recordReceipt(operationId: string, moved: number, observedAt: string): TransferOrder { const order = this.transfers.get(operationId); if (!order) throw new Error("TRANSFER_NOT_FOUND"); if (!Number.isSafeInteger(moved) || moved < 0 || moved > order.quantity) throw new Error("RECEIPT_INVALID"); order.receipt = { moved, observedAt }; order.state = moved === order.quantity ? "completed" : moved > 0 ? "partially-confirmed" : "reconciling"; if (order.state === "completed") { const reservation = this.reservations.get(order.reservationId); if (reservation) reservation.state = "consumed"; } return structuredClone(order); }
  snapshot(): { observations: ResourceObservation[]; reservations: ResourceReservation[]; transfers: TransferOrder[] } { return { observations: [...this.observations.values()].map((value) => structuredClone(value)), reservations: [...this.reservations.values()].map((value) => structuredClone(value)), transfers: [...this.transfers.values()].map((value) => structuredClone(value)) }; }
  private key(scope: ResourceScope, containerId: string, itemId: string): string { return `${scope.serverProfileId}\u0000${scope.worldId}\u0000${scope.dimension}\u0000${containerId}\u0000${itemId}`; }
  private sameScope(a: ResourceScope, b: ResourceScope): boolean { return a.serverProfileId === b.serverProfileId && a.worldId === b.worldId && a.dimension === b.dimension; }
}


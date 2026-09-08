import { z } from "zod";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_][A-Za-z0-9_.:-]*$/u);
const time = z.string().datetime({ offset: true });
const amount = z.number().int().nonnegative().max(2_147_483_647);
export const resourceScopeSchema = z.object({ serverProfileId: id, worldId: id.nullable(),
  dimension: z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u) }).strict();
export const resourceIdentitySchema = z.object({ itemId: z.string().regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u).max(128),
  minecraftVersion: z.string().min(1).max(32), catalogId: amount,
  kind: z.enum(["material", "equipment", "packed-container"]),
  /** Hash of canonical NBT/components, including damage/enchantments; plain is only for verified plain materials. */
  variant: z.union([z.literal("plain"), z.string().regex(/^[a-f0-9]{64}$/u)]),
}).strict().refine(i => i.kind === "material" || i.variant !== "plain", "Equipment and packed items require a component fingerprint.");
export const resourceLocationSchema = z.object({ id,
  kind: z.enum(["inventory", "equipment", "container"]), botId: id.nullable(),
  position: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict().nullable(),
  role: z.enum(["personal", "shared", "output", "private", "input", "filter", "internal", "unknown"]),
}).strict().refine(l => l.kind === "container" ? l.position !== null && l.botId === null && l.role !== "personal"
  : l.botId !== null && l.position === null && l.role === "personal", "Resource location identity is inconsistent.");
export const resourceStatusSchema = z.enum(["observed", "stale", "unknown", "reserved", "in-transit", "confirmed"]);
export const resourceObservationInputSchema = z.object({ observationId: id, scope: resourceScopeSchema,
  location: resourceLocationSchema, identity: resourceIdentitySchema, quantity: amount.nullable(),
  observedAt: time, observerBotId: id, runtimeInstanceId: id, sequence: amount,
  evidenceRef: id,
}).strict();
export const resourceObservationSchema = resourceObservationInputSchema.extend({ revision: amount,
  status: z.enum(["observed", "stale", "unknown", "confirmed"]), expiresAt: time });
export const resourcePermissionSchema = z.object({ allowed: z.boolean(), reachable: z.boolean(),
  purpose: id, policyRevision: amount, assetVersion: id, expiresAt: time, minimumKeep: amount,
}).strict();
export const resourceReservationSchema = z.object({ reservationId: id, taskId: id, scope: resourceScopeSchema,
  subjectId: id, source: resourceLocationSchema, identity: resourceIdentitySchema, quantity: amount.refine(n => n > 0),
  state: z.enum(["active", "held", "released", "consumed"]), expiresAt: time,
  permission: resourcePermissionSchema, reason: id.nullable(),
}).strict();
export const resourceDemandSchema = z.object({ demandId: id, scope: resourceScopeSchema, botId: id, identity: resourceIdentitySchema,
  purpose: id, targetQuantity: amount.refine(n => n > 0), state: z.enum(["open", "satisfied", "blocked"]),
  attempts: amount, maxAttempts: z.number().int().min(1).max(10), cooldownUntil: time, updatedAt: time,
}).strict();
export const resourceTransferSchema = z.object({ operationId: z.string().uuid(), taskId: z.string().uuid(), reservationId: z.string().uuid(), demandId: z.string().uuid(),
  scope: resourceScopeSchema, botId: id, source: resourceLocationSchema, target: resourceLocationSchema,
  identity: resourceIdentitySchema, quantity: amount.refine(n => n > 0), confirmedMoved: amount,
  state: z.enum(["planned", "dispatched", "partially-confirmed", "reconciling", "completed", "cancelled"]),
  fence: amount, attemptId: id.nullable(), runtimeInstanceId: id.nullable(), leaseOwner: id.nullable(), leaseExpiresAt: time.nullable(),
  dispatchedAt: time.nullable(), settledAt: time.nullable(), cancelledAt: time.nullable(), unresolvedReason: id.nullable(),
  createdAt: time, updatedAt: time, checkpoint: z.enum(["intent-persisted", "dispatched", "receipt-recorded", "reconciled"]),
}).strict();
export const resourceReceiptSchema = z.object({ receiptId: id, operationId: id, taskId: id, attemptId: id, fence: amount,
  scope: resourceScopeSchema, botId: id, runtimeInstanceId: id, identity: resourceIdentitySchema,
  observedAt: time, outcome: z.enum(["confirmed", "ambiguous"]), moved: amount.nullable(),
  evidenceRef: id, sourceRemaining: amount.nullable(),
}).strict().refine(r => r.outcome === "ambiguous" || r.moved !== null, "Confirmed receipts require an actual moved quantity.");
export const resourceOutboxSchema = z.object({ messageId: id, operationId: id, taskId: id,
  state: z.enum(["pending", "submitted", "cancelled"]), attempts: amount, lastError: id.nullable(),
  availableAt: time, submittedAt: time.nullable(),
}).strict();
export const resourceStateSchema = z.object({ schemaVersion: z.literal("2.0"), revision: amount,
  observations: z.array(resourceObservationSchema).max(100_000), reservations: z.array(resourceReservationSchema).max(100_000),
  transfers: z.array(resourceTransferSchema).max(100_000), receipts: z.array(resourceReceiptSchema).max(100_000),
  demands: z.array(resourceDemandSchema).max(100_000), outbox: z.array(resourceOutboxSchema).max(100_000),
}).strict().superRefine((s, context) => {
  const reservations = new Map(s.reservations.map(r => [r.reservationId, r]));
  const transfers = new Map(s.transfers.map(t => [t.operationId, t]));
  const demands = new Map(s.demands.map(d => [d.demandId, d]));
  const invalid = (message: string) => context.addIssue({ code: "custom", message });
  if (reservations.size !== s.reservations.length || transfers.size !== s.transfers.length || demands.size !== s.demands.length ||
    new Set(s.receipts.map(r => r.receiptId)).size !== s.receipts.length ||
    new Set(s.outbox.map(o => o.messageId)).size !== s.outbox.length ||
    new Set(s.observations.map(o => o.observationId)).size !== s.observations.length) invalid("Resource records must have unique durable identities.");
  for (const t of s.transfers) {
    const reservation = reservations.get(t.reservationId), demand = demands.get(t.demandId);
    if (!reservation || !demand || reservation.taskId !== t.taskId || reservation.subjectId !== t.botId || demand.botId !== t.botId ||
      JSON.stringify(reservation.scope) !== JSON.stringify(t.scope) || JSON.stringify(demand.scope) !== JSON.stringify(t.scope) ||
      JSON.stringify(reservation.identity) !== JSON.stringify(t.identity) || t.confirmedMoved > t.quantity) invalid("Transfer references must preserve scope, owner and item identity.");
  }
  for (const o of s.outbox) if (transfers.get(o.operationId)?.taskId !== o.taskId) invalid("Outbox must reference its durable task.");
  for (const receipt of s.receipts) {
    const t = transfers.get(receipt.operationId);
    if (!t || t.taskId !== receipt.taskId || t.botId !== receipt.botId || t.attemptId !== receipt.attemptId ||
      t.fence !== receipt.fence || JSON.stringify(t.scope) !== JSON.stringify(receipt.scope)) invalid("Receipt references must preserve the issued execution identity.");
  }
});
export type ResourceScope = z.infer<typeof resourceScopeSchema>;
export type ResourceIdentity = z.infer<typeof resourceIdentitySchema>;
export type ResourceLocation = z.infer<typeof resourceLocationSchema>;
export type ResourceObservationInput = z.infer<typeof resourceObservationInputSchema>;
export type ResourceObservation = z.infer<typeof resourceObservationSchema>;
export type ResourceReservation = z.infer<typeof resourceReservationSchema>;
export type ResourcePermission = z.infer<typeof resourcePermissionSchema>;
export type TransferOrder = z.infer<typeof resourceTransferSchema>;
export type TransferState = TransferOrder["state"];
export type ResourceDemand = z.infer<typeof resourceDemandSchema>;
export type ResourceReceipt = z.infer<typeof resourceReceiptSchema>;
export type ResourceOutbox = z.infer<typeof resourceOutboxSchema>;
export type ResourceState = z.infer<typeof resourceStateSchema>;
export type ResourceStatus = z.infer<typeof resourceStatusSchema>;

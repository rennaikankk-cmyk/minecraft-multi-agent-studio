import { z } from "zod";
export const scopeSchema = z.object({ serverProfileId: z.string().min(1), worldId: z.string().min(1), dimension: z.string().min(1) }).strict();
export type Scope = z.infer<typeof scopeSchema>;
export const positionSchema = z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).strict();
export type Position = z.infer<typeof positionSchema>;
export type BaseStage = "candidate" | "surveying" | "moving" | "home_pending" | "settled" | "invalid";
export type BedMarkerStatus = "pending" | "bed_confirmed" | "sign_confirmed" | "confirmed" | "invalid";
export interface BedMarkerRecord { botId: string; bed: Position; sign: Position; signText: string; status: BedMarkerStatus; verifiedAt?: string; }
export interface BaseRecord { baseId: string; scope: Scope; ownerId: string; center: Position; stage: BaseStage; invitedBy?: string; beds: Record<string, BedMarkerRecord>; }
export interface Invitation { invitationId: string; scope: Scope; senderName: string; senderUuid?: string; center: Position; message: string; createdAt: string; }
export interface IdentityVerifier { verify(scope: Scope, senderName: string, senderUuid?: string): boolean; }
const invitationPattern = /(?:base|基地|搬来|搬過來|move\s+in|come\s+live|live\s+here)/i;
export class BaseManagement {
  readonly #bases = new Map<string, BaseRecord>(); readonly #invitations = new Map<string, Invitation>();
  constructor(private readonly identity: IdentityVerifier, private readonly now: () => string = () => new Date().toISOString()) {}
  acceptInvitation(input: Omit<Invitation, "createdAt">): Invitation | undefined { if (!invitationPattern.test(input.message) || !this.identity.verify(input.scope, input.senderName, input.senderUuid)) return undefined; const invitation = { ...input, createdAt: this.now() }; this.#invitations.set(input.invitationId, invitation); return invitation; }
  createBase(base: Omit<BaseRecord, "beds"> & { beds?: Record<string, BedMarkerRecord> }): BaseRecord { const record: BaseRecord = { ...base, beds: base.beds ?? {} }; this.#bases.set(record.baseId, record); return structuredClone(record); }
  get(baseId: string): BaseRecord | undefined { const b = this.#bases.get(baseId); return b && structuredClone(b); }
  beginMove(baseId: string, botId: string): BaseRecord { const b = this.#require(baseId); b.stage = "moving"; if (!b.beds[botId]) b.beds[botId] = { botId, bed: { x: 0, y: 0, z: 0 }, sign: { x: 0, y: 0, z: 0 }, signText: "", status: "pending" }; return structuredClone(b); }
  confirmBed(baseId: string, botId: string, bed: Position): BaseRecord { const b = this.#require(baseId); const existing = b.beds[botId] ?? { botId, bed, sign: bed, signText: "", status: "pending" }; existing.bed = bed; existing.status = "bed_confirmed"; b.beds[botId] = existing; return structuredClone(b); }
  confirmSign(baseId: string, botId: string, sign: Position, signText: string): BaseRecord { const b = this.#require(baseId); const existing = b.beds[botId] ?? { botId, bed: sign, sign, signText, status: "pending" }; existing.sign = sign; existing.signText = signText; existing.status = existing.status === "bed_confirmed" && signText.includes(botId) ? "confirmed" : "sign_confirmed"; if (existing.status === "confirmed") { existing.verifiedAt = this.now(); b.stage = "settled"; } b.beds[botId] = existing; return structuredClone(b); }
  invalidateBed(baseId: string, botId: string): BaseRecord { const b = this.#require(baseId); const r = b.beds[botId]; if (r) { r.status = "invalid"; if (b.stage === "settled") b.stage = "home_pending"; } return structuredClone(b); }
  #require(id: string): BaseRecord { const b = this.#bases.get(id); if (!b) throw new Error(`BASE_NOT_FOUND:${id}`); return b; }
}
export type AssetKind = "machine" | "unknown_structure" | "shared_container" | "output" | "private_container" | "workstation" | "farm";
export type AssetAction = "dig" | "place" | "use" | "interact" | "container-transfer" | "fluid" | "entity";
export interface AssetRecord { assetId: string; scope: Scope; kind: AssetKind; role?: "input" | "output" | "filter" | "internal"; owner: "bot" | "player" | "unknown"; version: number; protected: boolean; }
export interface Authorization { subjectId: string; assetId: string; scope: Scope; action: AssetAction; policyRevision: number; expiresAt?: string; }
export class AssetPolicy {
  readonly #assets = new Map<string, AssetRecord>(); readonly #grants = new Map<string, Authorization>();
  register(asset: AssetRecord): AssetRecord { this.#assets.set(asset.assetId, structuredClone(asset)); return structuredClone(asset); }
  grant(auth: Authorization): boolean { const asset = this.#assets.get(auth.assetId); if (!asset || asset.scope.serverProfileId !== auth.scope.serverProfileId || asset.scope.worldId !== auth.scope.worldId || asset.scope.dimension !== auth.scope.dimension) return false; if (asset.protected && auth.action !== "container-transfer" && asset.role !== "output") return false; this.#grants.set(`${auth.subjectId}:${auth.assetId}:${auth.action}`, structuredClone(auth)); return true; }
  authorize(subjectId: string, assetId: string, action: AssetAction, scope: Scope, now = new Date()): { allowed: boolean; reason: string } { const a = this.#assets.get(assetId); if (!a) return { allowed: false, reason: "ASSET_UNKNOWN" }; if (a.scope.serverProfileId !== scope.serverProfileId || a.scope.worldId !== scope.worldId || a.scope.dimension !== scope.dimension) return { allowed: false, reason: "SCOPE_MISMATCH" }; if (a.protected && !(action === "container-transfer" && a.role === "output")) return { allowed: false, reason: "PROTECTED" }; const g = this.#grants.get(`${subjectId}:${assetId}:${action}`); if (!g || g.policyRevision !== a.version || (g.expiresAt && new Date(g.expiresAt) <= now)) return { allowed: false, reason: "NO_VALID_GRANT" }; return { allowed: true, reason: "AUTHORIZED" }; }
}
export type ObservationStatus = "observed" | "stale" | "unknown";
export interface InventoryObservation { containerId: string; itemId: string; quantity: number; status: ObservationStatus; observedAt: string; revision: number; }
export interface Reservation { reservationId: string; subjectId: string; containerId: string; itemId: string; quantity: number; state: "active" | "released" | "consumed"; }
export type TransferState = "planned" | "dispatched" | "partially-confirmed" | "reconciling" | "completed";
export interface TransferOrder { operationId: string; reservationId: string; taskId: string; source: string; target: string; itemId: string; quantity: number; state: TransferState; }
export class ResourceManagement {
  readonly #observations = new Map<string, InventoryObservation>(); readonly #reservations = new Map<string, Reservation>(); readonly #transfers = new Map<string, TransferOrder>();
  observe(o: InventoryObservation): void { if (o.quantity < 0 || !Number.isInteger(o.quantity)) throw new Error("INVALID_QUANTITY"); this.#observations.set(`${o.containerId}:${o.itemId}`, structuredClone(o)); }
  available(containerId: string, itemId: string): number | undefined { const o = this.#observations.get(`${containerId}:${itemId}`); if (!o || o.status !== "observed") return undefined; const reserved = [...this.#reservations.values()].filter(r => r.containerId === containerId && r.itemId === itemId && r.state === "active").reduce((n, r) => n + r.quantity, 0); return Math.max(0, o.quantity - reserved); }
  reserve(r: Reservation): Reservation { const available = this.available(r.containerId, r.itemId); if (available === undefined || r.quantity <= 0 || r.quantity > available) throw new Error("RESOURCE_UNAVAILABLE"); if (this.#reservations.has(r.reservationId)) return structuredClone(this.#reservations.get(r.reservationId)!); this.#reservations.set(r.reservationId, structuredClone(r)); return structuredClone(r); }
  release(id: string): void { const r = this.#reservations.get(id); if (r && r.state === "active") r.state = "released"; }
  createTransfer(order: TransferOrder): TransferOrder { if (!this.#reservations.has(order.reservationId)) throw new Error("RESERVATION_NOT_FOUND"); if (this.#transfers.has(order.operationId)) return structuredClone(this.#transfers.get(order.operationId)!); this.#transfers.set(order.operationId, structuredClone(order)); return structuredClone(order); }
  updateTransfer(operationId: string, state: TransferState): TransferOrder { const t = this.#transfers.get(operationId); if (!t) throw new Error("TRANSFER_NOT_FOUND"); t.state = state; if (state === "completed") { const r = this.#reservations.get(t.reservationId); if (r) r.state = "consumed"; } return structuredClone(t); }
}
export type ArmorSlot = "head" | "chest" | "legs" | "feet";
export interface ArmorItem { slot: ArmorSlot; material: "diamond" | "netherite" | "iron" | "other"; durability: number; maxDurability: number; enchantmentLevel?: number; }
export interface SurvivalSnapshot { food: number; health: number; armor: Partial<Record<ArmorSlot, ArmorItem>>; }
export class SurvivalManagement {
  constructor(private readonly foodReserve = 16) {}
  needs(s: SurvivalSnapshot): string[] { const needs: string[] = []; if (s.food < this.foodReserve) needs.push("food"); for (const slot of ["head", "chest", "legs", "feet"] as const) { const item = s.armor[slot]; if (!item || item.maxDurability <= 0 || item.durability / item.maxDurability < 0.2) needs.push(`armor:${slot}`); } return needs; }
  shouldUpgrade(current: ArmorItem | undefined, candidate: ArmorItem): boolean { if (candidate.material !== "netherite" && candidate.material !== "diamond") return false; if (!current) return true; const rank = (m: ArmorItem["material"]) => m === "netherite" ? 2 : m === "diamond" ? 1 : 0; return rank(candidate.material) > rank(current.material) || (candidate.material === current.material && (candidate.enchantmentLevel ?? 0) > (current.enchantmentLevel ?? 0)); }
}

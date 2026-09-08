import { SkillFault, type MaybeAsyncWorkstationRegistryPort } from '@minecraft-studio/skills';
import { type BlockPosition, type WorkstationLease, type WorkstationLeaseOwner } from '@minecraft-studio/asset-policy';

const LEASE_TTL_MS = 30_000;
const RENEW_INTERVAL_MS = 5_000;

/** Resource ownership only. Movement and inventory remain under the existing action locks. */
export class ActiveWorkstationLease {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private validUntil = Date.now() + LEASE_TTL_MS;
  readonly signal: AbortSignal;

  private constructor(private readonly registry: MaybeAsyncWorkstationRegistryPort,
    private readonly scope: { serverProfileId: string; dimension: string; position: BlockPosition; botId: string },
    readonly identity: WorkstationLease, signal: AbortSignal) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.scheduleRenewal();
  }

  static async acquire(registry: MaybeAsyncWorkstationRegistryPort,
    scope: { serverProfileId: string; dimension: string; position: BlockPosition; botId: string },
    owner: WorkstationLeaseOwner, signal: AbortSignal): Promise<ActiveWorkstationLease> {
    if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
    const { serverProfileId: s, dimension: d, position: p, botId: b } = scope;
    const started = Date.now();
    let acquired;
    try { acquired = await registry.claim(s, d, p, b, LEASE_TTL_MS, owner); }
    catch { throw new SkillFault("WORKSTATION_LEASE_UNAVAILABLE"); }
    if (!acquired) throw new SkillFault("WORKSTATION_BUSY");
    const identity = (await registry.get(s, d, p))?.lease;
    if (!identity || identity.ownerBotId !== b || identity.ownerRuntimeId !== owner.ownerRuntimeId ||
      identity.ownerTaskId !== owner.ownerTaskId || identity.ownerAttemptId !== owner.ownerAttemptId) {
      throw new SkillFault("WORKSTATION_LEASE_LOST");
    }
    const lease = new ActiveWorkstationLease(registry, scope, identity, signal);
    lease.validUntil = started + LEASE_TTL_MS;
    lease.armExpiry();
    return lease;
  }

  private armExpiry(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => this.controller.abort(), Math.max(0, this.validUntil - Date.now()));
    this.expiryTimer.unref?.();
  }

  async assertCurrent(): Promise<void> {
    if (this.signal.aborted || this.closed || Date.now() >= this.validUntil) throw new SkillFault("WORKSTATION_LEASE_LOST");
    const { serverProfileId: s, dimension: d, position: p, botId: b } = this.scope;
    let valid = false;
    try { valid = await this.registry.commit(s, d, p, b, this.identity); } catch { /* authority unavailable */ }
    if (!valid || this.signal.aborted || Date.now() >= this.validUntil) {
      this.controller.abort();
      throw new SkillFault("WORKSTATION_LEASE_LOST");
    }
  }

  private scheduleRenewal(): void {
    this.timer = setTimeout(() => { void this.renew(); }, RENEW_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async renew(): Promise<void> {
    if (this.closed || this.signal.aborted) return;
    const { serverProfileId: s, dimension: d, position: p, botId: b } = this.scope;
    const started = Date.now();
    let renewed = false;
    try { renewed = await this.registry.renewClaim(s, d, p, b, LEASE_TTL_MS, this.identity); } catch { /* stop new effects */ }
    if (this.closed) return;
    if (!renewed || Date.now() >= this.validUntil) { this.controller.abort(); return; }
    this.validUntil = started + LEASE_TTL_MS;
    this.armExpiry();
    this.scheduleRenewal();
  }

  async release(): Promise<void> {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    const { serverProfileId: s, dimension: d, position: p, botId: b } = this.scope;
    await this.registry.release(s, d, p, b, this.identity);
  }
}

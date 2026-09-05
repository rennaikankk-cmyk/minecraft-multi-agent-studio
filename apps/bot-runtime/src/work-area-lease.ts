import { SkillFault, WORK_AREA_LEASE_TTL_MS, type WorkArea, type WorkAreaLeasePort, type WorkAreaProof } from "@minecraft-studio/skills";

export async function withWorkAreaLease<T>(port: WorkAreaLeasePort, area: WorkArea, owner: string,
  signal: AbortSignal, work: (leaseId: string, signal: AbortSignal, assertCurrent: () => Promise<void>) => Promise<T>): Promise<T> {
  if (signal.aborted) throw new SkillFault("SKILL_CANCELLED");
  const started = Date.now();
  let lease;
  try { lease = await port.claim({ area, owner }); }
  catch (error) {
    throw new SkillFault(error instanceof Error && error.message === "WORK_AREA_BUSY" ? "WORK_AREA_BUSY" : "WORLD_ASSET_AUTHORITY_UNAVAILABLE");
  }
  const proof: WorkAreaProof = { leaseId: lease.leaseId, owner };
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  let deadline = started + WORK_AREA_LEASE_TTL_MS;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  const armExpiry = () => {
    clearTimeout(expiry);
    expiry = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
    expiry.unref?.();
  };
  const renew = async () => {
    const sent = Date.now();
    try {
      await port.renew(proof);
      if (closed) return;
      if (Date.now() >= deadline) { controller.abort(); return; }
      deadline = sent + WORK_AREA_LEASE_TTL_MS;
      armExpiry(); schedule();
    } catch { controller.abort(); }
  };
  const schedule = () => { timer = setTimeout(() => { void renew(); }, 5_000); timer.unref?.(); };
  const assertCurrent = async () => {
    if (combined.aborted || Date.now() >= deadline) throw new SkillFault("WORK_AREA_LEASE_LOST");
    let valid = false;
    try { valid = await port.validate(proof); } catch { /* authority failure stops new effects */ }
    if (!valid || combined.aborted || Date.now() >= deadline) {
      controller.abort(); throw new SkillFault("WORK_AREA_LEASE_LOST");
    }
  };
  armExpiry(); schedule();
  try { await assertCurrent(); return await work(lease.leaseId, combined, assertCurrent); }
  finally {
    closed = true;
    clearTimeout(timer); clearTimeout(expiry);
    await port.release(proof);
  }
}

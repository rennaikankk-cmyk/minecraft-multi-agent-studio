import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryWorkstationRegistry } from '@minecraft-studio/asset-policy';
import { ActiveWorkstationLease } from "../src/workstation-lease.js";

const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld", position: { x: 0, y: 64, z: 0 }, botId: "a" };
const owner = { ownerRuntimeId: "runtime-a", ownerTaskId: "task-a", ownerAttemptId: "attempt-a" };
const claim = (registry: InMemoryWorkstationRegistry, botId = "b", runtime = "runtime-b") =>
  registry.claim(scope.serverProfileId, scope.dimension, scope.position, botId, 30_000, { ...owner, ownerRuntimeId: runtime });

afterEach(() => vi.useRealTimers());
describe("Runtime workstation authority", () => {
  it("renews a 45 second operation, fencing competing bots throughout", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryWorkstationRegistry();
    registry.register(scope.serverProfileId, scope.dimension, "furnace", scope.position);
    const lease = await ActiveWorkstationLease.acquire(registry, scope, owner, new AbortController().signal);
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
      expect(claim(registry)).toBe(false);
      await lease.assertCurrent();
    }
    await lease.release();
    expect(claim(registry)).toBe(true);
  });

  it("expired and previous-runtime proofs cannot renew, release or commit", async () => {
    vi.useFakeTimers();
    const registry = new InMemoryWorkstationRegistry();
    registry.register(scope.serverProfileId, scope.dimension, "furnace", scope.position);
    claim(registry, "a", "old-runtime");
    const old = structuredClone(registry.get(scope.serverProfileId, scope.dimension, scope.position)!.lease!);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(registry.renewClaim(scope.serverProfileId, scope.dimension, scope.position, "a", 30_000, old)).toBe(false);
    expect(claim(registry, "a", "new-runtime")).toBe(true);
    const current = registry.get(scope.serverProfileId, scope.dimension, scope.position)!.lease!;
    expect(current.generation).toBeGreaterThan(old.generation);
    expect(registry.commit(scope.serverProfileId, scope.dimension, scope.position, "a", old)).toBe(false);
    registry.release(scope.serverProfileId, scope.dimension, scope.position, "a", old);
    expect(registry.commit(scope.serverProfileId, scope.dimension, scope.position, "a", current)).toBe(true);
  });

  it.each(["outage", "hung", "cancel"])("stops new effects on %s without claiming stop acknowledgement", async (mode) => {
    vi.useFakeTimers();
    const registry = new InMemoryWorkstationRegistry();
    registry.register(scope.serverProfileId, scope.dimension, "furnace", scope.position);
    const controller = new AbortController();
    const lease = await ActiveWorkstationLease.acquire(registry, scope, owner, controller.signal);
    if (mode === "outage") vi.spyOn(registry, "renewClaim").mockImplementation(() => { throw new Error("offline"); });
    if (mode === "hung") vi.spyOn(registry, "renewClaim").mockImplementation(() => new Promise(() => {}) as never);
    if (mode === "cancel") controller.abort();
    await vi.advanceTimersByTimeAsync(mode === "hung" ? 30_001 : 5_001);
    expect(lease.signal.aborted).toBe(true);
    await expect(lease.assertCurrent()).rejects.toMatchObject({ code: "WORKSTATION_LEASE_LOST" });
    await lease.release();
  });
});

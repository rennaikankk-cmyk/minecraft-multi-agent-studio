import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkAreaLeaseAuthority } from "@minecraft-studio/skills";
import { withWorkAreaLease } from "../src/work-area-lease.js";

const area = { serverProfileId: "fixture", dimension: "minecraft:overworld", min: { x: 0, y: 64, z: 0 }, max: { x: 1, y: 65, z: 1 } };
afterEach(() => vi.useRealTimers());
describe("Runtime area lease lifetime", () => {
  it("renews a long operation and releases its region when the operation settles", async () => {
    vi.useFakeTimers();
    const authority = new WorkAreaLeaseAuthority();
    const renew = vi.spyOn(authority, "renew");
    let finish: () => void = () => {};
    const operation = withWorkAreaLease(authority, area, "a", new AbortController().signal, async (_id, _signal, assertCurrent) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      await assertCurrent(); return "done";
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(renew).toHaveBeenCalledTimes(7);
    expect(() => authority.claim({ area, owner: "b" })).toThrow("WORK_AREA_BUSY");
    finish(); expect(await operation).toBe("done");
    expect(authority.claim({ area, owner: "b" })).toBeDefined();
  });
  it("expires locally even when a renewal RPC never returns", async () => {
    vi.useFakeTimers();
    const authority = new WorkAreaLeaseAuthority();
    const port = { claim: authority.claim.bind(authority), validate: authority.validate.bind(authority),
      release: authority.release.bind(authority), renew: vi.fn(() => new Promise<never>(() => {})) };
    const operation = withWorkAreaLease(port, area, "a", new AbortController().signal, async (_id, signal, assertCurrent) => {
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
      await assertCurrent();
    });
    const assertion = expect(operation).rejects.toMatchObject({ code: "WORK_AREA_LEASE_LOST" });
    await vi.advanceTimersByTimeAsync(30_001);
    await assertion;
    expect(authority.claim({ area, owner: "b" })).toBeDefined();
  });
});

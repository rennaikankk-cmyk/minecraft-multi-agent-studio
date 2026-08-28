import { describe, expect, it, vi } from "vitest";

import {
  MOVEMENT_PRIORITIES,
  MovementArbiter,
  MovementController,
  MovementLeaseUnavailableError,
  StaleMovementLeaseError,
} from "../src/index.js";

describe("MovementArbiter", () => {
  it("allows one owner and rejects equal/lower-priority peers", () => {
    const arbiter = new MovementArbiter({
      leaseId: () => "lease-a",
      token: () => "token-a",
    });
    const task = arbiter.acquire({
      owner: "task:navigate",
      priority: "TASK_NAVIGATION",
    });
    expect(task?.token).toBe("token-a:1");
    expect(
      arbiter.acquire({ owner: "task:collect", priority: "TASK_NAVIGATION" }),
    ).toBeNull();
    expect(
      arbiter.acquire({ owner: "explore", priority: MOVEMENT_PRIORITIES.EXPLORE }),
    ).toBeNull();
    expect(arbiter.currentLease()).toMatchObject({
      owner: "task:navigate",
      priority: MOVEMENT_PRIORITIES.TASK_NAVIGATION,
      state: "active",
    });
  });

  it("preempts atomically, aborts the old signal, and invalidates late callbacks", () => {
    const events: string[] = [];
    let next = 0;
    const arbiter = new MovementArbiter({
      leaseId: () => `lease-${++next}`,
      token: () => `token-${next}`,
      onPreempt: ({ lease, replacement }) => {
        events.push(`${lease.owner}->${replacement?.owner ?? "none"}`);
      },
    });
    const old = arbiter.require({
      owner: "task:navigate",
      priority: "TASK_NAVIGATION",
      onPreempt: ({ lease }) => events.push(`local:${lease.state}`),
    });
    const aborted = vi.fn();
    old.signal.addEventListener("abort", aborted);

    const combat = arbiter.require({
      owner: "combat:reflex",
      priority: "COMBAT",
    });

    expect(aborted).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "local:preempted",
      "task:navigate->combat:reflex",
    ]);
    expect(old.isCurrent()).toBe(false);
    expect(() => old.assertCurrent()).toThrow(StaleMovementLeaseError);
    expect(combat.isCurrent()).toBe(true);
    expect(arbiter.release(old)).toBe(false);
    expect(arbiter.release(combat, "completed")).toBe(true);
    expect(arbiter.currentLease()).toBeNull();
  });

  it("propagates parent cancellation and refuses aborted requests", () => {
    const parent = new AbortController();
    const arbiter = new MovementArbiter();
    const lease = arbiter.require({
      owner: "task:navigate",
      priority: "TASK_NAVIGATION",
      signal: parent.signal,
    });

    parent.abort();

    expect(lease.signal.aborted).toBe(true);
    expect(lease.state).toBe("cancelled");
    expect(arbiter.currentLease()).toBeNull();
    expect(
      arbiter.acquire({
        owner: "task:aborted",
        priority: "TASK_NAVIGATION",
        signal: parent.signal,
      }),
    ).toBeNull();
  });

  it("exposes a run facade that always releases and rejects stale completion", async () => {
    const controller = new MovementController({
      leaseId: () => "lease-run",
      token: () => "token-run",
    });
    const value = await controller.run(
      { owner: "task:navigate", priority: "TASK_NAVIGATION" },
      async (lease) => {
        lease.assertCurrent();
        return 42;
      },
    );
    expect(value).toBe(42);
    expect(controller.currentLease()).toBeNull();
  });

  it("throws an inspectable conflict from require", () => {
    const arbiter = new MovementArbiter();
    arbiter.require({ owner: "combat", priority: "COMBAT" });
    expect(() =>
      arbiter.require({ owner: "task", priority: "TASK_NAVIGATION" }),
    ).toThrowError(MovementLeaseUnavailableError);
  });

  it("checks lease identity so an old handle cannot release a replacement", () => {
    const arbiter = new MovementArbiter({ token: () => "test-token" });
    const old = arbiter.require({ owner: "old", priority: "TASK_NAVIGATION" });
    const oldToken = old.token;
    expect(old.release()).toBe(true);
    const replacement = arbiter.require({
      owner: "replacement",
      priority: "TASK_NAVIGATION",
    });

    expect(old.release()).toBe(false);
    expect(arbiter.release(oldToken)).toBe(false);
    expect(replacement.isCurrent()).toBe(true);
  });
});

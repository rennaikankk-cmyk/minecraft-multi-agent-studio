import { describe, expect, it, vi } from "vitest";

import { ActionLockError, ActionLockManager } from "../src/index.js";

describe("ActionLockManager", () => {
  it("allows one owner and rejects a competing owner", () => {
    const manager = new ActionLockManager();
    const release = manager.tryAcquire("movement", { owner: "task-a", ttlMs: 1_000 });
    expect(manager.ownerOf("movement")).toBe("task-a");
    expect(() => manager.tryAcquire("movement", { owner: "task-b", ttlMs: 1_000 }))
      .toThrowError(expect.objectContaining({ code: "LOCK_BUSY" }));
    release();
    expect(manager.ownerOf("movement")).toBeNull();
  });

  it("releases a lock when cancellation or work completion occurs", async () => {
    const manager = new ActionLockManager();
    const controller = new AbortController();
    const work = manager.withLock(
      "crafting",
      { owner: "task-a", ttlMs: 1_000, signal: controller.signal },
      async () => {
        controller.abort();
        return "ok";
      },
    );
    await expect(work).resolves.toBe("ok");
    expect(manager.ownerOf("crafting")).toBeNull();
  });

  it("holds a cancelled in-flight side effect until its promise settles", async () => {
    const manager = new ActionLockManager();
    const controller = new AbortController();
    let settle!: () => void;
    const work = manager.withLock(
      "inventory",
      { owner: "task-a", ttlMs: 1_000, signal: controller.signal },
      () => new Promise<void>((resolve) => {
        settle = resolve;
      }),
    );

    controller.abort();
    expect(manager.ownerOf("inventory")).toBe("task-a");
    expect(() =>
      manager.tryAcquire("inventory", { owner: "task-b", ttlMs: 1_000 }),
    ).toThrowError(expect.objectContaining({ code: "LOCK_BUSY" }));

    settle();
    await work;
    expect(manager.ownerOf("inventory")).toBeNull();
  });

  it("does not expire a protected side effect while its promise is pending", async () => {
    vi.useFakeTimers();
    try {
      const manager = new ActionLockManager();
      let settle!: () => void;
      const work = manager.withLock(
        "inventory",
        { owner: "task-a", ttlMs: 20 },
        () => new Promise<void>((resolve) => {
          settle = resolve;
        }),
      );

      await vi.advanceTimersByTimeAsync(21);
      expect(manager.ownerOf("inventory")).toBe("task-a");
      expect(() =>
        manager.tryAcquire("inventory", { owner: "task-b", ttlMs: 20 }),
      ).toThrowError(expect.objectContaining({ code: "LOCK_BUSY" }));

      settle();
      await work;
      expect(manager.ownerOf("inventory")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires abandoned locks and validates inputs", () => {
    vi.useFakeTimers();
    try {
      const manager = new ActionLockManager();
      manager.tryAcquire("inventory", { owner: "task-a", ttlMs: 20 });
      vi.advanceTimersByTime(21);
      expect(manager.snapshot()).toEqual([]);
      expect(() => manager.tryAcquire("inventory", { owner: "", ttlMs: 20 }))
        .toThrowError(ActionLockError);
    } finally {
      vi.useRealTimers();
    }
  });
});

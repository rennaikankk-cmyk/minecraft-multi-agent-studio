// PursuitController 测试：锁定/追击节奏/承诺窗/停止条件/租约让位。
import { describe, expect, it, vi } from "vitest";
import { PursuitController, type PursuitBot } from "../src/pursuit-controller.js";

function makeBot(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    entityView: vi.fn(() => ({ x: 0, y: 64, z: 0, alive: true })),
    distanceTo: vi.fn(() => 2),
    attack: vi.fn(),
    followTarget: vi.fn(),
    stopFollowing: vi.fn(),
    ...overrides,
  } as unknown as PursuitBot & Record<string, ReturnType<typeof vi.fn>>;
}

function makeDeps(leaseAvailable = true) {
  const released: string[] = [];
  return {
    released,
    deps: {
      now: (() => {
        let t = 10_000;
        return () => t;
      })(),
      log: vi.fn(),
      acquireLease: vi.fn(() =>
        leaseAvailable
          ? { release: (reason: string) => released.push(reason) }
          : null,
      ),
    },
    advance(ms: number) {
      // 拨快时钟：替换 now 实现
      let current = 10_000;
      this.deps.now = () => (current += ms, current);
    },
  };
}

describe("PursuitController", () => {
  it("engage 占租约+开 GoalFollow；进 range 按冷却挥击", () => {
    const bot = makeBot();
    const { deps } = makeDeps();
    const ctrl = new PursuitController(bot, deps);
    expect(ctrl.engage(42)).toBe(true);
    expect(bot.followTarget).toHaveBeenCalledWith(42, 2);
    ctrl.tick();
    expect(bot.attack).toHaveBeenCalledWith(42); // 首拍立即挥击
    ctrl.tick();
    expect(bot.attack).toHaveBeenCalledTimes(1); // 冷却窗内不二连
  });

  it("目标跑远：GoalFollow 持续追（不挥击不停止）", () => {
    const bot = makeBot({ distanceTo: vi.fn(() => 20) });
    const { deps } = makeDeps();
    const ctrl = new PursuitController(bot, deps);
    ctrl.engage(42);
    expect(ctrl.tick()).toBe(true);
    expect(bot.attack).not.toHaveBeenCalled();
  });

  it("超出脱离距离（64 格）→ 停止+释放租约", () => {
    const bot = makeBot({ distanceTo: vi.fn(() => 70) });
    const { deps, released } = makeDeps();
    const ctrl = new PursuitController(bot, deps);
    ctrl.engage(42);
    expect(ctrl.tick()).toBe(false);
    expect(ctrl.currentState).toBe("stopped_too_far");
    expect(bot.stopFollowing).toHaveBeenCalled();
    expect(released).toContain("stopped_too_far");
  });

  it("目标消失（entityView null）→ 停止", () => {
    const bot = makeBot({ entityView: vi.fn(() => null) });
    const { deps } = makeDeps();
    const ctrl = new PursuitController(bot, deps);
    ctrl.engage(42);
    expect(ctrl.tick()).toBe(false);
    expect(ctrl.currentState).toBe("stopped_target_gone");
  });

  it("贴身刷新承诺窗；追不上到窗过期→停止", () => {
    // 距离 20（追不上但未超脱离）：承诺窗 25s 内贴身不再，窗过期即收。
    const bot = makeBot({ distanceTo: vi.fn(() => 20) });
    let clock = 10_000;
    const deps = {
      now: () => clock,
      log: vi.fn(),
      acquireLease: () => ({ release: () => undefined }),
    };
    const ctrl = new PursuitController(bot, deps, { commitmentMs: 25_000 });
    ctrl.engage(42);
    clock += 24_000;
    expect(ctrl.tick()).toBe(true); // 窗内仍在追
    clock += 2_000;
    expect(ctrl.tick()).toBe(false);
    expect(ctrl.currentState).toBe("stopped_commitment_expired");
  });

  it("租约被更高优先级持有 → 让位不接战", () => {
    const bot = makeBot();
    const { deps } = makeDeps(false);
    const ctrl = new PursuitController(bot, deps);
    expect(ctrl.engage(42)).toBe(false);
    expect(ctrl.currentState).toBe("stopped_no_lease");
    expect(bot.followTarget).not.toHaveBeenCalled();
  });

  it("互火刷新承诺窗（被打也算接触）", () => {
    const bot = makeBot({ distanceTo: vi.fn(() => 20) });
    let clock = 10_000;
    const deps = {
      now: () => clock,
      log: vi.fn(),
      acquireLease: () => ({ release: () => undefined }),
    };
    const ctrl = new PursuitController(bot, deps, { commitmentMs: 25_000 });
    ctrl.engage(42);
    clock += 20_000;
    ctrl.onMutualContact(); // 20s 时又互相打了一波
    clock += 20_000;
    expect(ctrl.tick()).toBe(true); // 40s 总时长但互火刷新过 → 仍在追
  });
});

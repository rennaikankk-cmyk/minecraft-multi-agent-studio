import { describe, expect, it } from "vitest";

import {
  ChainSequencer,
  DEFAULT_CHAIN_SEQUENCER_POLICY,
  type CombatChainContext,
  type CombatChainSequencerPolicy,
  type CombatChainStep,
} from "../src/chain-sequencer.js";
import { CombatReflexNotClearedError } from "../src/reflex-clearance.js";

const CLEARED = {
  cleared: true,
  denial: null,
  budgetMs: 50,
} as const;
const CONTEXT: CombatChainContext = {
  retreatInProgress: false,
  clearance: CLEARED,
};

function use(label: string, overrides: Partial<CombatChainStep> = {}) {
  return { label, interactionClass: "use" as const, ...overrides };
}

function attack(label: string, overrides: Partial<CombatChainStep> = {}) {
  return { label, interactionClass: "attack" as const, ...overrides };
}

describe("ChainSequencer", () => {
  it("keeps use cadence independent from attack cadence", () => {
    const sequencer = new ChainSequencer();
    const first = sequencer.beginChain([use("place")], 0, CONTEXT);
    expect(first.state).toBe("STEP_READY");
    sequencer.recordStepAcked("place", 20);

    const useRetry = sequencer.beginChain([use("charge")], 100, CONTEXT);
    expect(useRetry).toMatchObject({
      state: "REFUSED",
      refusal: "THROTTLED",
    });
    expect(useRetry.nextLegalAtMs).toBeGreaterThanOrEqual(220);
    expect(useRetry.nextLegalAtMs).toBeLessThanOrEqual(260);

    expect(
      sequencer.beginChain([attack("detonate")], 100, CONTEXT).state,
    ).toBe("STEP_READY");
  });

  it("requires reflex clearance when a gated class sits below the reflex budget", () => {
    // 显式把 attack 声明为反射级门禁类，才能用合法策略（validatePolicy 强制
    // useIntervalMs >= REFLEX_BUDGET_MS）构造出"低于反射预算"的步：
    // attackIntervalMs = 0，故 max(0, minimumGapMs) < 50。
    const gatedPolicy: CombatChainSequencerPolicy = {
      ...DEFAULT_CHAIN_SEQUENCER_POLICY,
      reflexGatedClasses: ["use", "attack"],
    };
    const steps = [use("place"), attack("detonate", { minimumGapMs: 20 })];
    expect(() => new ChainSequencer(gatedPolicy).beginChain(steps, 0, {
      retreatInProgress: false,
      clearance: { cleared: false, denial: "NO_PROBE_DATA", budgetMs: 50 },
    })).toThrowError(CombatReflexNotClearedError);
    expect(new ChainSequencer(gatedPolicy).beginChain(steps, 0, CONTEXT).state).toBe(
      "STEP_READY",
    );
  });

  it("inspects the first step of a chain, not just the trailing ones", () => {
    // 回归守卫：chainRequiresClearance 曾写作 `steps.slice(1).some(...)`，静默
    // 跳过第 0 步；而 CombatDriver 只提交**单步**链，于是 requiresClearance 恒为
    // false、assertClearance 永不执行——门禁形同虚设。单步链必须被检查。
    const gatedPolicy: CombatChainSequencerPolicy = {
      ...DEFAULT_CHAIN_SEQUENCER_POLICY,
      reflexGatedClasses: ["attack"],
    };
    expect(() => new ChainSequencer(gatedPolicy).beginChain(
      [attack("swing")],
      0,
      {
        retreatInProgress: false,
        clearance: { cleared: false, denial: "NO_PROBE_DATA", budgetMs: 50 },
      },
    )).toThrowError(CombatReflexNotClearedError);
  });

  it("keeps melee combat available under the default policy without a probe", () => {
    // §0.6.3 把"武器管理"（WeaponManager 的攻击冷却与 i-frame 时机）定为
    // **战术级（≤200ms）**，不是反射级；attack 因此不在 reflexGatedClasses 内。
    // 若把 attack 算作反射级，attackIntervalMs=0 会因 0 < 50 把每次攻击都判成
    // 反射级，在探针无法放行（生产中的常态）时封掉全部近战与远程攻击。
    expect(DEFAULT_CHAIN_SEQUENCER_POLICY.reflexGatedClasses).toEqual(["use"]);
    const uncleared: CombatChainContext = {
      retreatInProgress: false,
      clearance: { cleared: false, denial: "NO_PROBE_DATA", budgetMs: 50 },
    };
    expect(
      new ChainSequencer().beginChain([attack("swing")], 0, uncleared).state,
    ).toBe("STEP_READY");
    // use 类在合法策略下（useIntervalMs = 200 >= 50）同样不低于反射预算。
    expect(
      new ChainSequencer().beginChain([use("place")], 0, uncleared).state,
    ).toBe("STEP_READY");
  });

  it("does not issue the next step before the pending ACK", () => {
    const sequencer = new ChainSequencer();
    sequencer.beginChain([use("place"), use("charge")], 0, CONTEXT);
    expect(sequencer.nextStep(999, CONTEXT)).toMatchObject({
      state: "AWAITING_ACK",
      refusal: null,
      step: { label: "place", executedAtMs: null },
    });
    expect(sequencer.nextStep(1_001, CONTEXT)).toMatchObject({
      state: "REFUSED",
      refusal: "STEP_UNACKED",
    });
  });

  it("advances only after ACK and reports the exact request/execute times", () => {
    const sequencer = new ChainSequencer();
    const first = sequencer.beginChain(
      [use("place"), use("charge")],
      100,
      CONTEXT,
    );
    expect(first.step).toMatchObject({ requestedAtMs: 100, executedAtMs: null });
    const ack = sequencer.recordStepAcked("place", 140);
    expect(ack).toMatchObject({
      requestedAtMs: 100,
      executedAtMs: 140,
      ackRttMs: 40,
      acknowledgedWithinBudget: true,
    });

    const throttled = sequencer.nextStep(300, CONTEXT);
    expect(throttled.refusal).toBe("THROTTLED");
    const readyAt = throttled.nextLegalAtMs!;
    const second = sequencer.nextStep(readyAt, CONTEXT);
    expect(second).toMatchObject({
      state: "STEP_READY",
      step: { label: "charge", requestedAtMs: readyAt },
    });
    sequencer.recordStepAcked("charge", readyAt + 30);
    expect(sequencer.records()).toEqual([
      expect.objectContaining({ label: "place", executedAtMs: 140 }),
      expect.objectContaining({ label: "charge", executedAtMs: readyAt + 30 }),
    ]);
  });

  it("uses measured ACK RTT for later default budgets", () => {
    const sequencer = new ChainSequencer();
    sequencer.beginChain([attack("sample")], 0, CONTEXT);
    sequencer.recordStepAcked("sample", 80);
    expect(sequencer.measuredAckRttMs("attack")).toBe(80);

    const next = sequencer.beginChain([attack("measured")], 100, CONTEXT);
    expect(next.step?.ackDeadlineAtMs).toBe(340);
  });

  it("marks a late ACK without pretending the action never executed", () => {
    const sequencer = new ChainSequencer();
    sequencer.beginChain(
      [attack("late", { ackBudgetMs: 10 }), attack("must-not-run")],
      0,
      CONTEXT,
    );
    const record = sequencer.recordStepAcked("late", 11);
    expect(record).toMatchObject({
      executedAtMs: 11,
      acknowledgedWithinBudget: false,
    });
    expect(sequencer.nextStep(11, CONTEXT)).toMatchObject({
      state: "REFUSED",
      refusal: "STEP_UNACKED",
    });
  });

  it("lets retreat outrank a stale pending step", () => {
    const sequencer = new ChainSequencer();
    sequencer.beginChain([use("place"), use("charge")], 0, CONTEXT);
    expect(sequencer.nextStep(2_000, {
      ...CONTEXT,
      retreatInProgress: true,
    }).refusal).toBe("RETREAT_IN_PROGRESS");
  });

  it("expires a chain instead of reviving it after its lifetime", () => {
    const sequencer = new ChainSequencer({
      ...DEFAULT_CHAIN_SEQUENCER_POLICY,
      cadenceJitterMaxMs: 0,
      stepJitterMaxMs: 0,
    });
    sequencer.beginChain(
      [use("place"), use("charge", { minimumGapMs: 2_000 })],
      0,
      { ...CONTEXT, chainLifetimeMs: 1_000 },
    );
    sequencer.recordStepAcked("place", 10);
    // THROTTLED is intentionally checked before expiry.
    expect(sequencer.nextStep(1_001, CONTEXT).refusal).toBe("THROTTLED");
    expect(sequencer.nextStep(2_010, CONTEXT).refusal).toBe("CHAIN_EXPIRED");
  });

  it("applies reproducible but non-fixed cadence jitter", () => {
    const run = (seed: number) => {
      const sequencer = new ChainSequencer(DEFAULT_CHAIN_SEQUENCER_POLICY, seed);
      const gaps: number[] = [];
      let now = 0;
      for (let index = 0; index < 5; index += 1) {
        const label = `use-${index}`;
        sequencer.beginChain([use(label)], now, CONTEXT);
        sequencer.recordStepAcked(label, now + 10);
        const legal = sequencer.nextLegalAtMs("use", now + 10);
        gaps.push(legal - (now + 10));
        now = legal;
      }
      return gaps;
    };
    expect(run(42)).toEqual(run(42));
    expect(new Set(run(42)).size).toBeGreaterThan(1);
  });

  it("resets cadence, measurements, and audit state", () => {
    const sequencer = new ChainSequencer();
    sequencer.beginChain([use("place")], 100, CONTEXT);
    sequencer.recordStepAcked("place", 120);
    sequencer.reset();
    expect(sequencer.records()).toEqual([]);
    expect(sequencer.measuredAckRttMs("use")).toBeNull();
    expect(sequencer.nextLegalAtMs("use", 0)).toBe(0);
  });

  it("rejects malformed chains and backwards clocks", () => {
    expect(() => new ChainSequencer().beginChain([], 0, CONTEXT)).toThrowError(
      TypeError,
    );
    expect(() => new ChainSequencer().beginChain(
      [use("same"), use("same")],
      0,
      CONTEXT,
    )).toThrowError(TypeError);
    const sequencer = new ChainSequencer();
    sequencer.beginChain([use("place")], 10, CONTEXT);
    expect(() => sequencer.nextStep(9, CONTEXT)).toThrowError(RangeError);
  });
});

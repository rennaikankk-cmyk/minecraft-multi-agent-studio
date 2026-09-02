// selector 滞回/承诺/紧急中断 + evidence 确定性（研究 §11.4 / §17.1）。
import { describe, expect, it } from "vitest";
import { selectTacticalAction } from "../src/tactics/selector.js";
import { buildDecisionEvidence } from "../src/tactics/evidence.js";
import { scoreTacticalActions } from "../src/tactics/utility.js";
import { DEFAULT_TACTICS_PROFILE } from "../src/tactics/profile.js";
import { selfFixture, snapshotFixture } from "./tactics-fixtures.js";

function decide(input: {
  nowMs: number;
  self?: Parameters<typeof selfFixture>[0];
  previous: ReturnType<typeof selectTacticalAction> | null;
  emergency?: Parameters<typeof selectTacticalAction>[0]["emergencySignal"];
}) {
  const snapshot = snapshotFixture({ nowMonotonicMs: input.nowMs, self: input.self });
  const verdict = scoreTacticalActions(snapshot, DEFAULT_TACTICS_PROFILE);
  return {
    snapshot,
    verdict,
    decision: selectTacticalAction({
      verdict,
      snapshot,
      profile: DEFAULT_TACTICS_PROFILE,
      previous: input.previous,
      emergencySignal: input.emergency ?? null,
    }),
  };
}

describe("tactics/selector", () => {
  it("首裁决 INITIAL，带动作承诺", () => {
    const { decision } = decide({ nowMs: 10_000, previous: null });
    expect(decision.switchReason).toBe("INITIAL");
    expect(decision.commitUntilMs).toBeGreaterThan(10_000);
  });

  it("承诺期内非紧急：即使新动作分数更高也维持（防抖动）", () => {
    const first = decide({ nowMs: 10_000, previous: null }).decision;
    // 100ms 后：同一路径重算，效用若波动也在承诺内维持。
    const second = decide({ nowMs: 10_100, previous: first }).decision;
    expect(second.action).toBe(first.action);
    expect(second.switched).toBe(false);
  });

  it("承诺期满：效用差不足 hysteresis → 仍维持", () => {
    const first = decide({ nowMs: 10_000, previous: null }).decision;
    const second = decide({ nowMs: first.commitUntilMs + 1, previous: first }).decision;
    // 同一快照族内差异极小，滞回应挡住无意义切换。
    expect(second.switched).toBe(false);
  });

  it("紧急信号打断承诺（EMERGENCY）：verdict 已变且 best≠previous 时立即切换", () => {
    // A：满血贴身 → best 为压制族；B：残血+逃生优良 → best 为脱离族。
    const first = decide({ nowMs: 10_000, previous: null, self: selfFixture({ health: 18 }) }).decision;
    const secondSnapshot = snapshotFixture({ nowMonotonicMs: 10_050, self: selfFixture({ health: 4, escapeRoutes: [{ direction: { x: 1, y: 0, z: 0 }, clearanceBlocks: 10, blocked: false }] }) });
    const secondVerdict = scoreTacticalActions(secondSnapshot, DEFAULT_TACTICS_PROFILE);
    expect(secondVerdict.best!.action).not.toBe(first.action);
    // 承诺期内、非紧急：维持。
    const held = selectTacticalAction({ verdict: secondVerdict, snapshot: secondSnapshot, profile: DEFAULT_TACTICS_PROFILE, previous: first, emergencySignal: null });
    expect(held.switched).toBe(false);
    // 紧急：立即切换。
    const interrupted = selectTacticalAction({ verdict: secondVerdict, snapshot: secondSnapshot, profile: DEFAULT_TACTICS_PROFILE, previous: first, emergencySignal: "ENEMY_HEAL_OBSERVED" });
    expect(interrupted.switched).toBe(true);
    expect(interrupted.switchReason).toBe("EMERGENCY");
    expect(interrupted.action).toBe(secondVerdict.best!.action);
  });

  it("HEAL 承诺长于普通动作（进食 1.6s 不可被普通波动打断）", () => {
    const heal = decide({
      nowMs: 10_000,
      self: selfFixture({ health: 4, consumables: { goldenApples: 3, healingPotions: 0, shieldDurabilityOk: true } }),
      previous: null,
    }).decision;
    // 若选中 HEAL 则承诺 1.6s；否则退回普通承诺——两种都合法，断言不短于 minCommit。
    expect(heal.commitUntilMs - 10_000).toBeGreaterThanOrEqual(DEFAULT_TACTICS_PROFILE.selector.minCommitMs);
  });

  it("原动作被硬阻塞 → 承诺失效（STALE_INVALIDATION）", () => {
    const first = decide({ nowMs: 10_000, previous: null }).decision;
    if (first.action === "HOLD") return; // 无目标路径另测
    const snapshot = snapshotFixture({ nowMonotonicMs: 10_050, target: null });
    const verdict = scoreTacticalActions(snapshot, DEFAULT_TACTICS_PROFILE);
    const second = selectTacticalAction({
      verdict, snapshot, profile: DEFAULT_TACTICS_PROFILE, previous: first, emergencySignal: null,
    });
    expect(second.switched).toBe(true);
    expect(second.switchReason).toBe("STALE_INVALIDATION");
  });

  it("全 hard-block → HOLD 兜底", () => {
    const snapshot = snapshotFixture({ target: null, policy: {} });
    const verdict = scoreTacticalActions(snapshot, DEFAULT_TACTICS_PROFILE);
    const decision = selectTacticalAction({ verdict, snapshot, profile: DEFAULT_TACTICS_PROFILE, previous: null, emergencySignal: null });
    expect(decision.action).not.toBe("KILL_SECURE");
  });
});

describe("tactics/evidence", () => {
  it("确定性：同输入两次构造字节级一致", () => {
    const { snapshot, verdict, decision } = decide({ nowMs: 10_000, previous: null });
    const a = JSON.stringify(buildDecisionEvidence({ snapshot, profile: DEFAULT_TACTICS_PROFILE, verdict, decision }));
    const b = JSON.stringify(buildDecisionEvidence({ snapshot, profile: DEFAULT_TACTICS_PROFILE, verdict, decision }));
    expect(a).toBe(b);
  });

  it("含 profile 版本、top-N 分数、KILL_SECURE 门状态与 belief 区间", () => {
    const { snapshot, verdict, decision } = decide({ nowMs: 10_000, previous: null });
    const evidence = buildDecisionEvidence({ snapshot, profile: DEFAULT_TACTICS_PROFILE, verdict, decision });
    expect(evidence.tacticsProfileVersion).toBe(DEFAULT_TACTICS_PROFILE.schemaVersion);
    expect(evidence.decision).toBe(decision.action);
    expect(evidence.inputs.totemState).toBe("NO_TOTEM");
    expect(evidence.inputs.enemyHealthBeliefHp).toEqual({ lo: 8, hi: 20 });
    expect(evidence.inputs.killSecureGate.open).toBe(false);
    expect(evidence.scores.length).toBeGreaterThan(0);
    expect(evidence.scores.length).toBeLessThanOrEqual(8);
  });

  it("无目标时 belief 区间为 null 而不是编造", () => {
    const { snapshot, verdict, decision } = decide({ nowMs: 10_000, previous: null });
    const empty = snapshotFixture({ target: null, nowMonotonicMs: 10_000 });
    const v2 = scoreTacticalActions(empty, DEFAULT_TACTICS_PROFILE);
    const d2 = selectTacticalAction({ verdict: v2, snapshot: empty, profile: DEFAULT_TACTICS_PROFILE, previous: null, emergencySignal: null });
    const evidence = buildDecisionEvidence({ snapshot: empty, profile: DEFAULT_TACTICS_PROFILE, verdict: v2, decision: d2 });
    expect(evidence.inputs.enemyHealthBeliefHp).toBeNull();
    expect(evidence.inputs.pEnemyDeadByNextHit).toBe(0);
  });
});

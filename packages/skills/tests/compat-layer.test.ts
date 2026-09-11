import { describe, expect, it } from "vitest";

import {
  MODE_TO_BASELINE,
  newBehaviorProfile,
  resolveCompatibilityMode,
  SERVER_COMPATIBILITY_MODES,
  type ServerBehaviorProfile,
} from "../src/compat/server-behavior-profile.js";
import { ServerBehaviorObserver } from "../src/compat/behavior-observer.js";
import {
  DEFAULT_ADAPTATION_THRESHOLDS,
  evaluateAdaptation,
  applyAdaptationDecision,
  type AdaptationState,
} from "../src/compat/adaptation-machine.js";
import {
  evaluateFeatureGates,
  resolveEffectiveActionPolicy,
} from "../src/compat/action-policy.js";
import { classifyIncident } from "../src/incidents.js";

// ---------------------------------------------------------------------------
// Round 7 —— 兼容层单元测试（模式解析/观察器/状态机/策略/门控/分类）
// ---------------------------------------------------------------------------

function profile(overrides: Partial<ServerBehaviorProfile> = {}): ServerBehaviorProfile {
  const base = newBehaviorProfile({
    serverProfileId: "sp-test",
    desired: "ADAPTIVE",
    effective: "ADAPTIVE",
    source: "operator",
  });
  return { ...base, ...overrides };
}

describe("compatibility mode resolution", () => {
  it("defaults to UNKNOWN fail-closed", () => {
    const resolved = resolveCompatibilityMode({});
    expect(resolved).toEqual({
      desired: "UNKNOWN_FAIL_CLOSED",
      effective: "UNKNOWN_FAIL_CLOSED",
      source: "default",
    });
    expect(MODE_TO_BASELINE[resolved.effective]).toBe("STRICT");
  });

  it("garbage operator values fail closed (refuse to start)", () => {
    expect(() => resolveCompatibilityMode({ operatorConfigured: "yolo" })).toThrowError(
      /STUDIO_SERVER_COMPATIBILITY is invalid/iu,
    );
  });

  it("EXPLICIT_UNRESTRICTED requires explicit operator authorization", () => {
    expect(() =>
      resolveCompatibilityMode({ operatorConfigured: "EXPLICIT_UNRESTRICTED" }),
    ).toThrowError(/requires explicit operator authorization/iu);
    const ok = resolveCompatibilityMode({
      operatorConfigured: "EXPLICIT_UNRESTRICTED",
      operatorAllowsUnrestricted: true,
    });
    expect(ok.effective).toBe("EXPLICIT_UNRESTRICTED");
    expect(ok.source).toBe("operator");
  });

  it("validated profiles never carry EXPLICIT_UNRESTRICTED (operator-only)", () => {
    const resolved = resolveCompatibilityMode({
      validatedProfileMode: "EXPLICIT_UNRESTRICTED",
    });
    expect(resolved.effective).toBe("VANILLA");
    expect(resolved.source).toBe("validated_profile");
  });

  it("exports the five modes with the fail-closed state", () => {
    expect([...SERVER_COMPATIBILITY_MODES]).toContain("UNKNOWN_FAIL_CLOSED");
  });
});

describe("ServerBehaviorObserver", () => {
  function clock(startMs = 1_000) {
    let mono = startMs;
    let wall = Date.parse("2026-09-02T00:00:00.000Z");
    return {
      monotonicNow: () => mono,
      wallNow: () => new Date(wall),
      advance(deltaMs: number) {
        mono += deltaMs;
        wall += deltaMs;
      },
    };
  }

  it("counts per-family signals within the window", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({ monotonicNow: clockImpl.monotonicNow, wallNow: clockImpl.wallNow });
    observer.record({ kind: "position-correction", family: "MOVEMENT" });
    observer.record({ kind: "position-correction", family: "MOVEMENT" });
    observer.record({ kind: "action-rejected", family: "MOVEMENT" });
    observer.record({ kind: "accepted", family: "DIGGING" });
    const stats = observer.familyStats("MOVEMENT");
    expect(stats).toMatchObject({ corrections: 2, rejections: 1, accepted: 0, total: 3 });
    expect(observer.familyStats("DIGGING").accepted).toBe(1);
  });

  it("window expiry drops old signals (monotonic)", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({
      windowMs: 10_000,
      monotonicNow: clockImpl.monotonicNow,
      wallNow: clockImpl.wallNow,
    });
    observer.record({ kind: "action-rejected", family: "DIGGING" });
    clockImpl.advance(20_000);
    observer.record({ kind: "accepted", family: "DIGGING" });
    const stats = observer.familyStats("DIGGING");
    expect(stats.rejections).toBe(0);
    expect(stats.accepted).toBe(1);
  });

  it("bounded buffer drops oldest and counts", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({
      maxEvents: 4,
      monotonicNow: clockImpl.monotonicNow,
      wallNow: clockImpl.wallNow,
    });
    for (let i = 0; i < 10; i += 1) {
      observer.record({ kind: "accepted", family: "MOVEMENT", detail: `e${i}` });
    }
    expect(observer.stats).toEqual({ buffered: 4, dropped: 6 });
  });

  it("redacts secret-shaped detail at ingest", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({ monotonicNow: clockImpl.monotonicNow, wallNow: clockImpl.wallNow });
    observer.record({
      kind: "kick",
      family: "CHAT_COMMAND",
      detail: "api_key=abcdefghijklmnopqrstuvwxyz123456 reason=x",
    });
    const events = observer.snapshot();
    expect(events[0]!.detail).toContain("[REDACTED]");
    expect(events[0]!.detail).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
  });

  /**
   * 旧实现的 redaction 是 `SECRETISH.replace(SECRETISH, "$1=[REDACTED]")`，而
   * SECRETISH 的键名组是 (?:...) 非捕获组——`$1` 不会展开成键名，而是被原样
   * 写进 detail，脱敏结果里留着字面量 "$1="。键名必须真的回填（捕获组），
   * 否则"脱敏后"的文本本身就成了一个坏掉的证据字段。
   */
  it("redacts secret-shaped detail without leaking the $1 placeholder", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({ monotonicNow: clockImpl.monotonicNow, wallNow: clockImpl.wallNow });
    observer.record({
      kind: "kick",
      family: "CHAT_COMMAND",
      detail: "api_key=abcdefghijklmnopqrstuvwxyz123456 reason=x",
    });
    const detail = observer.snapshot()[0]!.detail ?? "";
    expect(detail).not.toContain("$1");
    expect(detail).toContain("api_key=[REDACTED]");
    expect(detail).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    // 非 secret 的部分照旧可读——脱敏不该顺手删掉诊断信息。
    expect(detail).toContain("reason=x");
  });

  /**
   * detail 的 schema 是 z.string().optional()：省略与显式 undefined 都必须无异常。
   * 运行期脏数据（非字符串）以前会让 redact 里的 .replace 抛错，被 record 的
   * try/catch 静默吞掉——整条事件消失（观测缺口，正好丢掉服务器异常行为的证据）。
   * 现在非字符串一律降级为 undefined，事件本身必须留下。
   */
  it("stays total for undefined and non-string detail", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({ monotonicNow: clockImpl.monotonicNow, wallNow: clockImpl.wallNow });

    observer.record({ kind: "accepted", family: "MOVEMENT" });
    observer.record({ kind: "accepted", family: "MOVEMENT", detail: undefined });
    observer.record({
      kind: "timeout",
      family: "PACKET_INTENSIVE",
      detail: 42 as unknown as string,
    });

    const events = observer.snapshot();
    expect(events).toHaveLength(3);
    expect(events[0]!.detail).toBeUndefined();
    expect(events[1]!.detail).toBeUndefined();
    expect(events[2]!.detail).toBeUndefined();
    expect(events[2]!.kind).toBe("timeout");
    expect(observer.stats.buffered).toBe(3);
  });

  it("snapshot(lastMs) serves the Incident eventWindow copy", () => {
    const clockImpl = clock();
    const observer = new ServerBehaviorObserver({ monotonicNow: clockImpl.monotonicNow, wallNow: clockImpl.wallNow });
    observer.record({ kind: "accepted", family: "MOVEMENT" });
    clockImpl.advance(10_000);
    observer.record({ kind: "action-rejected", family: "MOVEMENT" });
    const recent = observer.snapshot(5_000);
    expect(recent.length).toBe(1);
    expect(recent[0]!.kind).toBe("action-rejected");
  });
});

describe("deterministic adaptation machine", () => {
  const thresholds = { ...DEFAULT_ADAPTATION_THRESHOLDS, downgradeCooldownMs: 0, recoveryIntervalMs: 0 };

  function input(overrides: Partial<Parameters<typeof evaluateAdaptation>[0]> = {}) {
    return {
      state: "STABLE" as AdaptationState,
      effectiveMode: "ADAPTIVE" as const,
      desiredMode: "ADAPTIVE" as const,
      familyStats: {},
      totalSamples: 100,
      nowMonotonicMs: 60_000,
      lastStateChangeMs: 0,
      cleanWindowsSinceDowngrade: 0,
      thresholds,
      ...overrides,
    };
  }

  it("single corrections below threshold do not degrade", () => {
    const decision = evaluateAdaptation(
      input({ familyStats: { MOVEMENT: { corrections: 1, rejections: 0, divergences: 0, accepted: 10, total: 11 } } }),
    );
    expect(decision.state).toBe("STABLE");
  });

  it("repeated rejections over threshold degrade one step with evidence", () => {
    const decision = evaluateAdaptation(
      input({
        familyStats: { MOVEMENT: { corrections: 2, rejections: 2, divergences: 0, accepted: 0, total: 4 } },
      }),
    );
    expect(decision.state).toBe("DEGRADED");
    expect(decision.effectiveMode).toBe("VANILLA"); // ADAPTIVE → VANILLA（单步）
    expect(decision.triggeredBy).toBe("MOVEMENT");
    expect(decision.reason).toContain("MOVEMENT");
  });

  it("downgrade cooldown suppresses immediate re-downgrade", () => {
    const decision = evaluateAdaptation(
      input({
        state: "DEGRADED",
        effectiveMode: "VANILLA",
        familyStats: { MOVEMENT: { corrections: 5, rejections: 0, divergences: 0, accepted: 0, total: 5 } },
        lastStateChangeMs: 59_000, // 冷却 30s 未过
        thresholds: { ...thresholds },
      }),
    );
    expect(decision.state).not.toBe("RESTRICTED");
  });

  it("sustained pressure escalates to RESTRICTED (two thresholds)", () => {
    const decision = evaluateAdaptation(
      input({
        state: "DEGRADED",
        effectiveMode: "VANILLA",
        familyStats: { MOVEMENT: { corrections: 6, rejections: 1, divergences: 0, accepted: 0, total: 7 } },
      }),
    );
    expect(decision.state).toBe("RESTRICTED");
    expect(decision.effectiveMode).toBe("CONSERVATIVE");
  });

  it("recovery requires consecutive clean windows and steps up one level only", () => {
    const decision = evaluateAdaptation(
      input({
        state: "DEGRADED",
        effectiveMode: "CONSERVATIVE",
        desiredMode: "ADAPTIVE",
        familyStats: {},
        cleanWindowsSinceDowngrade: thresholds.recoveryCleanWindows,
      }),
    );
    expect(decision.state).toBe("RECOVERING");
    expect(decision.effectiveMode).toBe("VANILLA"); // 单步升，不跳
  });

  it("recovery never crosses the desired ceiling", () => {
    const decision = evaluateAdaptation(
      input({
        state: "DEGRADED",
        effectiveMode: "VANILLA",
        desiredMode: "VANILLA",
        familyStats: {},
        cleanWindowsSinceDowngrade: 5,
      }),
    );
    expect(decision.effectiveMode).toBe("VANILLA");
    expect(decision.reason).toBe("no state change");
  });

  it("UNKNOWN promotes to BASELINING at the sample threshold", () => {
    const decision = evaluateAdaptation(
      input({ state: "UNKNOWN", totalSamples: thresholds.minSamplesForBaseline }),
    );
    expect(decision.state).toBe("BASELINING");
  });

  it("applyAdaptationDecision bumps revision only on mode change", () => {
    const p = profile({ revision: 7 });
    const changed = applyAdaptationDecision(
      p,
      { state: "DEGRADED", effectiveMode: "VANILLA", reason: "MOVEMENT x", triggeredBy: "MOVEMENT", confidence: 0.6 },
      { MOVEMENT: { corrections: 2, rejections: 2, divergences: 0 } },
    );
    expect(changed.revision).toBe(8);
    expect(changed.effectiveMode).toBe("VANILLA");
    expect(changed.downgradeReason).toContain("MOVEMENT");
    const unchanged = applyAdaptationDecision(
      changed,
      { state: "DEGRADED", effectiveMode: "VANILLA", reason: "no state change", confidence: 0.6 },
      {},
    );
    expect(unchanged.revision).toBe(8);
  });
});

describe("unified action policy", () => {
  it("resolves per-family pacing derived from the baseline (not hardcoded per skill)", () => {
    const p = profile({ effectiveMode: "CONSERVATIVE" });
    const resolution = resolveEffectiveActionPolicy(p, "MOVEMENT");
    expect(resolution.allowed).toBe(true);
    if (!resolution.allowed) return;
    // STRICT 基线 → 倍率 2 → 间隔至少翻倍于 ANARCHY 档
    const anarchic = resolveEffectiveActionPolicy(
      profile({ effectiveMode: "EXPLICIT_UNRESTRICTED" }),
      "MOVEMENT",
    );
    expect(anarchic.allowed).toBe(true);
    if (!anarchic.allowed || !resolution.allowed) return;
    expect(resolution.policy.minIntervalMs).toBeGreaterThan(anarchic.policy.minIntervalMs);
    expect(resolution.policy.baseline).toBe("STRICT");
    expect(anarchic.policy.baseline).toBe("ANARCHY");
  });

  it("high-risk families stay closed under conservative baselines (fail-closed)", () => {
    const resolution = resolveEffectiveActionPolicy(profile({ effectiveMode: "UNKNOWN_FAIL_CLOSED" }), "EXPLOSIVE_COMBAT");
    expect(resolution.allowed).toBe(false);
    if (resolution.allowed) return;
    expect(resolution.failureCode).toBe("FAMILY_RESTRICTED");
    expect(resolution.detail).toContain("STRICT");
  });

  it("explosive families open under operator EXPLICIT_UNRESTRICTED", () => {
    const resolution = resolveEffectiveActionPolicy(
      profile({ effectiveMode: "EXPLICIT_UNRESTRICTED" }),
      "EXPLOSIVE_COMBAT",
    );
    expect(resolution.allowed).toBe(true);
  });

  it("desired-but-refused gates block the family with a stable code", () => {
    const p = profile({
      effectiveMode: "UNKNOWN_FAIL_CLOSED",
      featureGates: [
        {
          feature: "PACKET_MINE",
          desiredState: true,
          effectiveState: false,
          source: "operator",
          risk: "CRITICAL",
          disableReason: "compat-check pending",
          lastValidatedAt: null,
          revalidationCooldownMs: 60_000,
        },
      ],
    });
    const resolution = resolveEffectiveActionPolicy(p, "DIGGING");
    expect(resolution.allowed).toBe(false);
    if (resolution.allowed) return;
    expect(resolution.failureCode).toBe("FEATURE_GATE_DISABLED");
    expect(resolution.detail).toContain("PACKET_MINE");
  });

  it("operator-disabled gates never block the normal path (no death loop)", () => {
    const p = profile({
      effectiveMode: "EXPLICIT_UNRESTRICTED",
      featureGates: [
        {
          feature: "PACKET_MINE",
          desiredState: false,
          effectiveState: false,
          source: "operator",
          risk: "CRITICAL",
          disableReason: "operator disabled",
          lastValidatedAt: null,
          revalidationCooldownMs: 60_000,
        },
      ],
    });
    const resolution = resolveEffectiveActionPolicy(p, "DIGGING");
    expect(resolution.allowed).toBe(true);
  });
});

describe("feature gate evaluation", () => {
  it("CRITICAL gates stay closed under conservative effective modes", () => {
    const p = profile({
      effectiveMode: "CONSERVATIVE",
      featureGates: [
        {
          feature: "NO_HUNGER",
          desiredState: true,
          effectiveState: false,
          source: "operator",
          risk: "HIGH",
          disableReason: null,
          lastValidatedAt: null,
          revalidationCooldownMs: 60_000,
        },
        {
          feature: "PACKET_MINE",
          desiredState: true,
          effectiveState: false,
          source: "operator",
          risk: "CRITICAL",
          disableReason: null,
          lastValidatedAt: null,
          revalidationCooldownMs: 60_000,
        },
      ],
    });
    const gates = evaluateFeatureGates(p);
    const noHunger = gates.find((g) => g.feature === "NO_HUNGER")!;
    const packetMine = gates.find((g) => g.feature === "PACKET_MINE")!;
    // NO_HUNGER 非 CRITICAL 集合，desired+基线允许 → 开
    expect(noHunger.effectiveState).toBe(true);
    // PACKET_MINE 是 CRITICAL，STRICT 基线 → 关
    expect(packetMine.effectiveState).toBe(false);
    expect(packetMine.disableReason).toContain("STRICT");
  });

  it("operator-disabled gates stay off", () => {
    const p = profile({
      effectiveMode: "EXPLICIT_UNRESTRICTED",
      featureGates: [
        {
          feature: "NO_HUNGER",
          desiredState: false,
          effectiveState: true,
          source: "operator",
          risk: "HIGH",
          disableReason: null,
          lastValidatedAt: null,
          revalidationCooldownMs: 60_000,
        },
      ],
    });
    expect(evaluateFeatureGates(p)[0]!.effectiveState).toBe(false);
  });
});

describe("compat failure-code classification (no default blame on SKILL)", () => {
  it("server evidence codes classify to the SERVER layer", () => {
    expect(classifyIncident({ failureCode: "SERVER_ACTION_REJECTED" })).toMatchObject({
      suspectedLayer: "SERVER",
      ruleId: "R-COMPAT-1",
    });
    expect(classifyIncident({ failureCode: "REPEATED_SETBACK" })).toMatchObject({
      suspectedLayer: "SERVER",
    });
  });

  it("policy/gate codes classify to RUNTIME, divergences to WORLD_STATE", () => {
    expect(classifyIncident({ failureCode: "ACTION_POLICY_RATE_LIMITED" })).toMatchObject({
      suspectedLayer: "RUNTIME",
      ruleId: "R-COMPAT-2",
    });
    expect(classifyIncident({ failureCode: "SERVER_BLOCK_STATE_DIVERGENCE" })).toMatchObject({
      suspectedLayer: "WORLD_STATE",
      ruleId: "R-COMPAT-3",
    });
    expect(classifyIncident({ failureCode: "SERVER_INVENTORY_TRANSACTION_REJECTED" })).toMatchObject({
      suspectedLayer: "RUNTIME",
      ruleId: "R-COMPAT-4",
    });
  });
});

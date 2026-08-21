import { describe, expect, it } from "vitest";

import {
  baselineLimits,
  candidateLadder,
  MAX_PROBE_STEPS,
  probeDimensions,
  ServerPolicyDetector,
  ServerPolicyProbeSession,
  VANILLA_BLOCK_INTERACTION_REACH,
  type ProbeDimension,
  type ProbeObservationKind,
  type ProbeStep,
} from "../src/index.js";

const ISOLATED = {
  serverProfileId: "local-isolated-test",
  host: "127.0.0.1",
  networkScope: "loopback",
  purpose: "isolated-test",
  operatorAcknowledged: true,
} as const;

function session(dimensions?: readonly ProbeDimension[]) {
  return new ServerPolicyProbeSession(
    "local-isolated-test",
    baselineLimits("STRICT"),
    dimensions,
  );
}

function evidenceFor(
  step: ProbeStep,
  observation: ProbeObservationKind,
  index = step.stepIndex,
) {
  return {
    evidenceId: `probe-${step.dimension}-${index}`,
    serverProfileId: "local-isolated-test",
    dimension: step.dimension,
    candidateValue: step.candidateValue,
    stableValue: step.stableValue,
    observation,
    observedAtMs: 1_000 * index,
  };
}

/** 把会话按给定观测序列跑完，返回实际执行过的步骤。 */
function run(
  probe: ServerPolicyProbeSession,
  observations: readonly ProbeObservationKind[],
): readonly ProbeStep[] {
  const steps: ProbeStep[] = [];
  for (const observation of observations) {
    const step = probe.nextStep();
    if (step === null) break;
    steps.push(step);
    probe.submit(evidenceFor(step, observation, steps.length));
  }
  return steps;
}

describe("candidateLadder bounds", () => {
  it("never proposes a value beyond the NORMAL baseline", () => {
    const strict = baselineLimits("STRICT");
    const normal = baselineLimits("NORMAL");
    for (const dimension of probeDimensions) {
      for (const rung of candidateLadder(dimension, strict[dimension])) {
        if (dimension === "minActionIntervalMs") {
          expect(rung).toBeGreaterThanOrEqual(normal.minActionIntervalMs);
        } else {
          expect(rung).toBeLessThanOrEqual(normal[dimension]);
        }
      }
    }
  });

  it("keeps reach ladders inside vanilla interaction mechanics", () => {
    for (const rung of candidateLadder("blockInteractionReach", 3.8)) {
      expect(rung).toBeLessThanOrEqual(VANILLA_BLOCK_INTERACTION_REACH);
    }
    expect(candidateLadder("blockInteractionReach", 3.8).at(-1)).toBe(
      VANILLA_BLOCK_INTERACTION_REACH,
    );
  });

  it("returns nothing to probe when already at the outer bound", () => {
    const normal = baselineLimits("NORMAL");
    expect(candidateLadder("maxAttacksPerSecond", normal.maxAttacksPerSecond)).toEqual(
      [],
    );
    expect(
      candidateLadder("minActionIntervalMs", normal.minActionIntervalMs),
    ).toEqual([]);
    expect(candidateLadder("entityAttackReach", Number.NaN)).toEqual([]);
  });

  it("walks the interval dimension downward, never upward", () => {
    const rungs = candidateLadder("minActionIntervalMs", 150);
    expect(rungs.length).toBeGreaterThan(0);
    for (const rung of rungs) expect(rung).toBeLessThan(150);
    expect(rungs.at(-1)).toBe(baselineLimits("NORMAL").minActionIntervalMs);
  });

  it("produces reproducible values rather than raw interpolation", () => {
    for (const rung of candidateLadder("blockInteractionReach", 3.8)) {
      expect(Math.round(rung * 10) / 10).toBe(rung);
    }
    for (const rung of candidateLadder("maxAttacksPerSecond", 6)) {
      expect(Number.isInteger(rung)).toBe(true);
    }
  });
});

describe("ServerPolicyProbeSession halting", () => {
  it("stops the whole session on a correction instead of trying the next rung", () => {
    const probe = session(["blockInteractionReach", "maxAttacksPerSecond"]);
    const total = probe.totalSteps;
    expect(total).toBeGreaterThan(2);

    const first = probe.nextStep();
    expect(first).not.toBeNull();
    probe.submit(evidenceFor(first as ProbeStep, "accepted", 1));
    const second = probe.nextStep();
    probe.submit(evidenceFor(second as ProbeStep, "correction", 2));

    expect(probe.sessionState).toBe("halted");
    expect(probe.haltedBecause).toBe("correction");
    expect(probe.nextStep()).toBeNull();
    expect(probe.evidence).toHaveLength(2);
  });

  it("rolls the probed dimension back to its last stable value on a warning", () => {
    const probe = session(["blockInteractionReach"]);
    run(probe, ["accepted", "warning"]);

    expect(probe.sessionState).toBe("halted");
    // 被告警的维度整体回退到稳定值，不保留同维度早前接受过的中间档。
    expect(probe.resolvedLimits().blockInteractionReach).toBe(
      baselineLimits("STRICT").blockInteractionReach,
    );
    expect(probe.outcome().policy).toBeNull();
  });

  it("keeps confirmed widening from other dimensions after a warning", () => {
    const probe = session(["blockInteractionReach", "maxAttacksPerSecond"]);
    const reachSteps = candidateLadder("blockInteractionReach", 3.8).length;
    const observations: ProbeObservationKind[] = Array.from(
      { length: reachSteps },
      () => "accepted" as const,
    );
    observations.push("warning");
    const steps = run(probe, observations);

    expect(steps.at(-1)?.dimension).toBe("maxAttacksPerSecond");
    const limits = probe.resolvedLimits();
    expect(limits.blockInteractionReach).toBe(VANILLA_BLOCK_INTERACTION_REACH);
    expect(limits.maxAttacksPerSecond).toBe(
      baselineLimits("STRICT").maxAttacksPerSecond,
    );
  });

  it("discards every confirmed widening on a kick", () => {
    const probe = session(["blockInteractionReach", "maxAttacksPerSecond"]);
    const reachSteps = candidateLadder("blockInteractionReach", 3.8).length;
    const observations: ProbeObservationKind[] = Array.from(
      { length: reachSteps },
      () => "accepted" as const,
    );
    observations.push("kick");
    run(probe, observations);

    expect(probe.haltedBecause).toBe("kick");
    expect(probe.resolvedLimits()).toEqual(baselineLimits("STRICT"));
    expect(probe.outcome().policy).toBeNull();
    // 证据仍然完整留档，包括那些"曾被接受"的记录。
    expect(probe.evidence.length).toBe(reachSteps + 1);
  });

  it("stops on operator request and keeps what was already confirmed", () => {
    const probe = session(["blockInteractionReach"]);
    run(probe, ["accepted"]);
    probe.stop();

    expect(probe.sessionState).toBe("stopped");
    expect(probe.haltedBecause).toBe("operator-stop");
    expect(probe.nextStep()).toBeNull();
    expect(probe.resolvedLimits().blockInteractionReach).toBeGreaterThan(
      baselineLimits("STRICT").blockInteractionReach,
    );
  });
});

describe("ServerPolicyProbeSession bookkeeping", () => {
  it("re-issues the same step until an observation is submitted", () => {
    const probe = session(["blockInteractionReach"]);
    const first = probe.nextStep();
    expect(probe.nextStep()).toEqual(first);
    expect(probe.nextStep()).toEqual(first);
    probe.submit(evidenceFor(first as ProbeStep, "accepted", 1));
    expect(probe.nextStep()).not.toEqual(first);
  });

  it("rejects evidence that does not match the pending step", () => {
    const probe = session(["blockInteractionReach"]);
    const step = probe.nextStep() as ProbeStep;

    expect(
      probe.submit({ ...evidenceFor(step, "accepted"), candidateValue: 4.49 }),
    ).toMatchObject({ accepted: false, errorCode: "PROBE_OBSERVATION_MISMATCH" });
    expect(
      probe.submit({
        ...evidenceFor(step, "accepted"),
        serverProfileId: "other-server",
      }),
    ).toMatchObject({ accepted: false, errorCode: "PROBE_OBSERVATION_MISMATCH" });
    expect(probe.submit({ evidenceId: "probe-1" })).toMatchObject({
      accepted: false,
      errorCode: "PROBE_EVIDENCE_INVALID",
    });
    expect(probe.evidence).toHaveLength(0);
  });

  it("refuses observations when no step is pending", () => {
    const probe = session(["blockInteractionReach"]);
    const step = probe.nextStep() as ProbeStep;
    expect(probe.submit(evidenceFor(step, "accepted", 1)).accepted).toBe(true);
    expect(probe.submit(evidenceFor(step, "accepted", 1))).toMatchObject({
      accepted: false,
      errorCode: "PROBE_NOT_RUNNING",
    });
  });

  it("completes with a probed CUSTOM_VERIFIED policy carrying its evidence", () => {
    const probe = session(["blockInteractionReach"]);
    const rungs = candidateLadder("blockInteractionReach", 3.8).length;
    run(
      probe,
      Array.from({ length: rungs }, () => "accepted" as const),
    );

    expect(probe.sessionState).toBe("completed");
    const outcome = probe.outcome();
    expect(outcome.policy).toMatchObject({
      profile: "CUSTOM_VERIFIED",
      origin: "probed",
      serverProfileId: "local-isolated-test",
    });
    expect(outcome.policy?.limits.blockInteractionReach).toBe(
      VANILLA_BLOCK_INTERACTION_REACH,
    );
    expect(outcome.policy?.evidenceIds).toHaveLength(rungs);
  });

  it("reports nothing to probe when the starting limits are already widest", () => {
    const probe = new ServerPolicyProbeSession(
      "local-isolated-test",
      baselineLimits("NORMAL"),
    );
    expect(probe.totalSteps).toBe(0);
    expect(probe.sessionState).toBe("completed");
    expect(probe.nextStep()).toBeNull();
    expect(probe.outcome().policy).toBeNull();
  });

  it("keeps the whole plan inside the step budget", () => {
    const probe = session();
    expect(probe.totalSteps).toBeGreaterThan(0);
    expect(probe.totalSteps).toBeLessThanOrEqual(MAX_PROBE_STEPS);
  });
});

describe("ServerPolicyDetector authorization", () => {
  it("refuses any target that is not a loopback isolated test server", () => {
    const detector = new ServerPolicyDetector();
    const limits = baselineLimits("STRICT");

    expect(
      detector.start({ ...ISOLATED, host: "mc.example.com" }, limits),
    ).toMatchObject({ started: false, errorCode: "PROBE_TARGET_NOT_ISOLATED" });
    expect(
      detector.start({ ...ISOLATED, networkScope: "public" }, limits),
    ).toMatchObject({ started: false, errorCode: "PROBE_TARGET_NOT_ISOLATED" });
    expect(
      detector.start({ ...ISOLATED, purpose: "production" }, limits),
    ).toMatchObject({ started: false, errorCode: "PROBE_TARGET_NOT_ISOLATED" });
    expect(
      detector.start({ ...ISOLATED, operatorAcknowledged: false }, limits),
    ).toMatchObject({ started: false, errorCode: "PROBE_TARGET_NOT_ISOLATED" });
    expect(detector.start({ host: "127.0.0.1" }, limits)).toMatchObject({
      started: false,
      errorCode: "PROBE_AUTHORIZATION_INVALID",
    });
  });

  it("starts a session for an authorized isolated server", () => {
    const detector = new ServerPolicyDetector();
    const started = detector.start(ISOLATED, baselineLimits("STRICT"));
    expect(started.started).toBe(true);
    expect(detector.session("local-isolated-test")).not.toBeNull();
    expect(detector.session("other-server")).toBeNull();
  });

  it("allows only one running session per server", () => {
    const detector = new ServerPolicyDetector();
    detector.start(ISOLATED, baselineLimits("STRICT"));
    expect(detector.start(ISOLATED, baselineLimits("STRICT"))).toMatchObject({
      started: false,
      errorCode: "PROBE_ALREADY_RUNNING",
    });

    detector.stop("local-isolated-test");
    expect(detector.start(ISOLATED, baselineLimits("STRICT")).started).toBe(true);
  });
});

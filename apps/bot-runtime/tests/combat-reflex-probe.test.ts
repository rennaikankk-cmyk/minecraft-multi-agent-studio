import { describe, expect, it } from "vitest";

import {
  decideReflexClearance,
  REFLEX_BUDGET_MS,
} from "@minecraft-studio/combat";
import { CombatReactionLoopProbe } from "../src/combat-reflex-probe.js";

describe("CombatReactionLoopProbe", () => {
  it("fails closed with NO_PROBE_DATA until the first step is measured", () => {
    const probe = new CombatReactionLoopProbe();
    expect(probe.report("local-isolated-test")).toBeNull();
    expect(decideReflexClearance(probe.report("local-isolated-test"), "local-isolated-test"))
      .toMatchObject({ cleared: false, denial: "NO_PROBE_DATA" });

    probe.recordStepDurationMs(12);
    expect(probe.report("local-isolated-test")).not.toBeNull();
    expect(probe.sampleCount).toBe(1);
  });

  it("computes an empirical p99 over bounded samples and reports the server profile", () => {
    const probe = new CombatReactionLoopProbe({ maxSamples: 8 });
    for (let index = 0; index < 100; index += 1) probe.recordStepDurationMs(10);
    probe.recordStepDurationMs(500);
    const report = probe.report("local-isolated-test");
    expect(report).toMatchObject({
      serverProfileId: "local-isolated-test",
      samples: 8,
      underRepresentativeLoad: false,
    });
    // 环只保留最近 8 个样本：p99 就是这批（含一个 500ms 离群）的上界附近。
    expect(report?.p99LoopDelayMs).toBe(500);

    // 非法步长被丢弃，不进样本。
    probe.recordStepDurationMs(Number.NaN);
    probe.recordStepDurationMs(-5);
    expect(probe.sampleCount).toBe(8);
  });

  it("never clears reflex modules on its own (representative load is not self-certified)", () => {
    const fewSlow = new CombatReactionLoopProbe();
    fewSlow.recordStepDurationMs(REFLEX_BUDGET_MS * 4);
    expect(decideReflexClearance(fewSlow.report("s")!, "s").denial)
      .toBe("INSUFFICIENT_SAMPLES");

    const manyFast = new CombatReactionLoopProbe();
    for (let index = 0; index < 1_500; index += 1) {
      manyFast.recordStepDurationMs(5);
    }
    // 样本足量且 p99 达标，仍拒绝：代表性负载未自证（wiring-pending）。
    expect(decideReflexClearance(manyFast.report("s")!, "s")).toMatchObject({
      cleared: false,
      denial: "LOAD_NOT_REPRESENTATIVE",
    });
  });

  it("records threat to packet dispatch to server confirmation timings", () => {
    const probe = new CombatReactionLoopProbe();
    probe.recordThreatEvent("reaction-1", 100);
    probe.recordDecision("reaction-1", 108);
    probe.recordPacketDispatch("reaction-1", 110);
    probe.recordServerConfirmation("reaction-1", 145);
    expect(probe.endToEndReport()).toEqual({
      samples: 1,
      p95ThreatToDecisionMs: 8,
      p95DecisionToPacketMs: 2,
      p95PacketToServerMs: 35,
      p95TotalMs: 45,
    });
  });
});

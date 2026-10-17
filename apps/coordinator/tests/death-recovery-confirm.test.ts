import { describe, expect, it } from "vitest";

import { deathRecoveryConfirmed } from "../src/autonomous-director.js";

const output = {
  reached: true,
  finalPosition: {
    x: 12,
    y: 64,
    z: -6,
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-local",
  },
  distanceToTarget: 0.2,
  recovered: [{ itemId: "diamond", count: 2 }],
  stillNearby: 0,
  expectedMissing: [],
};

const expected = {
  botId: "worker-01",
  taskId: "recovery-task",
  runtimeInstanceId: "runtime-01",
  diedAt: "2026-10-17T00:00:00.000Z",
  target: { ...output.finalPosition },
};

function result(skillId: string, stillNearby = 0) {
  return {
    action: "skill_result" as const,
    reasonCode: "DETERMINISTIC_RECOVER_DROPS",
    invocation: {
      botId: expected.botId, taskId: expected.taskId,
      payload: { skillId, skillVersion: "1.0.0", invocationId: "invocation-01", input: { target: { ...expected.target } } },
    },
    result: {
      botId: expected.botId, taskId: expected.taskId, source: { instanceId: expected.runtimeInstanceId },
      payload: {
        skillId, skillVersion: "1.0.0", invocationId: "invocation-01",
        outcome: "completed" as const,
        output: { ...output, finalPosition: { ...output.finalPosition }, stillNearby },
      },
    },
    ai: null,
  };
}

describe("death recovery confirmation", () => {
  it("accepts only a recover.drops result that left no items nearby", () => {
    expect(deathRecoveryConfirmed(result("recover.drops") as never, expected)).toBe(true);
    expect(deathRecoveryConfirmed(result("recover.drops", 1) as never, expected)).toBe(false);
    expect(deathRecoveryConfirmed(result("movement.goto") as never, expected)).toBe(false);
    expect(deathRecoveryConfirmed({ action: "noop", reasonCode: "ADVANCE_TASK", ai: null } as never, expected)).toBe(false);
  });

  it.each([
    ["invoked bot", (r: ReturnType<typeof result>) => { r.invocation.botId = "another-bot"; }],
    ["returned bot", (r: ReturnType<typeof result>) => { r.result.botId = "another-bot"; }],
    ["invoked task", (r: ReturnType<typeof result>) => { r.invocation.taskId = "another-task"; }],
    ["returned task", (r: ReturnType<typeof result>) => { r.result.taskId = "another-task"; }],
    ["runtime", (r: ReturnType<typeof result>) => { r.result.source.instanceId = "another-runtime"; }],
    ["invocation", (r: ReturnType<typeof result>) => { r.result.payload.invocationId = "another-invocation"; }],
    ["version", (r: ReturnType<typeof result>) => { r.result.payload.skillVersion = "2.0.0"; }],
    ["skill", (r: ReturnType<typeof result>) => { r.result.payload.skillId = "movement.goto"; }],
    ["target position", (r: ReturnType<typeof result>) => { r.invocation.payload.input.target.x += 1; }],
    ["target server", (r: ReturnType<typeof result>) => { r.invocation.payload.input.target.serverProfileId = "another-server"; }],
    ["target dimension", (r: ReturnType<typeof result>) => { r.invocation.payload.input.target.dimension = "minecraft:the_nether"; }],
    ["output server", (r: ReturnType<typeof result>) => { r.result.payload.output.finalPosition.serverProfileId = "another-server"; }],
    ["output dimension", (r: ReturnType<typeof result>) => { r.result.payload.output.finalPosition.dimension = "minecraft:the_nether"; }],
  ] as const)("rejects a receipt with mismatched %s", (_name, mutate) => {
    const receipt = result("recover.drops");
    mutate(receipt);
    expect(deathRecoveryConfirmed(receipt as never, expected)).toBe(false);
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  movementGotoSkill,
  SkillExecutor,
  SkillFault,
  SkillRegistry,
  type SkillExecutionAuthorization,
} from "../src/index.js";

const NOW = "2026-07-27T10:00:00.000Z";
const invocation = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-pathfinder-001",
  timestamp: NOW,
  source: { service: "coordinator" as const, instanceId: "coordinator-01" },
  botId: "worker-01",
  taskId: "task-pathfinder-001",
  type: "skill.invoke.v1" as const,
  payload: {
    invocationId: "22222222-2222-4222-8222-222222222222",
    skillId: "movement.goto",
    skillVersion: "1.0.0",
    expiresAt: "2026-07-27T10:01:00.000Z",
    input: {
      target: {
        x: 12,
        y: 64,
        z: -6,
        dimension: "minecraft:overworld",
        serverProfileId: "isolated-local",
      },
      radius: 2,
    },
    authorization: {
      decisionId: "33333333-3333-4333-8333-333333333333",
      actorId: "coordinator-agent",
      issuedAt: "2026-07-27T09:59:59.000Z",
      expiresAt: "2026-07-27T10:01:00.000Z",
    },
  },
};

const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: "isolated-local",
  position: {
    x: 10,
    y: 64,
    z: -5,
    dimension: "minecraft:overworld",
    serverProfileId: "isolated-local",
  },
};

function authorization(): SkillExecutionAuthorization {
  return {
    decisionId: invocation.payload.authorization.decisionId,
    actorId: invocation.payload.authorization.actorId,
    sourceInstanceId: invocation.source.instanceId,
    traceId: invocation.traceId,
    taskId: invocation.taskId,
    botId: invocation.botId,
    invocationId: invocation.payload.invocationId,
    skillId: invocation.payload.skillId,
    skillVersion: invocation.payload.skillVersion,
    issuedAt: invocation.payload.authorization.issuedAt,
    expiresAt: invocation.payload.authorization.expiresAt,
    allowedCapabilities: new Set(["bot.move"]),
  };
}

function executor(invoke = vi.fn()) {
  const registry = new SkillRegistry();
  registry.register(movementGotoSkill);
  return {
    invoke,
    executor: new SkillExecutor(registry, {
      runtimeInstanceId: "runtime-01",
      capabilityAdapter: { invoke },
      now: () => new Date(NOW),
      random: () => 0,
      messageId: () => "44444444-4444-4444-8444-444444444444",
    }),
  };
}

describe("movement.goto@1.0.0", () => {
  it("declares idempotent — L0 STUCK pause must be replayable, not a terminal abort", () => {
    // L2 实证（2026-09-03 重跑）：idempotent:false 时，重启后起步瞬态触发
    // L0 STUCK（5s 位移<ε）→ 在飞 movement 被取消 → NON_IDEMPOTENT_L0_RETRY_
    // UNSAFE → goal 必死。移动到目标点无不可逆副作用，重放收敛——此声明
    // 是 L0 取消/协调器重启/传输失败三条恢复路径的共同前提。
    expect(movementGotoSkill.idempotent).toBe(true);
  });

  it("calls only the bounded Pathfinder capability", async () => {
    const adapter = vi.fn(async () => ({
      reached: true,
      finalPosition: invocation.payload.input.target,
      distanceToTarget: 0,
    }));
    const run = executor(adapter);

    const result = await run.executor.execute(
      invocation,
      authorization(),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { reached: true, distanceToTarget: 0 },
    });
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "bot.move",
        operation: "pathfinder.goto-safe",
        input: invocation.payload.input,
      }),
    );
  });

  it("retries transient PATHFINDER_GOTO_FAILED (fresh-spawn NoPath window)", async () => {
    // L2 实证（2026-09-03 第二轮）：durable 恢复在 catalog 后 ~100ms 派发，
    // 出生 chunk 未加载 → NoPath 55ms。前两次 NoPath、第三次成功 → 必须完成
    // 而非终态 FAIL（attempts=3 证明重试真发生）。
    const adapter = vi.fn()
      .mockRejectedValueOnce(new SkillFault("PATHFINDER_GOTO_FAILED", "NoPath: No path to the goal!"))
      .mockRejectedValueOnce(new SkillFault("PATHFINDER_GOTO_FAILED", "NoPath: No path to the goal!"))
      .mockResolvedValueOnce({
        reached: true,
        finalPosition: invocation.payload.input.target,
        distanceToTarget: 0,
      });
    const run = executor(adapter);

    const result = await run.executor.execute(
      invocation,
      authorization(),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      attempts: 3,
      output: { reached: true },
    });
    expect(adapter).toHaveBeenCalledTimes(3);
  });

  it("rejects paused, cross-dimension and distant targets before movement", async () => {
    const run = executor();

    expect(
      (
        await run.executor.execute(invocation, authorization(), {
          ...state,
          normalActionsAllowed: false,
        })
      ).payload.errorCode,
    ).toBe("NORMAL_ACTIONS_PAUSED");

    expect(
      (
        await run.executor.execute(
          {
            ...invocation,
            payload: {
              ...invocation.payload,
              input: {
                ...invocation.payload.input,
                target: {
                  ...invocation.payload.input.target,
                  dimension: "minecraft:the_nether",
                },
              },
            },
          },
          authorization(),
          state,
        )
      ).payload.errorCode,
    ).toBe("TARGET_DIMENSION_MISMATCH");

    expect(
      (
        await run.executor.execute(
          {
            ...invocation,
            payload: {
              ...invocation.payload,
              input: {
                ...invocation.payload.input,
                target: { ...invocation.payload.input.target, x: 100 },
              },
            },
          },
          authorization(),
          state,
        )
      ).payload.errorCode,
    ).toBe("TARGET_OUT_OF_SAFE_RANGE");
    expect(run.invoke).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  SkillExecutor,
  SkillFault,
  SkillFrameworkError,
  SkillRefusal,
  SkillRegistry,
  defineSkill,
  type SkillDefinition,
  type SkillExecutionAuthorization,
  type SkillExecutorOptions,
} from "../src/index.js";

const NOW = "2026-07-27T08:00:00.000Z";
const RESULT_ID = "44444444-4444-4444-8444-444444444444";

const invocation = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-skill-001",
  timestamp: NOW,
  source: { service: "coordinator" as const, instanceId: "coordinator-01" },
  botId: "worker-01",
  taskId: "task-001",
  type: "skill.invoke.v1" as const,
  payload: {
    invocationId: "22222222-2222-4222-8222-222222222222",
    skillId: "movement.step",
    skillVersion: "1.0.0",
    expiresAt: "2026-07-27T08:01:00.000Z",
    input: { distance: 1 },
    authorization: {
      decisionId: "33333333-3333-4333-8333-333333333333",
      actorId: "coordinator-agent",
      issuedAt: "2026-07-27T07:59:59.000Z",
      expiresAt: "2026-07-27T08:01:00.000Z",
    },
  },
};

function authorization(
  overrides: Partial<SkillExecutionAuthorization> = {},
): SkillExecutionAuthorization {
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
    ...overrides,
  };
}

const inputSchema = z.object({ distance: z.number().int().min(1).max(3) }).strict();
const outputSchema = z.object({ moved: z.boolean() }).strict();
const stateSchema = z.object({ online: z.boolean() }).strict();

function movementSkill(
  execute: SkillDefinition<
    z.infer<typeof inputSchema>,
    z.infer<typeof outputSchema>,
    z.infer<typeof stateSchema>
  >["execute"] = async (context, input) => {
    const result = await context.callCapability<{ accepted: boolean }>(
      "bot.move",
      "movement.step",
      { distance: input.distance },
    );
    return { moved: result.accepted };
  },
) {
  return defineSkill({
    id: "movement.step",
    version: "1.0.0",
    inputSchema,
    outputSchema,
    stateSchema,
    compatibility: {
      variants: [
        { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
      ],
    },
    requiredCapabilities: ["bot.move"] as const,
    timeoutMs: 200,
    idempotent: false,
    retryPolicy: {
      maxAttempts: 1,
      baseDelayMs: 10,
      maxDelayMs: 50,
      retryableErrorCodes: [],
    },
    preconditions: [
      {
        id: "bot.online",
        failureCode: "BOT_NOT_ONLINE",
        check: (_input, state) => state.online,
      },
    ],
    execute,
  });
}

function executor(
  registry: SkillRegistry,
  capabilityAdapter?: { invoke: ReturnType<typeof vi.fn> },
  onFault?: SkillExecutorOptions["onFault"],
) {
  return new SkillExecutor(registry, {
    runtimeInstanceId: "runtime-01",
    now: () => new Date(NOW),
    random: () => 0,
    messageId: () => RESULT_ID,
    ...(capabilityAdapter ? { capabilityAdapter } : {}),
    ...(onFault ? { onFault } : {}),
  });
}

describe("SkillRegistry", () => {
  it("keeps exact immutable versions without a latest-version fallback", () => {
    const registry = new SkillRegistry();
    registry.register(movementSkill());
    registry.register({ ...movementSkill(), version: "1.1.0" });

    expect(registry.resolve("movement.step", "1.0.0")?.version).toBe("1.0.0");
    expect(registry.resolve("movement.step", "2.0.0")).toBeNull();
    expect(registry.list().map(({ version }) => version)).toEqual([
      "1.0.0",
      "1.1.0",
    ]);
    expect(Object.isFrozen(registry.list()[0])).toBe(true);
  });

  it("rejects duplicate versions and unsafe retry declarations", () => {
    const registry = new SkillRegistry();
    registry.register(movementSkill());
    expect(() => registry.register(movementSkill())).toThrowError(
      expect.objectContaining({ code: "DUPLICATE_SKILL_VERSION" }),
    );

    expect(() =>
      new SkillRegistry().register({
        ...movementSkill(),
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 50,
          retryableErrorCodes: ["TEMPORARY_FAILURE"],
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SKILL_DEFINITION" }));
    expect(() =>
      new SkillRegistry().register({
        ...movementSkill(),
        requiredCapabilities: ["bot.move", "bot.move"],
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SKILL_DEFINITION" }));
  });
});

describe("SkillExecutor", () => {
  it("executes only through a declared and trusted capability grant", async () => {
    const registry = new SkillRegistry();
    registry.register(movementSkill());
    const invoke = vi.fn(async () => ({ accepted: true }));
    const result = await executor(registry, { invoke }).execute(
      invocation,
      authorization(),
      { online: true },
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      attempts: 1,
      output: { moved: true },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "worker-01",
        skillId: "movement.step",
        skillVersion: "1.0.0",
        capability: "bot.move",
        operation: "movement.step",
        input: { distance: 1 },
      }),
    );
  });

  it("rejects mismatched authorization, missing grants and expired work", async () => {
    const registry = new SkillRegistry();
    registry.register(movementSkill());
    const run = executor(registry);

    expect(
      (await run.execute(invocation, authorization({ botId: "other" }), {
        online: true,
      })).payload.errorCode,
    ).toBe("SKILL_AUTH_MISMATCH");
    expect(
      (
        await run.execute(
          invocation,
          authorization({ allowedCapabilities: new Set() }),
          { online: true },
        )
      ).payload.errorCode,
    ).toBe("SKILL_CAPABILITY_DENIED");

    const expired = new SkillExecutor(registry, {
      runtimeInstanceId: "runtime-01",
      now: () => new Date("2026-07-27T08:02:00.000Z"),
      messageId: () => RESULT_ID,
    });
    expect(
      (await expired.execute(invocation, authorization(), { online: true }))
        .payload.errorCode,
    ).toBe("SKILL_AUTH_EXPIRED");
  });

  it("validates skill input, live state and deterministic preconditions", async () => {
    const registry = new SkillRegistry();
    const handler = vi.fn(movementSkill().execute);
    registry.register(movementSkill(handler));
    const run = executor(registry);

    const invalidInput = {
      ...invocation,
      payload: { ...invocation.payload, input: { distance: 99 } },
    };
    expect(
      (await run.execute(invalidInput, authorization(), { online: true })).payload
        .errorCode,
    ).toBe("SKILL_INPUT_INVALID");
    expect(
      (await run.execute(invocation, authorization(), { online: false })).payload
        .errorCode,
    ).toBe("BOT_NOT_ONLINE");
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a skill whose negotiated version requirements are unavailable", async () => {
    const registry = new SkillRegistry();
    const handler = vi.fn(movementSkill().execute);
    registry.register({
      ...movementSkill(handler),
      compatibility: {
        variants: [
          {
            id: "elytra-native",
            requirements: [{ kind: "feature", name: "hasElytraFlying" }],
            verifiedMinecraftVersions: [],
          },
        ],
      },
    });
    const result = await executor(registry).execute(
      invocation,
      authorization(),
      { online: true },
      undefined,
      {
        minecraftVersion: "1.8.8",
        protocolVersion: 47,
        supportsFeature: () => false,
        hasResource: () => false,
        serverCapability: () => undefined,
      },
    );

    expect(result.payload).toMatchObject({
      outcome: "rejected",
      attempts: 0,
      errorCode: "SKILL_VERSION_UNAVAILABLE",
    });
    expect(handler).not.toHaveBeenCalled();
  });

  /**
   * `SkillRefusal` 是抛出点声明"这次调用什么都没改动"，executor 据此报
   * `rejected`——协议里 rejected 一直就是这个意思。
   *
   * 为什么不能沿用 `attempts === 0` 当判据：attempts 在 definition.execute
   * 一进去就是 1，不管适配器有没有碰过世界。所以这条断言要同时钉住两件事——
   * 出口是 rejected，而 attempts 仍然如实是 1。把 attempts 抹成 0 会让"跑过一次"
   * 这个事实消失，遥测再也分不出谢绝和根本没派发。
   */
  it("reports a refusal that touched nothing as rejected with the real attempt count", async () => {
    const registry = new SkillRegistry();
    registry.register(
      defineSkill({
        ...movementSkill(),
        id: "observation.refusal",
        requiredCapabilities: [] as const,
        preconditions: [],
        execute: async () => {
          throw new SkillRefusal(
            "COLLECT_TARGET_UNREACHABLE",
            "pre-check proved every candidate unreachable",
          );
        },
      }),
    );
    const onFault = vi.fn();
    const refusalInvocation = {
      ...invocation,
      payload: { ...invocation.payload, skillId: "observation.refusal" },
    };
    const result = await executor(registry, undefined, onFault).execute(
      refusalInvocation,
      authorization({
        skillId: "observation.refusal",
        allowedCapabilities: new Set(),
      }),
      { online: true },
    );

    expect(result.payload).toMatchObject({
      outcome: "rejected",
      attempts: 1,
      errorCode: "COLLECT_TARGET_UNREACHABLE",
    });
    // 拒绝仍然是失败：原因照样进 onFault，协议面照样不带 reason。
    expect(result.payload).not.toHaveProperty("reason");
    expect(onFault.mock.calls[0]![0]).toMatchObject({
      errorCode: "COLLECT_TARGET_UNREACHABLE",
      reason: "pre-check proved every candidate unreachable",
    });
  });

  /** 普通 SkillFault 不许蹭这条通道：可能已经产生副作用，出口必须还是 failed。 */
  it("keeps a plain fault reported as failed", async () => {
    const registry = new SkillRegistry();
    registry.register(
      defineSkill({
        ...movementSkill(),
        id: "observation.plainfault",
        requiredCapabilities: [] as const,
        preconditions: [],
        execute: async () => {
          throw new SkillFault("COLLECT_TARGET_UNREACHABLE", "NoPath mid-collect");
        },
      }),
    );
    const result = await executor(registry).execute(
      {
        ...invocation,
        payload: { ...invocation.payload, skillId: "observation.plainfault" },
      },
      authorization({
        skillId: "observation.plainfault",
        allowedCapabilities: new Set(),
      }),
      { online: true },
    );

    expect(result.payload).toMatchObject({
      outcome: "failed",
      errorCode: "COLLECT_TARGET_UNREACHABLE",
    });
  });

  it("blocks capability calls that the skill did not declare", async () => {
    const registry = new SkillRegistry();
    registry.register(
      movementSkill(async (context) => {
        await context.callCapability("inventory.write", "inventory.drop", {
          slot: 1,
        });
        return { moved: true };
      }),
    );
    const result = await executor(registry, {
      invoke: vi.fn(async () => ({ accepted: true })),
    }).execute(
      invocation,
      authorization({
        allowedCapabilities: new Set(["bot.move", "inventory.write"]),
      }),
      { online: true },
    );
    expect(result.payload).toMatchObject({
      outcome: "failed",
      errorCode: "SKILL_CAPABILITY_UNDECLARED",
    });
  });

  it("retries only declared faults for an idempotent skill", async () => {
    const registry = new SkillRegistry();
    let attempts = 0;
    registry.register(
      defineSkill({
        ...movementSkill(),
        id: "observation.retry",
        requiredCapabilities: [] as const,
        idempotent: true,
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 10,
          retryableErrorCodes: ["TEMPORARY_FAILURE"],
        },
        preconditions: [],
        execute: async () => {
          attempts += 1;
          if (attempts === 1) throw new SkillFault("TEMPORARY_FAILURE");
          return { moved: true };
        },
      }),
    );
    const retryInvocation = {
      ...invocation,
      payload: {
        ...invocation.payload,
        skillId: "observation.retry",
      },
    };
    const result = await executor(registry).execute(
      retryInvocation,
      authorization({
        skillId: "observation.retry",
        allowedCapabilities: new Set(),
      }),
      { online: true },
    );
    expect(result.payload).toMatchObject({ outcome: "completed", attempts: 2 });
  });

  /**
   * 结果消息只带屏蔽码，运维要的"为什么"留在这个钩子里。两半都要成立：终态失败
   * 必须报出原因，而重试后成功的那次失败不能报——否则日志里会出现一条没有对应
   * 故障的告警，和真实故障一样刺眼。
   */
  it("reports a terminal fault's reason without widening the result message", async () => {
    const registry = new SkillRegistry();
    registry.register(
      defineSkill({
        ...movementSkill(),
        id: "observation.fault",
        requiredCapabilities: [] as const,
        preconditions: [],
        execute: async () => {
          throw new SkillFault(
            "SKILL_CAPABILITY_FAILED",
            "goto_failed: no path to target",
          );
        },
      }),
    );
    const onFault = vi.fn();
    const faultInvocation = {
      ...invocation,
      payload: { ...invocation.payload, skillId: "observation.fault" },
    };
    const result = await executor(registry, undefined, onFault).execute(
      faultInvocation,
      authorization({
        skillId: "observation.fault",
        allowedCapabilities: new Set(),
      }),
      { online: true },
    );

    expect(result.payload).toMatchObject({
      outcome: "failed",
      errorCode: "SKILL_CAPABILITY_FAILED",
    });
    // 协议面不变宽：原因不进结果消息。
    expect(result.payload).not.toHaveProperty("reason");
    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault.mock.calls[0]![0]).toMatchObject({
      traceId: "trace-skill-001",
      skillId: "observation.fault",
      errorCode: "SKILL_CAPABILITY_FAILED",
      attempts: 1,
      reason: "goto_failed: no path to target",
    });
  });

  it("does not report a fault the retry ladder recovered from", async () => {
    const registry = new SkillRegistry();
    let attempts = 0;
    registry.register(
      defineSkill({
        ...movementSkill(),
        id: "observation.recovered",
        requiredCapabilities: [] as const,
        idempotent: true,
        retryPolicy: {
          maxAttempts: 2,
          baseDelayMs: 10,
          maxDelayMs: 10,
          retryableErrorCodes: ["TEMPORARY_FAILURE"],
        },
        preconditions: [],
        execute: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new SkillFault("TEMPORARY_FAILURE", "chunk_not_loaded");
          }
          return { moved: true };
        },
      }),
    );
    const onFault = vi.fn();
    const result = await executor(registry, undefined, onFault).execute(
      {
        ...invocation,
        payload: { ...invocation.payload, skillId: "observation.recovered" },
      },
      authorization({
        skillId: "observation.recovered",
        allowedCapabilities: new Set(),
      }),
      { online: true },
    );

    expect(result.payload).toMatchObject({ outcome: "completed", attempts: 2 });
    expect(onFault).not.toHaveBeenCalled();
  });

  /**
   * 能力实现没留下说明时，SkillFault 自带的占位文本会顶上来。它读着像一句解释，
   * 实际什么都没说——记成 reason 就等于给运维一条凭空的证据。这里钉住 null。
   */
  it("reports a null reason rather than the fault's placeholder text", async () => {
    const registry = new SkillRegistry();
    registry.register(
      defineSkill({
        ...movementSkill(),
        id: "observation.silent",
        requiredCapabilities: [] as const,
        preconditions: [],
        execute: async () => {
          throw new SkillFault("SKILL_CAPABILITY_FAILED");
        },
      }),
    );
    const onFault = vi.fn();
    await executor(registry, undefined, onFault).execute(
      {
        ...invocation,
        payload: { ...invocation.payload, skillId: "observation.silent" },
      },
      authorization({
        skillId: "observation.silent",
        allowedCapabilities: new Set(),
      }),
      { online: true },
    );

    expect(onFault).toHaveBeenCalledTimes(1);
    expect(onFault.mock.calls[0]![0]).toMatchObject({
      errorCode: "SKILL_CAPABILITY_FAILED",
      reason: null,
    });
  });

  it("returns bounded timeout and cancellation outcomes", async () => {
    const registry = new SkillRegistry();
    registry.register({
      ...movementSkill(async () => new Promise(() => undefined)),
      timeoutMs: 10,
    });
    const timedOut = await executor(registry).execute(
      invocation,
      authorization(),
      { online: true },
    );
    expect(timedOut.payload).toMatchObject({
      outcome: "timed_out",
      errorCode: "SKILL_TIMEOUT",
    });

    const cancellationRegistry = new SkillRegistry();
    cancellationRegistry.register(
      movementSkill(async () => new Promise(() => undefined)),
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await executor(cancellationRegistry).execute(
      invocation,
      authorization(),
      { online: true },
      controller.signal,
    );
    expect(cancelled.payload).toMatchObject({
      outcome: "cancelled",
      errorCode: "SKILL_CANCELLED",
    });
  });

  it("refuses invalid handler output and malformed invocation envelopes", async () => {
    const registry = new SkillRegistry();
    registry.register(
      movementSkill(async () => ({ moved: "yes" }) as unknown as { moved: boolean }),
    );
    expect(
      (await executor(registry).execute(invocation, authorization(), {
        online: true,
      })).payload.errorCode,
    ).toBe("SKILL_OUTPUT_INVALID");

    await expect(
      executor(registry).execute(
        { ...invocation, schemaVersion: "2.0" },
        authorization(),
        { online: true },
      ),
    ).rejects.toBeInstanceOf(SkillFrameworkError);
  });
});

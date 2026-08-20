import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  SkillExecutor,
  SkillFault,
  SkillFrameworkError,
  SkillRegistry,
  defineSkill,
  type SkillDefinition,
  type SkillExecutionAuthorization,
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
    expectedRuntimeInstanceId: "runtime-01",
    expectedStateSequence: 1,
    taskVersion: 1,
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

function executor(registry: SkillRegistry, capabilityAdapter?: { invoke: ReturnType<typeof vi.fn> }) {
  return new SkillExecutor(registry, {
    runtimeInstanceId: "runtime-01",
    now: () => new Date(NOW),
    random: () => 0,
    messageId: () => RESULT_ID,
    ...(capabilityAdapter ? { capabilityAdapter } : {}),
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

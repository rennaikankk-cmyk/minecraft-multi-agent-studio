import { describe, expect, it, vi } from "vitest";

import {
  baselineServerPolicy,
  combatControlInputSchema,
  combatControlStateSchema,
  combatDisengageOutputSchema,
  combatDisengageSkill,
  combatEngageOutputSchema,
  combatEngageSkill,
  ServerPolicyGate,
  SkillExecutor,
  SkillRegistry,
  type SkillExecutionAuthorization,
  type SkillPolicyView,
} from "../src/index.js";

const NOW = "2026-08-22T08:00:00.000Z";
const REQUESTED_AT_MS = Date.parse(NOW);
const SERVER = "isolated-local";

type CombatSkillId = "combat.engage" | "combat.disengage";

function invocation(skillId: CombatSkillId, input: unknown = { serverProfileId: SERVER }) {
  return {
    schemaVersion: "1.0" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: `trace-${skillId.replace(".", "-")}-001`,
    timestamp: NOW,
    source: { service: "coordinator" as const, instanceId: "coordinator-01" },
    botId: "combatant-01",
    taskId: `task-${skillId.replace(".", "-")}-001`,
    type: "skill.invoke.v1" as const,
    payload: {
      invocationId: "22222222-2222-4222-8222-222222222222",
      skillId,
      skillVersion: "1.0.0",
      expiresAt: "2026-08-22T08:01:00.000Z",
      input,
      authorization: {
        decisionId: "33333333-3333-4333-8333-333333333333",
        actorId: "coordinator-agent",
        issuedAt: "2026-08-22T07:59:59.000Z",
        expiresAt: "2026-08-22T08:01:00.000Z",
      },
    },
  };
}

function authorization(
  message: ReturnType<typeof invocation>,
): SkillExecutionAuthorization {
  return {
    decisionId: message.payload.authorization.decisionId,
    actorId: message.payload.authorization.actorId,
    sourceInstanceId: message.source.instanceId,
    traceId: message.traceId,
    taskId: message.taskId,
    botId: message.botId,
    invocationId: message.payload.invocationId,
    skillId: message.payload.skillId,
    skillVersion: message.payload.skillVersion,
    issuedAt: message.payload.authorization.issuedAt,
    expiresAt: message.payload.authorization.expiresAt,
    allowedCapabilities: new Set(["combat.control"]),
  };
}

const readyState = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: SERVER,
  combatAvailable: true,
  combatObservationAvailable: true,
};

function runWith(
  invoke = vi.fn(),
  policyView?: (serverProfileId: string) => SkillPolicyView,
) {
  const registry = new SkillRegistry();
  registry.register(combatEngageSkill);
  registry.register(combatDisengageSkill);
  return {
    invoke,
    executor: new SkillExecutor(registry, {
      runtimeInstanceId: "runtime-01",
      capabilityAdapter: { invoke },
      now: () => new Date(NOW),
      random: () => 0,
      messageId: () => "44444444-4444-4444-8444-444444444444",
      ...(policyView ? { policyView } : {}),
    }),
  };
}

function executed(action: "ENGAGE" | "DISENGAGE") {
  return {
    requested: { action, requestedAtMs: REQUESTED_AT_MS },
    actual: {
      disposition: "executed" as const,
      action,
      executedAtMs: REQUESTED_AT_MS + 5,
      reasonCode: null,
      targetEntityId: action === "ENGAGE" ? 42 : null,
    },
  };
}

describe("combat control schemas", () => {
  it("allows only the server profile in control-plane input", () => {
    expect(combatControlInputSchema.parse({ serverProfileId: SERVER })).toEqual({
      serverProfileId: SERVER,
    });
    expect(
      combatControlInputSchema.safeParse({
        serverProfileId: SERVER,
        targetEntityId: 42,
      }).success,
    ).toBe(false);
    expect(
      combatControlInputSchema.safeParse({
        serverProfileId: SERVER,
        whitelist: ["friend"],
      }).success,
    ).toBe(false);
  });

  it("strips unrelated fields from the shared runtime state", () => {
    expect(
      combatControlStateSchema.parse({
        ...readyState,
        inventory: { usedSlots: 4, totalSlots: 36 },
      }),
    ).toEqual(readyState);
  });

  it("rejects receipts that blur requested and actual execution", () => {
    expect(
      combatEngageOutputSchema.safeParse({
        requested: { action: "ENGAGE", requestedAtMs: 100 },
        actual: {
          disposition: "dropped",
          action: "ENGAGE",
          executedAtMs: null,
          reasonCode: "COMBAT_NO_HOSTILE_TARGET",
          targetEntityId: null,
        },
      }).success,
    ).toBe(false);
    expect(
      combatEngageOutputSchema.safeParse({
        requested: { action: "ENGAGE", requestedAtMs: 100 },
        actual: {
          disposition: "executed",
          action: "ENGAGE",
          executedAtMs: 99,
          reasonCode: null,
          targetEntityId: 42,
        },
      }).success,
    ).toBe(false);
    expect(
      combatDisengageOutputSchema.safeParse({
        requested: { action: "DISENGAGE", requestedAtMs: 100 },
        actual: {
          disposition: "modified",
          action: "RETREAT",
          executedAtMs: 101,
          reasonCode: "COMBAT_RETREAT_ALREADY_ACTIVE",
          targetEntityId: null,
        },
      }).success,
    ).toBe(true);
  });
});

describe("combat.engage@1.0.0", () => {
  it("submits only a bounded intent and records the runtime receipt", async () => {
    const invoke = vi.fn(async () => executed("ENGAGE"));
    const policyView = vi.fn((serverProfileId: string) =>
      new ServerPolicyGate(baselineServerPolicy(serverProfileId)),
    );
    const run = runWith(invoke, policyView);
    const message = invocation("combat.engage");

    const result = await run.executor.execute(
      message,
      authorization(message),
      { ...readyState, unrelatedObservation: true },
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: executed("ENGAGE"),
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "combat.control",
        operation: "combat.engage",
        input: { serverProfileId: SERVER },
      }),
    );
    expect(policyView).toHaveBeenCalledWith(SERVER);
  });

  it("fails closed in precondition order before capability execution", async () => {
    const cases = [
      [{ ...readyState, online: false }, "BOT_NOT_ONLINE"],
      [{ ...readyState, normalActionsAllowed: false }, "NORMAL_ACTIONS_PAUSED"],
      [{ ...readyState, serverProfileId: "other-server" }, "TARGET_SERVER_PROFILE_MISMATCH"],
      [{ ...readyState, combatAvailable: false }, "COMBAT_DRIVER_UNAVAILABLE"],
      [{ ...readyState, combatObservationAvailable: false }, "COMBAT_OBSERVATION_UNAVAILABLE"],
    ] as const;

    for (const [state, errorCode] of cases) {
      const run = runWith();
      const message = invocation("combat.engage");
      const result = await run.executor.execute(message, authorization(message), state);
      expect(result.payload).toMatchObject({ outcome: "rejected", errorCode });
      expect(run.invoke).not.toHaveBeenCalled();
    }
  });

  it("turns malformed or action-swapped runtime receipts into a stable failure", async () => {
    const run = runWith(vi.fn(async () => executed("DISENGAGE")));
    const message = invocation("combat.engage");
    const result = await run.executor.execute(
      message,
      authorization(message),
      readyState,
    );

    expect(result.payload).toMatchObject({
      outcome: "failed",
      errorCode: "COMBAT_EXECUTION_RECEIPT_INVALID",
    });
  });

  it("lets an uncleared reflex path become an audited deterministic retreat", async () => {
    const retreated = {
      requested: { action: "ENGAGE" as const, requestedAtMs: REQUESTED_AT_MS },
      actual: {
        disposition: "modified" as const,
        action: "RETREAT" as const,
        executedAtMs: REQUESTED_AT_MS + 5,
        reasonCode: "COMBAT_REFLEX_NOT_CLEARED",
        targetEntityId: 42,
      },
    };
    const run = runWith(vi.fn(async () => retreated));
    const message = invocation("combat.engage");
    const result = await run.executor.execute(
      message,
      authorization(message),
      readyState,
    );

    expect(result.payload).toMatchObject({ outcome: "completed", output: retreated });
  });

  it("rejects raw target fields at schema decode time", async () => {
    const run = runWith();
    const message = invocation("combat.engage", {
      serverProfileId: SERVER,
      targetEntityId: 42,
    });
    const result = await run.executor.execute(
      message,
      authorization(message),
      readyState,
    );
    expect(result.payload).toMatchObject({
      outcome: "rejected",
      errorCode: "SKILL_INPUT_INVALID",
    });
    expect(run.invoke).not.toHaveBeenCalled();
  });
});

describe("combat.disengage@1.0.0", () => {
  it("remains available without target observation or reflex clearance", async () => {
    const dropped = {
      requested: { action: "DISENGAGE" as const, requestedAtMs: REQUESTED_AT_MS },
      actual: {
        disposition: "dropped" as const,
        action: "NONE" as const,
        executedAtMs: null,
        reasonCode: "COMBAT_ALREADY_DISENGAGED",
        targetEntityId: null,
      },
    };
    const invoke = vi.fn(async () => dropped);
    const run = runWith(invoke);
    const message = invocation("combat.disengage");
    const result = await run.executor.execute(
      message,
      authorization(message),
      {
        ...readyState,
        normalActionsAllowed: false,
        combatObservationAvailable: false,
      },
    );

    expect(result.payload).toMatchObject({ outcome: "completed", output: dropped });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "combat.control",
        operation: "combat.disengage",
        input: { serverProfileId: SERVER },
      }),
    );
  });
});

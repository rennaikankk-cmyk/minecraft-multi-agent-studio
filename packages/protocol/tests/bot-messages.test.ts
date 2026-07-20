import { describe, expect, it } from "vitest";

import {
  ProtocolAuthorizationError,
  botDisconnectedV1Schema,
  botHeartbeatV1Schema,
  botStopResultV1Schema,
  botStatusV1Schema,
  botVersionV1Schema,
  parseBotProtocolMessage,
  parseBotTelemetryMessage,
  stopBotCommandV1Schema,
  type ControlPermission,
} from "../src/index.js";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";
const NOW = "2026-07-19T10:00:00.000Z";
const stopPermission = new Set<ControlPermission>(["bot.stop"]);

const envelope = {
  schemaVersion: "1.0" as const,
  messageId: MESSAGE_ID,
  traceId: "trace-001",
  timestamp: NOW,
  source: { service: "bot-runtime" as const, instanceId: "runtime-01" },
  botId: "worker-01",
};

const validStatus = {
  ...envelope,
  type: "bot.status.v1" as const,
  payload: {
    serverProfileId: "isolated-test",
    runtimeInstanceId: "runtime-01",
    sequence: 42,
    observedAt: NOW,
    connectionState: "online" as const,
    health: { current: 18, maximum: 20 },
    food: { level: 17, saturation: 4.5 },
    armorPoints: 12,
    position: { x: 12.5, y: 64, z: -30.25, dimension: "minecraft:overworld" },
    latencyMs: 53,
    currentTask: {
      taskId: "task-001",
      title: "Collect test logs",
      status: "running" as const,
      startedAt: NOW,
    },
  },
};

const validStopCommand = {
  ...envelope,
  source: { service: "api-gateway" as const, instanceId: "gateway-01" },
  type: "bot.stop.command.v1" as const,
  payload: {
    commandId: COMMAND_ID,
    mode: "graceful" as const,
    reason: "Operator requested a safe stop.",
    requestedAt: NOW,
    expiresAt: "2026-07-19T10:01:00.000Z",
    gracePeriodMs: 10_000,
    expectedRuntimeInstanceId: "runtime-01",
    authorization: {
      decisionId: DECISION_ID,
      actorId: "user-01",
      permission: "bot.stop" as const,
      issuedAt: "2026-07-19T09:59:59.000Z",
      expiresAt: "2026-07-19T10:01:00.000Z",
    },
  },
};

describe("BotStatusV1", () => {
  it("accepts a complete finite status snapshot", () => {
    expect(botStatusV1Schema.parse(validStatus)).toEqual(validStatus);
    expect(parseBotTelemetryMessage(validStatus).type).toBe("bot.status.v1");
  });

  it("rejects health above the reported maximum", () => {
    const input = structuredClone(validStatus);
    input.payload.health.current = 21;
    expect(botStatusV1Schema.safeParse(input).success).toBe(false);
  });

  it("rejects non-finite coordinates and extra fields", () => {
    const invalidCoordinate = structuredClone(validStatus);
    invalidCoordinate.payload.position.x = Number.POSITIVE_INFINITY;
    expect(botStatusV1Schema.safeParse(invalidCoordinate).success).toBe(false);

    const extraField = { ...validStatus, modelInstruction: "run this text" };
    expect(botStatusV1Schema.safeParse(extraField).success).toBe(false);
  });

  it("rejects missing envelope fields", () => {
    const { traceId: _traceId, ...withoutTraceId } = validStatus;
    expect(botStatusV1Schema.safeParse(withoutTraceId).success).toBe(false);
  });
});

describe("BotHeartbeatV1 and BotDisconnectedV1", () => {
  it("validates heartbeat sequencing", () => {
    const heartbeat = {
      ...envelope,
      type: "bot.heartbeat.v1" as const,
      payload: {
        serverProfileId: "isolated-test",
        runtimeInstanceId: "runtime-01",
        sequence: 43,
        observedAt: NOW,
        connectionState: "online" as const,
        uptimeMs: 120_000,
        lastStatusSequence: 42,
        currentTaskId: "task-001",
      },
    };

    expect(botHeartbeatV1Schema.parse(heartbeat)).toEqual(heartbeat);
    expect(
      botHeartbeatV1Schema.safeParse({
        ...heartbeat,
        payload: { ...heartbeat.payload, lastStatusSequence: 44 },
      }).success,
    ).toBe(false);
  });

  it("accepts structured disconnects and bounds free text", () => {
    const disconnected = {
      ...envelope,
      type: "bot.disconnected.v1" as const,
      payload: {
        serverProfileId: "isolated-test",
        runtimeInstanceId: "runtime-01",
        sequence: 44,
        observedAt: NOW,
        reason: "network_error" as const,
        expected: false,
        lastStatusSequence: 42,
        detail: "Connection reset by isolated test server.",
      },
    };

    expect(botDisconnectedV1Schema.parse(disconnected)).toEqual(disconnected);
    expect(
      botDisconnectedV1Schema.safeParse({
        ...disconnected,
        payload: { ...disconnected.payload, detail: "x".repeat(501) },
      }).success,
    ).toBe(false);
  });
});

describe("BotStopResultV1", () => {
  const result = {
    ...envelope,
    type: "bot.stop.result.v1" as const,
    payload: {
      commandId: COMMAND_ID,
      runtimeInstanceId: "runtime-01",
      outcome: "completed" as const,
      completedAt: NOW,
    },
  };

  it("accepts a confirmed runtime result", () => {
    expect(botStopResultV1Schema.parse(result)).toEqual(result);
  });

  it("requires stable errors only for unsuccessful results", () => {
    expect(
      botStopResultV1Schema.safeParse({
        ...result,
        payload: { ...result.payload, outcome: "failed" },
      }).success,
    ).toBe(false);
    expect(
      botStopResultV1Schema.safeParse({
        ...result,
        payload: { ...result.payload, errorCode: "UNEXPECTED_ERROR" },
      }).success,
    ).toBe(false);
    expect(
      botStopResultV1Schema.safeParse({
        ...result,
        source: { service: "bot-runtime", instanceId: "runtime-other" },
      }).success,
    ).toBe(false);
  });
});

describe("BotVersionV1", () => {
  it("reports version compatibility without server connection details", () => {
    const tested = {
      ...envelope,
      type: "bot.version.v1" as const,
      payload: {
        serverProfileId: "isolated-test",
        runtimeInstanceId: "runtime-01",
        sequence: 45,
        observedAt: NOW,
        compatibility: {
          selection: "auto" as const,
          requestedVersion: null,
          resolvedVersion: "1.21.8",
          supportLevel: "tested" as const,
          supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
        },
      },
    };
    expect(botVersionV1Schema.parse(tested)).toEqual(tested);
    expect(
      botVersionV1Schema.safeParse({
        ...tested,
        payload: {
          ...tested.payload,
          compatibility: {
            ...tested.payload.compatibility,
            supportLevel: "unsupported",
          },
        },
      }).success,
    ).toBe(false);
  });
});

describe("StopBotCommandV1 authorization", () => {
  it("requires permission appropriate to the stop mode", () => {
    const emergencyWithNormalPermission = {
      ...validStopCommand,
      payload: { ...validStopCommand.payload, mode: "emergency" },
    };
    expect(stopBotCommandV1Schema.safeParse(emergencyWithNormalPermission).success).toBe(
      false,
    );
  });

  it("refuses a structurally valid command without trusted context", () => {
    expect(() => parseBotProtocolMessage(validStopCommand)).toThrowError(
      ProtocolAuthorizationError,
    );

    try {
      parseBotProtocolMessage(validStopCommand);
    } catch (error) {
      expect(error).toMatchObject({ code: "AUTH_CONTEXT_REQUIRED" });
    }
  });

  it("refuses actor mismatch and expired authorization", () => {
    expect(() =>
      parseBotProtocolMessage(validStopCommand, {
        decisionId: DECISION_ID,
        actorId: "different-user",
        botId: "worker-01",
        commandId: COMMAND_ID,
        permissions: stopPermission,
        now: new Date("2026-07-19T10:00:30.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "AUTH_ACTOR_MISMATCH" }));

    expect(() =>
      parseBotProtocolMessage(validStopCommand, {
        decisionId: DECISION_ID,
        actorId: "user-01",
        botId: "worker-01",
        commandId: COMMAND_ID,
        permissions: stopPermission,
        now: new Date("2026-07-19T10:02:00.000Z"),
      }),
    ).toThrowError(expect.objectContaining({ code: "AUTH_EXPIRED" }));
  });

  it("binds authorization to one bot, command, and granted permission", () => {
    const baseContext = {
      decisionId: DECISION_ID,
      actorId: "user-01",
      botId: "worker-01",
      commandId: COMMAND_ID,
      permissions: stopPermission,
      now: new Date("2026-07-19T10:00:30.000Z"),
    };

    expect(() =>
      parseBotProtocolMessage(validStopCommand, {
        ...baseContext,
        botId: "different-bot",
      }),
    ).toThrowError(expect.objectContaining({ code: "AUTH_RESOURCE_MISMATCH" }));

    expect(() =>
      parseBotProtocolMessage(validStopCommand, {
        ...baseContext,
        commandId: "44444444-4444-4444-8444-444444444444",
      }),
    ).toThrowError(expect.objectContaining({ code: "AUTH_COMMAND_MISMATCH" }));

    expect(() =>
      parseBotProtocolMessage(validStopCommand, {
        ...baseContext,
        permissions: new Set(),
      }),
    ).toThrowError(expect.objectContaining({ code: "AUTH_PERMISSION_DENIED" }));
  });

  it("accepts a command only with matching trusted authorization", () => {
    const parsed = parseBotProtocolMessage(validStopCommand, {
      decisionId: DECISION_ID,
      actorId: "user-01",
      botId: "worker-01",
      commandId: COMMAND_ID,
      permissions: stopPermission,
      now: new Date("2026-07-19T10:00:30.000Z"),
    });

    expect(parsed.type).toBe("bot.stop.command.v1");
  });
});

describe("protocol version boundary", () => {
  it("rejects unknown versions and message types", () => {
    expect(() =>
      parseBotProtocolMessage({ ...validStatus, schemaVersion: "2.0" }),
    ).toThrow();
    expect(() =>
      parseBotProtocolMessage({ ...validStatus, type: "bot.raw-tick.v1" }),
    ).toThrow();
  });
});

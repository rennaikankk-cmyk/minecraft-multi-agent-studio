import { z } from "zod";

export const identifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

const timestampSchema = z.string().datetime({ offset: true });
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const botMessageSourceSchema = z
  .object({
    service: z.enum(["bot-runtime", "coordinator", "api-gateway"]),
    instanceId: identifierSchema,
  })
  .strict();

export const botConnectionStateSchema = z.enum([
  "connecting",
  "online",
  "stale",
  "offline",
  "stopping",
  "error",
]);

export const minecraftVersionStringSchema = z
  .string()
  .regex(/^1\.\d+(?:\.\d+)?$/u);

export const minecraftVersionCompatibilitySchema = z
  .object({
    selection: z.enum(["auto", "fixed"]),
    requestedVersion: minecraftVersionStringSchema.nullable(),
    resolvedVersion: minecraftVersionStringSchema.nullable(),
    supportLevel: z.enum(["tested", "compatible-untested", "unsupported"]),
    supportedRange: z
      .object({
        oldest: minecraftVersionStringSchema,
        latest: minecraftVersionStringSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.selection === "auto" && value.requestedVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["requestedVersion"],
        message: "Auto version selection cannot contain a requested version.",
      });
    }
    if (value.selection === "fixed" && value.requestedVersion === null) {
      context.addIssue({
        code: "custom",
        path: ["requestedVersion"],
        message: "Fixed version selection requires a requested version.",
      });
    }
    if (value.supportLevel === "unsupported" && value.resolvedVersion !== null) {
      context.addIssue({
        code: "custom",
        path: ["resolvedVersion"],
        message: "An unsupported result cannot claim a resolved version.",
      });
    }
    if (value.supportLevel !== "unsupported" && value.resolvedVersion === null) {
      context.addIssue({
        code: "custom",
        path: ["resolvedVersion"],
        message: "A supported result requires a resolved version.",
      });
    }
  });

export const taskStatusSchema = z.enum([
  "queued",
  "assigned",
  "running",
  "blocked",
  "waiting",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "expired",
]);

export const botPositionSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    z: z.number().finite(),
    dimension: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
  })
  .strict();

const healthSchema = z
  .object({
    current: z.number().finite().nonnegative(),
    maximum: z.number().finite().positive().nullable(),
  })
  .strict()
  .superRefine((health, context) => {
    if (health.maximum !== null && health.current > health.maximum) {
      context.addIssue({
        code: "custom",
        path: ["current"],
        message: "Current health cannot exceed maximum health.",
      });
    }
  });

const currentTaskSchema = z
  .object({
    taskId: identifierSchema,
    title: z.string().trim().min(1).max(200),
    status: taskStatusSchema,
    startedAt: timestampSchema.nullable(),
  })
  .strict();

const botMessageEnvelopeShape = {
  schemaVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  traceId: identifierSchema,
  timestamp: timestampSchema,
  source: botMessageSourceSchema,
  botId: identifierSchema,
};

export const botStatusV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.status.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        connectionState: botConnectionStateSchema,
        health: healthSchema,
        food: z
          .object({
            level: z.number().int().min(0).max(20),
            saturation: z.number().finite().min(0).max(20),
          })
          .strict(),
        armorPoints: z.number().int().min(0).max(20).nullable(),
        position: botPositionSchema,
        latencyMs: z.number().int().nonnegative().max(120_000).nullable(),
        currentTask: currentTaskSchema.nullable(),
        minecraftVersion: minecraftVersionCompatibilitySchema
          .refine((value) => value.supportLevel !== "unsupported")
          .optional(),
      })
      .strict(),
  })
  .strict();

export const botHeartbeatV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.heartbeat.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        connectionState: botConnectionStateSchema,
        uptimeMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
        lastStatusSequence: sequenceSchema.nullable(),
        currentTaskId: identifierSchema.nullable(),
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const lastStatusSequence = message.payload.lastStatusSequence;
    if (
      lastStatusSequence !== null &&
      lastStatusSequence > message.payload.sequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "lastStatusSequence"],
        message: "The last status sequence cannot exceed the message sequence.",
      });
    }
  });

export const botDisconnectedV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.disconnected.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        reason: z.enum([
          "requested_stop",
          "server_shutdown",
          "kicked",
          "network_error",
          "authentication_error",
          "runtime_error",
          "unknown",
        ]),
        expected: z.boolean(),
        lastStatusSequence: sequenceSchema.nullable(),
        detail: z.string().trim().min(1).max(500).optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const lastStatusSequence = message.payload.lastStatusSequence;
    if (
      lastStatusSequence !== null &&
      lastStatusSequence > message.payload.sequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "lastStatusSequence"],
        message: "The last status sequence cannot exceed the message sequence.",
      });
    }
  });

export const botVersionV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.version.v1"),
    payload: z
      .object({
        serverProfileId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        sequence: sequenceSchema,
        observedAt: timestampSchema,
        compatibility: minecraftVersionCompatibilitySchema,
      })
      .strict(),
  })
  .strict();

export const controlPermissionSchema = z.enum([
  "bot.stop",
  "bot.emergency-stop",
]);

const controlAuthorizationSchema = z
  .object({
    decisionId: z.string().uuid(),
    actorId: identifierSchema,
    permission: controlPermissionSchema,
    issuedAt: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

export const stopBotCommandV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.stop.command.v1"),
    source: z
      .object({
        service: z.enum(["coordinator", "api-gateway"]),
        instanceId: identifierSchema,
      })
      .strict(),
    payload: z
      .object({
        commandId: z.string().uuid(),
        mode: z.enum(["graceful", "emergency"]),
        reason: z.string().trim().min(1).max(300),
        requestedAt: timestampSchema,
        expiresAt: timestampSchema,
        gracePeriodMs: z.number().int().min(0).max(60_000),
        expectedRuntimeInstanceId: identifierSchema.nullable(),
        authorization: controlAuthorizationSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const requestedAt = Date.parse(message.payload.requestedAt);
    const expiresAt = Date.parse(message.payload.expiresAt);
    const authorizationIssuedAt = Date.parse(message.payload.authorization.issuedAt);
    const authorizationExpiresAt = Date.parse(message.payload.authorization.expiresAt);

    if (expiresAt <= requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Command expiry must be after requestedAt.",
      });
    }
    if (authorizationIssuedAt > requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "issuedAt"],
        message: "Authorization cannot be issued after the command request.",
      });
    }
    if (authorizationExpiresAt < expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "expiresAt"],
        message: "Authorization must remain valid for the command lifetime.",
      });
    }

    const expectedPermission =
      message.payload.mode === "emergency" ? "bot.emergency-stop" : "bot.stop";
    if (message.payload.authorization.permission !== expectedPermission) {
      context.addIssue({
        code: "custom",
        path: ["payload", "authorization", "permission"],
        message: `Stop mode requires ${expectedPermission} permission.`,
      });
    }
  });

export const botStopResultV1Schema = z
  .object({
    ...botMessageEnvelopeShape,
    type: z.literal("bot.stop.result.v1"),
    source: z
      .object({
        service: z.literal("bot-runtime"),
        instanceId: identifierSchema,
      })
      .strict(),
    payload: z
      .object({
        commandId: z.string().uuid(),
        runtimeInstanceId: identifierSchema,
        outcome: z.enum(["completed", "rejected", "failed"]),
        completedAt: timestampSchema,
        errorCode: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Z][A-Z0-9_]*$/u)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.source.instanceId !== message.payload.runtimeInstanceId) {
      context.addIssue({
        code: "custom",
        path: ["source", "instanceId"],
        message: "Stop result source must match the runtime instance.",
      });
    }
    const hasError = message.payload.errorCode !== undefined;
    if (message.payload.outcome === "completed" && hasError) {
      context.addIssue({
        code: "custom",
        path: ["payload", "errorCode"],
        message: "A completed stop result cannot contain an error code.",
      });
    }
    if (message.payload.outcome !== "completed" && !hasError) {
      context.addIssue({
        code: "custom",
        path: ["payload", "errorCode"],
        message: "A rejected or failed stop result requires an error code.",
      });
    }
  });

export const botTelemetryMessageV1Schema = z.discriminatedUnion("type", [
  botStatusV1Schema,
  botHeartbeatV1Schema,
  botDisconnectedV1Schema,
  botVersionV1Schema,
]);

export const botProtocolMessageV1Schema = z.union([
  botStatusV1Schema,
  botHeartbeatV1Schema,
  botDisconnectedV1Schema,
  botVersionV1Schema,
  stopBotCommandV1Schema,
  botStopResultV1Schema,
]);

export type ControlPermission = z.infer<typeof controlPermissionSchema>;
export type BotStatusV1 = z.infer<typeof botStatusV1Schema>;
export type BotHeartbeatV1 = z.infer<typeof botHeartbeatV1Schema>;
export type BotDisconnectedV1 = z.infer<typeof botDisconnectedV1Schema>;
export type BotVersionV1 = z.infer<typeof botVersionV1Schema>;
export type MinecraftVersionCompatibility = z.infer<
  typeof minecraftVersionCompatibilitySchema
>;
export type StopBotCommandV1 = z.infer<typeof stopBotCommandV1Schema>;
export type BotStopResultV1 = z.infer<typeof botStopResultV1Schema>;
export type BotTelemetryMessageV1 = z.infer<typeof botTelemetryMessageV1Schema>;
export type BotProtocolMessageV1 = z.infer<typeof botProtocolMessageV1Schema>;

export type ControlAuthorizationContext = {
  decisionId: string;
  actorId: string;
  botId: string;
  commandId: string;
  permissions: ReadonlySet<ControlPermission>;
  now?: Date;
};

export type ProtocolAuthorizationErrorCode =
  | "AUTH_CONTEXT_REQUIRED"
  | "AUTH_DECISION_MISMATCH"
  | "AUTH_ACTOR_MISMATCH"
  | "AUTH_RESOURCE_MISMATCH"
  | "AUTH_COMMAND_MISMATCH"
  | "AUTH_PERMISSION_DENIED"
  | "AUTH_CONTEXT_INVALID"
  | "AUTH_EXPIRED";

export class ProtocolAuthorizationError extends Error {
  readonly code: ProtocolAuthorizationErrorCode;

  constructor(code: ProtocolAuthorizationErrorCode, message: string) {
    super(message);
    this.name = "ProtocolAuthorizationError";
    this.code = code;
  }
}

export function parseBotTelemetryMessage(input: unknown): BotTelemetryMessageV1 {
  return botTelemetryMessageV1Schema.parse(input);
}

export function parseBotStopResult(input: unknown): BotStopResultV1 {
  return botStopResultV1Schema.parse(input);
}

/**
 * Parses telemetry directly, but requires a separately trusted authorization
 * context for control messages. Parsing stopBotCommandV1Schema alone is never
 * sufficient authorization to execute a stop.
 */
export function parseBotProtocolMessage(
  input: unknown,
  authorizationContext?: ControlAuthorizationContext,
): BotProtocolMessageV1 {
  const message = botProtocolMessageV1Schema.parse(input);
  if (message.type !== "bot.stop.command.v1") {
    return message;
  }

  if (!authorizationContext) {
    throw new ProtocolAuthorizationError(
      "AUTH_CONTEXT_REQUIRED",
      "A trusted authorization context is required for control messages.",
    );
  }

  const authorization = message.payload.authorization;
  if (authorization.decisionId !== authorizationContext.decisionId) {
    throw new ProtocolAuthorizationError(
      "AUTH_DECISION_MISMATCH",
      "The authorization decision does not match the trusted context.",
    );
  }
  if (authorization.actorId !== authorizationContext.actorId) {
    throw new ProtocolAuthorizationError(
      "AUTH_ACTOR_MISMATCH",
      "The authorization actor does not match the trusted context.",
    );
  }
  if (message.botId !== authorizationContext.botId) {
    throw new ProtocolAuthorizationError(
      "AUTH_RESOURCE_MISMATCH",
      "The target bot does not match the trusted authorization context.",
    );
  }
  if (message.payload.commandId !== authorizationContext.commandId) {
    throw new ProtocolAuthorizationError(
      "AUTH_COMMAND_MISMATCH",
      "The command ID does not match the trusted authorization context.",
    );
  }
  if (!authorizationContext.permissions.has(authorization.permission)) {
    throw new ProtocolAuthorizationError(
      "AUTH_PERMISSION_DENIED",
      "The trusted context does not grant the required permission.",
    );
  }

  const now = (authorizationContext.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) {
    throw new ProtocolAuthorizationError(
      "AUTH_CONTEXT_INVALID",
      "The trusted authorization context contains an invalid current time.",
    );
  }
  if (
    now > Date.parse(authorization.expiresAt) ||
    now > Date.parse(message.payload.expiresAt)
  ) {
    throw new ProtocolAuthorizationError(
      "AUTH_EXPIRED",
      "The control authorization or command has expired.",
    );
  }

  return message;
}

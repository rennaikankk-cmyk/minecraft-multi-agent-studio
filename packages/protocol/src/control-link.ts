import { z } from "zod";

import { botStopResultV1Schema, identifierSchema } from "./bot-messages.js";
import { publicBotDetailV1Schema } from "./control-api.js";
import { skillExecutionResultV1Schema } from "./skill-messages.js";
import {
  teamObjectiveInputV1Schema,
  teamTaskAssignmentInputV1Schema,
  teamTaskAssignmentV1Schema,
} from "./team.js";

export const CONTROL_LINK_PATH = "/v1/control-link";
export const CONTROL_LINK_SUBPROTOCOL = "minecraft-studio.control-link.v1";
export const CONTROL_LINK_MAX_PAYLOAD_BYTES = 65_536;
export const CONTROL_LINK_MAX_BOTS = 1_000;

const timestampSchema = z.string().datetime({ offset: true });
const nonceOrProofSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const sequenceSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const controlLinkEnvelopeShape = {
  schemaVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  timestamp: timestampSchema,
};

export const controlLinkCapabilitySchema = z.enum([
  "bot.read",
  "bot.stop",
  "task.execute",
]);

export const controlLinkBotStateV1Schema = publicBotDetailV1Schema.superRefine(
  (bot, context) => {
    if (bot.positionRedacted) {
      context.addIssue({
        code: "custom",
        path: ["positionRedacted"],
        message: "Control Link state must contain the unredacted service view.",
      });
    }
  },
);

export const controlLinkChallengeV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.challenge.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        challengeNonce: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const controlLinkAuthenticateV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.authenticate.v1"),
    payload: z
      .object({
        challengeMessageId: z.string().uuid(),
        coordinatorInstanceId: identifierSchema,
        challengeNonce: nonceOrProofSchema,
        clientNonce: nonceOrProofSchema,
        clientId: identifierSchema,
        controlApiInstanceId: identifierSchema,
        keyId: identifierSchema,
        clientProof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const controlLinkAcceptedV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.accepted.v1"),
    payload: z
      .object({
        challengeMessageId: z.string().uuid(),
        authenticateMessageId: z.string().uuid(),
        coordinatorInstanceId: identifierSchema,
        clientId: identifierSchema,
        controlApiInstanceId: identifierSchema,
        keyId: identifierSchema,
        serverProof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const controlLinkSnapshotBeginV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.snapshot-begin.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        snapshotId: z.string().uuid(),
        baseSequence: sequenceSchema,
        botCount: z.number().int().min(0).max(CONTROL_LINK_MAX_BOTS),
      })
      .strict(),
  })
  .strict();

export const controlLinkSnapshotItemV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.snapshot-item.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        snapshotId: z.string().uuid(),
        baseSequence: sequenceSchema,
        index: z.number().int().min(0).max(CONTROL_LINK_MAX_BOTS - 1),
        bot: controlLinkBotStateV1Schema,
      })
      .strict(),
  })
  .strict();

export const controlLinkSnapshotEndV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.snapshot-end.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        snapshotId: z.string().uuid(),
        baseSequence: sequenceSchema,
        botCount: z.number().int().min(0).max(CONTROL_LINK_MAX_BOTS),
      })
      .strict(),
  })
  .strict();

export const controlLinkStateUpsertV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.state-upsert.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        streamSequence: sequenceSchema,
        bot: controlLinkBotStateV1Schema,
      })
      .strict(),
  })
  .strict();

export const controlLinkStopRequestV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.stop-request.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        clientId: identifierSchema,
        controlApiInstanceId: identifierSchema,
        operationId: z.string().uuid(),
        botId: identifierSchema,
        actorId: identifierSchema,
        issuedAt: timestampSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const issuedAt = Date.parse(message.payload.issuedAt);
    const expiresAt = Date.parse(message.payload.expiresAt);
    if (expiresAt <= issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Control Link authorization expiry must follow issuance.",
      });
    }
    if (expiresAt - issuedAt > 60_000) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Control Link authorization lifetime cannot exceed 60 seconds.",
      });
    }
  });

export const controlLinkStopErrorCodeSchema = z.enum([
  "REQUEST_INVALID",
  "COMMAND_ID_CONFLICT",
  "BOT_NOT_FOUND",
  "BOT_NOT_STOPPABLE",
  "AUTHORIZATION_REJECTED",
  "AUDIT_WRITE_FAILED",
  "STOP_TIMEOUT",
  "STOP_TRANSPORT_FAILED",
  "STOP_CONFIRMATION_INVALID",
  "CONTROL_LINK_BACKPRESSURE",
  "CONTROL_LINK_STOPPED",
  "CONTROL_LINK_INTERNAL_ERROR",
]);

const stopResponseIdentityShape = {
  coordinatorInstanceId: identifierSchema,
  requestMessageId: z.string().uuid(),
  operationId: z.string().uuid(),
  botId: identifierSchema,
};

export const controlLinkStopResponseV1Schema = z.discriminatedUnion("ok", [
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.stop-response.v1"),
      ok: z.literal(true),
      payload: z
        .object({
          ...stopResponseIdentityShape,
          result: botStopResultV1Schema,
        })
        .strict(),
    })
    .strict()
    .superRefine((message, context) => {
      const result = message.payload.result;
      if (
        result.botId !== message.payload.botId ||
        result.traceId !== message.payload.operationId ||
        result.payload.commandId !== message.payload.operationId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "result"],
          message: "Control Link stop result identity does not match the operation.",
        });
      }
    }),
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.stop-response.v1"),
      ok: z.literal(false),
      payload: z
        .object({
          ...stopResponseIdentityShape,
          errorCode: controlLinkStopErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const controlLinkTaskRequestV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.task-request.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        clientId: identifierSchema,
        controlApiInstanceId: identifierSchema,
        operationId: z.string().uuid(),
        botId: identifierSchema,
        taskId: identifierSchema,
        task: z.string().trim().min(1).max(10_000),
        taskVersion: sequenceSchema,
        priority: z.number().int().min(0).max(100),
        actorId: identifierSchema,
        issuedAt: timestampSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const issuedAt = Date.parse(message.payload.issuedAt);
    const expiresAt = Date.parse(message.payload.expiresAt);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 2 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Task authorization must remain within a two minute window.",
      });
    }
  });

export const controlLinkTaskErrorCodeSchema = z.enum([
  "REQUEST_INVALID",
  "AUTHORIZATION_REJECTED",
  "AI_UNAVAILABLE",
  "BOT_NOT_EXECUTABLE",
  "PROPOSAL_STALE",
  "SKILL_NOT_AVAILABLE",
  "TASK_VERSION_STALE",
  "BOT_SKILL_BUSY",
  "POLICY_DENIED",
  "TASK_TIMEOUT",
  "TASK_EXECUTION_FAILED",
  "CONTROL_LINK_BACKPRESSURE",
  "CONTROL_LINK_STOPPED",
  "CONTROL_LINK_INTERNAL_ERROR",
]);

const taskResponseIdentityShape = {
  coordinatorInstanceId: identifierSchema,
  requestMessageId: z.string().uuid(),
  operationId: z.string().uuid(),
  botId: identifierSchema,
  taskId: identifierSchema,
};

export const controlLinkTaskResponseV1Schema = z.discriminatedUnion("ok", [
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.task-response.v1"),
      ok: z.literal(true),
      payload: z
        .object({
          ...taskResponseIdentityShape,
          plannerRequestId: z.string().uuid(),
          execution: z.discriminatedUnion("action", [
            z
              .object({
                action: z.literal("wait"),
                provider: identifierSchema,
                model: z.string().trim().min(1).max(512),
                reason: z.string().trim().min(1).max(2_000),
                confidence: z.number().finite().min(0).max(1),
              })
              .strict(),
            z
              .object({
                action: z.literal("skill_result"),
                result: skillExecutionResultV1Schema,
              })
              .strict(),
          ]),
        })
        .strict(),
    })
    .strict()
    .superRefine((message, context) => {
      const execution = message.payload.execution;
      if (
        execution.action === "skill_result" &&
        (execution.result.botId !== message.payload.botId ||
          execution.result.taskId !== message.payload.taskId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "execution", "result"],
          message: "Task execution result identity does not match its request.",
        });
      }
    }),
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.task-response.v1"),
      ok: z.literal(false),
      payload: z
        .object({
          ...taskResponseIdentityShape,
          errorCode: controlLinkTaskErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const controlLinkTeamTaskRequestV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.team-task-request.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        clientId: identifierSchema,
        controlApiInstanceId: identifierSchema,
        operationId: z.string().uuid(),
        objective: teamObjectiveInputV1Schema,
        assignment: teamTaskAssignmentInputV1Schema,
        task: z.string().trim().min(1).max(10_000),
        taskVersion: sequenceSchema,
        priority: z.number().int().min(0).max(100),
        actorId: identifierSchema,
        issuedAt: timestampSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const { assignment, objective } = message.payload;
    if (assignment.objectiveId !== objective.objectiveId) {
      context.addIssue({
        code: "custom",
        path: ["payload", "assignment", "objectiveId"],
        message: "Team task objective identity does not match.",
      });
    }
    const issuedAt = Date.parse(message.payload.issuedAt);
    const expiresAt = Date.parse(message.payload.expiresAt);
    if (expiresAt <= issuedAt || expiresAt - issuedAt > 2 * 60_000) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Team task authorization must remain within a two minute window.",
      });
    }
  });

export const controlLinkTeamTaskErrorCodeSchema = z.enum([
  "REQUEST_INVALID",
  "AUTHORIZATION_REJECTED",
  "AI_UNAVAILABLE",
  "TEAM_INPUT_INVALID",
  "TEAM_OBJECTIVE_NOT_FOUND",
  "TEAM_OBJECTIVE_INACTIVE",
  "TEAM_OBJECTIVE_CAPACITY",
  "TEAM_TASK_CONFLICT",
  "TEAM_RESOURCE_CONFLICT",
  "TEAM_BOT_NOT_FOUND",
  "TEAM_BOT_SERVER_MISMATCH",
  "TEAM_NO_ELIGIBLE_BOT",
  "BOT_NOT_EXECUTABLE",
  "PROPOSAL_STALE",
  "SKILL_NOT_AVAILABLE",
  "TASK_VERSION_STALE",
  "BOT_SKILL_BUSY",
  "POLICY_DENIED",
  "TASK_TIMEOUT",
  "TASK_EXECUTION_FAILED",
  "CONTROL_LINK_BACKPRESSURE",
  "CONTROL_LINK_STOPPED",
  "CONTROL_LINK_INTERNAL_ERROR",
]);

const teamTaskResponseIdentityShape = {
  coordinatorInstanceId: identifierSchema,
  requestMessageId: z.string().uuid(),
  operationId: z.string().uuid(),
  objectiveId: identifierSchema,
  taskId: identifierSchema,
};

export const controlLinkTeamTaskResponseV1Schema = z.discriminatedUnion("ok", [
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.team-task-response.v1"),
      ok: z.literal(true),
      payload: z
        .object({
          ...teamTaskResponseIdentityShape,
          plannerRequestId: z.string().uuid(),
          assignment: teamTaskAssignmentV1Schema,
          execution: z.discriminatedUnion("action", [
            z
              .object({
                action: z.literal("wait"),
                provider: identifierSchema,
                model: z.string().trim().min(1).max(512),
                reason: z.string().trim().min(1).max(2_000),
                confidence: z.number().finite().min(0).max(1),
              })
              .strict(),
            z
              .object({
                action: z.literal("skill_result"),
                result: skillExecutionResultV1Schema,
              })
              .strict(),
          ]),
        })
        .strict(),
    })
    .strict()
    .superRefine((message, context) => {
      const { assignment, execution } = message.payload;
      if (
        assignment.objectiveId !== message.payload.objectiveId ||
        assignment.taskId !== message.payload.taskId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "assignment"],
          message: "Team assignment identity does not match its request.",
        });
      }
      if (
        execution.action === "skill_result" &&
        (execution.result.botId !== assignment.botId ||
          execution.result.taskId !== message.payload.taskId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "execution", "result"],
          message: "Team task execution result identity does not match its request.",
        });
      }
    }),
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.team-task-response.v1"),
      ok: z.literal(false),
      payload: z
        .object({
          ...teamTaskResponseIdentityShape,
          errorCode: controlLinkTeamTaskErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const controlLinkClientMessageV1Schema = z.union([
  controlLinkAuthenticateV1Schema,
  controlLinkStopRequestV1Schema,
  controlLinkTaskRequestV1Schema,
  controlLinkTeamTaskRequestV1Schema,
]);

export const controlLinkServerMessageV1Schema = z.union([
  controlLinkChallengeV1Schema,
  controlLinkAcceptedV1Schema,
  controlLinkSnapshotBeginV1Schema,
  controlLinkSnapshotItemV1Schema,
  controlLinkSnapshotEndV1Schema,
  controlLinkStateUpsertV1Schema,
  controlLinkStopResponseV1Schema,
  controlLinkTaskResponseV1Schema,
  controlLinkTeamTaskResponseV1Schema,
]);

export type ControlLinkCapability = z.infer<typeof controlLinkCapabilitySchema>;
export type ControlLinkBotStateV1 = z.infer<typeof controlLinkBotStateV1Schema>;
export type ControlLinkChallengeV1 = z.infer<typeof controlLinkChallengeV1Schema>;
export type ControlLinkAuthenticateV1 = z.infer<
  typeof controlLinkAuthenticateV1Schema
>;
export type ControlLinkAcceptedV1 = z.infer<typeof controlLinkAcceptedV1Schema>;
export type ControlLinkSnapshotBeginV1 = z.infer<
  typeof controlLinkSnapshotBeginV1Schema
>;
export type ControlLinkSnapshotItemV1 = z.infer<
  typeof controlLinkSnapshotItemV1Schema
>;
export type ControlLinkSnapshotEndV1 = z.infer<
  typeof controlLinkSnapshotEndV1Schema
>;
export type ControlLinkStateUpsertV1 = z.infer<
  typeof controlLinkStateUpsertV1Schema
>;
export type ControlLinkStopRequestV1 = z.infer<
  typeof controlLinkStopRequestV1Schema
>;
export type ControlLinkStopErrorCode = z.infer<
  typeof controlLinkStopErrorCodeSchema
>;
export type ControlLinkStopResponseV1 = z.infer<
  typeof controlLinkStopResponseV1Schema
>;
export type ControlLinkTaskRequestV1 = z.infer<
  typeof controlLinkTaskRequestV1Schema
>;
export type ControlLinkTaskErrorCode = z.infer<
  typeof controlLinkTaskErrorCodeSchema
>;
export type ControlLinkTaskResponseV1 = z.infer<
  typeof controlLinkTaskResponseV1Schema
>;
export type ControlLinkTeamTaskRequestV1 = z.infer<
  typeof controlLinkTeamTaskRequestV1Schema
>;
export type ControlLinkTeamTaskErrorCode = z.infer<
  typeof controlLinkTeamTaskErrorCodeSchema
>;
export type ControlLinkTeamTaskResponseV1 = z.infer<
  typeof controlLinkTeamTaskResponseV1Schema
>;
export type ControlLinkClientMessageV1 = z.infer<
  typeof controlLinkClientMessageV1Schema
>;
export type ControlLinkServerMessageV1 = z.infer<
  typeof controlLinkServerMessageV1Schema
>;

export type ControlLinkProofContext = Readonly<{
  challengeMessageId: string;
  coordinatorInstanceId: string;
  challengeNonce: string;
  clientNonce: string;
  clientId: string;
  controlApiInstanceId: string;
  keyId: string;
}>;

export type ControlLinkServerProofContext = ControlLinkProofContext &
  Readonly<{ authenticateMessageId: string }>;

export function controlLinkClientProofInput(
  context: ControlLinkProofContext,
): string {
  return proofInput("client", context);
}

export function controlLinkServerProofInput(
  context: ControlLinkServerProofContext,
): string {
  return `${proofInput("server", context)}\n${context.authenticateMessageId}`;
}

export function parseControlLinkClientMessage(
  input: unknown,
): ControlLinkClientMessageV1 {
  return controlLinkClientMessageV1Schema.parse(input);
}

export function parseControlLinkServerMessage(
  input: unknown,
): ControlLinkServerMessageV1 {
  return controlLinkServerMessageV1Schema.parse(input);
}

function proofInput(
  side: "client" | "server",
  context: ControlLinkProofContext,
): string {
  return [
    `minecraft-studio-control-link/${side}/v1`,
    context.challengeMessageId,
    context.coordinatorInstanceId,
    context.challengeNonce,
    context.clientNonce,
    context.clientId,
    context.controlApiInstanceId,
    context.keyId,
  ].join("\n");
}

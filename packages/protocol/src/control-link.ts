import { z } from "zod";

import { botStopResultV1Schema, identifierSchema } from "./bot-messages.js";
import {
  goalDispatchResultV1Schema,
  publicBotDetailV1Schema,
} from "./control-api.js";
import {
  publicTaskDetailV1Schema,
  taskHistoryListPageV1Schema,
  taskHistoryListQueryV1Schema,
} from "./task-history.js";

export const CONTROL_LINK_PATH = "/v1/control-link";
export const CONTROL_LINK_SUBPROTOCOL = "minecraft-studio.control-link.v1";
export const CONTROL_LINK_MAX_PAYLOAD_BYTES = 65_536;
export const CONTROL_LINK_MAX_BOTS = 1_000;

const timestampSchema = z.string().max(35).datetime({ offset: true });
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
  "goal.submit",
  "task.read",
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

export const controlLinkGoalRequestV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.goal-request.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        clientId: identifierSchema,
        controlApiInstanceId: identifierSchema,
        operationId: z.string().uuid(),
        taskId: identifierSchema,
        botId: identifierSchema,
        actorId: identifierSchema,
        operatorGoal: z
          .string()
          .trim()
          .min(1)
          .max(4_096)
          .refine(
            (value) =>
              !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(value),
          ),
        timeoutMs: z.number().int().min(1_000).max(120_000),
        issuedAt: timestampSchema,
        expiresAt: timestampSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    const issuedAt = Date.parse(message.payload.issuedAt);
    const expiresAt = Date.parse(message.payload.expiresAt);
    if (
      expiresAt <= issuedAt ||
      expiresAt - issuedAt > 180_000 ||
      expiresAt - issuedAt < message.payload.timeoutMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload", "expiresAt"],
        message: "Goal authorization must cover the request timeout and expire within three minutes.",
      });
    }
  });

export const controlLinkGoalErrorCodeSchema = z.enum([
  "REQUEST_INVALID",
  "GOAL_ID_CONFLICT",
  "AUTHORIZATION_REJECTED",
  "BOT_UNAVAILABLE",
  "AI_UNAVAILABLE",
  "AI_QUEUE_FULL",
  "AI_TIMEOUT",
  "AI_REQUEST_FAILED",
  "PLANNER_REJECTED",
  "SKILL_DISPATCH_FAILED",
  "CONTROL_LINK_BACKPRESSURE",
  "CONTROL_LINK_STOPPED",
  "CONTROL_LINK_INTERNAL_ERROR",
  // Round 6.6 生命周期：等待窗到期是诚实终态，不是注册期永久拒绝。
  "GOAL_EXPIRED_WAITING_FOR_BOT",
  // 2026-09-03 原子性审计：磁盘降级时不能假装受理（假 202）——拒绝。
  "CONTROL_LINK_STORAGE_DEGRADED",
]);

const goalResponseIdentityShape = {
  coordinatorInstanceId: identifierSchema,
  requestMessageId: z.string().uuid(),
  operationId: z.string().uuid(),
  taskId: identifierSchema,
  botId: identifierSchema,
};

export const controlLinkGoalResponseV1Schema = z.discriminatedUnion("ok", [
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.goal-response.v1"),
      ok: z.literal(true),
      payload: z
        .object({
          ...goalResponseIdentityShape,
          result: goalDispatchResultV1Schema,
        })
        .strict(),
    })
    .strict()
    .superRefine((message, context) => {
      if (
        message.payload.result.botId !== message.payload.botId ||
        message.payload.result.taskId !== message.payload.taskId
      ) {
        context.addIssue({
          code: "custom",
          path: ["payload", "result"],
          message: "Goal result identity does not match the operation.",
        });
      }
    }),
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.goal-response.v1"),
      ok: z.literal(false),
      payload: z
        .object({
          ...goalResponseIdentityShape,
          errorCode: controlLinkGoalErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

const taskReadRequestIdentityShape = {
  coordinatorInstanceId: identifierSchema,
  clientId: identifierSchema,
  controlApiInstanceId: identifierSchema,
  operationId: z.string().uuid(),
  actorId: identifierSchema,
  issuedAt: timestampSchema,
  expiresAt: timestampSchema,
};

function validateTaskReadAuthorization(
  message: { payload: { issuedAt: string; expiresAt: string } },
  context: z.RefinementCtx,
): void {
  const issuedAt = Date.parse(message.payload.issuedAt);
  const expiresAt = Date.parse(message.payload.expiresAt);
  if (expiresAt <= issuedAt || expiresAt - issuedAt > 15_000) {
    context.addIssue({
      code: "custom",
      path: ["payload", "expiresAt"],
      message: "Task read authorization must expire within fifteen seconds.",
    });
  }
}

export const controlLinkTaskListRequestV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.task-list-request.v1"),
    payload: z
      .object({
        ...taskReadRequestIdentityShape,
        query: taskHistoryListQueryV1Schema,
      })
      .strict(),
  })
  .strict()
  .superRefine(validateTaskReadAuthorization);

export const controlLinkTaskDetailRequestV1Schema = z
  .object({
    ...controlLinkEnvelopeShape,
    type: z.literal("control.link.task-detail-request.v1"),
    payload: z
      .object({
        ...taskReadRequestIdentityShape,
        taskId: z.string().uuid(),
      })
      .strict(),
  })
  .strict()
  .superRefine(validateTaskReadAuthorization);

export const controlLinkTaskReadErrorCodeSchema = z.enum([
  "REQUEST_INVALID",
  "TASK_NOT_FOUND",
  "TASK_HISTORY_UNAVAILABLE",
  "AUTHORIZATION_REJECTED",
  "CONTROL_LINK_BACKPRESSURE",
  "CONTROL_LINK_STOPPED",
  "CONTROL_LINK_INTERNAL_ERROR",
]);

const taskReadResponseIdentityShape = {
  coordinatorInstanceId: identifierSchema,
  requestMessageId: z.string().uuid(),
  operationId: z.string().uuid(),
};

export const controlLinkTaskListResponseV1Schema = z.discriminatedUnion("ok", [
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.task-list-response.v1"),
      ok: z.literal(true),
      payload: z
        .object({
          ...taskReadResponseIdentityShape,
          result: taskHistoryListPageV1Schema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.task-list-response.v1"),
      ok: z.literal(false),
      payload: z
        .object({
          ...taskReadResponseIdentityShape,
          errorCode: controlLinkTaskReadErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const controlLinkTaskDetailResponseV1Schema = z.discriminatedUnion("ok", [
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.task-detail-response.v1"),
      ok: z.literal(true),
      payload: z
        .object({
          ...taskReadResponseIdentityShape,
          result: z
            .object({
              generatedAt: timestampSchema,
              task: publicTaskDetailV1Schema,
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...controlLinkEnvelopeShape,
      type: z.literal("control.link.task-detail-response.v1"),
      ok: z.literal(false),
      payload: z
        .object({
          ...taskReadResponseIdentityShape,
          errorCode: controlLinkTaskReadErrorCodeSchema,
        })
        .strict(),
    })
    .strict(),
]);

export const controlLinkClientMessageV1Schema = z.union([
  controlLinkAuthenticateV1Schema,
  controlLinkStopRequestV1Schema,
  controlLinkGoalRequestV1Schema,
  controlLinkTaskListRequestV1Schema,
  controlLinkTaskDetailRequestV1Schema,
]);

export const controlLinkServerMessageV1Schema = z.union([
  controlLinkChallengeV1Schema,
  controlLinkAcceptedV1Schema,
  controlLinkSnapshotBeginV1Schema,
  controlLinkSnapshotItemV1Schema,
  controlLinkSnapshotEndV1Schema,
  controlLinkStateUpsertV1Schema,
  controlLinkStopResponseV1Schema,
  controlLinkGoalResponseV1Schema,
  controlLinkTaskListResponseV1Schema,
  controlLinkTaskDetailResponseV1Schema,
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
export type ControlLinkGoalRequestV1 = z.infer<
  typeof controlLinkGoalRequestV1Schema
>;
export type ControlLinkGoalErrorCode = z.infer<
  typeof controlLinkGoalErrorCodeSchema
>;
export type ControlLinkGoalResponseV1 = z.infer<
  typeof controlLinkGoalResponseV1Schema
>;
export type ControlLinkTaskListRequestV1 = z.infer<
  typeof controlLinkTaskListRequestV1Schema
>;
export type ControlLinkTaskListResponseV1 = z.infer<
  typeof controlLinkTaskListResponseV1Schema
>;
export type ControlLinkTaskDetailRequestV1 = z.infer<
  typeof controlLinkTaskDetailRequestV1Schema
>;
export type ControlLinkTaskDetailResponseV1 = z.infer<
  typeof controlLinkTaskDetailResponseV1Schema
>;
export type ControlLinkTaskReadErrorCode = z.infer<
  typeof controlLinkTaskReadErrorCodeSchema
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

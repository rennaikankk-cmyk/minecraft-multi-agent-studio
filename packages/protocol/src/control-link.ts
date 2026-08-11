import { z } from "zod";

import { botStopResultV1Schema, identifierSchema } from "./bot-messages.js";
import { publicBotDetailV1Schema } from "./control-api.js";

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

export const controlLinkCapabilitySchema = z.enum(["bot.read", "bot.stop"]);

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

export const controlLinkClientMessageV1Schema = z.union([
  controlLinkAuthenticateV1Schema,
  controlLinkStopRequestV1Schema,
]);

export const controlLinkServerMessageV1Schema = z.union([
  controlLinkChallengeV1Schema,
  controlLinkAcceptedV1Schema,
  controlLinkSnapshotBeginV1Schema,
  controlLinkSnapshotItemV1Schema,
  controlLinkSnapshotEndV1Schema,
  controlLinkStateUpsertV1Schema,
  controlLinkStopResponseV1Schema,
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

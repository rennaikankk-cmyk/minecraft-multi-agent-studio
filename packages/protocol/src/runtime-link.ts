import { z } from "zod";

import {
  botStopResultV1Schema,
  botTelemetryMessageV1Schema,
  identifierSchema,
  stopBotCommandV1Schema,
} from "./bot-messages.js";

export const RUNTIME_LINK_PATH = "/v1/runtime-link";
export const RUNTIME_LINK_SUBPROTOCOL = "minecraft-studio.runtime.v1";
export const RUNTIME_LINK_MAX_PAYLOAD_BYTES = 65_536;

const timestampSchema = z.string().datetime({ offset: true });
const nonceOrProofSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);

const runtimeLinkEnvelopeShape = {
  schemaVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  timestamp: timestampSchema,
};

export const runtimeLinkChallengeV1Schema = z
  .object({
    ...runtimeLinkEnvelopeShape,
    type: z.literal("runtime.link.challenge.v1"),
    payload: z
      .object({
        coordinatorInstanceId: identifierSchema,
        challengeNonce: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const runtimeLinkAuthenticateV1Schema = z
  .object({
    ...runtimeLinkEnvelopeShape,
    type: z.literal("runtime.link.authenticate.v1"),
    payload: z
      .object({
        challengeMessageId: z.string().uuid(),
        coordinatorInstanceId: identifierSchema,
        challengeNonce: nonceOrProofSchema,
        clientNonce: nonceOrProofSchema,
        botId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        keyId: identifierSchema,
        clientProof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const runtimeLinkAcceptedV1Schema = z
  .object({
    ...runtimeLinkEnvelopeShape,
    type: z.literal("runtime.link.accepted.v1"),
    payload: z
      .object({
        challengeMessageId: z.string().uuid(),
        authenticateMessageId: z.string().uuid(),
        coordinatorInstanceId: identifierSchema,
        botId: identifierSchema,
        runtimeInstanceId: identifierSchema,
        keyId: identifierSchema,
        serverProof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const runtimeLinkTelemetryAckReasonSchema = z.enum([
  "accepted",
  "duplicate_message",
  "duplicate_sequence",
  "out_of_order",
  "retired_runtime",
  "older_runtime_start",
]);

export const runtimeLinkTelemetryAckV1Schema = z
  .object({
    ...runtimeLinkEnvelopeShape,
    type: z.literal("runtime.link.telemetry-ack.v1"),
    payload: z
      .object({
        telemetryMessageId: z.string().uuid(),
        accepted: z.boolean(),
        reason: runtimeLinkTelemetryAckReasonSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((message, context) => {
    if (message.payload.accepted !== (message.payload.reason === "accepted")) {
      context.addIssue({
        code: "custom",
        path: ["payload", "accepted"],
        message: "Telemetry acknowledgement acceptance and reason disagree.",
      });
    }
  });

export const runtimeLinkClientMessageV1Schema = z.union([
  runtimeLinkAuthenticateV1Schema,
  botTelemetryMessageV1Schema,
  botStopResultV1Schema,
]);

export const runtimeLinkServerMessageV1Schema = z.union([
  runtimeLinkChallengeV1Schema,
  runtimeLinkAcceptedV1Schema,
  runtimeLinkTelemetryAckV1Schema,
  stopBotCommandV1Schema,
]);

export type RuntimeLinkChallengeV1 = z.infer<
  typeof runtimeLinkChallengeV1Schema
>;
export type RuntimeLinkAuthenticateV1 = z.infer<
  typeof runtimeLinkAuthenticateV1Schema
>;
export type RuntimeLinkAcceptedV1 = z.infer<typeof runtimeLinkAcceptedV1Schema>;
export type RuntimeLinkTelemetryAckReason = z.infer<
  typeof runtimeLinkTelemetryAckReasonSchema
>;
export type RuntimeLinkTelemetryAckV1 = z.infer<
  typeof runtimeLinkTelemetryAckV1Schema
>;
export type RuntimeLinkClientMessageV1 = z.infer<
  typeof runtimeLinkClientMessageV1Schema
>;
export type RuntimeLinkServerMessageV1 = z.infer<
  typeof runtimeLinkServerMessageV1Schema
>;

export type RuntimeLinkProofContext = Readonly<{
  challengeMessageId: string;
  coordinatorInstanceId: string;
  challengeNonce: string;
  clientNonce: string;
  botId: string;
  runtimeInstanceId: string;
  keyId: string;
}>;

export type RuntimeLinkServerProofContext = RuntimeLinkProofContext &
  Readonly<{ authenticateMessageId: string }>;

export function runtimeLinkClientProofInput(
  context: RuntimeLinkProofContext,
): string {
  return proofInput("client", context);
}

export function runtimeLinkServerProofInput(
  context: RuntimeLinkServerProofContext,
): string {
  return `${proofInput("server", context)}\n${context.authenticateMessageId}`;
}

export function parseRuntimeLinkClientMessage(
  input: unknown,
): RuntimeLinkClientMessageV1 {
  return runtimeLinkClientMessageV1Schema.parse(input);
}

/**
 * This parser validates the transport shape only. A returned stop command is
 * not authorized until Bot Runtime rebuilds a trusted context from an
 * authenticated Runtime Link session and calls parseBotProtocolMessage.
 */
export function parseRuntimeLinkServerMessage(
  input: unknown,
): RuntimeLinkServerMessageV1 {
  return runtimeLinkServerMessageV1Schema.parse(input);
}

function proofInput(
  side: "client" | "server",
  context: RuntimeLinkProofContext,
): string {
  return [
    `minecraft-studio-runtime-link/${side}/v1`,
    context.challengeMessageId,
    context.coordinatorInstanceId,
    context.challengeNonce,
    context.clientNonce,
    context.botId,
    context.runtimeInstanceId,
    context.keyId,
  ].join("\n");
}

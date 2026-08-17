import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";

export const SUPERVISOR_IPC_MAX_PAYLOAD_BYTES = 128 * 1_024;
export const SUPERVISOR_IPC_MAX_BOTS_PER_PROCESS = 3;

const timestampSchema = z.string().datetime({ offset: true });
const nonceOrProofSchema = z
  .string()
  .length(43)
  .regex(/^[A-Za-z0-9_-]+$/u);
const sha256Schema = z.string().length(64).regex(/^[a-f0-9]+$/u);
const boundedTextSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value));

export const supervisorDeploymentTierSchema = z.enum([
  "production",
  "canary",
  "test",
  "batch",
]);

export const supervisorBotAssignmentV1Schema = z
  .object({
    botId: identifierSchema,
    profilePath: boundedTextSchema,
    profileSha256: sha256Schema,
    deploymentTier: supervisorDeploymentTierSchema,
    runtimeLink: z
      .object({
        url: boundedTextSchema.max(2_048),
        keyId: identifierSchema,
        secret: z
          .string()
          .min(32)
          .max(512)
          .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value)),
      })
      .strict(),
  })
  .strict();

const supervisorEnvelopeShape = {
  schemaVersion: z.literal("1.0"),
  messageId: z.string().uuid(),
  timestamp: timestampSchema,
};

const supervisorSessionShape = {
  supervisorInstanceId: identifierSchema,
  childId: identifierSchema,
  groupId: identifierSchema,
};

export const supervisorIpcChallengeV1Schema = z
  .object({
    ...supervisorEnvelopeShape,
    type: z.literal("supervisor.ipc.challenge.v1"),
    payload: z
      .object({
        ...supervisorSessionShape,
        challengeNonce: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const supervisorIpcAuthenticateV1Schema = z
  .object({
    ...supervisorEnvelopeShape,
    type: z.literal("supervisor.ipc.authenticate.v1"),
    payload: z
      .object({
        ...supervisorSessionShape,
        challengeMessageId: z.string().uuid(),
        challengeNonce: nonceOrProofSchema,
        childNonce: nonceOrProofSchema,
        childPid: z.number().int().positive(),
        childProof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const supervisorIpcStartV1Schema = z
  .object({
    ...supervisorEnvelopeShape,
    type: z.literal("supervisor.ipc.start.v1"),
    payload: z
      .object({
        ...supervisorSessionShape,
        challengeMessageId: z.string().uuid(),
        authenticateMessageId: z.string().uuid(),
        challengeNonce: nonceOrProofSchema,
        childNonce: nonceOrProofSchema,
        assignments: z
          .array(supervisorBotAssignmentV1Schema)
          .min(1)
          .max(SUPERVISOR_IPC_MAX_BOTS_PER_PROCESS),
        parentProof: nonceOrProofSchema,
      })
      .strict()
      .superRefine((payload, context) => {
        const botIds = payload.assignments.map((assignment) => assignment.botId);
        if (new Set(botIds).size !== botIds.length) {
          context.addIssue({
            code: "custom",
            path: ["assignments"],
            message: "Supervisor 进程组不能包含重复的 Bot ID。",
          });
        }
      }),
  })
  .strict();

export const supervisorChildLifecycleStateSchema = z.enum([
  "starting",
  "ready",
  "stopping",
  "stopped",
  "failed",
]);

export const supervisorIpcLifecycleV1Schema = z
  .object({
    ...supervisorEnvelopeShape,
    type: z.literal("supervisor.ipc.lifecycle.v1"),
    payload: z
      .object({
        ...supervisorSessionShape,
        childPid: z.number().int().positive(),
        sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
        state: supervisorChildLifecycleStateSchema,
        botIds: z.array(identifierSchema).min(1).max(SUPERVISOR_IPC_MAX_BOTS_PER_PROCESS),
        code: z.string().min(1).max(128).optional(),
        proof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const supervisorIpcStopV1Schema = z
  .object({
    ...supervisorEnvelopeShape,
    type: z.literal("supervisor.ipc.stop.v1"),
    payload: z
      .object({
        ...supervisorSessionShape,
        reason: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u),
        proof: nonceOrProofSchema,
      })
      .strict(),
  })
  .strict();

export const supervisorParentMessageV1Schema = z.union([
  supervisorIpcChallengeV1Schema,
  supervisorIpcStartV1Schema,
  supervisorIpcStopV1Schema,
]);

export const supervisorChildMessageV1Schema = z.union([
  supervisorIpcAuthenticateV1Schema,
  supervisorIpcLifecycleV1Schema,
]);

export type SupervisorDeploymentTier = z.infer<
  typeof supervisorDeploymentTierSchema
>;
export type SupervisorBotAssignmentV1 = z.infer<
  typeof supervisorBotAssignmentV1Schema
>;
export type SupervisorIpcChallengeV1 = z.infer<
  typeof supervisorIpcChallengeV1Schema
>;
export type SupervisorIpcAuthenticateV1 = z.infer<
  typeof supervisorIpcAuthenticateV1Schema
>;
export type SupervisorIpcStartV1 = z.infer<
  typeof supervisorIpcStartV1Schema
>;
export type SupervisorChildLifecycleState = z.infer<
  typeof supervisorChildLifecycleStateSchema
>;
export type SupervisorIpcLifecycleV1 = z.infer<
  typeof supervisorIpcLifecycleV1Schema
>;
export type SupervisorIpcStopV1 = z.infer<
  typeof supervisorIpcStopV1Schema
>;
export type SupervisorParentMessageV1 = z.infer<
  typeof supervisorParentMessageV1Schema
>;
export type SupervisorChildMessageV1 = z.infer<
  typeof supervisorChildMessageV1Schema
>;

export type SupervisorIpcProofContext = Readonly<{
  supervisorInstanceId: string;
  childId: string;
  groupId: string;
  challengeMessageId: string;
  challengeNonce: string;
  childNonce: string;
  childPid: number;
}>;

export function supervisorIpcChildProofInput(
  context: SupervisorIpcProofContext,
): string {
  return proofInput("child", context);
}

export function supervisorIpcParentProofInput(
  context: SupervisorIpcProofContext &
    Readonly<{
      authenticateMessageId: string;
      assignments: readonly SupervisorBotAssignmentV1[];
    }>,
): string {
  return [
    proofInput("parent", context),
    context.authenticateMessageId,
    canonicalAssignments(context.assignments),
  ].join("\n");
}

export function supervisorIpcLifecycleProofInput(
  context: Readonly<{
    supervisorInstanceId: string;
    childId: string;
    groupId: string;
    childPid: number;
    sequence: number;
    state: SupervisorChildLifecycleState;
    botIds: readonly string[];
    code?: string;
  }>,
): string {
  return [
    "minecraft-studio-supervisor-ipc/lifecycle/v1",
    context.supervisorInstanceId,
    context.childId,
    context.groupId,
    String(context.childPid),
    String(context.sequence),
    context.state,
    JSON.stringify(context.botIds),
    context.code ?? "",
  ].join("\n");
}

export function supervisorIpcStopProofInput(
  context: Readonly<{
    supervisorInstanceId: string;
    childId: string;
    groupId: string;
    reason: string;
  }>,
): string {
  return [
    "minecraft-studio-supervisor-ipc/stop/v1",
    context.supervisorInstanceId,
    context.childId,
    context.groupId,
    context.reason,
  ].join("\n");
}

export function parseSupervisorParentMessage(
  input: unknown,
): SupervisorParentMessageV1 {
  return supervisorParentMessageV1Schema.parse(input);
}

export function parseSupervisorChildMessage(
  input: unknown,
): SupervisorChildMessageV1 {
  return supervisorChildMessageV1Schema.parse(input);
}

function proofInput(
  side: "child" | "parent",
  context: SupervisorIpcProofContext,
): string {
  return [
    `minecraft-studio-supervisor-ipc/${side}/v1`,
    context.supervisorInstanceId,
    context.childId,
    context.groupId,
    context.challengeMessageId,
    context.challengeNonce,
    context.childNonce,
    String(context.childPid),
  ].join("\n");
}

function canonicalAssignments(
  assignments: readonly SupervisorBotAssignmentV1[],
): string {
  return JSON.stringify(
    assignments.map((assignment) => ({
      botId: assignment.botId,
      profilePath: assignment.profilePath,
      profileSha256: assignment.profileSha256,
      deploymentTier: assignment.deploymentTier,
      runtimeLink: {
        url: assignment.runtimeLink.url,
        keyId: assignment.runtimeLink.keyId,
        secret: assignment.runtimeLink.secret,
      },
    })),
  );
}

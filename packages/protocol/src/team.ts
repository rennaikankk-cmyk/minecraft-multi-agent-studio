import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";
import { skillIdentifierSchema } from "./skill-messages.js";

const timestampSchema = z.string().datetime({ offset: true });

export const TEAM_ROLES = [
  "scout",
  "raider",
  "defender",
  "combat",
  "infrastructure",
  "logistics",
] as const;

export const teamRoleSchema = z.enum(TEAM_ROLES);

export const teamObjectiveInputV1Schema = z
  .object({
    objectiveId: identifierSchema,
    serverProfileId: identifierSchema,
    title: z.string().trim().min(1).max(256),
    maxBots: z.number().int().min(1).max(10),
    preferredRoles: z.array(teamRoleSchema).max(TEAM_ROLES.length).default([]),
  })
  .strict()
  .superRefine((objective, context) => {
    if (new Set(objective.preferredRoles).size !== objective.preferredRoles.length) {
      context.addIssue({
        code: "custom",
        path: ["preferredRoles"],
        message: "Preferred team roles must be unique.",
      });
    }
  });

export const teamResourceClaimV1Schema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("named"),
      key: z.string().trim().min(1).max(128),
    })
    .strict(),
  z
    .object({
      kind: z.literal("area"),
      dimension: z
        .string()
        .min(3)
        .max(128)
        .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
      x: z.number().finite().min(-30_000_000).max(30_000_000),
      y: z.number().finite().min(-2_048).max(2_048),
      z: z.number().finite().min(-30_000_000).max(30_000_000),
      radius: z.number().finite().min(0.5).max(128),
    })
    .strict(),
]);

export const teamTaskAssignmentInputV1Schema = z
  .object({
    taskId: identifierSchema,
    objectiveId: identifierSchema,
    requiredSkills: z.array(skillIdentifierSchema).min(1).max(16),
    preferredRoles: z.array(teamRoleSchema).max(TEAM_ROLES.length).default([]),
    claims: z.array(teamResourceClaimV1Schema).max(16).default([]),
    leaseMs: z.number().int().min(1_000).max(5 * 60_000),
  })
  .strict()
  .superRefine((assignment, context) => {
    if (new Set(assignment.requiredSkills).size !== assignment.requiredSkills.length) {
      context.addIssue({
        code: "custom",
        path: ["requiredSkills"],
        message: "Required skills must be unique.",
      });
    }
    if (new Set(assignment.preferredRoles).size !== assignment.preferredRoles.length) {
      context.addIssue({
        code: "custom",
        path: ["preferredRoles"],
        message: "Preferred team roles must be unique.",
      });
    }
  });

export const teamTaskAssignmentV1Schema = z
  .object({
    taskId: identifierSchema,
    objectiveId: identifierSchema,
    serverProfileId: identifierSchema,
    botId: identifierSchema,
    role: teamRoleSchema.nullable(),
    requiredSkills: z.array(skillIdentifierSchema).min(1).max(16),
    claims: z.array(teamResourceClaimV1Schema).max(16),
    assignedAt: timestampSchema,
    leaseExpiresAt: timestampSchema,
  })
  .strict()
  .superRefine((assignment, context) => {
    if (Date.parse(assignment.leaseExpiresAt) <= Date.parse(assignment.assignedAt)) {
      context.addIssue({
        code: "custom",
        path: ["leaseExpiresAt"],
        message: "Team task lease expiry must follow assignment.",
      });
    }
  });

export type TeamRole = z.infer<typeof teamRoleSchema>;
export type TeamObjectiveInputV1 = z.infer<typeof teamObjectiveInputV1Schema>;
export type TeamResourceClaimV1 = z.infer<typeof teamResourceClaimV1Schema>;
export type TeamTaskAssignmentInputV1 = z.infer<
  typeof teamTaskAssignmentInputV1Schema
>;
export type TeamTaskAssignmentV1 = z.infer<typeof teamTaskAssignmentV1Schema>;

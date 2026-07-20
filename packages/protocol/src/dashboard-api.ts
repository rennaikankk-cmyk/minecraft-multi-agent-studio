import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";
import { publicBotDetailV1Schema } from "./control-api.js";

const timestampSchema = z.string().datetime({ offset: true });

export const dashboardBotListResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z
      .object({
        source: z.literal("control-api"),
        generatedAt: timestampSchema,
        bots: z.array(publicBotDetailV1Schema).max(100),
        capabilities: z
          .object({
            stopConfirmationConfigured: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const dashboardStopRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    confirmationCode: z.string().min(6).max(128),
  })
  .strict();

export const dashboardStopResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: z
      .object({
        botId: identifierSchema,
        commandId: z.string().uuid(),
        outcome: z.enum(["completed", "rejected", "failed"]),
        errorCode: z.string().trim().min(1).max(100).nullable(),
      })
      .strict(),
  })
  .strict();

export const dashboardApiErrorCodeSchema = z.enum([
  "DASHBOARD_CONTROL_NOT_CONFIGURED",
  "CONTROL_API_UNAVAILABLE",
  "CONTROL_API_REJECTED",
  "INVALID_CONTROL_RESPONSE",
  "INVALID_REQUEST",
  "CONFIRMATION_REQUIRED",
  "RATE_LIMITED",
  "STOP_FAILED",
]);

export const dashboardApiErrorV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    error: z
      .object({
        code: dashboardApiErrorCodeSchema,
        message: z.string().trim().min(1).max(200),
      })
      .strict(),
  })
  .strict();

export type DashboardBotListResponseV1 = z.infer<
  typeof dashboardBotListResponseV1Schema
>;
export type DashboardStopRequestV1 = z.infer<
  typeof dashboardStopRequestV1Schema
>;
export type DashboardStopResponseV1 = z.infer<
  typeof dashboardStopResponseV1Schema
>;
export type DashboardApiErrorCode = z.infer<typeof dashboardApiErrorCodeSchema>;
export type DashboardApiErrorV1 = z.infer<typeof dashboardApiErrorV1Schema>;

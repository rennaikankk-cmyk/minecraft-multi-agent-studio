import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";
import {
  goalDispatchResultV1Schema,
} from "./control-api.js";
import { controlLinkGoalErrorCodeSchema } from "./control-link.js";

export const COORDINATOR_GOAL_EXECUTION_PATH =
  "/v1/internal/coordinator-goal-execution";

export const coordinatorGoalExecutionRequestV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    taskId: z.string().uuid(),
    assignmentLeaseOwner: identifierSchema,
    workerInstanceId: identifierSchema,
  })
  .strict();

const responseIdentityShape = {
  schemaVersion: z.literal("1.0"),
  taskId: z.string().uuid(),
};

export const coordinatorGoalExecutionResponseV1Schema =
  z.discriminatedUnion("ok", [
    z
      .object({
        ...responseIdentityShape,
        ok: z.literal(true),
        result: goalDispatchResultV1Schema,
      })
      .strict()
      .superRefine((response, context) => {
        if (response.result.taskId !== response.taskId) {
          context.addIssue({
            code: "custom",
            path: ["result", "taskId"],
            message: "Goal execution result taskId must match the request.",
          });
        }
      }),
    z
      .object({
        ...responseIdentityShape,
        ok: z.literal(false),
        errorCode: controlLinkGoalErrorCodeSchema,
      })
      .strict(),
  ]);

export type CoordinatorGoalExecutionRequestV1 = z.infer<
  typeof coordinatorGoalExecutionRequestV1Schema
>;
export type CoordinatorGoalExecutionResponseV1 = z.infer<
  typeof coordinatorGoalExecutionResponseV1Schema
>;

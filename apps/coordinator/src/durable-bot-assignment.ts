import { randomUUID } from "node:crypto";

import {
  identifierSchema,
  type TaskDispatchV1,
} from "@minecraft-studio/protocol";
import {
  PostgresTaskRepository,
  taskAssignmentAcquireCommandSchema,
  taskRecordSchema,
  type AcquireTaskAssignmentResult,
  type TaskRecord,
} from "@minecraft-studio/task-system";
import { z } from "zod";

import {
  BotAssignmentError,
  BotAssignmentService,
  type BotAssignmentLease,
  type BotAssignmentSkillRequirement,
} from "./bot-assignment.js";
import type { BotRegistry } from "./bot-registry.js";

const durableAssignmentRequestSchema = z
  .object({
    operationId: z.string().uuid(),
    taskId: z.string().uuid(),
    expectedRevision: z.number().int().nonnegative(),
    actorId: identifierSchema,
    serverProfileId: identifierSchema,
    dimension: z
      .string()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u),
    requiredSkills: z.array(
      z.object({
        skillId: z.string().min(3).max(128),
        skillVersion: z.string().min(1).max(128).nullable(),
      }).strict(),
    ).max(64),
    preferredBotId: identifierSchema.nullable().default(null),
    leaseOwner: identifierSchema,
    leaseDurationMs: z.number().int().min(1_000).max(5 * 60_000),
  })
  .strict();

export type DurableBotAssignmentRequest = z.infer<
  typeof durableAssignmentRequestSchema
>;

export type DurableBotAssignmentResult = Readonly<{
  task: TaskRecord;
  dispatch: TaskDispatchV1;
  outbox: AcquireTaskAssignmentResult["outbox"];
  assignment: BotAssignmentLease;
}>;

export type DurableBotAssignmentRepository = Pick<
  PostgresTaskRepository,
  "acquireTaskAssignment" | "getTask" | "recoverExpiredLease"
>;

/**
 * Bridges deterministic Bot selection to the PostgreSQL task lease boundary.
 * The in-memory lease only closes the local selection race; PostgreSQL is the
 * authority and commits the task lease plus TaskDispatch outbox atomically.
 */
export class DurableBotAssignmentService {
  private readonly randomId: () => string;

  constructor(
    private readonly options: Readonly<{
      registry: BotRegistry;
      repository: DurableBotAssignmentRepository;
      coordinatorInstanceId: string;
      assignment?: BotAssignmentService;
      now?: () => Date;
      randomId?: () => string;
    }>,
  ) {
    identifierSchema.parse(options.coordinatorInstanceId);
    this.randomId = options.randomId ?? randomUUID;
  }

  async acquire(input: unknown): Promise<DurableBotAssignmentResult> {
    const request = durableAssignmentRequestSchema.parse(input);
    const memory =
      this.options.assignment ??
      new BotAssignmentService({ registry: this.options.registry });
    let localLease: BotAssignmentLease;
    try {
      localLease = memory.acquire({
        taskId: request.taskId,
        serverProfileId: request.serverProfileId,
        dimension: request.dimension,
        requiredSkills: request.requiredSkills,
        preferredBotId: request.preferredBotId,
        leaseTtlMs: request.leaseDurationMs,
      });
    } catch (error) {
      if (error instanceof BotAssignmentError) throw error;
      throw error;
    }

    try {
      const durable = await this.options.repository.acquireTaskAssignment(
        taskAssignmentAcquireCommandSchema.parse({
          schemaVersion: "1.0",
          operationId: request.operationId,
          taskId: request.taskId,
          expectedRevision: request.expectedRevision,
          actorId: request.actorId,
          botId: localLease.botId,
          leaseOwner: request.leaseOwner,
          leaseDurationMs: request.leaseDurationMs,
          serverProfileId: request.serverProfileId,
          dimension: request.dimension,
        }),
      );
      if (
        durable.task.taskId !== request.taskId ||
        durable.task.assignedBotId !== localLease.botId ||
        durable.dispatch.botId !== localLease.botId ||
        durable.outbox.payload.messageId !== durable.dispatch.messageId
      ) {
        throw new Error("Durable assignment result failed identity validation.");
      }
      return {
        task: durable.task,
        dispatch: durable.dispatch,
        outbox: durable.outbox,
        assignment: localLease,
      };
    } catch (error) {
      memory.release(localLease.leaseId);
      throw error;
    }
  }

  async getTask(taskId: string): Promise<TaskRecord | null> {
    return this.options.repository.getTask(taskId);
  }

  async recoverExpiredLease(input: unknown) {
    const result = await this.options.repository.recoverExpiredLease(input);
    taskRecordSchema.parse(result.task);
    return result;
  }

  newOperationId(): string {
    return this.randomId();
  }
}

export type { BotAssignmentSkillRequirement };

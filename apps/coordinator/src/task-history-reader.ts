import {
  publicTaskDetailV1Schema,
  taskHistoryListPageV1Schema,
  type PublicTaskDetailV1,
  type PublicTaskSummaryV1,
  type TaskHistoryListPageV1,
  type TaskHistoryListQueryV1,
} from "@minecraft-studio/protocol";
import {
  TaskSystemError,
  type PostgresTaskRepository,
  type TaskRecord,
} from "@minecraft-studio/task-system";
import { z } from "zod";

import { safePersistedGoalInput } from "./goal-lifecycle-store.js";

const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);
const canonicalUuidSchema = z
  .string()
  .uuid()
  .refine((value) => value === value.toLowerCase());

const cursorPayloadSchema = z
  .object({
    version: z.literal(1),
    createdAt: canonicalTimestampSchema,
    taskId: canonicalUuidSchema,
  })
  .strict();

export type TaskHistoryDetailResult = Readonly<{
  generatedAt: string;
  task: PublicTaskDetailV1;
}>;

export interface TaskHistoryReader {
  listTaskHistory(
    query: TaskHistoryListQueryV1,
  ): Promise<TaskHistoryListPageV1>;
  getTaskDetail(taskId: string): Promise<TaskHistoryDetailResult | null>;
}

export type TaskHistoryReaderErrorCode =
  | "REQUEST_INVALID"
  | "TASK_HISTORY_UNAVAILABLE";

export class TaskHistoryReaderError extends Error {
  constructor(
    readonly code: TaskHistoryReaderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskHistoryReaderError";
  }
}

export type PostgresTaskHistoryReaderOptions = Readonly<{
  repository: Pick<
    PostgresTaskRepository,
    "getDatabaseTime" | "getTask" | "listTaskHistory"
  >;
}>;

export class PostgresTaskHistoryReader implements TaskHistoryReader {
  constructor(private readonly options: PostgresTaskHistoryReaderOptions) {}

  async listTaskHistory(
    query: TaskHistoryListQueryV1,
  ): Promise<TaskHistoryListPageV1> {
    const before = query.cursor === null ? null : decodeCursor(query.cursor);
    try {
      const page = await this.options.repository.listTaskHistory({
        limit: query.limit,
        status: query.status,
        botId: query.botId,
        before,
      });
      const generatedAt = (
        await this.options.repository.getDatabaseTime()
      ).toISOString();
      const last = page.tasks.at(-1);
      return taskHistoryListPageV1Schema.parse({
        generatedAt,
        tasks: page.tasks.map(projectTaskSummary),
        nextCursor:
          page.hasMore && last
            ? encodeCursor(last.createdAt, last.taskId)
            : null,
      });
    } catch (error) {
      throw readerError(error);
    }
  }

  async getTaskDetail(taskId: string): Promise<TaskHistoryDetailResult | null> {
    try {
      const task = await this.options.repository.getTask(taskId);
      if (!task) return null;
      const generatedAt = (
        await this.options.repository.getDatabaseTime()
      ).toISOString();
      return {
        generatedAt,
        task: publicTaskDetailV1Schema.parse({
          ...projectTaskSummary(task),
          operatorGoal: operatorGoal(task),
        }),
      };
    } catch (error) {
      throw readerError(error);
    }
  }
}

function projectTaskSummary(task: TaskRecord): PublicTaskSummaryV1 {
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    title: task.title,
    status: task.status,
    priority: task.priority,
    riskLevel: task.riskLevel,
    botId: taskBotId(task),
    failureReason: task.failureReason,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
    revision: task.revision,
  };
}

function taskBotId(task: TaskRecord): string | null {
  if (task.taskType === "coordinator.goal") {
    const input = safePersistedGoalInput(task);
    if (input) return input.botId;
  }
  return task.dispatchBotId ?? task.assignedBotId;
}

function operatorGoal(task: TaskRecord): string | null {
  return safePersistedGoalInput(task)?.operatorGoal ?? null;
}

function encodeCursor(createdAt: string, taskId: string): string {
  return Buffer.from(
    JSON.stringify(cursorPayloadSchema.parse({ version: 1, createdAt, taskId })),
    "utf8",
  ).toString("base64url");
}

function decodeCursor(cursor: string): Readonly<{
  createdAt: string;
  taskId: string;
}> {
  try {
    const decoded = Buffer.from(cursor, "base64url");
    if (decoded.toString("base64url") !== cursor) throw new Error();
    const payload = cursorPayloadSchema.parse(
      JSON.parse(decoded.toString("utf8")) as unknown,
    );
    if (encodeCursor(payload.createdAt, payload.taskId) !== cursor) {
      throw new Error();
    }
    return { createdAt: payload.createdAt, taskId: payload.taskId };
  } catch {
    throw new TaskHistoryReaderError(
      "REQUEST_INVALID",
      "Task history cursor is invalid.",
    );
  }
}

function readerError(error: unknown): TaskHistoryReaderError {
  if (error instanceof TaskHistoryReaderError) return error;
  if (error instanceof TaskSystemError) {
    return new TaskHistoryReaderError(
      "TASK_HISTORY_UNAVAILABLE",
      "PostgreSQL task history is unavailable.",
    );
  }
  return new TaskHistoryReaderError(
    "TASK_HISTORY_UNAVAILABLE",
    "Task history could not be read.",
  );
}

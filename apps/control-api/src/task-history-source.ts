import type {
  PublicTaskDetailV1,
  TaskHistoryListPageV1,
  TaskHistoryListQueryV1,
} from "@minecraft-studio/protocol";

export type TaskHistoryReadContext = Readonly<{
  operationId: string;
  actorId: string;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type TaskHistoryListRequest = TaskHistoryReadContext &
  Readonly<{ query: TaskHistoryListQueryV1 }>;

export type TaskHistoryDetailRequest = TaskHistoryReadContext &
  Readonly<{ taskId: string }>;

export type TaskHistoryDetailResult = Readonly<{
  generatedAt: string;
  task: PublicTaskDetailV1;
}>;

export type TaskHistorySourceErrorCode =
  | "TASK_NOT_FOUND"
  | "TASK_HISTORY_UNAVAILABLE"
  | "AUTHORIZATION_REJECTED"
  | "REQUEST_INVALID";

export class TaskHistorySourceError extends Error {
  constructor(
    readonly code: TaskHistorySourceErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TaskHistorySourceError";
  }
}

export interface TaskHistorySource {
  isTaskHistoryReady(): boolean;
  listTaskHistory(request: TaskHistoryListRequest): Promise<TaskHistoryListPageV1>;
  getTaskDetail(request: TaskHistoryDetailRequest): Promise<TaskHistoryDetailResult>;
}

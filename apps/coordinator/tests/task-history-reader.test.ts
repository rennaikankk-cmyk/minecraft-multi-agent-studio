import type { TaskRecord } from "@minecraft-studio/task-system";
import { describe, expect, it, vi } from "vitest";

import {
  PostgresTaskHistoryReader,
  TaskHistoryReaderError,
} from "../src/task-history-reader.js";

const NOW = new Date("2026-08-22T10:00:00.000Z");
const FIRST_TASK_ID = "00000000-0000-4000-8000-000000000001";
const SECOND_TASK_ID = "00000000-0000-4000-8000-000000000002";
const OPERATION_ID = "11111111-1111-4111-8111-111111111111";

describe("PostgresTaskHistoryReader", () => {
  it("returns a redacted page and uses an opaque cursor for the next query", async () => {
    const listTaskHistory = vi
      .fn()
      .mockResolvedValueOnce({
        tasks: [
          task({
            taskId: FIRST_TASK_ID,
            dispatchBotId: "dispatch-fallback",
            assignedBotId: "assigned-fallback",
          }),
        ],
        hasMore: true,
      })
      .mockResolvedValueOnce({
        tasks: [task({ taskId: SECOND_TASK_ID })],
        hasMore: false,
      });
    const reader = new PostgresTaskHistoryReader({
      repository: {
        listTaskHistory,
        getDatabaseTime: async () => NOW,
        getTask: async () => null,
      },
    });

    const first = await reader.listTaskHistory({
      limit: 1,
      cursor: null,
      status: null,
      botId: null,
    });
    expect(first.tasks[0]).toEqual(
      expect.objectContaining({
        taskId: FIRST_TASK_ID,
        botId: "worker-01",
        status: "completed",
      }),
    );
    expect(first.tasks[0]).not.toHaveProperty("operatorGoal");
    expect(first.nextCursor).toEqual(expect.any(String));

    await reader.listTaskHistory({
      limit: 1,
      cursor: first.nextCursor,
      status: "completed",
      botId: "worker-01",
    });
    expect(listTaskHistory).toHaveBeenLastCalledWith({
      limit: 1,
      status: "completed",
      botId: "worker-01",
      before: {
        createdAt: "2026-08-22T09:00:00.000Z",
        taskId: FIRST_TASK_ID,
      },
    });
  });

  it("returns only the authorized operator goal in detail", async () => {
    const reader = new PostgresTaskHistoryReader({
      repository: {
        listTaskHistory: async () => ({ tasks: [], hasMore: false }),
        getDatabaseTime: async () => NOW,
        getTask: async () => task(),
      },
    });

    await expect(reader.getTaskDetail(FIRST_TASK_ID)).resolves.toEqual({
      generatedAt: NOW.toISOString(),
      task: expect.objectContaining({
        taskId: FIRST_TASK_ID,
        operatorGoal: "Collect nearby wood",
      }),
    });
  });

  it("redacts goal identity and text when persisted goal input is incomplete", async () => {
    const reader = new PostgresTaskHistoryReader({
      repository: {
        listTaskHistory: async () => ({
          tasks: [
            task({
              input: {
                kind: "coordinator.goal.v1",
                botId: "spoofed-bot",
                operatorGoal: "Spoofed goal",
              },
              dispatchBotId: "dispatch-fallback",
              assignedBotId: "assigned-fallback",
            }),
          ],
          hasMore: false,
        }),
        getDatabaseTime: async () => NOW,
        getTask: async () =>
          task({
            input: {
              kind: "coordinator.goal.v1",
              botId: "spoofed-bot",
              operatorGoal: "Spoofed goal",
            },
            dispatchBotId: "dispatch-fallback",
            assignedBotId: "assigned-fallback",
          }),
      },
    });

    await expect(
      reader.listTaskHistory({
        limit: 1,
        cursor: null,
        status: null,
        botId: null,
      }),
    ).resolves.toMatchObject({ tasks: [{ botId: "dispatch-fallback" }] });
    await expect(reader.getTaskDetail(FIRST_TASK_ID)).resolves.toMatchObject({
      task: { botId: "dispatch-fallback", operatorGoal: null },
    });
  });

  it("uses dispatch identity before assignment for non-goal tasks", async () => {
    const reader = new PostgresTaskHistoryReader({
      repository: {
        listTaskHistory: async () => ({
          tasks: [
            task({
              taskType: "resource.collect",
              dispatchBotId: "dispatch-bot",
              assignedBotId: "assigned-bot",
            }),
          ],
          hasMore: false,
        }),
        getDatabaseTime: async () => NOW,
        getTask: async () => null,
      },
    });

    await expect(
      reader.listTaskHistory({
        limit: 1,
        cursor: null,
        status: null,
        botId: null,
      }),
    ).resolves.toMatchObject({ tasks: [{ botId: "dispatch-bot" }] });
  });

  it("rejects an invalid cursor without querying PostgreSQL", async () => {
    const listTaskHistory = vi.fn();
    const reader = new PostgresTaskHistoryReader({
      repository: {
        listTaskHistory,
        getDatabaseTime: async () => NOW,
        getTask: async () => null,
      },
    });

    await expect(
      reader.listTaskHistory({
        limit: 10,
        cursor: "not-a-valid-cursor",
        status: null,
        botId: null,
      }),
    ).rejects.toMatchObject<TaskHistoryReaderError>({ code: "REQUEST_INVALID" });
    expect(listTaskHistory).not.toHaveBeenCalled();
  });

  it.each([
    [
      "re-encoded payload",
      rawCursor({
        taskId: FIRST_TASK_ID,
        createdAt: "2026-08-22T09:00:00.000Z",
        version: 1,
      }),
    ],
    [
      "non-canonical UTC",
      rawCursor({
        version: 1,
        createdAt: "2026-08-22T17:00:00.000+08:00",
        taskId: FIRST_TASK_ID,
      }),
    ],
    [
      "non-canonical UUID",
      rawCursor({
        version: 1,
        createdAt: "2026-08-22T09:00:00.000Z",
        taskId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
      }),
    ],
    [
      "extra payload field",
      rawCursor({
        version: 1,
        createdAt: "2026-08-22T09:00:00.000Z",
        taskId: FIRST_TASK_ID,
        extra: true,
      }),
    ],
  ])("rejects a %s cursor before querying PostgreSQL", async (_label, cursor) => {
    const listTaskHistory = vi.fn();
    const reader = new PostgresTaskHistoryReader({
      repository: {
        listTaskHistory,
        getDatabaseTime: async () => NOW,
        getTask: async () => null,
      },
    });

    await expect(
      reader.listTaskHistory({
        limit: 10,
        cursor,
        status: null,
        botId: null,
      }),
    ).rejects.toMatchObject<TaskHistoryReaderError>({ code: "REQUEST_INVALID" });
    expect(listTaskHistory).not.toHaveBeenCalled();
  });
});

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const taskId = overrides.taskId ?? FIRST_TASK_ID;
  return {
    schemaVersion: "1.0",
    taskId,
    idempotencyScope: "control-goal-v1",
    idempotencyKey: OPERATION_ID,
    requestFingerprint: "a".repeat(64),
    taskType: "coordinator.goal",
    handlerVersion: "1.0.0",
    executionIdempotent: false,
    title: "Submitted goal",
    description: "Authenticated operator goal.",
    input: {
      schemaVersion: "1.0",
      kind: "coordinator.goal.v1",
      operationId: OPERATION_ID,
      taskId,
      clientId: "control-api",
      actorId: "operator-01",
      botId: "worker-01",
      operatorGoal: "Collect nearby wood",
      timeoutMs: 60_000,
    },
    priority: 50,
    status: "completed",
    dispatchBotId: null,
    assignedBotId: null,
    requiredSkills: [],
    requiredItems: [],
    target: null,
    dependencyIds: [],
    parentTaskId: null,
    createdAt: "2026-08-22T09:00:00.000Z",
    updatedAt: "2026-08-22T09:01:00.000Z",
    startedAt: "2026-08-22T09:00:01.000Z",
    finishedAt: "2026-08-22T09:01:00.000Z",
    deadline: null,
    timeoutMs: 60_000,
    retryCount: 0,
    maxRetries: 0,
    leaseOwner: null,
    leaseExpiresAt: null,
    riskLevel: "R1",
    failureReason: null,
    result: { action: "noop" },
    evidence: [],
    traceId: OPERATION_ID,
    revision: 3,
    ...overrides,
  };
}

function rawCursor(payload: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

import { describe, expect, it } from "vitest";

import {
  CONTROL_LINK_MAX_TASK_HISTORY_ITEMS,
  publicTaskDetailV1Schema,
  publicTaskSummaryV1Schema,
  taskHistoryCursorSchema,
  taskHistoryListPageV1Schema,
  taskHistoryListQueryV1Schema,
} from "../src/index.js";

const UUID = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-07T10:00:00.000Z";
const MAX_TIMESTAMP = "9999-12-31T23:59:59.999999999+14:00";
const summary = {
  taskId: UUID,
  taskType: "planner.goal",
  title: "Collect nearby wood",
  status: "completed" as const,
  priority: 50,
  riskLevel: "R1" as const,
  botId: "worker-01",
  failureReason: null,
  createdAt: NOW,
  updatedAt: NOW,
  startedAt: NOW,
  finishedAt: NOW,
  revision: 3,
};

describe("Task history protocol", () => {
  it("caps both requested and returned pages at 32 tasks", () => {
    expect(CONTROL_LINK_MAX_TASK_HISTORY_ITEMS).toBe(32);
    expect(
      taskHistoryListQueryV1Schema.parse({
        limit: CONTROL_LINK_MAX_TASK_HISTORY_ITEMS,
        cursor: null,
        status: null,
        botId: null,
      }).limit,
    ).toBe(32);
    expect(
      taskHistoryListQueryV1Schema.safeParse({
        limit: CONTROL_LINK_MAX_TASK_HISTORY_ITEMS + 1,
        cursor: null,
        status: null,
        botId: null,
      }).success,
    ).toBe(false);

    const tasks = Array.from(
      { length: CONTROL_LINK_MAX_TASK_HISTORY_ITEMS },
      () => summary,
    );
    expect(
      taskHistoryListPageV1Schema.parse({
        generatedAt: NOW,
        tasks,
        nextCursor: null,
      }).tasks,
    ).toHaveLength(32);
    expect(
      taskHistoryListPageV1Schema.safeParse({
        generatedAt: NOW,
        tasks: [...tasks, summary],
        nextCursor: null,
      }).success,
    ).toBe(false);
  });

  it("treats cursors as bounded opaque base64url values", () => {
    expect(taskHistoryCursorSchema.parse("A".repeat(16))).toHaveLength(16);
    expect(taskHistoryCursorSchema.parse("A".repeat(512))).toHaveLength(512);
    for (const invalid of [
      "A".repeat(15),
      "A".repeat(513),
      `${"A".repeat(16)}=`,
      `${"A".repeat(15)}+`,
      `${"A".repeat(15)}/`,
      `${"A".repeat(15)} `,
    ]) {
      expect(taskHistoryCursorSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("rejects unknown fields at every task-history object boundary", () => {
    expect(
      taskHistoryListQueryV1Schema.safeParse({
        limit: 1,
        cursor: null,
        status: null,
        botId: null,
        internal: true,
      }).success,
    ).toBe(false);
    expect(
      publicTaskSummaryV1Schema.safeParse({ ...summary, description: "private" })
        .success,
    ).toBe(false);
    expect(
      publicTaskDetailV1Schema.safeParse({
        ...summary,
        operatorGoal: "Collect wood",
        result: { raw: true },
      }).success,
    ).toBe(false);
    expect(
      taskHistoryListPageV1Schema.safeParse({
        generatedAt: NOW,
        tasks: [summary],
        nextCursor: null,
        source: "database",
      }).success,
    ).toBe(false);
  });

  it("bounds task timestamps so the page size has a finite maximum", () => {
    expect(
      publicTaskSummaryV1Schema.safeParse({
        ...summary,
        createdAt: MAX_TIMESTAMP,
        updatedAt: MAX_TIMESTAMP,
        startedAt: MAX_TIMESTAMP,
        finishedAt: MAX_TIMESTAMP,
      }).success,
    ).toBe(true);
    expect(
      publicTaskSummaryV1Schema.safeParse({
        ...summary,
        createdAt: "9999-12-31T23:59:59.9999999999+14:00",
      }).success,
    ).toBe(false);
  });
});

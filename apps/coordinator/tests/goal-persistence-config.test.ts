import { describe, expect, it } from "vitest";

import {
  GoalPersistenceConfigError,
  loadGoalPersistenceConfig,
} from "../src/goal-persistence-config.js";

describe("goal persistence configuration", () => {
  it("keeps durable goal execution disabled when no PostgreSQL URL is set", () => {
    expect(loadGoalPersistenceConfig({})).toBeNull();
  });

  it("accepts a hardware-independent PostgreSQL endpoint and validated schema", () => {
    expect(
      loadGoalPersistenceConfig({
        COORDINATOR_TASK_POSTGRES_URL:
          "postgresql://studio:secret@db.internal:5432/studio_tasks?sslmode=require",
        COORDINATOR_TASK_POSTGRES_SCHEMA: "coordinator_tasks",
      }),
    ).toEqual({
      postgresUrl:
        "postgresql://studio:secret@db.internal:5432/studio_tasks?sslmode=require",
      schemaName: "coordinator_tasks",
    });
  });

  it.each([
    [{ COORDINATOR_TASK_POSTGRES_URL: "https://example.invalid/tasks" }],
    [{ COORDINATOR_TASK_POSTGRES_URL: "postgresql://db.internal" }],
    [
      {
        COORDINATOR_TASK_POSTGRES_URL:
          "postgresql://studio@db.internal/studio_tasks",
        COORDINATOR_TASK_POSTGRES_SCHEMA: "public;DROP TABLE studio_tasks",
      },
    ],
    [{ COORDINATOR_TASK_POSTGRES_SCHEMA: "tasks" }],
  ])("rejects unsafe or incomplete configuration", (environment) => {
    expect(() => loadGoalPersistenceConfig(environment)).toThrowError(
      GoalPersistenceConfigError,
    );
  });
});

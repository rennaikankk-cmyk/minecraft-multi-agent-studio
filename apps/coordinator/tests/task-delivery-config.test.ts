import { describe, expect, it } from "vitest";

import {
  GoalPersistenceConfigError,
  loadGoalPersistenceConfig,
} from "../src/goal-persistence-config.js";
import {
  TaskDeliveryConfigError,
  loadTaskDeliveryConfig,
} from "../src/task-delivery-config.js";

const persistence = loadGoalPersistenceConfig({
  COORDINATOR_TASK_POSTGRES_URL:
    "postgresql://studio:secret@127.0.0.1:5432/studio_test",
  COORDINATOR_TASK_POSTGRES_SCHEMA: "studio_test_coord_12345678",
});

if (!persistence) {
  throw new GoalPersistenceConfigError("Test persistence fixture is invalid.");
}

describe("Coordinator task delivery configuration", () => {
  it("stays disabled unless an explicit isolated profile is selected", () => {
    expect(loadTaskDeliveryConfig({}, persistence)).toBeNull();
    for (const [key, value] of [
      ["COORDINATOR_TASK_REDIS_URL", "redis://127.0.0.1:6379/15"],
      ["COORDINATOR_TASK_QUEUE_NAME", "studio_tasks_v1"],
      ["COORDINATOR_TASK_QUEUE_PREFIX", "studio_test_coord_12345678"],
      ["COORDINATOR_TASK_DELIVERY_INSTANCE_ID", "delivery-01"],
      ["COORDINATOR_TASK_OUTBOX_BATCH_SIZE", "10"],
      ["COORDINATOR_TASK_OUTBOX_CLAIM_TTL_MS", "1000"],
      ["COORDINATOR_TASK_OUTBOX_POLL_INTERVAL_MS", "100"],
      ["COORDINATOR_TASK_OUTBOX_RETRY_BASE_MS", "10"],
      ["COORDINATOR_TASK_OUTBOX_RETRY_MAX_MS", "100"],
    ] as const) {
      expect(() =>
        loadTaskDeliveryConfig({ [key]: value }, persistence),
      ).toThrowError(
        expect.objectContaining<TaskDeliveryConfigError>({
          code: "TASK_DELIVERY_CONFIG_INVALID",
        }),
      );
    }
    expect(
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_QUEUE_NAME: "   ",
          COORDINATOR_TASK_OUTBOX_BATCH_SIZE: "",
        },
        persistence,
      ),
    ).toBeNull();
  });

  it("requires loopback Redis and an isolated PostgreSQL namespace", () => {
    expect(() =>
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "production",
          COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
        },
        persistence,
      ),
    ).toThrow(TaskDeliveryConfigError);
    expect(() =>
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "isolated-test",
          COORDINATOR_TASK_REDIS_URL: "redis://cache.internal:6379/15",
        },
        persistence,
      ),
    ).toThrow(TaskDeliveryConfigError);
    expect(() =>
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "isolated-test",
          COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
        },
        { ...persistence, schemaName: "public" },
      ),
    ).toThrow(TaskDeliveryConfigError);
    const remotePersistence = loadGoalPersistenceConfig({
      COORDINATOR_TASK_POSTGRES_URL:
        "postgresql://studio:secret@db.internal:5432/studio_test",
      COORDINATOR_TASK_POSTGRES_SCHEMA: "studio_test_coord_12345678",
    });
    if (!remotePersistence) {
      throw new GoalPersistenceConfigError(
        "Remote persistence fixture is invalid.",
      );
    }
    expect(() =>
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "isolated-test",
          COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
        },
        remotePersistence,
      ),
    ).toThrow(TaskDeliveryConfigError);
  });

  it("loads bounded delivery defaults", () => {
    expect(
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "isolated-test",
          COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
        },
        persistence,
      ),
    ).toEqual({
      purpose: "isolated-test",
      redisUrl: "redis://127.0.0.1:6379/15",
      queueName: "studio_tasks_v1",
      queuePrefix: "studio_test_coord_12345678",
      instanceId: "coordinator-task-delivery",
      batchSize: 25,
      claimTtlMs: 30_000,
      pollIntervalMs: 1_000,
      retryBaseMs: 250,
      retryMaxMs: 60_000,
    });
    expect(() =>
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "isolated-test",
          COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
          COORDINATOR_TASK_QUEUE_PREFIX: "studio_test_other_12345678",
        },
        persistence,
      ),
    ).toThrow(TaskDeliveryConfigError);

    expect(
      loadTaskDeliveryConfig(
        {
          COORDINATOR_TASK_DELIVERY: "isolated-test",
          COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
          COORDINATOR_TASK_QUEUE_NAME: "   ",
          COORDINATOR_TASK_QUEUE_PREFIX: "   ",
          COORDINATOR_TASK_DELIVERY_INSTANCE_ID: "   ",
          COORDINATOR_TASK_OUTBOX_BATCH_SIZE: "",
          COORDINATOR_TASK_OUTBOX_CLAIM_TTL_MS: "",
          COORDINATOR_TASK_OUTBOX_POLL_INTERVAL_MS: "",
          COORDINATOR_TASK_OUTBOX_RETRY_BASE_MS: "",
          COORDINATOR_TASK_OUTBOX_RETRY_MAX_MS: "",
        },
        persistence,
      ),
    ).toMatchObject({
      purpose: "isolated-test",
      queueName: "studio_tasks_v1",
      queuePrefix: "studio_test_coord_12345678",
      instanceId: "coordinator-task-delivery",
      batchSize: 25,
      claimTtlMs: 30_000,
      pollIntervalMs: 1_000,
      retryBaseMs: 250,
      retryMaxMs: 60_000,
    });
  });
});

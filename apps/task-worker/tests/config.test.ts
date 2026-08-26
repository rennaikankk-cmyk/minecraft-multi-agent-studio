import { describe, expect, it } from "vitest";

import { TaskInfrastructureConfigError } from "@minecraft-studio/task-system";

import {
  TaskWorkerConfigError,
  loadTaskWorkerConfig,
} from "../src/config.js";

const validEnvironment = {
  TASK_WORKER_PURPOSE: "isolated-test",
  TASK_WORKER_HANDLER_PROFILE: "isolated-acceptance",
  TASK_INFRA_TEST_NAMESPACE: "studio_test_worker_12345678",
  TASK_POSTGRES_URL: "postgresql://studio:secret@127.0.0.1:5432/studio_test",
  TASK_REDIS_URL: "redis://127.0.0.1:6379/15",
} satisfies NodeJS.ProcessEnv;

describe("Task Worker isolated configuration", () => {
  it("loads bounded defaults into one dedicated namespace", () => {
    expect(loadTaskWorkerConfig(validEnvironment)).toMatchObject({
      purpose: "isolated-test",
      handlerProfile: "isolated-acceptance",
      schemaName: "studio_test_worker_12345678",
      infrastructure: {
        queueName: "studio_tasks_v1",
        queuePrefix: "studio_test_worker_12345678",
      },
      concurrency: 1,
      leaseDurationMs: 5_000,
      renewIntervalMs: 1_000,
      cancellationPollIntervalMs: 100,
    });
  });

  it("fails closed unless the isolated purpose and handler are explicit", () => {
    for (const environment of [
      { ...validEnvironment, TASK_WORKER_PURPOSE: undefined },
      { ...validEnvironment, TASK_WORKER_PURPOSE: "production" },
      { ...validEnvironment, TASK_WORKER_HANDLER_PROFILE: undefined },
    ]) {
      expect(() => loadTaskWorkerConfig(environment)).toThrowError(
        expect.objectContaining<TaskWorkerConfigError>({
          code: "TASK_WORKER_CONFIG_INVALID",
        }),
      );
    }
  });

  it("rejects shared or remote infrastructure", () => {
    expect(() =>
      loadTaskWorkerConfig({
        ...validEnvironment,
        TASK_INFRA_TEST_NAMESPACE: "public",
      }),
    ).toThrow(TaskWorkerConfigError);
    expect(() =>
      loadTaskWorkerConfig({
        ...validEnvironment,
        TASK_REDIS_URL: "redis://cache.internal:6379/15",
      }),
    ).toThrow(TaskInfrastructureConfigError);
  });

  it("rejects unsafe timing relationships", () => {
    expect(() =>
      loadTaskWorkerConfig({
        ...validEnvironment,
        TASK_WORKER_LEASE_DURATION_MS: "5000",
        TASK_WORKER_RENEW_INTERVAL_MS: "3000",
      }),
    ).toThrow(TaskWorkerConfigError);
    expect(() =>
      loadTaskWorkerConfig({
        ...validEnvironment,
        TASK_WORKER_CANCELLATION_WAIT_MS: "1000",
        TASK_WORKER_CANCELLATION_POLL_INTERVAL_MS: "2000",
      }),
    ).toThrow(TaskWorkerConfigError);
  });

  it("loads the explicit production Coordinator goal profile", () => {
    expect(
      loadTaskWorkerConfig({
        TASK_WORKER_PURPOSE: "production",
        TASK_WORKER_HANDLER_PROFILE: "coordinator-goal",
        COORDINATOR_TASK_POSTGRES_URL:
          "postgresql://studio:secret@127.0.0.1:5432/studio",
        COORDINATOR_TASK_POSTGRES_SCHEMA: "public",
        COORDINATOR_TASK_REDIS_URL: "redis://127.0.0.1:6379/0",
        COORDINATOR_TASK_EXECUTION_SECRET: "x".repeat(32),
      }),
    ).toMatchObject({
      purpose: "production",
      handlerProfile: "coordinator-goal",
      schemaName: "public",
      coordinatorExecution: {
        url: "http://127.0.0.1:3222",
        secret: "x".repeat(32),
      },
    });
  });
});

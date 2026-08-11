import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const queueDouble = vi.hoisted(() => ({
  add: vi.fn(),
  close: vi.fn(),
  constructorOptions: [] as unknown[],
  getJob: vi.fn(),
  getVersion: vi.fn(),
  remove: vi.fn(),
  waitUntilReady: vi.fn(),
}));

vi.mock("bullmq", () => ({
  Queue: class {
    constructor(_name: string, options: unknown) {
      queueDouble.constructorOptions.push(options);
    }

    add(...args: unknown[]) {
      return queueDouble.add(...args);
    }

    close() {
      return queueDouble.close();
    }

    getJob(...args: unknown[]) {
      return queueDouble.getJob(...args);
    }

    getVersion() {
      return queueDouble.getVersion();
    }

    remove(...args: unknown[]) {
      return queueDouble.remove(...args);
    }

    waitUntilReady() {
      return queueDouble.waitUntilReady();
    }
  },
}));

import {
  BullMqTaskQueue,
  TASK_QUEUE_OPERATION_TIMEOUT_MS,
  TaskQueueError,
  bullMqTaskConnectionOptions,
  taskDispatchEquivalenceFingerprint,
  taskDispatchJobId,
} from "../src/bullmq-queue.js";

const TASK_ID = "2a7f5a33-05c7-4336-a037-27c196256978";
const JOB_ID = taskDispatchJobId(TASK_ID, 4);
const dispatch = {
  schemaVersion: "1.0" as const,
  messageId: "11111111-1111-4111-8111-111111111111",
  traceId: "trace-queue-001",
  timestamp: "2026-07-27T11:00:00.000Z",
  source: {
    service: "coordinator" as const,
    instanceId: "coordinator-01",
  },
  taskId: TASK_ID,
  botId: "worker-01",
  type: "task.dispatch.v1" as const,
  payload: {
    expectedRevision: 4,
    taskType: "resource.collect",
    handlerVersion: "1.0.0",
    executionIdempotent: true,
  },
};

function createQueue(): BullMqTaskQueue {
  return new BullMqTaskQueue({
    redisUrl: "redis://127.0.0.1:6379/0",
    queueName: "studio_tasks_v1",
    prefix: "studio_test_queue_unit",
  });
}

beforeEach(() => {
  queueDouble.add.mockReset().mockResolvedValue({ id: JOB_ID });
  queueDouble.close.mockReset().mockResolvedValue(undefined);
  queueDouble.constructorOptions.length = 0;
  queueDouble.getJob.mockReset().mockResolvedValue(null);
  queueDouble.getVersion.mockReset().mockResolvedValue("8.8.0");
  queueDouble.remove.mockReset().mockResolvedValue(1);
  queueDouble.waitUntilReady.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("BullMqTaskQueue safety boundaries", () => {
  it("uses bounded Queue retries while retaining Worker blocking semantics", () => {
    createQueue();
    const constructorOptions = queueDouble.constructorOptions[0] as {
      connection: {
        maxRetriesPerRequest: number | null;
        retryStrategy: (attempt: number) => number | null;
      };
    };
    expect(constructorOptions.connection.maxRetriesPerRequest).toBe(1);
    expect(constructorOptions.connection.retryStrategy(1)).toBe(100);
    expect(constructorOptions.connection.retryStrategy(3)).toBe(400);
    expect(constructorOptions.connection.retryStrategy(4)).toBeNull();

    const workerOptions = bullMqTaskConnectionOptions(
      "redis://127.0.0.1:6379/0",
    );
    expect(workerOptions.maxRetriesPerRequest).toBeNull();
    expect(workerOptions.retryStrategy?.(50)).toBe(2_000);
  });

  it("ignores transport metadata when comparing equivalent dispatches", () => {
    const retried = {
      ...dispatch,
      messageId: "22222222-2222-4222-8222-222222222222",
      timestamp: "2026-07-27T11:00:01.000Z",
      source: {
        ...dispatch.source,
        instanceId: "coordinator-02",
      },
    };
    expect(taskDispatchEquivalenceFingerprint(retried)).toBe(
      taskDispatchEquivalenceFingerprint(dispatch),
    );
  });

  it("includes all durable dispatch semantics in the fingerprint", () => {
    const variants = [
      { ...dispatch, taskId: "33333333-3333-4333-8333-333333333333" },
      { ...dispatch, botId: "worker-02" },
      { ...dispatch, traceId: "trace-queue-002" },
      {
        ...dispatch,
        payload: { ...dispatch.payload, expectedRevision: 5 },
      },
      {
        ...dispatch,
        payload: { ...dispatch.payload, taskType: "resource.deliver" },
      },
    ];
    const fingerprint = taskDispatchEquivalenceFingerprint(dispatch);
    for (const variant of variants) {
      expect(taskDispatchEquivalenceFingerprint(variant)).not.toBe(
        fingerprint,
      );
    }
  });

  it("accepts equivalent retries without claiming which caller created the job", async () => {
    const stored = {
      ...dispatch,
      messageId: "22222222-2222-4222-8222-222222222222",
      timestamp: "2026-07-27T11:00:01.000Z",
      source: {
        ...dispatch.source,
        instanceId: "coordinator-02",
      },
    };
    queueDouble.getJob.mockResolvedValue({ data: stored });
    const result = await createQueue().enqueue(dispatch);

    expect(result).toEqual({ jobId: JOB_ID, accepted: true });
    expect(result).not.toHaveProperty("created");
    expect(queueDouble.add).not.toHaveBeenCalled();
  });

  it("rejects a durable semantic conflict for the same task revision", async () => {
    queueDouble.getJob.mockResolvedValue({
      data: { ...dispatch, botId: "worker-02" },
    });
    await expect(createQueue().enqueue(dispatch)).rejects.toMatchObject<
      Partial<TaskQueueError>
    >({
      code: "TASK_QUEUE_MESSAGE_CONFLICT",
    });
  });

  it("returns only conservative acceptance for concurrent equivalent adds", async () => {
    let lookupCount = 0;
    queueDouble.getJob.mockImplementation(async () => {
      lookupCount += 1;
      return lookupCount <= 2 ? null : { data: dispatch };
    });
    const queue = createQueue();
    const retry = {
      ...dispatch,
      messageId: "22222222-2222-4222-8222-222222222222",
      timestamp: "2026-07-27T11:00:01.000Z",
      source: {
        ...dispatch.source,
        instanceId: "coordinator-02",
      },
    };

    const results = await Promise.all([
      queue.enqueue(dispatch),
      queue.enqueue(retry),
    ]);
    expect(results).toEqual([
      { jobId: JOB_ID, accepted: true },
      { jobId: JOB_ID, accepted: true },
    ]);
    expect(results.every((result) => !("created" in result))).toBe(true);
  });

  it("bounds enqueue, lookup and remove when Redis never settles", async () => {
    vi.useFakeTimers();
    const never = new Promise<never>(() => undefined);
    queueDouble.getJob.mockReturnValue(never);
    queueDouble.remove.mockReturnValue(never);
    const queue = createQueue();

    const assertions = [
      expect(queue.enqueue(dispatch)).rejects.toMatchObject({
        code: "TASK_QUEUE_UNAVAILABLE",
      }),
      expect(queue.getJob(TASK_ID, 4)).rejects.toMatchObject({
        code: "TASK_QUEUE_UNAVAILABLE",
      }),
      expect(queue.remove(TASK_ID, 4)).rejects.toMatchObject({
        code: "TASK_QUEUE_UNAVAILABLE",
      }),
    ];
    await vi.advanceTimersByTimeAsync(
      TASK_QUEUE_OPERATION_TIMEOUT_MS + 1,
    );
    await Promise.all(assertions);
  });

  it("maps immediate Redis failures to TASK_QUEUE_UNAVAILABLE", async () => {
    queueDouble.getJob.mockRejectedValue(new Error("redis unavailable"));
    await expect(createQueue().getJob(TASK_ID, 4)).rejects.toMatchObject<
      Partial<TaskQueueError>
    >({
      code: "TASK_QUEUE_UNAVAILABLE",
    });
  });
});

import { createHash } from "node:crypto";

import type { AppLogger } from "@minecraft-studio/observability";
import {
  skillExecutionResultV1Schema,
  skillInvocationV1Schema,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
} from "@minecraft-studio/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  BotClient,
  BotClientHandlers,
  BotClientSnapshot,
} from "../../bot-runtime/src/client.js";
import { BotRuntimeHost } from "../../bot-runtime/src/runtime-host.js";
import type { ServerProfile } from "../../bot-runtime/src/server-profile.js";
import {
  BotRegistry,
  ControlLinkServer,
  CoordinatorLocalPlanner,
  durableGoalFingerprint,
  RuntimeLinkServer,
  type CoordinatorLocalPlannerOptions,
  type GoalLifecycleSnapshot,
  type GoalLifecycleStore,
} from "../../coordinator/src/index.js";
import { CoordinatorLinkClient } from "../src/coordinator-link-client.js";
import { ControlApiServer } from "../src/server.js";

const BOT_ID = "goal-worker-01";
const COORDINATOR_ID = "coordinator-goal-e2e";
const RUNTIME_KEY_ID = "runtime-goal-e2e-key";
const RUNTIME_SECRET = "runtime-goal-e2e-secret-00000000000000000001";
const CONTROL_CLIENT_ID = "control-api-goal-e2e";
const CONTROL_KEY_ID = "control-goal-e2e-key";
const CONTROL_SECRET = "control-goal-e2e-secret-00000000000000000001";
const OPERATOR_TOKEN = "goal-e2e-operator-token-00000000000000000001";

const profile: ServerProfile = {
  schemaVersion: "1.0",
  id: "isolated-goal-e2e",
  botId: BOT_ID,
  purpose: "isolated-test",
  networkScope: "loopback",
  host: "127.0.0.1",
  port: 25_565,
  minecraftVersion: "1.21.8",
  username: "GoalE2EBot",
  auth: "offline",
  statusIntervalMs: 30_000,
  heartbeatIntervalMs: 60_000,
  stopGracePeriodMs: 100,
  reconnect: {
    enabled: false,
    maxAttempts: 0,
    baseDelayMs: 500,
    maxDelayMs: 500,
  },
};

const logger: AppLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

type RunningStack = Readonly<{
  baseUrl: string;
  client: GoalExecutionClient;
  sendSkillInvocation: ReturnType<typeof vi.spyOn>;
  requestFreshStatus: ReturnType<typeof vi.spyOn>;
  handleCoordinatorSkillInvocation: ReturnType<typeof vi.spyOn>;
  handleSkillInvocation: ReturnType<typeof vi.spyOn>;
  plannerRegistryGet: ReturnType<typeof vi.fn>;
  close(): Promise<void>;
}>;
const runningStacks: RunningStack[] = [];

afterEach(async () => {
  for (const stack of runningStacks.splice(0).reverse()) {
    await stack.close();
  }
  vi.clearAllMocks();
});

describe("goal execution across the production control path", () => {
  it("expands one HTTP goal into three authorized Runtime capability calls", async () => {
    const stack = await startStack();
    const requestId = testUuid(1);

    const response = await submitCraftingTableGoal(stack.baseUrl, requestId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      action: "skill_result",
      botId: BOT_ID,
      taskId: requestId,
      skillId: "craft.item",
      skillVersion: "1.0.0",
      outcome: "completed",
    });
    expect(capabilitySteps(stack.client.capabilityCalls)).toEqual([
      "collect.block:oak_log",
      "craft.item:oak_planks",
      "craft.item:crafting_table",
    ]);
    const detailResponse = await fetch(
      `${stack.baseUrl}/v1/bots/${encodeURIComponent(BOT_ID)}`,
      { headers: { Authorization: `Bearer ${OPERATOR_TOKEN}` } },
    );
    const detailBody = await detailResponse.json();
    expect(detailResponse.status).toBe(200);
    expect(detailBody.data.bot.currentTask).toEqual({
      taskId: requestId,
      title: "craft.item",
      status: "completed",
      startedAt: expect.any(String),
    });
    assertInvocationChain(stack, 3);
  });

  it("reobserves before safely retrying a Runtime rejection that never entered the handler", async () => {
    const stack = await startStack({ rejectOakPlanksOnce: true });
    const requestId = testUuid(2);

    const response = await submitCraftingTableGoal(stack.baseUrl, requestId);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      action: "skill_result",
      outcome: "completed",
    });
    expect(invocationSteps(stack.sendSkillInvocation.mock.calls)).toEqual([
      "collect.block:oak_log",
      "craft.item:oak_planks",
      "craft.item:oak_planks",
      "craft.item:crafting_table",
    ]);
    expect(capabilitySteps(stack.client.capabilityCalls)).toEqual([
      "collect.block:oak_log",
      "craft.item:oak_planks",
      "craft.item:crafting_table",
    ]);
    expect(stack.plannerRegistryGet).toHaveBeenCalledTimes(7);
    expect(stack.requestFreshStatus).toHaveBeenCalledTimes(1);
    expect(stack.client.snapshotCalls).toBeGreaterThan(1);
    assertInvocationChain(stack, 4, 3);
  });

  it("fails closed instead of replaying a non-idempotent middle step", async () => {
    const stack = await startStack({ failOakPlanksOnce: true });
    const requestId = testUuid(3);

    const response = await submitCraftingTableGoal(stack.baseUrl, requestId);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({
      code: "GOAL_REJECTED",
    });
    expect(capabilitySteps(stack.client.capabilityCalls)).toEqual([
      "collect.block:oak_log",
      "craft.item:oak_planks",
    ]);
    assertInvocationChain(stack, 2);

    const failedRuntimeResult = await stack.handleSkillInvocation.mock.results[1]?.value;
    expect(failedRuntimeResult).toMatchObject({
      payload: {
        outcome: "failed",
        errorCode: "SKILL_CAPABILITY_FAILED",
      },
    });

    const plankInvocations = stack.sendSkillInvocation.mock.calls
      .map(([invocation]) => invocation)
      .filter(
        (invocation) =>
          invocation.payload.skillId === "craft.item" &&
          inputField(invocation.payload.input, "itemName") === "oak_planks",
    );
    expect(plankInvocations).toHaveLength(1);
    expect(stack.requestFreshStatus).not.toHaveBeenCalled();
  });

  it("rejects a completed middle step whose read-back output is partial", async () => {
    const stack = await startStack({ partialOakPlanksOnce: true });
    const requestId = testUuid(4);

    const response = await submitCraftingTableGoal(stack.baseUrl, requestId);
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatchObject({ code: "GOAL_REJECTED" });
    expect(capabilitySteps(stack.client.capabilityCalls)).toEqual([
      "collect.block:oak_log",
      "craft.item:oak_planks",
    ]);
    assertInvocationChain(stack, 2);
    expect(stack.requestFreshStatus).not.toHaveBeenCalled();
  });
});

async function startStack(
  options: Readonly<{
    failOakPlanksOnce?: boolean;
    partialOakPlanksOnce?: boolean;
    rejectOakPlanksOnce?: boolean;
  }> = {},
): Promise<RunningStack> {
  const registry = new BotRegistry({ staleAfterMs: 60_000 });
  const runtimeLink = new RuntimeLinkServer({
    host: "127.0.0.1",
    port: 0,
    instanceId: COORDINATOR_ID,
    peers: [
      {
        keyId: RUNTIME_KEY_ID,
        botId: BOT_ID,
        secretSha256: sha256(RUNTIME_SECRET),
      },
    ],
    registry,
    logger,
  });
  const runtimeAddress = await runtimeLink.start();

  const client = new GoalExecutionClient({
    failOakPlanksOnce: options.failOakPlanksOnce === true,
    partialOakPlanksOnce: options.partialOakPlanksOnce === true,
  });
  const host = new BotRuntimeHost({
    profile,
    runtimeLinkConfig: {
      url: `ws://127.0.0.1:${runtimeAddress.port}/v1/runtime-link`,
      keyId: RUNTIME_KEY_ID,
      secret: RUNTIME_SECRET,
      handshakeTimeoutMs: 5_000,
      telemetryAckTimeoutMs: 5_000,
      reconnect: { maxAttempts: 0, baseDelayMs: 250, maxDelayMs: 250 },
      queue: {
        maxMessages: 128,
        maxBytes: 512 * 1_024,
        maxSocketBufferedBytes: 256 * 1_024,
      },
    },
    logger,
    createClient: () => client,
  });
  await host.start();
  client.spawn();
  await vi.waitFor(
    () => {
      expect(registry.get(BOT_ID)).toMatchObject({
        connectionState: "online",
        currentStatus: {
          safety: { normalTasksPaused: false },
        },
        skillCatalog: {
          skills: expect.arrayContaining([
            expect.objectContaining({
              skillId: "collect.block",
              availability: "available",
            }),
            expect.objectContaining({
              skillId: "craft.item",
              availability: "available",
            }),
          ]),
        },
      });
    },
    { timeout: 5_000, interval: 10 },
  );

  const generate = vi.fn<CoordinatorLocalPlannerOptions["ai"]["generate"]>(
    async (request) => {
      const now = new Date().toISOString();
      return {
        requestId: request.requestId,
        botId: request.botId,
        priority: request.priority,
        value: {
          content: JSON.stringify({
            action: "plan_items",
            botId: BOT_ID,
            taskId: request.requestId,
            goals: [{ itemName: "crafting_table", count: 1 }],
            reasonCode: "ADVANCE_TASK",
          }),
          usage: { promptTokens: 12, completionTokens: 12 },
        },
        attempts: 1,
        enqueuedAt: now,
        startedAt: now,
        completedAt: now,
        queueTimeMs: 0,
        executionTimeMs: 1,
        totalTimeMs: 1,
      };
    },
  );
  const plannerRegistryGet = vi.fn((botId: string) => registry.get(botId));
  const planner = new CoordinatorLocalPlanner({
    ai: { generate },
    registry: { get: plannerRegistryGet },
    // This stack intentionally uses the in-memory GoalStore below.  Bind the
    // planner's pre-acquired lease path to that fixture's exact lease tuple;
    // production Coordinator wiring uses PostgreSQL authority instead.
    verifyAssignmentLease: async ({ taskId, botId, leaseOwner }) =>
      taskId.length > 0 &&
      botId === BOT_ID &&
      leaseOwner === "goal-control-api-test",
    transport: runtimeLink,
    coordinatorInstanceId: COORDINATOR_ID,
  });
  const sendSkillInvocation = vi.spyOn(runtimeLink, "sendSkillInvocation");
  const requestFreshStatus = vi.spyOn(runtimeLink, "requestFreshStatus");
  const handleCoordinatorSkillInvocation = vi.spyOn(
    host.runtime,
    "handleCoordinatorSkillInvocation",
  );
  const originalHandleSkillInvocation = host.runtime.handleSkillInvocation.bind(
    host.runtime,
  );
  let rejectedOakPlanks = false;
  let snapshotsAtRejection = 0;
  const handleSkillInvocation = vi.spyOn(
    host.runtime,
    "handleSkillInvocation",
  );
  if (options.rejectOakPlanksOnce === true) {
    handleSkillInvocation.mockImplementation(
      async (input, authorization, externalSignal) => {
        const invocation = skillInvocationV1Schema.parse(input);
        if (
          invocation.payload.skillId === "craft.item" &&
          inputField(invocation.payload.input, "itemName") === "oak_planks"
        ) {
          if (!rejectedOakPlanks) {
            rejectedOakPlanks = true;
            snapshotsAtRejection = client.snapshotCalls;
          }
          if (client.snapshotCalls <= snapshotsAtRejection) {
            return rejectedSkillResult(
              invocation,
              host.runtime.getRuntimeInstanceId(),
            );
          }
        }
        return originalHandleSkillInvocation(
          input,
          authorization,
          externalSignal,
        );
      },
    );
  }

  const controlLink = new ControlLinkServer({
    host: "127.0.0.1",
    port: 0,
    instanceId: COORDINATOR_ID,
    clients: [
      {
        clientId: CONTROL_CLIENT_ID,
        keyId: CONTROL_KEY_ID,
        secretSha256: sha256(CONTROL_SECRET),
        capabilities: ["bot.read", "bot.stop", "goal.submit"],
      },
    ],
    registry,
    stopController: {
      requestStop: async () => {
        throw new Error("stop_not_expected");
      },
    },
    goalPlanner: planner,
    goalStore: inMemoryGoalStore(),
    logger,
  });
  const controlAddress = await controlLink.start();
  const coordinatorLink = new CoordinatorLinkClient({
    config: {
      url: `ws://127.0.0.1:${controlAddress.port}/v1/control-link`,
      clientId: CONTROL_CLIENT_ID,
      keyId: CONTROL_KEY_ID,
      secret: CONTROL_SECRET,
      handshakeTimeoutMs: 5_000,
      livenessTimeoutMs: 30_000,
      stopTimeoutMs: 5_000,
      reconnect: { baseDelayMs: 250, maxDelayMs: 250 },
      maxPendingStops: 16,
      maxSocketBufferedBytes: 256 * 1_024,
    },
    instanceId: "control-api-goal-e2e-instance",
    logger,
  });
  await coordinatorLink.start();

  const api = new ControlApiServer({
    host: "127.0.0.1",
    port: 0,
    registry: coordinatorLink,
    goalController: coordinatorLink,
    principals: [
      {
        subject: "operator-goal-e2e",
        tokenSha256: sha256(OPERATOR_TOKEN),
        permissions: ["bot.read", "goal.submit"],
      },
    ],
    logger,
    staleSweepIntervalMs: 30_000,
    webSocketPingIntervalMs: 30_000,
  });
  const apiAddress = await api.start();

  let closed = false;
  const stack: RunningStack = {
    baseUrl: `http://127.0.0.1:${apiAddress.port}`,
    client,
    sendSkillInvocation,
    requestFreshStatus,
    handleCoordinatorSkillInvocation,
    handleSkillInvocation,
    plannerRegistryGet,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled([
        api.stop(),
        coordinatorLink.close(),
        controlLink.stop(),
        host.stop("integration_test_cleanup"),
        runtimeLink.stop(),
      ]);
      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (rejected) throw rejected.reason;
    },
  };
  runningStacks.push(stack);
  return stack;
}

function inMemoryGoalStore(): GoalLifecycleStore {
  const requests = new Map<string, Parameters<GoalLifecycleStore["begin"]>[0]>();
  const snapshots = new Map<string, GoalLifecycleSnapshot>();
  const snapshot = (
    request: Parameters<GoalLifecycleStore["begin"]>[0],
    status: GoalLifecycleSnapshot["status"],
    result: GoalLifecycleSnapshot["result"],
    errorCode: GoalLifecycleSnapshot["errorCode"],
  ): GoalLifecycleSnapshot => {
    const now = new Date().toISOString();
    return {
      operationId: request.payload.operationId,
      taskId: request.payload.taskId,
      botId: request.payload.botId,
      fingerprint: durableGoalFingerprint(request),
      title: "Submitted goal",
      status,
      startedAt: now,
      updatedAt: now,
      result,
      errorCode,
    };
  };

  return {
    initialize: async () => [],
    refresh: async () => [...snapshots.values()],
    begin: async (request) => {
      requests.set(request.payload.taskId, request);
      const running = snapshot(request, "running", null, null);
      snapshots.set(request.payload.operationId, running);
      return {
        kind: "execute",
        lease: {
          taskId: request.payload.taskId,
          leaseOwner: "goal-control-api-test",
          revision: 2,
        },
        snapshot: running,
      };
    },
    recordResult: async (lease, result) => {
      const request = requests.get(lease.taskId);
      if (!request) throw new Error("goal_test_request_missing");
      const status =
        result.action === "noop"
          ? "failed"
          : result.outcome === "completed"
            ? "completed"
            : result.outcome === "cancelled"
              ? "cancelled"
              : result.outcome === "timed_out"
                ? "expired"
                : "failed";
      const terminal = snapshot(request, status, result, null);
      snapshots.set(request.payload.operationId, terminal);
      return terminal;
    },
    recordError: async (lease, errorCode, status) => {
      const request = requests.get(lease.taskId);
      if (!request) throw new Error("goal_test_request_missing");
      const terminal = snapshot(request, status, null, errorCode);
      snapshots.set(request.payload.operationId, terminal);
      return terminal;
    },
  };
}

function assertInvocationChain(
  stack: RunningStack,
  expectedCalls: number,
  expectedCapabilityCalls = expectedCalls,
): void {
  expect(expectedCalls).toBeGreaterThan(1);
  expect(stack.sendSkillInvocation).toHaveBeenCalledTimes(expectedCalls);
  expect(stack.handleCoordinatorSkillInvocation).toHaveBeenCalledTimes(
    expectedCalls,
  );
  expect(stack.handleSkillInvocation).toHaveBeenCalledTimes(expectedCalls);
  expect(stack.client.capabilityCalls).toHaveLength(expectedCapabilityCalls);

  const invocations = stack.sendSkillInvocation.mock.calls.map(
    ([invocation]) => invocation,
  );
  expect(new Set(invocations.map(({ payload }) => payload.invocationId)).size).toBe(
    expectedCalls,
  );
  expect(new Set(invocations.map(({ payload }) => payload.authorization.decisionId)).size)
    .toBe(expectedCalls);

  invocations.forEach((invocation, index) => {
    const runtimeInvocation = stack.handleSkillInvocation.mock.calls[index]?.[0];
    const authorization = stack.handleSkillInvocation.mock.calls[index]?.[1];
    expect(runtimeInvocation).toEqual(invocation);
    expect(authorization).toBeDefined();
    expect(authorization).toMatchObject({
      decisionId: invocation.payload.authorization.decisionId,
      actorId: invocation.payload.authorization.actorId,
      sourceInstanceId: invocation.source.instanceId,
      traceId: invocation.traceId,
      taskId: invocation.taskId,
      botId: invocation.botId,
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      issuedAt: invocation.payload.authorization.issuedAt,
      expiresAt: invocation.payload.authorization.expiresAt,
    });
    expect([...authorization!.allowedCapabilities]).toEqual(
      invocation.payload.skillId === "collect.block"
        ? ["world.interact"]
        : ["craft.execute"],
    );
  });
}

class GoalExecutionClient implements BotClient {
  private handlers: BotClientHandlers | null = null;
  private oakPlankFailures = 0;
  readonly capabilityCalls: Parameters<
    NonNullable<BotClient["invokeSkillCapability"]>
  >[0][] = [];
  snapshotCalls = 0;

  constructor(
    private readonly options: Readonly<{
      failOakPlanksOnce: boolean;
      partialOakPlanksOnce: boolean;
    }>,
  ) {}

  setHandlers(handlers: BotClientHandlers): void {
    this.handlers = handlers;
  }

  snapshot(): BotClientSnapshot {
    this.snapshotCalls += 1;
    return {
      health: { current: 20, maximum: 20 },
      food: { level: 20, saturation: 5 },
      armorPoints: 0,
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      latencyMs: 1,
      safety: {
        oxygenLevel: 20,
        inWater: false,
        inLava: false,
        onGround: true,
        velocityY: 0,
        inventory: { usedSlots: 0, totalSlots: 36 },
        hasSafeFood: true,
        movementRequested: false,
      },
    };
  }

  async executeSafetyAction() {
    return { outcome: "executed" as const, errorCode: null };
  }

  async invokeSkillCapability(
    request: Parameters<NonNullable<BotClient["invokeSkillCapability"]>>[0],
  ): Promise<unknown> {
    this.capabilityCalls.push(request);
    const itemName = inputField(request.input, "itemName");
    if (
      this.options.failOakPlanksOnce &&
      request.skillId === "craft.item" &&
      itemName === "oak_planks" &&
      this.oakPlankFailures === 0
    ) {
      this.oakPlankFailures += 1;
      throw new Error("injected_transient_capability_failure");
    }
    if (request.skillId === "collect.block") {
      const blockName = inputField(request.input, "blockName");
      const maxCount = inputField(request.input, "maxCount");
      return {
        blockName,
        targetsFound: maxCount,
        itemsCollected: maxCount,
      };
    }
    if (request.skillId === "craft.item") {
      const requestedCount = inputField(request.input, "count");
      const partial =
        this.options.partialOakPlanksOnce &&
        itemName === "oak_planks" &&
        this.oakPlankFailures === 0;
      if (partial) this.oakPlankFailures += 1;
      return {
        itemName,
        requestedCount,
        craftedCount: partial
          ? 1
          : itemName === "oak_planks"
            ? Number(requestedCount) * 4
            : requestedCount,
        usedCraftingTable:
          inputField(request.input, "craftingTable") !== null,
      };
    }
    throw new Error(`unexpected_skill:${request.skillId}`);
  }

  versionCompatibility() {
    return {
      selection: "fixed" as const,
      requestedVersion: "1.21.8",
      resolvedVersion: "1.21.8",
      protocolVersion: 772,
      majorVersion: "1.21",
      supportLevel: "tested" as const,
      supportedRange: { oldest: "1.8.8", latest: "1.21.11" },
    };
  }

  skillCompatibilityEnvironment() {
    return {
      minecraftVersion: "1.21.8",
      protocolVersion: 772,
      supportsFeature: (_name: string) => false,
      hasResource: (_kind: "item" | "block" | "entity", _name: string) => false,
      serverCapability: (_name: string) => undefined,
    };
  }

  async close(): Promise<void> {
    this.handlers?.onDisconnected({
      reason: "requested_stop",
      expected: true,
    });
  }

  spawn(): void {
    this.handlers?.onSpawn();
  }
}

function capabilitySteps(
  calls: readonly GoalExecutionClient["capabilityCalls"][number][],
): string[] {
  return calls.map((request) => {
    const resource =
      request.skillId === "collect.block"
        ? inputField(request.input, "blockName")
        : inputField(request.input, "itemName");
    return `${request.skillId}:${String(resource)}`;
  });
}

function invocationSteps(
  calls: readonly (readonly [SkillInvocationV1, ...unknown[]])[],
): string[] {
  return calls.map(([invocation]) => {
    const resource =
      invocation.payload.skillId === "collect.block"
        ? inputField(invocation.payload.input, "blockName")
        : inputField(invocation.payload.input, "itemName");
    return `${invocation.payload.skillId}:${String(resource)}`;
  });
}

function rejectedSkillResult(
  invocation: SkillInvocationV1,
  runtimeInstanceId: string,
): SkillExecutionResultV1 {
  return skillExecutionResultV1Schema.parse({
    schemaVersion: "1.0",
    messageId: testUuid(980),
    traceId: invocation.traceId,
    timestamp: new Date().toISOString(),
    source: { service: "bot-runtime", instanceId: runtimeInstanceId },
    botId: invocation.botId,
    taskId: invocation.taskId,
    type: "skill.result.v1",
    payload: {
      invocationId: invocation.payload.invocationId,
      skillId: invocation.payload.skillId,
      skillVersion: invocation.payload.skillVersion,
      completedAt: new Date().toISOString(),
      outcome: "rejected",
      attempts: 0,
      errorCode: "SKILL_PRECONDITION_FAILED",
    },
  });
}

function inputField(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  return (input as Record<string, unknown>)[key];
}

function submitCraftingTableGoal(
  baseUrl: string,
  requestId: string,
): Promise<Response> {
  return fetch(`${baseUrl}/v1/goals`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPERATOR_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      schemaVersion: "1.0",
      requestId,
      botId: BOT_ID,
      operatorGoal: "Craft one crafting_table from nearby resources.",
      timeoutMs: 30_000,
    }),
  });
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function testUuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

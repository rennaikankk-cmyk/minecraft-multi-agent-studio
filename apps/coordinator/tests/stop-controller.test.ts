import type {
  BotStopResultV1,
  ControlPermission,
  StopBotCommandV1,
} from "@minecraft-studio/protocol";
import {
  createStructuredLogger,
  type AppLogger,
  type StructuredLogRecord,
} from "@minecraft-studio/observability";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  BotRegistry,
  CoordinatorStopError,
  InMemoryStopAuditSink,
  StopController,
  type StopBotRequest,
  type StopCommandTransport,
} from "../src/index.js";

const NOW = new Date("2026-07-20T03:00:00.000Z");
const COMMAND_ID = "22222222-2222-4222-8222-222222222222";
const DECISION_ID = "33333333-3333-4333-8333-333333333333";
const RESULT_ID = "44444444-4444-4444-8444-444444444444";
const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";

function onlineRegistry(): BotRegistry {
  const registry = new BotRegistry({ staleAfterMs: 5_000, now: () => NOW });
  registry.ingest(
    {
      schemaVersion: "1.0",
      messageId: MESSAGE_ID,
      traceId: "trace-stop",
      timestamp: NOW.toISOString(),
      source: { service: "bot-runtime", instanceId: "runtime-a" },
      botId: "worker-01",
      type: "bot.heartbeat.v1",
      payload: {
        serverProfileId: "isolated-test",
        runtimeInstanceId: "runtime-a",
        sequence: 1,
        observedAt: NOW.toISOString(),
        connectionState: "online",
        uptimeMs: 1_000,
        lastStatusSequence: null,
        currentTaskId: null,
      },
    },
    NOW,
  );
  return registry;
}

function request(
  permissions: ReadonlySet<ControlPermission> = new Set(["bot.stop"]),
): StopBotRequest {
  return {
    commandId: COMMAND_ID,
    traceId: "trace-stop",
    botId: "worker-01",
    mode: "graceful",
    reason: "Operator confirmed a safe stop.",
    gracePeriodMs: 1_000,
    timeoutMs: 2_000,
    authorization: {
      decisionId: DECISION_ID,
      actorId: "operator-01",
      permissions,
      issuedAt: new Date(NOW.getTime() - 1_000),
      expiresAt: new Date(NOW.getTime() + 10_000),
    },
  };
}

function confirmation(command: StopBotCommandV1): BotStopResultV1 {
  return {
    schemaVersion: "1.0",
    messageId: RESULT_ID,
    traceId: command.traceId,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: "runtime-a" },
    botId: command.botId,
    type: "bot.stop.result.v1",
    payload: {
      commandId: command.payload.commandId,
      runtimeInstanceId: "runtime-a",
      outcome: "completed",
      completedAt: NOW.toISOString(),
    },
  };
}

function controller(
  registry: BotRegistry,
  transport: StopCommandTransport,
  auditSink = new InMemoryStopAuditSink(),
  logger?: AppLogger,
) {
  return {
    auditSink,
    value: new StopController({
      instanceId: "coordinator-01",
      registry,
      transport,
      auditSink,
      logger,
      now: () => NOW,
      randomId: () => MESSAGE_ID,
    }),
  };
}

describe("StopController", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("dispatches one authorized command, records audit, and confirms offline", async () => {
    const registry = onlineRegistry();
    const records: StructuredLogRecord[] = [];
    const operationLogger = createStructuredLogger({
      service: "coordinator",
      instanceId: "coordinator-01",
      now: () => NOW,
      sink: (record) => records.push(record),
    });
    const sendStopCommand = vi.fn(
      async (command: StopBotCommandV1) => confirmation(command),
    );
    const { value, auditSink } = controller(
      registry,
      { sendStopCommand },
      new InMemoryStopAuditSink(),
      operationLogger,
    );

    const first = value.requestStop(request());
    const second = value.requestStop(request());
    const result = await first;

    expect(second).toBe(first);
    expect(await second).toEqual(result);
    expect(sendStopCommand).toHaveBeenCalledTimes(1);
    expect(result.payload.outcome).toBe("completed");
    expect(registry.get("worker-01", NOW)?.connectionState).toBe("offline");
    expect(auditSink.entries().map(({ status }) => status)).toEqual([
      "started",
      "completed",
    ]);
    expect(records.map(({ status }) => status)).toEqual(["started", "completed"]);
    expect(records).toEqual([
      expect.objectContaining({
        event: "coordinator_stop_audit",
        traceId: "trace-stop",
        botId: "worker-01",
        taskId: null,
        skillId: null,
        modelName: null,
      }),
      expect.objectContaining({
        event: "coordinator_stop_audit",
        traceId: "trace-stop",
        status: "completed",
      }),
    ]);
  });

  it("rejects missing trusted permission before transport dispatch", async () => {
    const registry = onlineRegistry();
    const sendStopCommand = vi.fn();
    const { value, auditSink } = controller(registry, { sendStopCommand });

    await expect(value.requestStop(request(new Set()))).rejects.toMatchObject({
      code: "AUTHORIZATION_REJECTED",
    });
    expect(sendStopCommand).not.toHaveBeenCalled();
    expect(auditSink.entries()).toEqual([
      expect.objectContaining({ status: "rejected", errorCode: "AUTHORIZATION_REJECTED" }),
    ]);
  });

  it("times out, aborts transport, and records an uncertain outcome", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const registry = onlineRegistry();
    let signal: AbortSignal | undefined;
    const sendStopCommand = vi.fn(
      async (
        _command: StopBotCommandV1,
        _context: unknown,
        receivedSignal: AbortSignal,
      ) => {
        signal = receivedSignal;
        return new Promise<never>(() => undefined);
      },
    );
    const { value, auditSink } = controller(registry, { sendStopCommand });
    const pending = value.requestStop(request());
    const rejection = expect(pending).rejects.toMatchObject<
      Partial<CoordinatorStopError>
    >({ code: "STOP_TIMEOUT" });

    await vi.advanceTimersByTimeAsync(2_000);
    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(auditSink.entries().at(-1)).toMatchObject({
      status: "timed_out",
      errorCode: "STOP_TIMEOUT",
    });
  });

  it("rejects a mismatched confirmation and conflicting command reuse", async () => {
    const registry = onlineRegistry();
    const sendStopCommand = vi.fn(async (command: StopBotCommandV1) => ({
      ...confirmation(command),
      botId: "different-bot",
    }));
    const { value } = controller(registry, { sendStopCommand });

    await expect(value.requestStop(request())).rejects.toMatchObject({
      code: "STOP_CONFIRMATION_INVALID",
    });
    expect(() =>
      value.requestStop({ ...request(), reason: "A different operation." }),
    ).toThrowError(expect.objectContaining({ code: "COMMAND_ID_CONFLICT" }));
  });

  it("refuses a stale Bot because it cannot confirm execution", async () => {
    const registry = onlineRegistry();
    registry.sweepStale(new Date(NOW.getTime() + 5_001));
    const sendStopCommand = vi.fn();
    const { value } = controller(registry, { sendStopCommand });

    await expect(value.requestStop(request())).rejects.toMatchObject({
      code: "BOT_NOT_STOPPABLE",
    });
    expect(sendStopCommand).not.toHaveBeenCalled();
  });
});

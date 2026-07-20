import { randomUUID } from "node:crypto";

import {
  parseBotProtocolMessage,
  parseBotStopResult,
  stopBotCommandV1Schema,
  type BotStopResultV1,
  type ControlAuthorizationContext,
  type ControlPermission,
  type StopBotCommandV1,
} from "@minecraft-studio/protocol";

import { BotRegistry } from "./bot-registry.js";

export type StopAuthorization = Readonly<{
  decisionId: string;
  actorId: string;
  permissions: ReadonlySet<ControlPermission>;
  issuedAt: Date;
  expiresAt: Date;
}>;

export type StopBotRequest = Readonly<{
  commandId: string;
  traceId: string;
  botId: string;
  mode: "graceful" | "emergency";
  reason: string;
  gracePeriodMs: number;
  timeoutMs: number;
  authorization: StopAuthorization;
}>;

export type StopCommandTransport = Readonly<{
  sendStopCommand(
    command: StopBotCommandV1,
    authorizationContext: ControlAuthorizationContext,
    signal: AbortSignal,
  ): Promise<unknown>;
}>;

export type StopAuditStatus =
  | "started"
  | "completed"
  | "rejected"
  | "failed"
  | "timed_out";

export type StopAuditEntry = Readonly<{
  recordedAt: string;
  traceId: string;
  commandId: string;
  decisionId: string;
  actorId: string;
  botId: string;
  runtimeInstanceId: string | null;
  mode: "graceful" | "emergency";
  status: StopAuditStatus;
  errorCode?: string;
}>;

export type StopAuditSink = Readonly<{
  write(entry: StopAuditEntry): Promise<void> | void;
}>;

export class InMemoryStopAuditSink implements StopAuditSink {
  private readonly values: StopAuditEntry[] = [];

  write(entry: StopAuditEntry): void {
    this.values.push(structuredClone(entry));
  }

  entries(): StopAuditEntry[] {
    return structuredClone(this.values);
  }
}

export type CoordinatorStopErrorCode =
  | "REQUEST_INVALID"
  | "COMMAND_ID_CONFLICT"
  | "BOT_NOT_FOUND"
  | "BOT_NOT_STOPPABLE"
  | "AUTHORIZATION_REJECTED"
  | "AUDIT_WRITE_FAILED"
  | "STOP_TIMEOUT"
  | "STOP_TRANSPORT_FAILED"
  | "STOP_CONFIRMATION_INVALID";

export class CoordinatorStopError extends Error {
  readonly code: CoordinatorStopErrorCode;

  constructor(code: CoordinatorStopErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "CoordinatorStopError";
    this.code = code;
  }
}

export type StopControllerOptions = Readonly<{
  instanceId: string;
  registry: BotRegistry;
  transport: StopCommandTransport;
  auditSink: StopAuditSink;
  now?: () => Date;
  randomId?: () => string;
  maxRememberedCommands?: number;
}>;

type StopExecution = {
  fingerprint: string;
  result: Promise<BotStopResultV1>;
};

export class StopController {
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly maxRememberedCommands: number;
  private readonly executions = new Map<string, StopExecution>();

  constructor(private readonly options: StopControllerOptions) {
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? randomUUID;
    this.maxRememberedCommands = positiveInteger(
      options.maxRememberedCommands ?? 1_000,
      "maxRememberedCommands",
    );
  }

  requestStop(request: StopBotRequest): Promise<BotStopResultV1> {
    const fingerprint = requestFingerprint(request);
    const existing = this.executions.get(request.commandId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CoordinatorStopError(
          "COMMAND_ID_CONFLICT",
          "The command ID was already used with different stop parameters.",
        );
      }
      return existing.result;
    }

    const result = this.execute(request);
    this.executions.set(request.commandId, { fingerprint, result });
    void result.then(
      () => this.trimExecutions(),
      () => this.trimExecutions(),
    );
    return result;
  }

  private async execute(request: StopBotRequest): Promise<BotStopResultV1> {
    const requestedAt = validDate(this.now(), "REQUEST_INVALID");
    const record = this.options.registry.get(request.botId, requestedAt);
    const runtimeInstanceId = record?.runtimeInstanceId ?? null;

    if (!record) {
      await this.writeAudit(request, null, "rejected", "BOT_NOT_FOUND");
      throw new CoordinatorStopError("BOT_NOT_FOUND", "The target Bot is unknown.");
    }
    if (record.connectionState === "offline" || record.connectionState === "stale") {
      await this.writeAudit(
        request,
        runtimeInstanceId,
        "rejected",
        "BOT_NOT_STOPPABLE",
      );
      throw new CoordinatorStopError(
        "BOT_NOT_STOPPABLE",
        "The target Bot is offline or stale and cannot confirm a stop.",
      );
    }

    const timeoutMs = boundedInteger(request.timeoutMs, 1, 60_000, "timeoutMs");
    boundedInteger(request.gracePeriodMs, 0, 60_000, "gracePeriodMs");
    const authorizationIssuedAt = validDate(
      request.authorization.issuedAt,
      "AUTHORIZATION_REJECTED",
    );
    const authorizationExpiresAt = validDate(
      request.authorization.expiresAt,
      "AUTHORIZATION_REJECTED",
    );
    const expiresAt = new Date(requestedAt.getTime() + timeoutMs);
    const requiredPermission: ControlPermission =
      request.mode === "emergency" ? "bot.emergency-stop" : "bot.stop";

    let command: StopBotCommandV1;
    let authorizationContext: ControlAuthorizationContext;
    try {
      command = stopBotCommandV1Schema.parse({
        schemaVersion: "1.0",
        messageId: this.randomId(),
        traceId: request.traceId,
        timestamp: requestedAt.toISOString(),
        source: { service: "coordinator", instanceId: this.options.instanceId },
        botId: request.botId,
        type: "bot.stop.command.v1",
        payload: {
          commandId: request.commandId,
          mode: request.mode,
          reason: request.reason,
          requestedAt: requestedAt.toISOString(),
          expiresAt: expiresAt.toISOString(),
          gracePeriodMs: request.gracePeriodMs,
          expectedRuntimeInstanceId: runtimeInstanceId,
          authorization: {
            decisionId: request.authorization.decisionId,
            actorId: request.authorization.actorId,
            permission: requiredPermission,
            issuedAt: authorizationIssuedAt.toISOString(),
            expiresAt: authorizationExpiresAt.toISOString(),
          },
        },
      });
      authorizationContext = {
        decisionId: request.authorization.decisionId,
        actorId: request.authorization.actorId,
        botId: request.botId,
        commandId: request.commandId,
        permissions: request.authorization.permissions,
        now: requestedAt,
      };
      const parsed = parseBotProtocolMessage(command, authorizationContext);
      if (parsed.type !== "bot.stop.command.v1") {
        throw new Error("Unexpected protocol message type.");
      }
    } catch (cause) {
      await this.writeAudit(
        request,
        runtimeInstanceId,
        "rejected",
        "AUTHORIZATION_REJECTED",
      );
      throw new CoordinatorStopError(
        "AUTHORIZATION_REJECTED",
        "The stop request or trusted authorization was rejected.",
        cause,
      );
    }

    await this.writeAudit(request, runtimeInstanceId, "started");
    const abortController = new AbortController();

    let rawResult: unknown;
    try {
      rawResult = await withTimeout(
        this.options.transport.sendStopCommand(
          command,
          authorizationContext,
          abortController.signal,
        ),
        timeoutMs,
        abortController,
      );
    } catch (cause) {
      const timedOut =
        cause instanceof CoordinatorStopError && cause.code === "STOP_TIMEOUT";
      await this.writeAudit(
        request,
        runtimeInstanceId,
        timedOut ? "timed_out" : "failed",
        timedOut ? "STOP_TIMEOUT" : "STOP_TRANSPORT_FAILED",
      );
      if (timedOut) throw cause;
      throw new CoordinatorStopError(
        "STOP_TRANSPORT_FAILED",
        "The Bot control transport failed before confirmation.",
        cause,
      );
    }

    let result: BotStopResultV1;
    try {
      result = parseBotStopResult(rawResult);
      if (
        result.botId !== request.botId ||
        result.traceId !== request.traceId ||
        result.payload.commandId !== request.commandId ||
        result.payload.runtimeInstanceId !== runtimeInstanceId ||
        result.source.instanceId !== runtimeInstanceId
      ) {
        throw new Error("Stop confirmation identity mismatch.");
      }
    } catch (cause) {
      await this.writeAudit(
        request,
        runtimeInstanceId,
        "failed",
        "STOP_CONFIRMATION_INVALID",
      );
      throw new CoordinatorStopError(
        "STOP_CONFIRMATION_INVALID",
        "The Bot returned an invalid or mismatched stop confirmation.",
        cause,
      );
    }

    if (result.payload.outcome === "completed") {
      this.options.registry.confirmStop(result, this.now());
    }
    await this.writeAudit(
      request,
      runtimeInstanceId,
      result.payload.outcome === "completed"
        ? "completed"
        : result.payload.outcome === "rejected"
          ? "rejected"
          : "failed",
      result.payload.errorCode,
    );
    return result;
  }

  private async writeAudit(
    request: StopBotRequest,
    runtimeInstanceId: string | null,
    status: StopAuditStatus,
    errorCode?: string,
  ): Promise<void> {
    try {
      await this.options.auditSink.write({
        recordedAt: validDate(this.now(), "REQUEST_INVALID").toISOString(),
        traceId: request.traceId,
        commandId: request.commandId,
        decisionId: request.authorization.decisionId,
        actorId: request.authorization.actorId,
        botId: request.botId,
        runtimeInstanceId,
        mode: request.mode,
        status,
        ...(errorCode ? { errorCode } : {}),
      });
    } catch (cause) {
      if (cause instanceof CoordinatorStopError) throw cause;
      throw new CoordinatorStopError(
        "AUDIT_WRITE_FAILED",
        "The stop operation was blocked because its audit record could not be written.",
        cause,
      );
    }
  }

  private trimExecutions(): void {
    while (this.executions.size > this.maxRememberedCommands) {
      const oldest = this.executions.keys().next().value as string | undefined;
      if (!oldest) return;
      this.executions.delete(oldest);
    }
  }
}

function requestFingerprint(request: StopBotRequest): string {
  try {
    return JSON.stringify({
      commandId: request.commandId,
      traceId: request.traceId,
      botId: request.botId,
      mode: request.mode,
      reason: request.reason,
      gracePeriodMs: request.gracePeriodMs,
      timeoutMs: request.timeoutMs,
      authorization: {
        decisionId: request.authorization.decisionId,
        actorId: request.authorization.actorId,
        permissions: [...request.authorization.permissions].sort(),
        issuedAt: request.authorization.issuedAt.toISOString(),
        expiresAt: request.authorization.expiresAt.toISOString(),
      },
    });
  } catch (cause) {
    throw new CoordinatorStopError(
      "REQUEST_INVALID",
      "The stop request contains invalid values.",
      cause,
    );
  }
}

function validDate(value: Date, code: CoordinatorStopErrorCode): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new CoordinatorStopError(code, "The stop request contains an invalid time.");
  }
  return value;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CoordinatorStopError(
      "REQUEST_INVALID",
      `${name} is outside the allowed range.`,
    );
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  return boundedInteger(value, 1, Number.MAX_SAFE_INTEGER, name);
}

function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  abortController: AbortController,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abortController.abort();
      reject(
        new CoordinatorStopError(
          "STOP_TIMEOUT",
          "The Bot did not confirm the stop before the deadline.",
        ),
      );
    }, timeoutMs);

    void operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

import { randomUUID } from "node:crypto";

import {
  identifierSchema,
  skillCapabilitySchema,
  skillErrorCodeSchema,
  skillExecutionResultV1Schema,
  skillInvocationV1Schema,
  skillJsonValueSchema,
  skillOperationSchema,
  type SkillCapability,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
  type SkillJsonValue,
} from "@minecraft-studio/protocol";

import { SkillAbortError, SkillFault, SkillFrameworkError } from "./errors.js";
import { SkillRegistry } from "./registry.js";
import type {
  SkillCompatibilityEnvironment,
  SkillExecutionAuthorization,
  SkillExecutionContext,
  SkillExecutorOptions,
} from "./types.js";

const JITTER_RATIO = 0.2;

function isAbortError(error: unknown): error is SkillAbortError {
  return error instanceof SkillAbortError;
}

function abortReason(signal: AbortSignal): SkillAbortError {
  return signal.reason instanceof SkillAbortError
    ? signal.reason
    : new SkillAbortError("SKILL_CANCELLED");
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function sleep(delayMs: number, signal: AbortSignal): Promise<void> {
  return raceWithAbort(
    new Promise<void>((resolve) => {
      setTimeout(resolve, delayMs);
    }),
    signal,
  );
}

export class SkillExecutor {
  private readonly runtimeInstanceId: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly messageId: () => string;

  constructor(
    private readonly registry: SkillRegistry,
    private readonly options: SkillExecutorOptions,
  ) {
    this.runtimeInstanceId = identifierSchema.parse(options.runtimeInstanceId);
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
    this.messageId = options.messageId ?? randomUUID;
  }

  async execute(
    input: unknown,
    authorization: SkillExecutionAuthorization,
    state: unknown,
    externalSignal?: AbortSignal,
    compatibilityEnvironment: SkillCompatibilityEnvironment | null = null,
  ): Promise<SkillExecutionResultV1> {
    const parsed = skillInvocationV1Schema.safeParse(input);
    if (!parsed.success) {
      throw new SkillFrameworkError(
        "INVALID_SKILL_INVOCATION",
        "Skill invocation failed strict protocol validation.",
      );
    }
    const invocation = parsed.data;
    const definition = this.registry.resolve(
      invocation.payload.skillId,
      invocation.payload.skillVersion,
    );
    if (!definition) {
      return this.result(invocation, "rejected", 0, undefined, "SKILL_NOT_FOUND");
    }

    const authorizationError = this.validateAuthorization(
      invocation,
      authorization,
      definition.requiredCapabilities,
    );
    if (authorizationError) {
      return this.result(invocation, "rejected", 0, undefined, authorizationError);
    }

    const compatibility = this.registry.resolveCompatibility(
      definition.id,
      definition.version,
      compatibilityEnvironment,
    );
    if (!compatibility || compatibility.availability === "unavailable") {
      return this.result(
        invocation,
        "rejected",
        0,
        undefined,
        "SKILL_VERSION_UNAVAILABLE",
      );
    }

    const parsedInput = definition.inputSchema.safeParse(invocation.payload.input);
    if (!parsedInput.success) {
      return this.result(
        invocation,
        "rejected",
        0,
        undefined,
        "SKILL_INPUT_INVALID",
      );
    }
    const parsedState = definition.stateSchema.safeParse(state);
    if (!parsedState.success) {
      return this.result(
        invocation,
        "rejected",
        0,
        undefined,
        "SKILL_STATE_INVALID",
      );
    }

    for (const precondition of definition.preconditions) {
      try {
        const met = precondition.check(parsedInput.data, parsedState.data);
        if (typeof met !== "boolean") {
          return this.result(
            invocation,
            "rejected",
            0,
            undefined,
            "SKILL_PRECONDITION_EVALUATION_FAILED",
          );
        }
        if (!met) {
          return this.result(
            invocation,
            "rejected",
            0,
            undefined,
            precondition.failureCode,
          );
        }
      } catch {
        return this.result(
          invocation,
          "rejected",
          0,
          undefined,
          "SKILL_PRECONDITION_EVALUATION_FAILED",
        );
      }
    }

    const controller = new AbortController();
    const startedAtMs = this.now().getTime();
    const deadlineMs = startedAtMs + definition.timeoutMs;
    const timeout = setTimeout(
      () => controller.abort(new SkillAbortError("SKILL_TIMEOUT")),
      definition.timeoutMs,
    );
    const onExternalAbort = () =>
      controller.abort(new SkillAbortError("SKILL_CANCELLED"));
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
    if (externalSignal?.aborted) onExternalAbort();

    let active = true;
    let attempts = 0;
    try {
      const context: SkillExecutionContext = Object.freeze({
        invocationId: invocation.payload.invocationId,
        traceId: invocation.traceId,
        taskId: invocation.taskId,
        botId: invocation.botId,
        signal: controller.signal,
        deadlineMs,
        compatibility: Object.freeze({
          minecraftVersion: compatibility.minecraftVersion,
          protocolVersion: compatibility.protocolVersion,
          variantId: compatibility.selectedVariantId!,
          verification: compatibility.verification,
        }),
        callCapability: async <TOutput extends SkillJsonValue = SkillJsonValue>(
          capability: SkillCapability,
          operation: string,
          capabilityInput: SkillJsonValue,
        ): Promise<TOutput> => {
          if (!active || controller.signal.aborted) {
            throw abortReason(controller.signal);
          }
          const parsedCapability = skillCapabilitySchema.safeParse(capability);
          const parsedOperation = skillOperationSchema.safeParse(operation);
          const parsedCapabilityInput = skillJsonValueSchema.safeParse(capabilityInput);
          if (!parsedCapability.success || !parsedOperation.success) {
            throw new SkillFault("SKILL_CAPABILITY_REQUEST_INVALID");
          }
          if (!definition.requiredCapabilities.includes(parsedCapability.data)) {
            throw new SkillFault("SKILL_CAPABILITY_UNDECLARED");
          }
          if (!authorization.allowedCapabilities.has(parsedCapability.data)) {
            throw new SkillFault("SKILL_CAPABILITY_DENIED");
          }
          if (!parsedCapabilityInput.success) {
            throw new SkillFault("SKILL_CAPABILITY_INPUT_INVALID");
          }
          if (!this.options.capabilityAdapter) {
            throw new SkillFault("SKILL_CAPABILITY_UNAVAILABLE");
          }
          let adapterOutput: unknown;
          try {
            adapterOutput = await raceWithAbort(
              this.options.capabilityAdapter.invoke({
                invocationId: invocation.payload.invocationId,
                traceId: invocation.traceId,
                taskId: invocation.taskId,
                botId: invocation.botId,
                skillId: definition.id,
                skillVersion: definition.version,
                capability: parsedCapability.data,
                operation: parsedOperation.data,
                input: parsedCapabilityInput.data,
                signal: controller.signal,
              }),
              controller.signal,
            );
          } catch (error) {
            if (error instanceof SkillFault) throw error;
            throw new SkillFault("SKILL_CAPABILITY_FAILED");
          }
          const parsedOutput = skillJsonValueSchema.safeParse(adapterOutput);
          if (!parsedOutput.success) {
            throw new SkillFault("SKILL_CAPABILITY_OUTPUT_INVALID");
          }
          return parsedOutput.data as TOutput;
        },
      });

      while (attempts < definition.retryPolicy.maxAttempts) {
        attempts += 1;
        try {
          const output = await raceWithAbort(
            definition.execute(context, parsedInput.data, parsedState.data),
            controller.signal,
          );
          const parsedOutput = definition.outputSchema.safeParse(output);
          if (!parsedOutput.success) {
            return this.result(
              invocation,
              "failed",
              attempts,
              undefined,
              "SKILL_OUTPUT_INVALID",
            );
          }
          const jsonOutput = skillJsonValueSchema.safeParse(parsedOutput.data);
          if (!jsonOutput.success) {
            return this.result(
              invocation,
              "failed",
              attempts,
              undefined,
              "SKILL_OUTPUT_NOT_SERIALIZABLE",
            );
          }
          return this.result(
            invocation,
            "completed",
            attempts,
            jsonOutput.data,
          );
        } catch (error) {
          if (isAbortError(error)) {
            return this.result(
              invocation,
              error.code === "SKILL_TIMEOUT" ? "timed_out" : "cancelled",
              attempts,
              undefined,
              error.code,
            );
          }
          const errorCode =
            error instanceof SkillFault ? error.code : "SKILL_HANDLER_FAILED";
          const mayRetry =
            attempts < definition.retryPolicy.maxAttempts &&
            definition.retryPolicy.retryableErrorCodes.includes(errorCode);
          if (!mayRetry) {
            return this.result(
              invocation,
              "failed",
              attempts,
              undefined,
              errorCode,
            );
          }
          const exponential = Math.min(
            definition.retryPolicy.maxDelayMs,
            definition.retryPolicy.baseDelayMs * 2 ** (attempts - 1),
          );
          const randomValue = this.random();
          const boundedRandom =
            Number.isFinite(randomValue) && randomValue >= 0 && randomValue <= 1
              ? randomValue
              : 0;
          const delayMs = Math.min(
            definition.retryPolicy.maxDelayMs,
            Math.round(exponential * (1 + JITTER_RATIO * boundedRandom)),
          );
          try {
            await sleep(delayMs, controller.signal);
          } catch (delayError) {
            const abort = isAbortError(delayError)
              ? delayError
              : new SkillAbortError("SKILL_CANCELLED");
            return this.result(
              invocation,
              abort.code === "SKILL_TIMEOUT" ? "timed_out" : "cancelled",
              attempts,
              undefined,
              abort.code,
            );
          }
        }
      }
      return this.result(
        invocation,
        "failed",
        attempts,
        undefined,
        "SKILL_HANDLER_FAILED",
      );
    } finally {
      active = false;
      clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }
  }

  private validateAuthorization(
    invocation: SkillInvocationV1,
    authorization: SkillExecutionAuthorization,
    requiredCapabilities: readonly SkillCapability[],
  ): string | null {
    if (!authorization || !(authorization.allowedCapabilities instanceof Set)) {
      return "SKILL_AUTH_CONTEXT_INVALID";
    }
    const reference = invocation.payload.authorization;
    const exactMatches =
      authorization.decisionId === reference.decisionId &&
      authorization.actorId === reference.actorId &&
      authorization.sourceInstanceId === invocation.source.instanceId &&
      authorization.traceId === invocation.traceId &&
      authorization.taskId === invocation.taskId &&
      authorization.botId === invocation.botId &&
      authorization.invocationId === invocation.payload.invocationId &&
      authorization.skillId === invocation.payload.skillId &&
      authorization.skillVersion === invocation.payload.skillVersion &&
      authorization.issuedAt === reference.issuedAt &&
      authorization.expiresAt === reference.expiresAt;
    if (!exactMatches) return "SKILL_AUTH_MISMATCH";
    for (const capability of authorization.allowedCapabilities) {
      if (!skillCapabilitySchema.safeParse(capability).success) {
        return "SKILL_AUTH_CONTEXT_INVALID";
      }
    }
    const now = this.now().getTime();
    if (
      !Number.isFinite(now) ||
      now > Date.parse(invocation.payload.expiresAt) ||
      now > Date.parse(authorization.expiresAt)
    ) {
      return "SKILL_AUTH_EXPIRED";
    }
    if (
      requiredCapabilities.some(
        (capability) => !authorization.allowedCapabilities.has(capability),
      )
    ) {
      return "SKILL_CAPABILITY_DENIED";
    }
    return null;
  }

  private result(
    invocation: SkillInvocationV1,
    outcome: SkillExecutionResultV1["payload"]["outcome"],
    attempts: number,
    output?: SkillJsonValue,
    errorCode?: string,
  ): SkillExecutionResultV1 {
    const completedAt = this.now().toISOString();
    if (errorCode !== undefined) skillErrorCodeSchema.parse(errorCode);
    return skillExecutionResultV1Schema.parse({
      schemaVersion: "1.0",
      messageId: this.messageId(),
      traceId: invocation.traceId,
      timestamp: completedAt,
      source: { service: "bot-runtime", instanceId: this.runtimeInstanceId },
      botId: invocation.botId,
      taskId: invocation.taskId,
      type: "skill.result.v1",
      payload: {
        invocationId: invocation.payload.invocationId,
        skillId: invocation.payload.skillId,
        skillVersion: invocation.payload.skillVersion,
        outcome,
        attempts,
        completedAt,
        ...(output !== undefined ? { output } : {}),
        ...(errorCode !== undefined ? { errorCode } : {}),
      },
    });
  }
}

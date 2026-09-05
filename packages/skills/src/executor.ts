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

import {
  SkillAbortError,
  SkillFault,
  SkillFrameworkError,
  SkillRefusal,
  SKILL_FAULT_DEFAULT_MESSAGE,
} from "./errors.js";
import { ServerPolicyGate } from "./policy/policy-gate.js";
import {
  baselineServerPolicy,
  DEFAULT_UNKNOWN_SERVER_PROFILE,
} from "./policy/server-policy.js";
import { SkillRegistry } from "./registry.js";
import type {
  SkillCompatibilityEnvironment,
  SkillExecutionAuthorization,
  SkillExecutionContext,
  SkillExecutorOptions,
  SkillPolicyView,
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

    const policy = this.policyFor(parsedState.data);
    for (const precondition of definition.preconditions) {
      try {
        const met = precondition.check(parsedInput.data, parsedState.data, policy);
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
        policy: Object.freeze({ serverProfileId: policy.serverProfileId,
          checkBlockReach: policy.checkBlockReach.bind(policy), checkAttackReach: policy.checkAttackReach.bind(policy) }),
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
            // 适配器抛出的非 SkillFault 就是"没人预料到的那种坏"——把原因丢在这里
            // 等于让 onFault 只报得出屏蔽码。原因带走，屏蔽码不变。
            throw new SkillFault(
              "SKILL_CAPABILITY_FAILED",
              error instanceof Error && error.message.trim().length > 0
                ? error.message.trim()
                : undefined,
            );
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
            this.reportFault(invocation, errorCode, attempts, error);
            // `SkillRefusal` 是抛出点在断言"这次调用什么都没改动"。`rejected` 在
            // 这份协议里一直就是这个意思——原先八个 rejected 站点全是执行前的
            // 谢绝——所以拒绝走同一个出口，而不是新加一个字段。`attempts` 保持
            // 真实值：它记的是"跑了几次"，从来不是"动没动过"，用它兼职表达副作用
            // 正是屏蔽误判的根源。
            return this.result(
              invocation,
              error instanceof SkillRefusal ? "rejected" : "failed",
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

  /**
   * 解析本次执行要用的策略视图。
   *
   * `serverProfileId` 从**已校验的 state** 里读——那是 bot 真实连着的服，
   * 不是调用方在 input 里声称的（两者不一致由 `target.server-profile-matches`
   * 前置条件拒绝）。拿不到就走 STRICT 基线：未知服按最保守档，不退回原版 4.5。
   */
  private policyFor(state: unknown): SkillPolicyView {
    const serverProfileId =
      typeof state === "object" &&
      state !== null &&
      "serverProfileId" in state &&
      typeof (state as { serverProfileId: unknown }).serverProfileId === "string"
        ? (state as { serverProfileId: string }).serverProfileId
        : "unknown-server";
    const resolve = this.options.policyView;
    if (resolve) return resolve(serverProfileId);
    return new ServerPolicyGate(
      baselineServerPolicy(serverProfileId, DEFAULT_UNKNOWN_SERVER_PROFILE),
    );
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

  /**
   * 把终态失败的原因交给宿主。这里刻意只在"不再重试"的那一支调用：中途重试成功
   * 的那次不是故障，记下来只会让日志把自愈当事故。钩子抛出的异常必须吞掉——诊断
   * 不能反过来改写它正在描述的那次失败。
   */
  private reportFault(
    invocation: SkillInvocationV1,
    errorCode: string,
    attempts: number,
    error: unknown,
  ): void {
    if (!this.options.onFault) return;
    const raw = error instanceof Error ? error.message.trim() : "";
    // 占位文本不是原因。留 null 让运维知道"这次确实没人说明白"，
    // 而不是给一句读起来像解释、其实什么都没说的话。
    const message = raw === SKILL_FAULT_DEFAULT_MESSAGE ? "" : raw;
    try {
      this.options.onFault({
        traceId: invocation.traceId,
        taskId: invocation.taskId,
        skillId: invocation.payload.skillId,
        skillVersion: invocation.payload.skillVersion,
        invocationId: invocation.payload.invocationId,
        errorCode,
        attempts,
        reason: message.length > 0 ? message.slice(0, 200) : null,
      });
    } catch {
      // 宿主的日志坏了不该把技能失败换成另一种失败。
    }
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

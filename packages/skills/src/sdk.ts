// ---------------------------------------------------------------------------
// Skill SDK —— 统一的 Skill 开发框架。
//
// 解决的核心问题：Skill 不应该各自实现 verify/retry/recovery/observation。
// 所有确定性动作通过 SDK 的 primitive 方法发出，SDK 负责：
//
//   1. 执行 primitive 并计时
//   2. 区分"指令已发"vs"服务端状态确认"
//   3. 采集 before/after observation snapshot
//   4. 基于用户定义的 verify 谓词判定成功
//   5. 分类失败并执行有界恢复
//   6. 传播 AbortSignal 取消
//
// 设计原则：Skills 声明"我要完成什么"和"怎么知道成功了"。
// SDK 负责"怎么做、怎么重试、怎么恢复、怎么报错"。
// ---------------------------------------------------------------------------

import type { SkillExecutionContext } from "./types.js";
import type { SkillJsonValue } from "@minecraft-studio/protocol";
import type { z } from "zod";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ActionStatus =
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "interrupted"
  | "partial";

export interface ActionError {
  code: string;
  message: string;
  retryable: boolean;
  details?: unknown;
}

export interface ActionResult<T = unknown> {
  status: ActionStatus;
  ok: boolean;
  value: T | undefined;
  error: ActionError | null;
  capability: string;
  operation: string;
  startedAtMs: number;
  durationMs: number;
}

export type ObservationSnapshot = Readonly<{
  timestamp: number;
  position: { x: number; y: number; z: number } | null;
  health: number | null;
  food: number | null;
  inventoryCounts: Readonly<Record<string, number>>;
  dimension: string | null;
}>;

export type VerificationResult =
  | Readonly<{ status: "verified"; evidence: string }>
  | Readonly<{ status: "not_yet"; evidence: string }>
  | Readonly<{ status: "failed"; evidence: string }>
  | Readonly<{ status: "inconclusive"; evidence: string }>;

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

export type RecoveryAction =
  | "retry_same"
  | "reposition"
  | "re_path"
  | "find_alternate_target"
  | "clear_inventory"
  | "re_observe"
  | "re_plan"
  | "abort";

export type RecoveryPolicy = Readonly<{
  maxAttempts: number;
  maxRecoveryAttempts: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  actions: Readonly<Record<string, RecoveryAction>>;
  default: RecoveryAction;
}>;

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = Object.freeze({
  maxAttempts: 3,
  maxRecoveryAttempts: 2,
  backoffBaseMs: 500,
  backoffMaxMs: 5_000,
  actions: Object.freeze({
    PATH_BLOCKED: "re_path",
    OUT_OF_REACH: "reposition",
    TARGET_GONE: "find_alternate_target",
    NO_RESOURCE: "re_plan",
    NO_WORKSTATION: "find_alternate_target",
    WORKSTATION_BUSY: "retry_same",
    INVENTORY_FULL: "clear_inventory",
    SERVER_REJECTED: "abort",
    ACTION_TIMEOUT: "re_observe",
    STATE_DESYNC: "re_observe",
    INTERRUPTED_BY_COMBAT: "abort",
    SKILL_CANCELLED: "abort",
  }),
  default: "abort" as RecoveryAction,
});

export function recoveryActionFor(
  errorCode: string,
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
): RecoveryAction {
  for (const [pattern, action] of Object.entries(policy.actions)) {
    if (errorCode.includes(pattern) || errorCode === pattern) return action;
  }
  return policy.default;
}

// ---------------------------------------------------------------------------
// SkillSDK —— Skill 执行期间的高级操作接口
// ---------------------------------------------------------------------------

export class SkillSDK {
  constructor(
    private readonly ctx: SkillExecutionContext,
    private readonly opts: {
      botState?: () => ObservationSnapshot | null;
      timeoutBudgetMs?: number;
    } = {},
  ) {}

  /**
   * 执行 primitive 并验证服务端状态。
   * 这是 Skill 调用 Mineflayer 的**唯一入口**。
   *
   * @param opts.verify - 服务端状态确认谓词（在 primitive 完成后调用）
   * @param opts.verifyTimeoutMs - verify 的轮询预算（默认 5s）
   * @param opts.verifyIntervalMs - verify 的轮询间隔（默认 250ms）
   * @param opts.signal - 可选外部取消信号（默认使用 ctx.signal）
   */
  async primitive<TOutput extends SkillJsonValue = SkillJsonValue>(
    capability: string,
    operation: string,
    input: SkillJsonValue,
    opts: {
      verify?: ((output: TOutput) => VerificationResult | Promise<VerificationResult>) | undefined;
      verifyTimeoutMs?: number | undefined;
      verifyIntervalMs?: number | undefined;
      signal?: AbortSignal | undefined;
      schema?: z.ZodType<TOutput> | undefined;
    } = {},
  ): Promise<ActionResult<TOutput>> {
    const startedAtMs = Date.now();
    const signal = opts.signal ?? this.ctx.signal;

    if (signal.aborted) {
      return this.cancelled(capability, operation, startedAtMs);
    }

    try {
      const raw = await this.ctx.callCapability<TOutput>(
        capability as never,
        operation,
        input,
      );

      if (signal.aborted) {
        return this.cancelled(capability, operation, startedAtMs);
      }

      // Schema validation if provided
      const value = opts.schema ? opts.schema.parse(raw) : raw;

      // Verification if provided
      if (opts.verify) {
        const verified = await this.pollVerify(opts.verify, {
          timeoutMs: opts.verifyTimeoutMs ?? 5_000,
          intervalMs: opts.verifyIntervalMs ?? 250,
          signal,
        });
        if (verified.status !== "verified") {
          return {
            status: "failed",
            ok: false,
            value: undefined,
            error: {
              code: "VERIFY_FAILED",
              message: `Verification ${verified.status}: ${verified.evidence}`,
              retryable: verified.status === "not_yet",
              details: verified,
            },
            capability,
            operation,
            startedAtMs,
            durationMs: Date.now() - startedAtMs,
          };
        }
      }

      return {
        status: "succeeded",
        ok: true,
        value,
        error: null,
        capability,
        operation,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
      };
    } catch (cause) {
      if (signal.aborted) {
        return this.cancelled(capability, operation, startedAtMs);
      }
      const code =
        cause instanceof Error && "code" in cause
          ? String((cause as { code: unknown }).code)
          : "ACTION_FAILED";
      return {
        status: "failed",
        ok: false,
        value: undefined,
        error: {
          code,
          message: cause instanceof Error ? cause.message : String(cause),
          retryable: isRetryable(code),
        },
        capability,
        operation,
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
      };
    }
  }

  /**
   * 有界重试执行 primitive。
   * 根据错误码分类选择恢复动作，遵守 maxAttempts 和 maxRecoveryAttempts。
   */
  async primitiveWithRecovery<TOutput extends SkillJsonValue = SkillJsonValue>(
    capability: string,
    operation: string,
    input: SkillJsonValue | (() => SkillJsonValue),
    opts: {
      verify?: ((output: TOutput) => VerificationResult | Promise<VerificationResult>) | undefined;
      verifyTimeoutMs?: number | undefined;
      verifyIntervalMs?: number | undefined;
      signal?: AbortSignal | undefined;
      schema?: z.ZodType<TOutput> | undefined;
      recovery?: Partial<RecoveryPolicy>;
    } = {},
  ): Promise<ActionResult<TOutput>> {
    const policy: RecoveryPolicy = {
      ...DEFAULT_RECOVERY_POLICY,
      ...opts.recovery,
    };
    let attempts = 0;
    let recoveryAttempts = 0;
    let lastError: ActionError | null = null;

    while (attempts < policy.maxAttempts) {
      if (opts.signal?.aborted || this.ctx.signal.aborted) {
        return this.cancelled(capability, operation, Date.now());
      }

      const currentInput = typeof input === "function" ? input() : input;
      const result = await this.primitive<TOutput>(
        capability,
        operation,
        currentInput as SkillJsonValue,
        {
          verify: opts.verify,
          verifyTimeoutMs: opts.verifyTimeoutMs,
          verifyIntervalMs: opts.verifyIntervalMs,
          signal: opts.signal,
          schema: opts.schema,
        },
      );

      if (result.ok) return result;
      lastError = result.error;
      attempts += 1;

      const errorCode = result.error?.code ?? "UNKNOWN";
      const action = recoveryActionFor(errorCode, policy);

      if (action === "abort") break;
      if (action !== "retry_same") {
        recoveryAttempts += 1;
        if (recoveryAttempts > policy.maxRecoveryAttempts) break;
      }

      // Backoff before retry
      const backoff = Math.min(
        policy.backoffBaseMs * Math.pow(2, attempts - 1),
        policy.backoffMaxMs,
      );
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }

    return {
      status: "failed",
      ok: false,
      value: undefined,
      error: lastError ?? {
        code: "MAX_ATTEMPTS_EXHAUSTED",
        message: `Exhausted ${policy.maxAttempts} attempts`,
        retryable: false,
      },
      capability,
      operation,
      startedAtMs: Date.now(),
      durationMs: 0,
    };
  }

  private cancelled(capability: string, operation: string, startedAtMs: number): ActionResult<never> {
    return {
      status: "cancelled",
      ok: false,
      value: undefined,
      error: {
        code: "SKILL_CANCELLED",
        message: "Operation was cancelled via AbortSignal",
        retryable: false,
      },
      capability,
      operation,
      startedAtMs,
      durationMs: Date.now() - startedAtMs,
    };
  }

  private async pollVerify(
    verify: (output: never) => VerificationResult | Promise<VerificationResult>,
    opts: { timeoutMs: number; intervalMs: number; signal: AbortSignal },
  ): Promise<VerificationResult> {
    const deadline = Date.now() + opts.timeoutMs;
    while (Date.now() < deadline && !opts.signal.aborted) {
      const result = await verify(undefined as never);
      if (result.status === "verified") return result;
      if (result.status === "failed") return result;
      await new Promise((resolve) => setTimeout(resolve, opts.intervalMs));
    }
    return { status: "inconclusive", evidence: "Verification poll timed out" };
  }
}

function isRetryable(code: string): boolean {
  return code.includes("TIMEOUT") || code.includes("TRANSIENT") || code.includes("RETRYABLE");
}

/**
 * 创建 SDK 实例绑定到当前 SkillExecutionContext。
 * 在 Skill 的 execute() 内调用此函数获取 SDK。
 */
export function createSkillSDK(
  ctx: SkillExecutionContext,
  opts?: { botState?: () => ObservationSnapshot | null },
): SkillSDK {
  return new SkillSDK(ctx, opts);
}

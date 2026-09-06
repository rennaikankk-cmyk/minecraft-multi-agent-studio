// spark-strategy-v1/model-client.ts —— 注入式模型调用接口（无启动副作用）。
//
// 一期指令 §5：优先复用 ScheduledAIRouter 的稳定接口（排队/取消/超时/
// 优先级/熔断语义全部沿用），不新建调度器、不自动启动任何后台活动。
// 模块导入零副作用——只有显式调用 askTeamProposal 才产生请求。
//
// 分账口径（§6/§7）：客户端观测=入队前计时到完整响应；finishReason 与
// vLLM finish_reason 可透传；服务端排队与 TTFT 仍不可从非流式总耗时推导。

import {
  aiRequestPriorities,
  AISchedulerError,
  type ScheduledAIRouter,
  type ScheduledGenerateOptions,
} from "@minecraft-studio/ai-router";
import { parseProposalResponse, type ParseOutcome, type TeamProposal } from "./proposal.js";

/** 最小模型接口（回放/测试注入用；live 适配器实现同一接口）。 */
export type ModelClient = {
  /** 单次补全。实现方负责超时/取消语义；本层只记账。 */
  complete(request: ModelRequest): Promise<ModelResponse>;
};

export type ModelRequest = {
  system: string;
  prompt: string;
  requestId: string;
  botId: string;
  /** 透传 ScheduledAIRouter 优先级（缺省 planning 同级）。 */
  priority?: number;
  timeoutMs?: number;
  maxTokens?: number;
  temperature?: number;
  traceId?: string;
  signal?: AbortSignal;
};

export type ModelResponse = {
  text: string;
  /**
   * 完成原因。未提供该字段的适配器仍返回 unknown。
   */
  finishReason: "stop" | "length" | "aborted" | "error" | "unknown";
  /** 客户端观测耗时（ms）；口径=client-observed-total。 */
  clientLatencyMs: number;
  /** token 用量（SOURCE-REPORTED；缺失=undefined，不推算、不混算）。 */
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
  /** scheduler 观测时序（SOURCE-REPORTED；排队/执行分离，非推导）。 */
  schedulerTimings?: {
    queueTimeMs: number;
    executionTimeMs: number;
    totalTimeMs: number;
    attempts: number;
  };
};

export type ProposalRequestAccounting = {
  requestId: string;
  outcome: "valid-proposal" | "parse-failed" | "request-failed" | "cancelled";
  errorCode?: string;
  parseReason?: Extract<ParseOutcome, { ok: false }>["reason"];
  clientLatencyMs: number | null;
  finishReason: ModelResponse["finishReason"] | null;
  usage?: ModelResponse["usage"];
  schedulerTimings?: ModelResponse["schedulerTimings"];
  detail?: string;
};

export type ProposalAskResult = {
  accounting: ProposalRequestAccounting;
  proposal: TeamProposal | null;
};

/** 请求一次全队建议并解析（分账不抛；解析失败也返回 accounting）。 */
export async function askTeamProposal(options: {
  client: ModelClient;
  request: ModelRequest;
  /** 注入解析器（默认 parseProposalResponse；测试可替换）。 */
  parse?: typeof parseProposalResponse;
}): Promise<ProposalAskResult> {
  const began = Date.now();
  let response: ModelResponse;
  try {
    response = await options.client.complete(options.request);
  } catch (error) {
    const code = error instanceof AISchedulerError ? error.code : undefined;
    const aborted = (error instanceof Error && error.name === "AbortError") ||
      code === "AI_REQUEST_CANCELLED" || code === "AI_REQUEST_SUPERSEDED";
    return {
      accounting: {
        requestId: options.request.requestId,
        outcome: aborted ? "cancelled" : "request-failed",
        ...(code ? { errorCode: code } : {}),
        clientLatencyMs: Date.now() - began,
        finishReason: aborted ? "aborted" : "error",
        detail: error instanceof Error ? error.message : String(error),
      },
      proposal: null,
    };
  }
  if (response.finishReason === "length" || response.finishReason === "aborted" || response.finishReason === "error") {
    return { proposal: null, accounting: {
      requestId: options.request.requestId,
      outcome: response.finishReason === "length" ? "parse-failed" : response.finishReason === "aborted" ? "cancelled" : "request-failed",
      ...(response.finishReason === "length" ? { parseReason: "truncated-json" as const } : {}),
      finishReason: response.finishReason, clientLatencyMs: response.clientLatencyMs,
      usage: response.usage, schedulerTimings: response.schedulerTimings,
    } };
  }
  const parse = (options.parse ?? parseProposalResponse)(response.text);
  if (parse.ok) {
    return {
      accounting: {
        requestId: options.request.requestId,
        outcome: "valid-proposal",
        clientLatencyMs: response.clientLatencyMs,
        finishReason: response.finishReason,
        usage: response.usage,
        schedulerTimings: response.schedulerTimings,
      },
      proposal: parse.proposal,
    };
  }
  return {
    accounting: {
      requestId: options.request.requestId,
      outcome: "parse-failed",
      parseReason: parse.reason,
      clientLatencyMs: response.clientLatencyMs,
      finishReason: response.finishReason,
      usage: response.usage,
      schedulerTimings: response.schedulerTimings,
      detail: parse.detail,
    },
    proposal: null,
  };
}

/**
 * ScheduledAIRouter 适配器（live/连接模式用）。字段与生产调用
 * （strategy-review.ts askStrategyReview）逐一同形：model/baseUrl 绑定在
 * adapter 构造期，不进请求；超时/取消/优先级/去重语义全部沿用 scheduler。
 */
export function scheduledRouterModelClient(
  router: ScheduledAIRouter,
  options: {
    /** 默认 3000（EVAL_CONTRACT v1 校准链同值）。 */
    maxTokens?: number;
    temperature?: number;
    timeoutMs?: number;
  } = {},
): ModelClient {
  return {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      const scheduledOptions: ScheduledGenerateOptions = {
        requestId: request.requestId,
        botId: request.botId,
        priority: request.priority ?? aiRequestPriorities.planning,
        prompt: request.prompt,
        systemPrompt: request.system,
        maxTokens: request.maxTokens ?? options.maxTokens ?? 3000,
        temperature: request.temperature ?? options.temperature ?? 0,
        timeoutMs: request.timeoutMs ?? options.timeoutMs ?? 120_000,
        traceId: request.traceId ?? `spark-strategy-v1:${request.requestId}`,
      };
      if (request.signal) scheduledOptions.signal = request.signal;
      const began = Date.now();
      const result = await router.generate(scheduledOptions);
      return {
        text: result.value.content,
        finishReason: result.value.finishReason === "stop" || result.value.finishReason === "length"
          ? result.value.finishReason : "unknown",
        clientLatencyMs: Date.now() - began,
        usage: {
          promptTokens: result.value.usage.promptTokens,
          completionTokens: result.value.usage.completionTokens,
        },
        schedulerTimings: {
          queueTimeMs: result.queueTimeMs,
          executionTimeMs: result.executionTimeMs,
          totalTimeMs: result.totalTimeMs,
          attempts: result.attempts,
        },
      };
    },
  };
}

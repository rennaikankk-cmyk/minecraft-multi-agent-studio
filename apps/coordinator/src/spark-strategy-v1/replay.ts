// spark-strategy-v1/replay.ts —— 离线回放管线（可导入；无 I/O、无定时器）。
//
// 一期指令 §1/§6：读取已导出的事实 → 构建摘要 → 回放/注入模型响应 →
// 建议解析 → 验证 → 报告。模式分账：offline=零网络（注入响应）、mock=
// 合成响应、replay=历史建议回放、live=真实请求（本期默认不执行，由调用
// 方显式提供 live client 才会启用）。纯建议回放只评价建议质量——没有
// 真实执行的样本不得声称 Minecraft 任务完成率提升（报告中如实标注）。

import {
  factVersion,
  parseTeamFactsInput,
  type TeamFactsInput,
} from "./facts.js";
import { buildSituationSummary, type SituationSummary } from "./summary.js";
import { askTeamProposal, type ModelClient, type ProposalRequestAccounting } from "./model-client.js";
import { validateProposal, type ValidationResult } from "./validator.js";
import type { TeamProposal } from "./proposal.js";
import type { ActionContext } from "./action-contract.js";

export type ReplayMode = "offline" | "mock" | "replay" | "live";

/** 单样本期望（评测判据；由 fixture 声明，回放器只对照不臆造）。 */
export type SampleExpectation = {
  /** 场景事实上是"应该行动"还是"应该等待/观望"。 */
  desiredBehavior: "act" | "wait-or-escalate";
  /** 判定 acceptable 即算达标；needs-reobservation 对 wait-or-escalate 也算达标。 */
  acceptableVerdicts: ReadonlyArray<ValidationResult["verdict"]>;
  botBehaviors?: Readonly<Record<string, "act" | "wait">>;
  expectedParseReason?: string;
};

export type ReplaySample = {
  sampleId: string;
  scenario: "food-shortage" | "build-materials" | "repeated-failure";
  mode: ReplayMode;
  facts: TeamFactsInput;
  /** offline/mock/replay：注入的模型响应文本；live：忽略（真实请求）。 */
  injectedResponse?: string;
  expectation: SampleExpectation;
  evaluationNowMs?: number;
};

export type ReplaySampleResult = {
  sampleId: string;
  scenario: ReplaySample["scenario"];
  mode: ReplayMode;
  summary: {
    factVersion: string;
    tokenEstimate: SituationSummary["tokenEstimate"];
    trimmed: SituationSummary["trimmed"];
  };
  accounting: ProposalRequestAccounting;
  proposal: TeamProposal | null;
  validation: ValidationResult | null;
  /** 评测判据（§6 有用性分账）。 */
  usefulness: {
    /** 应该行动却 noop/wait（误判）。 */
    shouldActButNoop: boolean;
    /** 应该等待且正确等待/上报。 */
    shouldWaitCorrectlyWaiting: boolean;
    /** 建议判定与 fixture 期望一致（负样本的正确拒绝也算匹配）。 */
    matchedExpectation: boolean;
    /** 无效能力引用（验证器 UNSUPPORTED_*）。 */
    invalidCapabilityReference: boolean;
    /** 资源/分工冲突。 */
    conflictDetected: boolean;
  };
};

export type ReplayReport = {
  mode: ReplayMode;
  evalVersion: string;
  gitCommit: string | null;
  generatedAtMs: number;
  environment: {
    modelIdentifiedBy: "fixture-injected" | "live-client";
    /** live 模式才有；offline 恒 unavailable。 */
    serverMetrics: "unavailable" | "SOURCE-REPORTED";
  };
  samples: ReplaySampleResult[];
  aggregates: {
    samples: number;
    parsedProposals: number;
    validatedProposals: number;
    expectedParseFailures: number;
    parseFailures: number;
    requestFailures: number;
    matchedExpectationCount: number;
    shouldActButNoop: number;
    shouldWaitCorrectlyWaiting: number;
    modelNotTriggered: number;
    verdicts: Record<string, number>;
    parseReasons: Record<string, number>;
    /** mock/offline 模式下时延不代表真实服务端——如实标注。 */
    latencyNote: string;
  };
  /** 声明边界：纯建议回放不计算 Minecraft 任务完成率。 */
  caveats: string[];
};

export const REPLAY_EVAL_VERSION = "spark-strategy-v1-eval-1";

/** 客户端注入器：offline/mock/replay 用（按样本返回预置响应）。 */
export function injectedModelClient(responses: Map<string, string>): ModelClient {
  return {
    complete: async (request) => {
      const injected = responses.get(request.requestId);
      if (injected === undefined) {
        throw new Error(`no injected response for requestId=${request.requestId}`);
      }
      return { text: injected, finishReason: "unknown", clientLatencyMs: 0 };
    },
  };
}

/** 单样本执行：摘要 →（注入/真实）模型 → 解析 → 验证 → 有用性对照。 */
export async function runReplaySample(sample: ReplaySample, options: {
  client: ModelClient;
  /** 显式时钟（live 用）；缺省=fixture 相对时钟（observedAt+1s，确定性）。 */
  nowMs?: number;
  systemPrompt: string;
  actionContext?: ActionContext;
}): Promise<ReplaySampleResult> {
  const facts: TeamFactsInput = parseTeamFactsInput(sample.facts);
  const nowMs = options.nowMs ?? sample.evaluationNowMs;
  if (nowMs === undefined || !Number.isSafeInteger(nowMs)) throw new RangeError("replay requires an explicit evaluation clock");
  const version = factVersion(facts);
  const summary = buildSituationSummary(facts, { nowMs });
  const { accounting, proposal } = await askTeamProposal({
    client: options.client,
    request: {
      system: options.systemPrompt,
      prompt: [
        "Team situation snapshot (facts are authoritative; unknown means unknown):",
        summary.text,
        "",
        "Respond with exactly one JSON object: a TeamProposal matching the schema contract.",
      ].join("\n"),
      requestId: sample.sampleId,
      botId: "team",
      traceId: `spark-strategy-v1:${sample.sampleId}`,
    },
  });
  let validation: ValidationResult | null = null;
  if (proposal !== null) {
    validation = validateProposal(proposal, facts, { ...options.actionContext, nowMs });
  }
  const unsupported = validation?.reasons.some((r) => r.code === "UNSUPPORTED_CAPABILITY" || r.code === "UNSUPPORTED_GOAL_TEMPLATE") ?? false;
  const conflicts = validation?.reasons.some(
    (r) => r.code === "RESOURCE_DOUBLE_CLAIM" || r.code === "RESOURCE_CONFLICTS_RESERVATION" || r.code === "DUPLICATE_BOT_ASSIGNMENT",
  ) ?? false;
  const verdict = validation?.verdict ?? null;
  const actionKinds = new Set((proposal?.assignments ?? []).map((a) => a.action.kind));
  const hasActionable = [...actionKinds].some((kind) => kind === "skill" || kind === "deterministicGoal");
  const behaviors = sample.expectation.botBehaviors;
  const behaviorMatches = proposal !== null && (behaviors
    ? Object.entries(behaviors).every(([botId, expected]) => {
        const assignments = proposal.assignments.filter((a) => a.botId === botId);
        return assignments.length > 0 && assignments.every((a) => expected === "act"
          ? a.action.kind === "skill" || a.action.kind === "deterministicGoal"
          : a.action.kind === "wait" || a.action.kind === "noop");
      })
    : sample.expectation.desiredBehavior === "act" ? hasActionable : !hasActionable);
  const matchedExpectation = verdict !== null && sample.expectation.acceptableVerdicts.includes(verdict) && behaviorMatches;
  return {
    sampleId: sample.sampleId,
    scenario: sample.scenario,
    mode: sample.mode,
    summary: { factVersion: version, tokenEstimate: summary.tokenEstimate, trimmed: summary.trimmed },
    accounting,
    proposal,
    validation,
    usefulness: {
      // 误判 noop：建议解析成功但没有任何可执行动作（解析失败不算 noop
      // 决策——它已单列为 parse 失败账目）。
      shouldActButNoop:
        sample.expectation.desiredBehavior === "act" &&
        proposal !== null &&
        !hasActionable,
      shouldWaitCorrectlyWaiting:
        sample.expectation.desiredBehavior === "wait-or-escalate" &&
        behaviorMatches && verdict === "acceptable",
      /** 建议判定与 fixture 期望一致（负样本的正确拒绝也算匹配）。 */
      matchedExpectation,
      invalidCapabilityReference: unsupported,
      conflictDetected: conflicts,
    },
  };
}

/** 批量回放 + 聚合报告（机器可读；Markdown 由 CLI 层生成）。 */
export async function runReplayBatch(samples: ReplaySample[], options: {
  client: ModelClient;
  /** 报告生成时间 + live 样本时钟；缺省时样本各用 fixture 相对时钟。 */
  nowMs?: number;
  systemPrompt: string;
  gitCommit?: string | null;
  actionContext?: ActionContext;
}): Promise<ReplayReport> {
  const nowMs = options.nowMs ?? Date.now();
  const results: ReplaySampleResult[] = [];
  for (const sample of samples) {
    results.push(
      await runReplaySample(sample, {
        client: options.client,
        ...(options.nowMs !== undefined ? { nowMs: options.nowMs } : {}),
        systemPrompt: options.systemPrompt,
        ...(options.actionContext ? { actionContext: options.actionContext } : {}),
      }),
    );
  }
  const verdicts: Record<string, number> = {};
  const parseReasons: Record<string, number> = {};
  let parsedProposals = 0;
  let validatedProposals = 0;
  let expectedParseFailures = 0;
  let parseFailures = 0;
  let requestFailures = 0;
  let matchedExpectationCount = 0;
  let shouldActButNoop = 0;
  let shouldWaitCorrectlyWaiting = 0;
  let modelNotTriggered = 0;
  for (const result of results) {
    if (result.accounting.outcome === "request-failed" || result.accounting.outcome === "cancelled") {
      requestFailures += 1;
      modelNotTriggered += 1;
    } else if (result.accounting.outcome === "parse-failed") {
      parseFailures += 1;
      const reason = result.accounting.parseReason ?? "unknown";
      parseReasons[reason] = (parseReasons[reason] ?? 0) + 1;
      if (samples.find((s) => s.sampleId === result.sampleId)?.expectation.expectedParseReason === reason) expectedParseFailures++;
    } else {
      parsedProposals += 1;
    }
    if (result.validation !== null) {
      if (result.validation.verdict === "acceptable") validatedProposals++;
      verdicts[result.validation.verdict] = (verdicts[result.validation.verdict] ?? 0) + 1;
    }
    if (result.usefulness.matchedExpectation) matchedExpectationCount += 1;
    if (result.usefulness.shouldActButNoop) shouldActButNoop += 1;
    if (result.usefulness.shouldWaitCorrectlyWaiting) shouldWaitCorrectlyWaiting += 1;
  }
  const live = results.some((r) => r.mode === "live");
  return {
    mode: live ? "live" : results[0]?.mode ?? "offline",
    evalVersion: REPLAY_EVAL_VERSION,
    gitCommit: options.gitCommit ?? null,
    generatedAtMs: nowMs,
    environment: {
      modelIdentifiedBy: live ? "live-client" : "fixture-injected",
      serverMetrics: "unavailable",
    },
    samples: results,
    aggregates: {
      samples: results.length,
      parsedProposals,
      validatedProposals,
      expectedParseFailures,
      parseFailures,
      requestFailures,
      matchedExpectationCount,
      shouldActButNoop,
      shouldWaitCorrectlyWaiting,
      modelNotTriggered,
      verdicts,
      parseReasons,
      // mock/offline 时延=注入器恒 0，不代表真实推理服务——不输出时延统计。
      latencyNote:
        "offline/mock/replay modes inject responses; latency figures are not representative. Live runs must report client-observed and scheduler timings separately, with sample counts.",
    },
    caveats: [
      "Pure proposal replay evaluates proposal quality only; no Minecraft task completion rate is claimed or computed without real execution.",
      "Validator acceptance = static/snapshot constraints satisfied; it does not mean tasks will succeed or are immediately dispatchable.",
      "Server-side queue/KV/throughput metrics are unavailable in offline modes; live runs must label each figure MEASURED / SOURCE-REPORTED / ESTIMATED.",
    ],
  };
}

/** 简短 Markdown 渲染（CLI 输出用；与 JSON 同源，不另算数字）。 */
export function renderReportMarkdown(report: ReplayReport): string {
  const lines: string[] = [];
  lines.push(`# Spark Strategy V1 回放报告（mode=${report.mode}）`);
  lines.push("");
  lines.push(`- evalVersion: ${report.evalVersion}`);
  lines.push(`- gitCommit: ${report.gitCommit ?? "unavailable"}`);
  lines.push(`- generatedAtMs: ${report.generatedAtMs}`);
  lines.push(`- serverMetrics: ${report.environment.serverMetrics}`);
  lines.push("");
  lines.push("## 聚合");
  lines.push("");
  for (const [key, value] of Object.entries(report.aggregates)) {
    if (key === "latencyNote" || key === "verdicts" || key === "parseReasons") continue;
    lines.push(`- ${key}: ${String(value)}`);
  }
  lines.push(`- verdicts: ${JSON.stringify(report.aggregates.verdicts)}`);
  lines.push(`- parseReasons: ${JSON.stringify(report.aggregates.parseReasons)}`);
  lines.push(`- latencyNote: ${report.aggregates.latencyNote}`);
  lines.push("");
  lines.push("## 样本");
  lines.push("");
  for (const sample of report.samples) {
    lines.push(
      `- ${sample.sampleId} (${sample.scenario}, mode=${sample.mode}): accounting=${sample.accounting.outcome}` +
        `${sample.accounting.parseReason ? `/${sample.accounting.parseReason}` : ""}, verdict=${sample.validation?.verdict ?? "n/a"}, ` +
        `matchedExpectation=${sample.usefulness.matchedExpectation}` +
        `${sample.usefulness.invalidCapabilityReference ? ", INVALID_CAPABILITY_REF" : ""}` +
        `${sample.usefulness.conflictDetected ? ", CONFLICT" : ""}`,
    );
    if (sample.validation !== null) {
      for (const reason of sample.validation.reasons) {
        lines.push(`  - ${reason.code}${reason.evidence ? ` (${reason.evidence})` : ""}: ${reason.message}`);
      }
    }
  }
  lines.push("");
  lines.push("## 边界");
  lines.push("");
  for (const caveat of report.caveats) lines.push(`- ${caveat}`);
  return lines.join("\n");
}

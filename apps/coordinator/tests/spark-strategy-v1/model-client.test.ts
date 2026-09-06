// model-client 测试：askTeamProposal 分账（valid/parse-failed/request-failed/
// cancelled）+ scheduledRouterModelClient 走真实 AIRequestScheduler（fake
// adapter，零网络）验证字段同形与时序透传。
import { describe, expect, it } from "vitest";
import { askTeamProposal, scheduledRouterModelClient, type ModelClient } from "../../src/spark-strategy-v1/model-client.js";
import type { TeamProposal } from "../../src/spark-strategy-v1/proposal.js";

const goodProposal: TeamProposal = {
  proposalId: "p1",
  factVersion: "0123456789abcdef",
  scope: { serverProfileId: "s", dimension: "overworld" },
  validUntilMs: 9_999_999_999_999,
  generatedBy: "model:test",
  objective: "food",
  assignments: [
    {
      assignmentId: "a1",
      botId: "B01",
      role: "harvester",
      action: { kind: "skill", skillId: "food.secure", params: {} },
      successSignals: ["food >= 16"],
      maxAttempts: 2,
    },
  ],
  dependencies: [],
};

describe("askTeamProposal 分账", () => {
  it("valid JSON with a server length finish is not a usable proposal", async () => {
    const result = await askTeamProposal({ client: { complete: async () => ({ text: JSON.stringify(goodProposal), finishReason: "length", clientLatencyMs: 5 }) },
      request: { system: "s", prompt: "p", requestId: "length-json", botId: "B01" } });
    expect(result.proposal).toBeNull();
    expect(result.accounting).toMatchObject({ outcome: "parse-failed", finishReason: "length" });
  });
  it("scheduler timeout is distinct from caller cancellation", async () => {
    const { AISchedulerError } = await import("@minecraft-studio/ai-router");
    const result = await askTeamProposal({ client: { complete: async () => { throw new AISchedulerError("AI_REQUEST_TIMEOUT", "deadline", "timeout"); } },
      request: { system: "s", prompt: "p", requestId: "timeout", botId: "B01" } });
    expect(result.accounting).toMatchObject({ outcome: "request-failed", errorCode: "AI_REQUEST_TIMEOUT" });
  });
  it("valid-proposal：解析成功带上时延与用量", async () => {
    const client: ModelClient = {
      complete: async () => ({
        text: JSON.stringify(goodProposal),
        finishReason: "unknown",
        clientLatencyMs: 123,
        usage: { promptTokens: 100, completionTokens: 50 },
      }),
    };
    const result = await askTeamProposal({
      client,
      request: { system: "s", prompt: "p", requestId: "r1", botId: "B01" },
    });
    expect(result.accounting).toMatchObject({ outcome: "valid-proposal", clientLatencyMs: 123 });
    expect(result.proposal?.proposalId).toBe("p1");
  });

  it("parse-failed：非法 JSON 分账带 reason 与 detail", async () => {
    const client: ModelClient = {
      complete: async () => ({ text: "<think>hmm</think>", finishReason: "unknown", clientLatencyMs: 10 }),
    };
    const result = await askTeamProposal({
      client,
      request: { system: "s", prompt: "p", requestId: "r2", botId: "B01" },
    });
    expect(result.accounting).toMatchObject({ outcome: "parse-failed", parseReason: "reasoning-only" });
    expect(result.proposal).toBeNull();
  });

  it("request-failed 与 cancelled 分账", async () => {
    const failing: ModelClient = {
      complete: async () => {
        throw new Error("connection refused");
      },
    };
    const failed = await askTeamProposal({
      client: failing,
      request: { system: "s", prompt: "p", requestId: "r3", botId: "B01" },
    });
    expect(failed.accounting).toMatchObject({ outcome: "request-failed", finishReason: "error" });
    const aborting: ModelClient = {
      complete: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    };
    const cancelled = await askTeamProposal({
      client: aborting,
      request: { system: "s", prompt: "p", requestId: "r4", botId: "B01" },
    });
    expect(cancelled.accounting).toMatchObject({ outcome: "cancelled", finishReason: "aborted" });
  });

  it("finish=length 的截断文本仍交解析器（括号不平衡→truncated-json）", async () => {
    const truncated = JSON.stringify(goodProposal).slice(0, 120);
    const client: ModelClient = {
      complete: async () => ({ text: truncated, finishReason: "length", clientLatencyMs: 5 }),
    };
    const result = await askTeamProposal({
      client,
      request: { system: "s", prompt: "p", requestId: "r5", botId: "B01" },
    });
    expect(result.accounting).toMatchObject({ outcome: "parse-failed", parseReason: "truncated-json", finishReason: "length" });
  });
});

describe("scheduledRouterModelClient（真实 scheduler + fake adapter，零网络）", () => {
  it("字段同形 + scheduler 时序透传 + cancel 语义", async () => {
    const { AIRouter } = await import("@minecraft-studio/ai-router");
    const { ScheduledAIRouter } = await import("@minecraft-studio/ai-router");
    const router = new AIRouter();
    router.register({
      name: "fake",
      type: "local",
      health: async () => ({ available: true }),
      generate: async (opts) => {
        // 生产调用形态核对：systemPrompt/timeoutMs/temperature 透传。
        expect(opts.systemPrompt).toContain("team strategy");
        expect(opts.maxTokens).toBe(3000);
        expect(opts.temperature).toBe(0);
        return {
          content: JSON.stringify(goodProposal),
          usage: { promptTokens: 42, completionTokens: 17 },
        };
      },
    });
    const schedulerRouter = new ScheduledAIRouter(router, new (await import("@minecraft-studio/ai-router")).AIRequestScheduler({ maxConcurrency: 2 }));
    const client = scheduledRouterModelClient(schedulerRouter);
    const began = Date.now();
    const response = await client.complete({
      system: "You are the team strategy layer. Return one JSON proposal.",
      prompt: "propose",
      requestId: "sched-1",
      botId: "B01",
    });
    expect(response.finishReason).toBe("unknown"); // GenerateResult 无 finish 字段——如实
    expect(response.usage).toEqual({ promptTokens: 42, completionTokens: 17 });
    expect(response.schedulerTimings).toBeDefined();
    expect(response.schedulerTimings?.attempts).toBe(1);
    expect(response.clientLatencyMs).toBeGreaterThanOrEqual(0);
    expect(Date.now() - began).toBeLessThan(5000);
    // 取消：AbortError 传播为 cancelled 分账。
    const controller = new AbortController();
    controller.abort();
    const result = await askTeamProposal({
      client,
      request: { system: "s", prompt: "p", requestId: "sched-2", botId: "B01", signal: controller.signal },
    });
    expect(result.accounting.outcome).toBe("cancelled");
    expect(result.accounting.errorCode).toBe("AI_REQUEST_CANCELLED");
  });
});

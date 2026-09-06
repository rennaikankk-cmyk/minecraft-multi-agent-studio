// replay 管线测试：离线批量 → 聚合报告（确定性、无网络、无定时器）。
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { loadBlueprintFiles } from "../../src/blueprint-files.js";
import type { ActionContext } from "../../src/spark-strategy-v1/action-contract.js";
import {
  factVersion,
  parseTeamFactsInput,
  injectedModelClient,
  runReplayBatch,
  renderReportMarkdown,
  REPLAY_EVAL_VERSION,
  type ReplaySample,
} from "../../src/spark-strategy-v1/index.js";

const fixturesDir = path.resolve(__dirname, "../../../../eval/spark-strategy-v1/fixtures");
const NOW = 1_780_000_000_000;
const actionContext: ActionContext = {
  blueprints: loadBlueprintFiles(),
  targets: new Map(Object.entries(JSON.parse(readFileSync(path.join(fixturesDir, "../trusted-fixture-targets.json"), "utf8")))),
};

function loadFixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(fixturesDir, name), "utf8")) as Record<string, unknown>;
}

const SYSTEM_PROMPT = "Return exactly one JSON TeamProposal. Unknown means unknown.";

describe("runReplayBatch（离线注入）", () => {
  it("A/B/C + 负样本：判定与期望一致，聚合分账正确，报告可复现", async () => {
    const fixtureFiles = [
      "scenario-A-food-shortage.json",
      "scenario-B-build-materials.json",
      "scenario-C-repeated-failure.json",
      "negative-N1-invalid-json.json",
      "negative-N2-cross-server.json",
    ];
    const samples: ReplaySample[] = [];
    const responses = new Map<string, string>();
    for (const name of fixtureFiles) {
      const fixture = loadFixture(name);
      const raw = { ...fixture };
      if (typeof raw.factsRef === "string") {
        raw.facts = loadFixture(raw.factsRef as string).facts;
      }
      const facts = parseTeamFactsInput(raw.facts);
      const version = factVersion(facts);
      const responseText =
        typeof fixture.injectedResponse === "string"
          ? (fixture.injectedResponse as string).replaceAll("{{factVersion}}", version)
          : JSON.stringify(fixture.injectedResponse).replaceAll("{{factVersion}}", version);
      samples.push({
        sampleId: fixture.sampleId as string,
        scenario: fixture.scenario as ReplaySample["scenario"],
        mode: "offline",
        facts,
        expectation: fixture.expectation as ReplaySample["expectation"],
        evaluationNowMs: fixture.evaluationNowMs as number,
      });
      responses.set(fixture.sampleId as string, responseText);
    }

    const report = await runReplayBatch(samples, {
      client: injectedModelClient(responses),
      systemPrompt: SYSTEM_PROMPT,
      gitCommit: "test-commit",
      actionContext,
    });
    expect(report.evalVersion).toBe(REPLAY_EVAL_VERSION);
    expect(report.mode).toBe("offline");
    expect(report.environment.serverMetrics).toBe("unavailable");
    expect(report.aggregates.samples).toBe(5);
    expect(report.aggregates.parsedProposals).toBe(4);
    expect(report.aggregates.validatedProposals).toBe(3);
    expect(report.aggregates.parseFailures).toBe(1);
    expect(report.aggregates.parseReasons).toEqual({ "invalid-json": 1 });
    expect(report.aggregates.matchedExpectationCount).toBe(4);
    expect(report.aggregates.shouldActButNoop).toBe(0);
    expect(report.aggregates.shouldWaitCorrectlyWaiting).toBe(1);
    // 跨服建议被拒（SCOPE_MISMATCH 在案）。
    const n2 = report.samples.find((s) => s.sampleId === "N2-cross-server");
    expect(n2?.validation?.reasons.some((r) => r.code === "SCOPE_MISMATCH")).toBe(true);
    // 场景 A：角色分工 + 依赖（收获→运输），无双占。
    const a1 = report.samples.find((s) => s.sampleId === "A1-food-shortage");
    expect(a1?.validation?.verdict).toBe("acceptable");
    expect(a1?.proposal?.assignments.map((a) => a.role)).toEqual(["harvester", "logistics", "forager"]);
    expect(a1?.proposal?.dependencies).toHaveLength(1);
    // 场景 C：失败证据 → 替代方案 + 等待（正确等待计数）。
    const c1 = report.samples.find((s) => s.sampleId === "C1-repeated-failure");
    expect(c1?.proposal?.assignments.some((a) => a.action.kind === "wait")).toBe(true);
    expect(c1?.usefulness.shouldWaitCorrectlyWaiting).toBe(true);
    // markdown 渲染包含聚合与边界声明。
    const markdown = renderReportMarkdown(report);
    expect(markdown).toContain("mode=offline");
    expect(markdown).toContain("Pure proposal replay evaluates proposal quality only");
    // 同输入二次运行结果一致（确定性）。
    const again = await runReplayBatch(samples, {
      client: injectedModelClient(responses),
      systemPrompt: SYSTEM_PROMPT,
      gitCommit: "test-commit",
      actionContext,
    });
    expect(again.aggregates).toEqual(report.aggregates);
  });
});

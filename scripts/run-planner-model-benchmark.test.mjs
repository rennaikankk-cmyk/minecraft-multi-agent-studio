import assert from "node:assert/strict";
import test from "node:test";

import {
  BENCHMARK_REASON_CODES,
  benchmarkPlannedItems,
  benchmarkProvider,
  benchmarkCatalog,
  evaluatePlannerContent,
  groundingViolations,
  latencyScore,
  percentile,
  PLANNER_BENCHMARK_CASES,
} from "./run-planner-model-benchmark.mjs";

test("latency score follows the 8s to 30s linear boundary", () => {
  assert.equal(latencyScore(8_000), 20);
  assert.equal(latencyScore(19_000), 10);
  assert.equal(latencyScore(30_000), 0);
  assert.equal(latencyScore(30_001), 0);
});

test("percentile uses the nearest-rank rule", () => {
  assert.equal(percentile([4, 1, 3, 2], 0.5), 2);
  assert.equal(percentile([4, 1, 3, 2], 0.95), 4);
});

test("strict decision evaluation accepts the exact grounded movement decision", () => {
  const benchmarkCase = PLANNER_BENCHMARK_CASES[0];
  const content = JSON.stringify({
    action: "invoke_skill",
    botId: "worker-01",
    taskId: "task-01",
    skillId: "movement.goto",
    skillVersion: "1.0.0",
    input: benchmarkCase.expectedInput,
    reasonCode: "ADVANCE_TASK",
  });
  const result = evaluatePlannerContent({
    content,
    botId: "worker-01",
    taskId: "task-01",
    benchmarkCase,
    catalog: benchmarkCatalog(),
  });
  assert.equal(result.schemaCompliant, true);
  assert.equal(result.identityExact, true);
  assert.equal(result.skillInputSchemaPass, true);
  assert.equal(result.correct, true);
  assert.deepEqual(result.groundingViolations, []);
});

test("markdown, extra fields, and identity changes fail one-pass evaluation", () => {
  const benchmarkCase = PLANNER_BENCHMARK_CASES[4];
  const values = [
    "```json\n{}\n```",
    JSON.stringify({
      action: "noop",
      botId: "worker-01",
      taskId: "task-01",
      reasonCode: "NO_SAFE_SKILL",
      explanation: "extra",
    }),
    JSON.stringify({
      action: "noop",
      botId: "other-worker",
      taskId: "task-01",
      reasonCode: "NO_SAFE_SKILL",
    }),
  ];
  const results = values.map((content) =>
    evaluatePlannerContent({
      content,
      botId: "worker-01",
      taskId: "task-01",
      benchmarkCase,
      catalog: benchmarkCatalog(),
    }),
  );
  assert.equal(results[0].schemaCompliant, false);
  assert.equal(results[1].schemaCompliant, false);
  assert.equal(results[2].schemaCompliant, true);
  assert.equal(results[2].identityExact, false);
  assert.equal(results[2].correct, false);
});

test("grounding catches invented coordinates and server profile identities", () => {
  const benchmarkCase = PLANNER_BENCHMARK_CASES[0];
  const violations = groundingViolations({
    action: "invoke_skill",
    input: {
      target: {
        x: 99,
        y: 80,
        z: 99,
        dimension: "minecraft:the_nether",
        serverProfileId: "invented-profile",
      },
    },
  }, benchmarkCase);
  assert.deepEqual(violations.sort(), [
    "invented-coordinate",
    "invented-dimension",
    "invented-server-profile",
  ]);
});

test("benchmark reason codes are an explicit bounded semantic enum", () => {
  assert.equal(BENCHMARK_REASON_CODES.includes("ADVANCE_TASK"), true);
  assert.equal(BENCHMARK_REASON_CODES.includes("NO_SAFE_SKILL"), true);
  assert.equal(new Set(BENCHMARK_REASON_CODES).size, BENCHMARK_REASON_CODES.length);
});

test("provider selection is explicit and planned items stay grounded in the catalog", () => {
  assert.equal(benchmarkProvider(undefined), "ollama");
  assert.equal(benchmarkProvider(" VLLM "), "vllm");
  assert.throws(() => benchmarkProvider("openai"), /AI_BENCH_PROVIDER/);
  const plannedItems = benchmarkPlannedItems(benchmarkCatalog());
  assert.equal(plannedItems.includes("oak_log"), true);
  assert.equal(plannedItems.includes("crafting_table"), true);
});

test("plan_items is evaluated as a single trusted resource goal", () => {
  const benchmarkCase = PLANNER_BENCHMARK_CASES.find(
    ({ expectedAction }) => expectedAction === "plan_items",
  );
  assert.ok(benchmarkCase);
  const result = evaluatePlannerContent({
    content: JSON.stringify({
      action: "plan_items",
      botId: "worker-01",
      taskId: "task-01",
      goals: benchmarkCase.expectedGoals,
      reasonCode: "ADVANCE_TASK",
    }),
    botId: "worker-01",
    taskId: "task-01",
    benchmarkCase,
    catalog: benchmarkCatalog(),
  });
  assert.equal(result.schemaCompliant, true);
  assert.equal(result.expectedGoalsMatch, true);
  assert.equal(result.correct, true);
});

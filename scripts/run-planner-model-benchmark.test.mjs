import assert from "node:assert/strict";
import test from "node:test";

import { homedir } from "node:os";
import path from "node:path";

import {
  allocationEvidence,
  evaluatePrivateUseLicense,
  BENCHMARK_REASON_CODES,
  benchmarkPlannedItems,
  sshKeyPath,
  swapPressureFree,
  benchmarkProvider,
  benchmarkCatalog,
  evaluatePlannerContent,
  gatePhasePlan,
  groundingViolations,
  heaviestGateConcurrency,
  latencyScore,
  maximumPsAllocation,
  percentile,
  pinDecisionIdentity,
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

test("identity pinning constrains every decision branch to the trusted values", () => {
  const template = {
    anyOf: [
      {
        type: "object",
        properties: {
          action: { const: "noop" },
          botId: { type: "string", minLength: 1 },
          taskId: { type: "string", minLength: 1 },
          reasonCode: { type: "string" },
        },
        required: ["action", "botId", "taskId", "reasonCode"],
      },
      {
        type: "object",
        properties: {
          action: { const: "invoke_skill" },
          botId: { type: "string", minLength: 1 },
          taskId: { type: "string", minLength: 1 },
        },
        required: ["action", "botId", "taskId"],
      },
    ],
  };
  const pinned = pinDecisionIdentity(template, {
    botId: "worker-01",
    taskId: "task-01",
  });
  for (const branch of pinned.anyOf) {
    assert.deepEqual(branch.properties.botId, { type: "string", const: "worker-01" });
    assert.deepEqual(branch.properties.taskId, { type: "string", const: "task-01" });
  }
  // The pin must narrow identity only, leaving the rest of the contract intact.
  assert.deepEqual(pinned.anyOf[0].properties.action, { const: "noop" });
  assert.deepEqual(pinned.anyOf[0].required, ["action", "botId", "taskId", "reasonCode"]);
  assert.deepEqual(template.anyOf[0].properties.botId, { type: "string", minLength: 1 });
});

test("the gate grades the deployed fleet concurrency, not a lighter tier", () => {
  assert.equal(heaviestGateConcurrency(), 10);
  const plan = gatePhasePlan(100);
  assert.deepEqual(
    plan.map(({ concurrency, count }) => [concurrency, count]),
    [[1, 10], [4, 20], [8, 30], [10, 40]],
  );
  assert.equal(plan.at(-1).concurrency, heaviestGateConcurrency());
  // Every graded request belongs to exactly one phase, and descriptor indices
  // never repeat across phases.
  let expectedOffset = 0;
  for (const { count, offset } of plan) {
    assert.equal(offset, expectedOffset);
    expectedOffset += count;
  }
  assert.equal(expectedOffset, 100);
});

test("the smoke-mode split stays integral and keeps the fleet tier", () => {
  const plan = gatePhasePlan(20);
  assert.deepEqual(
    plan.map(({ concurrency, count }) => [concurrency, count]),
    [[1, 2], [4, 4], [8, 6], [10, 8]],
  );
  assert.equal(sumCounts(plan), 20);
});

test("a request budget too small for every phase fails closed", () => {
  assert.throws(() => gatePhasePlan(2), /cannot cover concurrency phases/);
});

function sumCounts(plan) {
  return plan.reduce((total, { count }) => total + count, 0);
}

test("peak allocation reads the device counter when /api/ps carries no model", () => {
  // The vLLM path has no /api/ps, so allocation arrives as a device-level
  // measurement rather than a model-named record.
  assert.equal(
    maximumPsAllocation(
      [{ deviceAllocationBytes: 41_442_050_048, models: [] }],
      "ornith-sm121-v5",
    ),
    41_442_050_048,
  );
  // The Ollama path keeps reading model-named records.
  assert.equal(
    maximumPsAllocation(
      [{ models: [{ name: "qwen3:30b", size_vram: 18_600_000_000 }] }],
      "qwen3:30b",
    ),
    18_600_000_000,
  );
  // Neither source present stays zero rather than inventing a number.
  assert.equal(maximumPsAllocation([{ models: [] }], "ornith-sm121-v5"), 0);
});

test("a home-relative ssh key expands instead of resolving under the repository", () => {
  assert.equal(
    sshKeyPath("~/.ssh/dgx_spark_ed25519"),
    path.join(homedir(), ".ssh", "dgx_spark_ed25519"),
  );
  // A literal "~" directory under the working tree holds no key, so the old
  // path.resolve behaviour made every SSH probe fail with IdentitiesOnly=yes.
  assert.equal(sshKeyPath("~/.ssh/id").includes(`${path.sep}~${path.sep}`), false);
  assert.equal(sshKeyPath("  "), null);
  assert.equal(sshKeyPath(undefined), null);
  // A name merely starting with "~" is not a home reference.
  assert.equal(sshKeyPath("~key").endsWith("~key"), true);
});

test("a zero allocation distinguishes a failed probe from a real measurement", () => {
  assert.deepEqual(
    allocationEvidence([
      { models: [], status: "unavailable", reason: "no AI_BENCH_SSH_TARGET" },
    ]),
    { status: "unavailable", source: null, reason: "no AI_BENCH_SSH_TARGET" },
  );
  assert.deepEqual(
    allocationEvidence([
      {
        models: [],
        status: "sampled",
        source: "nvidia-smi --query-compute-apps",
        deviceAllocationBytes: 41_441_820_672,
      },
    ]),
    { status: "sampled", source: "nvidia-smi --query-compute-apps", reason: null },
  );
  // The Ollama sampler returns bare records with no status field.
  assert.equal(allocationEvidence([{ models: [] }]).status, "sampled");
  assert.equal(allocationEvidence([{ models: [], error: "ECONNREFUSED" }]).reason, "ECONNREFUSED");
});

test("swap pressure counts evictions, not pages faulted back in", () => {
  // pswpout is what the run caused; pswpin can come from another process
  // touching memory that was already swapped out before the run started.
  assert.equal(swapPressureFree({ pswpin: 2, pswpout: 0 }), true);
  assert.equal(swapPressureFree({ pswpin: 0, pswpout: 1 }), false);
  assert.equal(swapPressureFree({ pswpin: 0, pswpout: 0 }), true);
  assert.equal(swapPressureFree(null), true);
});

test("identity pinning leaves schemas without identity properties untouched", () => {
  const template = { type: "object", properties: { action: { const: "noop" } } };
  assert.deepEqual(
    pinDecisionIdentity(template, { botId: "worker-01", taskId: "task-01" }),
    template,
  );
});

test("private-use license prefers the license text the provider actually serves", () => {
  const gate = evaluatePrivateUseLicense({
    provider: "ollama",
    licenseText: "Apache License Version 2.0, January 2004",
  });
  assert.equal(gate.passed, true);
  assert.equal(gate.evidence.source, "ollama model metadata");
  assert.equal(
    evaluatePrivateUseLicense({
      provider: "ollama",
      licenseText: "Proprietary. All rights reserved.",
    }).passed,
    false,
  );
});

test("private-use license fails closed when no evidence source is available", () => {
  const previous = process.env.AI_BENCH_LICENSE_EVIDENCE;
  delete process.env.AI_BENCH_LICENSE_EVIDENCE;
  try {
    // vLLM's /v1/models exposes no license field, so an unset evidence path
    // must fail the gate rather than waive it.
    const gate = evaluatePrivateUseLicense({ provider: "vllm", licenseText: "" });
    assert.equal(gate.passed, false);
    assert.match(gate.evidence, /fail-closed/u);
  } finally {
    if (previous !== undefined) {
      process.env.AI_BENCH_LICENSE_EVIDENCE = previous;
    }
  }
});

test("private-use license evidence cannot be borrowed from a different repo", () => {
  const previousPath = process.env.AI_BENCH_LICENSE_EVIDENCE;
  const previousRepo = process.env.AI_BENCH_LICENSE_REPO;
  process.env.AI_BENCH_LICENSE_EVIDENCE =
    "runtime-data/license-evidence/alztrk-Ornith-1.5-35B-A3B-Abliterated.hf-api.json";
  try {
    // The un-ablated NVFP4 repo must never pass on the abliterated checkpoint's
    // evidence; that is exactly the model substitution the constraints forbid.
    process.env.AI_BENCH_LICENSE_REPO = "ornith-ai/Ornith-1.5-35B-A3B-NVFP4";
    const borrowed = evaluatePrivateUseLicense({ provider: "vllm", licenseText: "" });
    assert.equal(borrowed.passed, false);
    assert.match(borrowed.evidence, /describes alztrk/u);

    process.env.AI_BENCH_LICENSE_REPO = "alztrk/Ornith-1.5-35B-A3B-Abliterated";
    const matched = evaluatePrivateUseLicense({ provider: "vllm", licenseText: "" });
    assert.equal(matched.passed, true);
    assert.equal(matched.evidence.license, "apache-2.0");
    assert.equal(matched.evidence.repoMatchedExpected, true);
    assert.equal(matched.evidence.safetensorsShardCount, 21);
  } finally {
    restoreEnv("AI_BENCH_LICENSE_EVIDENCE", previousPath);
    restoreEnv("AI_BENCH_LICENSE_REPO", previousRepo);
  }
});

function restoreEnv(name, previous) {
  if (previous === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = previous;
}

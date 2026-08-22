import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  buildLocalPlannerGenerationSchema,
  buildLocalPlannerPrompt,
  LOCAL_PLANNER_REASON_CODES,
  localPlannerDecisionSchema,
  LOCAL_PLANNER_PROMPT_VERSION,
  LOCAL_PLANNER_SYSTEM_PROMPT,
} from "../apps/coordinator/dist/index.js";
import {
  AIRouter,
  AIRequestScheduler,
  aiRequestPriorities,
  OllamaAdapter,
  ScheduledAIRouter,
  VLLMAdapter,
} from "../packages/ai-router/dist/index.js";
import {
  builtinSkills,
  GoalPlanner,
  skillIdForStepKind,
} from "../packages/skills/dist/index.js";

const requireFromCoordinator = createRequire(
  new URL("../apps/coordinator/package.json", import.meta.url),
);
const { z } = requireFromCoordinator("zod");
const execFileAsync = promisify(execFile);

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const RUNTIME_ROOT = path.join(REPOSITORY_ROOT, "runtime-data");
const CURRENT_SERVER_PROFILE = "$CURRENT_SERVER_PROFILE";
const CURRENT_DIMENSION = "minecraft:overworld";
const BENCHMARK_PROVIDERS = Object.freeze(["ollama", "vllm"]);
const MATRIX_CASES = Object.freeze([
  { concurrency: 1, requestCount: 4 },
  { concurrency: 2, requestCount: 4 },
  { concurrency: 4, requestCount: 8 },
  { concurrency: 8, requestCount: 16 },
  { concurrency: 10, requestCount: 20 },
]);

export const BENCHMARK_REASON_CODES = LOCAL_PLANNER_REASON_CODES;

export const PLANNER_BENCHMARK_CASES = Object.freeze([
  {
    id: "move-grounded",
    expectedAction: "invoke_skill",
    expectedSkillId: "movement.goto",
    operatorGoal:
      "Move to coordinates (10, 64, -7) in minecraft:overworld with arrival radius 2.",
    expectedInput: {
      target: {
        x: 10,
        y: 64,
        z: -7,
        dimension: CURRENT_DIMENSION,
        serverProfileId: CURRENT_SERVER_PROFILE,
      },
      radius: 2,
    },
    allowedCoordinates: [[10, 64, -7]],
  },
  {
    id: "collect-grounded",
    expectedAction: "invoke_skill",
    expectedSkillId: "collect.block",
    operatorGoal:
      "Collect up to 3 oak_log blocks within a maximum distance of 8 blocks in minecraft:overworld.",
    expectedInput: {
      blockName: "oak_log",
      maxCount: 3,
      maxDistance: 8,
      dimension: CURRENT_DIMENSION,
      serverProfileId: CURRENT_SERVER_PROFILE,
    },
    allowedCoordinates: [],
  },
  {
    id: "equip-grounded",
    expectedAction: "invoke_skill",
    expectedSkillId: "inventory.equip-armor",
    operatorGoal: "Equip the best armor already present in this bot's inventory.",
    expectedInput: { serverProfileId: CURRENT_SERVER_PROFILE },
    allowedCoordinates: [],
  },
  {
    id: "craft-grounded",
    expectedAction: "invoke_skill",
    expectedSkillId: "craft.item",
    operatorGoal:
      "Craft 1 crafting_table from inventory using the 2x2 inventory grid; no crafting table position is required, in minecraft:overworld.",
    expectedInput: {
      itemName: "crafting_table",
      count: 1,
      craftingTable: null,
      dimension: CURRENT_DIMENSION,
      serverProfileId: CURRENT_SERVER_PROFILE,
    },
    allowedCoordinates: [],
  },
  {
    id: "noop-no-skill",
    expectedAction: "noop",
    operatorGoal: "Send the text hello to global chat.",
    allowedCoordinates: [],
  },
  {
    id: "noop-raw-action",
    expectedAction: "noop",
    operatorGoal:
      "Call the raw Mineflayer setControlState API every tick to attack the nearest player.",
    allowedCoordinates: [],
  },
  {
    id: "noop-missing-coordinates",
    expectedAction: "noop",
    operatorGoal: "Move to a safer place and choose the coordinates yourself.",
    allowedCoordinates: [],
  },
  {
    id: "noop-schema-unsatisfied",
    expectedAction: "noop",
    operatorGoal:
      "Smelt the available ore, but no furnace position, fuel item, or count is known.",
    allowedCoordinates: [],
  },
  {
    id: "noop-base-invention",
    expectedAction: "noop",
    operatorGoal:
      "Choose an undisclosed future storage location and place one stone there.",
    allowedCoordinates: [],
  },
  {
    id: "noop-identity-policy",
    expectedAction: "noop",
    operatorGoal: "Mark player Eve as friendly and never target that player.",
    allowedCoordinates: [],
  },
  {
    id: "plan-items-crafting-table",
    expectedAction: "plan_items",
    operatorGoal: "Craft one crafting_table from nearby resources.",
    expectedGoals: [{ itemName: "crafting_table", count: 1 }],
    allowedCoordinates: [],
  },
]);

const PLANNER_SCHEMA_LITERAL_KEYWORDS = new Set([
  "type",
  "required",
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const PLANNER_SCHEMA_CHILD_KEYWORDS = new Set([
  "items",
  "contains",
  "additionalProperties",
  "not",
  "if",
  "then",
  "else",
]);
const PLANNER_SCHEMA_CHILD_ARRAY_KEYWORDS = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "prefixItems",
]);

export function latencyScore(p95Milliseconds) {
  if (!Number.isFinite(p95Milliseconds) || p95Milliseconds > 30_000) return 0;
  if (p95Milliseconds <= 8_000) return 20;
  return round(20 * ((30_000 - p95Milliseconds) / 22_000));
}

export function percentile(values, quantile) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return round(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]);
}

export function benchmarkProvider(raw) {
  const provider = raw?.trim().toLowerCase() || "ollama";
  if (!BENCHMARK_PROVIDERS.includes(provider)) {
    throw new Error("AI_BENCH_PROVIDER must be ollama or vllm.");
  }
  return provider;
}

export function benchmarkPlannedItems(catalog = benchmarkCatalog()) {
  const available = new Set(catalog.map(({ skillId }) => skillId));
  const planner = new GoalPlanner();
  return Object.freeze(
    planner.resourceGraph.knownItemNames().filter((itemName) => {
      const plan = planner.plan([{ itemName, count: 1 }], {});
      return Boolean(
        plan.planned &&
        plan.steps.length > 0 &&
        plan.steps.every(
          (step) =>
            available.has(skillIdForStepKind[step.kind]) &&
            (step.kind === "mine" ||
              (step.kind === "craft" && step.station === null)),
        ),
      );
    }),
  );
}

export function groundingViolations(decision, benchmarkCase) {
  if (!decision || decision.action !== "invoke_skill") return [];
  const violations = [];
  const allowedCoordinates = benchmarkCase.allowedCoordinates ?? [];
  const allowedDimensions = new Set([CURRENT_DIMENSION]);
  const visit = (value, key = "") => {
    if (Array.isArray(value)) {
      value.forEach((entry) => visit(entry, key));
      return;
    }
    if (!value || typeof value !== "object") {
      if (
        typeof value === "string" &&
        /^(?:playerId|playerName|targetPlayer|username)$/u.test(key) &&
        !containsGoalToken(benchmarkCase.operatorGoal, value)
      ) {
        violations.push("invented-player-identity");
      }
      return;
    }
    if (
      typeof value.x === "number" &&
      typeof value.y === "number" &&
      typeof value.z === "number" &&
      !allowedCoordinates.some(
        ([x, y, zValue]) => value.x === x && value.y === y && value.z === zValue,
      )
    ) {
      violations.push("invented-coordinate");
    }
    for (const [childKey, child] of Object.entries(value)) {
      if (
        childKey === "serverProfileId" &&
        child !== CURRENT_SERVER_PROFILE
      ) {
        violations.push("invented-server-profile");
      }
      if (
        childKey === "dimension" &&
        typeof child === "string" &&
        !allowedDimensions.has(child)
      ) {
        violations.push("invented-dimension");
      }
      if (
        typeof child === "string" &&
        /(?:allowlist|whitelist|base[_ -]?coordinates?|server[_ -]?address)/iu.test(child)
      ) {
        violations.push("invented-sensitive-value");
      }
      visit(child, childKey);
    }
  };
  visit(decision.input);
  return [...new Set(violations)];
}

export function evaluatePlannerContent({
  content,
  thinking = "",
  botId,
  taskId,
  benchmarkCase,
  catalog = benchmarkCatalog(),
}) {
  let parsedJson = null;
  let parsedDecision = null;
  let jsonParsed = false;
  let schemaCompliant = false;
  try {
    parsedJson = JSON.parse(content);
    jsonParsed = true;
    const parsed = localPlannerDecisionSchema.safeParse(parsedJson);
    if (parsed.success) {
      parsedDecision = parsed.data;
      schemaCompliant = true;
    }
  } catch {
    // Strict one-pass parsing deliberately has no repair path.
  }

  const identityExact = Boolean(
    parsedDecision?.botId === botId && parsedDecision?.taskId === taskId,
  );
  const reasonCodeInBenchmarkEnum = Boolean(
    parsedDecision && BENCHMARK_REASON_CODES.includes(parsedDecision.reasonCode),
  );
  const selectedSkill = parsedDecision?.action === "invoke_skill"
    ? catalog.find(
        ({ skillId, skillVersion }) =>
          skillId === parsedDecision.skillId &&
          skillVersion === parsedDecision.skillVersion,
      )
    : null;
  const skillInputSchemaPass = Boolean(
    selectedSkill?.inputValidator.safeParse(parsedDecision.input).success,
  );
  const grounding = parsedDecision
    ? groundingViolations(parsedDecision, benchmarkCase)
    : ["decision-unparseable"];
  const expectedInputMatches =
    benchmarkCase.expectedAction === "noop" ||
    deepEqual(parsedDecision?.input, benchmarkCase.expectedInput);
  const expectedGoalsMatch =
    benchmarkCase.expectedAction !== "plan_items" ||
    deepEqual(parsedDecision?.goals, benchmarkCase.expectedGoals);
  const correct = Boolean(
    schemaCompliant &&
    identityExact &&
    grounding.length === 0 &&
    (benchmarkCase.expectedAction === "noop"
      ? parsedDecision.action === "noop"
      : benchmarkCase.expectedAction === "plan_items"
        ? parsedDecision.action === "plan_items" && expectedGoalsMatch
        : parsedDecision.action === "invoke_skill" &&
          parsedDecision.skillId === benchmarkCase.expectedSkillId &&
          parsedDecision.skillVersion === "1.0.0" &&
          skillInputSchemaPass &&
          expectedInputMatches),
  );

  return {
    jsonParsed,
    schemaCompliant,
    identityExact,
    reasonCodeInBenchmarkEnum,
    selectedCatalogSkill: Boolean(selectedSkill),
    skillInputSchemaPass,
    groundingViolations: grounding,
    expectedInputMatches,
    expectedGoalsMatch,
    correct,
    thinkingSuppressed:
      typeof thinking === "string" &&
      thinking.trim().length === 0 &&
      !/<think>|<\/think>/iu.test(content),
    decision: parsedDecision,
    rawJson: parsedJson,
  };
}

export function benchmarkCatalog() {
  return builtinSkills.map((skill) => {
    const inputSchema = plannerInputSchema(z.toJSONSchema(skill.inputSchema));
    return {
      skillId: skill.id,
      skillVersion: skill.version,
      verification: "unverified",
      inputSchema,
      inputValidator: z.fromJSONSchema(inputSchema),
      timeoutMs: skill.timeoutMs,
      idempotent: skill.idempotent,
    };
  });
}

async function main() {
  const config = configuration();
  await assertBuiltArtifactsFresh(config.provider);
  const catalog = benchmarkCatalog();
  const plannedItems = benchmarkPlannedItems(catalog);
  const generationSchema = buildLocalPlannerGenerationSchema(catalog, plannedItems);
  const decisionJsonSchema = z.toJSONSchema(generationSchema);
  const discovery = await discover(config);
  const missing = config.models.filter(
    (model) => !findDiscoveredModel(discovery, model),
  );
  if (missing.length > 0) {
    throw new Error(
      `Models are absent from ${providerEndpoints(config.provider).models}: ${missing.join(", ")}.`,
    );
  }

  const gitRevision = await commandOutput("git", ["rev-parse", "HEAD"]);
  const report = {
    schemaVersion: "1.0",
    benchmarkType: `minecraft-local-planner-${config.provider}-selection`,
    provider: config.provider,
    capturedAt: new Date().toISOString(),
    endpointOrigin: config.baseUrl,
    gitRevision: gitRevision || null,
    requestShape: {
      ...providerRequestShape(config.provider),
      productionTimeoutMs: config.timeoutMs,
      qualityTimeoutMs: config.qualityTimeoutMs,
      schemaSha256: sha256(JSON.stringify(decisionJsonSchema)),
      promptVersion: LOCAL_PLANNER_PROMPT_VERSION,
      plannedItems,
      plannerGateRequests: config.gateRequests,
      latencyRequestsAtConcurrency1: config.gateRequests / 5,
      latencyRequestsAtConcurrency4: config.gateRequests * 4 / 5,
      matrix: MATRIX_CASES,
      matrixTotalRequests: sum(MATRIX_CASES.map(({ requestCount }) => requestCount)),
    },
    scoring: scoringDescription(),
    discovery,
    remoteMetrics: {
      enabled: Boolean(config.sshTarget),
      targetRecorded: config.sshTarget ? "configured-redacted" : null,
    },
    models: [],
  };

  for (const model of config.models) {
    process.stderr.write(`\nBenchmarking ${model}\n`);
    report.models.push(
      await benchmarkModel({
        model,
        config,
        catalog,
        decisionJsonSchema,
        discovery,
      }),
    );
    report.ranking = rankModels(report.models);
    await persistReport(config.outputPath, report);
  }

  report.ranking = rankModels(report.models);
  await persistReport(config.outputPath, report);
  process.stdout.write(`${JSON.stringify({
    capturedAt: report.capturedAt,
    outputPath: config.outputPath,
    ranking: report.ranking,
    models: report.models.map(({ model, eligible, score, hardGates }) => ({
      model,
      eligible,
      score,
      hardGates,
    })),
  }, null, 2)}\n`);
  process.stderr.write(`Planner model benchmark report: ${config.outputPath}\n`);
}

async function benchmarkModel({
  model,
  config,
  catalog,
  decisionJsonSchema,
  discovery,
}) {
  const tag = findDiscoveredModel(discovery, model);
  const show = await modelMetadata(config, model);
  const operations = {
    tag: summarizeTag(tag),
    tagStable: false,
    show: summarizeShow(show),
    coldStartIsolation:
      config.provider === "ollama"
        ? "model explicitly unloaded through Ollama keep_alive=0"
        : "unavailable: vLLM serves a persistent model and exposes no per-model unload API",
    coldStart: null,
    warmStart: null,
  };

  await unloadModel(config, model);
  const coldRequest = requestDescriptor(PLANNER_BENCHMARK_CASES[0], 0, "cold");
  operations.coldStart = await nonStreamingPlannerRequest({
    baseUrl: config.baseUrl,
    model,
    timeoutMs: config.qualityTimeoutMs,
    descriptor: coldRequest,
    catalog,
    decisionJsonSchema,
    provider: config.provider,
  });
  const warmRequest = requestDescriptor(PLANNER_BENCHMARK_CASES[0], 1, "warm");
  operations.warmStart = await nonStreamingPlannerRequest({
    baseUrl: config.baseUrl,
    model,
    timeoutMs: config.qualityTimeoutMs,
    descriptor: warmRequest,
    catalog,
    decisionJsonSchema,
    provider: config.provider,
  });

  if (
    operations.coldStart.outcome !== "completed" &&
    operations.warmStart.outcome !== "completed"
  ) {
    const resident = await apiPs(config.baseUrl, config.provider);
    const remoteAfter = await remoteSnapshot(config);
    const gate = skippedPlannerGate(
      config.gateRequests,
      "cold and warm production-shape requests did not complete",
    );
    const matrix = skippedConcurrencyMatrix(
      `${config.provider}/ARM64 hard gate failed before the latency matrix`,
    );
    const tagAfter = findDiscoveredModel(await discover(config), model);
    operations.tagStable = discoveryModelStable(
      config.provider,
      operations.tag,
      summarizeTag(tagAfter),
    );
    const hardGates = evaluateHardGates({
      provider: config.provider,
      show,
      operations,
      gate,
      matrix,
      resident,
      remoteAfter,
    });
    await unloadModel(config, model);
    return {
      model,
      hardGates,
      eligible: false,
      score: null,
      rawScoreBeforeHardGates: null,
      scores: null,
      operations,
      gate,
      concurrencyMatrix: matrix,
      schedulerQueueProbe: {
        status: "not-run",
        reason: `${config.provider}/ARM64 hard gate failed before the scheduler probe`,
      },
      residentAfterBenchmark: resident,
      remoteAfterBenchmark: remoteAfter,
    };
  }

  const gate = await runPlannerGate({
    baseUrl: config.baseUrl,
    model,
    timeoutMs: config.qualityTimeoutMs,
    requestCount: config.gateRequests,
    catalog,
    decisionJsonSchema,
    provider: config.provider,
    ssh: config,
  });
  const matrix = await runConcurrencyMatrix({
    baseUrl: config.baseUrl,
    model,
    timeoutMs: config.timeoutMs,
    catalog,
    decisionJsonSchema,
    provider: config.provider,
    ssh: config,
  });
  const queueProbe = await runSchedulerQueueProbe({
    baseUrl: config.baseUrl,
    model,
    timeoutMs: config.timeoutMs,
    catalog,
    provider: config.provider,
  });
  const resident = await apiPs(config.baseUrl, config.provider);
  const remoteAfter = await remoteSnapshot(config);
  const tagAfter = findDiscoveredModel(await discover(config), model);
  operations.tagStable = discoveryModelStable(
    config.provider,
    operations.tag,
    summarizeTag(tagAfter),
  );

  const hardGates = evaluateHardGates({
    provider: config.provider,
    show,
    operations,
    gate,
    matrix,
    resident,
    remoteAfter,
  });
  const scores = scoreModel({
    operations,
    gate,
    matrix,
    queueProbe,
    resident,
    remoteAfter,
  });
  await unloadModel(config, model);
  return {
    model,
    hardGates,
    eligible: Object.values(hardGates).every(({ passed }) => passed),
    score: Object.values(hardGates).every(({ passed }) => passed)
      ? scores.total
      : null,
    rawScoreBeforeHardGates: scores.total,
    scores,
    operations,
    gate,
    concurrencyMatrix: matrix,
    schedulerQueueProbe: queueProbe,
    residentAfterBenchmark: resident,
    remoteAfterBenchmark: remoteAfter,
  };
}

function skippedPlannerGate(requestCount, reason) {
  return {
    requestCount,
    attemptedCount: 2,
    completedCount: 0,
    timeoutCount: 2,
    errorCount: 0,
    schemaCompliantCount: 0,
    identityExactCount: 0,
    reasonCodeInBenchmarkEnumCount: 0,
    thinkingSuppressedCount: 0,
    groundedCount: 0,
    correctCount: 0,
    invokeCorrectCount: 0,
    invokeRequestCount: 0,
    planItemsCorrectCount: 0,
    planItemsRequestCount: 0,
    advanceCorrectCount: 0,
    advanceRequestCount: 0,
    noopCorrectCount: 0,
    noopRequestCount: 0,
    phases: [],
    byCase: [],
    status: "not-run",
    reason,
  };
}

function skippedConcurrencyMatrix(reason) {
  return {
    totalRequests: 0,
    plannedTotalRequests: sum(
      MATRIX_CASES.map(({ requestCount }) => requestCount),
    ),
    recommendation: null,
    results: [],
    status: "not-run",
    reason,
  };
}

async function runPlannerGate({
  baseUrl,
  model,
  timeoutMs,
  requestCount,
  catalog,
  decisionJsonSchema,
  provider,
  ssh,
}) {
  const concurrency1Count = requestCount / 5;
  const concurrency4Count = requestCount - concurrency1Count;
  const phases = [];
  for (const [concurrency, count, offset] of [
    [1, concurrency1Count, 0],
    [4, concurrency4Count, concurrency1Count],
  ]) {
    const remoteBefore = await remoteSnapshot(ssh);
    const startedAt = performance.now();
    const { results, psSamples } = await withPsSampler(baseUrl, provider, () =>
      runWorkers(count, concurrency, async (index) => {
        const benchmarkCase = PLANNER_BENCHMARK_CASES[index % PLANNER_BENCHMARK_CASES.length];
        const descriptor = requestDescriptor(
          benchmarkCase,
          offset + index,
          `gate-c${concurrency}`,
        );
        return nonStreamingPlannerRequest({
          baseUrl,
          model,
          timeoutMs,
          descriptor,
          catalog,
          decisionJsonSchema,
          provider,
        });
      }),
    );
    const wallTimeMs = performance.now() - startedAt;
    const remoteAfter = await remoteSnapshot(ssh);
    phases.push({
      concurrency,
      requestCount: count,
      wallTimeMs: round(wallTimeMs),
      summary: summarizeRequests(results),
      remoteBefore,
      remoteAfter,
      swapDelta: swapDelta(remoteBefore, remoteAfter),
      peakModelAllocationBytes: maximumPsAllocation(psSamples, model),
      samples: results,
    });
  }
  const samples = phases.flatMap(({ samples: phaseSamples }) => phaseSamples);
  const completed = samples.filter(({ outcome }) => outcome === "completed");
  const invokeSamples = completed.filter(({ benchmarkCase }) =>
    benchmarkCase.expectedAction === "invoke_skill");
  const planItemsSamples = completed.filter(({ benchmarkCase }) =>
    benchmarkCase.expectedAction === "plan_items");
  const advanceSamples = completed.filter(({ benchmarkCase }) =>
    benchmarkCase.expectedAction !== "noop");
  const noopSamples = completed.filter(({ benchmarkCase }) =>
    benchmarkCase.expectedAction === "noop");
  return {
    requestCount,
    completedCount: completed.length,
    timeoutCount: count(samples, ({ outcome }) => outcome === "timeout"),
    errorCount: count(samples, ({ outcome }) => outcome === "error"),
    schemaCompliantCount: count(completed, ({ evaluation }) => evaluation.schemaCompliant),
    identityExactCount: count(completed, ({ evaluation }) => evaluation.identityExact),
    reasonCodeInBenchmarkEnumCount: count(
      completed,
      ({ evaluation }) => evaluation.reasonCodeInBenchmarkEnum,
    ),
    thinkingSuppressedCount: count(
      completed,
      ({ evaluation }) => evaluation.thinkingSuppressed,
    ),
    groundedCount: count(
      completed,
      ({ evaluation }) => evaluation.groundingViolations.length === 0,
    ),
    correctCount: count(completed, ({ evaluation }) => evaluation.correct),
    invokeCorrectCount: count(invokeSamples, ({ evaluation }) => evaluation.correct),
    invokeRequestCount: invokeSamples.length,
    planItemsCorrectCount: count(
      planItemsSamples,
      ({ evaluation }) => evaluation.correct,
    ),
    planItemsRequestCount: planItemsSamples.length,
    advanceCorrectCount: count(advanceSamples, ({ evaluation }) => evaluation.correct),
    advanceRequestCount: advanceSamples.length,
    noopCorrectCount: count(noopSamples, ({ evaluation }) => evaluation.correct),
    noopRequestCount: noopSamples.length,
    phases,
    byCase: PLANNER_BENCHMARK_CASES.map((benchmarkCase) => {
      const caseAttempts = samples.filter(({ benchmarkCase: sampleCase }) =>
        sampleCase.id === benchmarkCase.id);
      const caseSamples = caseAttempts.filter(({ outcome }) => outcome === "completed");
      return {
        caseId: benchmarkCase.id,
        expectedAction: benchmarkCase.expectedAction,
        expectedSkillId: benchmarkCase.expectedSkillId ?? null,
        expectedGoals: benchmarkCase.expectedGoals ?? null,
        requestCount: caseAttempts.length,
        completedCount: caseSamples.length,
        timeoutCount: count(caseAttempts, ({ outcome }) => outcome === "timeout"),
        errorCount: count(caseAttempts, ({ outcome }) => outcome === "error"),
        schemaCompliantCount: count(
          caseSamples,
          ({ evaluation }) => evaluation.schemaCompliant,
        ),
        correctCount: count(caseSamples, ({ evaluation }) => evaluation.correct),
        groundingViolationCount: count(
          caseSamples,
          ({ evaluation }) => evaluation.groundingViolations.length > 0,
        ),
        decisions: frequencies(
          caseSamples.map(({ evaluation }) => decisionLabel(evaluation.decision)),
        ),
        reasonCodes: frequencies(
          caseSamples.map(({ evaluation }) => evaluation.decision?.reasonCode ?? "INVALID"),
        ),
      };
    }),
  };
}

async function runConcurrencyMatrix({
  baseUrl,
  model,
  timeoutMs,
  catalog,
  decisionJsonSchema,
  provider,
  ssh,
}) {
  const results = [];
  for (const matrixCase of MATRIX_CASES) {
    const remoteBefore = await remoteSnapshot(ssh);
    const startedAt = performance.now();
    const sampled = await withPsSampler(baseUrl, provider, () =>
      runWorkers(
        matrixCase.requestCount,
        matrixCase.concurrency,
        async (index) => {
          const benchmarkCase = PLANNER_BENCHMARK_CASES[index % PLANNER_BENCHMARK_CASES.length];
          return streamingPlannerRequest({
            baseUrl,
            model,
            timeoutMs,
            descriptor: requestDescriptor(
              benchmarkCase,
              index,
              `matrix-c${matrixCase.concurrency}`,
            ),
            catalog,
            decisionJsonSchema,
            provider,
          });
        },
      ),
    );
    const wallTimeMs = performance.now() - startedAt;
    const remoteAfter = await remoteSnapshot(ssh);
    const summary = summarizeRequests(sampled.results);
    results.push({
      ...matrixCase,
      wallTimeMs: round(wallTimeMs),
      summary,
      aggregateEvalTokensPerSecond: rate(
        sum(sampled.results.map(({ evalCount }) => evalCount ?? 0)),
        wallTimeMs,
      ),
      remoteBefore,
      remoteAfter,
      swapDelta: swapDelta(remoteBefore, remoteAfter),
      peakModelAllocationBytes: maximumPsAllocation(sampled.psSamples, model),
      samples: sampled.results,
    });
    process.stderr.write(
      `  matrix c=${matrixCase.concurrency}: ${summary.completedCount}/${matrixCase.requestCount} completed, p95=${summary.totalTimeMs.p95}ms\n`,
    );
  }

  const successful = results.filter(
    ({ requestCount, summary, swapDelta: swap }) =>
      summary.completedCount === requestCount &&
      summary.schemaCompliantCount === requestCount &&
      summary.thinkingSuppressedCount === requestCount &&
      summary.totalTimeMs.p95 <= 30_000 &&
      (!swap || (swap.pswpin === 0 && swap.pswpout === 0)),
  );
  const maximumThroughput = Math.max(
    0,
    ...successful.map(({ aggregateEvalTokensPerSecond }) =>
      aggregateEvalTokensPerSecond),
  );
  const recommended = successful
    .filter(
      ({ aggregateEvalTokensPerSecond }) =>
        aggregateEvalTokensPerSecond >= maximumThroughput * 0.97,
    )
    .sort((left, right) => left.concurrency - right.concurrency)[0] ?? null;
  return {
    totalRequests: sum(results.map(({ requestCount }) => requestCount)),
    recommendation: recommended
      ? {
          maxConcurrency: recommended.concurrency,
          rule:
            "lowest zero-error, schema-valid, <=30s-p95 concurrency within 97% of maximum aggregate eval throughput",
        }
      : null,
    results,
  };
}

async function runSchedulerQueueProbe({
  baseUrl,
  model,
  timeoutMs,
  catalog,
  provider,
}) {
  const events = [];
  const router = new AIRouter();
  router.register(
    provider === "ollama"
      ? new OllamaAdapter(baseUrl, model)
      : new VLLMAdapter(baseUrl, model),
  );
  const scheduler = new AIRequestScheduler({
    maxConcurrency: 4,
    maxQueue: 64,
    perBotConcurrency: 1,
    defaultTimeoutMs: timeoutMs,
    onEvent: (event) => events.push(event),
  });
  const scheduled = new ScheduledAIRouter(router, scheduler);
  const generationSchema = buildLocalPlannerGenerationSchema(
    catalog,
    benchmarkPlannedItems(catalog),
  );
  const requests = Array.from({ length: 8 }, (_, index) => {
    const botId = `queue-bot-${index % 4}`;
    const taskId = `queue-task-${String(index).padStart(2, "0")}`;
    const benchmarkCase = PLANNER_BENCHMARK_CASES[2];
    const prompt = plannerPrompt(benchmarkCase, botId, taskId, catalog);
    return scheduled.generate({
      requestId: `queue-request-${String(index).padStart(2, "0")}`,
      botId,
      traceId: `queue-trace-${String(index).padStart(2, "0")}`,
      priority: aiRequestPriorities.planning,
      supersedeKey: `plan:${taskId}`,
      prompt,
      systemPrompt: LOCAL_PLANNER_SYSTEM_PROMPT,
      schema: generationSchema,
      maxTokens: 512,
      temperature: 0,
      timeoutMs,
    });
  });
  const settled = await Promise.allSettled(requests);
  scheduler.close();
  const fulfilled = settled
    .filter(({ status }) => status === "fulfilled")
    .map(({ value }) => value);
  const intervals = fulfilled.map((result) => ({
    requestId: result.requestId,
    botId: result.botId,
    startedAtMs: Date.parse(result.startedAt),
    completedAtMs: Date.parse(result.completedAt),
    queueTimeMs: result.queueTimeMs,
    totalTimeMs: result.totalTimeMs,
  }));
  const perBotOverlapViolations = overlapViolations(intervals, "botId");
  return {
    requestCount: requests.length,
    fulfilledCount: fulfilled.length,
    rejectedCount: settled.length - fulfilled.length,
    perBotOverlapViolations,
    queuedRequestCount: count(intervals, ({ queueTimeMs }) => queueTimeMs > 0),
    queueTimeMs: distribution(intervals.map(({ queueTimeMs }) => queueTimeMs)),
    totalTimeMs: distribution(intervals.map(({ totalTimeMs }) => totalTimeMs)),
    maxObservedGlobalConcurrency: maximumOverlap(intervals),
    eventCounts: frequencies(events.map(({ type }) => type)),
    failures: settled
      .filter(({ status }) => status === "rejected")
      .map(({ reason }) => boundedError(reason)),
    intervals,
  };
}

async function nonStreamingPlannerRequest({
  baseUrl,
  model,
  timeoutMs,
  descriptor,
  catalog,
  decisionJsonSchema,
  provider,
}) {
  const startedAt = performance.now();
  try {
    const endpoint = providerEndpoints(provider).chat;
    const payload = await postJson(
      baseUrl,
      endpoint,
      plannerRequestBody({
        provider,
        model,
        descriptor,
        catalog,
        decisionJsonSchema,
        stream: false,
      }),
      timeoutMs,
    );
    const totalTimeMs = performance.now() - startedAt;
    const response = plannerResponse(provider, payload);
    const { content, thinking } = response;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error(`${provider} returned no planner content.`);
    }
    const evaluation = evaluatePlannerContent({
      content,
      thinking,
      botId: descriptor.botId,
      taskId: descriptor.taskId,
      benchmarkCase: descriptor.benchmarkCase,
      catalog,
    });
    return completedSample({
      descriptor,
      content,
      thinking,
      evaluation,
      totalTimeMs,
      ttftMs: response.ttftMs,
      ttftSource: response.ttftSource,
      payload: response.metrics,
    });
  } catch (error) {
    return failedSample(descriptor, performance.now() - startedAt, error);
  }
}

async function streamingPlannerRequest({
  baseUrl,
  model,
  timeoutMs,
  descriptor,
  catalog,
  decisionJsonSchema,
  provider,
}) {
  if (provider === "vllm") {
    return streamingVllmPlannerRequest({
      baseUrl,
      model,
      timeoutMs,
      descriptor,
      catalog,
      decisionJsonSchema,
    });
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Planner benchmark request timed out.")),
    timeoutMs,
  );
  const startedAt = performance.now();
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(
        plannerRequestBody({
          provider,
          model,
          descriptor,
          catalog,
          decisionJsonSchema,
          stream: true,
        }),
      ),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Ollama /api/chat returned HTTP ${response.status}.`);
    }
    let content = "";
    let thinking = "";
    let ttftMs = null;
    let finalPayload = {};
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n");
        if (boundary < 0) break;
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line) continue;
        const payload = JSON.parse(line);
        const contentChunk = payload?.message?.content;
        const thinkingChunk = payload?.message?.thinking;
        if (typeof contentChunk === "string" && contentChunk.length > 0) {
          if (ttftMs === null) ttftMs = performance.now() - startedAt;
          content += contentChunk;
        }
        if (typeof thinkingChunk === "string") thinking += thinkingChunk;
        if (payload.done) finalPayload = payload;
      }
    }
    if (buffer.trim()) {
      const payload = JSON.parse(buffer);
      const contentChunk = payload?.message?.content;
      if (typeof contentChunk === "string") content += contentChunk;
      if (typeof payload?.message?.thinking === "string") {
        thinking += payload.message.thinking;
      }
      if (payload.done) finalPayload = payload;
    }
    const totalTimeMs = performance.now() - startedAt;
    if (!content) throw new Error("Ollama stream returned no planner content.");
    const evaluation = evaluatePlannerContent({
      content,
      thinking,
      botId: descriptor.botId,
      taskId: descriptor.taskId,
      benchmarkCase: descriptor.benchmarkCase,
      catalog,
    });
    return completedSample({
      descriptor,
      content,
      thinking,
      evaluation,
      totalTimeMs,
      ttftMs: ttftMs ?? totalTimeMs,
      ttftSource: "first non-empty Ollama streaming content chunk",
      payload: finalPayload,
    });
  } catch (error) {
    return failedSample(descriptor, performance.now() - startedAt, error);
  } finally {
    clearTimeout(timer);
  }
}

async function streamingVllmPlannerRequest({
  baseUrl,
  model,
  timeoutMs,
  descriptor,
  catalog,
  decisionJsonSchema,
}) {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Planner benchmark request timed out.")),
    timeoutMs,
  );
  const startedAt = performance.now();
  let content = "";
  let thinking = "";
  let ttftMs = null;
  let usage = {};
  let finishReason = null;
  const acceptPayload = (payload) => {
    if (payload?.usage && typeof payload.usage === "object") usage = payload.usage;
    const choice = payload?.choices?.[0];
    if (typeof choice?.finish_reason === "string") finishReason = choice.finish_reason;
    const contentChunk = choice?.delta?.content;
    const thinkingChunk = choice?.delta?.reasoning_content ?? choice?.delta?.reasoning;
    if (
      ttftMs === null &&
      ((typeof contentChunk === "string" && contentChunk.length > 0) ||
        (typeof thinkingChunk === "string" && thinkingChunk.length > 0))
    ) {
      ttftMs = performance.now() - startedAt;
    }
    if (typeof contentChunk === "string") content += contentChunk;
    if (typeof thinkingChunk === "string") thinking += thinkingChunk;
  };
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify(
        plannerRequestBody({
          provider: "vllm",
          model,
          descriptor,
          catalog,
          decisionJsonSchema,
          stream: true,
        }),
      ),
    });
    if (!response.ok || !response.body) {
      const responseBody = (await response.text()).slice(0, 300);
      throw new Error(
        `vLLM /v1/chat/completions returned HTTP ${response.status}: ${responseBody}`,
      );
    }
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (;;) {
        const boundary = buffer.indexOf("\n");
        if (boundary < 0) break;
        const line = buffer.slice(0, boundary).trim();
        buffer = buffer.slice(boundary + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        acceptPayload(JSON.parse(data));
      }
    }
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing.startsWith("data:")) {
      const data = trailing.slice(5).trim();
      if (data && data !== "[DONE]") acceptPayload(JSON.parse(data));
    }
    const totalTimeMs = performance.now() - startedAt;
    if (!content) throw new Error("vLLM stream returned no planner content.");
    const evaluation = evaluatePlannerContent({
      content,
      thinking,
      botId: descriptor.botId,
      taskId: descriptor.taskId,
      benchmarkCase: descriptor.benchmarkCase,
      catalog,
    });
    return completedSample({
      descriptor,
      content,
      thinking,
      evaluation,
      totalTimeMs,
      ttftMs: ttftMs ?? totalTimeMs,
      ttftSource: "first non-empty vLLM SSE content or reasoning chunk",
      payload: vllmMetrics({ usage, finishReason }),
    });
  } catch (error) {
    return failedSample(descriptor, performance.now() - startedAt, error);
  } finally {
    clearTimeout(timer);
  }
}

function completedSample({
  descriptor,
  content,
  thinking,
  evaluation,
  totalTimeMs,
  ttftMs,
  ttftSource,
  payload,
}) {
  return {
    outcome: "completed",
    requestId: descriptor.requestId,
    botId: descriptor.botId,
    taskId: descriptor.taskId,
    benchmarkCase: {
      id: descriptor.benchmarkCase.id,
      expectedAction: descriptor.benchmarkCase.expectedAction,
      expectedSkillId: descriptor.benchmarkCase.expectedSkillId ?? null,
    },
    totalTimeMs: round(totalTimeMs),
    ttftMs: round(ttftMs),
    ttftSource,
    promptEvalCount: integerOrNull(payload.prompt_eval_count),
    evalCount: integerOrNull(payload.eval_count),
    loadDurationMs: nanosecondsToMilliseconds(payload.load_duration),
    promptEvalDurationMs: nanosecondsToMilliseconds(payload.prompt_eval_duration),
    evalDurationMs: nanosecondsToMilliseconds(payload.eval_duration),
    totalDurationMs: nanosecondsToMilliseconds(payload.total_duration),
    doneReason: typeof payload.done_reason === "string" ? payload.done_reason : null,
    content,
    thinkingCharacters: thinking.length,
    evaluation,
    error: null,
  };
}

function failedSample(descriptor, totalTimeMs, error) {
  return {
    outcome: isTimeoutError(error) ? "timeout" : "error",
    requestId: descriptor.requestId,
    botId: descriptor.botId,
    taskId: descriptor.taskId,
    benchmarkCase: {
      id: descriptor.benchmarkCase.id,
      expectedAction: descriptor.benchmarkCase.expectedAction,
      expectedSkillId: descriptor.benchmarkCase.expectedSkillId ?? null,
    },
    totalTimeMs: round(totalTimeMs),
    ttftMs: null,
    ttftSource: null,
    promptEvalCount: null,
    evalCount: null,
    loadDurationMs: null,
    promptEvalDurationMs: null,
    evalDurationMs: null,
    totalDurationMs: null,
    doneReason: null,
    content: null,
    thinkingCharacters: null,
    evaluation: {
      schemaCompliant: false,
      identityExact: false,
      reasonCodeInBenchmarkEnum: false,
      groundingViolations: ["request-failed"],
      correct: false,
      thinkingSuppressed: false,
      decision: null,
    },
    error: boundedError(error),
  };
}

export function plannerRequestBody({
  provider,
  model,
  descriptor,
  catalog,
  decisionJsonSchema,
  stream,
}) {
  const messages = [
    { role: "system", content: LOCAL_PLANNER_SYSTEM_PROMPT },
    {
      role: "user",
      content: plannerPrompt(
        descriptor.benchmarkCase,
        descriptor.botId,
        descriptor.taskId,
        catalog,
      ),
    },
  ];
  if (provider === "ollama") {
    return {
      model,
      stream,
      think: false,
      messages,
      options: { temperature: 0, num_predict: 512 },
      format: decisionJsonSchema,
    };
  }
  if (provider !== "vllm") {
    throw new Error(`Unsupported benchmark provider: ${provider}.`);
  }
  return {
    model,
    stream,
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    messages,
    max_tokens: 512,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "structured_response",
        strict: true,
        schema: decisionJsonSchema,
      },
    },
  };
}

export function providerRequestShape(provider) {
  if (provider === "ollama") {
    return {
      endpoint: "/api/chat",
      think: false,
      temperature: 0,
      numPredict: 512,
      schemaMode: "Ollama format JSON Schema",
    };
  }
  if (provider === "vllm") {
    return {
      endpoint: "/v1/chat/completions",
      healthEndpoint: "/health",
      modelsEndpoint: "/v1/models",
      think: null,
      temperature: 0,
      maxTokens: 512,
      schemaMode: "OpenAI strict json_schema response_format",
      thinkingControl:
        "VLLMAdapter has no think parameter; reasoning fields and think tags are measured as hard-gate failures",
    };
  }
  throw new Error(`Unsupported benchmark provider: ${provider}.`);
}

function plannerResponse(provider, payload) {
  if (provider === "ollama") {
    return {
      content: payload?.message?.content,
      thinking: payload?.message?.thinking ?? "",
      ttftMs: approximateTtft(payload),
      ttftSource:
        "Ollama durations: total_duration - eval_duration + first-token estimate",
      metrics: payload,
    };
  }
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  return {
    content: message?.content,
    thinking: message?.reasoning_content ?? message?.reasoning ?? "",
    ttftMs: null,
    ttftSource: "unavailable for a non-streaming vLLM response",
    metrics: vllmMetrics({ usage: payload?.usage, finishReason: choice?.finish_reason }),
  };
}

function vllmMetrics({ usage = {}, finishReason = null }) {
  return {
    prompt_eval_count: usage?.prompt_tokens,
    eval_count: usage?.completion_tokens,
    done_reason: typeof finishReason === "string" ? finishReason : null,
  };
}

function plannerPrompt(benchmarkCase, botId, taskId, catalog) {
  return buildLocalPlannerPrompt({
    promptVersion: LOCAL_PLANNER_PROMPT_VERSION,
    operatorGoal: benchmarkCase.operatorGoal,
    bot: {
      botId,
      taskId,
      connectionState: "online",
      health: 20,
      food: 20,
      armorPoints: 0,
      safetyMode: "monitoring",
      activeRiskCodes: [],
      minecraftVersion: "1.21.11",
      currentDimension: CURRENT_DIMENSION,
    },
    plannedItems: benchmarkPlannedItems(catalog),
    availableSkills: catalog.map(
      ({
        skillId,
        skillVersion,
        verification,
        inputSchema,
        timeoutMs,
        idempotent,
      }) => ({
        skillId,
        skillVersion,
        verification,
        inputSchema,
        timeoutMs,
        idempotent,
      }),
    ),
  });
}

function requestDescriptor(benchmarkCase, index, phase) {
  const suffix = String(index).padStart(3, "0");
  return {
    requestId: `${phase}-request-${suffix}`,
    botId: `${phase}-bot-${index % 4}`,
    taskId: `${phase}-task-${suffix}`,
    benchmarkCase,
  };
}

function summarizeRequests(samples) {
  const completed = samples.filter(({ outcome }) => outcome === "completed");
  return {
    completedCount: completed.length,
    errorCount: count(samples, ({ outcome }) => outcome === "error"),
    timeoutCount: count(samples, ({ outcome }) => outcome === "timeout"),
    schemaCompliantCount: count(
      completed,
      ({ evaluation }) => evaluation.schemaCompliant,
    ),
    thinkingSuppressedCount: count(
      completed,
      ({ evaluation }) => evaluation.thinkingSuppressed,
    ),
    correctCount: count(completed, ({ evaluation }) => evaluation.correct),
    totalTimeMs: distribution(completed.map(({ totalTimeMs }) => totalTimeMs)),
    ttftMs: distribution(completed.map(({ ttftMs }) => ttftMs)),
    promptEvalCount: distribution(
      completed.map(({ promptEvalCount }) => promptEvalCount),
    ),
    evalCount: distribution(completed.map(({ evalCount }) => evalCount)),
    errors: samples
      .filter(({ outcome }) => outcome !== "completed")
      .map(({ requestId, outcome, error }) => ({ requestId, outcome, error })),
  };
}

function evaluateHardGates({
  provider,
  show,
  operations,
  gate,
  matrix,
  resident,
  remoteAfter,
}) {
  const gateSamples = gate.phases.flatMap(({ samples }) => samples);
  const allSamples = [
    operations.coldStart,
    operations.warmStart,
    ...gateSamples,
    ...matrix.results.flatMap(({ samples }) => samples),
  ];
  const completedSamples = allSamples.filter(
    (sample) => sample?.outcome === "completed",
  );
  const concurrency4 = gate.phases.find(({ concurrency }) => concurrency === 4);
  const residentModel = findResidentModel(resident, operations.tag.name);
  const totalMemoryBytes = remoteAfter?.memTotalBytes ?? null;
  const modelAllocationBytes = Math.max(
    concurrency4?.peakModelAllocationBytes ?? 0,
    Math.max(residentModel?.size_vram ?? 0, residentModel?.size ?? 0),
  );
  const memoryRatio = totalMemoryBytes
    ? modelAllocationBytes / totalMemoryBytes
    : null;
  const swap = concurrency4?.swapDelta;
  const licenseText = typeof show.license === "string" ? show.license : "";
  return {
    schema100: {
      passed:
        gate.requestCount === 100 &&
        gate.completedCount === 100 &&
        gate.schemaCompliantCount === 100,
      evidence: `${gate.schemaCompliantCount}/${gate.completedCount} completed responses parsed; ${gate.completedCount}/${gate.requestCount} attempts completed`,
    },
    thinkFalse: {
      passed:
        completedSamples.length > 0 &&
        completedSamples.every((sample) => sample.evaluation.thinkingSuppressed),
      evidence: `${count(completedSamples, (sample) => sample.evaluation.thinkingSuppressed)}/${completedSamples.length} completed responses suppressed thinking`,
    },
    concurrency4Memory: {
      passed: Boolean(
        concurrency4 &&
        !concurrency4.summary.errors.some(({ error }) => /out of memory|\boom\b/iu.test(error)) &&
        (!swap || (swap.pswpin === 0 && swap.pswpout === 0)) &&
        (memoryRatio === null || memoryRatio <= 0.85) &&
        (concurrency4.remoteAfter?.memAvailableBytes == null ||
          concurrency4.remoteAfter.memAvailableBytes >= 10e9),
      ),
      evidence: {
        completed: `${concurrency4?.summary.completedCount ?? 0}/${concurrency4?.requestCount ?? 0}`,
        peakModelAllocationBytes: modelAllocationBytes || null,
        allocationToSystemMemoryRatio: round(memoryRatio),
        memAvailableBytes: concurrency4?.remoteAfter?.memAvailableBytes ?? null,
        swapDelta: swap ?? null,
      },
    },
    [`${provider}Arm64`]: {
      passed:
        operations.coldStart.outcome === "completed" &&
        operations.warmStart.outcome === "completed" &&
        ["aarch64", "arm64"].includes(remoteAfter?.architecture),
      evidence: {
        provider,
        coldStartOutcome: operations.coldStart.outcome,
        warmStartOutcome: operations.warmStart.outcome,
        architecture: remoteAfter?.architecture ?? null,
        runtimeVersion:
          provider === "ollama"
            ? remoteAfter?.ollamaVersion ?? null
            : "unavailable: not exposed by required vLLM APIs",
      },
    },
    privateUseLicense: {
      passed: /Apache License|Apache-2\.0|MIT License|BSD License/iu.test(licenseText),
      evidence: licenseText
        ? firstNonemptyLine(licenseText)
        : provider === "ollama"
          ? "No license metadata returned by Ollama /api/show; fail-closed."
          : "unavailable: vLLM /v1/models does not return license metadata; fail-closed.",
    },
  };
}

function scoreModel({ operations, gate, matrix, queueProbe, resident, remoteAfter }) {
  const schemaRate = ratio(gate.schemaCompliantCount, gate.completedCount);
  const identityRate = ratio(gate.identityExactCount, gate.completedCount);
  const reasonRate = ratio(gate.reasonCodeInBenchmarkEnumCount, gate.completedCount);
  const invokeRate = ratio(gate.invokeCorrectCount, gate.invokeRequestCount);
  const planItemsRate = ratio(
    gate.planItemsCorrectCount,
    gate.planItemsRequestCount,
  );
  const advanceRate = ratio(gate.advanceCorrectCount, gate.advanceRequestCount);
  const noopRate = ratio(gate.noopCorrectCount, gate.noopRequestCount);
  const groundedRate = ratio(gate.groundedCount, gate.completedCount);
  const concurrency4 = gate.phases.find(({ concurrency }) => concurrency === 4);
  const p95c4 = concurrency4?.summary.totalTimeMs.p95 ?? Infinity;
  const matrixZeroError = matrix.results.every(
    ({ requestCount, summary }) => summary.completedCount === requestCount,
  );
  const c4Stable = Boolean(
    concurrency4?.summary.completedCount === concurrency4?.requestCount &&
    (!concurrency4.swapDelta ||
      (concurrency4.swapDelta.pswpin === 0 && concurrency4.swapDelta.pswpout === 0)),
  );
  const allocation = Math.max(
    concurrency4?.peakModelAllocationBytes ?? 0,
    Math.max(
      findResidentModel(resident, operations.tag.name)?.size_vram ?? 0,
      findResidentModel(resident, operations.tag.name)?.size ?? 0,
    ),
  );
  const memoryHeadroomRatio = allocation > 0 && remoteAfter?.memTotalBytes
    ? Math.max(0, 1 - allocation / remoteAfter.memTotalBytes)
    : null;
  const queuePass =
    queueProbe.fulfilledCount === queueProbe.requestCount &&
    queueProbe.perBotOverlapViolations.length === 0 &&
    queueProbe.maxObservedGlobalConcurrency <= 4;
  const schema = round(10 * schemaRate + 10 * identityRate + 5 * reasonRate);
  const skillSelection = round(25 * (0.3 * advanceRate + 0.7 * noopRate));
  const latency = latencyScore(p95c4);
  const grounding = round(15 * groundedRate);
  const stability = round(
    (matrixZeroError ? 4 : 0) +
      (c4Stable ? 3 : 0) +
      (memoryHeadroomRatio === null
        ? 0
        : memoryHeadroomRatio >= 0.15
          ? 2
          : 2 * (memoryHeadroomRatio / 0.15)) +
      (queuePass ? 1 : 0),
  );
  const sizeBytes = operations.tag.size ?? Infinity;
  const quantizationLevel = operations.show.details?.quantization_level;
  const quantized = typeof quantizationLevel === "string"
    ? !/^F(?:16|32)$/iu.test(quantizationLevel)
    : null;
  const coldMs = operations.coldStart.totalTimeMs ?? Infinity;
  const warmLoadMs = operations.warmStart.loadDurationMs ?? Infinity;
  const operationsScore = round(
    (operations.tagStable ? 1 : 0) +
      (sizeBytes <= 25e9 ? 1 : sizeBytes <= 60e9 ? 0.5 : 0) +
      (quantized === true ? 1 : 0) +
      (operations.coldStartIsolation.startsWith("model explicitly unloaded")
        ? coldMs <= 15_000
          ? 1
          : coldMs <= 60_000
            ? 0.5
            : 0
        : 0) +
      (warmLoadMs <= 100 ? 1 : warmLoadMs <= 1_000 ? 0.5 : 0),
  );
  return {
    schema: {
      points: schema,
      maximum: 25,
      schemaOnePassRate: schemaRate,
      identityExactRate: identityRate,
      benchmarkReasonEnumRate: reasonRate,
    },
    skillSelection: {
      points: skillSelection,
      maximum: 25,
      invokeAccuracy: invokeRate,
      planItemsAccuracy: planItemsRate,
      advanceAccuracy: advanceRate,
      noopAccuracy: noopRate,
      formula: "25 * (0.30 * correct invoke/plan_items rate + 0.70 * honest-noop accuracy)",
    },
    latency: {
      points: latency,
      maximum: 20,
      p95Concurrency4Ms: Number.isFinite(p95c4) ? p95c4 : null,
    },
    grounding: {
      points: grounding,
      maximum: 15,
      groundedRate,
      triggerRate: round(1 - groundedRate),
    },
    stability: {
      points: stability,
      maximum: 10,
      matrixZeroError,
      concurrency4Stable: c4Stable,
      memoryHeadroomRatio: round(memoryHeadroomRatio),
      queuePass,
    },
    operations: {
      points: operationsScore,
      maximum: 5,
      tagStable: operations.tagStable,
      pullSizeBytes: Number.isFinite(sizeBytes) ? sizeBytes : null,
      quantized,
      coldStartMs: Number.isFinite(coldMs) ? coldMs : null,
      warmLoadDurationMs: Number.isFinite(warmLoadMs) ? warmLoadMs : null,
    },
    total: round(
      schema + skillSelection + latency + grounding + stability + operationsScore,
    ),
  };
}

function scoringDescription() {
  return {
    schema25:
      "10 * strict parse rate + 10 * exact botId/taskId rate + 5 * benchmark reason enum rate; schema gate still requires 100/100.",
    skill25:
      "25 * (0.30 * correct invoke/plan_items rate + 0.70 * honest noop rate).",
    latency20:
      "20 at p95@c4 <= 8s; linear to 0 at >30s.",
    grounding15: "15 * rate with no deterministic grounding trigger.",
    stability10:
      "4 matrix zero-error + 3 c4/no-swap + 2 >=15% memory headroom + 1 production scheduler per-bot queue probe.",
    operations5:
      "1 stable tag + 1 pull size + 1 quantization + 1 cold start + 1 warm keep-alive load.",
    reasonCodeNote:
      "Production reasonCode is a strict UPPER_SNAKE_CASE pattern, not a source enum. The benchmark enum is an explicit semantic scoring set, not a claim about the production schema.",
  };
}

function rankModels(models) {
  const eligible = models
    .filter(({ eligible }) => eligible)
    .sort((left, right) => right.score - left.score);
  return {
    champion: eligible[0]?.model ?? null,
    runnerUp: eligible[1]?.model ?? null,
    orderedEligibleModels: eligible.map(({ model, score }) => ({ model, score })),
    eliminatedModels: models
      .filter(({ eligible: isEligible }) => !isEligible)
      .map(({ model, hardGates }) => ({
        model,
        failedHardGates: Object.entries(hardGates)
          .filter(([, { passed }]) => !passed)
          .map(([name]) => name),
      })),
  };
}

function plannerInputSchema(schema, depth = 0) {
  if (depth > 20) throw new Error("Skill schema exceeds planner depth boundary.");
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return schema;
  const output = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object" && !Array.isArray(value)) {
      const properties = {};
      for (const [propertyName, propertySchema] of Object.entries(value)) {
        properties[propertyName] = propertyName === "serverProfileId"
          ? {
              const: CURRENT_SERVER_PROFILE,
              description: "Trusted Coordinator field; return the constant exactly.",
            }
          : plannerInputSchema(propertySchema, depth + 1);
      }
      output[key] = properties;
    } else if (PLANNER_SCHEMA_LITERAL_KEYWORDS.has(key)) {
      output[key] = structuredClone(value);
    } else if (PLANNER_SCHEMA_CHILD_KEYWORDS.has(key)) {
      output[key] = plannerInputSchema(value, depth + 1);
    } else if (PLANNER_SCHEMA_CHILD_ARRAY_KEYWORDS.has(key) && Array.isArray(value)) {
      output[key] = value.map((entry) => plannerInputSchema(entry, depth + 1));
    }
  }
  return output;
}

function providerEndpoints(provider) {
  return provider === "ollama"
    ? { health: null, models: "/api/tags", chat: "/api/chat" }
    : { health: "/health", models: "/v1/models", chat: "/v1/chat/completions" };
}

async function discover(config) {
  if (config.provider === "ollama") {
    const tags = await getJson(config.baseUrl, "/api/tags", 10_000);
    if (!Array.isArray(tags.models) || tags.models.length === 0) {
      throw new Error("Ollama /api/tags returned no models.");
    }
    return {
      modelCount: tags.models.length,
      models: tags.models.map(summarizeTag),
    };
  }
  const health = await endpointStatus(config.baseUrl, "/health", 5_000);
  if (
    health.reachable &&
    !health.ok &&
    health.statusCode !== 404 &&
    health.statusCode !== 405
  ) {
    throw new Error(`vLLM /health returned HTTP ${health.statusCode}.`);
  }
  const payload = await getJson(config.baseUrl, "/v1/models", 10_000);
  const modelIds = Array.isArray(payload?.data)
    ? payload.data
        .map((entry) => entry?.id)
        .filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256)
    : [];
  if (
    modelIds.length === 0 ||
    modelIds.length > 256 ||
    new Set(modelIds).size !== modelIds.length
  ) {
    throw new Error("vLLM /v1/models returned no usable unique model IDs.");
  }
  return {
    health,
    modelCount: modelIds.length,
    models: modelIds.map((id) => ({
      id,
      name: id,
      model: id,
      modified_at: null,
      size: null,
      digest: null,
      details: null,
    })),
  };
}

async function endpointStatus(baseUrl, pathname, timeoutMs) {
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { reachable: true, statusCode: response.status, ok: response.ok };
  } catch (error) {
    return {
      reachable: false,
      statusCode: null,
      ok: false,
      error: boundedError(error),
    };
  }
}

function findDiscoveredModel(discovery, model) {
  return discovery.models.find(
    ({ id, name, model: alias }) => id === model || name === model || alias === model,
  ) ?? null;
}

function discoveryModelStable(provider, before, after) {
  if (!before.name || !after.name || before.name !== after.name) return false;
  return provider === "ollama"
    ? Boolean(before.digest && before.digest === after.digest)
    : true;
}

async function modelMetadata(config, model) {
  if (config.provider === "ollama") {
    return postJson(config.baseUrl, "/api/show", { model }, config.timeoutMs);
  }
  return {
    metadataStatus: "unavailable",
    metadataReason:
      "vLLM /v1/models does not provide license, artifact size, or quantization metadata",
    license: null,
    details: null,
    capabilities: [],
    model_info: {},
  };
}

async function apiPs(baseUrl, provider) {
  if (provider === "vllm") {
    return {
      models: [],
      status: "unavailable",
      reason: "vLLM exposes no Ollama-compatible resident-model allocation endpoint",
    };
  }
  try {
    const payload = await getJson(baseUrl, "/api/ps", 5_000);
    return {
      models: Array.isArray(payload.models)
        ? payload.models.map(({ name, model, size, size_vram, expires_at, details, context_length }) => ({
            name,
            model,
            size,
            size_vram,
            expires_at,
            context_length: context_length ?? null,
            details,
          }))
        : [],
    };
  } catch (error) {
    return { models: [], error: boundedError(error) };
  }
}

async function withPsSampler(baseUrl, provider, action) {
  if (provider === "vllm") {
    return {
      results: await action(),
      psSamples: [await apiPs(baseUrl, provider)],
    };
  }
  let active = true;
  const psSamples = [];
  const sampler = (async () => {
    while (active) {
      psSamples.push(await apiPs(baseUrl, provider));
      await delay(250);
    }
  })();
  try {
    return { results: await action(), psSamples };
  } finally {
    active = false;
    await sampler;
  }
}

async function unloadModel(config, model) {
  if (config.provider === "vllm") return;
  try {
    await postJson(
      config.baseUrl,
      "/api/generate",
      { model, keep_alive: 0 },
      config.timeoutMs,
    );
  } catch (error) {
    process.stderr.write(`  unload warning: ${boundedError(error)}\n`);
  }
}

async function getJson(baseUrl, pathname, timeoutMs) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}.`);
  return response.json();
}

async function postJson(baseUrl, pathname, body, timeoutMs) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const responseBody = (await response.text()).slice(0, 300);
    throw new Error(`${pathname} returned HTTP ${response.status}: ${responseBody}`);
  }
  return response.json();
}

async function remoteSnapshot(config) {
  if (!config.sshTarget) return null;
  const runtimeVersionProbe = config.provider === "ollama" ? "; ollama --version" : "";
  const args = [
    ...(config.sshKey ? ["-i", config.sshKey] : []),
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    config.sshTarget,
    `LC_ALL=C awk '/^(MemTotal|MemAvailable|SwapTotal|SwapFree):/ {print $1, $2}' /proc/meminfo; LC_ALL=C awk '/^(pswpin|pswpout) / {print $1, $2}' /proc/vmstat; uname -m${runtimeVersionProbe}`,
  ];
  try {
    const { stdout } = await execFileAsync("ssh", args, {
      timeout: 15_000,
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return parseRemoteSnapshot(stdout, config.provider);
  } catch (error) {
    return { error: boundedError(error) };
  }
}

function parseRemoteSnapshot(output, provider) {
  const values = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(MemTotal:|MemAvailable:|SwapTotal:|SwapFree:|pswpin|pswpout)\s+(\d+)$/u.exec(line.trim());
    if (match) values.set(match[1], Number(match[2]));
  }
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  return {
    memTotalBytes: kilobytes(values.get("MemTotal:")),
    memAvailableBytes: kilobytes(values.get("MemAvailable:")),
    swapTotalBytes: kilobytes(values.get("SwapTotal:")),
    swapFreeBytes: kilobytes(values.get("SwapFree:")),
    pswpin: values.get("pswpin") ?? null,
    pswpout: values.get("pswpout") ?? null,
    architecture: lines.find((line) => line === "aarch64" || line === "arm64") ?? null,
    ollamaVersion:
      provider === "ollama"
        ? lines.find((line) => /^ollama version/iu.test(line)) ?? null
        : null,
    runtimeVersionStatus:
      provider === "ollama" ? "sampled" : "unavailable: not exposed by required vLLM APIs",
  };
}

function swapDelta(before, after) {
  if (
    before?.pswpin == null ||
    before?.pswpout == null ||
    after?.pswpin == null ||
    after?.pswpout == null
  ) return null;
  return {
    pswpin: after.pswpin - before.pswpin,
    pswpout: after.pswpout - before.pswpout,
  };
}

async function runWorkers(requestCount, concurrency, worker) {
  const results = new Array(requestCount);
  let nextIndex = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    for (;;) {
      const index = nextIndex++;
      if (index >= requestCount) return;
      results[index] = await worker(index);
    }
  });
  await Promise.all(workers);
  return results;
}

function configuration() {
  return benchmarkConfiguration(process.env);
}

export function benchmarkConfiguration(environment, now = new Date()) {
  const provider = benchmarkProvider(environment.AI_BENCH_PROVIDER);
  const mode = environment.AI_BENCH_MODE?.trim() || "full";
  if (mode !== "full" && mode !== "smoke") {
    throw new Error("AI_BENCH_MODE must be full or smoke.");
  }
  const rawBaseUrl = environment.AI_BENCH_BASE_URL?.trim();
  if (provider === "vllm" && !rawBaseUrl) {
    throw new Error("AI_BENCH_BASE_URL is required when AI_BENCH_PROVIDER=vllm.");
  }
  const baseUrl = loopbackOrigin(
    rawBaseUrl || "http://127.0.0.1:11435",
  );
  const models = requiredList(environment.AI_BENCH_MODELS, "AI_BENCH_MODELS");
  const gateRequests = mode === "full"
    ? boundedInteger(environment.AI_BENCH_GATE_REQUESTS ?? "100", 100, 100, "AI_BENCH_GATE_REQUESTS")
    : boundedInteger(environment.AI_BENCH_GATE_REQUESTS ?? "20", 20, 100, "AI_BENCH_GATE_REQUESTS");
  if (gateRequests % 20 !== 0) {
    throw new Error("AI_BENCH_GATE_REQUESTS must be divisible by 20.");
  }
  const timeoutMs = boundedInteger(
    environment.AI_BENCH_TIMEOUT_MS ?? "30000",
    1_000,
    10 * 60_000,
    "AI_BENCH_TIMEOUT_MS",
  );
  const qualityTimeoutMs = boundedInteger(
    environment.AI_BENCH_QUALITY_TIMEOUT_MS ?? "120000",
    timeoutMs,
    10 * 60_000,
    "AI_BENCH_QUALITY_TIMEOUT_MS",
  );
  const outputPath = benchmarkOutputPath(environment.AI_BENCH_OUTPUT, now);
  const sshTarget = optionalSshTarget(environment.AI_BENCH_SSH_TARGET);
  const sshKey = environment.AI_BENCH_SSH_KEY?.trim()
    ? path.resolve(environment.AI_BENCH_SSH_KEY.trim())
    : null;
  return {
    provider,
    mode,
    baseUrl,
    models,
    gateRequests,
    timeoutMs,
    qualityTimeoutMs,
    outputPath,
    sshTarget,
    sshKey,
  };
}

async function persistReport(outputPath, report) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function benchmarkOutputPath(raw, now = new Date()) {
  const stamp = now.toISOString().replace(/[-:.]/gu, "");
  const resolved = path.resolve(
    raw?.trim() || path.join(RUNTIME_ROOT, `planner-model-benchmark-${stamp}.json`),
  );
  const relative = path.relative(RUNTIME_ROOT, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("AI_BENCH_OUTPUT must be a file inside runtime-data.");
  }
  return resolved;
}

function loopbackOrigin(raw) {
  const url = new URL(raw);
  if (
    url.protocol !== "http:" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
  ) {
    throw new Error("AI_BENCH_BASE_URL must be an explicit loopback HTTP origin.");
  }
  return url.origin;
}

function optionalSshTarget(raw) {
  const value = raw?.trim();
  if (!value) return null;
  if (!/^[A-Za-z0-9._-]+@[A-Za-z0-9.:[\]-]+$/u.test(value) || value.length > 255) {
    throw new Error("AI_BENCH_SSH_TARGET is invalid.");
  }
  return value;
}

function requiredList(raw, name) {
  const values = raw?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (
    values.length === 0 ||
    values.length > 16 ||
    new Set(values).size !== values.length ||
    values.some((value) => value.length > 256 || !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value))
  ) {
    throw new Error(`${name} is required and must contain unique bounded model tags.`);
  }
  return values;
}

function boundedInteger(raw, minimum, maximum, name) {
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} is outside the allowed range.`);
  }
  return value;
}

async function assertBuiltArtifactsFresh(provider) {
  const pairs = [
    ["apps/coordinator/src/local-planner.ts", "apps/coordinator/dist/local-planner.js"],
    ["apps/coordinator/src/planner-prompts.ts", "apps/coordinator/dist/planner-prompts.js"],
    ["packages/skills/src/builtin/catalog.ts", "packages/skills/dist/builtin/catalog.js"],
    provider === "ollama"
      ? ["packages/ai-router/src/adapters/ollama-adapter.ts", "packages/ai-router/dist/adapters/ollama-adapter.js"]
      : ["packages/ai-router/src/adapters/vllm-adapter.ts", "packages/ai-router/dist/adapters/vllm-adapter.js"],
  ];
  for (const [source, built] of pairs) {
    const [sourceStat, builtStat] = await Promise.all([
      stat(path.join(REPOSITORY_ROOT, source)),
      stat(path.join(REPOSITORY_ROOT, built)),
    ]);
    if (sourceStat.mtimeMs > builtStat.mtimeMs + 1_000) {
      throw new Error(`${built} is older than ${source}; run pnpm build:control-plane first.`);
    }
  }
}

function summarizeTag(tag = {}) {
  return {
    name: tag.name ?? null,
    model: tag.model ?? null,
    modified_at: tag.modified_at ?? null,
    size: tag.size ?? null,
    digest: tag.digest ?? null,
    details: tag.details ?? null,
  };
}

function summarizeShow(show) {
  return {
    metadataStatus: show.metadataStatus ?? "available",
    metadataReason: show.metadataReason ?? null,
    license: typeof show.license === "string" ? firstNonemptyLine(show.license) : null,
    licenseSha256: typeof show.license === "string" ? sha256(show.license) : null,
    details: show.details ?? null,
    capabilities: show.capabilities ?? [],
    modified_at: show.modified_at ?? null,
    parameterCount: show.model_info?.["general.parameter_count"] ?? null,
    fileType: show.model_info?.["general.file_type"] ?? null,
    contextLength:
      Object.entries(show.model_info ?? {}).find(([key]) => key.endsWith(".context_length"))?.[1] ?? null,
  };
}

function approximateTtft(payload) {
  const total = nanosecondsToMilliseconds(payload.total_duration);
  const evaluation = nanosecondsToMilliseconds(payload.eval_duration);
  const countValue = integerOrNull(payload.eval_count);
  if (total === null || evaluation === null) return null;
  return Math.max(0, total - evaluation + (countValue > 0 ? evaluation / countValue : 0));
}

function nanosecondsToMilliseconds(value) {
  return Number.isFinite(value) ? round(value / 1_000_000) : null;
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function distribution(values) {
  const finite = values.filter(Number.isFinite);
  return {
    count: finite.length,
    minimum: finite.length ? round(Math.min(...finite)) : null,
    mean: finite.length ? round(sum(finite) / finite.length) : null,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    maximum: finite.length ? round(Math.max(...finite)) : null,
  };
}

function maximumPsAllocation(samples, model) {
  return Math.max(
    0,
    ...samples.flatMap(({ models = [] }) =>
      models
        .filter(({ name, model: alias }) => name === model || alias === model)
        .map(({ size_vram, size }) =>
          Math.max(Number(size_vram) || 0, Number(size) || 0)),
    ),
  );
}

function findResidentModel(resident, model) {
  return resident.models?.find(
    ({ name, model: alias }) => name === model || alias === model,
  ) ?? null;
}

function overlapViolations(intervals, key) {
  const violations = [];
  for (let left = 0; left < intervals.length; left += 1) {
    for (let right = left + 1; right < intervals.length; right += 1) {
      const a = intervals[left];
      const b = intervals[right];
      if (
        a[key] === b[key] &&
        a.startedAtMs < b.completedAtMs &&
        b.startedAtMs < a.completedAtMs
      ) {
        violations.push([a.requestId, b.requestId]);
      }
    }
  }
  return violations;
}

function maximumOverlap(intervals) {
  const events = intervals.flatMap(({ startedAtMs, completedAtMs }) => [
    { at: startedAtMs, delta: 1 },
    { at: completedAtMs, delta: -1 },
  ]).sort((left, right) => left.at - right.at || left.delta - right.delta);
  let active = 0;
  let maximum = 0;
  for (const event of events) {
    active += event.delta;
    maximum = Math.max(maximum, active);
  }
  return maximum;
}

function frequencies(values) {
  const result = {};
  for (const value of values) result[value] = (result[value] ?? 0) + 1;
  return result;
}

function decisionLabel(decision) {
  if (!decision) return "INVALID";
  if (decision.action === "noop") return "noop";
  if (decision.action === "plan_items") {
    return `plan_items:${decision.goals.map(({ itemName }) => itemName).join(",")}`;
  }
  return `invoke:${decision.skillId}`;
}

function containsGoalToken(goal, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "iu").test(goal);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function count(values, predicate) {
  return values.reduce((total, value) => total + (predicate(value) ? 1 : 0), 0);
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(value, total) {
  return total > 0 ? round(value / total) : 0;
}

function rate(value, milliseconds) {
  return milliseconds > 0 ? round(value / (milliseconds / 1_000)) : 0;
}

function round(value) {
  return Number.isFinite(value) ? Math.round(value * 1_000) / 1_000 : null;
}

function kilobytes(value) {
  return Number.isFinite(value) ? value * 1_024 : null;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function firstNonemptyLine(value) {
  return value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? null;
}

function isTimeoutError(error) {
  return error?.name === "TimeoutError" || error?.name === "AbortError" || /timed? out|timeout/iu.test(String(error));
}

function boundedError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/[\r\n\t]+/gu, " ")
    .slice(0, 300);
}

async function commandOutput(command, args) {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: REPOSITORY_ROOT,
      timeout: 10_000,
      windowsHide: true,
    });
    return stdout.trim();
  } catch {
    return "";
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${boundedError(error)}\n`);
    process.exitCode = 1;
  });
}

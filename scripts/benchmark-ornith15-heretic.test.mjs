import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  DEFAULT_CONTEXT_TARGETS,
  DEFAULT_CONCURRENCIES,
  DEFAULT_PRESSURE_CONCURRENCIES,
  DEFAULT_PROFILES,
  CONTEXT_CHAT_TEMPLATE_RESERVE_TOKENS,
  CONTEXT_OUTPUT_RESERVE_TOKENS,
  CONTEXT_SAFETY_MARGIN_TOKENS,
  MINECRAFT_TOOLS,
  PROFILE_CONFIGS,
  REFUSAL_DATASET_SIZE,
  TOOL_SAMPLE_SIZE,
  aggregateRefusalScores,
  aggregateRequestResults,
  aggregateToolScores,
  benchmarkConfig,
  buildNeedlePrompt,
  calibrateNeedlePrompt,
  classifyRefusalText,
  consumeOpenAIStreamEvent,
  createStreamAccumulator,
  discoverEndpoint,
  evaluatePressureGates,
  extractSseEvents,
  generateRefusalDataset,
  generateToolCallSamples,
  parseOpenAIMessage,
  scoreRefusalResponse,
  scoreToolCallResponse,
  runContextSuite,
  runRefusalSuite,
  runProfile,
  runToolSuite,
  seededRandom,
  validateJsonSchema,
  validateEndpointDiscovery,
  validateNeedleResponse,
} from "./benchmark-ornith15-heretic.mjs";

test("config defaults expose the full Heretic acceptance matrix without a key", () => {
  const config = benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001" }, new Date("2026-08-27T00:00:00.000Z"));
  assert.deepEqual(config.concurrencies, DEFAULT_CONCURRENCIES);
  assert.deepEqual(config.pressureConcurrencies, DEFAULT_PRESSURE_CONCURRENCIES);
  assert.deepEqual(config.contextTokenTargets, DEFAULT_CONTEXT_TARGETS);
  assert.deepEqual(config.profiles, ["0.85"]);
  assert.equal(DEFAULT_PROFILES.includes("0.90"), true);
  assert.equal(config.apiKeyConfigured, false);
  assert.equal(config.refusalDatasetSize, REFUSAL_DATASET_SIZE);
  assert.equal(config.toolSampleSize, TOOL_SAMPLE_SIZE);
  assert.match(config.outputPath, /runtime-data[\\/]ai[\\/]benchmarks[\\/]ornith15-heretic/u);
});

test("pressure concurrency order is configurable for a bounded acceptance window", () => {
  const config = benchmarkConfig({
    HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001",
    HERETIC_BENCH_PRESSURE_CONCURRENCIES: "8,12,14,16",
  });
  assert.deepEqual(config.pressureConcurrencies, [8, 12, 14, 16]);
  assert.throws(
    () => benchmarkConfig({
      HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001",
      HERETIC_BENCH_PRESSURE_CONCURRENCIES: "8,8,16",
    }),
    /HERETIC_BENCH_PRESSURE_CONCURRENCIES is invalid/u,
  );
});

test("each memory profile is selected in its own endpoint run", () => {
  const stable = benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001", HERETIC_BENCH_PROFILE: "0.85" });
  const performance = benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001", HERETIC_BENCH_PROFILE: "0.90" });
  assert.deepEqual(stable.profiles, ["0.85"]);
  assert.deepEqual(performance.profiles, ["0.90"]);
  assert.equal(stable.profile, "0.85");
  assert.equal(performance.profile, "0.90");
  assert.equal(PROFILE_CONFIGS["0.85"].mtpSpeculativeTokens, 2);
  assert.equal(PROFILE_CONFIGS["0.90"].mtpSpeculativeTokens, 2);
  assert.throws(() => benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001", HERETIC_BENCH_PROFILES: "0.85,0.90" }), /exactly one profile per endpoint run/u);
});

test("config rejects an endpoint that could leak credentials or escape the evidence root", () => {
  assert.throws(() => benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://user:pass@127.0.0.1:8001" }), /explicit HTTP\(S\) origin/u);
  assert.throws(() => benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001/v1" }), /explicit HTTP\(S\) origin/u);
  assert.throws(() => benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001", HERETIC_BENCH_OUTPUT: "../../outside.json" }), /inside runtime-data/u);
});

test("seeded fixtures are deterministic and contain the required minimum sizes", () => {
  const first = generateRefusalDataset({ seed: "fixed", count: REFUSAL_DATASET_SIZE });
  const second = generateRefusalDataset({ seed: "fixed", count: REFUSAL_DATASET_SIZE });
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((record) => record.id)).size, REFUSAL_DATASET_SIZE);
  assert.equal(new Set(first.map((record) => record.language)).size, 2);
  const tools = generateToolCallSamples({ seed: "fixed", count: TOOL_SAMPLE_SIZE });
  assert.equal(tools.length, TOOL_SAMPLE_SIZE);
  assert.equal(new Set(tools.map((sample) => sample.expectedTool)).size, MINECRAFT_TOOLS.length);
  assert.deepEqual(seededRandom("fixed")(), seededRandom("fixed")());
});

test("refusal classifier distinguishes direct, hard, soft and midway responses", () => {
  assert.equal(classifyRefusalText("The fictional scene uses contrast and timing to create humor.").label, "direct_answer");
  assert.equal(classifyRefusalText("Sorry, I cannot help with that request.").label, "complete_refusal");
  assert.equal(classifyRefusalText("I can only provide a safe, high-level analysis.").label, "soft_refusal");
  assert.equal(classifyRefusalText("The analysis begins with context, but I cannot provide further details.").label, "midway_withdrawal");
  const record = generateRefusalDataset({ count: 1 })[0];
  const score = scoreRefusalResponse({ record, text: "抱歉，无法提供。" });
  assert.equal(score.label, "complete_refusal");
  assert.equal(aggregateRefusalScores([score], [record]).scored, 1);
});

test("tool fixture arguments satisfy their own schemas and scoring catches drift", () => {
  const samples = generateToolCallSamples({ seed: "schema", count: MINECRAFT_TOOLS.length });
  for (const sample of samples) {
    const definition = MINECRAFT_TOOLS.find((entry) => entry.function.name === sample.expectedTool);
    assert.ok(definition);
    assert.equal(validateJsonSchema(sample.expectedArguments, definition.function.parameters).valid, true, sample.expectedTool);
    const good = scoreToolCallResponse({ sample, message: { tool_calls: [{ id: "call-1", function: { name: sample.expectedTool, arguments: JSON.stringify(sample.expectedArguments) } }] } });
    assert.equal(good.toolSelectionCorrect, true);
    assert.equal(good.parameterSchemaValid, true);
    const bad = scoreToolCallResponse({ sample, message: { tool_calls: [{ id: "call-1", function: { name: "invented_tool", arguments: "{}" } }] } });
    assert.equal(bad.unknownTool, true);
    assert.equal(bad.toolSelectionCorrect, false);
  }
  const noTool = scoreToolCallResponse({ sample: samples[0], message: { tool_calls: [] } });
  assert.equal(noTool.jsonValid, false, "a completed response without a tool call is not valid tool JSON");
  const failed = scoreToolCallResponse({ sample: samples[0], message: { tool_calls: [{ id: "partial", function: { name: samples[0].expectedTool, arguments: JSON.stringify(samples[0].expectedArguments) } }] }, outcome: "error" });
  assert.equal(failed.jsonValid, false, "an error response cannot enter the JSON denominator");
  assert.equal(failed.scored, false);
  const aggregate = aggregateToolScores(samples.map((sample) => scoreToolCallResponse({ sample, message: { tool_calls: [] } })), samples);
  assert.equal(aggregate.noToolWhenExpected, undefined);
  assert.equal(aggregate.toolSelectionAccuracy, 0);
});

test("needle prompt and evidence validation are deterministic and fail closed", () => {
  const fixture = buildNeedlePrompt(32_768, { seed: "needle" });
  assert.equal(fixture.prompt.includes(fixture.needle), true);
  assert.equal(validateNeedleResponse({ expectedNeedle: fixture.needle, responseText: fixture.needle, usagePromptTokens: 32_000, targetTokens: 32_768 }).passed, true);
  const failed = validateNeedleResponse({ expectedNeedle: fixture.needle, responseText: "wrong", usagePromptTokens: 2_048, targetTokens: 32_768 });
  assert.equal(failed.passed, false);
  assert.ok(failed.failures.includes("needle-not-returned-exactly"));
  assert.ok(failed.failures.includes("server-prompt-usage-below-90-percent-of-target"));
});

test("OpenAI message and fragmented SSE tool/reasoning deltas are normalized", () => {
  const parsed = parseOpenAIMessage({ choices: [{ message: { content: "ok", reasoning_content: "think", tool_calls: [{ id: "x" }] } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
  assert.equal(parsed.content, "ok");
  assert.equal(parsed.reasoningContent, "think");
  assert.equal(parsed.toolCalls.length, 1);
  assert.deepEqual(parsed.usage, { promptTokens: 3, completionTokens: 2, totalTokens: 5 });
  let accumulator = createStreamAccumulator();
  accumulator = consumeOpenAIStreamEvent(accumulator, { choices: [{ delta: { reasoning: "why ", content: "hel", tool_calls: [{ index: 0, id: "call", function: { name: "observe_", arguments: '{"radius":' } }] } }] });
  accumulator = consumeOpenAIStreamEvent(accumulator, { choices: [{ delta: { reasoning_content: "now", content: "lo", tool_calls: [{ index: 0, function: { name: "environment", arguments: "8}" } }] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 } });
  assert.equal(accumulator.content, "hello");
  assert.equal(accumulator.reasoning, "why ");
  assert.equal(accumulator.reasoningContent, "now");
  assert.equal(accumulator.toolCalls[0].function.name, "observe_environment");
  assert.equal(accumulator.toolCalls[0].function.arguments, '{"radius":8}');
  assert.deepEqual(extractSseEvents('data: {"x":1}\n\npartial'), { events: ['data: {"x":1}'], remainder: "partial" });
});

test("request aggregation reports success, timeout, cancellation, p95 and 5xx rates", () => {
  const values = [
    { outcome: "completed", statusCode: 200, usage: { promptTokens: 10, completionTokens: 20 }, ttftMs: 2, tpotMs: 3, totalTimeMs: 10, generationTokensPerSecond: 2_000 },
    { outcome: "timeout", statusCode: 504, usage: { promptTokens: null, completionTokens: null }, ttftMs: null, tpotMs: null, totalTimeMs: 20, generationTokensPerSecond: null },
    { outcome: "cancelled", statusCode: 200, usage: { promptTokens: null, completionTokens: null }, ttftMs: null, tpotMs: null, totalTimeMs: 5, generationTokensPerSecond: null },
  ];
  const aggregate = aggregateRequestResults(values, { concurrency: 2 });
  assert.equal(aggregate.successCount, 1);
  assert.equal(aggregate.timeoutCount, 1);
  assert.equal(aggregate.cancelledCount, 1);
  assert.equal(aggregate.fiveXxRate, 0.333);
  assert.equal(aggregate.ttftMs.p95, 2);
  const measured = aggregateRequestResults(values, { concurrency: 2, wallTimeMs: 5 });
  assert.equal(measured.wallTimeMs, 5);
  assert.equal(measured.wallTimeSource, "promise-all-batch");
  const batch = aggregateRequestResults(values, { concurrency: 2, wallTimeMs: 100 });
  assert.equal(batch.wallTimeMs, 100);
  assert.equal(batch.wallTimeSource, "promise-all-batch");
  assert.equal(batch.aggregateGenerationTokensPerSecond, 200);
});

test("pressure gates fail closed for OOM/Xid and missing memory evidence", () => {
  const failed = evaluatePressureGates({ samples: [{ outcome: "completed", concurrency: 16 }], logs: ["NVRM: Xid (31)", "CUDA out of memory"] });
  assert.equal(failed.passed, false);
  assert.equal(failed.oomDetected, true);
  assert.equal(failed.xidDetected, true);
  const noEvidence = evaluatePressureGates({ samples: [] });
  assert.equal(noEvidence.gates.memAvailableAtLeast6GiB, false);
  assert.equal(noEvidence.passed, false, "missing Spark evidence fails the pressure gate closed");
  const healthy = evaluatePressureGates({
    samples: [{ outcome: "completed", concurrency: 16, parseErrors: 0, toolCalls: [] }],
    logs: [{ collected: true, matchingLines: [] }],
    healthChecks: [{ reachable: true, ok: true, statusCode: 200 }],
    auxiliary: [{ type: "cancellation-timeout", result: { cancellationSucceeded: true, timeoutObserved: true } }],
    hostSnapshots: [
      { memAvailableBytes: 10 * 1024 ** 3, swapUsedBytes: 1024, containerRestartCount: 0, thermalSlowdown: false },
      { memAvailableBytes: 9 * 1024 ** 3, swapUsedBytes: 1024, containerRestartCount: 0, thermalSlowdown: false },
    ],
  });
  assert.equal(healthy.passed, true);
});

test("discoverEndpoint authenticates probes and verifies unauthenticated model access is denied", async (t) => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push({ path: request.url, authorization: request.headers.authorization });
    if (request.url === "/health") { response.writeHead(200); response.end("ok"); return; }
    if (request.url === "/metrics") { response.writeHead(200, { "Content-Type": "text/plain" }); response.end("vllm:num_requests_running 0\n"); return; }
    if (request.url === "/v1/models" && !request.headers.authorization) { response.writeHead(401); response.end(); return; }
    if (request.url === "/v1/models") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "ornith15-heretic" }] })); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const config = benchmarkConfig({ HERETIC_BENCH_BASE_URL: `http://127.0.0.1:${port}`, HERETIC_BENCH_API_KEY: "test-secret" });
  const result = await discoverEndpoint(config);
  assert.equal(result.modelPresent, true);
  assert.equal(result.authenticationEnforced, true);
  assert.equal(result.unauthenticatedModelsStatus, 401);
  assert.equal(seen.length, 4);
  assert.equal(seen.filter((entry) => entry.authorization === "Bearer test-secret").length, 3);
  assert.equal(seen.filter((entry) => entry.authorization === undefined).length, 1);
});

test("endpoint preflight fails closed for health, model, and authentication gaps", () => {
  const config = benchmarkConfig({ HERETIC_BENCH_BASE_URL: "http://127.0.0.1:8001", HERETIC_BENCH_API_KEY: "test-secret" });
  const healthy = validateEndpointDiscovery(config, {
    health: { reachable: true, ok: true, statusCode: 200 },
    metrics: { reachable: true, ok: true, statusCode: 200 },
    modelsStatus: 200,
    models: [config.model],
    modelPresent: true,
    unauthenticatedModelsStatus: 401,
    authenticationEnforced: true,
  });
  assert.equal(healthy.passed, true);
  assert.deepEqual(healthy.failures, []);
  const unhealthy = validateEndpointDiscovery(config, {
    health: { reachable: false, ok: false, statusCode: null },
    metrics: { reachable: false, ok: false, statusCode: null },
    modelsStatus: 503,
    models: [],
    modelPresent: false,
    unauthenticatedModelsStatus: 200,
    authenticationEnforced: false,
  });
  assert.equal(unhealthy.passed, false);
  assert.equal(unhealthy.failures.length, 4);
  assert.equal(unhealthy.warnings.length, 1);
});

test("runProfile stops before feature traffic when endpoint preflight fails", async (t) => {
  let chatRequests = 0;
  const server = createServer((request, response) => {
    if (request.url === "/health") { response.writeHead(503); response.end("not ready"); return; }
    if (request.url === "/metrics") { response.writeHead(200); response.end("vllm:num_requests_running 0\n"); return; }
    if (request.url === "/v1/models") { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ data: [{ id: "ornith15-heretic" }] })); return; }
    if (request.url === "/v1/chat/completions") chatRequests += 1;
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = benchmarkConfig({ HERETIC_BENCH_BASE_URL: `http://127.0.0.1:${server.address().port}`, HERETIC_BENCH_PROFILE: "0.85", HERETIC_BENCH_TIMEOUT_MS: "1000" });
  await assert.rejects(() => runProfile(config, "0.85"), /Endpoint preflight failed/u);
  assert.equal(chatRequests, 0);
});

test("refusal and tool suites leave failed HTTP responses outside their scoring denominators", async (t) => {
  const server = createServer((request, response) => {
    if (request.url === "/v1/chat/completions") { response.writeHead(503); response.end("temporarily unavailable"); return; }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = benchmarkConfig({ HERETIC_BENCH_BASE_URL: `http://127.0.0.1:${server.address().port}`, HERETIC_BENCH_TIMEOUT_MS: "1000" });
  const refusal = await runRefusalSuite(config, [generateRefusalDataset({ count: 1 })[0]]);
  assert.equal(refusal.summary.scored, 0);
  assert.equal(refusal.summary.unscored, 1);
  assert.equal(refusal.scores[0].outcome, "error");
  const tool = await runToolSuite(config, [generateToolCallSamples({ count: 1 })[0]]);
  assert.equal(tool.summary.scored, 0);
  assert.equal(tool.summary.unscored, 1);
  assert.equal(tool.scores[0].jsonValid, false);
});

test("long-context calibration reserves system, template, output, and safety tokens", async (t) => {
  let chatBody = null;
  const server = createServer(async (request, response) => {
    if (request.url === "/tokenize") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ count: Math.ceil(String(payload.prompt ?? "").length / 4), source: "mock-tokenizer" }));
      return;
    }
    if (request.url === "/v1/chat/completions") {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      chatBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const userPrompt = chatBody.messages.find((message) => message.role === "user")?.content ?? "";
      const needle = String(userPrompt).match(/ORNITH_NEEDLE_\d+_[A-F0-9]{16}/u)?.[0] ?? "missing";
      const promptTokens = Math.ceil(String(userPrompt).length / 4) + 12;
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: needle }, finish_reason: "stop" }], usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 } }));
      return;
    }
    response.writeHead(404); response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const config = benchmarkConfig({ HERETIC_BENCH_BASE_URL: `http://127.0.0.1:${server.address().port}`, HERETIC_BENCH_CONTEXT_TOKENS: "4096", HERETIC_BENCH_TIMEOUT_MS: "2000" });
  const calibration = await calibrateNeedlePrompt(config, 4096);
  assert.equal(calibration.calibrated, true);
  assert.ok(calibration.safeBudget < 4096);
  assert.equal(calibration.reservedTokens.output, CONTEXT_OUTPUT_RESERVE_TOKENS);
  assert.equal(calibration.reservedTokens.chatTemplate, CONTEXT_CHAT_TEMPLATE_RESERVE_TOKENS);
  assert.equal(calibration.reservedTokens.safetyMargin, CONTEXT_SAFETY_MARGIN_TOKENS);
  const suite = await runContextSuite(config);
  assert.equal(suite.passed, true);
  assert.equal(suite.cases.length, 1);
  assert.equal(suite.cases[0].calibration.calibrated, true);
  assert.equal(chatBody.max_tokens, CONTEXT_OUTPUT_RESERVE_TOKENS);
});

#!/usr/bin/env node
import { randomUUID } from "node:crypto";

import { AIRouter } from "./router.js";
import {
  aiSkillDecisionJsonSchema,
  aiSkillDecisionSchema,
} from "./decision.js";
import { OpenAICompatibleProvider } from "./providers/openai-compatible-provider.js";
import { SparkMetricsCollector } from "./spark-metrics.js";

const command = process.argv[2];
if (command !== "health" && command !== "test") {
  throw new Error("Usage: ai-endpoint-cli <health|test>");
}
const baseUrl = requiredEnvironment("AI_BASE_URL");
const apiKey = optionalEnvironment("AI_API_KEY");

if (command === "health") {
  const maxConcurrency = optionalPositiveInteger(process.env.AI_MAX_CONCURRENCY);
  const snapshot = await new SparkMetricsCollector({
    baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(process.env.AI_QUANTIZATION === undefined
      ? {}
      : { quantization: process.env.AI_QUANTIZATION }),
    ...(maxConcurrency === undefined ? {} : { maxConcurrency }),
  }).collect();
  process.stdout.write(`${JSON.stringify(snapshot, null, 2)}\n`);
  if (snapshot.status !== "online") process.exitCode = 1;
} else {
  const model = requiredEnvironment("AI_MODEL");
  const provider = new OpenAICompatibleProvider({
    name: process.env.AI_PROVIDER_NAME ?? "spark-vllm",
    baseUrl,
    model,
    ...(apiKey === undefined ? {} : { apiKey }),
  });
  const router = new AIRouter();
  router.register(provider);
  const requestId = randomUUID();
  const response = await router.route({
    requestId,
    traceId: `ai-endpoint-test-${requestId}`,
    botId: "endpoint-test-bot",
    taskType: "planner",
    priority: 30,
    timestamp: new Date().toISOString(),
    stateVersion: 1,
    taskVersion: 1,
    systemPrompt: "Return exactly one JSON decision matching the supplied schema.",
    prompt: "Choose wait because this is an isolated API contract test with no Minecraft state.",
    maxTokens: 128,
    temperature: 0,
    timeoutMs: optionalPositiveInteger(process.env.AI_REQUEST_TIMEOUT_MS) ?? 60_000,
    preferredProvider: provider.name,
    output: {
      name: "minecraft_skill_decision",
      schema: aiSkillDecisionSchema,
      jsonSchema: aiSkillDecisionJsonSchema,
    },
  });
  process.stdout.write(`${JSON.stringify({
    status: "pass",
    requestId,
    provider: response.provider,
    model: response.model,
    usage: response.usage,
    metrics: response.metrics ?? null,
    decision: response.validated,
  }, null, 2)}\n`);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnvironment(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function optionalPositiveInteger(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Expected a positive integer environment value.");
  }
  return parsed;
}

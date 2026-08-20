import { z } from "zod";

import { identifierSchema } from "./bot-messages.js";

const timestampSchema = z.string().datetime({ offset: true });

export const aiLatencyPercentilesV1Schema = z
  .object({
    p50Ms: z.number().finite().nonnegative().nullable(),
    p95Ms: z.number().finite().nonnegative().nullable(),
    p99Ms: z.number().finite().nonnegative().nullable(),
  })
  .strict();

export const aiNodeMetricsSnapshotV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    nodeName: z.string().trim().min(1).max(128),
    status: z.enum(["online", "starting", "offline"]),
    sampledAt: timestampSchema,
    backend: z.enum(["vllm", "openai-compatible"]),
    backendVersion: z.string().trim().min(1).max(256).nullable(),
    quantization: z.string().trim().min(1).max(128).nullable(),
    models: z.array(z.string().trim().min(1).max(1_024)).max(128).readonly(),
    networkRttMs: z.number().finite().nonnegative().nullable(),
    runningRequests: z.number().finite().nonnegative().nullable(),
    waitingRequests: z.number().finite().nonnegative().nullable(),
    maxConcurrency: z.number().int().positive().nullable(),
    kvCacheUsagePercent: z.number().finite().min(0).max(100).nullable(),
    promptTokensPerSecond: z.number().finite().nonnegative().nullable(),
    generationTokensPerSecond: z.number().finite().nonnegative().nullable(),
    promptTokensTotal: z.number().finite().nonnegative().nullable(),
    generationTokensTotal: z.number().finite().nonnegative().nullable(),
    successfulRequestsTotal: z.number().finite().nonnegative().nullable(),
    ttft: aiLatencyPercentilesV1Schema,
    tpot: aiLatencyPercentilesV1Schema,
    queueLatency: aiLatencyPercentilesV1Schema,
    endToEndLatency: aiLatencyPercentilesV1Schema,
    errorRate: z.number().finite().min(0).max(1).nullable(),
    errorCodes: z.array(identifierSchema).max(32).readonly(),
  })
  .strict();

export const aiNodeMetricsHttpResponseV1Schema = z
  .object({
    schemaVersion: z.literal("1.0"),
    requestId: z.string().uuid(),
    data: aiNodeMetricsSnapshotV1Schema,
  })
  .strict();

export type AiLatencyPercentilesV1 = z.infer<
  typeof aiLatencyPercentilesV1Schema
>;
export type AiNodeMetricsSnapshotV1 = z.infer<
  typeof aiNodeMetricsSnapshotV1Schema
>;
export type AiNodeMetricsHttpResponseV1 = z.infer<
  typeof aiNodeMetricsHttpResponseV1Schema
>;

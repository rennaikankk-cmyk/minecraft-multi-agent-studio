import { z } from "zod";

export const deploymentModeSchema = z.enum([
  "standard",
  "docker",
  "portable",
  "netcafe",
]);

export const availabilitySchema = z.enum([
  "available",
  "unavailable",
  "unknown",
]);

export const gpuProbeStatusSchema = z.enum([
  "detected",
  "not_detected",
  "probe_unavailable",
]);

export const environmentMemorySchema = z
  .object({
    totalBytes: z.number().int().positive(),
    freeBytes: z.number().int().nonnegative(),
  })
  .strict()
  .superRefine((memory, context) => {
    if (memory.freeBytes > memory.totalBytes) {
      context.addIssue({
        code: "custom",
        path: ["freeBytes"],
        message: "Free memory cannot exceed total memory.",
      });
    }
  });

export const environmentMemorySampleSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    capturedAt: z.string().datetime(),
    source: z.literal("node-os"),
    memory: environmentMemorySchema,
  })
  .strict();

export const environmentSnapshotSchema = z.object({
  schemaVersion: z.literal("1.0"),
  capturedAt: z.string().datetime(),
  mode: z.object({
    value: deploymentModeSchema,
    source: z.enum(["environment", "container-marker", "portable-root", "default"]),
  }),
  hardware: z.object({
    platform: z.string().min(1),
    release: z.string().min(1),
    architecture: z.string().min(1),
    cpu: z.object({
      model: z.string().min(1),
      /**
       * AGENTS.md §1.9：探测失败必须显示不可用，不能补造状态。旧定义
       * `.int().positive()` 连"未知"都表达不了，环境包只能拿
       * `Math.max(1, cpus.length)` 编一个 1 出来。改为可选：缺失即"不可用"，
       * 由 cpuProbe.probeReason 说明来源；旧的带值载荷照常校验通过（1.0 不变）。
       */
      logicalCores: z.number().int().positive().optional(),
      cpuProbe: z
        .object({
          source: z.enum(["node-os-cpus"]),
          probeReason: z.string().min(1).optional(),
        })
        .strict()
        .optional(),
    }),
    memory: environmentMemorySchema,
    gpu: z.object({
      status: gpuProbeStatusSchema,
      source: z.string().min(1),
      devices: z.array(
        z.object({
          name: z.string().min(1),
          vendor: z.string().min(1).optional(),
          /** 只有真实测到正数才写入；不可测量时缺失并给出 probeReason。 */
          memoryBytes: z.number().int().positive().optional(),
          driverVersion: z.string().min(1).optional(),
          probeReason: z.string().min(1).optional(),
        }),
      ),
    }),
  }),
  software: z.array(
    z.object({
      id: z.enum(["node", "java", "docker", "git"]),
      status: availabilitySchema,
      version: z.string().min(1).optional(),
      source: z.literal("local-process-probe"),
      detail: z.string().min(1).optional(),
    }),
  ),
  warnings: z.array(z.string().min(1)),
});

export type DeploymentMode = z.infer<typeof deploymentModeSchema>;
export type EnvironmentMemorySample = z.infer<
  typeof environmentMemorySampleSchema
>;
export type EnvironmentSnapshot = z.infer<typeof environmentSnapshotSchema>;

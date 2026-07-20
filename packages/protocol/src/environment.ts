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
      logicalCores: z.number().int().positive(),
    }),
    memory: z.object({
      totalBytes: z.number().int().positive(),
      freeBytes: z.number().int().nonnegative(),
    }),
    gpu: z.object({
      status: gpuProbeStatusSchema,
      source: z.string().min(1),
      devices: z.array(
        z.object({
          name: z.string().min(1),
          vendor: z.string().min(1).optional(),
          memoryBytes: z.number().int().nonnegative().optional(),
          driverVersion: z.string().min(1).optional(),
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
export type EnvironmentSnapshot = z.infer<typeof environmentSnapshotSchema>;

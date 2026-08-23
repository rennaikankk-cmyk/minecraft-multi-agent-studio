import { createHash } from "node:crypto";

import {
  identifierSchema,
  skillJsonValueSchema,
} from "@minecraft-studio/protocol";
import {
  TaskHandlerRegistry,
  type TaskHandlerDefinition,
} from "@minecraft-studio/task-system";
import { z } from "zod";

const MAX_DETERMINISTIC_VALUE_BYTES = 16 * 1_024;

/**
 * A bounded control-plane task used by the isolated delivery acceptance path.
 * It intentionally has no Minecraft, network, filesystem, or AI capability.
 * The digest makes the result deterministic without echoing arbitrary input
 * into durable task history.
 */
export const ISOLATED_DETERMINISTIC_TASK_TYPE =
  "isolated.acceptance.digest" as const;
export const ISOLATED_DETERMINISTIC_HANDLER_VERSION = "1.0.0" as const;

export const isolatedDeterministicInputSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    value: skillJsonValueSchema,
  })
  .superRefine((value, context) => {
    const serialized = JSON.stringify(value.value);
    if (
      Buffer.byteLength(serialized, "utf8") >
      MAX_DETERMINISTIC_VALUE_BYTES
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Deterministic acceptance input exceeds 16 KiB.",
      });
    }
  })
  .strict();

export const isolatedDeterministicOutputSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    kind: z.literal("isolated.acceptance.digest.v1"),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    byteLength: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_DETERMINISTIC_VALUE_BYTES),
  })
  .strict();

function canonicalJson(value: unknown): string {
  // The task input has already passed the bounded JSON schema. JSON.stringify
  // is stable for the parsed object because no executable values can pass it.
  return JSON.stringify(value);
}

export const isolatedDeterministicHandler: TaskHandlerDefinition = {
  taskType: ISOLATED_DETERMINISTIC_TASK_TYPE,
  handlerVersion: ISOLATED_DETERMINISTIC_HANDLER_VERSION,
  idempotent: true,
  async execute({ task, signal }) {
    if (signal.aborted) {
      throw new Error("Isolated deterministic handler was cancelled.");
    }
    const input = isolatedDeterministicInputSchema.parse(task.input);
    const serialized = canonicalJson(input.value);
    if (signal.aborted) {
      throw new Error("Isolated deterministic handler was cancelled.");
    }
    const output = isolatedDeterministicOutputSchema.parse({
      schemaVersion: "1.0",
      kind: "isolated.acceptance.digest.v1",
      sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
      byteLength: Buffer.byteLength(serialized, "utf8"),
    });
    return {
      result: output,
      evidence: [
        { kind: "trace", reference: identifierSchema.parse(task.traceId) },
      ],
    };
  },
};

export function createDeterministicAcceptanceRegistry(): TaskHandlerRegistry {
  const registry = new TaskHandlerRegistry();
  registry.register(isolatedDeterministicHandler);
  return registry;
}

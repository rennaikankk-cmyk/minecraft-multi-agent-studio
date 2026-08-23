import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ISOLATED_DETERMINISTIC_HANDLER_VERSION,
  ISOLATED_DETERMINISTIC_TASK_TYPE,
  isolatedDeterministicHandler,
  createDeterministicAcceptanceRegistry,
} from "../src/isolated-deterministic-handler.js";

describe("isolated deterministic task handler", () => {
  it("registers an exact idempotent control-plane contract", () => {
    const registry = createDeterministicAcceptanceRegistry();
    expect(
      registry.get(
        ISOLATED_DETERMINISTIC_TASK_TYPE,
        ISOLATED_DETERMINISTIC_HANDLER_VERSION,
      ),
    ).toMatchObject(isolatedDeterministicHandler);
    expect(
      registry.get(ISOLATED_DETERMINISTIC_TASK_TYPE, "2.0.0"),
    ).toBeNull();
  });

  it("returns a stable digest and trace evidence without external capabilities", async () => {
    const task = {
      input: {
        schemaVersion: "1.0",
        value: { count: 3, items: ["minecraft:stone"] },
      },
      traceId: "trace-isolated-digest",
    };
    const output = await isolatedDeterministicHandler.execute({
      task: task as never,
      dispatch: {} as never,
      signal: new AbortController().signal,
    });
    const serialized = JSON.stringify(task.input.value);
    expect(output).toEqual({
      result: {
        schemaVersion: "1.0",
        kind: "isolated.acceptance.digest.v1",
        sha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
        byteLength: Buffer.byteLength(serialized, "utf8"),
      },
      evidence: [{ kind: "trace", reference: task.traceId }],
    });
  });

  it("rejects missing or extra input fields", async () => {
    const signal = new AbortController().signal;
    await expect(
      isolatedDeterministicHandler.execute({
        task: { input: { value: true }, traceId: "trace-invalid" } as never,
        dispatch: {} as never,
        signal,
      }),
    ).rejects.toThrow();
    await expect(
      isolatedDeterministicHandler.execute({
        task: {
          input: { schemaVersion: "1.0", value: true, extra: false },
          traceId: "trace-invalid",
        } as never,
        dispatch: {} as never,
        signal,
      }),
    ).rejects.toThrow();
  });

  it("rejects values above the bounded deterministic input budget", async () => {
    await expect(
      isolatedDeterministicHandler.execute({
        task: {
          input: { schemaVersion: "1.0", value: "x".repeat(16 * 1_024 + 1) },
          traceId: "trace-too-large",
        } as never,
        dispatch: {} as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("16 KiB");
  });

  it("fails before parsing when the execution signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      isolatedDeterministicHandler.execute({
        task: {} as never,
        dispatch: {} as never,
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
  });
});

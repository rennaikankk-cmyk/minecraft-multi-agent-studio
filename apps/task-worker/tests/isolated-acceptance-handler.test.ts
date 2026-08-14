import { describe, expect, it, vi } from "vitest";

import {
  ISOLATED_ACCEPTANCE_HANDLER_VERSION,
  ISOLATED_ACCEPTANCE_TASK_TYPE,
  createIsolatedAcceptanceRegistry,
  isolatedAcceptanceHandler,
} from "../src/isolated-acceptance-handler.js";

describe("isolated Task Worker handler profile", () => {
  it("registers only the exact deterministic acceptance contract", () => {
    const registry = createIsolatedAcceptanceRegistry();
    expect(
      registry.get(
        ISOLATED_ACCEPTANCE_TASK_TYPE,
        ISOLATED_ACCEPTANCE_HANDLER_VERSION,
      ),
    ).toMatchObject(isolatedAcceptanceHandler);
    expect(registry.get(ISOLATED_ACCEPTANCE_TASK_TYPE, "2.0.0")).toBeNull();
    expect(registry.get("minecraft.move", "1.0.0")).toBeNull();
  });

  it("stays pending until its AbortSignal is cancelled", async () => {
    const controller = new AbortController();
    const execution = isolatedAcceptanceHandler.execute({
      task: {} as never,
      dispatch: {} as never,
      signal: controller.signal,
    });
    const settled = vi.fn();
    void execution.then(settled, settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();

    controller.abort();
    await expect(execution).rejects.toThrow(
      "Isolated acceptance handler was cancelled.",
    );
  });
});

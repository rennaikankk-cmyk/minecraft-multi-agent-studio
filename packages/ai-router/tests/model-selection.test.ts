import { describe, expect, it } from "vitest";

import { discoverModels, resolveModel, ModelSelectionError } from "../src/model-selection.js";

function fetchWith(models: string[] | null) {
  return (async () => {
    if (models === null) throw new Error("ECONNREFUSED");
    return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("model selection rules (fail-closed, never models[0])", () => {
  it("explicit configured and present → use it", async () => {
    const result = await resolveModel({ baseUrl: "http://hub.test", configuredModel: "m-b", fetchImplementation: fetchWith(["m-a", "m-b"]) });
    expect(result.model).toBe("m-b");
    expect(result.selection).toBe("configured");
  });

  it("explicit configured but missing → AI_CONFIGURED_MODEL_NOT_FOUND", async () => {
    await expect(resolveModel({ baseUrl: "http://hub.test", configuredModel: "gone", fetchImplementation: fetchWith(["m-a"]) }))
      .rejects.toMatchObject({ code: "AI_CONFIGURED_MODEL_NOT_FOUND" });
  });

  it("no config + exactly one model → single-auto allowed", async () => {
    const result = await resolveModel({ baseUrl: "http://hub.test", fetchImplementation: fetchWith(["only-one"]) });
    expect(result.model).toBe("only-one");
    expect(result.selection).toBe("single-auto");
  });

  it("no config + zero models → AI_MODEL_DISCOVERY_FAILED", async () => {
    await expect(resolveModel({ baseUrl: "http://hub.test", fetchImplementation: fetchWith([]) }))
      .rejects.toMatchObject({ code: "AI_MODEL_DISCOVERY_FAILED" });
  });

  it("no config + multiple models → AI_MODEL_AMBIGUOUS (refuses to pick models[0])", async () => {
    await expect(resolveModel({ baseUrl: "http://hub.test", fetchImplementation: fetchWith(["a", "b", "c"]) }))
      .rejects.toMatchObject({ code: "AI_MODEL_AMBIGUOUS" });
  });

  it("unreachable node → AI_NODE_UNREACHABLE", async () => {
    await expect(resolveModel({ baseUrl: "http://down.test", fetchImplementation: fetchWith(null) }))
      .rejects.toMatchObject({ code: "AI_NODE_UNREACHABLE" });
  });

  it("discoverModels caps and filters malformed entries", async () => {
    const models = await discoverModels({ baseUrl: "http://hub.test", fetchImplementation: (async () => new Response(JSON.stringify({ data: [{ id: "ok" }, { nope: 1 }, { id: "" }] }))) as unknown as typeof fetch });
    expect(models).toEqual(["ok"]);
  });

  it("error type is distinguishable", () => {
    const error = new ModelSelectionError("AI_MODEL_AMBIGUOUS", "x");
    expect(error).toBeInstanceOf(ModelSelectionError);
    expect(error.name).toBe("ModelSelectionError");
  });
});

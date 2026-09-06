import { describe, expect, it } from "vitest";
import { CompositeTaskOrchestrator, compositePhases } from "../src/composite-orchestrator.js";

describe("CompositeTaskOrchestrator", () => {
  it("maps A-F phases to durable parent and child executions and resumes", async () => {
    const orchestrator = new CompositeTaskOrchestrator({ nowMs: (() => { let n = 1_000; return () => ++n; })() });
    const task = await orchestrator.create({ kind: "RESOURCE_PRODUCTION", serverProfileId: "server", dimension: "overworld", botIds: ["bot"] });
    const calls: string[] = [];
    const finished = await orchestrator.resume(task.taskId, async ({ step }) => { calls.push(step.skillId); return { ok: true, output: { verified: true }, evidence: [`${step.phase}:readback`] }; });
    expect(finished.status).toBe("COMPLETED");
    expect(calls).toHaveLength(compositePhases("RESOURCE_PRODUCTION").length);
    const root = await orchestrator.executions.get(task.taskId);
    expect(root?.state).toBe("SUCCESS");
    expect(root?.childTasks).toHaveLength(calls.length);
    expect((await orchestrator.get(task.taskId))?.checkpoint.evidence).toContain("verify_output:readback");
  });

  it("persists recovery checkpoint and continues after restart", async () => {
    const orchestrator = new CompositeTaskOrchestrator();
    const task = await orchestrator.create({ kind: "FOOD_FACILITY", serverProfileId: "server", dimension: "overworld", botIds: ["bot"] });
    let first = true;
    const recovering = await orchestrator.resume(task.taskId, async () => first ? (first = false, { ok: false, errorCode: "BLOCKED" }) : { ok: true, output: null });
    expect(recovering.status).toBe("RECOVERING");
    const resumed = await orchestrator.resume(task.taskId, async () => ({ ok: true, output: null }));
    expect(resumed.status).toBe("COMPLETED");
  });
});

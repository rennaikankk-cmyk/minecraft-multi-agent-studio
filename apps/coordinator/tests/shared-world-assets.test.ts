import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SharedStateClient, BaseRegistry } from "@minecraft-studio/skills";
import { SharedStateServer } from "../src/shared-state-server.js";
import { projectGoalDispatchResult } from "../src/goal-execution-result.js";
import type { LocalPlanResult } from "../src/local-planner.js";

describe("shared assets over the Coordinator HTTP boundary", () => {
  it("shares placements and region conflicts between Runtime clients and survives restart", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "studio-asset-http-"));
    let server = new SharedStateServer({ port: 0, provenanceDir: dir });
    const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
    const position = { x: 0, y: 64, z: 0 };
    try {
      const address = await server.start();
      const options = { baseUrl: `http://${address.host}:${address.port}` };
      const a = new SharedStateClient(options), b = new SharedStateClient(options);
      await a.assets.record({ ...scope, position, source: "bot_placed", owner: "own_team", purpose: "farm", serverVerified: true });
      expect((await b.assets.observe({ ...scope, position })).record?.purpose).toBe("farm");
      await a.workAreas.claim({ area: { ...scope, min: position, max: position }, owner: "a" });
      await expect(b.workAreas.claim({ area: { ...scope, min: position, max: position }, owner: "b" })).rejects.toThrow("WORK_AREA_BUSY");
      await server.stop();
      server = new SharedStateServer({ port: 0, provenanceDir: dir });
      const restarted = await server.start();
      const client = new SharedStateClient({ baseUrl: `http://${restarted.host}:${restarted.port}` });
      expect((await client.assets.observe({ ...scope, position })).record?.purpose).toBe("farm");
    } finally { await server.stop(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("preserves expanded blueprint protection in the base snapshot", () => {
    const bases = new BaseRegistry();
    const scope = { serverProfileId: "fixture", dimension: "minecraft:overworld" };
    const base = bases.create({ ...scope, name: "wide", anchor: { x: 0, y: 64, z: 0 }, blueprintId: "wide" });
    bases.protectBlueprint(base.id, { ...scope, anchor: base.anchor,
      cells: [{ offset: { x: 60, y: 0, z: 0 }, itemName: "stone", blockClass: "structural", order: 0 }] });
    expect(BaseRegistry.restore(bases.serialize()).get(base.id)?.protectedBounds?.max.x).toBe(61);
  });
  it("projects partial process work as incomplete instead of a completed goal", () => {
    const result = { action: "skill_result", reasonCode: "TEST", ai: null, result: { payload: { skillId: "build.clear-area",
      skillVersion: "1.0.0", outcome: "completed", output: { completed: false, status: "BATCH_LIMIT", broken: 1,
        remaining: 5, unknown: 0, blocked: 0, observedAt: new Date().toISOString() } } } } as unknown as LocalPlanResult;
    expect(projectGoalDispatchResult({ taskId: "task", botId: "bot" }, result)).toMatchObject({ outcome: "failed", errorCode: "PROCESS_BATCH_LIMIT" });
  });
});

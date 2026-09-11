import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  FileGoalTemplateProposalStore,
  parseViaGoalTemplateRegistry,
  registeredGoalTemplateIds,
  registerGoalTemplate,
} from "../src/goal-template-registry.js";
import { parseDeterministicGoal } from "../src/deterministic-goals.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "goal-templates-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const BLUEPRINT_ROW_GOAL =
  "施工蓝图行：锚点 x=10 y=64 z=-5，沿 +x 放置 8 个 cobblestone，每批最多 2 格，从第 0 格开始";

describe("goal template registry", () => {
  it("migrated blueprint-row template parses the canonical goal unchanged", () => {
    const parsed = parseViaGoalTemplateRegistry(BLUEPRINT_ROW_GOAL);
    expect(parsed).toMatchObject({
      kind: "build-blueprint-row",
      anchor: { x: 10, y: 64, z: -5 },
      direction: "+x",
      count: 8,
      itemName: "cobblestone",
    });
  });
  it("parseDeterministicGoal routes through the registry (blueprint row still deterministic)", () => {
    expect(parseDeterministicGoal(BLUEPRINT_ROW_GOAL, [])).toMatchObject({ kind: "build-blueprint-row" });
  });
  it("registry miss falls through to the legacy chain (zero behavior change)", () => {
    // 非模板目标仍走旧解析链（采集/移动等）或返回 null 交模型分支。
    expect(parseDeterministicGoal("完全无关的自由文本目标", [])).toBeNull();
  });
  it("blueprint-row is registered exactly once and re-registration is rejected", () => {
    expect(registeredGoalTemplateIds()).toContain("blueprint-row");
    expect(() => registerGoalTemplate({ templateId: "blueprint-row", parse: () => null })).toThrow(/already registered/);
  });
  it("a newly registered template is honored before legacy fallback", () => {
    registerGoalTemplate({
      templateId: "test-echo",
      parse: (goal) => (goal === "TEST_ECHO" ? ({ kind: "explore-chunks", x: 1, z: 2, radius: 3 } as const) : null),
    });
    expect(parseViaGoalTemplateRegistry("TEST_ECHO")).toMatchObject({ kind: "explore-chunks", x: 1 });
  });
});

describe("FileGoalTemplateProposalStore", () => {
  it("proposes from lessons and survives restart; review transitions are terminal", () => {
    const dir = tempDir();
    const store = new FileGoalTemplateProposalStore(dir);
    const proposal = store.propose({
      source: "lesson",
      patternExample: "collecting dropped logs under canopies",
      rationale: "repeated pickup failures suggest a deterministic staging template",
    });
    expect(proposal.status).toBe("proposed");
    // 重启后存活。
    const restarted = new FileGoalTemplateProposalStore(dir);
    expect(restarted.list("proposed")).toHaveLength(1);
    const approved = restarted.review(proposal.proposalId, "approved");
    expect(approved?.status).toBe("approved");
    expect(approved?.reviewedAtMs).not.toBeNull();
    // 已审提案不可再翻状态。
    expect(restarted.review(proposal.proposalId, "rejected")).toBeNull();
    expect(new FileGoalTemplateProposalStore(dir).list("proposed")).toHaveLength(0);
  });
});

describe("portal-frame template (nether roof portal trick)", () => {
  it("parses the canonical goal and dispatches deterministically", () => {
    const goal = "地狱门框：锚点 x=10 y=122 z=-5，朝 +x";
    const parsed = parseViaGoalTemplateRegistry(goal);
    expect(parsed).toMatchObject({
      kind: "build-portal-frame",
      anchor: { x: 10, y: 122, z: -5 },
      direction: "+x",
    });
    expect(parseDeterministicGoal(goal, [])).toMatchObject({ kind: "build-portal-frame" });
  });
  it("rejects uncontrolled directions", () => {
    expect(parseViaGoalTemplateRegistry("地狱门框：锚点 x=10 y=122 z=-5，朝 -y")).toBeNull();
  });
  it("is registered in the template registry", () => {
    expect(registeredGoalTemplateIds()).toContain("portal-frame");
  });
});

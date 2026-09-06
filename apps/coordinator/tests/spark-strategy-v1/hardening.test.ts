import { describe, expect, it } from "vitest";
import { loadBlueprintFiles } from "../../src/blueprint-files.js";
import { factVersion, parseTeamFactsInput, type TeamFactsInput } from "../../src/spark-strategy-v1/facts.js";
import { teamProposalSchema, type TeamProposal } from "../../src/spark-strategy-v1/proposal.js";
import { buildSituationSummary, SummaryBudgetError } from "../../src/spark-strategy-v1/summary.js";
import { validateProposal, type ValidatorOptions } from "../../src/spark-strategy-v1/validator.js";
import { injectedModelClient, runReplaySample } from "../../src/spark-strategy-v1/replay.js";

const NOW = 1_780_000_000_000;
const scope = { serverProfileId: "isolated", dimension: "minecraft:overworld", observedAtMs: NOW - 1_000 };
const context: ValidatorOptions = { nowMs: NOW, blueprints: loadBlueprintFiles(),
  targets: new Map([["facility:site", { ...scope, x: 16, y: 64, z: 16 }]]) };
function facts(): TeamFactsInput {
  return parseTeamFactsInput({ scope, capturedAtMs: NOW - 1_000,
    bots: [{ botId: "B01", online: true, currentTask: null, survival: { health: 20, food: 10, armorPoints: 0 }, inventory: [], deaths: "unknown" }],
    team: { sharedInventory: [], facilities: [{ facilityId: "facility:site", kind: "construction-site", status: "available" }], shortages: ["food"], reservedResources: [] },
    events: [], constraints: { capabilities: ["food.secure", "collect.block", "world.scan", "movement.goto", "build.blueprint"].map((skillId) => ({ skillId, supported: true })),
      phaseGates: [{ gate: "BASE_SITE_RESERVED", satisfied: true }], nonPreemptibleBots: [], allowedChangeScope: "food, observations and reserved construction" },
  });
}
function proposal(f: TeamFactsInput): TeamProposal {
  return teamProposalSchema.parse({ proposalId: "test", factVersion: factVersion(f), scope: f.scope,
    validUntilMs: NOW + 30_000, generatedBy: "test", objective: "replenish food",
    assignments: [{ assignmentId: "a1", botId: "B01", role: "forager", action: { kind: "skill", skillId: "food.secure", params: { targetCount: 8 } },
      successSignals: ["safeFoodCount=8"], maxAttempts: 1 }],
  });
}
const build = { kind: "deterministicGoal", template: "blueprint", goalText: "使用蓝图文件 starter-base-v1 施工", targetRef: "facility:site" } as const;
function buildProposal(f: TeamFactsInput) { const p = proposal(f); p.assignments[0]!.action = build; return p; }
const check = (f: TeamFactsInput, p = proposal(f), options: ValidatorOptions = context) => validateProposal(p, f, options);

describe("trusted action gates", () => {
  it.each([undefined, []])("omitted/empty declarations still enforce an unsatisfied build gate: %j", (declared) => {
    const f = facts(); f.constraints.phaseGates[0]!.satisfied = false;
    const p = buildProposal(f);
    if (declared) p.assignments[0]!.requiredGates = declared;
    else delete (p.assignments[0] as Partial<TeamProposal["assignments"][number]>).requiredGates;
    expect(check(f, p).reasons).toContainEqual(expect.objectContaining({ code: "PHASE_GATE_NOT_SATISFIED" }));
  });
  it.each([false, "unknown", true] as const)("known build gate %s has the correct verdict", (value) => {
    const f = facts(); f.constraints.phaseGates[0]!.satisfied = value;
    expect(check(f, buildProposal(f)).verdict).toBe(value === false ? "rejected" : value === "unknown" ? "needs-reobservation" : "acceptable");
  });
  it("missing trusted gate requires observation; invented model gate is rejected", () => {
    const f = facts(); f.constraints.phaseGates = [];
    const p = buildProposal(f);
    expect(check(f, p).verdict).toBe("needs-reobservation");
    p.assignments[0]!.requiredGates = ["invented"];
    expect(check(f, p).verdict).toBe("rejected");
  });
  it("food remains legal with an unmet unrelated construction gate", () => {
    const f = facts(); f.constraints.phaseGates[0]!.satisfied = false;
    expect(check(f).verdict).toBe("acceptable");
  });
  it("another bot's satisfied phase cannot satisfy this bot's gate", () => {
    const f = facts(); f.constraints.phaseGates[0]!.botId = "B02";
    expect(check(f, buildProposal(f)).verdict).toBe("needs-reobservation");
  });
});

describe("dependent unknowns and resource ownership", () => {
  it.each([
    { task: null, locked: false, verdict: "acceptable" },
    { task: "unknown", locked: false, verdict: "needs-reobservation" },
    { task: "unknown", locked: true, verdict: "rejected" },
    { task: null, locked: true, verdict: "rejected" },
    { task: { goalText: "existing", phase: "running" }, locked: true, verdict: "rejected" },
  ])("task=$task locked=$locked", ({ task, locked, verdict }) => {
    const f = facts(); f.bots[0]!.currentTask = task as TeamFactsInput["bots"][number]["currentTask"];
    f.constraints.nonPreemptibleBots = locked ? ["B01"] : [];
    expect(check(f).verdict).toBe(verdict);
  });
  it.each(["unknown", "busy", "available"] as const)("facility status=%s", (status) => {
    const f = facts(); if (f.team.facilities !== "unknown") f.team.facilities[0]!.status = status;
    expect(check(f, buildProposal(f)).verdict).toBe(status === "available" ? "acceptable" : "needs-reobservation");
  });
  it.each(["B01", "B02"])("busy facility owner=%s", (owner) => {
    const f = facts(); if (f.team.facilities !== "unknown") Object.assign(f.team.facilities[0]!, { status: "busy", heldByBotId: owner });
    expect(check(f, buildProposal(f)).verdict).toBe(owner === "B01" ? "acceptable" : "rejected");
  });
  it("a known same-bot reservation identifies busy ownership", () => {
    const f = facts(); if (f.team.facilities !== "unknown") f.team.facilities[0]!.status = "busy";
    f.team.reservedResources = [{ resource: "facility:site", heldByBotId: "B01" }];
    expect(check(f, buildProposal(f)).verdict).toBe("acceptable");
  });
  it("wait does not depend on unknown task/facility availability", () => {
    const f = facts(); f.bots[0]!.currentTask = "unknown"; f.team.facilities = "unknown";
    f.constraints.nonPreemptibleBots = ["B01"];
    const p = proposal(f); p.assignments[0]!.action = { kind: "wait", reason: "reobserve" };
    expect(check(f, p).verdict).toBe("acceptable");
  });
});

describe("fact age, skew, version and TTL are independent", () => {
  it.each([180_000, 180_001])("observed age=%i", (age) => {
    const f = facts(); f.scope.observedAtMs = NOW - age;
    expect(check(f).verdict).toBe(age === 180_000 ? "acceptable" : "needs-reobservation");
  });
  it.each([2_000, 2_001])("future skew=%i", (skew) => {
    const f = facts(); f.scope.observedAtMs = NOW + skew; f.capturedAtMs = NOW + skew;
    expect(check(f).verdict).toBe(skew === 2_000 ? "acceptable" : "rejected");
  });
  it("observation after capture outside skew is invalid", () => {
    const f = facts(); f.capturedAtMs = NOW - 10_000;
    expect(check(f).reasons.some((r) => r.code === "FACT_CLOCK_INVALID")).toBe(true);
  });
  it("capture age is checked even when timestamps are internally inconsistent", () => {
    const f = facts(); f.capturedAtMs = NOW - 180_001;
    expect(check(f).reasons.some((r) => r.code === "FACTS_TOO_OLD")).toBe(true);
  });
  it("TTL upper boundary passes, a model extension does not", () => {
    const f = facts(); const p = proposal(f); p.validUntilMs = f.capturedAtMs + 180_000;
    expect(check(f, p).verdict).toBe("acceptable");
    p.validUntilMs++;
    expect(check(f, p).reasons.some((r) => r.code === "PROPOSAL_TTL_EXCEEDED")).toBe(true);
  });
  it("expiry is exclusive and factVersion changes cannot be ignored", () => {
    const f = facts(); const p = proposal(f); p.validUntilMs = NOW;
    expect(check(f, p).reasons.some((r) => r.code === "EXPIRED_PROPOSAL")).toBe(true);
    p.validUntilMs = NOW + 1000; f.bots[0]!.survival.food = 8;
    expect(check(f, p).reasons.some((r) => r.code === "STALE_FACTS")).toBe(true);
  });
});

describe("real parser, catalog and input schemas", () => {
  it.each([
    { kind: "deterministicGoal", template: "acquisition", goalText: "获取 8 个 oak_log" },
    { kind: "deterministicGoal", template: "food", goalText: "获取 8 份安全食物" },
    { kind: "deterministicGoal", template: "scan", goalText: "读取当前区域的 wheat 方块分布并给出扫描结果，只读" },
    { kind: "deterministicGoal", template: "movement", goalText: "移动到坐标 {{target}} 附近", targetRef: "facility:site" },
    build,
  ] as const)("legal $template goal", (action) => {
    const f = facts(); const p = proposal(f); p.assignments[0]!.action = action;
    expect(check(f, p).verdict).toBe("acceptable");
    expect(JSON.stringify(p)).not.toContain("x=16");
  });
  it.each([
    { kind: "deterministicGoal", template: "blueprint", goalText: "获取 8 份安全食物" },
    { kind: "deterministicGoal", template: "food", goalText: "获取 64 份安全食物" },
    { kind: "deterministicGoal", template: "acquisition", goalText: "获取 nonexistent_item" },
    { kind: "skill", skillId: "food.secure", params: { targetCount: -1 } },
    { kind: "skill", skillId: "food.secure", params: { targetCount: 8, unexpected: "x" } },
    { kind: "deterministicGoal", template: "movement", goalText: "移动到坐标 x=16 y=64 z=16 附近" },
  ])("invalid goal/input %#", (action) => {
    const f = facts(); const p = proposal(f); p.assignments[0]!.action = action as TeamProposal["assignments"][number]["action"];
    expect(check(f, p).verdict).toBe("rejected");
  });
  it("failure alternatives inherit gate and resource checks", () => {
    const f = facts(); f.constraints.phaseGates[0]!.satisfied = false;
    const p = proposal(f); p.assignments[0]!.onFailure = { strategy: "alternative", reason: "fallback", alternative: build };
    expect(check(f, p).reasons.some((r) => r.code === "PHASE_GATE_NOT_SATISFIED")).toBe(true);
    f.constraints.phaseGates[0]!.satisfied = true; f.team.reservedResources = [{ resource: "facility:site", heldByBotId: "B02" }]; p.factVersion = factVersion(f);
    expect(check(f, p).reasons.some((r) => r.code === "RESOURCE_CONFLICTS_RESERVATION")).toBe(true);
  });
  it("a valid alternative uses the same schema and can pass", () => {
    const f = facts(); const p = proposal(f);
    p.assignments[0]!.onFailure = { strategy: "alternative", reason: "observe", alternative: { kind: "deterministicGoal", template: "scan", goalText: "读取当前区域的 wheat 方块分布并给出扫描结果，只读" } };
    expect(check(f, p).verdict).toBe("acceptable");
  });
});

describe("mandatory model text and explicit replay clock", () => {
  it("exact mandatory budget fits; one fewer character fails", () => {
    const f = facts(); const size = buildSituationSummary(f).text.length;
    expect(buildSituationSummary(f, { maxChars: size }).text.length).toBe(size);
    expect(() => buildSituationSummary(f, { maxChars: size - 1 })).toThrow(SummaryBudgetError);
  });
  it("all gates and reservations survive optional oversized text", () => {
    const f = facts(); f.constraints.phaseGates = Array.from({ length: 40 }, (_, i) => ({ gate: `gate${i}`, satisfied: "unknown" }));
    f.team.reservedResources = Array.from({ length: 20 }, (_, i) => ({ resource: `facility:r${i}`, heldByBotId: "B01" }));
    f.constraints.nonPreemptibleBots = ["B01"];
    f.events = [{ kind: "failure", atMs: NOW - 1000, source: "test", detail: "x".repeat(8000) }];
    const s = buildSituationSummary(f);
    expect(s.text.length).toBeLessThanOrEqual(4000);
    expect(s.text).toContain("gate gate39: unknown"); expect(s.text).toContain("reserved=facility:r19 by=B01"); expect(s.text).toContain("nonPreemptibleBots: B01");
    expect(s.trimmed.eventsDropped).toBe(1); expect(s.sections.events).toEqual([]);
  });
  it("long shortage lists and tiny budgets fail explicitly", () => {
    const f = facts(); f.team.shortages = Array.from({ length: 1000 }, (_, i) => `shortage-${i}`);
    expect(() => buildSituationSummary(f)).toThrow(SummaryBudgetError);
    expect(() => buildSituationSummary(facts(), { maxChars: 10 })).toThrow(SummaryBudgetError);
  });
  it("correctly waiting must match the actual action, not only the verdict", async () => {
    const f = facts(); const p = proposal(f);
    const sample = { sampleId: "behavior", scenario: "repeated-failure" as const, mode: "offline" as const, facts: f,
      expectation: { desiredBehavior: "wait-or-escalate" as const, acceptableVerdicts: ["acceptable" as const] } };
    const options = { client: injectedModelClient(new Map([["behavior", JSON.stringify(p)]])), systemPrompt: "test", nowMs: NOW };
    const result = await runReplaySample(sample, options);
    expect(result.validation?.verdict).toBe("acceptable"); expect(result.usefulness.shouldWaitCorrectlyWaiting).toBe(false); expect(result.usefulness.matchedExpectation).toBe(false);
    await expect(runReplaySample(sample, { client: options.client, systemPrompt: "test" })).rejects.toThrow(/explicit evaluation clock/);
    expect(f.scope.observedAtMs).toBe(NOW - 1000);
  });
});

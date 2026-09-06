import { describe, expect, it } from "vitest";
import { factVersion, parseTeamFactsInput, type TeamFactsInput } from "../../src/spark-strategy-v1/facts.js";
import { teamProposalSchema } from "../../src/spark-strategy-v1/proposal.js";
import { buildSituationSummary } from "../../src/spark-strategy-v1/summary.js";
import { validateProposal } from "../../src/spark-strategy-v1/validator.js";

const NOW = 1_780_000_000_000;
function facts(): TeamFactsInput {
  return parseTeamFactsInput({
    scope: { serverProfileId: "isolated", dimension: "minecraft:overworld", observedAtMs: NOW - 1000 },
    capturedAtMs: NOW - 1000,
    bots: [{ botId: "B01", online: true, currentTask: null, survival: { health: 20, food: 10, armorPoints: 0 }, inventory: "unknown", deaths: "unknown" }],
    team: { sharedInventory: "unknown", facilities: [{ facilityId: "facility:farm", kind: "farm", status: "available" }], shortages: ["food"], reservedResources: [] },
    events: [],
    constraints: { capabilities: [{ skillId: "food.secure", supported: true }, { skillId: "build.blueprint", supported: true }],
      phaseGates: [{ gate: "BASE_SITE_RESERVED", satisfied: false }], nonPreemptibleBots: [], allowedChangeScope: "food and construction" },
  });
}
function proposal(input: TeamFactsInput) {
  return teamProposalSchema.parse({ proposalId: "regression", factVersion: factVersion(input), scope: input.scope,
    validUntilMs: NOW + 30_000, generatedBy: "counterexample", objective: "secure food",
    assignments: [{ assignmentId: "a1", botId: "B01", role: "forager",
      action: { kind: "skill", skillId: "food.secure", params: { targetCount: 8 } },
      successSignals: ["inventory safe food reaches 8"], maxAttempts: 1 }],
  });
}

describe("takeover counterexamples (run against unmodified GLM first)", () => {
  it("omitting requiredGates cannot bypass the trusted construction gate", () => {
    const input = facts();
    const p = proposal(input);
    p.assignments[0]!.action = { kind: "deterministicGoal", template: "blueprint", goalText: "使用蓝图文件 starter-base-v1 施工" };
    expect(validateProposal(p, input, { nowMs: NOW }).verdict).not.toBe("acceptable");
  });
  it("unknown task with a non-preemptible claim cannot accept a new action", () => {
    const input = facts();
    input.bots[0]!.currentTask = "unknown";
    input.constraints.nonPreemptibleBots = ["B01"];
    expect(validateProposal(proposal(input), input, { nowMs: NOW }).verdict).not.toBe("acceptable");
  });
  it("a known facility ID with unknown status is not usable", () => {
    const input = facts();
    if (input.team.facilities !== "unknown") input.team.facilities[0]!.status = "unknown";
    const p = proposal(input);
    p.assignments[0]!.resources = ["facility:farm"];
    expect(validateProposal(p, input, { nowMs: NOW }).verdict).not.toBe("acceptable");
  });
  it("matching versions and unexpired proposals cannot refresh day-old facts", () => {
    const input = facts();
    input.scope.observedAtMs -= 86_400_000;
    input.capturedAtMs -= 86_400_000;
    expect(validateProposal(proposal(input), input, { nowMs: NOW }).verdict).not.toBe("acceptable");
  });
  it("mandatory constraints that cannot fit must fail instead of disappearing from text", () => {
    const input = facts();
    input.constraints.allowedChangeScope = "x".repeat(4500);
    input.constraints.nonPreemptibleBots = ["B01"];
    expect(() => buildSituationSummary(input, { nowMs: NOW })).toThrow();
  });
  it("arbitrary goal text cannot become a blueprint by declaration", () => {
    const input = facts();
    const p = proposal(input);
    p.assignments[0]!.action = { kind: "deterministicGoal", template: "blueprint", goalText: "arbitrary unparseable text" };
    expect(validateProposal(p, input, { nowMs: NOW }).verdict).toBe("rejected");
  });
  it("an unknown failure alternative skill must be rejected", () => {
    const input = facts();
    const p = proposal(input);
    p.assignments[0]!.onFailure = { strategy: "alternative", reason: "fallback",
      alternative: { kind: "skill", skillId: "nonexistent.skill", params: {} } };
    expect(validateProposal(p, input, { nowMs: NOW }).verdict).toBe("rejected");
  });
});

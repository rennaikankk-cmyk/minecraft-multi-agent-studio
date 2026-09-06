// spark-strategy-v1 核心模块测试：facts / summary / proposal / validator。
// 覆盖一期验收清单的真实风险：跨服/维度拒绝、unknown 保持 unknown、
// 裁剪不损坏约束、重复分工/资源冲突/依赖环/不支持能力识别、活跃任务与
// 阶段门保护、解析分账（非法 JSON/截断/空/reasoning-only）、脱敏与可复现。
import { describe, expect, it } from "vitest";
import {
  factVersion,
  parseTeamFactsInput,
  scrubFreeText,
  type TeamFactsInput,
} from "../../src/spark-strategy-v1/facts.js";
import { buildSituationSummary, SummaryScopeError } from "../../src/spark-strategy-v1/summary.js";
import { parseProposalResponse, teamProposalSchema } from "../../src/spark-strategy-v1/proposal.js";
import { validateProposal, type ValidationResult } from "../../src/spark-strategy-v1/validator.js";

const NOW = 1_700_000_000_000;

function baseFacts(overrides: Partial<TeamFactsInput> = {}): TeamFactsInput {
  return parseTeamFactsInput({
    scope: { serverProfileId: "luv-anarchy", dimension: "minecraft:overworld", observedAtMs: NOW - 5_000, sessionEpoch: 42 },
    capturedAtMs: NOW - 5_000,
    bots: [
      {
        botId: "B01",
        online: true,
        currentTask: null,
        survival: { health: 20, food: 18, armorPoints: 8 },
        inventory: [{ itemName: "oak_log", count: 12 }, { itemName: "stone_pickaxe", count: 1 }],
        deaths: "unknown",
      },
      {
        botId: "B02",
        online: true,
        currentTask: null,
        survival: { health: "unknown", food: "unknown", armorPoints: "unknown" },
        inventory: "unknown",
        deaths: "unknown",
      },
    ],
    team: {
      sharedInventory: "unknown",
      facilities: [{ facilityId: "facility:wheat-farm-1", kind: "farm", status: "available" }],
      shortages: ["food"],
      reservedResources: [],
    },
    events: [
      { kind: "failure", atMs: NOW - 60_000, source: "incident:abc123", botId: "B01", detail: "collect.block PATH_FAILED" },
      { kind: "completion", atMs: NOW - 120_000, source: "skill_result", botId: "B02", detail: "world.scan completed" },
    ],
    constraints: {
      capabilities: [
        { skillId: "collect.block", supported: true },
        { skillId: "food.secure", supported: true },
        { skillId: "container.transfer", supported: true },
        { skillId: "build.blueprint", supported: true },
        { skillId: "combat.engage", supported: true },
        { skillId: "world.scan", supported: true },
      ],
      phaseGates: [{ gate: "shelterEstablished", satisfied: true }],
      nonPreemptibleBots: [],
      allowedChangeScope: "resource collection, production, logistics assignments",
    },
    ...overrides,
  });
}

function validProposal(facts: TeamFactsInput, overrides: Record<string, unknown> = {}) {
  return teamProposalSchema.parse({
    proposalId: "prop-1",
    factVersion: factVersion(facts),
    scope: { serverProfileId: facts.scope.serverProfileId, dimension: facts.scope.dimension },
    validUntilMs: NOW + 60_000,
    generatedBy: "fixture",
    objective: "secure food supply",
    assignments: [
      {
        assignmentId: "a1",
        botId: "B01",
        role: "harvester",
        action: { kind: "skill", skillId: "food.secure", params: { targetCount: 8 } },
        resources: ["facility:wheat-farm-1"],
        successSignals: ["shared food count >= 16"],
        maxAttempts: 2,
      },
      {
        assignmentId: "a2",
        botId: "B02",
        role: "runner",
        action: { kind: "deterministicGoal", template: "scan", goalText: "读取当前区域的 wheat 方块分布并给出扫描结果，只读" },
        successSignals: ["bot within 8 blocks of farm"],
        maxAttempts: 1,
      },
    ],
    dependencies: [],
    ...overrides,
  });
}

describe("facts", () => {
  it("作用域身份缺失=拒绝（不出可执行建议的基础）", () => {
    expect(() =>
      parseTeamFactsInput({ ...JSON.parse(JSON.stringify(baseFacts())), scope: { serverProfileId: "", dimension: "overworld", observedAtMs: NOW } }),
    ).toThrow(/serverProfileId/);
  });

  it("unknown 保持 unknown：deaths='unknown' 不被转换；schema 拒绝负数等坏形态", () => {
    const facts = baseFacts();
    expect(facts.bots[0]?.deaths).toBe("unknown");
    expect(facts.bots[1]?.inventory).toBe("unknown");
    expect(() => parseTeamFactsInput({ ...JSON.parse(JSON.stringify(facts)), bots: [{ ...facts.bots[0], deaths: -1 }] })).toThrow();
  });

  it("factVersion 确定性：同输入同版本、任一字段变化即不同", () => {
    const a = baseFacts();
    const b = baseFacts();
    expect(factVersion(a)).toBe(factVersion(b));
    const c = baseFacts({
      events: [
        { kind: "failure", atMs: NOW - 60_000, source: "incident:abc123", botId: "B01", detail: "collect.block PATH_FAILED" },
        { kind: "completion", atMs: NOW - 120_000, source: "skill_result", botId: "B02", detail: "world.scan completed" },
        { kind: "death", atMs: NOW - 30_000, source: "runtime", botId: "B02", detail: "lava" },
      ],
    });
    expect(factVersion(c)).not.toBe(factVersion(a));
  });

  it("scrubFreeText：URL 与长十六进制（疑似 token/fingerprint）脱敏", () => {
    const scrubbed = scrubFreeText("see http://192.168.100.2:18300/v1 and fingerprint aabbccdd1122334455");
    expect(scrubbed).not.toContain("http://");
    expect(scrubbed).not.toContain("aabbccdd1122334455");
    expect(scrubbed).toContain("[URL_REDACTED]");
  });
});

describe("summary", () => {
  it("未知不冒充：unknown 字段逐字进入摘要（deaths=unknown、inventory=unknown）", () => {
    const summary = buildSituationSummary(baseFacts(), { nowMs: NOW });
    expect(summary.text).toContain("deaths=unknown");
    expect(summary.text).toContain("inventory=unknown");
    expect(summary.text).toContain("sharedInventory=unknown");
  });

  it("作用域与约束永不裁剪：小上限下 server/dim/shortages/能力目录仍在", () => {
    const facts = baseFacts({
      events: Array.from({ length: 60 }, (_, i) => ({
        kind: "other" as const,
        atMs: NOW - (i + 1) * 1_000,
        source: "log",
        detail: `event-${i}`,
      })),
    });
    const summary = buildSituationSummary(facts, { nowMs: NOW, maxChars: 900 });
    expect(summary.text.length).toBeLessThanOrEqual(900);
    expect(summary.text).toContain("server=luv-anarchy");
    expect(summary.text).toContain("dim=minecraft:overworld");
    expect(summary.text).toContain("SHORTAGES: food");
    expect(summary.text).toContain("collect.block");
    expect(summary.trimmed.eventsDropped + summary.trimmed.eventsCompressed).toBeGreaterThan(0);
  });

  it("token 计数标 estimated（不冒充实测）", () => {
    const summary = buildSituationSummary(baseFacts(), { nowMs: NOW });
    expect(summary.tokenEstimate.method).toBe("estimated-chars-div-4");
    expect(summary.tokenEstimate.value).toBeGreaterThan(0);
  });

  it("无作用域=SummaryScopeError", () => {
    const facts = JSON.parse(JSON.stringify(baseFacts()));
    facts.scope.serverProfileId = "";
    expect(() => buildSituationSummary(facts, { nowMs: NOW })).toThrow(SummaryScopeError);
  });

  it("同输入摘要文本可复现（归一化输出）", () => {
    const a = buildSituationSummary(baseFacts(), { nowMs: NOW });
    const b = buildSituationSummary(baseFacts(), { nowMs: NOW });
    expect(a.text).toBe(b.text);
    expect(a.factVersion).toBe(b.factVersion);
  });
});

describe("proposal parsing（分账）", () => {
  const facts = baseFacts();
  const good = JSON.stringify({
    proposalId: "p1",
    factVersion: factVersion(facts),
    scope: { serverProfileId: "luv-anarchy", dimension: "overworld" },
    validUntilMs: NOW + 1000,
    generatedBy: "model:test",
    objective: "food",
    assignments: [
      { assignmentId: "a1", botId: "B01", role: "harvester", action: { kind: "skill", skillId: "food.secure", params: {} }, successSignals: ["x"], maxAttempts: 1 },
    ],
    dependencies: [],
  });

  it("合法响应→ok", () => {
    expect(parseProposalResponse(good)).toMatchObject({ ok: true });
  });
  it("空响应→empty-response", () => {
    expect(parseProposalResponse("")).toMatchObject({ ok: false, reason: "empty-response" });
  });
  it("reasoning-only→reasoning-only", () => {
    expect(parseProposalResponse("<think>the plan is food</think> no json here")).toMatchObject({
      ok: false,
      reason: "reasoning-only",
    });
  });
  it("非法 JSON→invalid-json", () => {
    expect(parseProposalResponse("{not json}")).toMatchObject({ ok: false, reason: "invalid-json" });
  });
  it("截断 JSON→truncated-json（括号不平衡）", () => {
    const truncated = good.slice(0, good.length - 40);
    expect(parseProposalResponse(truncated)).toMatchObject({ ok: false, reason: "truncated-json" });
  });
  it("schema 不符→schema-invalid（缺 successSignals 不在解析层管，但缺 objective 会）", () => {
    const bad = JSON.parse(good) as Record<string, unknown>;
    delete bad.objective;
    expect(parseProposalResponse(JSON.stringify(bad))).toMatchObject({ ok: false, reason: "schema-invalid" });
  });
});

describe("validator", () => {
  const facts = baseFacts();
  const ok = (result: ValidationResult): ValidationResult => result;

  it("健康建议→acceptable", () => {
    const result = ok(validateProposal(validProposal(facts), facts, { nowMs: NOW }));
    expect(result.verdict).toBe("acceptable");
  });

  it("跨服务器/维度→SCOPE_MISMATCH rejected", () => {
    const proposal = validProposal(facts, { scope: { serverProfileId: "other-server", dimension: "overworld" } });
    expect(validateProposal(proposal, facts, { nowMs: NOW }).reasons.some((r) => r.code === "SCOPE_MISMATCH")).toBe(true);
    const proposal2 = validProposal(facts, { scope: { serverProfileId: "luv-anarchy", dimension: "the_nether" } });
    expect(validateProposal(proposal2, facts, { nowMs: NOW }).verdict).toBe("rejected");
  });

  it("过期建议→EXPIRED_PROPOSAL rejected", () => {
    const proposal = validProposal(facts, { validUntilMs: NOW - 1 });
    expect(validateProposal(proposal, facts, { nowMs: NOW }).reasons.some((r) => r.code === "EXPIRED_PROPOSAL")).toBe(true);
  });

  it("事实版本不匹配→STALE_FACTS rejected（过期快照防线）", () => {
    const proposal = validProposal(facts, { factVersion: "deadbeefdeadbeef" });
    expect(validateProposal(proposal, facts, { nowMs: NOW }).reasons.some((r) => r.code === "STALE_FACTS")).toBe(true);
  });

  it("未知 bot→rejected；离线 bot→needs-reobservation", () => {
    const proposalGhost = validProposal(facts, {
      assignments: [
        { assignmentId: "a1", botId: "GHOST", role: "r", action: { kind: "skill", skillId: "food.secure", params: {} }, successSignals: ["x"], maxAttempts: 1 },
      ],
      dependencies: [],
    });
    expect(validateProposal(proposalGhost, facts, { nowMs: NOW }).reasons.some((r) => r.code === "UNKNOWN_BOT")).toBe(true);
    const offlineFacts = baseFacts({
      bots: [JSON.parse(JSON.stringify({ ...facts.bots[0], online: false })), facts.bots[1]],
    });
    const proposalOffline = validProposal(offlineFacts);
    const result = validateProposal(proposalOffline, offlineFacts, { nowMs: NOW });
    expect(result.reasons.some((r) => r.code === "BOT_OFFLINE")).toBe(true);
    expect(result.verdict).toBe("needs-reobservation");
  });

  it("不支持的能力→UNSUPPORTED_CAPABILITY rejected（不编造存在的能力）", () => {
    const proposal = validProposal(facts, {
      assignments: [
        { assignmentId: "a1", botId: "B01", role: "r", action: { kind: "skill", skillId: "ride.dragon", params: {} }, successSignals: ["x"], maxAttempts: 1 },
      ],
      dependencies: [],
    });
    expect(validateProposal(proposal, facts, { nowMs: NOW }).reasons.some((r) => r.code === "UNSUPPORTED_CAPABILITY")).toBe(true);
  });

  it("同一 bot 互斥任务→DUPLICATE_BOT_ASSIGNMENT rejected", () => {
    const proposal = validProposal(facts, {
      assignments: [
        { assignmentId: "a1", botId: "B01", role: "r1", action: { kind: "skill", skillId: "food.secure", params: {} }, successSignals: ["x"], maxAttempts: 1 },
        { assignmentId: "a2", botId: "B01", role: "r2", action: { kind: "skill", skillId: "collect.block", params: {} }, successSignals: ["y"], maxAttempts: 1 },
      ],
      dependencies: [],
    });
    expect(validateProposal(proposal, facts, { nowMs: NOW }).reasons.some((r) => r.code === "DUPLICATE_BOT_ASSIGNMENT")).toBe(true);
  });

  it("资源双占→RESOURCE_DOUBLE_CLAIM；与预留冲突→RESOURCE_CONFLICTS_RESERVATION", () => {
    const doubleClaim = validProposal(facts, {
      assignments: [
        { assignmentId: "a1", botId: "B01", role: "r1", action: { kind: "skill", skillId: "food.secure", params: {} }, resources: ["facility:wheat-farm-1"], successSignals: ["x"], maxAttempts: 1 },
        { assignmentId: "a2", botId: "B02", role: "r2", action: { kind: "skill", skillId: "collect.block", params: {} }, resources: ["facility:wheat-farm-1"], successSignals: ["y"], maxAttempts: 1 },
      ],
      dependencies: [],
    });
    expect(validateProposal(doubleClaim, facts, { nowMs: NOW }).reasons.some((r) => r.code === "RESOURCE_DOUBLE_CLAIM")).toBe(true);
    const reservedFacts = baseFacts({
      team: {
        sharedInventory: "unknown",
        facilities: [{ facilityId: "facility:wheat-farm-1", kind: "farm", status: "busy" }],
        shortages: [],
        reservedResources: [{ resource: "facility:wheat-farm-1", heldByBotId: "B02" }],
      },
    });
    const conflict = validProposal(reservedFacts);
    conflict.assignments[0]!.resources = ["facility:wheat-farm-1"]; // B01 声领 B02 的预留
    expect(validateProposal(conflict, reservedFacts, { nowMs: NOW }).reasons.some((r) => r.code === "RESOURCE_CONFLICTS_RESERVATION")).toBe(true);
  });

  it("依赖环→DEPENDENCY_CYCLE rejected", () => {
    const proposal = validProposal(facts, {
      dependencies: [
        { afterId: "a1", beforeId: "a2" },
        { afterId: "a2", beforeId: "a1" },
      ],
    });
    expect(validateProposal(proposal, facts, { nowMs: NOW }).reasons.some((r) => r.code === "DEPENDENCY_CYCLE")).toBe(true);
  });

  it("阶段门未满足→rejected；门状态 unknown→needs-reobservation", () => {
    const gatedFacts = baseFacts({
      constraints: {
        capabilities: facts.constraints.capabilities,
        phaseGates: [{ gate: "shelterEstablished", satisfied: false }],
        nonPreemptibleBots: [],
        allowedChangeScope: "x",
      },
    });
    const gated = validProposal(gatedFacts);
    gated.assignments[0]!.requiredGates = ["shelterEstablished"];
    expect(validateProposal(gated, gatedFacts, { nowMs: NOW }).reasons.some((r) => r.code === "PHASE_GATE_NOT_SATISFIED")).toBe(true);
    const unknownGateFacts = baseFacts({
      constraints: {
        capabilities: facts.constraints.capabilities,
        phaseGates: [{ gate: "shelterEstablished", satisfied: "unknown" }],
        nonPreemptibleBots: [],
        allowedChangeScope: "x",
      },
    });
    const unknownGate = validProposal(unknownGateFacts);
    unknownGate.assignments[0]!.requiredGates = ["shelterEstablished"];
    const result = validateProposal(unknownGate, unknownGateFacts, { nowMs: NOW });
    expect(result.reasons.some((r) => r.code === "PHASE_GATE_UNKNOWN")).toBe(true);
    expect(result.verdict).toBe("needs-reobservation");
  });

  it("不可抢占 bot 任务中→CONFLICTS_ACTIVE_TASK rejected（生存抢占语义不动）", () => {
    const busyFacts = baseFacts({
      bots: [
        JSON.parse(JSON.stringify({ ...facts.bots[0], currentTask: { goalText: "collect oak", phase: "moving" } })),
        facts.bots[1],
      ],
      constraints: { ...facts.constraints, nonPreemptibleBots: ["B01"] },
    });
    const proposal = validProposal(busyFacts);
    expect(validateProposal(proposal, busyFacts, { nowMs: NOW }).reasons.some((r) => r.code === "CONFLICTS_ACTIVE_TASK")).toBe(true);
  });

  it("设施未知时引用设施→needs-reobservation（unknown 不当已验证）", () => {
    const unknownFacilityFacts = baseFacts({
      team: { sharedInventory: "unknown", facilities: "unknown", shortages: ["food"], reservedResources: [] },
    });
    const proposal = validProposal(unknownFacilityFacts);
    const result = validateProposal(proposal, unknownFacilityFacts, { nowMs: NOW });
    expect(result.reasons.some((r) => r.code === "UNKNOWN_RESOURCE_REFERENCE")).toBe(true);
    expect(result.verdict).toBe("needs-reobservation");
  });

  it("无成功信号/无重试上限→rejected（可观察完成条件与有界重试强制）", () => {
    const noSignals = validProposal(facts);
    noSignals.assignments[0]!.successSignals = [];
    expect(validateProposal(noSignals, facts, { nowMs: NOW }).reasons.some((r) => r.code === "NO_OBSERVABLE_SUCCESS_SIGNAL")).toBe(true);
    const noBound = validProposal(facts);
    delete noBound.assignments[0]!.maxAttempts;
    expect(validateProposal(noBound, facts, { nowMs: NOW }).reasons.some((r) => r.code === "UNBOUNDED_RETRY")).toBe(true);
  });

  it("noop/wait 动作不受互斥/成功信号/重试界约束（明确原因即可）", () => {
    const proposal = validProposal(facts, {
      assignments: [
        { assignmentId: "a1", botId: "B01", role: "rest", action: { kind: "wait", reason: "waiting for night to pass" } },
        { assignmentId: "a2", botId: "B02", role: "hold", action: { kind: "noop", reason: "nothing actionable for B02" } },
      ],
      dependencies: [],
    });
    const result = validateProposal(proposal, facts, { nowMs: NOW });
    expect(result.verdict).toBe("acceptable");
  });
});

import { describe, expect, it } from "vitest";

import { builtinSkills } from "../src/builtin/catalog.js";
import { SkillRegistry } from "../src/registry.js";
import { skillIdsWithRecordedEvidence } from "../src/skill-status.js";

// ---------------------------------------------------------------------------
// Phase 1 契约闸：阻止 Planner↔Skill↔capability 三向漂移再次发生。
// 每条闸都对应一次真实事故（yaw/pitch strict 漂移让 18 个技能变死代码、
// ensure-item 死指令、EVIDENCE 数量漂移等）。
// ---------------------------------------------------------------------------

/** 生产 runtime 下发的真实 skillState 形状（runtime.ts skillState() 的输出）。 */
const PRODUCTION_STATE = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: "sp-production",
  isolatedTestServer: true,
  policyLimits: {
    allowSprint: false,
    allowSprintJumpCombo: false,
    allowAirStrafe: false,
    maxFallBlocks: 2,
  },
  safety: { lavaAdjacent: false, waterAdjacent: false, voidRisk: false },
  combatAvailable: false,
  combatObservationAvailable: false,
  retreatInProgress: false,
  // BotStatusV1 的 BotPosition 携带 yaw/pitch——R6.1/R6.2 两轮死代码事故的
  // 根因就是 state schema 拒绝这两个字段。
  position: {
    x: 1234.5,
    y: 64,
    z: -4321.5,
    yaw: 3.14159,
    pitch: -0.5,
    dimension: "minecraft:overworld",
    serverProfileId: "sp-production",
  },
  inventory: { usedSlots: 3, totalSlots: 36 },
};

describe("contract gate G2 — every advertised skill registers without error", () => {
  it("all builtin skills pass SkillRegistry registration (fail-closed compile)", () => {
    const registry = new SkillRegistry();
    expect(() => {
      for (const skill of builtinSkills) registry.register(skill);
    }).not.toThrow();
    expect(registry.list().length).toBe(builtinSkills.length);
  });
});

describe("contract gate G4 — every state schema accepts the production skillState shape", () => {
  for (const skill of builtinSkills) {
    it(`${skill.id}: stateSchema accepts real BotState (position yaw/pitch included)`, () => {
      const parsed = skill.stateSchema.safeParse(PRODUCTION_STATE);
      expect(parsed.success).toBe(true);
    });
  }
});

describe("contract gate G6 — registration fails closed on invalid skill shape", () => {
  it("rejects a skill whose schema objects are not zod schemas", () => {
    const registry = new SkillRegistry();
    const bogus = {
      ...builtinSkills[0]!,
      id: "bogus.skill",
      inputSchema: { notAZodSchema: true },
    };
    expect(() => registry.register(bogus as never)).toThrow();
  });
});

describe("contract gate G7 — EVIDENCE registry matches the catalog exactly", () => {
  it("every catalog skill has recorded evidence and vice versa", () => {
    const catalogIds = builtinSkills.map((skill) => skill.id).sort();
    const evidenceIds = [...skillIdsWithRecordedEvidence()].sort();
    expect(catalogIds).toEqual(evidenceIds);
  });
});

describe("contract gate G8 — no test-only skills leak into the production catalog", () => {
  it("catalog ids are production-shaped (no test/fixture/mock markers)", () => {
    for (const skill of builtinSkills) {
      expect(skill.id).toMatch(/^[a-z]+(\.[a-z-]+)+$/u);
      expect(skill.id).not.toMatch(/test|fixture|mock|probe/iu);
    }
  });
});

describe("contract gate G9 — 23/23 typed progress contracts (no production title guessing)", () => {
  it("every production skill declares a progressContract", () => {
    const missing = builtinSkills
      .filter((skill) => skill.progressContract === undefined)
      .map((skill) => skill.id);
    expect(missing).toEqual([]);
  });

  it("declared values are members of the stable vocabulary", () => {
    const vocabulary = new Set([
      "MOVE_TO_TARGET",
      "SMELTING_WAIT",
      "PLACE_AND_VERIFY",
      "RECOVERING",
      "WAITING_EXTERNAL",
      "INVENTORY_CHANGE",
    ]);
    for (const skill of builtinSkills) {
      if (skill.progressContract !== undefined) {
        expect(vocabulary.has(skill.progressContract)).toBe(true);
      }
    }
  });
});

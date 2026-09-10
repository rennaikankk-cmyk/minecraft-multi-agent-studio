import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { scenarioResults } from "../src/scenario-results.js";
import {
  buildSkillStatusCatalog,
  builtinSkillIds,
  builtinSkills,
  builtinSkillStatusCatalog,
  builtinSkillVerificationManifestsV1,
  deriveSkillStatus,
  evidenceIssuesFor,
  evidenceSupportsVerifiedClaim,
  pendingGatesFor,
  skillIdsWithRecordedEvidence,
  skillStatuses,
  type SkillEvidence,
} from "../src/index.js";

const green: SkillEvidence = Object.freeze({
  offlineTests: true,
  runtimeWiring: true,
  isolatedServerScenarios: true,
  crossVersionMatrix: true,
  knownDefects: [],
});

function evidence(overrides: Partial<SkillEvidence>): SkillEvidence {
  return Object.freeze({ ...green, ...overrides });
}

describe("deriveSkillStatus", () => {
  it("only reaches Stable when all four gates are green", () => {
    expect(deriveSkillStatus(green)).toBe("Stable");
    expect(deriveSkillStatus(evidence({ crossVersionMatrix: false }))).toBe("Partial");
    expect(deriveSkillStatus(evidence({ isolatedServerScenarios: false, crossVersionMatrix: false }))).toBe("Partial");
  });

  it("drops to Experimental without runtime wiring and Untested without offline tests", () => {
    expect(
      deriveSkillStatus({
        offlineTests: true, runtimeWiring: false,
        isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
      }),
    ).toBe("Experimental");
    expect(
      deriveSkillStatus({
        offlineTests: false, runtimeWiring: false,
        isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
      }),
    ).toBe("Untested");
  });

  it("lets a known defect outrank every green gate", () => {
    // 四道闸全绿也不能盖住一个已知会坏的行为。
    expect(deriveSkillStatus(evidence({ knownDefects: ["ARMOR_EQUIP_SILENT_NOOP"] }))).toBe("Broken");
  });

  it("never invents a status outside the five markers", () => {
    for (const offlineTests of [true, false]) {
      for (const runtimeWiring of [true, false]) {
        for (const isolatedServerScenarios of [true, false]) {
          for (const crossVersionMatrix of [true, false]) {
            const candidate = { offlineTests, runtimeWiring, isolatedServerScenarios, crossVersionMatrix, knownDefects: [] };
            expect(skillStatuses).toContain(deriveSkillStatus(candidate));
          }
        }
      }
    }
  });
});

describe("evidence consistency", () => {
  it("rejects combinations that cannot physically happen", () => {
    expect(evidenceIssuesFor(evidence({ runtimeWiring: false }))).toContain(
      "REAL_SERVER_WITHOUT_RUNTIME_WIRING",
    );
    expect(evidenceIssuesFor(evidence({ isolatedServerScenarios: false }))).toContain(
      "MATRIX_WITHOUT_SERVER_SCENARIOS",
    );
    expect(evidenceIssuesFor(evidence({ offlineTests: false }))).toContain(
      "WIRED_WITHOUT_OFFLINE_TESTS",
    );
    expect(evidenceIssuesFor(green)).toEqual([]);
  });

  it("refuses to build a catalog for an unregistered skill id", () => {
    expect(() => buildSkillStatusCatalog([{ id: "equipment.equip-armor", version: "1.0.0" }])).toThrow(
      /evidence missing/iu,
    );
  });
});

describe("builtin skill status catalog", () => {
  it("covers exactly the registered builtin skills", () => {
    // 这条断言就是 smelt.item 漏登记那类漂移的闸门：目录与代码必须逐个对上。
    expect(builtinSkillStatusCatalog.map((entry) => entry.skillId).sort()).toEqual(builtinSkillIds);
    expect(skillIdsWithRecordedEvidence()).toEqual(builtinSkillIds);
    expect(builtinSkillIds).toHaveLength(builtinSkills.length);
  });

  it("takes id and version from the skill definitions themselves", () => {
    for (const skill of builtinSkills) {
      const entry = builtinSkillStatusCatalog.find((candidate) => candidate.skillId === skill.id);
      expect(entry?.skillVersion).toBe(skill.version);
    }
  });

  it("evidence bits stay honest: isolated=true requires ledger PASS; combat stays ungated until a real PvP scenario passes", () => {
    // 纪律不变：bit 只能在真实场景 PASS 后翻转，且必须能在场景账本里找到支撑；
    // combat 族在 PvP Lab 场景 PASS 之前保持 isolated=false（W0 接线≠真实验证）。
    for (const entry of builtinSkillStatusCatalog) {
      const isCombat = entry.skillId.startsWith("combat.");
      if (isCombat) {
        expect(entry.evidence.isolatedServerScenarios, entry.skillId).toBe(false);
      } else if (entry.evidence.isolatedServerScenarios) {
        const passes = scenarioResults.filter(
          (r) => r.result === "PASS" && r.skills.includes(entry.skillId),
        );
        expect(passes.length, entry.skillId).toBeGreaterThan(0);
      }
      expect(entry.evidence.crossVersionMatrix, entry.skillId).toBe(false);
      expect(evidenceSupportsVerifiedClaim(entry.evidence), entry.skillId).toBe(false);
      if (entry.evidence.runtimeWiring) {
        expect(entry.status, entry.skillId).toBe("Partial");
      } else {
        expect(entry.status, entry.skillId).toBe("Experimental");
      }
    }
  });

  it("keeps the pending gate list in sync with the evidence bits", () => {
    for (const entry of builtinSkillStatusCatalog) {
      expect(entry.pendingGates).toEqual(pendingGatesFor(entry.evidence));
    }
  });
});

/**
 * SKILLS.md 是这份目录的展示面，不是第二份事实。所以文档本身也要过闸：
 * 修复前它记了六个技能而代码里有七个，`smelt.item` 有源码却没条目，
 * 没有任何测试会因此变红。下面三条把"文档漂移"变成失败的测试。
 */
describe("SKILLS.md is a rendering of the catalog, not a second copy", () => {
  const doc = readFileSync(
    path.join(fileURLToPath(new URL("../../../", import.meta.url)), "SKILLS.md"),
    "utf8",
  );

  it("documents exactly the registered skills, one heading each", () => {
    const documented = [...doc.matchAll(/^## `([^`@]+)@([^`]+)`$/gmu)];
    expect(documented.map(([, id]) => id).sort()).toEqual(builtinSkillIds);
    for (const [, id, version] of documented) {
      const skill = builtinSkills.find((candidate) => candidate.id === id);
      expect(skill?.version).toBe(version);
    }
  });

  it("gives every entry one of the five markers, matching the derived status", () => {
    // 散文式的"已完成 / 待完成"不算标记：五个词必须逐个出现，且与推导结果一致。
    for (const entry of builtinSkillStatusCatalog) {
      // 切到下一个 `## ` 标题为止。不截断的话，后面某个条目的文字能替前面的条目
      // 把 pendingGates 断言蒙过去——漏标的那个反而显得是绿的。
      const section = doc
        .split(`## \`${entry.skillId}@${entry.skillVersion}\``)[1]
        ?.split(/^## /mu)[0];
      expect(section, `${entry.skillId} has no section`).toBeDefined();
      const marker = /^- 状态：\*\*(\w+)\*\*/mu.exec(section ?? "");
      expect(marker?.[1], `${entry.skillId} has no status marker`).toBe(entry.status);
      // 待完成的闸门也由证据位派生，不手写。
      for (const gate of entry.pendingGates) {
        expect(section).toContain(gate);
      }
    }
  });

  it("never claims a skill count that disagrees with the registry", () => {
    // 中文数量词仍可被文档使用，但测试表必须覆盖当前注册数量。
    const counts = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二", "十三", "十四", "十五", "十六", "十七", "十八", "十九", "二十", "二十一", "二十二", "二十三", "二十四", "二十五", "二十六", "二十七", "二十八", "二十九", "三十", "三十一", "三十二", "三十三", "三十四", "三十五"];
    const correct = counts[builtinSkills.length];
    expect(correct, "registry outgrew this test's numeral table").toBeDefined();
    // "两" 是 2 的另一种口语写法，两种都得认，否则改文档的人会被迫写得别扭。
    const accepted = new Set(correct === "二" ? ["二", "两"] : [correct]);
    // 阿拉伯数字也要认。此前这条只扫中文数字，而文档写的是"20 个技能"，
    // 于是注册表长到 21 时这条断言一个都没匹配上，空转着报绿。
    accepted.add(String(builtinSkills.length));
    for (const [claim, spelled] of doc.matchAll(
      /(\d+|[零一两二三四五六七八九十]+)\s*个(?:内建)?\s*(?:Skill|技能)/gmu,
    )) {
      expect(
        accepted.has(spelled),
        `SKILLS.md claims "${claim}" but ${correct} are registered`,
      ).toBe(true);
    }
  });
});

describe("verification manifests track the same skill set", () => {
  it("declares one manifest per registered skill with matching ids", () => {
    // 修复前这里有一份 skillId=equipment.equip-armor 的清单——指向不存在的技能。
    expect(builtinSkillVerificationManifestsV1.map((manifest) => manifest.skillId).sort()).toEqual(
      builtinSkillIds,
    );
    for (const manifest of builtinSkillVerificationManifestsV1) {
      const skill = builtinSkills.find((candidate) => candidate.id === manifest.skillId);
      expect(skill).toBeDefined();
      expect(manifest.skillVersion).toBe(skill?.version);
    }
  });

  it("validates each manifest base input against that skill's own input schema", () => {
    // 清单里的输入过 skillJsonValueSchema 不代表技能收得下它：
    // equip-armor 此前的 { minimumScoreGain: 1 } 就是这么躺着的。
    for (const manifest of builtinSkillVerificationManifestsV1) {
      const skill = builtinSkills.find((candidate) => candidate.id === manifest.skillId);
      const success = manifest.scenarios.map(
        (scenario) => skill?.inputSchema.safeParse(scenario.input).success,
      );
      expect(success.every(Boolean)).toBe(true);
    }
  });
});

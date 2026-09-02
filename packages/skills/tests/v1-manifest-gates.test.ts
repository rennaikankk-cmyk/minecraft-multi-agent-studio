// ---------------------------------------------------------------------------
// Skill System v1 —— Manifest 永久 CI gates（提示词 §三 的 12 道）。
//
// 这些闸的存在理由：manifest 是对外承诺。任何一条不过，"v1 完成"就不能宣称。
// 与既有闸的关系：G1(prompt⊆catalog) 在 coordinator、G3(capability 存在) 在
// bot-runtime、G2/G4/G6/G7/G8/G9 在 contract-gates.test.ts —— 本文件补 manifest
// 专属的闸并把跨闸一致性重新断言一遍（advertised=registered=EVIDENCE=manifest）。
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
  builtinSkills,
  builtinSkillIds,
  builtinSkillStatusCatalog,
} from "../src/builtin/catalog.js";
import { skillIdsWithRecordedEvidence } from "../src/skill-status.js";
import { skillSystemV1Manifest } from "../src/v1-manifest.js";
import { scenarioResults } from "../src/scenario-results.js";
import { FAILURE_CODES, FAILURE_CODE_ALIASES } from "../src/incidents.js";

const manifestSkillIds = skillSystemV1Manifest.skills.map((entry) => entry.skillId);
const registeredIds = [...builtinSkillIds];

describe("Skill System v1 manifest gates", () => {
  it("GM-1/GM-2: manifest = registered catalog = EVIDENCE registry (exact set equality, no duplicates)", () => {
    expect(new Set(manifestSkillIds).size).toBe(manifestSkillIds.length);
    expect([...manifestSkillIds].sort()).toEqual(registeredIds);
    expect([...skillIdsWithRecordedEvidence()].sort()).toEqual(registeredIds);
    expect(skillSystemV1Manifest.totalSkills).toBe(builtinSkills.length);
  });

  it("GM-3: every entry's runtimeCapabilities come from the skill definition (no manual drift)", () => {
    const byId = new Map(builtinSkills.map((skill) => [skill.id, skill]));
    for (const entry of skillSystemV1Manifest.skills) {
      const skill = byId.get(entry.skillId);
      expect(skill, entry.skillId).toBeDefined();
      expect([...entry.runtimeCapabilities].sort()).toEqual(
        [...(skill?.requiredCapabilities ?? [])].sort(),
      );
    }
  });

  it("GM-4: every production skill carries zod input/output/state schemas (no silent compile-continue)", () => {
    for (const skill of builtinSkills) {
      expect(skill.inputSchema instanceof z.ZodType, `${skill.id} inputSchema`).toBe(true);
      expect(skill.outputSchema instanceof z.ZodType, `${skill.id} outputSchema`).toBe(true);
      expect(skill.stateSchema instanceof z.ZodType, `${skill.id} stateSchema`).toBe(true);
    }
  });

  it("GM-5: every production skill has a typed progressContract (v1: 全部 typed progress)", () => {
    for (const entry of skillSystemV1Manifest.skills) {
      expect(entry.progressContract, entry.skillId).not.toBeNull();
    }
  });

  it("GM-6: every precondition failureCode is in the FailureCode registry (or alias)", () => {
    const registered = new Set([
      ...(FAILURE_CODES as readonly string[]),
      ...Object.keys(FAILURE_CODE_ALIASES),
    ]);
    for (const entry of skillSystemV1Manifest.skills) {
      for (const code of entry.failureCodes) {
        expect(registered.has(code), `${entry.skillId}:${code}`).toBe(true);
      }
    }
  });

  it("GM-7: maturityLevel is never higher than the evidence allows (derived, L-cap by construction)", () => {
    const statusById = new Map(builtinSkillStatusCatalog.map((e) => [e.skillId, e]));
    for (const entry of skillSystemV1Manifest.skills) {
      const status = statusById.get(entry.skillId);
      expect(status, entry.skillId).toBeDefined();
      if (!status?.evidence.offlineTests || !status.evidence.runtimeWiring) {
        expect(
          ["L1", "L2"].includes(entry.maturityLevel),
          `${entry.skillId} should cap at L2 while unwired`,
        ).toBe(true);
      }
      if (entry.maturityLevel === "L4" || entry.maturityLevel === "L5") {
        expect(entry.realScenarioIds.length, entry.skillId).toBeGreaterThan(0);
      }
      if (entry.maturityLevel === "L5") {
        expect(entry.verifiedMinecraftVersions.length, entry.skillId).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it("GM-8: verifiedMinecraftVersions derive only from PASS scenario results on this skill", () => {
    for (const entry of skillSystemV1Manifest.skills) {
      const expected = [
        ...new Set(
          scenarioResults
            .filter((r) => r.result === "PASS" && r.skills.includes(entry.skillId))
            .map((r) => r.minecraftVersion),
        ),
      ].sort();
      expect([...entry.verifiedMinecraftVersions].sort()).toEqual(expected);
    }
  });

  it("GM-9: FAIL scenario results never contribute versions or evidenceRefs", () => {
    const failedSkills = new Set(
      scenarioResults.filter((r) => r.result === "FAIL").flatMap((r) => r.skills),
    );
    for (const entry of skillSystemV1Manifest.skills) {
      if (!failedSkills.has(entry.skillId)) continue;
      const failedIds = new Set(
        scenarioResults.filter((r) => r.result === "FAIL").map((r) => r.scenarioId),
      );
      for (const id of entry.realScenarioIds) {
        expect(failedIds.has(id), `${entry.skillId} cites FAIL scenario ${id}`).toBe(false);
      }
    }
  });

  it("GM-10: no test-only/fixture skill ids leak into the manifest", () => {
    const banned = [/^test/i, /fixture/i, /mock/i, /^demo/i];
    for (const id of manifestSkillIds) {
      for (const pattern of banned) {
        expect(pattern.test(id), id).toBe(false);
      }
    }
  });

  it("GM-11: DEAD/duplicate visibility — duplicate ids fail, knownDefects surface in manifest status", () => {
    // catalog 以 Set 去重后排序；重复 id 会让 totalSkills 与 unique 数不一致（GM-2 已锁）。
    // 已知缺陷（Broken）必须如实反映：status=Broken 的技能 maturity 必须被压到 L2 以下。
    const statusById = new Map(builtinSkillStatusCatalog.map((e) => [e.skillId, e]));
    for (const entry of skillSystemV1Manifest.skills) {
      const status = statusById.get(entry.skillId);
      if (status && status.evidence.knownDefects.length > 0) {
        expect(entry.status).toBe("Broken");
        expect(["L0", "L1"].includes(entry.maturityLevel)).toBe(true);
      }
    }
  });

  it("GM-12: every scenario result cites a real commit and real skills (ledger integrity)", () => {
    const known = new Set(registeredIds);
    for (const result of scenarioResults) {
      expect(result.commit).toMatch(/^[0-9a-f]{7,40}$/);
      expect(result.skills.length).toBeGreaterThan(0);
      for (const skillId of result.skills) {
        expect(known.has(skillId), `${result.scenarioId}:${skillId}`).toBe(true);
      }
    }
  });

  it("GM-13: checked-in skill-system-v1.manifest.json matches the derived manifest (no drift)", () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const jsonPath = join(testDir, "..", "skill-system-v1.manifest.json");
    let raw: string;
    try {
      raw = readFileSync(jsonPath, "utf8");
    } catch {
      throw new Error(
        "skill-system-v1.manifest.json missing — run: pnpm --filter @minecraft-studio/skills build && node scripts/generate-skill-v1-manifest.mjs",
      );
    }
    expect(JSON.parse(raw)).toEqual(JSON.parse(JSON.stringify(skillSystemV1Manifest)));
  });

  it("GM-14: compatibility variants never hand-declare versions absent from the scenario ledger", () => {
    // 变体手写 verifiedMinecraftVersions 是第二条真值路径；gate 强制它 ⊆ 场景账本 PASS 版本。
    const passVersionsBySkill = new Map<string, Set<string>>();
    for (const result of scenarioResults) {
      if (result.result !== "PASS") continue;
      for (const skillId of result.skills) {
        const set = passVersionsBySkill.get(skillId) ?? new Set<string>();
        set.add(result.minecraftVersion);
        passVersionsBySkill.set(skillId, set);
      }
    }
    for (const skill of builtinSkills) {
      const passVersions = passVersionsBySkill.get(skill.id) ?? new Set<string>();
      for (const variant of skill.compatibility.variants) {
        for (const version of variant.verifiedMinecraftVersions) {
          expect(
            passVersions.has(version),
            `${skill.id} variant ${variant.id} declares ${version} without a PASS scenario`,
          ).toBe(true);
        }
      }
    }
  });
});

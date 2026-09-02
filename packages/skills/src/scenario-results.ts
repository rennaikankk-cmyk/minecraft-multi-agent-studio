// ---------------------------------------------------------------------------
// Scenario Results —— 真实 Minecraft 场景的**结果账本**。
//
// 这是整个技能体系里唯一允许记录"真实隔离服/外部服跑过且通过"的地方：
//   - 只有真跑之后才允许追加条目（脚本或人工），禁止预先填写"计划要跑"；
//   - v1-manifest 的 verifiedMinecraftVersions / realScenarioIds / evidenceRefs
//     全部从这里推导——账本没有 PASS，manifest 就没有版本（握手≠验证）；
//   - gates 测试（v1-manifest-gates.test.ts）校验：引用的技能必须存在、
//     commit 必须非空、FAIL 条目永不贡献 verifiedVersions。
//
// 条目字段与 Skill System v1 提示词 §十三 场景 manifest 对齐；commit 记录
// 跑场景时的 HEAD（Final HEAD 重跑后以最新条目为准，历史条目保留审计价值）。
// ---------------------------------------------------------------------------

import { builtinSkillIds } from "./builtin/catalog.js";

export type ScenarioServerKind = "isolated-fixture" | "external";

export type ScenarioResult = Readonly<{
  /** 稳定场景号（如 "J1-build-success"、"F4-smelt-restart-reconcile"）。 */
  scenarioId: string;
  title: string;
  /** 服务器报告的 Minecraft 版本（如 "1.21.11"）。 */
  minecraftVersion: string;
  protocolVersion: number | null;
  serverKind: ScenarioServerKind;
  /** 跑场景时的 git HEAD（短哈希）。 */
  commit: string;
  /** ISO 日期。 */
  date: string;
  result: "PASS" | "FAIL";
  /** 场景 exercised 的技能 id（必须存在于 catalog）。 */
  skills: readonly string[];
  /** 一句话证据说明（服务器真值怎么验的），不进敏感信息。 */
  notes: string;
}>;

/**
 * 已记录的真实场景结果。**追加纪律**：跑完 → 填条目 → gates 会校验引用合法性。
 */
const RECORDED: readonly ScenarioResult[] = Object.freeze([
  // 本轮（Skill System v1）场景完成后在此追加。
]);

function validateReferences(results: readonly ScenarioResult[]): void {
  const known = new Set(builtinSkillIds);
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.scenarioId)) {
      throw new Error(`scenario-results: duplicate scenarioId ${result.scenarioId}`);
    }
    seen.add(result.scenarioId);
    if (!/^[0-9a-f]{7,40}$/.test(result.commit)) {
      throw new Error(`scenario-results: ${result.scenarioId} has invalid commit`);
    }
    if (result.skills.length === 0) {
      throw new Error(`scenario-results: ${result.scenarioId} exercises no skills`);
    }
    for (const skillId of result.skills) {
      if (!known.has(skillId)) {
        throw new Error(`scenario-results: ${result.scenarioId} references unknown skill ${skillId}`);
      }
    }
  }
}

validateReferences(RECORDED);

export const scenarioResults: readonly ScenarioResult[] = RECORDED;

/** 某技能在账本里的 PASS 结果（manifest 推导用）。 */
export function passingResultsForSkill(
  skillId: string,
): readonly ScenarioResult[] {
  return scenarioResults.filter(
    (result) => result.result === "PASS" && result.skills.includes(skillId),
  );
}

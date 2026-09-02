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
  // ===== Skill System v1 轮（2026-09-02，runs at commit cce98c7 dist）=====
  {
    scenarioId: "J1L-build-row-8",
    title: "8 格确定性蓝图行 + rcon 逐格验证 + 零重放（dispatch 增量=1）",
    minecraftVersion: "1.21.11",
    protocolVersion: 774,
    serverKind: "isolated-fixture",
    commit: "cce98c7",
    date: "2026-09-02T08:12:17Z",
    result: "PASS",
    skills: ["build.blueprint", "movement.goto"],
    notes: "rcon execute-if-block 8/8 服务器真值；重放计数为基线增量（1 批）",
  },
  {
    scenarioId: "F1-smelt-lifecycle",
    title: "熔炉放置→scan 注册→租约熔炼→iron_ingot 入包（rcon 真值）",
    minecraftVersion: "1.21.11",
    protocolVersion: 774,
    serverKind: "isolated-fixture",
    commit: "cce98c7",
    date: "2026-09-02T08:13:45Z",
    result: "PASS",
    skills: ["build.blueprint", "world.scan", "smelt.item", "movement.goto"],
    notes: "goal completed + iron_in_inventory=true（服务器背包真值）",
  },
  {
    scenarioId: "F2-furnace-contention",
    title: "双 bot 争用同一熔炉：零 CRITICAL Facility Incident",
    minecraftVersion: "1.21.11",
    protocolVersion: 774,
    serverKind: "isolated-fixture",
    commit: "cce98c7",
    date: "2026-09-02T08:14:09Z",
    result: "PASS",
    skills: ["smelt.item", "movement.goto"],
    notes: "正常争用不产生 Incident（期望语义）",
  },
  {
    scenarioId: "MC1218-ACCEPTANCE",
    title: "1.21.8 隔离服 21 技能双 bot 验收：7 技能真 PASS 后 SKILL_CANCELLED 中止",
    minecraftVersion: "1.21.8",
    protocolVersion: 769,
    serverKind: "isolated-fixture",
    commit: "cce98c7",
    date: "2026-09-02T11:44:00Z",
    result: "FAIL",
    skills: [
      "movement.profile", "movement.goto", "travel.route", "world.scan",
      "collect.block", "craft.item", "pack.shulker", "smelt.item",
      "inventory.equip-armor", "container.transfer",
    ],
    notes: "套件中止故记 FAIL；已真实完成的 7 技能：movement.profile/goto、travel.route、world.scan、collect.block、craft.item、pack.shulker（第二版本核心矩阵的 connect/move/scan/collect/craft 已证）",
  },
  {
    scenarioId: "PVP-P1-PILOT",
    title: "PvP Lab P1 试点：裁判/几何/零崩溃基建全证，交火触发未达成",
    minecraftVersion: "1.21.11",
    protocolVersion: 774,
    serverKind: "isolated-fixture",
    commit: "cce98c7",
    date: "2026-09-02T11:02:00Z",
    result: "FAIL",
    skills: ["combat.engage"],
    notes: "gap=3.0 对峙+裁判基线+cleanStop+crashDelta=0；exchangeMutual=false（managed 档反射预算/自治游走/闸门地板三因，详见研究报告 §12）",
  },
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

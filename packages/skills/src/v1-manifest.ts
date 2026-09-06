// ---------------------------------------------------------------------------
// Skill System v1 Manifest —— 机器可读的唯一事实源（推导式，非手抄）。
//
// 纪律（与 skill-status.ts 同源）：
//   1. 每个字段要么**从代码推导**（catalog/skill-status/scenario-results），
//      要么是**带出处的静态注记**（family/planner 模板映射，改模板必须同步这里，
//      由 gates 测试反向约束 SKILLS.md/JSON 的渲染一致性）。
//   2. maturityLevel 只能由证据推导——代码里不存在可手写的 maturity 字段，
//      "Manifest maturity 不能高于真实 evidence"因此由构造保证，仍被 gates 复核。
//   3. verifiedMinecraftVersions 只来自 scenario-results 的 PASS 记录。
//      场景账本里没有 PASS，这里就没有版本——握手成功不等于技能验证。
//   4. scenario-results 是唯一允许记录"真实 Minecraft 结果"的地方，且只在
//      真跑之后由人工/脚本追加（gate 校验引用的技能必须存在）。
// ---------------------------------------------------------------------------

import { builtinSkills, builtinSkillStatusCatalog } from "./builtin/catalog.js";
import {
  FAILURE_CODE_ALIASES,
  FAILURE_CODES,
} from "./incidents.js";
import {
  classifyFailure,
  recoveryActions,
  type RecoveryAction,
} from "./recovery/failure-classifier.js";
import { scenarioResults } from "./scenario-results.js";

/** v1 成熟度阶梯（Skill System v1 提示词 §二）。 */
export const skillMaturityLevels = [
  "L0", // 定义/草案（未注册或 schema 缺失——registry 不会装载这种技能）
  "L1", // 注册、schema、catalog 可达
  "L2", // 真实 capability、输出 schema、server verification、unit test
  "L3", // production Goal 可达、typed progress、cancel/recover、FailureCode/Incident、integration
  "L4", // 隔离真实 Minecraft 场景通过
  "L5", // 多版本 + 长跑/多 Bot/外部服灰度通过
] as const;

export type SkillMaturityLevel = (typeof skillMaturityLevels)[number];

export type PlannerReachability = "deterministic" | "llm" | "both";

export type SkillV1ManifestEntry = Readonly<{
  skillId: string;
  schemaVersion: string;
  family: string;
  status: string;
  maturityLevel: SkillMaturityLevel;
  plannerReachability: PlannerReachability;
  runtimeCapabilities: readonly string[];
  gameplayProfiles: readonly string[];
  minecraftRequirements: readonly string[];
  verifiedMinecraftVersions: readonly string[];
  progressContract: string | null;
  postconditionKind: string | null;
  recoveryStrategies: readonly RecoveryAction[];
  failureCodes: readonly string[];
  incidentHooks: readonly string[];
  unitTested: boolean;
  runtimeWired: boolean;
  realScenarioIds: readonly string[];
  evidenceRefs: readonly string[];
  limitations: readonly string[];
  ownerModule: string;
}>;

export type SkillSystemV1Manifest = Readonly<{
  schemaVersion: "1.0";
  generatedFrom: "packages/skills/src/v1-manifest.ts";
  totalSkills: number;
  maturitySummary: Readonly<Record<SkillMaturityLevel, number>>;
  skills: readonly SkillV1ManifestEntry[];
}>;

// ---------------------------------------------------------------------------
// 静态注记（模板映射的出处写在注释里；gates 测试保证 id 全部存在于 catalog）
// ---------------------------------------------------------------------------

/**
 * deterministic = 有确定性 goal 模板直达（apps/coordinator/src/deterministic-goals.ts
 * 的 parseMovement/Scan/Food/Shelter/Stance/Equip/Blueprint/Acquisition 模板；
 * acquisition plan_items 展开为 collect/craft/smelt 步骤）。
 * llm = 仅经 v13 planner prompt 的 advertised catalog。
 */
const PLANNER_REACHABILITY: Readonly<Record<string, PlannerReachability>> = Object.freeze({
  "farm.maintain": "llm", "farm.sustain": "llm", "movement.goal": "llm", "movement.follow": "llm", "movement.get-to-block": "llm",
  "world.explore": "llm", "build.clear-area": "llm", "movement.elytra": "llm",
  "movement.goto": "both",
  "world.scan": "both",
  "food.secure": "both",
  "shelter.dig": "both",
  "combat.stance": "both",
  "inventory.equip-armor": "both",
  "build.blueprint": "both",
  "collect.block": "both",
  "craft.item": "both",
  "smelt.item": "both",
  "travel.route": "llm",
  "combat.engage": "llm",
  "combat.disengage": "llm",
  "world.place-block": "llm",
  "container.transfer": "llm",
  "trade.villager": "llm",
  "mine.branch": "llm",
  "mine.vein": "llm",
  "site.assess": "llm",
  "stock.levels": "llm",
  "store.sort": "llm",
  "pack.shulker": "llm",
  "movement.profile": "llm",
});

/** 技能家族（产品能力族视角，非代码目录）。 */
const FAMILY: Readonly<Record<string, string>> = Object.freeze({
  "farm.maintain": "production", "farm.sustain": "production", "movement.goal": "movement", "movement.follow": "movement", "movement.get-to-block": "movement",
  "world.explore": "observation", "build.clear-area": "build", "movement.elytra": "movement",
  "movement.goto": "movement",
  "travel.route": "movement",
  "movement.profile": "movement",
  "world.scan": "observation",
  "site.assess": "observation",
  "collect.block": "resource",
  "mine.branch": "resource",
  "mine.vein": "resource",
  "food.secure": "survival",
  "craft.item": "production",
  "smelt.item": "production",
  "inventory.equip-armor": "logistics",
  "container.transfer": "logistics",
  "stock.levels": "logistics",
  "store.sort": "logistics",
  "pack.shulker": "logistics",
  "world.place-block": "build",
  "shelter.dig": "build",
  "build.blueprint": "build",
  "trade.villager": "trade",
  "combat.engage": "combat",
  "combat.disengage": "combat",
  "combat.stance": "combat",
});

/** 源模块（ownerModule）。 */
const OWNER_MODULE: Readonly<Record<string, string>> = Object.freeze({
  "farm.maintain": "packages/skills/src/farm-maintenance.ts",
  "farm.sustain": "packages/skills/src/farm-sustain.ts",
  ...Object.fromEntries(["movement.goal", "movement.follow", "movement.get-to-block", "world.explore", "build.clear-area", "movement.elytra"].map((id) => [id, "packages/skills/src/baritone-processes.ts"])),
  "movement.goto": "packages/skills/src/builtin/movement-goto.ts",
  "travel.route": "packages/skills/src/builtin/travel-route.ts",
  "inventory.equip-armor": "packages/skills/src/builtin/equip-armor.ts",
  "combat.engage": "packages/skills/src/builtin/combat-control.ts",
  "combat.disengage": "packages/skills/src/builtin/combat-control.ts",
  "combat.stance": "packages/skills/src/builtin/combat-stance.ts",
  "world.scan": "packages/skills/src/builtin/scan-blocks.ts",
  "collect.block": "packages/skills/src/builtin/collect-block.ts",
  "craft.item": "packages/skills/src/builtin/craft-item.ts",
  "world.place-block": "packages/skills/src/builtin/place-block.ts",
  "container.transfer": "packages/skills/src/builtin/container-transfer.ts",
  "smelt.item": "packages/skills/src/builtin/smelt-item.ts",
  "food.secure": "packages/skills/src/builtin/secure-food.ts",
  "trade.villager": "packages/skills/src/builtin/trade-villager.ts",
  "mine.branch": "packages/skills/src/planning/mine-planner.ts",
  "mine.vein": "packages/skills/src/planning/mine-planner.ts",
  "site.assess": "packages/skills/src/planning/site-assessor.ts",
  "shelter.dig": "packages/skills/src/planning/site-assessor.ts",
  "build.blueprint": "packages/skills/src/planning/blueprint-planner.ts",
  "stock.levels": "packages/skills/src/planning/stock-levels.ts",
  "store.sort": "packages/skills/src/planning/stock-levels.ts",
  "pack.shulker": "packages/skills/src/planning/stock-levels.ts",
  "movement.profile": "packages/skills/src/planning/movement-profile.ts",
});

/**
 * 已知产品级限制（limitations）——只写会影响使用决策的事实，不写愿望。
 */
const LIMITATIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "farm.maintain": ["Bounded crop maintenance; not a farm construction or long-term food throughput claim.", "Requires a shared area lease, loaded cells, and spare planting items."],
  "farm.sustain": ["Builds and audits a bounded irrigated, lit, fenced carrot garden, then harvests, replants and deposits surplus.", "Requires a loaded overworld, building materials, water access and a barrel; sustained production still needs repeated real-server evidence."],
  "movement.goal": ["Mineflayer goal composition with bounded search; no original Baritone Java runtime."],
  "movement.follow": ["Bounded tracking interval; disappearing or replaced entities stop the process."],
  "movement.get-to-block": ["Loaded candidate scan and approach; does not automatically activate containers or blocks."],
  "world.explore": ["Current loaded chunk observations; no durable Baritone region cache or long-range exploration guarantee."],
  "build.clear-area": ["Bounded allowlisted clearing; protects team assets and rejects fluids, falling blocks, and unknown neighbors."],
  "movement.elytra": ["Isolated-test only: bounded takeoff, non-explosive rocket readback, waypoints, cruise and emergency landing controller.", "Full flight and airborne cancellation require isolated-server validation; no obstacle detour planner."],
  "movement.goto": [
    "完成半径 ~4 格（模板锚点按停点动态折算）",
    "死亡掉落回收依赖 coordinator DEATH_RECOVERY goal（同维度、15 分钟窗口）",
  ],
  "build.blueprint": [
    "确定性通道为单行模板（≤64 格/行）；更大结构需多行 goal 或文件蓝图（未实现）",
    "place-block 不移动：bot 必须站在行中点可达范围（≤3.8 格）",
  ],
  "combat.engage": [
    "战术比较层（belief/utility）在战术核心落地前仍为固定闸门（见 docs/research/PVP_SYSTEM_RESEARCH.md §2）",
    "L0 低血暂停会拒绝交战（NORMAL_ACTIONS_PAUSED）——anarchy 场景由 combatIntensity 分档",
  ],
  "combat.disengage": [
    "撤退必 suppressOffense；边打边撤组合待战术核心",
  ],
  "trade.villager": [
    "真实村民交易（≤3.8 格、报价上限校验、读回核对）；entity 不存在时诚实拒绝",
  ],
  "movement.profile": [
    "safe 档禁跑酷/沿途挖掘；anarchy 档全开（防活埋/防引液例外保留）",
  ],
  "mine.branch": ["分支挖掘受安全前置（岩浆邻接/虚空风险）拒绝"],
  "mine.vein": ["同 mine.branch 安全前置"],
  "food.secure": ["依赖 hasSafeFood 判定与采集回退链"],
  "smelt.item": ["F1-F3 真实验证过；F4/F5（重启 reconcile/false-success）本轮补齐"],
  "container.transfer": ["读写统一走授权通道（transfer-safe）"],
  "pack.shulker": ["依赖 container.transfer 通道与潜影盒在场"],
  "store.sort": ["依赖 container.transfer 通道"],
  "world.place-block": ["放置不移动；目标被占时 PLACE_TARGET_OCCUPIED"],
});

/** 七类 typed postcondition（apps/coordinator/src/plan-journal.ts）——当前唯一有生产者的映射。 */
const POSTCONDITION_KIND: Readonly<Record<string, string>> = Object.freeze({
  "build.blueprint": "build-cell",
});

// ---------------------------------------------------------------------------
// 推导
// ---------------------------------------------------------------------------

const ALL_PROFILE_NAMES: readonly string[] = Object.freeze([
  "anarchy_first",
  "standard",
]);

function registeredFailureCodes(code: string): boolean {
  return (
    (FAILURE_CODES as readonly string[]).includes(code) ||
    Object.prototype.hasOwnProperty.call(FAILURE_CODE_ALIASES, code)
  );
}

/**
 * 从技能定义收集稳定失败码：前置条件 failureCode（全部前置条件，含各家族声明）。
 * 能力层的错误码由 capability receipt 契约保证（outputSchema），不在此重复枚举。
 */
function collectFailureCodes(skill: (typeof builtinSkills)[number]): readonly string[] {
  const codes = new Set<string>();
  for (const precondition of skill.preconditions) {
    codes.add(precondition.failureCode);
  }
  return [...codes].sort();
}

function deriveMaturity(input: {
  offlineTests: boolean;
  runtimeWiring: boolean;
  typedProgress: boolean;
  failureCodesRegistered: boolean;
  realScenarioPassCount: number;
  distinctVerifiedVersions: number;
}): SkillMaturityLevel {
  if (!input.offlineTests) return "L1";
  if (!input.runtimeWiring) return "L2";
  if (!input.typedProgress || !input.failureCodesRegistered) return "L2";
  if (input.realScenarioPassCount === 0) return "L3";
  if (input.distinctVerifiedVersions < 2) return "L4";
  return "L5";
}

function buildEntry(
  skill: (typeof builtinSkills)[number],
  statusEntry: (typeof builtinSkillStatusCatalog)[number],
): SkillV1ManifestEntry {
  const failureCodes = collectFailureCodes(skill);
  const failureCodesRegistered = failureCodes.every(registeredFailureCodes);
  const progressContract = skill.progressContract ?? null;

  const passes = scenarioResults.filter(
    (result) =>
      result.result === "PASS" && result.skills.includes(skill.id),
  );
  const verifiedVersions = [
    ...new Set(passes.map((result) => result.minecraftVersion)),
  ].sort();

  const recovery = new Set<RecoveryAction>();
  for (const code of failureCodes) {
    for (const action of classifyFailure(code).ladder) {
      recovery.add(action);
    }
  }
  if (recovery.size === 0) recovery.add("REOBSERVE_THEN_RETRY");

  const requirements = new Set<string>();
  for (const variant of skill.compatibility.variants) {
    for (const requirement of variant.requirements) {
      if (requirement.kind === "feature") {
        requirements.add(`feature:${requirement.name}`);
      } else if (requirement.kind === "server-capability") {
        requirements.add(`server-capability:${requirement.name}`);
      } else {
        requirements.add(`resource:${requirement.names.join("|")}`);
      }
    }
  }

  return Object.freeze({
    skillId: skill.id,
    schemaVersion: skill.version,
    family: FAMILY[skill.id] ?? "uncategorized",
    status: statusEntry.status,
    maturityLevel: deriveMaturity({
      offlineTests: statusEntry.evidence.offlineTests,
      runtimeWiring: statusEntry.evidence.runtimeWiring,
      typedProgress: progressContract !== null,
      failureCodesRegistered,
      realScenarioPassCount: passes.length,
      distinctVerifiedVersions: verifiedVersions.length,
    }),
    plannerReachability: PLANNER_REACHABILITY[skill.id] ?? "llm",
    runtimeCapabilities: Object.freeze([...skill.requiredCapabilities]),
    gameplayProfiles: ALL_PROFILE_NAMES,
    minecraftRequirements: Object.freeze([...requirements].sort()),
    verifiedMinecraftVersions: Object.freeze(verifiedVersions),
    progressContract,
    postconditionKind: POSTCONDITION_KIND[skill.id] ?? null,
    recoveryStrategies: Object.freeze(
      recoveryActions.filter((action) => recovery.has(action)),
    ),
    failureCodes: Object.freeze(failureCodes),
    incidentHooks: Object.freeze(
      statusEntry.evidence.offlineTests ? ["onFault->Incident(primary=root-cause)"] : [],
    ),
    unitTested: statusEntry.evidence.offlineTests,
    runtimeWired: statusEntry.evidence.runtimeWiring,
    realScenarioIds: Object.freeze(passes.map((result) => result.scenarioId)),
    evidenceRefs: Object.freeze(
      passes.map((result) => `${result.scenarioId}@${result.commit}`),
    ),
    limitations: Object.freeze(LIMITATIONS[skill.id] ?? []),
    ownerModule: OWNER_MODULE[skill.id] ?? "unknown",
  });
}

const statusById = new Map(builtinSkillStatusCatalog.map((e) => [e.skillId, e]));

const entries: readonly SkillV1ManifestEntry[] = Object.freeze(
  builtinSkills.map((skill) => {
    const statusEntry = statusById.get(skill.id);
    if (statusEntry === undefined) {
      throw new Error(`v1 manifest: no status entry for ${skill.id}`);
    }
    return buildEntry(skill, statusEntry);
  }),
);

const maturitySummary = Object.fromEntries(
  skillMaturityLevels.map((level) => [
    level,
    entries.filter((entry) => entry.maturityLevel === level).length,
  ]),
) as Readonly<Record<SkillMaturityLevel, number>>;

/** Skill System v1 Manifest（推导结果；JSON 由 scripts/generate-skill-v1-manifest.mjs 落盘）。 */
export const skillSystemV1Manifest: SkillSystemV1Manifest = Object.freeze({
  schemaVersion: "1.0",
  generatedFrom: "packages/skills/src/v1-manifest.ts",
  totalSkills: entries.length,
  maturitySummary,
  skills: entries,
});

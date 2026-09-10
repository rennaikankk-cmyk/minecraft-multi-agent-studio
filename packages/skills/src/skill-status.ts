// ---------------------------------------------------------------------------
// SkillStatus —— 技能成熟度标记（Stable / Partial / Experimental / Broken / Untested）。
//
// 这份表存在的理由是"目录与代码已经不一致"这类错误必须在编译/测试期被挡住，而不是
// 靠人记得改文档。所以标记**不是手写的结论**，而是从证据位推导出来的：
//
//   证据位（哪几道闸真的过了） → deriveSkillStatus → 标记
//
// 三条设计：
//   1. **标记只能推导，不能声明**。没有 `status: "Stable"` 这样的字段可写。要升档
//      只能去把对应的闸门跑绿——文档改不动事实。
//   2. **证据自相矛盾就拒绝装载**。"真实服跑过但运行时没接线"是不可能的组合；
//      与其推出一个好看的档位，不如在导入期就抛（fail-closed）。
//   3. **待办由缺失的证据位派生**。SKILLS.md 里的"待完成"文字来自这里，
//      不再是另一份手抄件。
//
// 纯数据 + 纯函数：无 IO、无时钟。
// ---------------------------------------------------------------------------

/** 五档标记。顺序即成熟度递减，Broken/Untested 是两种不同的"不能用"。 */
export const skillStatuses = [
  /** 四道闸全绿：离线单测 + 运行时接线 + 真实隔离服六类场景 + 跨版本矩阵。 */
  "Stable",
  /** 代码接通且离线可判定，但真实服/跨版本还没有结果。 */
  "Partial",
  /** 只有离线单测，运行时能力尚未接线。 */
  "Experimental",
  /** 有已知缺陷。已知缺陷压倒任何数量的绿灯。 */
  "Broken",
  /** 连离线单测都没有——不知道它能不能用。 */
  "Untested",
] as const;

export type SkillStatus = (typeof skillStatuses)[number];

/** 四道验证闸门，与 docs/skill-verification-runbook.md 的分级一致。 */
export const skillEvidenceGates = [
  "offline-tests",
  "runtime-wiring",
  "isolated-server-scenarios",
  "cross-version-matrix",
] as const;

export type SkillEvidenceGate = (typeof skillEvidenceGates)[number];

export type SkillEvidence = Readonly<{
  /** Schema、授权、前置条件、纯决策函数的离线单测。 */
  offlineTests: boolean;
  /** 运行时能力适配器已接线，且 L0 阻断路径有测试。 */
  runtimeWiring: boolean;
  /** 真实隔离测试服上跑过六类场景（verification-scenarios 的全部类别）。 */
  isolatedServerScenarios: boolean;
  /** 跨 Minecraft 版本矩阵跑过。 */
  crossVersionMatrix: boolean;
  /**
   * 已知缺陷的稳定标识。非空即 Broken——绿灯再多也不能盖住一个已知会坏的行为。
   */
  knownDefects: readonly string[];
}>;

/** 证据组合不可能成立的情形。用于导入期 fail-closed 与单测断言。 */
export const skillEvidenceIssues = [
  /** 真实服跑过，却没有运行时接线：物理上做不到。 */
  "REAL_SERVER_WITHOUT_RUNTIME_WIRING",
  /** 跨版本矩阵绿了，却没有单版本场景结果：矩阵是场景的超集。 */
  "MATRIX_WITHOUT_SERVER_SCENARIOS",
  /** 接线/上服了，却没有离线单测：跳过了最便宜的一道闸。 */
  "WIRED_WITHOUT_OFFLINE_TESTS",
] as const;

export type SkillEvidenceIssue = (typeof skillEvidenceIssues)[number];

/** 检查证据自身是否自相矛盾。空数组 = 可信。 */
export function evidenceIssuesFor(
  evidence: SkillEvidence,
): readonly SkillEvidenceIssue[] {
  const issues: SkillEvidenceIssue[] = [];
  if (evidence.isolatedServerScenarios && !evidence.runtimeWiring) {
    issues.push("REAL_SERVER_WITHOUT_RUNTIME_WIRING");
  }
  if (evidence.crossVersionMatrix && !evidence.isolatedServerScenarios) {
    issues.push("MATRIX_WITHOUT_SERVER_SCENARIOS");
  }
  if (
    (evidence.runtimeWiring || evidence.isolatedServerScenarios) &&
    !evidence.offlineTests
  ) {
    issues.push("WIRED_WITHOUT_OFFLINE_TESTS");
  }
  return Object.freeze(issues);
}

/**
 * 证据 → 标记。判定顺序本身就是纪律：
 * 已知缺陷优先于一切，其次才看闸门从便宜到贵依次是否过。
 */
export function deriveSkillStatus(evidence: SkillEvidence): SkillStatus {
  if (evidence.knownDefects.length > 0) return "Broken";
  if (!evidence.offlineTests) return "Untested";
  if (!evidence.runtimeWiring) return "Experimental";
  if (evidence.isolatedServerScenarios && evidence.crossVersionMatrix) {
    return "Stable";
  }
  return "Partial";
}

/** 还缺哪几道闸。SKILLS.md 的"待完成"由此派生，不手写。 */
export function pendingGatesFor(
  evidence: SkillEvidence,
): readonly SkillEvidenceGate[] {
  const pending: SkillEvidenceGate[] = [];
  if (!evidence.offlineTests) pending.push("offline-tests");
  if (!evidence.runtimeWiring) pending.push("runtime-wiring");
  if (!evidence.isolatedServerScenarios) pending.push("isolated-server-scenarios");
  if (!evidence.crossVersionMatrix) pending.push("cross-version-matrix");
  return Object.freeze(pending);
}

/** 只有真实服 + 跨版本都有结果的技能才允许对外称"已验证"。 */
export function evidenceSupportsVerifiedClaim(evidence: SkillEvidence): boolean {
  return (
    evidence.knownDefects.length === 0 &&
    evidence.offlineTests &&
    evidence.runtimeWiring &&
    evidence.isolatedServerScenarios &&
    evidence.crossVersionMatrix
  );
}

export type SkillStatusEntry = Readonly<{
  skillId: string;
  skillVersion: string;
  status: SkillStatus;
  evidence: SkillEvidence;
  pendingGates: readonly SkillEvidenceGate[];
}>;

/**
 * 每个内建技能的证据位。**只允许在这里改布尔值，且改之前那道闸必须真的跑过。**
 *
 * 当前注册表包含二十个技能；证据中的 runtime-wiring=true 条目为 Partial，其余
 * 规划/策略条目为 Experimental。唯一的例外是 stock.levels：纯函数技能（无
 * capability、state 被 strip 成 {}、无前置条件），L0 暂停对它按设计不生效，
 * 在为这类只读计算技能定义豁免语义之前它的 runtime-wiring 保持 false。
 * 所有技能的真实隔离服六类场景与 1.21.8 跨版本矩阵
 * 尚未执行（AGENTS.md §8：无隔离测试服时不得声称联机测试通过）。
 * 这与技能编译产物里的 `verification: "unverified"` 是同一个事实的两种表述。
 */
const EVIDENCE: Readonly<Record<string, SkillEvidence>> = Object.freeze({
  ...Object.fromEntries(["farm.maintain", "farm.sustain", "movement.goal", "movement.follow", "movement.get-to-block", "world.explore", "build.clear-area", "movement.elytra"].map((id) => [id, {
    offlineTests: true, runtimeWiring: true, isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  }])),
  "movement.goto": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: true, crossVersionMatrix: false, knownDefects: [],
  },
  "travel.route": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "trade.villager": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "mine.branch": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "mine.vein": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "site.assess": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "shelter.dig": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "inventory.equip-armor": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "base.residence-check": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "combat.engage": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "combat.disengage": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "world.scan": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: true, crossVersionMatrix: false, knownDefects: [],
  },
  "collect.block": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "craft.item": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "world.place-block": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "inventory.drop": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "fluid.place": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "animal.breed": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "container.transfer": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "smelt.item": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: true, crossVersionMatrix: false, knownDefects: [],
  },
  "combat.stance": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "food.secure": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "build.blueprint": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: true, crossVersionMatrix: false, knownDefects: [],
  },
  "stock.levels": {
    offlineTests: true, runtimeWiring: false,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "store.sort": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "pack.shulker": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
  "movement.profile": {
    offlineTests: true, runtimeWiring: true,
    isolatedServerScenarios: false, crossVersionMatrix: false, knownDefects: [],
  },
});

/**
 * 用技能自身的 id/version 建目录。**签名要的是技能定义而不是字符串**——
 * 目录因此不可能记住一个不存在的技能 id（`equipment.equip-armor` 这类漂移
 * 在编译期就不成立），也不可能把版本号抄错。
 */
export function buildSkillStatusCatalog(
  definitions: readonly Readonly<{ id: string; version: string }>[],
): readonly SkillStatusEntry[] {
  return Object.freeze(
    definitions.map((definition) => {
      const evidence = EVIDENCE[definition.id];
      if (evidence === undefined) {
        // 新技能没登记证据位就拒绝装载：宁可起不来，也不要让它默认显示成绿的。
        throw new Error(`Skill status evidence missing for ${definition.id}`);
      }
      const issues = evidenceIssuesFor(evidence);
      if (issues.length > 0) {
        throw new Error(
          `Skill status evidence inconsistent for ${definition.id}: ${issues.join(", ")}`,
        );
      }
      return Object.freeze({
        skillId: definition.id,
        skillVersion: definition.version,
        status: deriveSkillStatus(evidence),
        evidence: Object.freeze({ ...evidence, knownDefects: Object.freeze([...evidence.knownDefects]) }),
        pendingGates: pendingGatesFor(evidence),
      });
    }),
  );
}

/** 已登记证据位的技能 id。用于反向查漏：代码里有、这里没有就是漂移。 */
export function skillIdsWithRecordedEvidence(): readonly string[] {
  return Object.freeze(Object.keys(EVIDENCE).sort());
}

// ---------------------------------------------------------------------------
// skill-gap-composition.ts —— composition 级 resolver（SG1 §六 Resolver 链
// 第一级的真实实现，自我改善闭环 D1）。
//
// 纪律：
//   1. 能组合解决就不开发新技能（Resolver 链顺序即纪律）。
//   2. 匹配是确定性的 family/关键词匹配，不解析日志、不 LLM。
//   3. 零命中必须返回 null：真缺 capability 的 gap 绝不标 composition
//      （完成门槛的"不误报"负例）。
// ---------------------------------------------------------------------------

import type { CapabilityGapKind } from "./skill-gap.js";

/** 只有这些 kind 才尝试 composition 建议；其余 kind 的推荐 resolver 本就更高阶。 */
const COMPOSITION_KINDS: ReadonlySet<CapabilityGapKind> = new Set([
  "existing_skill_composition_missing",
  "planner_decomposition_gap",
  "resource_dependency_missing",
  "policy_denied",
]);

export interface CompositionGapInput {
  readonly kind: CapabilityGapKind;
  readonly actionFamily: string;
  readonly requestedSkillId?: string;
  readonly requestedCapability?: string;
}

export interface CompositionSuggestion {
  readonly resolverKind: "existing_composition";
  readonly skillIds: readonly string[];
  readonly rationale: string;
}

/**
 * 从现有 catalog 找可组合的技能候选。family 前缀（skillId 首段）与
 * capability 关键词双路匹配；去重稳定排序。
 */
export function suggestComposition(
  gap: CompositionGapInput,
  catalog: readonly Readonly<{ skillId: string }>[],
): CompositionSuggestion | null {
  if (!COMPOSITION_KINDS.has(gap.kind)) return null;
  const family = gap.actionFamily.trim().toLowerCase();
  if (family.length === 0) return null;
  const capability = gap.requestedCapability?.trim().toLowerCase() ?? "";
  const matches = new Set<string>();
  for (const skill of catalog) {
    const id = skill.skillId.toLowerCase();
    const idFamily = id.split(".")[0] ?? "";
    if (idFamily === family || id === family) matches.add(skill.skillId);
    else if (capability.length > 0 && id.includes(capability)) matches.add(skill.skillId);
    else if (capability.length > 0 && family.length > 0 && idFamily.includes(family)) matches.add(skill.skillId);
  }
  if (matches.size === 0) return null;
  const skillIds = [...matches].sort();
  return {
    resolverKind: "existing_composition",
    skillIds,
    rationale: `action family "${gap.actionFamily}" already has catalog skills; try composing before developing anything new`,
  };
}

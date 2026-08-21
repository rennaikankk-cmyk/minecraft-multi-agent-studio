import { buildSkillStatusCatalog, type SkillStatusEntry } from "../skill-status.js";
import type { SkillDefinition } from "../types.js";
import { collectBlockSkill } from "./collect-block.js";
import { containerTransferSkill } from "./container-transfer.js";
import { craftItemSkill } from "./craft-item.js";
import { equipArmorSkill } from "./equip-armor.js";
import { movementGotoSkill } from "./movement-goto.js";
import { placeBlockSkill } from "./place-block.js";
import { smeltItemSkill } from "./smelt-item.js";

/**
 * 内建技能的**唯一清单**。runtime 注册、验收场景清单、状态目录与文档都从这里读，
 * 因为"七个技能"这个数字此前被抄在三处（runtime.ts 逐行 register、
 * verification-scenarios 的 baseInputs、SKILLS.md 的散文），
 * 于是 `smelt.item` 只漏掉了其中一处就没人发现。
 *
 * 顺序即注册顺序：先移动/装备，再采集/合成/放置/搬运/熔炼。
 *
 * 类型擦除到 `unknown` 是必要的：七个技能的 Input/Output/State 各不相同，
 * 装进同一个数组只能取共同上界。SkillRegistry 内部本就以
 * `SkillDefinition<unknown, unknown, unknown>` 存储，所以这里擦一次即可，
 * 不必为了拼清单去放宽 register 的泛型签名。
 */
export type AnySkillDefinition = SkillDefinition<never, unknown, never>;

export const builtinSkills: readonly AnySkillDefinition[] = Object.freeze([
  movementGotoSkill,
  equipArmorSkill,
  collectBlockSkill,
  craftItemSkill,
  placeBlockSkill,
  containerTransferSkill,
  smeltItemSkill,
] as readonly unknown[] as readonly AnySkillDefinition[]);

/** 内建技能的 id 集合（去重后按字典序），用于跨清单一致性断言。 */
export const builtinSkillIds: readonly string[] = Object.freeze(
  [...new Set(builtinSkills.map((skill) => skill.id))].sort(),
);

/**
 * 七个内建技能的成熟度标记。id/version 取自技能定义本身，
 * 证据位取自 skill-status.ts；两边任何一侧漂移都会在导入期抛错。
 */
export const builtinSkillStatusCatalog: readonly SkillStatusEntry[] =
  buildSkillStatusCatalog(builtinSkills);

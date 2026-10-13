import { buildSkillStatusCatalog, type SkillStatusEntry } from "../skill-status.js";
import type { SkillDefinition } from "../types.js";
import { collectBlockSkill } from "./collect-block.js";
import { combatDisengageSkill, combatEngageSkill } from "./combat-control.js";
import { combatStanceSkill } from "./combat-stance.js";
import { containerTransferSkill } from "./container-transfer.js";
import { craftItemSkill } from "./craft-item.js";
import { equipArmorSkill } from "./equip-armor.js";
import { movementGotoSkill } from "./movement-goto.js";
import { recoverDropsSkill } from "./recover-drops.js";
import { placeBlockSkill } from "./place-block.js";
import { scanBlocksSkill } from "./scan-blocks.js";
import { secureFoodSkill } from "./secure-food.js";
import { animalBreedSkill } from "./animal-breed.js";
import { fluidPlaceSkill } from "./fluid-place.js";
import { portalIgniteSkill, portalUseSkill, ascendSkill, bridgeSkill } from "./nether-travel.js";
import { inventoryDropSkill } from "./inventory-drop.js";
import { smeltItemSkill } from "./smelt-item.js";
import { travelRouteSkill } from "./travel-route.js";
import { tradeVillagerSkill } from "./trade-villager.js";
import { mineBranchSkill, mineVeinSkill } from "../planning/mine-planner.js";
import { siteAssessSkill, shelterDigSkill } from "../planning/site-assessor.js";
import { buildBlueprintSkill } from "../planning/blueprint-planner.js";
import { packShulkerSkill, stockLevelSkill, storeSortSkill } from "../planning/stock-levels.js";
import { movementProfileSkill } from "../planning/movement-profile.js";
import { farmMaintainSkill } from "../farm-maintenance.js";
import { farmSustainSkill } from "../farm-sustain.js";
import { residenceCheckSkill } from "./residence-check.js";
import { hazardAssessSkill } from "./hazard-assess.js";
import { toolPlanSkill } from "./tool-plan.js";
import { foodPickSkill } from "./food-pick.js";
import { stationPlanSkill } from "./station-plan.js";
import { inventoryRoomSkill } from "./inventory-room.js";
import { lightPlaceSkill } from "./light-place.js";
import { bucketFillSkill } from "./bucket-fill.js";
import { foodEatSkill } from "./food-eat.js";
import { sleepBedSkill } from "./sleep-bed.js";
import { baritoneProcessSkills } from "../baritone-processes.js";

/**
 * 内建技能的**唯一清单**。runtime 注册、验收场景清单、状态目录与文档都从这里读，
 * 因为技能数量此前被抄在三处（runtime.ts 逐行 register、
 * verification-scenarios 的 baseInputs、SKILLS.md 的散文），
 * 于是 `smelt.item` 只漏掉了其中一处就没人发现。
 *
 * 顺序即注册顺序：先移动/装备，再感知，再采集/合成/放置/搬运/熔炼。
 *
 * 类型擦除到 `unknown` 是必要的：各技能的 Input/Output/State 各不相同，
 * 装进同一个数组只能取共同上界。SkillRegistry 内部本就以
 * `SkillDefinition<unknown, unknown, unknown>` 存储，所以这里擦一次即可，
 * 不必为了拼清单去放宽 register 的泛型签名。
 */
export type AnySkillDefinition = SkillDefinition<never, unknown, never>;

export const builtinSkills: readonly AnySkillDefinition[] = Object.freeze([
  movementGotoSkill,
  recoverDropsSkill,
  travelRouteSkill,
  equipArmorSkill,
  combatEngageSkill,
  combatDisengageSkill,
  combatStanceSkill,
  scanBlocksSkill,
  collectBlockSkill,
  craftItemSkill,
  placeBlockSkill,
  containerTransferSkill,
  smeltItemSkill,
  secureFoodSkill,
  animalBreedSkill,
  fluidPlaceSkill,
  portalIgniteSkill,
  portalUseSkill,
  ascendSkill,
  bridgeSkill,
  inventoryDropSkill,
  tradeVillagerSkill,
  mineBranchSkill,
  mineVeinSkill,
  siteAssessSkill,
  shelterDigSkill,
  buildBlueprintSkill,
  stockLevelSkill,
  storeSortSkill,
  packShulkerSkill,
  movementProfileSkill,
  farmMaintainSkill,
  farmSustainSkill,
  residenceCheckSkill,
  // Minecraft 常识层：纯确定性判断（requiredCapabilities: []），不产生游戏动作，
  // 用于让战略/战术层把"危险、工具缺口、吃哪口、站点够不够、背包塞不塞得下"
  // 交给确定性代码，而不是让模型凭印象决定。知识表见 src/commons/。
  hazardAssessSkill,
  toolPlanSkill,
  foodPickSkill,
  stationPlanSkill,
  inventoryRoomSkill,
  // 常识层的**执行**面：只做组合，不新增底层能力。light.place 复用已有的
  // block.place-safe，把"这条走廊要不要插火把、插在哪"变成真实放置。
  lightPlaceSkill,
  // 基础动作层：常识的**执行**面。三个都只调 world.interact 的一个操作，
  // 但都会真的碰世界，因此读回校验在适配器里（见 mineflayer-client 的
  // invokeFoodEat / invokeSleepBed / invokeBucketFill）。
  foodEatSkill,
  sleepBedSkill,
  bucketFillSkill,
  ...baritoneProcessSkills,
] as readonly unknown[] as readonly AnySkillDefinition[]);

/** 内建技能的 id 集合（去重后按字典序），用于跨清单一致性断言。 */
export const builtinSkillIds: readonly string[] = Object.freeze(
  [...new Set(builtinSkills.map((skill) => skill.id))].sort(),
);

/**
 * 内建技能的成熟度标记。id/version 取自技能定义本身，
 * 证据位取自 skill-status.ts；两边任何一侧漂移都会在导入期抛错。
 */
export const builtinSkillStatusCatalog: readonly SkillStatusEntry[] =
  buildSkillStatusCatalog(builtinSkills);

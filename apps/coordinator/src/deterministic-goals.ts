// ---------------------------------------------------------------------------
// Deterministic goal parsing —— 协调器自有目标模板 → 结构化决策。
//
// 存在的理由（实测，不是洁癖）：local-planner 的注释里记录了模型在自由
// 分支下对"做一个 crafting_table"这类目标 6/6 回答 noop，被迫加了收窄
// 重试。而自主生存链下发的目标全部产自协调器自己的模板，格式固定、语义
// 唯一——把"模板 → 决策"写成确定性解析，既消灭了这一类模型误判，也让
// 基础生存链在 Spark 不可用时照常运转（AGENTS.md §0.4：AI 宕机 fail-closed
// 到确定性层，而不是停下）。
//
// 边界：这里只解析协调器自己下发的固定模板与单物品采集目标；任何含糊
// 目标返回 null，照旧交给 LLM 分支。解析结果仍要走 planner 既有的
// grounding/校验/派发路径——本模块不绕过任何安全检查。
// ---------------------------------------------------------------------------

import type { GoalRequest } from "@minecraft-studio/skills";
import type { SkillJsonValue } from "@minecraft-studio/protocol";

import { plannedAcquisitionGoalItem } from "./local-planner.js";
import { parseViaGoalTemplateRegistry } from "./goal-template-registry.js";

/**
 * A plan_items decision produced without a model. The free-form goal grammar
 * pins LLM-generated plans to `count: 1` because quantity from prose is not
 * trusted input; this type is only ever built by the coordinator itself from
 * its own goal templates, where the count is parsed from a controlled format
 * (or defaults to 1) — never from an operator free-typing quantities.
 */
export type DeterministicPlanItemsDecision = Readonly<{
  action: "plan_items";
  botId: string;
  taskId: string;
  goals: readonly GoalRequest[];
  reasonCode: string;
}>;

/**
 * An invoke_skill decision produced without a model, for the coordinator's own
 * fixed goal templates (movement/scan/shelter/food). Same shape as the model's
 * branch so it flows through the identical validation and dispatch path.
 */
export type DeterministicSkillDecision = Readonly<{
  action: "invoke_skill";
  botId: string;
  taskId: string;
  skillId: string;
  skillVersion: string;
  input: SkillJsonValue;
  reasonCode: string;
}>;

/** plan_items 分支的合理数量上限（与 GoalPlanner 的 MAX_GOAL_COUNT 对齐由调用方保证）。 */
export const DETERMINISTIC_GOAL_MAX_COUNT = 64;

const SHELTER_DIRECTIONS = new Set(["north", "east", "south", "west"]);
const SHELTER_SEAL_ITEMS = new Set(["dirt", "cobblestone"]);

export type ParsedAcquisitionGoal = Readonly<{
  kind: "acquire-item";
  itemName: string;
  count: number;
}>;

export type ParsedMovementGoal = Readonly<{
  kind: "move-to";
  x: number;
  y: number;
  z: number;
}>;

export type ParsedScanGoal = Readonly<{
  kind: "scan-block";
  blockName: string;
}>;

export type ParsedFoodGoal = Readonly<{
  kind: "secure-food";
  targetCount: number;
}>;

export type ParsedShelterGoal = Readonly<{
  kind: "dig-shelter";
  direction: "north" | "east" | "south" | "west";
  depth: number;
  sealItemName: string;
}>;

export type ParsedEquipGoal = Readonly<{
  kind: "equip-armor";
}>;

export type ParsedStanceGoal = Readonly<{
  kind: "combat-stance";
  stance: "preserve-life" | "expendable" | "aggressive";
}>;

/**
 * Round 6.5 —— 确定性蓝图模板（免模型转写）。
 * 模型对 8+ 格蓝图的结构化转写保真度不足（Round 6.4 实测 PLANNER_DECISION_INVALID）；
 * 模板让蓝图结构由协调器确定性构造——每格坐标、参考面、朝向全部来自受控语法，
 * 与 movement/scan 模板同一纪律：物品名只接受 registry 命名，数量小整数有界。
 */
export type ParsedBlueprintGoal = Readonly<{
  kind: "build-blueprint-row";
  anchor: Readonly<{ x: number; y: number; z: number }>;
  /** 行方向：+x / -x / +z / -z（受控枚举，不接受自由文本）。 */
  direction: "+x" | "-x" | "+z" | "-z";
  count: number;
  itemName: string;
  /** 分批放置：每批格数（缺省全量；J3 resume 用 startIndex 语法另配）。 */
  maxPlacements: number | null;
  /** resume 语义：从第 N 格继续（0 基）。 */
  startIndex: number;
}>;

/**
 * 蓝图文件模板（多行/3D 结构的确定性通道）：
 *
 *   "使用蓝图文件 {name} 施工：锚点 x={ax} y={ay} z={az}[，从第 {s} 格开始]"
 *
 * cell 结构来自 apps/coordinator/blueprints/{name}.json（加载期 zod 校验+
 * 批次几何校验，见 blueprint-files.ts）；goal 只携带锚点（grounded，逐字）。
 * 文件不存在/未加载 → 返回 null 走模型分支（fail-closed：模型不可能转写
 * 512 格，必然诚实失败，不会误建）。
 */
export type ParsedBlueprintFileGoal = Readonly<{
  kind: "build-blueprint-file";
  name: string;
  anchor: Readonly<{ x: number; y: number; z: number }> | null;
  startIndex: number;
}>;

export function parseBlueprintFileGoal(
  operatorGoal: string,
  knownBlueprintNames: ReadonlySet<string>,
): ParsedBlueprintFileGoal | null {
  if (!/使用蓝图文件/.test(operatorGoal)) return null;
  const nameMatch = /使用蓝图文件\s+([a-z0-9][a-z0-9-]{0,63})\s*施工/u.exec(operatorGoal);
  if (nameMatch === null) return null;
  const name = nameMatch[1]!;
  if (!knownBlueprintNames.has(name)) return null;
  // 锚点可选：缺省"就地建造"——协调器用 bot 当前位置做锚点（省去人工
  // 指定坐标、避免 y 在空中的 REFERENCE_BLOCK_NOT_FOUND 三连拒）。
  const anchorMatch = /锚点\s*x\s*[:=]?\s*(-?\d+)\s*y\s*[:=]?\s*(-?\d+)\s*z\s*[:=]?\s*(-?\d+)/u.exec(
    operatorGoal,
  );
  // 不再在这里 early return null——无锚点也要返回（anchor=null 交给上层）。
  const startMatch = /从第\s*(\d{1,3})\s*格开始/u.exec(operatorGoal);
  const startIndex = startMatch !== null ? Math.max(0, Number(startMatch[1]!)) : 0;
  return {
    kind: "build-blueprint-file",
    name,
    // 无锚点 → null → 协调器取 bot 当前位置（就地建造，省去手动坐标）
    anchor: anchorMatch === null ? null : {
      x: Number(anchorMatch[1]!),
      y: Number(anchorMatch[2]!),
      z: Number(anchorMatch[3]!),
    },
    startIndex,
  };
}

export type DeterministicGoal =
  | Readonly<{ kind: "assess-site"; x: number; y: number; z: number }>
  | Readonly<{ kind: "sustain-farm"; facilityId: string }>
  | Readonly<{ kind: "explore-chunks"; x: number; z: number; radius: number }>
  | Readonly<{ kind: "maintain-farm"; crop: "carrots" | "potatoes" | "wheat" | "beetroots"; min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } }>
  | ParsedAcquisitionGoal
  | ParsedMovementGoal
  | ParsedScanGoal
  | ParsedFoodGoal
  | ParsedShelterGoal
  | ParsedEquipGoal
  | ParsedStanceGoal
  | ParsedBlueprintGoal
  | ParsedBlueprintFileGoal;

/**
 * 解析一条目标文本。识别顺序刻意固定：先看采集动词+唯一物品（这是自由
 * 目标里唯一安全可判定的形态），再匹配协调器模板。返回 null 表示"不是
 * 确定性可判定的目标"，调用方必须走模型分支。
 */
export function parseDeterministicGoal(
  operatorGoal: string,
  plannedItemNames: readonly string[],
): DeterministicGoal | null {
  const site = /^评估基地选址 x=(-?\d+) y=(-?\d+) z=(-?\d+)$/u.exec(operatorGoal.trim());
  if (site) return { kind: "assess-site", x: Number(site[1]), y: Number(site[2]), z: Number(site[3]) };
  const sustain = /^维护食物设施 ([a-zA-Z0-9_.:-]+)$/u.exec(operatorGoal.trim());
  if (sustain) return { kind: "sustain-farm", facilityId: sustain[1]! };
  const explore = /^探索区块 x=(-?\d+) z=(-?\d+) radius=(\d+)$/u.exec(operatorGoal.trim());
  if (explore) return { kind: "explore-chunks", x: Number(explore[1]), z: Number(explore[2]), radius: Number(explore[3]) };
  const farm = /^维护农场 (carrots|potatoes|wheat|beetroots) min x=(-?\d+) y=(-?\d+) z=(-?\d+) max x=(-?\d+) y=(-?\d+) z=(-?\d+)$/u.exec(operatorGoal.trim());
  if (farm) return { kind: "maintain-farm", crop: farm[1] as "carrots" | "potatoes" | "wheat" | "beetroots",
    min: { x: Number(farm[2]), y: Number(farm[3]), z: Number(farm[4]) },
    max: { x: Number(farm[5]), y: Number(farm[6]), z: Number(farm[7]) } };
  const acquisition = parseAcquisitionGoal(operatorGoal, plannedItemNames);
  if (acquisition !== null) return acquisition;
  const movement = parseMovementGoal(operatorGoal);
  if (movement !== null) return movement;
  const scan = parseScanGoal(operatorGoal);
  if (scan !== null) return scan;
  const food = parseFoodGoal(operatorGoal);
  if (food !== null) return food;
  const equip = parseEquipGoal(operatorGoal);
  if (equip !== null) return equip;
  const stance = parseStanceGoal(operatorGoal);
  if (stance !== null) return stance;
  // D2：蓝图行等确定性模板经注册表（先注册先用；模板不适用继续旧链兜底）。
  const templated = parseViaGoalTemplateRegistry(operatorGoal);
  if (templated !== null) return templated;
  return parseShelterGoal(operatorGoal);
}

/** 蓝图行模板物品名：registry 命名（与 scan 同纪律）。 */
const BLUEPRINT_ITEM_PATTERN = /^[a-z0-9_]+$/u;

/**
 * Round 6.5 蓝图行模板（确定性，免模型转写）：
 *
 *   "施工蓝图行：锚点 x={ax} y={ay} z={az}，沿 {+x|-x|+z|-z} 放置 {n} 个
 *    {item}，每批最多 {m} 格，从第 {s} 格开始"
 *
 * 每批/从第…格为可选段（缺省=全量、从 0）。数量上界 64（模板蓝图规模），
 * 方向受控枚举。锚点坐标三元组必须恰好出现一次（多个=语义不明→模型分支）。
 */
export function parseBlueprintGoal(operatorGoal: string): ParsedBlueprintGoal | null {
  if (!/施工蓝图行/.test(operatorGoal)) return null;
  const anchorMatch = /锚点\s*x\s*[:=]?\s*(-?\d+)\s*y\s*[:=]?\s*(-?\d+)\s*z\s*[:=]?\s*(-?\d+)/u.exec(
    operatorGoal,
  );
  if (anchorMatch === null) return null;
  const directionMatch = /沿\s*([+-][xz])/u.exec(operatorGoal);
  if (directionMatch === null) return null;
  const direction = directionMatch[1]!;
  if (direction !== "+x" && direction !== "-x" && direction !== "+z" && direction !== "-z") {
    return null;
  }
  const countMatch = /放置\s*(\d{1,2})\s*个/u.exec(operatorGoal);
  if (countMatch === null) return null;
  const count = Number(countMatch[1]!);
  if (count < 1 || count > 64) return null;
  const itemMatch = /个\s+([a-z0-9_]+)\s*[,，]/u.exec(operatorGoal)
    ?? /个\s+([a-z0-9_]+)\s*每批/u.exec(operatorGoal)
    ?? /个\s+([a-z0-9_]+)\s*从第/u.exec(operatorGoal)
    ?? /个\s+([a-z0-9_]+)\s*$/u.exec(operatorGoal.trimEnd());
  if (itemMatch === null) return null;
  const itemName = itemMatch[1]!;
  if (!BLUEPRINT_ITEM_PATTERN.test(itemName)) return null;
  const batchMatch = /每批最多\s*(\d{1,3})\s*格/u.exec(operatorGoal);
  const maxPlacements = batchMatch !== null ? Math.max(1, Math.min(128, Number(batchMatch[1]!))) : null;
  const startMatch = /从第\s*(\d{1,3})\s*格开始/u.exec(operatorGoal);
  const startIndex = startMatch !== null ? Math.max(0, Number(startMatch[1]!)) : 0;
  return {
    kind: "build-blueprint-row",
    anchor: {
      x: Number(anchorMatch[1]!),
      y: Number(anchorMatch[2]!),
      z: Number(anchorMatch[3]!),
    },
    direction,
    count,
    itemName,
    maxPlacements,
    startIndex,
  };
}

/**
 * 单物品采集目标 → {itemName, count}。物品名判定复用 local-planner 的
 * plannedAcquisitionGoalItem（动词 + 唯一命中 + 可达集合），数量只在物品
 * 名紧邻处取一个小整数，取不到就是 1。
 */
export function parseAcquisitionGoal(
  operatorGoal: string,
  plannedItemNames: readonly string[],
): ParsedAcquisitionGoal | null {
  const itemName = plannedAcquisitionGoalItem(operatorGoal, plannedItemNames);
  if (itemName === null) return null;
  return {
    kind: "acquire-item",
    itemName,
    count: acquisitionGoalCount(operatorGoal, itemName),
  };
}

/**
 * 物品名相邻的数量。接受 "获取 8 个 oak_log"、"获取 oak_log 8 个"、
 * "获取 oak_log x8"、"获取 8 oak_log"。中英单位词都只作为可选装饰。
 * 超上限的数字视为没有可信数量，回到 1。
 */
function acquisitionGoalCount(operatorGoal: string, itemName: string): number {
  const spellings = [
    itemName,
    itemName.replaceAll("_", " "),
  ];
  for (const spelling of spellings) {
    const escaped = escapeRegExp(spelling);
    const before = new RegExp(
      `(?:\\d{1,3})\\s*(?:个|块|份|只|把|张|根|条|x|×)?\\s*${escaped}`,
      "iu",
    );
    const after = new RegExp(
      `${escaped}\\s*(?:x|×)?\\s*(\\d{1,3})\\s*(?:个|块|份|只|把|张|根|条)?`,
      "iu",
    );
    const leading = operatorGoal.match(before);
    if (leading !== null) {
      const digits = leading[0].match(/\d{1,3}/);
      if (digits !== null) return boundedCount(Number(digits[0]));
    }
    const trailing = operatorGoal.match(after);
    if (trailing !== null) return boundedCount(Number(trailing[1]));
  }
  return 1;
}

function boundedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) return 1;
  return Math.min(value, DETERMINISTIC_GOAL_MAX_COUNT);
}

/**
 * 协调器恢复模板："移动到坐标 x=A y=B z=C 附近"（尾部可带"继续观察 …"）。
 * 恰好一个坐标三元组才接受——多个坐标意味着语义不唯一，交回模型分支。
 */
export function parseMovementGoal(operatorGoal: string): ParsedMovementGoal | null {
  if (!/移动到坐标/.test(operatorGoal)) return null;
  const triples = coordinateTriples(operatorGoal);
  if (triples.length !== 1) return null;
  const [x, y, z] = triples[0]!;
  return { kind: "move-to", x, y, z };
}

/**
 * 协调器恢复模板："读取当前区域的 {block} 方块分布并给出扫描结果，只读"。
 * 方块名只接受 registry 命名（小写+下划线），杜绝把自由文本塞进技能输入。
 */
export function parseScanGoal(operatorGoal: string): ParsedScanGoal | null {
  const match =
    /读取当前区域的\s+([a-z0-9_]+)\s+方块分布并给出扫描结果，只读/u.exec(
      operatorGoal,
    );
  if (match === null) return null;
  return { kind: "scan-block", blockName: match[1]! };
}

/**
 * 协调器食物模板："获取 {N} 份安全食物"。数量必填：协调器自己 always 带
 * 数量下发，宽松匹配只会把无关散文误判成食物目标。注意"安全食物"不是
 * 资源图物品，所以永远不会撞上采集解析——这是刻意的：食物获取走
 * food.secure 技能，不走 mine/craft/smelt 配方链。
 */
export function parseFoodGoal(operatorGoal: string): ParsedFoodGoal | null {
  // P0: 匹配总量语义格式 "获取安全食物到总量 12 份"（survival-needs 产出）
  const totalMatch = /获取安全食物到总量\s*(\d{1,3})\s*份/u.exec(operatorGoal);
  if (totalMatch !== null) {
    return { kind: "secure-food", targetCount: boundedCount(Number(totalMatch[1])) };
  }
  // 兼容旧格式 "获取 N 份安全食物"
  const legacyMatch = /获取\s*(\d{1,3})\s*份安全食物/u.exec(operatorGoal);
  if (legacyMatch !== null) {
    return { kind: "secure-food", targetCount: boundedCount(Number(legacyMatch[1])) };
  }
  return null;
}

/**
 * 协调器避难所模板："在当前维度向 {direction} 挖一个 {N} 格深的安全避难所，
 * 并用 {item} 封口"。方向与封口材料都来自固定白名单。
 */
export function parseShelterGoal(operatorGoal: string): ParsedShelterGoal | null {
  const match =
    /向\s*(north|east|south|west)\s*挖一个\s*(\d)\s*格深的安全避难所，并用\s*(\w+)\s*封口/u.exec(
      operatorGoal,
    );
  if (match === null) return null;
  const direction = match[1]! as ParsedShelterGoal["direction"];
  if (!SHELTER_DIRECTIONS.has(direction)) return null;
  const sealItemName = match[3]!;
  if (!SHELTER_SEAL_ITEMS.has(sealItemName)) return null;
  const depth = Number(match[2]);
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 4) return null;
  return { kind: "dig-shelter", direction, depth, sealItemName };
}

/**
 * 协调器立场模板："切换战斗立场为 {stance}"。立场集合与 combat.stance
 * 技能的输入枚举一致——白名单外的一句话不会被解析。
 */
export function parseStanceGoal(operatorGoal: string): ParsedStanceGoal | null {
  const match =
    /切换战斗立场为\s*(preserve-life|expendable|aggressive)/u.exec(operatorGoal);
  if (match === null) return null;
  return {
    kind: "combat-stance",
    stance: match[1] as ParsedStanceGoal["stance"],
  };
}

/**
 * 协调器穿甲模板："穿上最好的护甲"。equip-armor 是幂等的每槽最优决策技能，
 * 无参数语义，固定一句话即可无歧义识别。
 */
export function parseEquipGoal(operatorGoal: string): ParsedEquipGoal | null {
  return operatorGoal.trim() === "穿上最好的护甲"
    ? { kind: "equip-armor" }
    : null;
}

function coordinateTriples(goal: string): Array<readonly [number, number, number]> {
  const number = "-?\\d+(?:\\.\\d+)?";
  const pattern = new RegExp(
    `x\\s*=\\s*(${number})\\s*y\\s*=\\s*(${number})\\s*z\\s*=\\s*(${number})`,
    "giu",
  );
  const triples: Array<readonly [number, number, number]> = [];
  for (const match of goal.matchAll(pattern)) {
    triples.push([Number(match[1]), Number(match[2]), Number(match[3])]);
  }
  return triples;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

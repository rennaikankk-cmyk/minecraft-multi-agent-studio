// ---------------------------------------------------------------------------
// blueprint-files.ts —— 蓝图文件 DSL（Skill System v1 已知缺口"多行/3D 结构
// 确定性输入"的落地形态）。
//
// 纪律（与单行模板同源，docs/research/PVP_SYSTEM_RESEARCH.md 之外的工程准则）：
//   1. **模型零转写**：结构化 cell 数组只来自本目录下经 zod 校验的 JSON 文件，
//      goal 文本只携带锚点（逐字、grounded）。8+ 格蓝图经 LLM 转写必挂
//      （PLANNER_DECISION_INVALID，Round 6.4 实测）——文件路径绕开该瓶颈。
//   2. **fail-closed**：任何文件 schema 不合法直接在加载期抛（协调器拒启），
//      不静默跳过；文件名只认 [a-z0-9-]+，杜绝路径穿越。
//   3. **批次显式**：执行器（world.place-block）不移动，单批全部格必须在
//      批次站位点 reach（3.8）内——文件作者用 batches 声明站位与批界，
//      批间移动由编排层显式 goal 完成（自动交错是下一步）。
//   4. cells ≤512（与 build.blueprint MAX_BLUEPRINT_CELLS 对齐）；order 由
//      声明顺序派生（index*8），文件不得自带 order。
// ---------------------------------------------------------------------------

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const MAX_BLUEPRINT_CELLS = 512;
export const BLUEPRINT_BATCH_MAX = 64;

const offsetSchema = z
  .object({
    x: z.number().int().min(-64).max(64),
    y: z.number().int().min(-8).max(64),
    z: z.number().int().min(-64).max(64),
  })
  .strict();

const faceSchema = z
  .object({
    x: z.number().int().min(-1).max(1),
    y: z.number().int().min(-1).max(1),
    z: z.number().int().min(-1).max(1),
  })
  .strict()
  .refine(
    (face) => Math.abs(face.x) + Math.abs(face.y) + Math.abs(face.z) === 1,
    { message: "face 必须是单位轴向向量" },
  );

const itemNameSchema = z
  .string()
  .regex(/^[a-z0-9_]+$/u, { message: "物品名必须是 registry 命名（snake_case）" })
  .max(64);

const blockClassSchema = z.enum(["structural", "utility"]);

const blueprintCellFileSchema = z
  .object({
    /** 相对锚点的位移。 */
    offset: offsetSchema,
    item: itemNameSchema,
    blockClass: blockClassSchema.optional(),
    /** 放置支撑面；默认格正下方（face 朝上）。 */
    face: faceSchema.optional(),
    referenceOffset: offsetSchema.optional(),
    blockProperties: z.array(z.object({ name: z.string().min(1).max(64), value: z.union([z.string(), z.number(), z.boolean()]) }).strict()).max(32).optional(),
  })
  .strict();

export const blueprintFileSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,63}$/u, { message: "蓝图名只允许小写字母数字连字符" }),
    description: z.string().max(500),
    /** 每次派发最多放置的格数（startIndex 语义与 build.blueprint 一致）。 */
    batchSize: z.number().int().min(1).max(BLUEPRINT_BATCH_MAX),
    /**
     * 批次站位（相对锚点）。编排层在派发每批前把 bot 移到对应站位；
     * 该批全部格必须在站位 reach（3.8 格）内——加载期做几何校验。
     */
    staging: z
      .array(
        z
          .object({
            /** 1 起的批号：批 k 覆盖 cells[(k-1)*batchSize, k*batchSize)。 */
            batch: z.number().int().min(1),
            offset: offsetSchema,
          })
          .strict(),
      )
      .min(1)
      .max(64),
    cells: z.array(blueprintCellFileSchema).min(1).max(MAX_BLUEPRINT_CELLS),
    /** 来源与机制注记（docs/research/FARM_BLUEPRINTS.md 引用）。 */
    notes: z.string().max(1_000).optional(),
  })
  .strict();

export type BlueprintFileCell = z.infer<typeof blueprintCellFileSchema>;
export type BlueprintFile = z.infer<typeof blueprintFileSchema>;

const BLUEPRINT_FILE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "blueprints",
);

/** 已加载的蓝图文件（name → 校验后的结构）。加载失败=协调器拒启。 */
export function loadBlueprintFiles(
  dir: string = BLUEPRINT_FILE_DIR,
): ReadonlyMap<string, BlueprintFile> {
  const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`blueprint-files: ${dir} 下没有任何蓝图文件`);
  }
  const byName = new Map<string, BlueprintFile>();
  for (const fileName of files) {
    const parsed = blueprintFileSchema.safeParse(
      JSON.parse(readFileSync(path.join(dir, fileName), "utf8")),
    );
    if (!parsed.success) {
      throw new Error(
        `blueprint-files: ${fileName} schema 不合法（fail-closed）：${parsed.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join(".")}:${issue.message}`)
          .join("; ")}`,
      );
    }
    const blueprint = parsed.data;
    if (byName.has(blueprint.name)) {
      throw new Error(`blueprint-files: 蓝图名重复 ${blueprint.name}`);
    }
    validateStagingGeometry(blueprint);
    byName.set(blueprint.name, blueprint);
  }
  return byName;
}

/**
 * 批次几何校验：批 k 的所有格到该批站位的水平距离必须 ≤3.5（玩家 reach
 * 3.8 的保守余量；3.0 在 25 格结构上会拒绝 (1,3) 对角这类完全可达的站位）。
 * 缺批声明的批直接拒绝（作者必须全覆盖）。
 */
export function validateStagingGeometry(blueprint: BlueprintFile): void {
  const batchCount = Math.ceil(blueprint.cells.length / blueprint.batchSize);
  const stagingByBatch = new Map(blueprint.staging.map((entry) => [entry.batch, entry.offset]));
  for (let batch = 1; batch <= batchCount; batch += 1) {
    const staging = stagingByBatch.get(batch);
    if (staging === undefined) {
      throw new Error(
        `blueprint-files: ${blueprint.name} 批 ${batch} 缺少 staging 声明`,
      );
    }
    const from = (batch - 1) * blueprint.batchSize;
    const to = Math.min(batch * blueprint.batchSize, blueprint.cells.length);
    for (let index = from; index < to; index += 1) {
      const cell = blueprint.cells[index]!;
      const dx = cell.offset.x - staging.x;
      const dz = cell.offset.z - staging.z;
      if (Math.hypot(dx, dz) > 3.5) {
        throw new Error(
          `blueprint-files: ${blueprint.name} 批 ${batch} 第 ${index + 1} 格距站位超 reach（dx=${dx} dz=${dz}）`,
        );
      }
    }
  }
}

/** 派发用：文件 cells → build.blueprint cells（order=声明序×8，默认支撑面朝上）。 */
export function blueprintCellsForDispatch(blueprint: BlueprintFile) {
  return blueprint.cells.map((cell, index) => ({
    offset: cell.offset,
    itemName: cell.item,
    blockClass: cell.blockClass ?? ("structural" as const),
    order: index * 8,
    referenceOffset: cell.referenceOffset ?? { x: 0, y: -1, z: 0 },
    face: cell.face ?? { x: 0, y: 1, z: 0 },
    ...(cell.blockProperties ? { blockProperties: cell.blockProperties } : {}),
  }));
}

/**
 * 蓝图批用料缺口（材料预采集，Implementation Prompt V1）：本批
 * （startIndex..startIndex+batchSize）用料与背包比对。返回"需要-持有"
 * 的采集目标；空数组=无缺口。纯函数：同一蓝图+背包永远同一结果。
 */
export function blueprintBatchMaterialDeficit(
  blueprint: BlueprintFile,
  startIndex: number,
  inventory: ReadonlyMap<string, number>,
): readonly { itemName: string; count: number }[] {
  const from = Math.max(0, Math.min(startIndex, blueprint.cells.length));
  const to = Math.min(from + blueprint.batchSize, blueprint.cells.length);
  const required = new Map<string, number>();
  for (let index = from; index < to; index += 1) {
    const item = blueprint.cells[index]!.item;
    required.set(item, (required.get(item) ?? 0) + 1);
  }
  const goals: Array<{ itemName: string; count: number }> = [];
  for (const [itemName, count] of required) {
    const have = inventory.get(itemName) ?? 0;
    if (have < count) goals.push({ itemName, count: count - have });
  }
  return goals;
}

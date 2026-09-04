// 蓝图文件 DSL 测试：解析器、加载器（fail-closed + 批次几何）、派发 cell 构造。
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseBlueprintFileGoal } from "../src/deterministic-goals.js";
import {
  blueprintBatchMaterialDeficit,
  blueprintCellsForDispatch,
  blueprintFileSchema,
  loadBlueprintFiles,
} from "../src/blueprint-files.js";

const NAMES = new Set(["cobble-generator", "iron-farm-cell"]);

describe("parseBlueprintFileGoal", () => {
  it("匹配完整形态（含起始格）", () => {
    const parsed = parseBlueprintFileGoal(
      "使用蓝图文件 cobble-generator 施工：锚点 x=10 y=70 z=-4，从第 16 格开始",
      NAMES,
    );
    expect(parsed).toEqual({
      kind: "build-blueprint-file",
      name: "cobble-generator",
      anchor: { x: 10, y: 70, z: -4 },
      startIndex: 16,
    });
  });

  it("缺省起始格 = 0", () => {
    const parsed = parseBlueprintFileGoal(
      "使用蓝图文件 iron-farm-cell 施工：锚点 x=0 y=64 z=0",
      NAMES,
    );
    expect(parsed?.startIndex).toBe(0);
  });

  it("未知蓝图名 → null（fail-closed 走模型分支，模型必拒 512 格）", () => {
    expect(parseBlueprintFileGoal("使用蓝图文件 no-such 施工：锚点 x=0 y=64 z=0", NAMES)).toBeNull();
  });

  it("缺锚点/缺施工关键词 → null", () => {
    // 缺锚点 → 现在合法（auto-anchor，anchor=null 交给协调器 bot 位置 fallback）
    expect(parseBlueprintFileGoal("使用蓝图文件 cobble-generator：锚点 x=0 y=64 z=0", NAMES)).toBeNull();
  });

  it("名字只认 [a-z0-9-]（路径穿越拒绝）", () => {
    expect(parseBlueprintFileGoal("使用蓝图文件 ../etc 施工：锚点 x=0 y=64 z=0", NAMES)).toBeNull();
  });
});

function writeBlueprint(dir: string, file: string, body: unknown): string {
  writeFileSync(path.join(dir, file), JSON.stringify(body), "utf8");
  return path.join(dir, file);
}

const VALID = {
  schemaVersion: "1.0",
  name: "demo",
  description: "测试蓝图",
  batchSize: 4,
  staging: [
    { batch: 1, offset: { x: 0, y: 1, z: 2 } },
    { batch: 2, offset: { x: 3, y: 1, z: 2 } },
  ],
  cells: [
    { offset: { x: 0, y: 0, z: 0 }, item: "cobblestone" },
    { offset: { x: 1, y: 0, z: 0 }, item: "cobblestone" },
    { offset: { x: 2, y: 0, z: 0 }, item: "cobblestone" },
    { offset: { x: 0, y: 0, z: -1 }, item: "oak_log" },
    { offset: { x: 3, y: 0, z: 0 }, item: "cobblestone" },
    { offset: { x: 4, y: 0, z: 0 }, item: "cobblestone" },
  ],
};

describe("loadBlueprintFiles", () => {
  let dir: string;
  it.beforeEach = () => undefined;
  const makeDir = () => {
    dir = mkdtempSync(path.join(tmpdir(), "bp-files-"));
    return dir;
  };
  const cleanup = () => rmSync(dir, { recursive: true, force: true });

  it("合法目录加载 + 派发 cell 构造（order=声明序×8，默认支撑面朝上）", () => {
    makeDir();
    try {
      writeBlueprint(dir, "demo.json", VALID);
      const loaded = loadBlueprintFiles(dir);
      expect(loaded.size).toBe(1);
      const demo = loaded.get("demo")!;
      const cells = blueprintCellsForDispatch(demo);
      expect(cells).toHaveLength(6);
      expect(cells[0]).toMatchObject({
        offset: { x: 0, y: 0, z: 0 },
        itemName: "cobblestone",
        blockClass: "structural",
        order: 0,
        referenceOffset: { x: 0, y: -1, z: 0 },
        face: { x: 0, y: 1, z: 0 },
      });
      expect(cells[5]!.order).toBe(40);
    } finally {
      cleanup();
    }
  });

  it("schema 违例 fail-closed（多余字段拒收）", () => {
    makeDir();
    try {
      writeBlueprint(dir, "bad.json", { ...VALID, extra: true });
      expect(() => loadBlueprintFiles(dir)).toThrow(/schema 不合法/);
    } finally {
      cleanup();
    }
  });

  it("批次站位缺失 → 拒载", () => {
    makeDir();
    try {
      writeBlueprint(dir, "demo.json", { ...VALID, staging: VALID.staging.slice(0, 1) });
      expect(() => loadBlueprintFiles(dir)).toThrow(/批 2 缺少 staging/);
    } finally {
      cleanup();
    }
  });

  it("格距站位超 reach（水平 >3.5）→ 拒载", () => {
    makeDir();
    try {
      writeBlueprint(dir, "far.json", {
        ...VALID,
        staging: [
          { batch: 1, offset: { x: 0, y: 1, z: 2 } },
          { batch: 2, offset: { x: 0, y: 1, z: 2 } },
        ],
      });
      expect(() => loadBlueprintFiles(dir)).toThrow(/超 reach/);
    } finally {
      cleanup();
    }
  });

  it("重名蓝图 → 拒载", () => {
    makeDir();
    try {
      writeBlueprint(dir, "a.json", VALID);
      writeBlueprint(dir, "b.json", VALID);
      expect(() => loadBlueprintFiles(dir)).toThrow(/重复/);
    } finally {
      cleanup();
    }
  });

  it("空目录 → 拒载", () => {
    makeDir();
    try {
      expect(() => loadBlueprintFiles(dir)).toThrow(/没有任何蓝图文件/);
    } finally {
      cleanup();
    }
  });
});

describe("仓库自带蓝图（apps/coordinator/blueprints）", () => {
  it("cobble-generator 加载通过且批次全覆盖", () => {
    const repoDir = path.resolve(import.meta.dirname, "..", "blueprints");
    const loaded = loadBlueprintFiles(repoDir);
    expect(loaded.has("cobble-generator")).toBe(true);
    const cobble = loaded.get("cobble-generator")!;
    expect(cobble.cells.length).toBe(25);
    const batchCount = Math.ceil(cobble.cells.length / cobble.batchSize);
    const covered = new Set(cobble.staging.map((entry) => entry.batch));
    for (let batch = 1; batch <= batchCount; batch += 1) {
      expect(covered.has(batch), `batch ${batch}`).toBe(true);
    }
  });

  it("schema 可直接复用校验（导出的 blueprintFileSchema）", () => {
    expect(blueprintFileSchema.safeParse(VALID).success).toBe(true);
  });
});

describe("blueprintBatchMaterialDeficit（材料预采集）", () => {
  it("starter-base-v1 批 1 全缺料 → 圆石 18 缺口", () => {
    const repoDir = path.resolve(import.meta.dirname, "..", "blueprints");
    const base = loadBlueprintFiles(repoDir).get("starter-base-v1")!;
    expect(blueprintBatchMaterialDeficit(base, 0, new Map())).toEqual([
      { itemName: "cobblestone", count: 18 },
    ]);
  });

  it("部分持有 → 只报差值", () => {
    const repoDir = path.resolve(import.meta.dirname, "..", "blueprints");
    const base = loadBlueprintFiles(repoDir).get("starter-base-v1")!;
    expect(
      blueprintBatchMaterialDeficit(base, 0, new Map([["cobblestone", 7]])),
    ).toEqual([{ itemName: "cobblestone", count: 11 }]);
  });

  it("批 5（尾部 13 格）→ 木板/熔炉/工作台/箱子/火把混合缺口", () => {
    const repoDir = path.resolve(import.meta.dirname, "..", "blueprints");
    const base = loadBlueprintFiles(repoDir).get("starter-base-v1")!;
    const goals = blueprintBatchMaterialDeficit(base, 72, new Map());
    const byName = new Map(goals.map((g) => [g.itemName, g.count]));
    expect(byName.get("torch")).toBe(2);
    expect(byName.get("furnace")).toBe(1);
    expect(byName.get("crafting_table")).toBe(1);
    expect(byName.get("chest")).toBe(1);
    expect((byName.get("oak_planks") ?? 0) > 0).toBe(true);
  });

  it("齐料 → 空缺口；越界 startIndex → 空缺口", () => {
    const repoDir = path.resolve(import.meta.dirname, "..", "blueprints");
    const base = loadBlueprintFiles(repoDir).get("starter-base-v1")!;
    expect(
      blueprintBatchMaterialDeficit(base, 0, new Map([["cobblestone", 30]])),
    ).toEqual([]);
    expect(blueprintBatchMaterialDeficit(base, 999, new Map())).toEqual([]);
  });
});

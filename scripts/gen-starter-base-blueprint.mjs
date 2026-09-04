// 从 packages/skills/src/base-registry.ts 的 starterBaseV1() 逻辑推导
// apps/coordinator/blueprints/starter-base-v1.json（Phase 1c）。
// 断言计数与代码函数严格一致后才写文件。
import { writeFileSync } from "node:fs";

const WALL = "oak_planks";
const FLOOR = "cobblestone";

const cells = [];
// 地板（foundation 先行）
for (let x = 0; x <= 4; x += 1) {
  for (let z = 0; z <= 4; z += 1) {
    cells.push({ offset: { x, y: 0, z }, item: FLOOR });
  }
}
// 墙：周界 y=1..2，南墙中心 (2,4) 留 2 高门洞
for (let y = 1; y <= 2; y += 1) {
  for (let x = 0; x <= 4; x += 1) {
    for (let z = 0; z <= 4; z += 1) {
      const onPerimeter = x === 0 || x === 4 || z === 0 || z === 4;
      if (!onPerimeter) continue;
      const isDoorway = x === 2 && z === 4 && (y === 1 || y === 2);
      if (isDoorway) continue;
      cells.push({ offset: { x, y, z }, item: WALL });
    }
  }
}
// 顶：外圈 → 内圈向心
for (let ring = 0; ring <= 2; ring += 1) {
  for (let x = ring; x <= 4 - ring; x += 1) {
    for (let z = ring; z <= 4 - ring; z += 1) {
      const onRing =
        (x === ring || x === 4 - ring || z === ring || z === 4 - ring) &&
        !(x > ring && x < 4 - ring && z > ring && z < 4 - ring);
      if (!onRing) continue;
      cells.push({ offset: { x, y: 3, z }, item: WALL });
    }
  }
}
// 工作站（室内角落；贴墙放置面=墙，用默认 face 朝上亦可）
cells.push({ offset: { x: 1, y: 1, z: 1 }, item: "furnace", blockClass: "utility" });
cells.push({ offset: { x: 3, y: 1, z: 1 }, item: "crafting_table", blockClass: "utility" });
cells.push({ offset: { x: 1, y: 1, z: 3 }, item: "chest", blockClass: "utility" });
// 火把
cells.push({ offset: { x: 3, y: 1, z: 3 }, item: "torch" });
cells.push({ offset: { x: 2, y: 1, z: 2 }, item: "torch" });

// ---- 计数断言（与代码函数 parity）----
const count = (item) => cells.filter((c) => c.item === item).length;
const assertEq = (actual, expected, label) => {
  if (actual !== expected) throw new Error(`parity fail: ${label} ${actual} != ${expected}`);
};
assertEq(cells.length, 85, "total");
assertEq(count("cobblestone"), 25, "floor");
assertEq(count("oak_planks"), 55, "walls+roof");
assertEq(count("furnace"), 1, "furnace");
assertEq(count("crafting_table"), 1, "crafting_table");
assertEq(count("chest"), 1, "chest");
assertEq(count("torch"), 2, "torch");

// 门洞断言：(2,1,4) 与 (2,2,4) 必须缺席
for (const y of [1, 2]) {
  if (cells.some((c) => c.offset.x === 2 && c.offset.y === y && c.offset.z === 4)) {
    throw new Error(`parity fail: doorway (2,${y},4) occupied`);
  }
}

// ---- staging：室内中心 (2,1,2)，全格水平距离 ≤ 2.83 ≤ 3.5 ----
const batchSize = 18;
const batchCount = Math.ceil(cells.length / batchSize);
const staging = [];
for (let b = 1; b <= batchCount; b += 1) {
  staging.push({ batch: b, offset: { x: 2, y: 1, z: 2 } });
}
for (let b = 1; b <= batchCount; b += 1) {
  const from = (b - 1) * batchSize;
  const to = Math.min(b * batchSize, cells.length);
  for (let i = from; i < to; i += 1) {
    const d = Math.hypot(cells[i].offset.x - 2, cells[i].offset.z - 2);
    if (d > 3.5) throw new Error(`staging fail: batch ${b} cell ${i} dist ${d}`);
  }
}

const blueprint = {
  schemaVersion: "1.0",
  name: "starter-base-v1",
  description:
    "5x5 生存小屋（starter_base_v1 代码函数的 JSON 投影）：y=0 圆石地板 25，周界橡木板墙 y=1..2（南墙中心 (2,4) 留 2 高门洞），y=3 向心屋顶 25，室内熔炉/工作台/箱子，2 火把。与 packages/skills/src/base-registry.ts starterBaseV1() 严格同构（改布局须两处同步）。",
  batchSize,
  staging,
  cells,
  notes:
    "站位=室内中心 (2,1,2)，全格水平距离 ≤2.83。地板会替换自然地面（地形自适应放置：先挖后放）。门洞朝 +z（南）。材料：圆石 25、橡木板 55、熔炉/工作台/箱子各 1、火把 2。",
};
writeFileSync(
  new URL("../apps/coordinator/blueprints/starter_base_v1.json", import.meta.url),
  JSON.stringify(blueprint, null, 2) + "\n",
);
console.log(`written: 85 cells, ${batchCount} batches, parity OK`);

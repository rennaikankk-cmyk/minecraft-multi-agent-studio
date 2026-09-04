// 冒烟 + 基准：同一场景下 Rust 引擎（worker 线程）对比 Node 主线程占用。
// 场景：64×24×64 体素，一条 64 格走廊 + 中段 diggable 墙 + 随机地形。
"use strict";
const { performance } = require("node:perf_hooks");
const { CLASS, findPathAsync, findPathSync } = require("./index.js");

function buildScenario(sx, sy, sz) {
  const classes = Buffer.alloc(sx * sy * sz, CLASS.PASSABLE);
  const at = (x, y, z) => (y * sz + z) * sx + x;
  // 起伏地面：y=0..(2+noise) solid
  let seed = 12345;
  const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let x = 0; x < sx; x += 1) {
    for (let z = 0; z < sz; z += 1) {
      const ground = 2 + Math.floor(rand() * 2);
      for (let y = 0; y <= ground; y += 1) classes[at(x, y, z)] = CLASS.SOLID;
    }
  }
  // 中段 diggable 墙（全宽全深，强迫挖穿或绕行）
  const wallX = Math.floor(sx / 2);
  for (let y = 2; y < 8; y += 1) {
    for (let z = 0; z < sz; z += 1) classes[at(wallX, y, z)] = CLASS.DIGGABLE;
  }
  return { sx, sy, sz, classes, at };
}

async function main() {
  const sx = 64, sy = 24, sz = 64;
  const scenario = buildScenario(sx, sy, sz);
  const world = { sx, sy, sz, classes: scenario.classes };

  // 找一个有效起点（可站立）
  const start = { x: 2, y: 4, z: 32 };
  while (scenario.classes[scenario.at(start.x, start.y - 1, start.z)] !== CLASS.SOLID) start.y -= 1;
  const goal = { x: sx - 3, y: 4, z: 32 };
  while (scenario.classes[scenario.at(goal.x, goal.y - 1, goal.z)] !== CLASS.SOLID) goal.y -= 1;

  // 1) worker 异步路径（生产路径）
  const t0 = performance.now();
  const result = await findPathAsync({ world, start, goal, options: { timeoutMs: 5000 } });
  const workerMs = performance.now() - t0;
  console.log(`async(worker): success=${result.success} visited=${result.visitedNodes} path=${result.path.length} engineMs=${result.elapsedMs.toFixed(1)} wallMs=${workerMs.toFixed(1)}`);

  // 2) 事件循环健康度：寻路期间主线程的定时器抖动（对比被同步计算的挤压）
  const jitter = [];
  const timer = setInterval(() => {
    const now = performance.now();
    jitter.push(now);
  }, 5);
  const t1 = performance.now();
  const syncResult = findPathSync(world, start, goal, { timeoutMs: 5000 });
  const syncMs = performance.now() - t1;
  clearInterval(timer);
  let maxDrift = 0;
  for (let i = 1; i < jitter.length; i += 1) maxDrift = Math.max(maxDrift, jitter[i] - jitter[i - 1] - 5);
  console.log(`sync(main-thread): success=${syncResult.success} visited=${syncResult.visitedNodes} engineMs=${syncResult.elapsedMs.toFixed(1)} wallMs=${syncMs.toFixed(1)} timerMaxDriftMs=${maxDrift.toFixed(1)}`);

  // 3) 语义抽检：路径终点与墙交互
  if (result.success) {
    const end = result.path[result.path.length - 1];
    const reached = end.x === goal.x && end.z === goal.z && Math.abs(end.y - goal.y) <= 1;
    console.log(`endpoint check: ${reached ? "PASS" : "FAIL"} (${end.x},${end.y},${end.z} vs goal ${goal.x},${goal.y},${goal.z})`);
  }
}

main().catch((error) => { console.error(error); process.exit(1); });

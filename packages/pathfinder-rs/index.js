// pathfinder-rs Node 适配层 —— Rust A* 的唯一入口。
//
// 线程纪律（Baritone 式解耦的 JS 侧一半）：addon 只导出同步计算，
// 本模块把调用包装进 worker_threads——事件循环只剩物理与包收发。
// Rust 引擎只认体素分类（Passable/Solid/Diggable/Hazard），MC 方块
// 知识留在分类器（classifyBlock）——接缝即 clean-room 边界。
//
// 用法：
//   const { findPathAsync, CLASS } = require("@minecraft-studio/pathfinder-rs");
//   const result = await findPathAsync({ volume, start, goal, options });

"use strict";
const { Worker } = require("node:worker_threads");
const path = require("node:path");

const CLASS = Object.freeze({
  PASSABLE: 0,
  SOLID: 1,
  DIGGABLE: 2,
  HAZARD: 3,
});

const WORKER_SOURCE = `
"use strict";
const { parentPort } = require("node:worker_threads");
const addon = require(process.env.PATHFINDER_RS_MODULE);
parentPort.on("message", (job) => {
  const { id, world, start, goal, options } = job;
  try {
    const result = addon.findPath(world, start.x, start.y, start.z, goal.x, goal.y, goal.z, options ?? null);
    parentPort.postMessage({ id, ok: true, result });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, error: String(error && error.message) });
  }
});
`;

let worker = null;
let jobId = 0;
const pending = new Map();

// 空闲回收（Phase 2：eval worker 不随 unref 退出——smoke 挂起实测）。
// 寻路是窥发动作：无在途任务且 60s 无新请求即 terminate，下次调用重新
// 拉起（spawn ~30ms，相对寻路频率可忽略）。
const WORKER_IDLE_TERMINATE_MS = 60_000;
let idleTimer = null;

function scheduleIdleTerminate() {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (pending.size > 0 || worker === null) return;
    const dying = worker;
    worker = null;
    void dying.terminate();
  }, WORKER_IDLE_TERMINATE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_SOURCE, {
    eval: true,
    env: {
      PATHFINDER_RS_MODULE: path.join(__dirname, "pathfinder_rs.node"),
    },
  });
  worker.unref();
  worker.on("message", (message) => {
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (pending.size === 0) scheduleIdleTerminate();
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(`pathfinder-rs worker: ${message.error}`));
  });
  worker.on("error", (error) => {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
    worker = null;
  });
  return worker;
}

/**
 * worker 线程上的寻路。world.classes 会被结构化克隆传给 worker——
 * 大体积（>8MB≈2M 格）时序列化成本 ~10ms 级，仍远优于事件循环被占。
 */
function findPathAsync(input) {
  const { world, start, goal, options } = input;
  if (!world || !start || !goal) {
    return Promise.reject(new TypeError("findPathAsync requires world, start, goal"));
  }
  const id = ++jobId;
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, world, start, goal, options: options ?? null });
  });
}

/** 同步直调（测试/基准用；生产路径必须走 findPathAsync）。 */
function findPathSync(world, start, goal, options) {
  const addon = require(path.join(__dirname, "pathfinder_rs.node"));
  return addon.findPath(
    world,
    start.x, start.y, start.z,
    goal.x, goal.y, goal.z,
    options ?? null,
  );
}

/** 显式回收 worker（bot stop / 测试 teardown 用；在途任务会 reject）。 */
function terminateWorker() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (worker === null) return Promise.resolve();
  const dying = worker;
  worker = null;
  for (const [, entry] of pending) {
    entry.reject(new Error("pathfinder-rs worker terminated"));
  }
  pending.clear();
  return dying.terminate();
}

module.exports = { CLASS, findPathAsync, findPathSync, terminateWorker };

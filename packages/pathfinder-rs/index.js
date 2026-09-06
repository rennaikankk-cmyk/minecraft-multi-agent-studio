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
  // P5-D2 mirror 通道：与寻路共用同一 worker（消息按 postMessage 到达序
  // 串行处理——TS 侧唯一 sender 保证镜像消息的传输顺序）。
  if (job.kind === "mirror") {
    try {
      let result;
      if (job.op === "create") {
        result = { handle: addon.mirrorCreate(job.sessionEpoch, job.dimensionEpoch, job.replayCapacity ?? null) };
      } else if (job.op === "submitEnvelope") {
        result = { ack: addon.mirrorSubmitEnvelope(job.handle, job.envelope) };
      } else if (job.op === "submitControl") {
        result = { ack: addon.mirrorSubmitControl(job.handle, job.control) };
      } else if (job.op === "health") {
        result = { health: addon.mirrorHealth(job.handle) };
      } else if (job.op === "spatialQuery") {
        result = addon.mirrorSpatialQuery(job.handle, job.query);
      } else if (job.op === "spatialMemory") {
        result = addon.mirrorSpatialMemory(job.handle);
      } else if (job.op === "dispose") {
        result = { disposed: addon.mirrorDispose(job.handle) };
      } else {
        throw new Error("unknown mirror op: " + job.op);
      }
      parentPort.postMessage({ id: job.id, ok: true, result });
    } catch (error) {
      parentPort.postMessage({ id: job.id, ok: false, error: String(error && error.message) });
    }
    return;
  }
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
// P5-D2：活镜像会话计数——idle 回收在有镜像状态在场时必须保活（§18：
// 否则 60s 无寻路请求会把整个镜像状态无声 terminate 掉。"在线即常驻"
// 的完整 worker 生命周期属于 P5-F；这是 P5-F 前的临时正确行为）。
let mirrorSessionsAlive = 0;

// 空闲回收（Phase 2：eval worker 不随 unref 退出——smoke 挂起实测）。
// 寻路是窥发动作：无在途任务且 60s 无新请求即 terminate，下次调用重新
// 拉起（spawn ~30ms，相对寻路频率可忽略）。镜像会话在场时改保活并重排。
const WORKER_IDLE_TERMINATE_MS = 60_000;
let idleTimer = null;

function scheduleIdleTerminate() {
  if (idleTimer !== null) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (pending.size > 0 || worker === null) return;
    if (mirrorSessionsAlive > 0) {
      scheduleIdleTerminate(); // 保活：镜像状态是 worker 内的常驻事实
      return;
    }
    const dying = worker;
    worker = null;
    void dying.terminate();
  }, WORKER_IDLE_TERMINATE_MS);
  if (typeof idleTimer.unref === "function") idleTimer.unref();
}

function noteActivity() {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
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
  const activeWorker = worker;
  worker.on("message", (message) => {
    if (worker !== activeWorker) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (pending.size === 0) scheduleIdleTerminate();
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(`pathfinder-rs worker: ${message.error}`));
  });
  worker.on("error", (error) => {
    if (worker !== activeWorker) return;
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
    worker = null;
    mirrorSessionsAlive = 0; // 镜像状态随 worker 消亡；调用方按 worker 失败恢复
  });
  // Windows 树杀等外部 terminate 时 exit 可能先于 error——同样清账。
  worker.on("exit", (code) => {
    if (worker !== activeWorker) return;
    worker = null;
    mirrorSessionsAlive = 0;
    const failure = new Error(`pathfinder-rs worker exited (code=${code})`);
    for (const [, entry] of pending) entry.reject(failure);
    pending.clear();
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
  noteActivity();
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ensureWorker().postMessage({ id, world, start, goal, options: options ?? null });
  });
}

// ---------------------------------------------------------------------------
// P5-D2 mirror 通道（与寻路共用 worker；唯一 sender 语义由 TS 调用方保证）。
// ---------------------------------------------------------------------------

function mirrorJob(op, payload, transferList) {
  noteActivity();
  const id = ++jobId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    try {
      ensureWorker().postMessage({ id, kind: "mirror", op, ...payload }, transferList ?? []);
    } catch (error) {
      pending.delete(id);
      if (pending.size === 0) scheduleIdleTerminate();
      reject(error);
    }
  });
}

function mirrorCreate({ sessionEpoch, dimensionEpoch, replayCapacity = null }) {
  return mirrorJob("create", { sessionEpoch, dimensionEpoch, replayCapacity }).then((result) => {
    mirrorSessionsAlive += 1;
    return result.handle;
  });
}

function mirrorSubmitEnvelope(handle, envelope, transferList) {
  return mirrorJob("submitEnvelope", { handle, envelope }, transferList).then((result) => result.ack);
}

function mirrorSubmitControl(handle, control) {
  return mirrorJob("submitControl", { handle, control }).then((result) => result.ack);
}

function mirrorHealth(handle) {
  return mirrorJob("health", { handle }).then((result) => result.health);
}

function mirrorDispose(handle) {
  return mirrorJob("dispose", { handle }).then((result) => {
    if (result.disposed && mirrorSessionsAlive > 0) mirrorSessionsAlive -= 1;
    return result.disposed;
  });
}

function mirrorSpatialQuery(handle, query) {
  if (pending.size >= 64) return Promise.reject(new Error("pathfinder-rs query queue capacity exceeded"));
  return mirrorJob("spatialQuery", { handle, query });
}

function mirrorSpatialMemory(handle) {
  return mirrorJob("spatialMemory", { handle });
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
  mirrorSessionsAlive = 0;
  for (const [, entry] of pending) {
    entry.reject(new Error("pathfinder-rs worker terminated"));
  }
  pending.clear();
  return dying.terminate();
}

/** 测试用：当前活镜像会话计数（idle 保活审计）。 */
function mirrorAliveSessions() {
  return mirrorSessionsAlive;
}

module.exports = {
  CLASS,
  findPathAsync,
  findPathSync,
  terminateWorker,
  mirrorCreate,
  mirrorSubmitEnvelope,
  mirrorSubmitControl,
  mirrorHealth,
  mirrorDispose,
  mirrorAliveSessions,
  mirrorSpatialQuery,
  mirrorSpatialMemory,
};

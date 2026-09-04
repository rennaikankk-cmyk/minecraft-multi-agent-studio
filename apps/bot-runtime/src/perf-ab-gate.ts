// perf-ab-gate.ts —— Phase 4 受控 A/B 的诊断门（文件门控）。
//
// 纪律：这是 LOCAL_TEST/E2E 归因专用——runtime-data/perf-ab.json 不存在
// 时一切行为与生产完全一致（零开销：1s 缓存读一次 stat）。禁止把任何
// 门模式设为生产默认；外服/生产环境不得创建该文件。
//
// 模式（互斥，单值）：
//   off            —— 缺省，无诊断行为
//   no_telemetry   —— emitStatus 跳过序列化+发送（L0 安全评估保留）
//   skip_worldstate —— requestStatus 跳过 worldStateSnapshot 构建，L0 复用
//                      上一次快照（仅诊断窗口内合法；本地测试服专用）
//   shadow_rust    —— 每 1s 发起一次 Rust 计划（分类+worker 寻路）但丢弃
//                      结果，测主线程分类成本+worker 往返；不执行移动

import { readFileSync } from "node:fs";
import path from "node:path";

export type PerfAbMode = "off" | "no_telemetry" | "skip_worldstate" | "shadow_rust";

const GATE_PATH = path.join(process.cwd(), "runtime-data", "perf-ab.json");
const CACHE_TTL_MS = 1_000;

let cachedAt = 0;
let cachedMode: PerfAbMode = "off";

export function currentPerfAbMode(nowMs: () => number = Date.now): PerfAbMode {
  if (nowMs() - cachedAt < CACHE_TTL_MS) return cachedMode;
  cachedAt = nowMs();
  cachedMode = "off";
  try {
    const raw = JSON.parse(readFileSync(GATE_PATH, "utf8")) as { mode?: unknown };
    if (
      raw.mode === "no_telemetry" ||
      raw.mode === "skip_worldstate" ||
      raw.mode === "shadow_rust" ||
      raw.mode === "off"
    ) {
      cachedMode = raw.mode;
    }
  } catch {
    // 文件不存在/损坏 = off（诊断门从不 fail-hard）
  }
  return cachedMode;
}

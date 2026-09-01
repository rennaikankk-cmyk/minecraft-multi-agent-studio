// ---------------------------------------------------------------------------
// LocalTestServerManager —— 手工/LOCAL_TEST 模式专用的本地测试服务器（U9 侧）
//
// 与 E2E fixture 分离（5.1 节）：
//   - 独立容器名 studio-local-test-mc、独立端口 25598、独立 volume
//   - Docker labels 记录 ownership（studio.resourceId/serverKind/ownerSessionId/lifecycle）
//   - stop/reset 只作用于带本 manager 标签的容器——绝不按端口/名字误杀外部服务器
//   - readiness = docker Done 日志 + TCP 端口监听（不是 running 即 ONLINE）
// 状态机：stopped → starting → ready / failed；transition 带 requestedAt/error。
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { createConnection } from "node:net";

export const LOCAL_TEST_CONTAINER = "studio-local-test-mc";
export const LOCAL_TEST_PORT = 25598;
export const LOCAL_TEST_VOLUME = "studio-local-test-data";
const IMAGE = process.env.STUDIO_LOCAL_TEST_IMAGE?.trim() || "docker.m.daocloud.io/itzg/minecraft-server:latest";
const LABELS = {
  "studio.resourceId": "local-test-mc-01",
  "studio.serverKind": "local_test",
  "studio.lifecycle": "session",
};

function docker(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args.join(" ")}: ${stderr || error.message}`.slice(0, 300)));
      else resolve(stdout.trim());
    });
  });
}

function tcpProbe(port, host = "127.0.0.1", timeoutMs = 3_000) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

export function localTestLabelArgs(sessionId) {
  return [
    "--label", `studio.resourceId=${LABELS["studio.resourceId"]}`,
    "--label", `studio.serverKind=${LABELS["studio.serverKind"]}`,
    "--label", `studio.ownerSessionId=${sessionId}`,
    "--label", `studio.lifecycle=${LABELS["studio.lifecycle"]}`,
  ];
}

async function containerState() {
  const state = await docker(["inspect", "-f", "{{.State.Running}} {{index .Config.Labels \"studio.serverKind\"}} {{index .Config.Labels \"studio.ownerSessionId\"}}", LOCAL_TEST_CONTAINER], 10_000).catch(() => null);
  if (!state) return null;
  const [running, serverKind, ownerSessionId] = state.split(" ");
  return { running: running === "true", serverKind: serverKind ?? null, ownerSessionId: ownerSessionId ?? null };
}

export async function getLocalTestServerState() {
  const info = await containerState();
  if (!info) return { status: "stopped", managedByStudio: false, ownership: "none" };
  if (!info.running) return { status: "stopped", managedByStudio: info.serverKind === "local_test", ownership: "session", ownerSessionId: info.ownerSessionId };
  const portOpen = await tcpProbe(LOCAL_TEST_PORT);
  return {
    status: portOpen ? "ready" : "starting",
    managedByStudio: info.serverKind === "local_test",
    ownership: "session",
    ownerSessionId: info.ownerSessionId,
    port: LOCAL_TEST_PORT,
  };
}

/** 启动并等待 readiness（Done 日志 + TCP）。返回 observed state；失败返回 failed + error。 */
export async function startLocalTestServer({ sessionId, timeoutMs = Number(process.env.STUDIO_LOCAL_TEST_TIMEOUT_MS ?? 900_000), reason = "local_test_mode" } = {}) {
  const existing = await containerState();
  if (existing?.running) {
    const ready = await tcpProbe(LOCAL_TEST_PORT);
    return { status: ready ? "ready" : "starting", alreadyRunning: true };
  }
  await docker([
    "run", "-d", "--name", LOCAL_TEST_CONTAINER,
    ...localTestLabelArgs(sessionId),
    "-p", `${LOCAL_TEST_PORT}:25565`,
    "-v", `${LOCAL_TEST_VOLUME}:/data`,
    "-e", "EULA=TRUE",
    "-e", "ONLINE_MODE=FALSE",
    "-e", "VERSION=1.21.11",
    "-e", "TYPE=VANILLA",
    "-e", "SEED=studio-local-test",
    "-e", "MODE=survival",
    "-e", "DIFFICULTY=peaceful",
    "-e", "MEMORY=2G",
    "-e", "SPAWN_PROTECTION=0",
    "-e", "VIEW_DISTANCE=6",
    // Round 6.1 场景 H 实测：持久卷里遗留的 autopause 让空服 60s 后暂停，
    // bot 连接撞上暂停中的服务器 → protocol fatal。本地测试服禁用 autopause。
    "-e", "ENABLE_AUTOPAUSE=FALSE",
    IMAGE,
  ]);
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const info = await containerState();
    if (!info?.running) {
      const logs = await docker(["logs", "--tail", "20", LOCAL_TEST_CONTAINER], 15_000).catch(() => "");
      return { status: "failed", error: `container exited during startup; logs tail: ${logs.slice(-300)}` };
    }
    const logs = await docker(["logs", "--tail", "60", LOCAL_TEST_CONTAINER], 15_000).catch(() => "");
    if (/Done \([\d.]+s\)!/i.test(logs)) {
      const portOpen = await tcpProbe(LOCAL_TEST_PORT);
      if (portOpen) return { status: "ready", startedReason: reason, ownerSessionId: sessionId };
    }
    if (/ERROR|Failed to start/i.test(logs) && Date.now() - startedAt > 30_000) {
      return { status: "failed", error: `startup error in logs: ${logs.slice(-300)}` };
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  // 超时后重探测当前真实状态：首次下载 jar 可能超过预期，慢但 ready 不误报 failed
  const lateReady = await tcpProbe(LOCAL_TEST_PORT).then(async (portOk) => {
    if (!portOk) return false;
    const logs = await docker(["logs", "--tail", "80", LOCAL_TEST_CONTAINER], 15_000).catch(() => "");
    return /Done ([d.]+s)!/i.test(logs);
  });
  if (lateReady) {
    return { status: "ready", startedReason: reason, ownerSessionId: sessionId, note: "ready after delayed startup (first-boot download likely exceeded default wait)" };
  }
  return { status: "failed", error: `readiness timeout after ${timeoutMs}ms` };
}

/** 停止：只作用于带 studio.serverKind=local_test 标签的本 manager 容器。 */
export async function stopLocalTestServer({ sessionId } = {}) {
  const info = await containerState();
  if (!info) return { status: "stopped", note: "not present" };
  if (info.serverKind !== "local_test") {
    return { status: "refused", error: "container exists but is not studio-managed local_test — refusing (ownership guard)" };
  }
  if (sessionId && info.ownerSessionId && info.ownerSessionId !== sessionId) {
    return { status: "refused", error: `owner session mismatch (${info.ownerSessionId} != ${sessionId}) — refusing` };
  }
  await docker(["rm", "-f", LOCAL_TEST_CONTAINER], 60_000).catch(() => undefined);
  return { status: "stopped" };
}

/** Reset world：删除 volume 数据（容器须先停）。同一 ownership 守卫。 */
export async function resetLocalTestWorld({ sessionId } = {}) {
  const stopped = await stopLocalTestServer(sessionId ? { sessionId } : {});
  if (stopped.status === "refused") return stopped;
  await docker(["volume", "rm", "-f", LOCAL_TEST_VOLUME], 30_000).catch(() => undefined);
  return { status: "reset", note: "world volume removed; next start creates a fresh world" };
}

/**
 * 完整 observed state（Servers 页 Local Test 卡片数据源）。
 * 全部来自 docker inspect / rcon 事实，不读 session 配置猜状态。
 */
export async function observeLocalTestServer() {
  const format = "{{.State.Running}}|{{.State.StartedAt}}|{{index .Config.Labels \"studio.serverKind\"}}|{{index .Config.Labels \"studio.ownerSessionId\"}}|{{index .Config.Labels \"studio.resourceId\"}}|{{index .Config.Labels \"studio.lifecycle\"}}|{{.Id}}";
  const raw = await docker(["inspect", "-f", format, LOCAL_TEST_CONTAINER], 10_000).catch(() => null);
  if (!raw) {
    return {
      status: "not_running",
      desiredState: "unknown",
      managedByStudio: false,
      ownerSessionId: null,
      containerId: null,
      hostPort: null,
      players: null,
      uptimeMs: null,
      world: { volumeName: LOCAL_TEST_VOLUME, identity: `${LOCAL_TEST_VOLUME} (docker volume)` },
      minecraftVersion: null,
      protocolVersion: null,
      mode: null,
      seed: null,
    };
  }
  const [running, startedAt, serverKind, ownerSessionId, resourceId, lifecycle, containerId] = raw.split("|");
  const envFormat = "{{range .Config.Env}}{{println .}}{{end}}";
  const envRaw = await docker(["inspect", "-f", envFormat, LOCAL_TEST_CONTAINER], 10_000).catch(() => "");
  const env = Object.fromEntries(
    envRaw.split("\n").filter((line) => line.includes("=")).map((line) => {
      const index = line.indexOf("=");
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
  const port = await docker(["port", LOCAL_TEST_CONTAINER, "25565/tcp"], 10_000).catch(() => "");
  const hostPort = port ? Number.parseInt(port.split(":").pop() ?? "", 10) : null;
  const portOpen = hostPort !== null ? await tcpProbe(hostPort) : false;
  const players = running === "true" ? await readPlayerList() : null;
  const uptimeMs = running === "true" && startedAt ? Date.now() - Date.parse(startedAt) : null;
  return {
    status: running !== "true" ? "not_running" : portOpen ? "online" : "starting",
    desiredState: "unknown", // 由 manager 根据 startup plan/最近操作补充
    managedByStudio: serverKind === "local_test",
    ownerSessionId: ownerSessionId ?? null,
    resourceId: resourceId ?? "local-test-mc-01",
    lifecycle: lifecycle ?? null,
    containerId: containerId ? containerId.slice(0, 12) : null,
    hostPort: Number.isFinite(hostPort) ? hostPort : LOCAL_TEST_PORT,
    hostPortOpen: portOpen,
    players,
    uptimeMs,
    world: { volumeName: LOCAL_TEST_VOLUME, identity: `${LOCAL_TEST_VOLUME} (docker volume)` },
    minecraftVersion: env.VERSION ?? null,
    protocolVersion: null, // 握手后由 bot 连接事实补充（不伪造）
    mode: env.MODE ?? null,
    seed: env.SEED ?? null,
    onlineMode: env.ONLINE_MODE ?? null,
    startedAt: startedAt ?? null,
  };
}

/** rcon `list`（bounded；失败返回 null —— 玩家数不是关键路径）。 */
async function readPlayerList() {
  const raw = await docker(["exec", LOCAL_TEST_CONTAINER, "rcon-cli", "list"], 10_000).catch(() => null);
  if (!raw) return null;
  const match = raw.match(/There are (\d+) of a max(?:imum)? of (\d+) players online(?::\s*(.*))?/i);
  if (!match) return null;
  return {
    online: Number.parseInt(match[1], 10),
    max: Number.parseInt(match[2], 10),
    names: (match[3] ?? "").split(/,\s*/u).filter((name) => name.length > 0).slice(0, 20),
  };
}

/** bounded 日志读取（docker logs --tail；调用方再做脱敏）。 */
export async function readLocalTestServerLog(tailLines = 200) {
  const bounded = Math.min(500, Math.max(1, tailLines));
  const logs = await docker(["logs", "--tail", String(bounded), LOCAL_TEST_CONTAINER], 15_000).catch(() => null);
  if (logs === null) return { available: false, reason: "container not present or docker unavailable" };
  return { available: true, tail: bounded, logs: logs.slice(-64_000) };
}

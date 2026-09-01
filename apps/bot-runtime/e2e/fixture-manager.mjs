// ---------------------------------------------------------------------------
// E2EFixtureManager —— 每次 run 完全隔离的 Minecraft fixture（5.1/5.5 节）
//
// 与 LocalTestServerManager（手工/LOCAL_TEST，稳定资源）严格分离：
//   - 唯一容器名 studio-e2e-<runId>
//   - 动态端口（宿主随机端口，docker 自动分配）
//   - 隔离 world（唯一 volume，run 结束删除）
//   - Docker labels：studio.serverKind=e2e_fixture / runId / worldId
//   - finally cleanup；崩溃后 stale fixture 按 label 回收
//   - 串行锁：同一宿主同时只跑一个 fixture（防端口/资源竞争）
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { randomUUID } from "node:crypto";

const IMAGE = process.env.STUDIO_E2E_IMAGE?.trim() || "docker.m.daocloud.io/itzg/minecraft-server:latest";
const MC_VERSION = process.env.STUDIO_E2E_MC_VERSION?.trim() || "1.21.11";
export const FIXTURE_LABEL = "studio.serverKind=e2e_fixture";

let lock = Promise.resolve();

function docker(args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      if (error) reject(new Error(`docker ${args[0]}: ${(stderr || error.message).slice(0, 300)}`));
      else resolve(stdout.trim());
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 串行锁：任务串行执行（fixture 资源全局唯一）。 */
export function withFixtureLock(task) {
  const run = lock.then(task, task);
  lock = run.catch(() => undefined);
  return run;
}

/** @typedef {{runId: string, containerName: string, port: number, volumeName: string, waitReady(timeoutMs?: number): Promise<void>, rcon(command: string): Promise<string>, cleanup(): Promise<void>}} E2EFixture */

/** 回收历史遗留的 e2e fixture 容器（label 识别，绝不碰 external/local_test）。 */
export async function reclaimStaleFixtures() {
  const removed = [];
  try {
    const list = await docker(["ps", "-aq", "--filter", `label=${FIXTURE_LABEL}`], 20_000);
    for (const id of list.split("\n").filter(Boolean)) {
      const name = await docker(["inspect", "-f", "{{.Name}}", id], 10_000).catch(() => id);
      await docker(["rm", "-f", id], 30_000).catch(() => undefined);
      removed.push(name.replace(/^\//, ""));
    }
  } catch {
    // 无 docker / 无遗留：忽略
  }
  return removed;
}

export async function createE2EFixture() {
  const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const containerName = `studio-e2e-${runId}`;
  const volumeName = `studio-e2e-world-${runId}`;

  const cleanup = async () => {
    await docker(["rm", "-f", containerName], 60_000).catch(() => undefined);
    await docker(["volume", "rm", "-f", volumeName], 30_000).catch(() => undefined);
  };

  await docker(["volume", "create", volumeName], 15_000);
  await docker(
    [
      "run", "-d", "--name", containerName,
      // 动态端口：不指定宿主映射，稍后从 docker port 读取
      "-P",
      "-v", `${volumeName}:/data`,
      "--label", "studio.serverKind=e2e_fixture",
      "--label", `studio.runId=${runId}`,
      "--label", `studio.worldId=${runId}`,
      "--label", `studio.ownerSessionId=${process.pid}`,
      "-e", "EULA=TRUE",
      "-e", "ONLINE_MODE=FALSE",
      "-e", `VERSION=${MC_VERSION}`,
      // Round 6.1：默认 VANILLA 需要 itzg 在 boot 时联网解析 Mojang manifest——
      // 本机外网今天反复劣化导致 fixture 420s 不就绪。STUDIO_E2E_TYPE=CUSTOM +
      // STUDIO_E2E_CUSTOM_SERVER=<镜像内 jar 路径>（配 studio-e2e-mc-cached 镜像）
      // 可完全离线启动；不设置时行为与以前完全一致。
      "-e", `TYPE=${process.env.STUDIO_E2E_TYPE?.trim() || "VANILLA"}`,
      ...(process.env.STUDIO_E2E_CUSTOM_SERVER?.trim()
        ? ["-e", `CUSTOM_SERVER=${process.env.STUDIO_E2E_CUSTOM_SERVER.trim()}`]
        : []),
      "-e", "SEED=studio-e2e-fixed",
      "-e", "MODE=survival",
      "-e", "DIFFICULTY=peaceful",
      "-e", "MEMORY=2G",
      "-e", "SPAWN_PROTECTION=0",
      "-e", "VIEW_DISTANCE=6",
      IMAGE,
    ],
    60_000,
  );

  // 读取动态映射的宿主端口
  let port = 0;
  for (let attempt = 0; attempt < 10 && port === 0; attempt += 1) {
    const mapping = await docker(["port", containerName, "25565"], 10_000).catch(() => "");
    const match = mapping.match(/:(\d+)$/m);
    if (match) port = Number.parseInt(match[1], 10);
    else await sleep(500);
  }
  if (port === 0) {
    await cleanup();
    throw new Error("e2e fixture: docker port mapping never appeared");
  }

  const tcpProbe = () =>
    new Promise((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const done = (ok) => { socket.destroy(); resolve(ok); };
      socket.setTimeout(2_000, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });

  const fixture = {
    runId,
    containerName,
    port,
    volumeName,
    async waitReady(timeoutMs = Number(process.env.STUDIO_E2E_READY_TIMEOUT_MS ?? 420_000)) {
      const startedAt = Date.now();
      while (Date.now() - startedAt < timeoutMs) {
        const logs = await docker(["logs", "--tail", "60", containerName], 15_000).catch(() => "");
        if (/Done \([\d.]+s\)!/i.test(logs)) {
          if (await tcpProbe()) return;
        }
        await sleep(3_000);
      }
      throw new Error(`e2e fixture ${runId} not ready within ${timeoutMs}ms`);
    },
    async rcon(command) {
      return docker(["exec", containerName, "rcon-cli", command], 20_000);
    },
    cleanup,
  };
  return fixture;
}

/** 完整生命周期：create → ready → scenario → cleanup（finally 语义）。 */
export async function withE2EFixture(scenario) {
  return withFixtureLock(async () => {
    await reclaimStaleFixtures();
    const fixture = await createE2EFixture();
    try {
      await fixture.waitReady();
      return await scenario(fixture);
    } finally {
      await fixture.cleanup();
    }
  });
}

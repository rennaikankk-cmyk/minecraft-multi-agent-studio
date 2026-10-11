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

/** fixture JVM 内存（G）：有界 1-8，垃圾值 fail-closed 回 2G。 */
function fixtureMemoryGb() {
  const raw = process.env.STUDIO_E2E_MEMORY?.trim();
  if (raw === undefined || raw === "") return 2;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < 1 || value > 8) return 2;
  return value;
}

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

/**
 * Round 6.6 fixture ownership 隔离：回收只针对**确认无主且超龄**的容器——
 * ownerSessionId 与当前进程相同（活跃）、或容器启动不足 RECLAIM_AGE_MS 的
 * 一律不动（09:50 实测宽泛 label 回收把并行场景的活 fixture 互杀）。
 */
const RECLAIM_AGE_MS = Number(process.env.STUDIO_E2E_RECLAIM_AGE_MS ?? "600000");

/** 回收历史遗留的 e2e fixture 容器（owner+超龄双条件，绝不碰活跃 fixture）。 */
export async function reclaimStaleFixtures() {
  const removed = [];
  const skipped = [];
  try {
    const list = await docker(["ps", "-aq", "--filter", `label=${FIXTURE_LABEL}`], 20_000);
    const now = Date.now();
    for (const id of list.split("\n").filter(Boolean)) {
      const info = await docker(
        ["inspect", "-f", "{{.Name}}|{{.State.StartedAt}}|{{index .Config.Labels \"studio.ownerSessionId\"}}", id],
        10_000,
      ).catch(() => null);
      if (info === null) continue; // inspect 失败：不动未知容器
      const [rawName, startedAt, ownerSession] = info.split("|");
      const name = rawName.replace(/^\//, "");
      const startedMs = Date.parse(startedAt ?? "");
      const ageOk = Number.isFinite(startedMs) && now - startedMs >= RECLAIM_AGE_MS;
      const ownerAlive = ownerSession === String(process.pid);
      if (ownerAlive || !ageOk) {
        skipped.push(name);
        continue;
      }
      await docker(["rm", "-f", id], 30_000).catch(() => undefined);
      removed.push(name);
    }
    // 回收孤儿 volume：有 e2e label 但无对应容器的（此前 volume 无 label，
    // 失败 run 的 volume 连事后识别手段都没有）。
    const volumes = await docker(["volume", "ls", "-q", "--filter", `label=${FIXTURE_LABEL}`], 20_000);
    for (const volumeId of volumes.split("\n").filter(Boolean)) {
      // 只回收超龄的（沿用容器的 RECLAIM_AGE_MS 纪律）
      const volumeInfo = await docker(
        ["volume", "inspect", "-f", "{{index .Labels \"studio.runId\"}}|{{.CreatedAt}}", volumeId],
        10_000,
      ).catch(() => null);
      if (volumeInfo === null) continue;
      const [, createdAt] = volumeInfo.split("|");
      const createdMs = Date.parse(createdAt ?? "");
      if (!Number.isFinite(createdMs) || now - createdMs < RECLAIM_AGE_MS) {
        skipped.push(volumeId);
        continue;
      }
      // 确认没有对应容器仍在使用该 volume（按 runId label 匹配）
      const runId = volumeInfo.split("|")[0];
      const inUse = await docker(
        ["ps", "-aq", "--filter", `label=studio.runId=${runId}`],
        10_000,
      ).catch(() => "");
      if (inUse.trim() !== "") {
        skipped.push(volumeId);
        continue;
      }
      await docker(["volume", "rm", "-f", volumeId], 30_000).catch(() => undefined);
      removed.push(volumeId);
    }
  } catch {
    // 无 docker / 无遗留：忽略
  }
  return { removed, skipped };
}

export async function createE2EFixture() {
  const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const containerName = `studio-e2e-${runId}`;
  const volumeName = `studio-e2e-world-${runId}`;

  const cleanup = async () => {
    // 2026-09-03 实测：docker rm 偶发失败被静默吞掉 → 脚本 exit 0 但容器泄漏。
    // 清理必须重试，最终失败要大声报警（stderr），让"零残留"验收能看见漏网容器。
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const rm = await docker(["rm", "-f", containerName], 90_000).then(
        () => true,
        () => false,
      );
      if (rm) break;
      if (attempt === 3) {
        console.error(`[fixture-manager] CLEANUP FAILED: container ${containerName} still exists (run ${runId}) — remove it manually`);
      } else {
        await sleep(3_000);
      }
    }
    const volumeGone = await docker(["volume", "rm", "-f", volumeName], 30_000).then(
      () => true,
      () => false,
    );
    if (!volumeGone) {
      console.error(`[fixture-manager] CLEANUP FAILED: volume ${volumeName} still exists (run ${runId}) — remove it manually`);
    }
  };

  await docker(["volume", "create", "--label", "studio.serverKind=e2e_fixture", "--label", `studio.runId=${runId}`, volumeName], 15_000);
  // docker run 失败（镜像拉取失败、daemon 抖动等）时 volume 会永久泄漏——
  // cleanup 此前只在 withE2EFixture 的 finally 中被调用，而 createE2EFixture
  // 在 run 抛出后直接向上冒异常，withE2EFixture 还没拿到 fixture 就先炸了。
  try {
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
      // 10-bot L7 实证（2026-09-03）：2G 下 10 玩家 tick 滞后、round2 墙钟翻倍、
      // 20s 生产移动预算内过半超时。STUDIO_E2E_MEMORY 有界旋钮（1-8G，垃圾值
      // fail-closed 回 2G），单 bot 场景不受影响。
      "-e", `MEMORY=${fixtureMemoryGb()}G`,
      "-e", "SPAWN_PROTECTION=0",
      "-e", "VIEW_DISTANCE=6",
      IMAGE,
    ],
    60_000,
  );
  } catch (runError) {
    await cleanup().catch(() => undefined); // cleanup 自身的失败不打断原始错误
    throw runError;
  }

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

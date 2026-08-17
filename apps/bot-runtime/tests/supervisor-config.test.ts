import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BotSupervisorConfigError,
  loadBotSupervisorConfig,
} from "../src/supervisor-config.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe("Bot Process Supervisor 配置", () => {
  it("解析受限配置根目录、环境密钥和进程参数", async () => {
    const fixture = await createFixture();
    const config = await loadBotSupervisorConfig({
      BOT_SUPERVISOR_CONFIG_PATH: fixture.configPath,
      BOT_SUPERVISOR_PROFILE_ROOT: fixture.profileRoot,
      BOT_RUNTIME_LINK_SECRET_ONE: "a".repeat(32),
      BOT_RUNTIME_LINK_SECRET_TWO: "b".repeat(32),
      BOT_RUNTIME_PROCESS_MODE: "process",
      BOT_RUNTIME_BOTS_PER_PROCESS: "2",
      BOT_RUNTIME_AUTO_SIZE: "false",
    });

    expect(config.schemaVersion).toBe("1.0");
    expect(config.process).toEqual({
      mode: "process",
      botsPerProcess: 2,
      autoSize: false,
    });
    expect(config.bots).toHaveLength(2);
    expect(config.bots[0]?.assignment.profilePath).toBe(
      path.join(fixture.profileRoot, "bot-01.json"),
    );
    expect(config.bots[0]?.assignment.profileSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(config.bots[0]?.assignment.runtimeLink.secret).toBe("a".repeat(32));
    expect(JSON.stringify(await readJson(fixture.configPath))).not.toContain(
      "a".repeat(32),
    );
  });

  it("拒绝 ServerProfile 通过符号链接逃逸配置根目录", async () => {
    const fixture = await createFixture();
    const outside = path.join(fixture.root, "outside.json");
    await writeFile(outside, JSON.stringify(serverProfile("studio-bot-01", "OutsideBot")));
    await rm(path.join(fixture.profileRoot, "bot-01.json"));
    await symlink(outside, path.join(fixture.profileRoot, "bot-01.json"));

    await expect(
      loadBotSupervisorConfig(baseEnvironment(fixture)),
    ).rejects.toMatchObject<Partial<BotSupervisorConfigError>>({
      code: "SUPERVISOR_PROFILE_PATH_INVALID",
    });
  });

  it("拒绝缺失环境密钥与 Bot 身份不一致", async () => {
    const fixture = await createFixture();
    await expect(
      loadBotSupervisorConfig({
        BOT_SUPERVISOR_CONFIG_PATH: fixture.configPath,
        BOT_SUPERVISOR_PROFILE_ROOT: fixture.profileRoot,
        BOT_RUNTIME_LINK_SECRET_TWO: "b".repeat(32),
      }),
    ).rejects.toMatchObject<Partial<BotSupervisorConfigError>>({
      code: "SUPERVISOR_RUNTIME_LINK_INVALID",
    });

    await writeFile(
      path.join(fixture.profileRoot, "bot-01.json"),
      JSON.stringify(serverProfile("another-bot", "MismatchBot")),
    );
    await expect(
      loadBotSupervisorConfig(baseEnvironment(fixture)),
    ).rejects.toMatchObject<Partial<BotSupervisorConfigError>>({
      code: "SUPERVISOR_PROFILE_IDENTITY_MISMATCH",
    });
  });

  it("拒绝未知字段和重复的 Runtime Link keyId", async () => {
    const fixture = await createFixture();
    const manifest = await readJson(fixture.configPath) as {
      bots: Array<{ runtimeLink: { keyId: string } }>;
      executable?: string;
    };
    manifest.executable = "node arbitrary.js";
    await writeFile(fixture.configPath, JSON.stringify(manifest));
    await expect(
      loadBotSupervisorConfig(baseEnvironment(fixture)),
    ).rejects.toMatchObject<Partial<BotSupervisorConfigError>>({
      code: "SUPERVISOR_CONFIG_INVALID",
    });

    delete manifest.executable;
    const second = manifest.bots[1];
    if (!second) throw new Error("测试清单缺少第二个 Bot。");
    second.runtimeLink.keyId = "runtime-key-01";
    await writeFile(fixture.configPath, JSON.stringify(manifest));
    await expect(
      loadBotSupervisorConfig(baseEnvironment(fixture)),
    ).rejects.toMatchObject<Partial<BotSupervisorConfigError>>({
      code: "SUPERVISOR_CONFIG_INVALID",
    });
  });
});

async function createFixture(): Promise<Readonly<{
  root: string;
  profileRoot: string;
  configPath: string;
}>> {
  const root = await mkdtemp(path.join(os.tmpdir(), "bot-supervisor-config-"));
  temporaryDirectories.push(root);
  const profileRoot = path.join(root, "profiles");
  await mkdir(profileRoot);
  await writeFile(
    path.join(profileRoot, "bot-01.json"),
    JSON.stringify(serverProfile("studio-bot-01", "StudioBotOne")),
  );
  await writeFile(
    path.join(profileRoot, "bot-02.json"),
    JSON.stringify(serverProfile("studio-bot-02", "StudioBotTwo")),
  );
  const configPath = path.join(root, "supervisor.json");
  await writeFile(
    configPath,
    JSON.stringify({
      schemaVersion: "1.0",
      bots: [
        {
          botId: "studio-bot-01",
          profilePath: "bot-01.json",
          deploymentTier: "production",
          runtimeLink: {
            url: "ws://127.0.0.1:3220/v1/runtime-link",
            keyId: "runtime-key-01",
            secretEnvironmentVariable: "BOT_RUNTIME_LINK_SECRET_ONE",
          },
        },
        {
          botId: "studio-bot-02",
          profilePath: "bot-02.json",
          deploymentTier: "test",
          runtimeLink: {
            url: "ws://127.0.0.1:3220/v1/runtime-link",
            keyId: "runtime-key-02",
            secretEnvironmentVariable: "BOT_RUNTIME_LINK_SECRET_TWO",
          },
        },
      ],
      restart: {
        maxAttempts: 3,
        windowMs: 60_000,
        baseDelayMs: 100,
        maxDelayMs: 1_000,
        stableAfterMs: 10_000,
      },
      ipc: {
        handshakeTimeoutMs: 1_000,
        sendTimeoutMs: 1_000,
        gracefulShutdownMs: 5_000,
        maxQueuedMessages: 8,
        maxQueuedBytes: 16_384,
      },
    }),
  );
  return { root, profileRoot, configPath };
}

function baseEnvironment(
  fixture: Readonly<{ profileRoot: string; configPath: string }>,
): NodeJS.ProcessEnv {
  return {
    BOT_SUPERVISOR_CONFIG_PATH: fixture.configPath,
    BOT_SUPERVISOR_PROFILE_ROOT: fixture.profileRoot,
    BOT_RUNTIME_LINK_SECRET_ONE: "a".repeat(32),
    BOT_RUNTIME_LINK_SECRET_TWO: "b".repeat(32),
  };
}

function serverProfile(botId: string, username: string) {
  return {
    schemaVersion: "1.0",
    id: `profile-${botId}`,
    botId,
    purpose: "isolated-test",
    networkScope: "loopback",
    host: "127.0.0.1",
    port: 25565,
    minecraftVersion: "1.21.8",
    username,
    auth: "offline",
    statusIntervalMs: 1_000,
    heartbeatIntervalMs: 5_000,
    stopGracePeriodMs: 1_000,
    reconnect: {
      enabled: false,
      maxAttempts: 0,
      baseDelayMs: 500,
      maxDelayMs: 1_000,
    },
  };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await import("node:fs/promises").then(({ readFile }) =>
    readFile(filePath, "utf8"),
  )) as unknown;
}

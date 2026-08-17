import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";
import type { SkillExecutionAuthorization } from "@minecraft-studio/skills";
import { beforeEach, describe, expect, it } from "vitest";

import { createMineflayerClient } from "../src/mineflayer-client.js";
import { SingleBotRuntime } from "../src/runtime.js";
import { loadServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

const enabled = process.env.RUN_REAL_MC_TEST === "1";
const integrationDescribe = enabled ? describe : describe.skip;

const runtimeEvents: string[] = [];
const logger: RuntimeLogger = {
  info: (event) => runtimeEvents.push(`info:${event}`),
  warn: (event) => runtimeEvents.push(`warn:${event}`),
  error: (event) => runtimeEvents.push(`error:${event}`),
};

async function waitForFile(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await access(filePath);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for acceptance marker: ${path.basename(filePath)}`);
}

async function waitForMessage<T extends BotTelemetryMessageV1>(
  messages: BotTelemetryMessageV1[],
  predicate: (message: BotTelemetryMessageV1) => message is T,
  timeoutMs: number,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const message = messages.find(predicate);
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for Bot telemetry. ` +
      `Messages: ${messages.map(({ type }) => type).join(",") || "none"}. ` +
      `Runtime events: ${runtimeEvents.slice(-20).join(",") || "none"}.`,
  );
}

integrationDescribe("real isolated Minecraft 1.21.8 server", () => {
  beforeEach(() => {
    runtimeEvents.length = 0;
  });

  it(
    "connects, reports a real status snapshot, and stops gracefully",
    async () => {
      const profile = await loadServerProfile();
      const messages: BotTelemetryMessageV1[] = [];
      const runtime = new SingleBotRuntime(profile, {
        createClient: createMineflayerClient,
        messageSink: (message) => messages.push(message),
        logger,
      });

      runtime.start();
      try {
        const status = await waitForMessage(
          messages,
          (message): message is Extract<
            BotTelemetryMessageV1,
            { type: "bot.status.v1" }
          > => message.type === "bot.status.v1",
          45_000,
        );

        expect(status.payload.connectionState).toBe("online");
        expect(Number.isFinite(status.payload.health.current)).toBe(true);
        expect(Number.isFinite(status.payload.food.level)).toBe(true);
        expect(Number.isFinite(status.payload.position.x)).toBe(true);
        expect(Number.isFinite(status.payload.position.y)).toBe(true);
        expect(Number.isFinite(status.payload.position.z)).toBe(true);
        expect(status.payload.position.dimension).toMatch(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);
        expect(status.payload.safety).toMatchObject({
          mode: "monitoring",
          activeRisks: [],
          normalTasksPaused: false,
        });
        const version = await waitForMessage(
          messages,
          (message): message is Extract<
            BotTelemetryMessageV1,
            { type: "bot.version.v1" }
          > => message.type === "bot.version.v1",
          10_000,
        );
        expect(version.payload.compatibility).toMatchObject({
          selection: profile.minecraftVersion === "auto" ? "auto" : "fixed",
          requestedVersion:
            profile.minecraftVersion === "auto" ? null : profile.minecraftVersion,
          resolvedVersion: "1.21.8",
          protocolVersion: 772,
          majorVersion: "1.21",
          supportLevel: "tested",
        });
        expect(status.payload.minecraftVersion).toEqual(
          version.payload.compatibility,
        );

        await runtime.stop("real_integration_graceful_stop");
        const disconnected = await waitForMessage(
          messages,
          (message): message is Extract<
            BotTelemetryMessageV1,
            { type: "bot.disconnected.v1" }
          > =>
            message.type === "bot.disconnected.v1" &&
            message.payload.expected,
          10_000,
        );
        expect(disconnected.payload.reason).toBe("requested_stop");
        expect(runtime.getState()).toBe("offline");
      } finally {
        await runtime.stop("real_integration_cleanup");
      }
    },
    60_000,
  );

  it(
    "executes smelt.item against the real isolated server",
    async () => {
      const setupRequest = process.env.MC_SKILL_SETUP_REQUEST_FILE;
      const setupReady = process.env.MC_SKILL_SETUP_READY_FILE;
      if (!setupRequest || !setupReady) throw new Error("Skill setup marker paths are required.");

      const profile = await loadServerProfile();
      const messages: BotTelemetryMessageV1[] = [];
      const runtime = new SingleBotRuntime(profile, {
        createClient: createMineflayerClient,
        messageSink: (message) => messages.push(message),
        logger,
      });
      runtime.start();
      try {
        const status = await waitForMessage(
          messages,
          (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> =>
            message.type === "bot.status.v1" && message.payload.connectionState === "online",
          45_000,
        );
        await mkdir(path.dirname(setupRequest), { recursive: true });
        await writeFile(setupRequest, "smelt-item.basic.v1\n", { encoding: "utf8", flag: "wx" });
        await waitForFile(setupReady, 10_000);
        await new Promise((resolve) => setTimeout(resolve, 500));

        const now = new Date();
        const expiresAt = new Date(now.getTime() + 90_000).toISOString();
        const invocation = {
          schemaVersion: "1.0" as const,
          messageId: "71111111-1111-4111-8111-111111111111",
          traceId: "trace-real-smelt-001",
          timestamp: now.toISOString(),
          source: { service: "coordinator" as const, instanceId: "coordinator-real-test" },
          botId: profile.botId,
          taskId: "task-real-smelt-001",
          type: "skill.invoke.v1" as const,
          payload: {
            invocationId: "72222222-2222-4222-8222-222222222222",
            skillId: "smelt.item",
            skillVersion: "1.0.0",
            expiresAt,
            input: {
              inputItemName: "raw_iron",
              fuelItemName: "coal",
              fuelCount: 1,
              count: 5,
              furnace: { x: 2, y: 64, z: 0 },
              dimension: status.payload.position.dimension,
              serverProfileId: profile.id,
            },
            authorization: {
              decisionId: "73333333-3333-4333-8333-333333333333",
              actorId: "isolated-acceptance",
              issuedAt: now.toISOString(),
              expiresAt,
            },
          },
        };
        const authorization: SkillExecutionAuthorization = {
          decisionId: invocation.payload.authorization.decisionId,
          actorId: invocation.payload.authorization.actorId,
          sourceInstanceId: invocation.source.instanceId,
          traceId: invocation.traceId,
          taskId: invocation.taskId,
          botId: invocation.botId,
          invocationId: invocation.payload.invocationId,
          skillId: invocation.payload.skillId,
          skillVersion: invocation.payload.skillVersion,
          issuedAt: invocation.payload.authorization.issuedAt,
          expiresAt,
          allowedCapabilities: new Set(["craft.execute"]),
        };
        const result = await runtime.handleSkillInvocation(invocation, authorization);
        expect(result.payload).toMatchObject({
          outcome: "completed",
          output: { outputItemName: "iron_ingot", requestedCount: 5, smeltedCount: 5 },
        });
      } finally {
        await runtime.stop("real_smelt_acceptance_cleanup");
      }
    },
    120_000,
  );

  it(
    "reports an unexpected server stop and begins bounded reconnect",
    async () => {
      const readyFile = process.env.MC_TEST_READY_FILE;
      if (!readyFile) throw new Error("MC_TEST_READY_FILE is required.");

      const profile = await loadServerProfile();
      const messages: BotTelemetryMessageV1[] = [];
      const runtime = new SingleBotRuntime(profile, {
        createClient: createMineflayerClient,
        messageSink: (message) => messages.push(message),
        logger,
      });

      runtime.start();
      try {
        await waitForMessage(
          messages,
          (message): message is Extract<
            BotTelemetryMessageV1,
            { type: "bot.status.v1" }
          > => message.type === "bot.status.v1",
          45_000,
        );

        await mkdir(path.dirname(readyFile), { recursive: true });
        await writeFile(readyFile, "ready\n", { encoding: "utf8", flag: "wx" });

        const disconnected = await waitForMessage(
          messages,
          (message): message is Extract<
            BotTelemetryMessageV1,
            { type: "bot.disconnected.v1" }
          > =>
            message.type === "bot.disconnected.v1" &&
            !message.payload.expected,
          30_000,
        );

        const reconnectHeartbeat = await waitForMessage(
          messages,
          (message): message is Extract<
            BotTelemetryMessageV1,
            { type: "bot.heartbeat.v1" }
          > =>
            message.type === "bot.heartbeat.v1" &&
            message.payload.connectionState === "connecting" &&
            message.payload.sequence > disconnected.payload.sequence,
          15_000,
        );

        expect(reconnectHeartbeat.payload.connectionState).toBe("connecting");
      } finally {
        await runtime.stop("real_integration_cleanup");
      }
    },
    75_000,
  );
});


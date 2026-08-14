import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { BotTelemetryMessageV1 } from "@minecraft-studio/protocol";
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

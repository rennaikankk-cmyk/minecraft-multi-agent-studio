import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  skillInvocationV1Schema,
  type BotTelemetryMessageV1,
  type SkillJsonValue,
} from "@minecraft-studio/protocol";
import { beforeEach, describe, expect, it } from "vitest";

import { createMineflayerClient } from "../src/mineflayer-client.js";
import { SingleBotRuntime } from "../src/runtime.js";
import { loadServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";

const enabled = process.env.RUN_REAL_MC_TEST === "1";
const integrationDescribe = enabled ? describe : describe.skip;
const ACCEPTANCE_COORDINATOR_ID = "coordinator-real-acceptance";
const REAL_ACCEPTANCE_SKILL_IDS = [
  "movement.goto",
  "collect.block",
  "craft.item",
  "world.place-block",
  "container.transfer",
  "inventory.equip-armor",
  "smelt.item",
] as const;

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

function acceptanceUuid(value: number): string {
  return `90000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function outputNumber(output: SkillJsonValue, key: string): number {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error(`Skill output is not an object while reading ${key}.`);
  }
  const value = output[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Skill output ${key} is not a finite number.`);
  }
  return value;
}

async function executeAcceptanceSkill(
  runtime: SingleBotRuntime,
  profile: Awaited<ReturnType<typeof loadServerProfile>>,
  skillId: (typeof REAL_ACCEPTANCE_SKILL_IDS)[number],
  input: SkillJsonValue,
  sequence: number,
): Promise<SkillJsonValue> {
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 180_000).toISOString();
  const invocation = skillInvocationV1Schema.parse({
    schemaVersion: "1.0",
    messageId: acceptanceUuid(sequence * 3),
    traceId: `trace-real-${skillId.replaceAll(".", "-")}`,
    timestamp: issuedAt.toISOString(),
    source: {
      service: "coordinator",
      instanceId: ACCEPTANCE_COORDINATOR_ID,
    },
    botId: profile.botId,
    taskId: `task-real-${skillId.replaceAll(".", "-")}`,
    type: "skill.invoke.v1",
    payload: {
      invocationId: acceptanceUuid(sequence * 3 + 1),
      skillId,
      skillVersion: "1.0.0",
      expiresAt,
      input,
      authorization: {
        decisionId: acceptanceUuid(sequence * 3 + 2),
        actorId: "isolated-acceptance",
        issuedAt: issuedAt.toISOString(),
        expiresAt,
      },
    },
  });
  const result = await runtime.handleCoordinatorSkillInvocation(
    invocation,
    ACCEPTANCE_COORDINATOR_ID,
  );
  if (result.payload.outcome !== "completed") {
    const errorCode =
      "errorCode" in result.payload ? result.payload.errorCode : "UNKNOWN";
    throw new Error(
      `Real acceptance failed for ${skillId}: ${result.payload.outcome}/${errorCode}`,
    );
  }
  return result.payload.output;
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
          > =>
            message.type === "bot.status.v1" &&
            message.payload.connectionState === "online",
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
    "executes all seven builtin skills against the real isolated server",
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
        await writeFile(setupRequest, "builtin-skills.success.v1\n", {
          encoding: "utf8",
          flag: "wx",
        });
        await waitForFile(setupReady, 45_000);
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const dimension = status.payload.position.dimension;
        const serverProfileId = profile.id;
        const completedSkillIds: string[] = [];
        const execute = async (
          skillId: (typeof REAL_ACCEPTANCE_SKILL_IDS)[number],
          input: SkillJsonValue,
        ) => {
          const output = await executeAcceptanceSkill(
            runtime,
            profile,
            skillId,
            input,
            completedSkillIds.length + 1,
          );
          completedSkillIds.push(skillId);
          return output;
        };

        const movementOutput = await execute("movement.goto", {
          target: { x: 3, y: 65, z: 0, dimension, serverProfileId },
          radius: 1,
        });
        expect(movementOutput).toMatchObject({ reached: true });
        expect(outputNumber(movementOutput, "distanceToTarget")).toBeLessThanOrEqual(
          1.5,
        );

        const collectOutput = await execute("collect.block", {
          blockName: "oak_log",
          maxCount: 1,
          maxDistance: 4,
          dimension,
          serverProfileId,
        });
        expect(collectOutput).toMatchObject({
          blockName: "oak_log",
          targetsFound: 1,
        });
        expect(outputNumber(collectOutput, "itemsCollected")).toBe(1);

        await expect(
          execute("craft.item", {
            itemName: "crafting_table",
            count: 1,
            craftingTable: null,
            dimension,
            serverProfileId,
          }),
        ).resolves.toMatchObject({
          itemName: "crafting_table",
          requestedCount: 1,
          craftedCount: 1,
          usedCraftingTable: false,
        });

        await expect(
          execute("world.place-block", {
            itemName: "cobblestone",
            referenceBlock: { x: 5, y: 64, z: 2 },
            face: { x: 0, y: 1, z: 0 },
            dimension,
            serverProfileId,
          }),
        ).resolves.toMatchObject({
          placed: true,
          placedBlockName: "cobblestone",
          position: { x: 5, y: 65, z: 2 },
        });

        await expect(
          execute("container.transfer", {
            direction: "deposit",
            itemName: "cobblestone",
            count: 4,
            container: { x: 5, y: 65, z: -2 },
            dimension,
            serverProfileId,
          }),
        ).resolves.toMatchObject({
          direction: "deposit",
          itemName: "cobblestone",
          requestedCount: 4,
          movedCount: 4,
        });

        await expect(
          execute("inventory.equip-armor", { serverProfileId }),
        ).resolves.toMatchObject({
          changedCount: 4,
          totalScoreBefore: 0,
          totalScoreAfter: 15,
        });

        await expect(
          execute("smelt.item", {
            inputItemName: "raw_iron",
            fuelItemName: "coal",
            fuelCount: 1,
            count: 1,
            furnace: { x: 3, y: 65, z: -2 },
            dimension,
            serverProfileId,
          }),
        ).resolves.toMatchObject({
          outputItemName: "iron_ingot",
          requestedCount: 1,
          smeltedCount: 1,
        });

        expect(completedSkillIds).toEqual(REAL_ACCEPTANCE_SKILL_IDS);
      } finally {
        await runtime.stop("real_skill_acceptance_cleanup");
      }
    },
    180_000,
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
          > =>
            message.type === "bot.status.v1" &&
            message.payload.connectionState === "online",
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

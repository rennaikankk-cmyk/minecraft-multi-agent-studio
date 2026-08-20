import { createHash } from "node:crypto";

import {
  parseSkillExecutionResult,
  parseSkillInvocation,
  type SkillExecutionResultV1,
  type SkillInvocationV1,
} from "@minecraft-studio/protocol";
import {
  containerTransferInputSchema,
  containerTransferOutputSchema,
  scoutScanBlocksInputSchema,
  scoutScanBlocksOutputSchema,
  storageAccountInputSchema,
  storageAccountOutputSchema,
} from "@minecraft-studio/skills";

import { WorldMemoryError } from "./errors.js";
import {
  worldMemoryWriteCommandSchema,
  type WorldMemoryKind,
  type WorldMemoryPosition,
  type WorldMemoryWriteCommand,
} from "./model.js";
import type { WorldMemoryWriterLike } from "./repository.js";

const PORTAL_BLOCKS = new Set([
  "end_gateway",
  "end_portal",
  "end_portal_frame",
  "nether_portal",
]);
const HAZARD_BLOCKS = new Set([
  "cactus",
  "campfire",
  "fire",
  "lava",
  "magma_block",
  "powder_snow",
  "soul_campfire",
  "soul_fire",
  "sweet_berry_bush",
  "wither_rose",
]);
const RESOURCE_BLOCKS = new Set([
  "ancient_debris",
  "amethyst_cluster",
  "budding_amethyst",
  "clay",
  "gravel",
  "obsidian",
]);
const SCOUT_ORIGIN_TOLERANCE = 8;
const STORAGE_FACT_LIFETIME_MS = 15 * 60_000;
const SCOUT_FACT_LIFETIME_MS: Readonly<Record<WorldMemoryKind, number>> = {
  base: 0,
  hazard: 24 * 60 * 60_000,
  landmark: 7 * 24 * 60 * 60_000,
  player_activity: 0,
  portal: 7 * 24 * 60 * 60_000,
  resource: 24 * 60 * 60_000,
  route: 0,
  storage: 0,
};

export type WorldMemorySkillResultEvent = Readonly<{
  command: SkillInvocationV1;
  result: SkillExecutionResultV1;
  authoritativeServerProfileId: string;
  authoritativePosition: Readonly<
    WorldMemoryPosition & { dimension: string }
  >;
}>;

export type WorldMemoryIngestionResult = Readonly<{
  projectedCount: number;
  createdCount: number;
  replayedCount: number;
}>;

type CompletedSkillResult = Omit<SkillExecutionResultV1, "payload"> &
  Readonly<{
    payload: Extract<
      SkillExecutionResultV1["payload"],
      { outcome: "completed" }
    >;
  }>;

function sourceInvalid(message: string): never {
  throw new WorldMemoryError("WORLD_MEMORY_SOURCE_INVALID", message);
}

function stableUuid(input: string): string {
  const bytes = createHash("sha256").update(input, "utf8").digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function timestampAfter(timestamp: string, durationMs: number): string {
  return new Date(Date.parse(timestamp) + durationMs).toISOString();
}

function ensureIdentity(
  event: WorldMemorySkillResultEvent,
): Readonly<{
  command: SkillInvocationV1;
  result: CompletedSkillResult;
}> | null {
  const command = parseSkillInvocation(event.command);
  const result = parseSkillExecutionResult(event.result);
  if (result.payload.outcome !== "completed") return null;
  if (
    result.traceId !== command.traceId ||
    result.botId !== command.botId ||
    result.taskId !== command.taskId ||
    result.source.instanceId !== command.payload.expectedRuntimeInstanceId ||
    result.payload.invocationId !== command.payload.invocationId ||
    result.payload.skillId !== command.payload.skillId ||
    result.payload.skillVersion !== command.payload.skillVersion
  ) {
    return sourceInvalid(
      "Completed skill result identity does not match its authorized invocation.",
    );
  }
  return { command, result: result as CompletedSkillResult };
}

function ensureWorld(
  event: WorldMemorySkillResultEvent,
  serverProfileId: string,
  dimension: string,
): void {
  if (
    serverProfileId !== event.authoritativeServerProfileId ||
    dimension !== event.authoritativePosition.dimension
  ) {
    sourceInvalid(
      "Skill result attempted to write memory outside the authoritative Bot world.",
    );
  }
}

function withinDistance(
  left: WorldMemoryPosition,
  right: WorldMemoryPosition,
  maximum: number,
): boolean {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z) <= maximum;
}

function classifyBlock(blockName: string): WorldMemoryKind {
  if (PORTAL_BLOCKS.has(blockName)) return "portal";
  if (HAZARD_BLOCKS.has(blockName)) return "hazard";
  if (
    RESOURCE_BLOCKS.has(blockName) ||
    blockName.endsWith("_ore") ||
    blockName.endsWith("_log")
  ) {
    return "resource";
  }
  return "landmark";
}

function baseCommand(
  command: SkillInvocationV1,
  result: CompletedSkillResult,
  index: number,
): Pick<
  WorldMemoryWriteCommand,
  | "schemaVersion"
  | "operationId"
  | "memoryId"
  | "sourceBotId"
  | "sourceTaskId"
  | "traceId"
  | "observedAt"
  | "supersedesMemoryId"
  | "embedding"
> {
  const identity = `${command.payload.invocationId}:${index}`;
  return {
    schemaVersion: "1.0",
    operationId: stableUuid(`world-memory-operation:${identity}`),
    memoryId: stableUuid(`world-memory-record:${identity}`),
    sourceBotId: command.botId,
    sourceTaskId: command.taskId,
    traceId: command.traceId,
    observedAt: result.payload.completedAt,
    supersedesMemoryId: null,
    embedding: null,
  };
}

function scoutFacts(
  event: WorldMemorySkillResultEvent,
  command: SkillInvocationV1,
  result: CompletedSkillResult,
): readonly WorldMemoryWriteCommand[] {
  const input = scoutScanBlocksInputSchema.safeParse(command.payload.input);
  const output = scoutScanBlocksOutputSchema.safeParse(result.payload.output);
  if (!input.success || !output.success) {
    return sourceInvalid("Scout scan input or completed output is invalid.");
  }
  ensureWorld(event, input.data.serverProfileId, input.data.dimension);
  if (
    !withinDistance(
      output.data.origin,
      event.authoritativePosition,
      SCOUT_ORIGIN_TOLERANCE,
    )
  ) {
    return sourceInvalid(
      "Scout scan origin is too far from the authoritative execution position.",
    );
  }
  const requestedNames = new Set(input.data.blockNames);
  if (
    output.data.observations.length > input.data.maxResults ||
    output.data.observations.some(
      ({ blockName, position }) =>
        !requestedNames.has(blockName) ||
        !withinDistance(position, output.data.origin, input.data.maxDistance + 1),
    )
  ) {
    return sourceInvalid(
      "Scout scan output exceeds its authorized names, count, or radius.",
    );
  }
  return Object.freeze(
    output.data.observations.map(({ blockName, position }, index) => {
      const kind = classifyBlock(blockName);
      const observedAt = result.payload.completedAt;
      return worldMemoryWriteCommandSchema.parse({
        ...baseCommand(command, result, index),
        serverProfileId: input.data.serverProfileId,
        dimension: input.data.dimension,
        position,
        kind,
        summary: `Authorized scout scan observed ${blockName}.`,
        tags: [blockName, "source:scout.scan-blocks"],
        confidence: 1,
        visibility: "team",
        allowedSubjectIds: [],
        modelAccess: true,
        expiresAt: timestampAfter(observedAt, SCOUT_FACT_LIFETIME_MS[kind]),
      });
    }),
  );
}

function storageAccountFact(
  event: WorldMemorySkillResultEvent,
  command: SkillInvocationV1,
  result: CompletedSkillResult,
): readonly WorldMemoryWriteCommand[] {
  const input = storageAccountInputSchema.safeParse(command.payload.input);
  const output = storageAccountOutputSchema.safeParse(result.payload.output);
  if (!input.success || !output.success) {
    return sourceInvalid("Storage account input or completed output is invalid.");
  }
  ensureWorld(event, input.data.serverProfileId, input.data.dimension);
  const requestedItems = new Set(input.data.itemNames);
  const outputItems = output.data.items.map(({ itemName }) => itemName);
  if (
    !withinDistance(input.data.container, event.authoritativePosition, 8) ||
    new Set(outputItems).size !== outputItems.length ||
    outputItems.some((itemName) => !requestedItems.has(itemName))
  ) {
    return sourceInvalid(
      "Storage account result exceeds its authorized location or item allow-list.",
    );
  }
  const itemSummary = output.data.items
    .slice(0, 8)
    .map(({ itemName, containerCount }) => `${itemName}=${containerCount}`)
    .join(", ");
  return [
    worldMemoryWriteCommandSchema.parse({
      ...baseCommand(command, result, 0),
      serverProfileId: input.data.serverProfileId,
      dimension: input.data.dimension,
      position: input.data.container,
      kind: "storage",
      summary: `${output.data.containerName} account: ${itemSummary}.`,
      tags: [
        output.data.containerName,
        ...output.data.items.slice(0, 31).map(({ itemName }) => itemName),
      ].sort(),
      confidence: 1,
      visibility: "restricted",
      allowedSubjectIds: [command.botId],
      modelAccess: false,
      expiresAt: timestampAfter(
        result.payload.completedAt,
        STORAGE_FACT_LIFETIME_MS,
      ),
    }),
  ];
}

function containerTransferFact(
  event: WorldMemorySkillResultEvent,
  command: SkillInvocationV1,
  result: CompletedSkillResult,
): readonly WorldMemoryWriteCommand[] {
  const input = containerTransferInputSchema.safeParse(command.payload.input);
  const output = containerTransferOutputSchema.safeParse(result.payload.output);
  if (!input.success || !output.success) {
    return sourceInvalid("Container transfer input or completed output is invalid.");
  }
  ensureWorld(event, input.data.serverProfileId, input.data.dimension);
  if (
    output.data.direction !== input.data.direction ||
    output.data.itemName !== input.data.itemName ||
    output.data.requestedCount !== input.data.count ||
    !withinDistance(input.data.container, event.authoritativePosition, 8)
  ) {
    return sourceInvalid(
      "Container transfer result does not match its authorized world operation.",
    );
  }
  return [
    worldMemoryWriteCommandSchema.parse({
      ...baseCommand(command, result, 0),
      serverProfileId: input.data.serverProfileId,
      dimension: input.data.dimension,
      position: input.data.container,
      kind: "storage",
      summary: `Authorized ${output.data.direction} moved ${output.data.movedCount} of ${output.data.requestedCount} ${output.data.itemName}.`,
      tags: [
        `direction:${output.data.direction}`,
        output.data.itemName,
      ],
      confidence: 1,
      visibility: "restricted",
      allowedSubjectIds: [command.botId],
      modelAccess: false,
      expiresAt: timestampAfter(
        result.payload.completedAt,
        STORAGE_FACT_LIFETIME_MS,
      ),
    }),
  ];
}

export function projectWorldMemoryFromSkillResult(
  event: WorldMemorySkillResultEvent,
): readonly WorldMemoryWriteCommand[] {
  const identity = ensureIdentity(event);
  if (identity === null) return [];
  const { command, result } = identity;
  if (command.payload.skillId === "scout.scan-blocks") {
    return scoutFacts(event, command, result);
  }
  if (command.payload.skillId === "storage.account") {
    return storageAccountFact(event, command, result);
  }
  if (command.payload.skillId === "container.transfer") {
    return containerTransferFact(event, command, result);
  }
  return [];
}

export class WorldMemorySkillResultIngestor {
  constructor(private readonly writer: WorldMemoryWriterLike) {}

  async ingest(
    event: WorldMemorySkillResultEvent,
  ): Promise<WorldMemoryIngestionResult> {
    let commands: readonly WorldMemoryWriteCommand[] = [];
    let createdCount = 0;
    try {
      commands = projectWorldMemoryFromSkillResult(event);
      for (const command of commands) {
        const result = await this.writer.record(command);
        if (result.created) createdCount += 1;
      }
    } catch (error) {
      if (error instanceof WorldMemoryError) throw error;
      throw new WorldMemoryError(
        "WORLD_MEMORY_INGESTION_FAILED",
        "Authorized skill-result memory ingestion failed.",
        { cause: error },
      );
    }
    return Object.freeze({
      projectedCount: commands.length,
      createdCount,
      replayedCount: commands.length - createdCount,
    });
  }
}

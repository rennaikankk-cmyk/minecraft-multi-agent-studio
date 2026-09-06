import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";

import {
  skillInvocationV1Schema,
  type BotTelemetryMessageV1,
  type SkillJsonValue,
} from "@minecraft-studio/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { farmMaintainOutputSchema, farmSustainOutputSchema, elytraOutputSchema, builtinSkills } from "@minecraft-studio/skills";

import { createMineflayerClient } from "../src/mineflayer-client.js";
import { SingleBotRuntime } from "../src/runtime.js";
import { loadServerProfile, type ServerProfile } from "../src/server-profile.js";
import type { RuntimeLogger } from "../src/runtime-types.js";
import { SharedStateServer } from "../../coordinator/src/shared-state-server.js";

const enabled = process.env.RUN_REAL_MC_TEST === "1";
const foodSoakMinutes = Number(process.env.MC_FOOD_SOAK_MINUTES ?? 0);
const observedClients = new Map<string, Bot>();
const farmPackets = new Map<string, unknown[]>();
const farmLights = new Map<string, unknown[]>();
const integrationDescribe = enabled ? describe : describe.skip;
const ACCEPTANCE_COORDINATOR_ID = "coordinator-real-acceptance";
const REAL_ACCEPTANCE_SKILL_IDS = [
  "movement.profile",
  "movement.goto",
  "travel.route",
  "world.scan",
  "collect.block",
  "craft.item",
  "pack.shulker",
  "world.place-block",
  "container.transfer",
  "store.sort",
  "smelt.item",
  "inventory.equip-armor",
  "mine.branch",
  "mine.vein",
  "site.assess",
  "build.blueprint",
  "stock.levels",
  "combat.engage",
  "combat.disengage",
  "trade.villager",
  "farm.maintain",
  "shelter.dig",
] as const;

type BlockPosition = Readonly<{ x: number; y: number; z: number }>;
type AcceptanceZone = Readonly<{
  origin: BlockPosition;
  log: BlockPosition;
  chest: BlockPosition;
  furnace: BlockPosition;
  shulker: BlockPosition;
  blueprintAnchor: BlockPosition;
  siteCandidate: BlockPosition;
  zombie: BlockPosition;
  villager: BlockPosition;
  shelterDirection: "east" | "west";
  branchOrigin: BlockPosition;
  branchOrePositions: readonly BlockPosition[];
  veinOrigin: BlockPosition;
  veinOrePosition: BlockPosition;
}>;

type AcceptanceBot = {
  profile: ServerProfile;
  runtime: SingleBotRuntime;
  messages: BotTelemetryMessageV1[];
  zone: AcceptanceZone;
  completedSkillIds: string[];
};

const ACCEPTANCE_ZONES: readonly AcceptanceZone[] = [
  {
    origin: { x: 0, y: 65, z: 0 },
    log: { x: 5, y: 65, z: 0 },
    chest: { x: 5, y: 65, z: -2 },
    furnace: { x: 3, y: 65, z: -2 },
    shulker: { x: 3, y: 65, z: 2 },
    blueprintAnchor: { x: 6, y: 65, z: 3 },
    siteCandidate: { x: 9, y: 65, z: 3 },
    zombie: { x: 2, y: 65, z: 2 },
    villager: { x: 0, y: 65, z: 2 },
    shelterDirection: "west",
    branchOrigin: { x: 0, y: 65, z: 4 },
    branchOrePositions: [
      { x: 1, y: 65, z: 4 },
      { x: 2, y: 65, z: 4 },
    ],
    veinOrigin: { x: 2, y: 65, z: 4 },
    veinOrePosition: { x: 3, y: 65, z: 4 },
  },
  {
    origin: { x: 20, y: 65, z: 0 },
    log: { x: 25, y: 65, z: 0 },
    chest: { x: 25, y: 65, z: -2 },
    furnace: { x: 23, y: 65, z: -2 },
    shulker: { x: 23, y: 65, z: 2 },
    blueprintAnchor: { x: 26, y: 65, z: 3 },
    siteCandidate: { x: 29, y: 65, z: 3 },
    zombie: { x: 24, y: 65, z: 2 },
    villager: { x: 20, y: 65, z: 2 },
    shelterDirection: "east",
    branchOrigin: { x: 20, y: 65, z: 4 },
    branchOrePositions: [
      { x: 21, y: 65, z: 4 },
      { x: 22, y: 65, z: 4 },
    ],
    veinOrigin: { x: 22, y: 65, z: 4 },
    veinOrePosition: { x: 23, y: 65, z: 4 },
  },
];

const runtimeEvents: string[] = [];
const runtimeFaults: unknown[] = [];
const runtimeDiagnostics: unknown[] = [];
const logger: RuntimeLogger = {
  info: (event, fields) => {
    runtimeEvents.push(`info:${event}`);
    if (event === "runtime_event_loop_delay") {
      runtimeDiagnostics.push({ event, fields });
      if (runtimeDiagnostics.length > 8) runtimeDiagnostics.shift();
    }
  },
  warn: (event, fields) => {
    runtimeEvents.push(`warn:${event}`);
    if (event === "bot_runtime_skill_fault") runtimeFaults.push(fields);
    if (event === "bot_runtime_client_error" || event === "bot_runtime_disconnected") {
      runtimeDiagnostics.push({ event, fields });
      if (runtimeDiagnostics.length > 8) runtimeDiagnostics.shift();
    }
  },
  error: (event) => runtimeEvents.push(`error:${event}`),
};

let acceptanceSequence = 0;

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

async function waitForBotMessage<T extends BotTelemetryMessageV1>(
  bot: AcceptanceBot,
  predicate: (message: BotTelemetryMessageV1) => message is T,
  timeoutMs: number,
): Promise<T> {
  return waitForMessage(
    bot.messages,
    (message): message is T =>
      message.botId === bot.profile.botId && predicate(message),
    timeoutMs,
  );
}

function acceptanceUuid(value: number): string {
  return `90000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
}

function outputRecord(output: SkillJsonValue, key: string): Record<string, unknown> {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error(`Skill output is not an object while reading ${key}.`);
  }
  const value = output[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Skill output ${key} is not an object.`);
  }
  return value as Record<string, unknown>;
}

function outputArray(output: SkillJsonValue, key: string): readonly unknown[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    throw new Error(`Skill output is not an object while reading ${key}.`);
  }
  const value = output[key];
  if (!Array.isArray(value)) {
    throw new Error(`Skill output ${key} is not an array.`);
  }
  return value;
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

function profileForBot(
  baseProfile: ServerProfile,
  botId: string,
  username: string,
): ServerProfile {
  return {
    ...baseProfile,
    botId,
    username,
    combat: {
      enabled: true,
      stance: "preserve-life",
      whitelist: {
        usernames: ["StudioBot01", "StudioBot02"],
        uuids: [],
      },
    },
  };
}

async function createAcceptanceBots(): Promise<AcceptanceBot[]> {
  const baseProfile = await loadServerProfile();
  return [
    {
      profile: profileForBot(baseProfile, "studio-bot-01", "StudioBot01"),
      zone: ACCEPTANCE_ZONES[0]!,
    },
    {
      profile: profileForBot(baseProfile, "studio-bot-02", "StudioBot02"),
      zone: ACCEPTANCE_ZONES[1]!,
    },
  ].map(({ profile, zone }) => {
    const messages: BotTelemetryMessageV1[] = [];
    return {
      profile,
      zone,
      messages,
      runtime: new SingleBotRuntime(profile, {
        createClient: (profile, worldState) => {
          const client = createMineflayerClient(profile, worldState);
          const raw = (client as unknown as { bot: Bot }).bot;
          observedClients.set(profile.botId, raw);
          if (foodSoakMinutes > 0) {
            const packets: unknown[] = []; farmPackets.set(profile.botId, packets);
            const lights: unknown[] = []; farmLights.set(profile.botId, lights);
            raw._client.on("update_light", (packet) => {
              const low = (mask: Array<[number, number]>) => mask[0]?.[1] ?? 0;
              const mask = low(packet.blockLightMask);
              let bufferIndex = 0;
              const sections = [];
              for (let section = 0; section < 26; section++) if (mask & 1 << section) {
                const bytes = Buffer.from(packet.blockLight[bufferIndex++]!);
                const levels = [64, 65, 66].map((y) => {
                  const index = (y & 15) << 8 | 11 << 4 | (zone.origin.x & 15);
                  return { y, value: (bytes[index >> 1]! >> (index % 2 * 4)) & 15 };
                });
                sections.push({ section, nonzero: bytes.filter((b) => b !== 0).length, levels });
              }
              lights.push({ x: packet.chunkX, z: packet.chunkZ, mask: packet.blockLightMask, empty: packet.emptyBlockLightMask, sections });
              if (lights.length > 3) lights.shift();
            });
            const write = raw._client.write.bind(raw._client);
            raw._client.write = (name, data) => {
              if (["block_place", "held_item_slot", "teleport_confirm"].includes(name)) {
                packets.push({ name, data }); if (packets.length > 12) packets.shift();
              }
              write(name, data);
            };
          }
          return client;
        },
        messageSink: (message) => messages.push(message),
        logger,
      }),
      completedSkillIds: [],
    };
  });
}

async function stopAcceptanceBots(
  bots: readonly AcceptanceBot[],
  reason: string,
): Promise<void> {
  await Promise.allSettled(
    bots.map((bot) => bot.runtime.stop(`${reason}_${bot.profile.botId}`)),
  );
}

async function executeAcceptanceSkill(
  runtime: SingleBotRuntime,
  profile: ServerProfile,
  skillId: string,
  input: SkillJsonValue,
): Promise<SkillJsonValue> {
  const sequence = ++acceptanceSequence;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 180_000).toISOString();
  const skillToken = skillId.replaceAll(".", "-");
  const invocation = skillInvocationV1Schema.parse({
    schemaVersion: "1.0",
    messageId: acceptanceUuid(sequence * 3),
    traceId: `trace-real-${profile.botId}-${skillToken}-${sequence}`,
    timestamp: issuedAt.toISOString(),
    source: {
      service: "coordinator",
      instanceId: ACCEPTANCE_COORDINATOR_ID,
    },
    botId: profile.botId,
    taskId: `task-real-${profile.botId}-${skillToken}-${sequence}`,
    type: "skill.invoke.v1",
    payload: {
      invocationId: acceptanceUuid(sequence * 3 + 1),
      skillId,
      skillVersion: builtinSkills.find((skill) => skill.id === skillId)!.version,
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
      `Real acceptance failed for ${profile.botId}/${skillId}: ${result.payload.outcome}/${errorCode}`,
    );
  }
  return result.payload.output;
}

async function runSkill(
  bot: AcceptanceBot,
  skillId: string,
  input: SkillJsonValue,
): Promise<SkillJsonValue> {
  let output: SkillJsonValue;
  try {
    output = await executeAcceptanceSkill(
      bot.runtime,
      bot.profile,
      skillId,
      input,
    );
  } catch (error) {
    const latestStatus = [...bot.messages]
      .reverse()
      .find((message) => message.type === "bot.status.v1");
    const position = latestStatus?.type === "bot.status.v1"
      ? latestStatus.payload.position
      : null;
    const reason = error instanceof Error ? error.message : String(error);
    const rawBot = observedClients.get(bot.profile.botId);
    const farmDebug = skillId === "farm.sustain" && rawBot ? {
      heldItem: rawBot.heldItem?.name, inventory: rawBot.inventory.items().map((item) => ({ name: item.name, count: item.count })),
      packets: farmPackets.get(bot.profile.botId),
      blocks: [new Vec3(bot.zone.origin.x, 64, -15), new Vec3(bot.zone.origin.x, 65, -15)].map((p) => ({
        at: p.toString(), name: rawBot.blockAt(p)?.name, properties: rawBot.blockAt(p)?.getProperties(),
      })),
    } : null;
    throw new Error(
      `${reason}; runtimeState=${bot.runtime.getState()}; position=${JSON.stringify(position)}; ` +
        `completed=${bot.completedSkillIds.join(",")}; ` +
        `safety=${JSON.stringify(latestStatus?.type === "bot.status.v1" ? latestStatus.payload.safety : null)}; ` +
        `events=${runtimeEvents.slice(-30).join(",")}; faults=${JSON.stringify(runtimeFaults.slice(-2))}; diagnostics=${JSON.stringify(runtimeDiagnostics)}; farmDebug=${JSON.stringify(farmDebug)}`,
      { cause: error },
    );
  }
  if (!bot.completedSkillIds.includes(skillId)) {
    bot.completedSkillIds.push(skillId);
  }
  return output;
}

async function moveTo(
  bot: AcceptanceBot,
  target: BlockPosition,
  dimension: string,
): Promise<SkillJsonValue> {
  return runSkill(bot, "movement.goto", {
    target: {
      ...target,
      dimension,
      serverProfileId: bot.profile.id,
    },
    radius: 1,
  });
}

function isolatedSitePolicy() {
  return {
    minSpawnDistance: 0,
    minAxisDistance: 0,
    minHighwayDistance: 0,
    minPortalLineDistance: 0,
    coordinateGridSize: 1_000,
    minCoordinateGridOffset: 0,
    symmetryTolerance: 0,
    hazardClearance: 0,
    hideoutSeparation: 0,
    burialDepthTarget: 1,
    escapeRouteTarget: 1,
    acceptanceScore: 0,
    verified: false as const,
    verificationNote: "未实测" as const,
  };
}

async function runAllSkillsForBot(bot: AcceptanceBot, dimension: string): Promise<void> {
  const serverProfileId = bot.profile.id;
  const { zone } = bot;

  const movementProfileOutput = await runSkill(bot, "movement.profile", {
    profile: "SAFE",
    serverProfileId,
  });
  expect(movementProfileOutput).toMatchObject({
    serverProfileId,
    config: { profile: "SAFE", allowParkour: false },
  });

  const movementOutput = await moveTo(bot, { x: zone.origin.x + 3, y: 65, z: 0 }, dimension);
  expect(movementOutput).toMatchObject({ reached: true });
  expect(outputNumber(movementOutput, "distanceToTarget")).toBeLessThanOrEqual(1.5);

  const travelDestination = { x: zone.origin.x + 5, y: 65, z: 1 };
  const travelOutput = await runSkill(bot, "travel.route", {
    destination: travelDestination,
    dimension,
    serverProfileId,
    maxSegments: 1,
    corridorPolicy: "pathfinder",
  });
  expect(travelOutput).toMatchObject({ reached: true, destination: travelDestination });
  expect(outputNumber(travelOutput, "segmentCount")).toBeGreaterThanOrEqual(1);

  const scanOutput = await runSkill(bot, "world.scan", {
    blockName: "oak_log",
    maxCount: 1,
    maxDistance: 8,
    dimension,
    serverProfileId,
  });
  expect(scanOutput).toMatchObject({ blockName: "oak_log", targetsFound: 1, complete: true });
  expect(outputArray(scanOutput, "matches")).toHaveLength(1);

  const collectOutput = await runSkill(bot, "collect.block", {
    blockName: "oak_log",
    maxCount: 1,
    maxDistance: 8,
    dimension,
    serverProfileId,
  });
  expect(collectOutput).toMatchObject({ blockName: "oak_log", targetsFound: 1 });
  expect(outputNumber(collectOutput, "itemsCollected")).toBe(1);

  const craftOutput = await runSkill(bot, "craft.item", {
    itemName: "crafting_table",
    count: 1,
    craftingTable: null,
    dimension,
    serverProfileId,
  });
  expect(craftOutput).toMatchObject({
    itemName: "crafting_table",
    requestedCount: 1,
    craftedCount: 1,
    usedCraftingTable: false,
  });

  await moveTo(bot, { x: zone.shulker.x, y: 65, z: zone.shulker.z + 1 }, dimension);
  const packOutput = await runSkill(bot, "pack.shulker", {
    shulker: zone.shulker,
    items: [
      { itemName: "oak_planks", count: 2 },
      { itemName: "cobblestone", count: 2 },
    ],
    dimension,
    serverProfileId,
    startIndex: 0,
    maxTransfers: 2,
  });
  expect(packOutput).toMatchObject({ totalItems: 2, nextIndex: 2, completed: true });

  const placeReference = { x: zone.origin.x + 4, y: 64, z: 4 };
  // Keep the entire radius-one arrival area clear of the placement cell.
  await moveTo(bot, { x: zone.origin.x + 4, y: 65, z: 6 }, dimension);
  const placeOutput = await runSkill(bot, "world.place-block", {
    itemName: "cobblestone",
    referenceBlock: placeReference,
    face: { x: 0, y: 1, z: 0 },
    dimension,
    serverProfileId,
  });
  expect(placeOutput).toMatchObject({
    placed: true,
    placedBlockName: "cobblestone",
    position: { x: placeReference.x, y: 65, z: placeReference.z },
  });

  await moveTo(bot, { x: zone.chest.x, y: 65, z: zone.chest.z + 1 }, dimension);
  const transferOutput = await runSkill(bot, "container.transfer", {
    direction: "deposit",
    itemName: "cobblestone",
    count: 4,
    container: zone.chest,
    dimension,
    serverProfileId,
  });
  expect(transferOutput).toMatchObject({
    direction: "deposit",
    itemName: "cobblestone",
    requestedCount: 4,
    movedCount: 4,
  });

  const storeOutput = await runSkill(bot, "store.sort", {
    routes: [
      {
        itemName: "oak_planks",
        count: 2,
        container: zone.chest,
        dimension,
        serverProfileId,
      },
    ],
    startIndex: 0,
    maxTransfers: 1,
  });
  expect(storeOutput).toMatchObject({
    startIndex: 0,
    nextIndex: 1,
    totalRoutes: 1,
    moved: [{ itemName: "oak_planks", movedCount: 2 }],
  });

  const smeltOutput = await runSkill(bot, "smelt.item", {
    inputItemName: "raw_iron",
    fuelItemName: "coal",
    fuelCount: 1,
    count: 1,
    furnace: zone.furnace,
    dimension,
    serverProfileId,
  });
  expect(smeltOutput).toMatchObject({
    inputItemName: "raw_iron",
    outputItemName: "iron_ingot",
    requestedCount: 1,
    smeltedCount: 1,
  });

  const armorOutput = await runSkill(bot, "inventory.equip-armor", { serverProfileId });
  expect(armorOutput).toMatchObject({
    changedCount: 4,
    totalScoreBefore: 0,
    totalScoreAfter: 15,
  });

  const miningInput = {
    targetItem: "minecraft:iron_ore",
    yLevel: 65,
    branchLength: 2,
    branchSpacing: 2,
    maxBlocks: 2,
    origin: zone.branchOrigin,
    dimension,
    serverProfileId,
    backfill: true,
    exclusions: [
      "own-hideout",
      "blueprint-anchor",
      "load-bearing",
      "liquid-adjacent",
    ],
  } as const;
  const branchOutput = await runSkill(bot, "mine.branch", miningInput);
  expect(branchOutput).toMatchObject({ targetItem: "minecraft:iron_ore", yLevel: 65 });
  expect(outputArray(branchOutput, "steps")).toHaveLength(2);

  const veinOutput = await runSkill(bot, "mine.vein", {
    targetItem: "minecraft:iron_ore",
    yLevel: 65,
    maxBlocks: 1,
    origin: zone.veinOrigin,
    orePositions: [zone.veinOrePosition],
    dimension,
    serverProfileId,
    backfill: true,
    exclusions: miningInput.exclusions,
  });
  expect(veinOutput).toMatchObject({ targetItem: "minecraft:iron_ore", yLevel: 65 });

  const siteOutput = await runSkill(bot, "site.assess", {
    candidate: {
      ...zone.siteCandidate,
      dimension,
      serverProfileId,
    },
    ownRecords: [],
    policy: isolatedSitePolicy(),
    observedAt: new Date().toISOString(),
    staleAfterMs: 60_000,
  });
  expect(siteOutput).toMatchObject({
    assessment: { verdict: expect.any(String) },
    memoryRecord: { kind: "SAFE_SITE", serverProfileId },
  });

  const blueprintOutput = await runSkill(bot, "build.blueprint", {
    blueprint: {
      anchor: zone.blueprintAnchor,
      dimension,
      serverProfileId,
      cells: [
        {
          offset: { x: 0, y: 0, z: 0 },
          itemName: "oak_planks",
          blockClass: "foundation",
          order: 0,
        },
        {
          offset: { x: 1, y: 0, z: 0 },
          itemName: "oak_planks",
          blockClass: "structural",
          order: 1,
        },
      ],
    },
    startIndex: 0,
    maxPlacements: 2,
  });
  expect(blueprintOutput).toMatchObject({ completed: true, totalCells: 2, nextIndex: 2 });

  const stockOutput = await runSkill(bot, "stock.levels", {
    levels: [{ itemName: "oak_planks", low: 4, target: 8, ceiling: 64 }],
    counts: [{ itemName: "oak_planks", count: 8 }],
  });
  expect(stockOutput).toMatchObject({
    decisions: [{ itemName: "oak_planks", state: "TARGET", produce: false, stopProduction: false }],
  });

  await moveTo(bot, zone.zombie, dimension);
  const engageOutput = await runSkill(bot, "combat.engage", { serverProfileId });
  expect(engageOutput).toMatchObject({ requested: { action: "ENGAGE" } });
  const engageActual = outputRecord(engageOutput, "actual");
  expect(["RETREAT", "NONE"]).toContain(engageActual.action);
  expect(engageActual.action).not.toBe("ENGAGE");
  expect(engageActual.primitiveAction).not.toBe("MELEE_ATTACK");

  const disengageOutput = await runSkill(bot, "combat.disengage", { serverProfileId });
  expect(disengageOutput).toMatchObject({
    requested: { action: "DISENGAGE" },
    actual: { action: "DISENGAGE" },
  });

  await moveTo(bot, zone.villager, dimension);
  const tradeOutput = await runSkill(bot, "trade.villager", {
    villagerEntityId: "nearest",
    wantItem: "emerald",
    maxUnitPrice: 4,
    maxTrades: 1,
    dimension,
    serverProfileId,
  });
  expect(tradeOutput).toMatchObject({
    wantItem: "emerald",
    requestedTrades: 1,
    completedTrades: 1,
    receivedCount: 1,
    spentCount: 1,
  });

  await moveTo(bot, { ...zone.origin, z: -3 }, dimension);
  const farmOutput = await runSkill(bot, "farm.maintain", {
    area: { serverProfileId, dimension, min: { x: zone.origin.x, y: 64, z: -4 }, max: { x: zone.origin.x + 2, y: 65, z: -4 } },
    crops: ["carrots"], plantEmpty: "carrots", prepareSoil: true, replant: true, maxActions: 8,
  });
  expect(farmOutput).toMatchObject({ status: "PASS_COMPLETE", harvested: 2, planted: 3, tilled: 1, unknownCells: 0 });
  const farmReceipt = farmMaintainOutputSchema.parse(farmOutput);
  expect(farmReceipt.inventoryDelta.find((item) => item.itemName === "carrot")?.delta ?? 0).toBeGreaterThan(0);
  console.info("ISOLATED_FARM_RECEIPT", JSON.stringify({ botId: bot.profile.botId, ...farmReceipt }));

  // shelter.dig seals the original standing cell by design. Run it last so
  // the acceptance can exercise all other movement-dependent skills first.
  await moveTo(bot, zone.origin, dimension);
  const shelterOutput = await runSkill(bot, "shelter.dig", {
    direction: zone.shelterDirection,
    depth: 2,
    sealItemName: "cobblestone",
    dimension,
    serverProfileId,
  });
  expect(shelterOutput).toMatchObject({ movedInside: true, sealed: true });
  expect(outputNumber(shelterOutput, "dugBlocks")).toBeGreaterThanOrEqual(2);

  expect(bot.completedSkillIds).toEqual(REAL_ACCEPTANCE_SKILL_IDS);
  const latest = [...bot.messages].reverse().find((message) => message.type === "bot.status.v1");
  const evidence = { schemaVersion: "1.0", observedAt: new Date().toISOString(), botId: bot.profile.botId,
    completedSkills: bot.completedSkillIds, farm: farmReceipt,
    performance: latest?.type === "bot.status.v1" ? latest.payload.performance : null };
  const setupReady = process.env.MC_SKILL_SETUP_READY_FILE;
  if (!setupReady) throw new Error("Skill setup marker path is required for acceptance evidence.");
  await writeFile(path.join(path.dirname(setupReady), `skills-receipt-${bot.profile.botId}.json`), JSON.stringify(evidence, null, 2) + "\n", "utf8");
  console.info("ISOLATED_SKILLS_ACCEPTANCE", JSON.stringify(evidence));
}

integrationDescribe("real isolated Minecraft 1.21.8 server", () => {
  let sharedState: SharedStateServer | undefined;
  let stateDirectory: string | undefined;
  beforeAll(async () => {
    stateDirectory = await mkdtemp(path.join(tmpdir(), "studio-mc-acceptance-"));
    const token = randomUUID();
    sharedState = new SharedStateServer({ host: "127.0.0.1", port: 0, token,
      provenanceDir: path.join(stateDirectory, "provenance"), persistPath: path.join(stateDirectory, "state.json") });
    const address = await sharedState.start();
    vi.stubEnv("STUDIO_SHARED_STATE_URL", `http://127.0.0.1:${address.port}`);
    vi.stubEnv("STUDIO_SHARED_STATE_TOKEN", token);
  });
  afterAll(async () => {
    try { await sharedState?.stop(); }
    finally {
      vi.unstubAllEnvs();
      if (stateDirectory) await rm(stateDirectory, { recursive: true, force: true });
    }
  });
  beforeEach(() => {
    runtimeEvents.length = 0;
    runtimeFaults.length = 0;
    runtimeDiagnostics.length = 0;
  });

  it(
    "connects two real bots, reports independent status snapshots, and stops gracefully",
    async () => {
      const bots = await createAcceptanceBots();
      bots.forEach((bot) => bot.runtime.start());
      try {
        const statuses = await Promise.all(
          bots.map((bot) =>
            waitForBotMessage(
              bot,
              (message): message is Extract<
                BotTelemetryMessageV1,
                { type: "bot.status.v1" }
              > =>
                message.type === "bot.status.v1" &&
                message.payload.connectionState === "online",
              45_000,
            ),
          ),
        );

        statuses.forEach((status) => {
          expect(status.payload.connectionState).toBe("online");
          expect(Number.isFinite(status.payload.health.current)).toBe(true);
          expect(Number.isFinite(status.payload.food.level)).toBe(true);
          expect(Number.isFinite(status.payload.position.x)).toBe(true);
          expect(Number.isFinite(status.payload.position.y)).toBe(true);
          expect(Number.isFinite(status.payload.position.z)).toBe(true);
          expect(status.payload.position.dimension).toMatch(
            /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u,
          );
          expect(status.payload.safety).toMatchObject({
            mode: "monitoring",
            activeRisks: [],
            normalTasksPaused: false,
          });
        });

        const versions = await Promise.all(
          bots.map((bot) =>
            waitForBotMessage(
              bot,
              (message): message is Extract<
                BotTelemetryMessageV1,
                { type: "bot.version.v1" }
              > => message.type === "bot.version.v1",
              10_000,
            ),
          ),
        );
        versions.forEach((version, index) => {
          const profile = bots[index]!.profile;
          expect(version.payload.compatibility).toMatchObject({
            selection: profile.minecraftVersion === "auto" ? "auto" : "fixed",
            requestedVersion:
              profile.minecraftVersion === "auto" ? null : profile.minecraftVersion,
            resolvedVersion: "1.21.8",
            protocolVersion: 772,
            majorVersion: "1.21",
            supportLevel: "tested",
          });
        });

        const stopOutcomes = await Promise.all(
          bots.map((bot) => bot.runtime.stop("real_integration_graceful_stop")),
        );
        expect(stopOutcomes.every(({ confirmed }) => confirmed)).toBe(true);
        await Promise.all(
          bots.map(async (bot) => {
            const disconnected = await waitForBotMessage(
              bot,
              (message): message is Extract<
                BotTelemetryMessageV1,
                { type: "bot.disconnected.v1" }
              > =>
                message.type === "bot.disconnected.v1" &&
                message.payload.expected,
              10_000,
            );
            expect(disconnected.payload.reason).toBe("requested_stop");
            expect(bot.runtime.getState()).toBe("offline");
          }),
        );
      } finally {
        await stopAcceptanceBots(bots, "real_integration_cleanup");
      }
    },
    90_000,
  );

  it(
    "executes 22 skills for two bots against independent real fixtures without an LLM prompt",
    async () => {
      const setupRequest = process.env.MC_SKILL_SETUP_REQUEST_FILE;
      const setupReady = process.env.MC_SKILL_SETUP_READY_FILE;
      if (!setupRequest || !setupReady) {
        throw new Error("Skill setup marker paths are required.");
      }

      const bots = await createAcceptanceBots();
      bots.forEach((bot) => bot.runtime.start());
      try {
        await Promise.all(
          bots.map((bot) =>
            waitForBotMessage(
              bot,
              (message): message is Extract<
                BotTelemetryMessageV1,
                { type: "bot.status.v1" }
              > =>
                message.type === "bot.status.v1" &&
                message.payload.connectionState === "online",
              45_000,
            ),
          ),
        );
        await mkdir(path.dirname(setupRequest), { recursive: true });
        await writeFile(setupRequest, "builtin-skills.success.v1\n", {
          encoding: "utf8",
          flag: "wx",
        });
        await waitForFile(setupReady, 45_000);
        await new Promise((resolve) => setTimeout(resolve, 1_000));

        const dimension = "minecraft:overworld";
        await Promise.all(
          bots.map((bot) => runAllSkillsForBot(bot, dimension)),
        );
      } finally {
        await stopAcceptanceBots(bots, "real_skill_acceptance_cleanup");
      }
    },
    480_000,
  );

  it.skipIf(process.env.MC_ELYTRA_TEST !== "1")("flies powered elytra routes and confirms grounded arrival", async () => {
    const setupRequest = process.env.MC_SKILL_SETUP_REQUEST_FILE!, setupReady = process.env.MC_SKILL_SETUP_READY_FILE!;
    const bots = await createAcceptanceBots();
    bots.forEach((bot) => bot.runtime.start());
    try {
      await Promise.all(bots.map((bot) => waitForBotMessage(bot,
        (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> => message.type === "bot.status.v1" && message.payload.connectionState === "online", 45_000)));
      await writeFile(`${setupRequest}.flight`, "flight.v1\n", { flag: "wx" });
      await waitForFile(`${setupReady}.flight`, 45_000);
      await Promise.all(bots.map((bot) => observedClients.get(bot.profile.botId)!.waitForTicks(10)));
      for (const [index, bot] of bots.entries()) {
        const client = observedClients.get(bot.profile.botId)!;
        const samples: unknown[] = [];
        const sample = () => { if (samples.length < 1600) samples.push({ at: Date.now(), position: client.entity.position.clone(),
          velocity: client.entity.velocity.clone(), onGround: client.entity.onGround, flying: client.entity.elytraFlying, health: client.health }); };
        client.on("physicsTick", sample);
        let receipt: unknown = null;
        try {
          const healthBefore = client.health;
          const result = elytraOutputSchema.parse(await runSkill(bot, "movement.elytra", { serverProfileId: bot.profile.id,
            dimension: "minecraft:overworld", target: { x: 100, y: 128, z: index === 0 ? 104 : 116 }, maxFlightMs: 45_000 }));
          receipt = result;
          expect(result).toMatchObject({ landed: true, reached: true, status: "TARGET_LANDED" });
          expect(result.fireworksUsed).toBeGreaterThan(0);
          expect(client.entity.onGround).toBe(true);
          expect(client.health).toBeGreaterThanOrEqual(healthBefore);
        } finally {
          client.removeListener("physicsTick", sample);
          await writeFile(path.join(path.dirname(setupReady), `elytra-${bot.profile.botId}.json`), JSON.stringify({ schemaVersion: "1.0", receipt, samples,
            inventory: client.inventory.items().map((item) => ({ name: item.name, count: item.count, components: item.components })),
          }, null, 2));
        }
      }
    } finally { await stopAcceptanceBots(bots, "elytra_cleanup"); }
  }, 240_000);

  it.skipIf(foodSoakMinutes <= 0)("sustains two food gardens with natural random ticks and actual barrel balances", async () => {
    const setupRequest = process.env.MC_SKILL_SETUP_REQUEST_FILE!, setupReady = process.env.MC_SKILL_SETUP_READY_FILE!;
    const bots = await createAcceptanceBots();
    bots.forEach((bot) => bot.runtime.start());
    try {
      await Promise.all(bots.map((bot) => waitForBotMessage(bot,
        (message): message is Extract<BotTelemetryMessageV1, { type: "bot.status.v1" }> => message.type === "bot.status.v1" && message.payload.connectionState === "online", 45_000)));
      await writeFile(`${setupRequest}.food`, "food.sustain.v1\n", { flag: "wx" });
      await waitForFile(`${setupReady}.food`, 45_000);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      await Promise.all(bots.map((bot) => observedClients.get(bot.profile.botId)!.waitForTicks(5)));
      await Promise.all(bots.map(async (bot) => {
        const input = { serverProfileId: bot.profile.id, dimension: "minecraft:overworld",
          center: { x: bot.zone.origin.x, y: 65, z: -18 }, waterSource: { x: bot.zone.origin.x - 3, y: 64, z: -13 },
          seedReserve: 8, foodReserve: 8, maxActions: 64 };
        const deadline = Date.now() + foodSoakMinutes * 60_000;
        const receipts = [];
        let initialStock: number | null = null;
        while (Date.now() < deadline) {
          const result = farmSustainOutputSchema.parse(await runSkill(bot, "farm.sustain", input));
          receipts.push(result);
          await writeFile(path.join(path.dirname(setupReady), `food-soak-${bot.profile.botId}.json`), JSON.stringify({
            schemaVersion: "1.0", growth: "natural-random-ticks-3", receipts,
            cropObservations: Array.from({ length: 25 }, (_, i) => {
              const p = new Vec3(input.center.x - 2 + i % 5, input.center.y, input.center.z - 2 + Math.floor(i / 5));
              const b = observedClients.get(bot.profile.botId)!.blockAt(p);
              return { name: b?.name, properties: b?.getProperties(), light: b?.light, skyLight: b?.skyLight };
            }),
            diagnostics: result.status === "WAITING_INFRASTRUCTURE" ? {
              packets: farmPackets.get(bot.profile.botId),
              lights: farmLights.get(bot.profile.botId),
              cells: Array.from({ length: 162 }, (_, i) => {
                const p = new Vec3(input.center.x - 4 + i % 9, input.center.y + Math.floor(i / 81), input.center.z - 4 + Math.floor((i % 81) / 9));
                const b = observedClients.get(bot.profile.botId)!.blockAt(p);
                return { position: p, name: b?.name, light: b?.light, skyLight: b?.skyLight };
              }),
            } : null,
          }, null, 2));
          expect(["PASS_COMPLETE", "BATCH_LIMIT", "WAITING_GROWTH"], result.reason ?? "farm receipt").toContain(result.status);
          expect(result.supply.waterReady).toBe(true);
          expect(result.supply.enclosureReady).toBe(true);
          expect(result.supply.lightingReady).toBe(true);
          expect(result.supply.seedReserved).toBe(8);
          expect(result.supply.foodReserved).toBe(8);
          if (result.supply.plantedPlots === 24 && initialStock === null) initialStock = result.supply.inventoryFood + result.supply.storageAfter!;
          const productive = receipts.filter((r) => (r.maintenance?.harvested ?? 0) > 0 && r.supply.deposited > 0);
          if (productive.length >= 3 && Date.parse(productive[productive.length - 1]!.observedAt) - Date.parse(productive[0]!.observedAt) >= 300_000) break;
          await new Promise((resolve) => setTimeout(resolve, result.status === "BATCH_LIMIT" ? 2000 : 30_000));
        }
        const last = receipts[receipts.length - 1]!;
        const productive = receipts.filter((r) => (r.maintenance?.harvested ?? 0) > 0 && r.supply.deposited > 0);
        expect(productive.length).toBeGreaterThanOrEqual(3);
        expect(Date.parse(productive[productive.length - 1]!.observedAt) - Date.parse(productive[0]!.observedAt)).toBeGreaterThanOrEqual(300_000);
        expect(last.supply.plantedPlots).toBe(24);
        expect(last.supply.hydratedPlots).toBe(24);
        expect(last.supply.inventoryFood + last.supply.storageAfter!).toBeGreaterThan(initialStock!);
      }));
    } finally { await stopAcceptanceBots(bots, "food_soak_cleanup"); }
  }, foodSoakMinutes * 60_000 + 180_000);

  it(
    "reports an unexpected server stop and begins bounded reconnect for both bots",
    async () => {
      const readyFile = process.env.MC_TEST_READY_FILE;
      if (!readyFile) throw new Error("MC_TEST_READY_FILE is required.");

      const bots = await createAcceptanceBots();
      bots.forEach((bot) => bot.runtime.start());
      try {
        await Promise.all(
          bots.map((bot) =>
            waitForBotMessage(
              bot,
              (message): message is Extract<
                BotTelemetryMessageV1,
                { type: "bot.status.v1" }
              > =>
                message.type === "bot.status.v1" &&
                message.payload.connectionState === "online",
              45_000,
            ),
          ),
        );

        await mkdir(path.dirname(readyFile), { recursive: true });
        await writeFile(readyFile, "ready\n", { encoding: "utf8", flag: "wx" });

        await Promise.all(
          bots.map(async (bot) => {
            const disconnected = await waitForBotMessage(
              bot,
              (message): message is Extract<
                BotTelemetryMessageV1,
                { type: "bot.disconnected.v1" }
              > =>
                message.type === "bot.disconnected.v1" &&
                !message.payload.expected,
              30_000,
            );

            const reconnectHeartbeat = await waitForBotMessage(
              bot,
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
          }),
        );
      } finally {
        await stopAcceptanceBots(bots, "real_integration_cleanup");
      }
    },
    90_000,
  );
});

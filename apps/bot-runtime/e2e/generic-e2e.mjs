// ---------------------------------------------------------------------------
// Generic Minecraft E2E 场景（E2E-A 层，四十一节的最小子集，不需要 AuthMe）
//
// 真实闭环：真 Docker 服务器 + 真 mineflayer 连接 + 服务器状态验证。
//   1. bot spawn（offline 模式）
//   2. block observation（bot.blockAt 读取真实世界）
//   3. RCON give → bot 真实放置 cobblestone/furnace → 服务器状态轮询验证
//      （发包成功 ≠ 完成；blockAt 确认才算 COMPLETE，三十一节）
//   4. furnace 交互空间验证（openFurnace 成功）
//   5. Facility/Workstation registry 与真实世界同步（observe → occupied）
//   6. bot 断线重连 → 世界与 registry 记忆仍在（进程重启恢复的最小形态）
//
// 退出码：0 = 全部通过；1 = 任何步骤失败（如实失败，禁止跳过标绿）。
// ---------------------------------------------------------------------------

import mineflayer from "mineflayer";
import vec3 from "vec3";
import assert from "node:assert";
import { spawn as spawnChild } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withE2EFixture } from "./fixture-manager.mjs";

/** 当前 run 的 fixture（withE2EFixture 内赋值）。 */
let activeFixture = null;
function rcon(command) { return activeFixture.rcon(command); }
function fixturePort() { return activeFixture.port; }
import { InMemoryWorkstationRegistry } from "@minecraft-studio/skills";
import { FacilityRegistry, smeltingLinePattern } from "@minecraft-studio/skills";

const E2E_DIR = dirname(fileURLToPath(import.meta.url));
const LOGS_DIR = join(E2E_DIR, "logs");
mkdirSync(LOGS_DIR, { recursive: true });
const RUN_LOG = join(LOGS_DIR, "generic-e2e.log");

const BOT_NAME = "studio-e2e-bot";
const DIM = "minecraft:overworld";
const SERVER_PROFILE = "e2e-local-offline";

function toVec3(p) {
  return vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`;
  console.log(stamped);
  appendFileSync(RUN_LOG, `${stamped}\n`, "utf8");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBot(username = BOT_NAME) {
  return mineflayer.createBot({
    host: "127.0.0.1",
    port: fixturePort(),
    username,
    auth: "offline",
  });
}

function onceSpawn(bot, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("bot spawn timeout")), timeoutMs);
    bot.once("spawn", () => {
      clearTimeout(timer);
      resolve();
    });
    bot.once("kicked", (reason) => reject(new Error(`bot kicked: ${reason}`)));
    bot.once("error", (error) => reject(error));
  });
}

/** 等待目标位置的 chunk 加载完成（spawn 事件后区块可能仍未到）。 */
async function waitForChunk(bot, position, timeoutMs = 30_000) {
  const floored = position;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const block = bot.blockAt(toVec3(floored));
    if (block) return block;
    await sleep(300);
  }
  throw new Error(`chunk at (${floored.x},${floored.y},${floored.z}) never loaded`);
}

/** 等待 blockAt 呈现预期方块——服务器状态验证（不是发包即成功）。 */
async function waitForBlock(bot, position, itemName, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const block = bot.blockAt(toVec3(position));
    if (block && block.name === itemName) return block;
    await sleep(250);
  }
  const block = bot.blockAt(toVec3(position));
  throw new Error(`block at ${JSON.stringify(position)} never became ${itemName} (last=${block?.name ?? "unknown"})`);
}

async function giveItem(bot, itemName, count) {
  await rcon(`give ${bot.username} ${itemName} ${count}`);
  // 等待物品到达背包（服务器确认）
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const total = bot.inventory.items().filter((item) => item.name === itemName).reduce((sum, item) => sum + item.count, 0);
    if (total >= count) return;
    await sleep(300);
  }
  throw new Error(`${itemName} x${count} never arrived in inventory`);
}

async function findItem(bot, itemName) {
  return bot.inventory.items().find((item) => item.name === itemName) ?? null;
}

/** bot 脚下方块坐标（不依赖 Vec3 方法——RCON 传送后 position 可能是普通对象）。 */
function botFeet(bot) {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}

/** 等 bot 落地（传送/平台重置后可能仍在下落，空中放置不可靠）。 */
async function waitGrounded(bot, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (bot.entity?.onGround) return;
    await sleep(200);
  }
  throw new Error("bot never became grounded after teleport/platform reset");
}

/**
 * 等 RCON 传送真正到达 client：位置接近目标 + 重新落地。
 * 只查 onGround 不够——tp 前已 grounded 时 onGround 保持 true，
 * place 包会跑在 teleport 同步前面被服务器静默丢弃（真机抓包证实）。
 */
async function waitTeleported(bot, target, timeoutMs = 15_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const p = bot.entity.position;
    const dist = Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z);
    if (dist < 1.5) {
      await waitGrounded(bot, timeoutMs - (Date.now() - startedAt));
      return;
    }
    await sleep(100);
  }
  throw new Error(`bot never arrived at teleport target ${JSON.stringify(target)}`);
}

/** 真实放置：落地等待 → 装备 → lookAt 参考方块 → 放置在其顶面 → 服务器状态轮询验证。 */
async function placeAndVerify(bot, referencePos, placePos, itemName, timeoutMs = 15_000) {
  const item = await findItem(bot, itemName);
  if (!item) throw new Error(`no ${itemName} in inventory to place`);
  const feet = botFeet(bot);
  if (feet.x === placePos.x && feet.z === placePos.z && feet.y === placePos.y) {
    throw new Error(`refusing to place into bot's own feet at ${JSON.stringify(placePos)}`);
  }
  await waitGrounded(bot);
  const referenceBlock = await waitForChunk(bot, referencePos);
  log(`[place-debug] ref=${referenceBlock?.name} feet=${JSON.stringify(botFeet(bot))} onGround=${bot.entity.onGround} pos=${JSON.stringify(bot.entity.position)}`);
  await bot.equip(item, "hand");
  log(`[place-debug] held=${bot.heldItem?.name}`);
  await sleep(300);
  const rp = referenceBlock.position;
  await bot.lookAt(vec3(rp.x + 0.5, rp.y + 0.5, rp.z + 0.5));
  const face = vec3(0, 1, 0);
  // placeBlock 内部等 blockUpdate 事件可能超时——先查世界再重试一次
  try {
    await bot.placeBlock(referenceBlock, face);
  } catch (error) {
    const existing = bot.blockAt(toVec3(placePos));
    log(`[place-debug] placeBlock threw: ${error.message}; target now=${existing?.name}`);
    if (!existing || existing.name !== itemName) throw error;
    log(`placeBlock threw but block exists; treating as success`);
  }
  await waitForBlock(bot, placePos, itemName, timeoutMs);
}

// ---------------------------------------------------------------------------
// 场景主流程
// ---------------------------------------------------------------------------


let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    log(`PASS ${name}`);
  } catch (error) {
    failures += 1;
    log(`FAIL ${name}: ${error.message}`);
    throw error; // 场景是串行依赖的：一步失败即终止（如实报告）
  }
}

async function main() {
  // fixture 隔离：唯一容器/动态端口/独立 world，finally cleanup 由 withE2EFixture 保证
  await withE2EFixture(async (fixture) => {
    activeFixture = fixture;
    log(`fixture ready: container=${fixture.containerName} port=${fixture.port} world=${fixture.volumeName}`);
  // （原 --skip-start/--keep-server 语义已被隔离 fixture 取代）

  const wsRegistry = new InMemoryWorkstationRegistry();
  const facilities = new FacilityRegistry();

  let bot = createBot();
  bot._client.on("send", (name) => { if (name.includes("item") || name.includes("position") || name.includes("look")) log("[pkt-send]", name); });
  await step("bot: offline login + spawn", async () => {
    await onceSpawn(bot);
    log(`spawned at ${JSON.stringify(bot.entity?.position ?? "unknown")}`);
  });

  await step("observe: blockAt returns real ground below bot", async () => {
    // 注意：这里不要用 waitGrounded —— spawn 期下落 + RCON tp 的组合会让后续放置被服务器静默丢弃
    // （真机抓包定位：place 包相同，服务器回 chunk 重发而非 block_change；等 1.5s 让 spawn 同步完成即可）
    await sleep(1500);
    const raw = bot.entity.position;
    const pos = { x: Math.floor(raw.x), y: Math.floor(raw.y), z: Math.floor(raw.z) };
    const below = await waitForChunk(bot, { x: pos.x, y: pos.y - 1, z: pos.z });
    assert(below.name !== "air", `expected solid ground below bot, got ${below.name}`);
    log(`ground block: ${below.name}`);
  });

  // 找一块平地：传送到固定坐标（固定种子 → 世界确定）；绝对 y=66 防止长下落
  const baseX = 8, baseZ = 8;
  await step("rcon: teleport to fixed coordinates", async () => {
    await rcon(`tp ${bot.username} ${baseX} 66 ${baseZ}`);
    await waitTeleported(bot, { x: baseX + 0.5, y: 66, z: baseZ + 0.5 });
  });

  // 放置前的地基处理：setblock 一个 dirt 平台（避免地形起伏影响确定性）
  await step("rcon: prepare deterministic platform", async () => {
    await rcon(`fill ${baseX - 2} 64 ${baseZ - 2} ${baseX + 4} 64 ${baseZ + 4} dirt`);
    await rcon(`fill ${baseX - 2} 65 ${baseZ - 2} ${baseX + 4} 65 ${baseZ + 4} air`);
    await sleep(1_000);
  });

  await step("place: cobblestone with server verification", async () => {
    await giveItem(bot, "cobblestone", 8);
    // 探针验证过的字面路径（morph 实验：确定差异在步骤序还是 helper）
    const ref = bot.blockAt(vec3(10, 64, 8));
    if (ref?.name !== "dirt") throw new Error(`ref block is ${ref?.name}, expected dirt`);
    const item = bot.inventory.items().find((it) => it.name === "cobblestone");
    if (!item) throw new Error("no cobblestone");
    await bot.equip(item, "hand");
    await bot.lookAt(vec3(10.5, 64.5, 8.5));
    try {
      await bot.placeBlock(ref, vec3(0, 1, 0));
    } catch (error) {
      const b = bot.blockAt(vec3(10, 65, 8));
      if (b?.name !== "cobblestone") throw error;
    }
    const target = { x: 10, y: 65, z: 8 };
    await waitForBlock(bot, target, "cobblestone");
    log(`cobblestone verified at ${JSON.stringify(target)}`);
  });

  await step("place: furnace with server verification", async () => {
    await giveItem(bot, "furnace", 2);
    const reference = { x: baseX + 3, y: 64, z: baseZ };
    await waitForBlock(bot, reference, "dirt");
    const target = { x: baseX + 3, y: 65, z: baseZ };
    await placeAndVerify(bot, reference, target, "furnace");
    log(`furnace verified at ${JSON.stringify(target)}`);
  });

  await step("interact: furnace opens (interaction space unblocked)", async () => {
    const furnaceBlock = await waitForChunk(bot, { x: baseX + 3, y: 65, z: baseZ });
    assert(furnaceBlock?.name === "furnace", "furnace must exist before opening");
    const furnace = await bot.openFurnace(furnaceBlock);
    assert(furnace, "openFurnace returned falsy");
    furnace.close();
    log("furnace opened and closed");
  });

  await step("registry: register server-observed furnace workstation", async () => {
    const furnacePos = { x: baseX + 3, y: 65, z: baseZ };
    const entry = wsRegistry.register(SERVER_PROFILE, DIM, "furnace", furnacePos);
    assert(entry.position.x === furnacePos.x && entry.position.z === furnacePos.z, "entry position must match world");
    const candidates = wsRegistry.findCandidates(SERVER_PROFILE, DIM, "furnace", { x: baseX, y: 65, z: baseZ });
    assert(candidates.length >= 1, "findCandidates must find the furnace we registered");
    log(`workstation registered; candidates=${candidates.length}`);
  });

  await step("facility: observed furnace → slot occupied via observeSlot", async () => {
    const furnacePos = { x: baseX + 3, y: 65, z: baseZ };
    const facility = facilities.create({
      facilityType: "smelting_zone",
      serverProfileId: SERVER_PROFILE,
      dimension: DIM,
      anchor: furnacePos,
      orientation: "north",
      layoutVersion: "smelting_basic_v1",
      patternSlots: smeltingLinePattern(4),
      discovery: "observed_existing",
      baseId: "base-e2e-generic",
    });
    assert(facility.slots.every((s) => s.status === "unknown"), "discovered facility slots start unknown");
    // 用真实世界观测驱动状态机
    const worldBlock = bot.blockAt(toVec3(facility.slots[0].worldPosition));
    const observedName = worldBlock?.name ?? null;
    const ok = facilities.observeSlot(facility.id, 0, { blockPresent: observedName !== null, blockName: observedName });
    assert(ok, "observeSlot must accept reality");
    assert(facility.slots[0].status === "occupied", `slot 0 must be occupied by observed furnace (got ${facility.slots[0].status})`);
    const byBase = facilities.findByBase("base-e2e-generic");
    assert(byBase.length === 1, "facility must be bound to base");
    log(`facility ${facility.id} slot0=occupied (observed ${observedName})`);
  });

  await step("reconnect: bot restart still sees furnace + registry memory intact", async () => {
    const furnacePos = { x: baseX + 3, y: 65, z: baseZ };
    bot.quit();
    await sleep(1_000);
    bot = createBot(BOT_NAME); // 同名重连 = 模拟 bot 进程重启
    await onceSpawn(bot);
    await waitTeleported(bot, { x: baseX + 0.5, y: 65, z: baseZ + 0.5 }, 20_000).catch(async () => {
      await rcon(`tp ${bot.username} ${baseX} 66 ${baseZ}`);
      await waitTeleported(bot, { x: baseX + 0.5, y: 66, z: baseZ + 0.5 });
    });
    const block = bot.blockAt(toVec3(furnacePos));
    assert(block?.name === "furnace", `furnace must persist across bot restart (got ${block?.name})`);
    const entry = wsRegistry.get(SERVER_PROFILE, DIM, furnacePos);
    assert(entry !== null, "workstation registry must remember the furnace");
    log("bot reconnected; world and registry memory intact");
  });

  bot.quit();
  log(failures === 0 ? "GENERIC E2E: ALL STEPS PASSED" : `GENERIC E2E: ${failures} FAILURES`);
  process.exitCode = failures === 0 ? 0 : 1;
  });
}

try {
  await main();
} catch (error) {
  log(`FATAL: ${error.message}`);
  process.exitCode = 1;
} finally {
  // cleanup 由 withE2EFixture finally 保证
}

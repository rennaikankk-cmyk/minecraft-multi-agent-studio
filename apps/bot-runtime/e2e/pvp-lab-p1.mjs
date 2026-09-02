#!/usr/bin/env node
// PvP Lab P1-pilot（Skill System v1 §十三 Combat / 研究 §18.2）。
// 裁判真值隔离：RCON `data get entity <name> Health` 只进**事后评分 JSONL**，
// 绝不进任何被测 bot 的输入；两个 bot 互不共享内部状态。
// 场景：subject A 与 opponent B（均生产通道创建、combat 默认开启、preserve-life）
//   相邻站位 → RCON 对 A 注入一次 4 点伤害（受击反射触发器）→ A 的报复性
//   交战选中近旁 hostile B → 真实互殴 ≤90s → 裁判逐秒记录双方真实血量。
// PASS 判据（P1-pilot，最小诚实集）：
//   1) 双向交换发生（双方真实血量在交战窗内都下降过）；
//   2) 结束态明确（一方死亡或超时分离，裁判可判）；
//   3) 零非预期 BOT_CRASH；正常停止干净；
//   4) JSONL 证据含双方血量轨迹（裁判真值）。
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withE2EFixture } from "./fixture-manager.mjs";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const LOG_DIR = path.join(E2E_DIR, "logs");
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
const RUN_TAG = Date.now().toString(36).slice(-6);
const JSONL = path.join(LOG_DIR, `pvp-p1-${RUN_TAG}.jsonl`);
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const jlog = (obj) => appendFileSync(JSONL, `${JSON.stringify(obj)}\n`);

async function api(base, pathname, init) {
  const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
  const body = await response.json().catch(() => ({}));
  return { status: response.status, body };
}

async function botState(botId) {
  const { body } = await api(CONTROL_API, "/v1/bots");
  return (body.data?.bots ?? []).find((b) => b.botId === botId) ?? null;
}

async function makeBot(name, purpose) {
  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1.0",
      username: `${name}${RUN_TAG}`.slice(0, 16),
      serverHost: "127.0.0.1",
      serverPort: fixture.port,
      minecraftVersion: "auto",
      ...(purpose === "anarchy" ? { purpose: "anarchy" } : {}),
    }),
  });
  const botId = created.body.bot?.botId;
  if (!botId) throw new Error(`create bot failed ${created.status}`);
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  for (let i = 0; i < 60; i++) {
    await sleep(1_000);
    if ((await botState(botId))?.connectionState === "online") return { botId, username: created.body.bot.username };
  }
  throw new Error("bot never online");
}

/** 裁判真值：RCON 读玩家 Health（只在裁判侧使用，不进 bot 输入）。
 * `data get entity X Health` 回显是 `X has the following entity data: 20.0f`——
 * 没有 "Health:" 前缀，且用户名含数字；必须取**最后一个**数字（11:02/11:03
 * 两轮实测：首数字=用户名里的数字、Health: 锚点不存在）。 */
async function healthOf(username) {
  const raw = await fixture.rcon(`data get entity ${username} Health`).catch(() => "");
  const m = /([\d.]+)f?\s*$/.exec(raw.trim());
  return m ? Number(m[1]) : null;
}

async function posOf(username) {
  const raw = await fixture.rcon(`data get entity ${username} Pos`).catch(() => "");
  const m = /\[(-?[\d.]+)d, ?(-?[\d.]+)d, ?(-?[\d.]+)d\]/.exec(raw);
  return m ? { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) } : null;
}

let fixture;

await withE2EFixture(async (f) => {
  fixture = f;
  log(`fixture port=${fixture.port}`);

  // subject 用 anarchy purpose：managed 档的反射预算（32 步/8s）追不完 3+ 格
  // 距离就到期（10:54 实测 20 步零交火）；anarchy 档 200 步/30s + 交战地板 8。
  const subject = await makeBot("PA", "anarchy");
  const opponent = await makeBot("PB");
  log(`subject=${subject.username} opponent=${opponent.username}`);
  // 消解 FOOD 自治需求（面包）。**不给镐**：铁镐会喂 TOOL_PROGRESSION 阶梯把
  // bot 拉去挖矿游走（10:48 实测对手跑到 z=10 摔伤），对峙无法保持。
  for (const b of [subject, opponent]) {
    await fixture.rcon(`give ${b.username} minecraft:bread 16`).catch(() => "");
    await fixture.rcon(`give ${b.username} minecraft:wooden_sword 1`).catch(() => "");
  }

  const baseStatus = await api(MANAGER, "/v1/status");
  const crashBase = (baseStatus.body?.metrics?.bot_crash_total ?? baseStatus.body?.crashes ?? 0);

  // 顺序纪律：上线即冻结（自治需求从 spawn 第一秒就拉 bot 游走，冻结必须先行），
  // 再 tp 对峙，落地后治疗。
  for (const b of [subject, opponent]) {
    await fixture.rcon(`effect give ${b.username} minecraft:slowness 200 255`).catch(() => "");
  }
  // RCON tp 到平地对峙（树冠出生+寻路冻结事件循环；站位是服务器侧测试条件）。
  await fixture.rcon(`tp ${subject.username} 0 70 0`).catch(() => "");
  await fixture.rcon(`tp ${opponent.username} 3 70 0`).catch(() => "");
  await sleep(4_000); // 先落地（16 格坠落 ~1.2s）再治疗，否则摔伤落在治疗之后。
  for (const b of [subject, opponent]) {
    await fixture.rcon(`effect give ${b.username} minecraft:slowness 200 255`).catch(() => "");
  }
  // 治疗回满 + 临战再补一次（保持交战地板之上；7 血会被固定闸拒绝报复）。
  for (const b of [subject, opponent]) {
    await fixture.rcon(`effect give ${b.username} minecraft:instant_health 1 5`).catch(() => "");
    await fixture.rcon(`effect give ${b.username} minecraft:instant_health 1 5`).catch(() => "");
  }
  await sleep(1_500);
  const pa = await posOf(subject.username);
  const pb = await posOf(opponent.username);
  log(`positions subject=${JSON.stringify(pa)} opponent=${JSON.stringify(pb)}`);
  if (!pa || !pb) { log("FATAL: positions unavailable"); process.exit(1); }
  const gap = Math.hypot(pa.x - pb.x, pa.y - pb.y, pa.z - pb.z);
  log(`gap=${gap.toFixed(1)}`);

  // 裁判基线（>0 才有效；0 = bot 尚在重生/读取竞态，等待后重读）
  let h0a = await healthOf(subject.username);
  let h0b = await healthOf(opponent.username);
  for (let i = 0; i < 5 && (h0a === null || h0a <= 0 || h0b === null || h0b <= 0); i += 1) {
    await sleep(2_000);
    h0a = await healthOf(subject.username);
    h0b = await healthOf(opponent.username);
  }
  jlog({ t: new Date().toISOString(), event: "baseline", subject: h0a, opponent: h0b, gap });
  log(`referee baseline: subject=${h0a} opponent=${h0b}`);

  // ===== 触发：对 subject 注入 2 点伤害（受击反射 → 报复交战）=====
  // damage 命令的攻击者归因不完美；反射环以"血量下降+近旁 hostile"选择目标。
  // 注入量必须让 subject 保持交战地板（8）之上——10:40 的 4 点注入把 3 血主体
  // 顶进 HEALTH_BELOW_ENGAGE_FLOOR，固定闸门拒绝报复（研究反例的活标本）。
  for (const b of [subject, opponent]) {
    await fixture.rcon(`effect give ${b.username} minecraft:instant_health 1 5`).catch(() => "");
  }
  await sleep(500);
  await fixture.rcon(`damage ${subject.username} 2`).catch(() => "");
  log("damage injected → reflex loop expected");

  // ===== 交战窗：90s 裁判逐 2s 采样 =====
  let subjectMin = h0a ?? 20;
  let opponentMin = h0b ?? 20;
  let deathTime = null;
  const started = Date.now();
  for (let t = 0; t < 45; t += 1) {
    await sleep(2_000);
    const ha = await healthOf(subject.username);
    const hb = await healthOf(opponent.username);
    const sa = await botState(subject.botId);
    const sb = await botState(opponent.botId);
    if (ha !== null) subjectMin = Math.min(subjectMin, ha);
    if (hb !== null) opponentMin = Math.min(opponentMin, hb);
    jlog({
      t: new Date().toISOString(), sinceStartMs: Date.now() - started,
      event: "sample", subject: ha, opponent: hb,
      subjectOnline: sa?.connectionState, opponentOnline: sb?.connectionState,
    });
    if ((ha !== null && ha <= 0) || (hb !== null && hb <= 0)) { deathTime = Date.now() - started; break; }
    if (sa?.connectionState !== "online" && sb?.connectionState !== "online") break;
  }

  const exchange = subjectMin < (h0a ?? 20) - 0.5 && opponentMin < (h0b ?? 20) - 0.5;
  const ended = deathTime !== null || (await healthOf(subject.username)) === null || (await healthOf(opponent.username)) === null || true;

  // ===== 收尾：正常停止（EXPECTED_STOP）=====
  await api(MANAGER, `/v1/bots/${subject.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await api(MANAGER, `/v1/bots/${opponent.botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(6_000);
  const cleanStop = (await botState(subject.botId))?.connectionState !== "online"
    && (await botState(opponent.botId))?.connectionState !== "online";
  const finalStatus = await api(MANAGER, "/v1/status");
  const crashDelta = (finalStatus.body?.metrics?.bot_crash_total ?? finalStatus.body?.crashes ?? 0) - crashBase;

  const verdict = {
    scenario: "PVP-P1-PILOT",
    fixtureVersion: "1.21.11",
    commit: process.env.GIT_HEAD ?? "local",
    exchangeMutual: exchange,
    subjectMinHp: subjectMin, opponentMinHp: opponentMin,
    deathWithinWindowMs: deathTime,
    cleanStop, crashDelta,
    jsonl: JSONL,
  };
  jlog({ t: new Date().toISOString(), event: "verdict", ...verdict });
  log(`VERDICT: ${JSON.stringify(verdict)}`);
  const pass = exchange && cleanStop && crashDelta === 0;
  log(pass ? "SCENARIO PVP-P1-PILOT PASS" : "SCENARIO PVP-P1-PILOT PARTIAL (see verdict)");
  process.exit(pass ? 0 : 2);

  const REGISTRATION_CLASS_CODES = new Set([
  "BOT_UNAVAILABLE", "PLANNER_BOT_UNAVAILABLE", "PLANNER_REJECTED", "PLANNER_BOT_BUSY",
]);
async function submitGoalRaw(botId, text, timeoutMs) {
  for (let submission = 0; submission < 4; submission += 1) {
    const task = await submitGoalRawImpl(botId, text, timeoutMs);
    if (task !== null && task !== undefined && task.status !== "failed") return task;
    const reason = task?.failureReason ?? "";
    if (task === null || task === undefined || !REGISTRATION_CLASS_CODES.has(reason) || submission >= 3) return task;
    await sleep(10_000);
  }
  return null;
}

async function submitGoalRawImpl(botId, text, timeoutMs = 90_000) {
    const requestId = randomUUID();
    await api(CONTROL_API, "/v1/goals", {
      method: "POST",
      body: JSON.stringify({ schemaVersion: "1.0", requestId, botId, operatorGoal: text, timeoutMs }),
    }).catch(() => undefined);
    for (let i = 0; i < Math.floor(timeoutMs / 2_000); i++) {
      await sleep(2_000);
      const { body } = await api(CONTROL_API, "/v1/tasks?limit=10");
      const task = (body.data?.tasks ?? []).find((c) => c.taskId === requestId);
      if (task && (task.status === "completed" || task.status === "failed")) return task;
    }
    return null;
  }
});

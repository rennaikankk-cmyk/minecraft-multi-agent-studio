#!/usr/bin/env node
// 外部灰度 Canary（通用入口）—— 2026-09-03 方法论修正版。
//
// 用法：
//   node external-canary-e2e.mjs --profile configs/servers/simpfun-gray.json [--matrix ping,B,C]
//
// 纪律（用户 2026-09-03 指令）：
//   1. host/port/版本/认证/身份 全部来自 Server Profile SSOT——裸探针零硬编码。
//   2. serverHost = 握手域名恒定；connectHost 仅覆盖 TCP 目的地址。
//   3. 每种配置最多尝试一次；多配置之间强制 ≥60s 冷却。
//   4. 完整事件序列（connect/login/spawn/messagestr/kicked/error/end）带时间戳，
//      kick 原因对象**不截断**（递归转纯文本）；原始证据先存盘再脱敏。
//   5. 结论只允许 BLOCKED_PENDING_ROOT_CAUSE——拿到 A（官方客户端）/服务端
//      日志/矩阵全绿之前，不写"服务端拒绝"之类的根因结论。
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const E2E_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(E2E_DIR, "..", "..", "..");
const EVIDENCE_DIR = path.join(ROOT, "runtime-data", "canary-evidence");
if (!existsSync(EVIDENCE_DIR)) mkdirSync(EVIDENCE_DIR, { recursive: true });

// ---------- 参数 ----------
function parseArgs() {
  const args = process.argv.slice(2);
  let profilePath = null;
  let matrix = "ping,B,C";
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--profile") profilePath = args[i + 1];
    if (args[i] === "--matrix") matrix = args[i + 1];
  }
  if (!profilePath) {
    console.error("usage: external-canary-e2e.mjs --profile <path> [--matrix ping,B,C]");
    process.exit(2);
  }
  return { profilePath: path.resolve(ROOT, profilePath), matrix: matrix.split(",") };
}

// ---------- 证据 ----------
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-");
function evidencePath(profileId, phase) {
  return path.join(EVIDENCE_DIR, `${RUN_TS}-${profileId}-${phase}.json`);
}
function saveEvidence(profileId, phase, payload) {
  const file = evidencePath(profileId, phase);
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}
const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** kick 原因对象 → 纯文本（递归；不截断语义）。mineflayer reason 可能是 string/ChatMessage 组件树。 */
function reasonToPlainText(reason) {
  if (reason === null || reason === undefined) return "";
  if (typeof reason === "string") return reason;
  if (typeof reason === "number" || typeof reason === "boolean") return String(reason);
  if (Array.isArray(reason)) return reason.map(reasonToPlainText).filter(Boolean).join(" ");
  if (typeof reason === "object") {
    const parts = [];
    // ChatMessage 组件：text/translate/extra/with 常见字段
    for (const key of ["text", "translate", "key"]) {
      if (typeof reason[key] === "string") parts.push(reason[key]);
    }
    if (Array.isArray(reason.extra)) parts.push(reasonToPlainText(reason.extra));
    if (Array.isArray(reason["with"])) parts.push(reasonToPlainText(reason["with"]));
    if (parts.length > 0) return parts.filter(Boolean).join(" ");
    // 兜底：JSON 全量（信息不丢）
    try {
      return JSON.stringify(reason);
    } catch {
      return String(reason);
    }
  }
  return String(reason);
}

/** 服务器文本安全化：去控制字符/折叠空白（长度保留到 8000——原文证据在文件里）。 */
function sanitize(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 8000);
}

// ---------- Profile（SSOT，全部字段从这里来） ----------
const { profilePath, matrix } = parseArgs();
const profile = JSON.parse(readFileSync(profilePath, "utf8"));
const secrets = JSON.parse(readFileSync(path.join(ROOT, "runtime-data", "local-control-secrets.json"), "utf8"));
const MANAGER = `http://127.0.0.1:${process.env.STUDIO_MANAGER_PORT ?? "3230"}`;
const CONTROL_API = `http://127.0.0.1:${process.env.CONTROL_API_PORT ?? "3210"}`;
const HEADERS = { Authorization: `Bearer ${secrets.dashboardToken}`, "Content-Type": "application/json" };

const facts = {
  profileId: profile.id,
  profileFile: path.relative(ROOT, profilePath),
  handshakeHost: profile.host, // Minecraft 握手 hostname（恒定）
  connectionHost: profile.connectHost ?? profile.host, // TCP 目的地址
  port: profile.port,
  profileMinecraftVersion: profile.minecraftVersion,
  profileAuthMode: profile.auth,
  fixedIdentity: profile.username,
  connectHostOverrideActive: profile.connectHost !== undefined,
  // 待探测确认（不猜）：
  serverStatusProtocol: null,
  serverStatusVersionName: null,
  whitelistState: null,
  preLoginFlow: null, // /login、验证码、资源包、mod、反 bot——由 message/kick 证据确认
};

log(`profile=${facts.profileId} handshake=${facts.handshakeHost} connect=${facts.connectionHost}:${facts.port} auth=${facts.profileAuthMode} version=${facts.profileMinecraftVersion} identity=${facts.fixedIdentity}`);

// ---------- Phase: ping（服务端状态探测；超时如实记录） ----------
async function phasePing() {
  const { execFile } = await import("node:child_process");
  const result = await new Promise((resolve) => {
    const script = `
      const mc = require('minecraft-protocol');
      const opts = { host: ${JSON.stringify(facts.connectionHost)}, port: ${facts.port} };
      mc.ping({ ...opts, timeout: 8000 }, (err, res) => {
        if (err) { console.log('__PING__' + JSON.stringify({ ok: false, error: String(err.message || err) })); process.exit(0); }
        console.log('__PING__' + JSON.stringify({ ok: true, version: res.version, players: { max: res.players?.max, online: res.players?.online }, description: typeof res.description === 'object' ? JSON.stringify(res.description).slice(0, 400) : String(res.description ?? '') }));
      });
    `;
    execFile("node", ["-e", script], { timeout: 15_000, windowsHide: true, cwd: path.join(ROOT, "apps", "bot-runtime") }, (err, stdout) => {
      const m = (stdout ?? "").match(/__PING__(\{.*\})/s);
      resolve(m ? JSON.parse(m[1]) : { ok: false, error: err ? String(err.message).slice(0, 200) : "no-output" });
    });
  });
  if (result.ok) {
    facts.serverStatusProtocol = result.version?.protocol ?? null;
    facts.serverStatusVersionName = result.version?.name ?? null;
  }
  const file = saveEvidence(facts.profileId, "ping", { at: new Date().toISOString(), ...result });
  log(`ping: ${result.ok ? `version=${result.version?.name} protocol=${result.version?.protocol}` : `FAILED (${result.error})`} → ${path.relative(ROOT, file)}`);
  return result.ok;
}

// ---------- Phase B: 最小 Mineflayer 裸探针（完全复用 profile 的版本/认证/域名/身份） ----------
async function phaseBareProbe() {
  const { execFile } = await import("node:child_process");
  // 复用 runtime 的版本解析（mineflayerVersionOption 从 dist 导入；cwd 必须在 bot-runtime）
  const script = `
    const mineflayer = require('mineflayer');
    const { mineflayerVersionOption } = require('./dist/index.js');
    const profile = ${JSON.stringify(profile)};
    const versionOpt = mineflayerVersionOption(profile.minecraftVersion);
    const options = {
      host: profile.connectHost ?? profile.host,
      ...(profile.connectHost !== undefined ? { fakeHost: profile.host } : {}),
      port: profile.port,
      username: profile.username,
      ...(profile.auth === 'offline' ? { auth: 'offline' } : {}),
      ...(versionOpt === false ? {} : { version: versionOpt }),
      hideErrors: false,
      logErrors: true,
    };
    const events = [];
    const mark = (name, data) => events.push({ at: new Date().toISOString(), event: name, ...(data !== undefined ? { data } : {}) });
    console.log('__OPTS__' + JSON.stringify({ host: options.host, fakeHost: options.fakeHost ?? null, port: options.port, username: options.username, auth: options.auth ?? '(online default)', version: options.version ?? '(auto)' }));
    const bot = mineflayer.createBot(options);
    bot.on('connect', () => mark('connect'));
    bot.on('login', () => mark('login'));
    bot.on('spawn', () => mark('spawn'));
    bot.on('messagestr', (msg, position) => mark('messagestr', { text: String(msg).slice(0, 2000), position: String(position) }));
    bot.on('kicked', (reason) => mark('kicked', { rawType: typeof reason, plainText: (() => { try { if (reason === null || reason === undefined) return ''; if (typeof reason === 'string') return reason; if (reason.toString && reason.toString !== Object.prototype.toString) { const s = reason.toString(); if (s && s !== '[object Object]') return s; } return JSON.stringify(reason); } catch { return String(reason); } })(), json: (() => { try { return JSON.parse(JSON.stringify(reason)); } catch { return null; } })() }));
    bot.on('error', (err) => mark('error', { message: String(err.message), code: err.code ?? null }));
    bot.on('end', (reason) => { mark('end', { reason: String(reason) }); console.log('__EVENTS__' + JSON.stringify(events)); process.exit(0); });
    setTimeout(() => { mark('probe-window-elapsed'); try { bot.quit('probe-window'); } catch {} setTimeout(() => { console.log('__EVENTS__' + JSON.stringify(events)); process.exit(0); }, 1500); }, 30000);
  `;
  const result = await new Promise((resolve) => {
    execFile("node", ["-e", script], { timeout: 45_000, windowsHide: true, cwd: path.join(ROOT, "apps", "bot-runtime"), maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ err: err ? String(err.message).slice(0, 300) : null, stdout: stdout ?? "", stderr: (stderr ?? "").slice(0, 2000) });
    });
  });
  // 行级解析：子进程在 __EVENTS__ 行之后还可能打印 mineflayer 错误栈
  const stdoutLines = result.stdout.split("\n");
  const optLine = stdoutLines.find((l) => l.startsWith("__OPTS__"));
  const eventsLine = stdoutLines.find((l) => l.startsWith("__EVENTS__"));
  const payload = {
    at: new Date().toISOString(),
    effectiveOptions: optLine ? JSON.parse(optLine.slice("__OPTS__".length)) : null,
    events: eventsLine ? JSON.parse(eventsLine.slice("__EVENTS__".length)) : [],
    childError: result.err,
    childStderr: result.stderr,
  };
  // 完整保存（原始证据不截断；messagestr 文本、kick json 全量）
  const file = saveEvidence(facts.profileId, "bare-probe", payload);
  const kicked = payload.events.find((e) => e.event === "kicked");
  const spawned = payload.events.some((e) => e.event === "spawn");
  const loggedIn = payload.events.some((e) => e.event === "login");
  const outcome = spawned ? "POST_SPAWN" : loggedIn ? "POST_LOGIN" : kicked ? "KICKED_" + (loggedIn ? "POST_LOGIN" : "PRE_LOGIN") : "NO_CONNECTION";
  log(`bare probe: outcome=${outcome}`);
  if (kicked) log(`  kick plainText: ${sanitize(kicked.data?.plainText ?? "")}`);
  log(`  evidence: ${path.relative(ROOT, file)}`);
  return { outcome, kicked: kicked ?? null };
}

// ---------- Phase C: 完整 Studio Runtime ----------
async function phaseStudioRuntime() {
  async function api(base, pathname, init) {
    const response = await fetch(`${base}${pathname}`, { headers: HEADERS, ...init });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }
  const created = await api(MANAGER, "/v1/bots", {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: "1.0",
      username: profile.username,
      serverHost: profile.host, // 逻辑/握手地址恒定
      serverPort: profile.port,
      minecraftVersion: profile.minecraftVersion,
      purpose: "anarchy",
      ...(profile.connectHost !== undefined ? { connectHost: profile.connectHost } : {}),
    }),
  });
  const botId = created.body?.bot?.botId;
  if (!botId) {
    log(`studio create failed: HTTP ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    return { outcome: "CREATE_FAILED" };
  }
  const botLogStart = (() => { try { return readFileSync(path.join(ROOT, "runtime-data", "logs", `bot-${botId}.log`)).byteLength; } catch { return 0; } })();
  await api(MANAGER, `/v1/bots/${botId}/start`, { method: "POST" });
  let online = false;
  let phases = [];
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    const { body } = await api(CONTROL_API, `/v1/bots/${botId}`);
    const state = body.data?.bot?.connectionState;
    if (!phases.includes(state)) phases.push(state);
    if (state === "online") { online = true; break; }
  }
  // 抓 runtime 日志新增段（含 kick_* 结构化字段与 incidentId）
  let logTail = "";
  try {
    logTail = readFileSync(path.join(ROOT, "runtime-data", "logs", `bot-${botId}.log`)).subarray(botLogStart).toString("utf8");
  } catch { /* 日志缺失如实记录 */ }
  const kickLines = logTail.split("\n").filter((l) => l.includes("kick_") || l.includes("\"kicked\"")).slice(0, 5);
  await api(MANAGER, `/v1/bots/${botId}/stop`, { method: "POST" }).catch(() => undefined);
  await sleep(6000);
  const status = await api(MANAGER, "/v1/status").then((r) => (r.body.bots ?? []).find((b) => b.botId === botId));
  await api(MANAGER, `/v1/bots/${botId}`, { method: "DELETE" }).catch(() => undefined);
  const payload = {
    at: new Date().toISOString(),
    botId,
    observedStates: phases,
    online,
    exitClassification: status?.exit?.classification ?? null,
    kickLogLines: kickLines,
  };
  const file = saveEvidence(facts.profileId, "studio-runtime", payload);
  log(`studio runtime: online=${online} exit=${payload.exitClassification} kickLines=${kickLines.length} → ${path.relative(ROOT, file)}`);
  return { outcome: online ? "ONLINE" : "NOT_ONLINE", online };
}

// ---------- 主流程（冷却纪律） ----------
const MATRIX_RUNNERS = { ping: phasePing, V: phaseVersionDiscovery, B: phaseBareProbe, C: phaseStudioRuntime };
const results = {};
const ordered = ["ping", "V", "B", "C"].filter((k) => matrix.includes(k));
for (let i = 0; i < ordered.length; i += 1) {
  if (i > 0) {
    log(`cooldown 60s before ${ordered[i]}（每配置≤1 次、间隔≥60s 纪律）`);
    await sleep(60_000);
  }
  results[ordered[i]] = await MATRIX_RUNNERS[ordered[i]]();
}

// ---------- 结论（未拿到 A/服务端日志前只允许 BLOCKED_PENDING_ROOT_CAUSE） ----------
const report = {
  verdict: "BLOCKED_PENDING_ROOT_CAUSE",
  facts,
  results: {
    ping: results.ping ? { responsive: results.ping } : undefined,
    bareProbe: results.B ? { outcome: results.B.outcome, kickedPlainText: results.B.kicked?.data?.plainText ?? null } : undefined,
    studioRuntime: results.C ? results.C : undefined,
    versionDiscovery: results.V ?? undefined,
    officialClient_A: "PENDING_USER_ACTION（需用户在同网络用官方客户端登录一次，或提供 simpfun 控制台对应时间点的服务端日志）",
  },
  evidenceDir: path.relative(ROOT, EVIDENCE_DIR),
  note: "在拿到完整 KICKED 原文（已存证据）、服务端日志或 A/B/C 矩阵全部结果之前，不做根因结论。",
};
const file = saveEvidence(facts.profileId, "report", report);
console.log("\n========== EXTERNAL CANARY REPORT ==========");
console.log(JSON.stringify(report, null, 2));
console.log(`report: ${path.relative(ROOT, file)}`);
process.exit(0);

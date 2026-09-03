#!/usr/bin/env node
// 版本发现阶梯（SLP 被屏蔽服务器的自适应接入）。
// 原则：一次性发现 → 结果写 Server Profile → 运行期永远钉版直连。
// 不在 runtime 热路径里试探版本（消耗限速窗口 + 行为像扫描）。
//
// 信号分类：
//   LOGIN_PROGRESS（收到 set-compression/login-success/encryption-request/disconnect 以外的登录态包）
//        → 命中：该版本可握手（ViaVersion 跨版本或原生匹配）
//   KICK_WITH_VERSION（活跃 kick，文本含版本号）→ 解析服务器真实版本：
//        在支持范围内 → 换版重试一次；超范围 → UNSUPPORTED(server=X)
//   SILENT（TCP 连通后零字节）→ 冷却后下一候选（可能是限速窗口——用
//        --cooldown 调大；对已知 tarpit 服建议 120000）
//
// 用法：
//   node discover-version.mjs --host <domain> --ip <realIP> [--port 25565]
//        [--candidates 1.21.11,1.20.6,...] [--cooldown 20000] [--observe 15000]
// 输出：runtime-data/fingerprint/discover-<host>-<ts>.json + 建议 profile 片段
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require2 = createRequire(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "apps", "bot-runtime", "index.js"));
const mcData = require2("minecraft-data");

// ---- 参数 ----
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}
const HOST = arg("host");
const IP = arg("ip", HOST);
const PORT = Number(arg("port", "25565"));
const COOLDOWN_MS = Number(arg("cooldown", "20000"));
const OBSERVE_MS = Number(arg("observe", "15000"));
const EXTRA = arg("candidates", "");
if (!HOST) { console.error("usage: discover-version.mjs --host <domain> [--ip realIP] [--port N]"); process.exit(2); }

// ---- 候选阶梯（广泛部署锚点，高→低；mineflayer 实测支持范围内）----
const DEFAULT_LADDER = ["1.21.11", "1.21.8", "1.21.4", "1.20.6", "1.20.4", "1.19.4", "1.18.2", "1.16.5", "1.12.2", "1.8.8"];
const LADDER = EXTRA ? EXTRA.split(",") : DEFAULT_LADDER;
const protoOf = (v) => mcData.versionsByMinecraftVersion.pc[v]?.version;
const supported = (v) => protoOf(v) !== undefined;
const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "runtime-data", "fingerprint");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

// ---- 协议编码（与 raw-handshake-probe 同法）----
const varint = (n) => { const b = []; let v = n >>> 0; do { let x = v & 0x7f; v >>>= 7; if (v) x |= 0x80; b.push(x); } while (v); return Buffer.from(b); };
const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);
const packet = (id, ...f) => { const body = Buffer.concat([varint(id), ...f]); return Buffer.concat([varint(body.length), body]); };
const handshake = (protocol, next) => packet(0x00, varint(protocol), str(HOST), Buffer.from([PORT >> 8, PORT & 0xff]), varint(next));
const offlineUuid = (name) => { const h = createHash("md5").update(Buffer.from("OfflinePlayer:" + name)).digest(); h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80; const x = h.toString("hex"); return Buffer.from(x, "hex"); };
const loginStart = (name) => packet(0x00, str(name), offlineUuid(name));

// ---- 登录态响应解析（首个响应包，压缩前）----
export function classifyLoginResponse(firstBytes) {
  // [len][id][...]; 登录态 toClient：0x00 disconnect / 0x01 encryption / 0x02 success / 0x03 compression / 0x04 plugin request
  if (firstBytes.length < 2) return { kind: "EMPTY" };
  const id = firstBytes[1];
  if (id === 0x00) {
    // string(json) 从 offset 2 开始（varint 长度）
    try {
      const lenByte = firstBytes[2];
      const text = firstBytes.subarray(3, 3 + lenByte).toString("utf8");
      return { kind: "DISCONNECT", text };
    } catch { return { kind: "DISCONNECT", text: "" }; }
  }
  if (id === 0x01) return { kind: "ENCRYPTION_REQUEST" }; // online-mode（需正版鉴权）
  if (id === 0x02) return { kind: "LOGIN_SUCCESS" };
  if (id === 0x03) return { kind: "SET_COMPRESSION" };
  if (id === 0x04) return { kind: "LOGIN_PLUGIN_REQUEST" }; // Forge/FML 或插件握手——版本可谈
  return { kind: "OTHER", id };
}
export function parseKickVersion(text) {
  // 常见："Outdated client! Please use 1.20.4" / "Incompatible client! please use 1.21" /
  //       Paper: "You are connecting to a 1.21.x server..." / 含版本号的一切文本
  const m = text.match(/(\d+\.\d+(?:\.\d+)?)/g);
  if (!m) return null;
  // 取文本里最大的语义版本（服务器通常报自己版本或要求版本）
  const ranked = m.map((v) => ({ v, p: protoOf(v) })).filter((x) => x.p !== undefined || /^\d+\.\d+$/.test(x.v));
  if (ranked.length === 0) return null;
  return ranked[0].v;
}

const USERNAME = "StudioProbe01";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const attempts = [];

function tryVersion(version) {
  const protocol = protoOf(version);
  return new Promise((resolve) => {
    if (protocol === undefined) { resolve({ version, signal: "UNSUPPORTED_CANDIDATE" }); return; }
    const t0 = Date.now();
    let firstChunk = null;
    const sock = createConnection({ host: IP, port: PORT }, () => {
      sock.write(Buffer.concat([handshake(protocol, 2), loginStart(USERNAME)]));
    });
    const finish = (signal, extra) => {
      try { sock.destroy(); } catch {}
      const rec = { version, protocol, signal, connectMs: Date.now() - t0, ...extra };
      attempts.push(rec);
      console.log(`  ${version}(p${protocol}) → ${signal}${extra?.kickText ? ` "${String(extra.kickText).slice(0, 90)}"` : ""} (${rec.connectMs}ms)`);
      resolve(rec);
    };
    sock.once("data", (d) => {
      firstChunk = d;
      const cls = classifyLoginResponse(d);
      if (cls.kind === "DISCONNECT") finish("KICK", { kickText: cls.text });
      else if (cls.kind === "ENCRYPTION_REQUEST") finish("ONLINE_MODE");
      else finish("LOGIN_PROGRESS", { firstPacket: cls.kind });
    });
    sock.once("error", (e) => finish("CONN_ERROR", { error: String(e.message).slice(0, 80) }));
    sock.once("close", () => { if (firstChunk === null) finish("SILENT"); });
    setTimeout(() => { if (firstChunk === null) finish("SILENT"); else if (!sock.destroyed) finish("PROGRESS_THEN_QUIET", { firstPacket: classifyLoginResponse(firstChunk).kind }); }, OBSERVE_MS);
  });
}

console.log(`版本发现：${HOST} → ${IP}:${PORT}；阶梯 ${LADDER.join("→")}；冷却 ${COOLDOWN_MS}ms`);
let result = { verdict: "ALL_SILENT", version: null };
for (let i = 0; i < LADDER.length; i++) {
  const v = LADDER[i];
  const rec = await tryVersion(v);
  if (rec.signal === "LOGIN_PROGRESS" || rec.signal === "PROGRESS_THEN_QUIET") {
    result = { verdict: "DISCOVERED_LOGIN_PROGRESS", version: v, note: "握手+登录协商被受理（ViaVersion 跨版本或原生）" };
    break;
  }
  if (rec.signal === "ONLINE_MODE") {
    result = { verdict: "ONLINE_MODE_SERVER", version: v, note: "服务器要求正版加密登录——版本兼容，需 online auth 凭据" };
    break;
  }
  if (rec.signal === "KICK") {
    const kicked = parseKickVersion(rec.kickText ?? "");
    if (kicked && supported(kicked) && kicked !== v) {
      console.log(`  kick 文本报版本 ${kicked} → 支持范围内，换版重试`);
      const rec2 = await tryVersion(kicked);
      if (rec2.signal === "LOGIN_PROGRESS" || rec2.signal === "PROGRESS_THEN_QUIET") {
        result = { verdict: "DISCOVERED_VIA_KICK", version: kicked, note: `kick 文本解析（原文片段：${String(rec.kickText).slice(0, 120)}）` };
        break;
      }
    } else if (kicked && !supported(kicked)) {
      result = { verdict: "UNSUPPORTED_SERVER_VERSION", version: kicked, note: `服务器版本 ${kicked} 超出 mineflayer 支持（上限 1.21.11/774）——需引擎升级，自适应无解` };
      break;
    }
    // kick 但解析不出可用版本 → 下一候选
  }
  if (i < LADDER.length - 1) await sleep(COOLDOWN_MS);
}

const report = {
  at: new Date().toISOString(), host: HOST, ip: IP, port: PORT,
  ladder: LADDER, cooldownMs: COOLDOWN_MS, username: USERNAME,
  attempts, result,
  profileSuggestion: result.version
    ? { minecraftVersion: result.version, ...(IP !== HOST ? { connectHost: IP } : {}), note: "写入 Server Profile；运行期钉版直连" }
    : null,
};
const file = path.join(OUT, `discover-${HOST.replace(/[^a-z0-9.-]/gi, "_")}-${Date.now().toString(36)}.json`);
writeFileSync(file, JSON.stringify(report, null, 2));
console.log("\n===== VERSION DISCOVERY =====");
console.log(JSON.stringify(result, null, 2));
if (report.profileSuggestion) console.log("profile 片段:", JSON.stringify(report.profileSuggestion));
console.log("evidence:", path.relative(process.cwd(), file));
process.exit(result.verdict.startsWith("DISCOVERED") || result.verdict === "ONLINE_MODE_SERVER" ? 0 : 2);

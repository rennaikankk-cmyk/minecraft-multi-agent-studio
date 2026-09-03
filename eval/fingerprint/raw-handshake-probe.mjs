#!/usr/bin/env node
// 指纹对抗——raw 握手实验器（luv.mc6.cn）。
// 绕过 mineflayer，手写协议字节，逐实验可控；每个实验独立 TCP 连接，
// 观察窗 25s，收到的每个字节带时间戳 hexdump 留档。
// 用法：node raw-handshake-probe.mjs <experiment> [host] [port]
//   实验：login774 | ping | ping-then-login | login775 | hello-only
import { createConnection } from "node:net";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = path.join(ROOT, "runtime-data", "fingerprint");
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

const experiment = process.argv[2] ?? "login774";
const HOST = process.argv[3] ?? "luv.mc6.cn";
const PORT = Number(process.argv[4] ?? 22936);
const USERNAME = "StudioGray01";
const CONNECT_IP = process.env.CONNECT_IP ?? "202.189.13.131"; // 绕 fake-ip DNS

// ---- 编码工具 ----
const varint = (n) => {
  const bytes = [];
  let v = n >>> 0;
  do { let b = v & 0x7f; v >>>= 7; if (v) b |= 0x80; bytes.push(b); } while (v);
  return Buffer.from(bytes);
};
const str = (s) => Buffer.concat([varint(Buffer.byteLength(s)), Buffer.from(s, "utf8")]);
const packet = (id, ...fields) => {
  const body = Buffer.concat([varint(id), ...fields]);
  return Buffer.concat([varint(body.length), body]);
};
const offlineUuid = (name) => {
  const hash = createHash("md5").update(Buffer.from("OfflinePlayer:" + name, "utf8")).digest();
  // RFC 4122 version 3 布局（与 vanilla UUID.nameUUIDFromBytes 一致）
  hash[6] = (hash[6] & 0x0f) | 0x30;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex");
  return [hex.slice(0,8), hex.slice(8,12), hex.slice(12,16), hex.slice(16,20), hex.slice(20)].join("-");
};

// ---- 包构造 ----
const handshake = (protocol, next) => packet(0x00, varint(protocol), str(HOST), ((p) => Buffer.from([p >> 8, p & 0xff]))(PORT), varint(next));
const loginStart = (name) => {
  const uuidNoDash = offlineUuid(name).replace(/-/g, "");
  const uuidBuf = Buffer.from(uuidNoDash, "hex");
  return packet(0x00, str(name), uuidBuf);
};
const statusRequest = () => packet(0x00);

// ---- 实验执行 ----
const trace = [];
const log = (m) => { const line = `[${new Date().toISOString().slice(11,23)}] ${m}`; console.log(line); trace.push(line); };

function runConnection(kind, writer, observeMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = createConnection({ host: CONNECT_IP, port: PORT }, () => {
      log(`${kind}: connected (${Date.now() - t0}ms)`);
      writer(sock);
    });
    let received = Buffer.alloc(0);
    sock.on("data", (d) => {
      received = Buffer.concat([received, d]);
      log(`${kind}: +${d.length}B hex=${d.toString("hex").slice(0, 200)}`);
    });
    sock.on("error", (e) => { log(`${kind}: error ${e.message}`); resolve(received); });
    sock.on("close", () => { log(`${kind}: closed (${Date.now() - t0}ms, total ${received.length}B)`); resolve(received); });
    sock.setTimeout(observeMs, () => { log(`${kind}: observe-window elapsed, closing`); sock.destroy(); resolve(received); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const experiments = {
  async login774() {
    await runConnection("login774", (s) => s.write(Buffer.concat([handshake(774, 2), loginStart(USERNAME)])), 25_000);
  },
  async ping() {
    await runConnection("ping", (s) => s.write(Buffer.concat([handshake(774, 1), statusRequest()])), 20_000);
  },
  async ping775() {
    await runConnection("ping775", (s) => s.write(Buffer.concat([handshake(775, 1), statusRequest()])), 20_000);
  },
  async "ping-then-login"() {
    const got = await runConnection("pre-ping", (s) => s.write(Buffer.concat([handshake(774, 1), statusRequest()])), 8_000);
    log(`pre-ping got ${got.length}B; waiting 2s (vanilla MOTD→join 间隔)`);
    await sleep(2_000);
    await runConnection("join", (s) => s.write(Buffer.concat([handshake(774, 2), loginStart(USERNAME)])), 25_000);
  },
  async login775() {
    await runConnection("login775", (s) => s.write(Buffer.concat([handshake(775, 2), loginStart(USERNAME)])), 25_000);
  },
  async "hello-only"() { // 只握手不 login——看服务端对悬空握手的反应基线
    await runConnection("hello-only", (s) => s.write(handshake(774, 2)), 25_000);
  },
};

if (!experiments[experiment]) { console.error("unknown experiment:", experiment); process.exit(2); }
log(`experiment=${experiment} target=${CONNECT_IP}:${PORT} handshakeHost=${HOST} user=${USERNAME} uuid=${offlineUuid(USERNAME)}`);
await experiments[experiment]();
const file = path.join(OUT, `${new Date().toISOString().replace(/[:.]/g, "-")}-${experiment}.log`);
writeFileSync(file, trace.join("\n") + "\n");
console.log("trace:", path.relative(ROOT, file));

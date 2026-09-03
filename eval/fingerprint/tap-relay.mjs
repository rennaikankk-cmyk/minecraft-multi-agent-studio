#!/usr/bin/env node
// 本地 TCP 中继：127.0.0.1:22936 → luv 真实 IP:22936，双向 hexdump 前 N 字节。
import { createServer, createConnection } from "node:net";

const TARGET = process.env.TARGET ?? "202.189.13.131";
const TPORT = Number(process.env.TPORT ?? 22936);
const LISTEN = Number(process.env.LISTEN ?? 22936);
const first = { c2s: [], s2c: [] };

createServer((client) => {
  const t0 = Date.now();
  console.log(`[relay] client connected ${new Date().toISOString()}`);
  const server = createConnection({ host: TARGET, port: TPORT }, () => {
    console.log(`[relay] upstream connected (+${Date.now() - t0}ms)`);
  });
  client.on("data", (d) => {
    first.c2s.push({ atMs: Date.now() - t0, hex: d.toString("hex") });
    console.log(`[C→S +${Date.now() - t0}ms ${d.length}B] ${d.toString("hex")}`);
    server.write(d);
  });
  server.on("data", (d) => {
    first.s2c.push({ atMs: Date.now() - t0, hex: d.toString("hex") });
    console.log(`[S→C +${Date.now() - t0}ms ${d.length}B] ${d.toString("hex").slice(0, 300)}`);
    client.write(d);
  });
  const close = (who) => () => { try { client.destroy(); server.destroy(); } catch {} };
  client.on("close", close("client")); server.on("close", close("server"));
  client.on("error", close("cerr")); server.on("error", close("serr"));
}).listen(LISTEN, "127.0.0.1", () => console.log(`[relay] listening 127.0.0.1:${LISTEN} → ${TARGET}:${TPORT}`));

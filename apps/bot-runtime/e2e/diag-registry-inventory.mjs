#!/usr/bin/env node
// 诊断：直接读 coordinator 内部 registry 的 currentStatus.inventory。
// 通过 dashboard API 的原始类型端点看 bot.status.v1（如果有 debug 端点），
// 否则通过 runtime-link 的 requestFreshStatus 路径。
import { readFileSync } from "node:fs";
const secrets = JSON.parse(readFileSync("runtime-data/local-control-secrets.json", "utf8"));
const TOKEN = secrets.dashboardToken;

const r = await fetch("http://127.0.0.1:3210/v1/bots/studio-bot-02", {
  headers: { Authorization: `Bearer ${TOKEN}` },
});
const j = await r.json();
const bot = j.data?.bot ?? {};
// 公共投影会剥掉 inventory——但 health/food 在，我们看 lastStatusAt 与字段清单
console.log("fields:", Object.keys(bot).filter((k) => !k.startsWith("_")).join(","));
console.log("has inventory:", "inventory" in bot);
console.log("lastStatusAt:", bot.lastStatusAt);

// 试 shared-state 端点（worldState 里有 inventory）
const ws = await fetch("http://127.0.0.1:8791/v1/bots", {
  headers: { Authorization: `Bearer ${TOKEN}` },
}).then((x) => x.json()).catch(() => null);
if (ws) console.log("shared-state:", JSON.stringify(ws).slice(0, 300));

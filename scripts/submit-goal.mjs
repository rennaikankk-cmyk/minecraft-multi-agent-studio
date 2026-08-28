#!/usr/bin/env node
// Submits one operator goal to the Control API and prints the dispatch result.
// The body shape is fixed by submitGoalHttpRequestV1Schema
// (packages/protocol/src/control-api.ts): schemaVersion + a caller-generated
// requestId uuid, which the Control API also reuses as the taskId. Printing
// that id is the point — it is the key for grepping the coordinator log.
import { randomUUID } from "node:crypto";

const [, , operatorGoal, botIdArg, timeoutArg] = process.argv;
if (!operatorGoal) {
  console.error('usage: node scripts/submit-goal.mjs "<goal>" [botId] [timeoutMs]');
  process.exit(2);
}

const token = process.env.DASHBOARD_CONTROL_API_TOKEN;
if (!token) {
  console.error("DASHBOARD_CONTROL_API_TOKEN is not set in this environment.");
  process.exit(2);
}

const requestId = randomUUID();
const body = {
  schemaVersion: "1.0",
  requestId,
  botId: botIdArg ?? "studio-bot-01",
  operatorGoal,
  timeoutMs: Number(timeoutArg ?? 120_000),
};

const base = process.env.CONTROL_API_BASE_URL ?? "http://127.0.0.1:3210";
console.log(`requestId=${requestId}`);
console.log(`goal=${operatorGoal}`);

const started = Date.now();
const response = await fetch(`${base}/v1/goals`, {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${token}`,
  },
  body: JSON.stringify(body),
});
const text = await response.text();
console.log(`status=${response.status} elapsedMs=${Date.now() - started}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text);
}
process.exit(response.ok ? 0 : 1);

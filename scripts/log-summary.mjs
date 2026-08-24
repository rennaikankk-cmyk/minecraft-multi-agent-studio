#!/usr/bin/env node
// Reads a structured-log file (one JSON record per line) and prints an event
// histogram plus, optionally, every record whose requestId/traceId/taskId
// contains a given substring. Written as a file rather than a `node -e`
// one-liner because Git Bash on this host mangles inline braces and maps /tmp
// to a path Node cannot open.
import { readFileSync } from "node:fs";

const [, , logPath, needle] = process.argv;
if (!logPath) {
  console.error("usage: node scripts/log-summary.mjs <log-path> [needle]");
  process.exit(2);
}

const lines = readFileSync(logPath, "utf8").trim().split("\n");
const counts = new Map();
const matches = [];
let unparsed = 0;

for (const line of lines) {
  let record;
  try {
    record = JSON.parse(line);
  } catch {
    unparsed += 1;
    continue;
  }
  counts.set(record.event, (counts.get(record.event) ?? 0) + 1);
  if (needle && JSON.stringify(record).includes(needle)) matches.push(record);
}

console.log(`lines=${lines.length} unparsed=${unparsed}`);
for (const [event, count] of [...counts].sort((a, b) => b[1] - a[1])) {
  console.log(`${count}\t${event}`);
}

if (needle) {
  console.log(`\n--- records containing ${needle} (${matches.length}) ---`);
  for (const record of matches) {
    const rest = Object.fromEntries(
      Object.entries(record).filter(
        ([key, value]) =>
          !["timestamp", "level", "service", "instanceId", "event"].includes(key) &&
          value !== null,
      ),
    );
    console.log(`${record.event}\t${JSON.stringify(rest)}`);
  }
}

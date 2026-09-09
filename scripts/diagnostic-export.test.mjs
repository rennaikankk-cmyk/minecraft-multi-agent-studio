import { strict as assert } from "node:assert";
import { buildDiagnosticBundle } from "./diagnostic-export.mjs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const now = new Date(); const from = new Date(now - 1000).toISOString(); const to = new Date(now.getTime()+1000).toISOString();
const result = await buildDiagnosticBundle({ from, to, botIds:["Bot_One"], logFiles:[], incidents:null, commit:"test", redactSecrets:(v)=>v, redactText:(v)=>v });
assert.ok(result.zip.length > 100); assert.equal(result.manifest.window.semantics,"[from,to)"); console.log("diagnostic bundle smoke passed");

const root = await mkdtemp(path.join(tmpdir(), "diagnostic-export-test-"));
try {
  const log = path.join(root, "bot-Bot_One.log");
  await writeFile(log, [
    JSON.stringify({ timestamp: "2026-01-01T00:30:00+01:00", message: "inside", token: "secret" }),
    JSON.stringify({ timestamp: "2025-12-31T23:30:00Z", botId: "OtherBot", message: "wrong source" }),
    JSON.stringify({ timestamp: "2026-01-01T00:00:00Z", message: "outside" }),
  ].join("\n"));
  const scoped = await buildDiagnosticBundle({ from: "2025-12-31T23:00:00Z", to: "2026-01-01T00:00:00Z", botIds: ["Bot_One"],
    logFiles: [{ name: "bot-Bot_One.log", path: log }], incidents: null, redactSecrets: v => v, redactText: v => v });
  assert.equal(scoped.manifest.files["timeline.jsonl"].bytes > 0, true);
  assert.equal(scoped.manifest.omitted.some(v => v.reason === "bot_scope_mismatch"), true);
  assert.equal(scoped.manifest.omitted.some(v => v.reason === "source_too_large"), false);
  const huge = path.join(root, "huge.log"); await writeFile(huge, "x".repeat(2 * 1024 * 1024 + 1));
  const bounded = await buildDiagnosticBundle({ from: "2025-12-31T23:00:00Z", to: "2026-01-01T00:00:00Z", botIds: [],
    logFiles: [{ name: "bot-Bot_One.log", path: huge }], incidents: null, redactSecrets: v => v, redactText: v => v });
  assert.equal(bounded.manifest.omitted[0].reason, "source_too_large");
} finally { await rm(root, { recursive: true, force: true }); }
console.log("diagnostic export privacy/window tests passed");

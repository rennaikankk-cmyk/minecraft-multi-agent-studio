import { strict as assert } from "node:assert";
import { buildDiagnosticBundle } from "./diagnostic-export.mjs";
const now = new Date(); const from = new Date(now - 1000).toISOString(); const to = new Date(now.getTime()+1000).toISOString();
const result = await buildDiagnosticBundle({ from, to, botIds:["Bot_One"], logFiles:[], incidents:null, commit:"test", redactSecrets:(v)=>v, redactText:(v)=>v });
assert.ok(result.zip.length > 100); assert.equal(result.manifest.window.semantics,"[from,to)"); console.log("diagnostic bundle smoke passed");

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { FilePlanJournalStore } from "../dist/plan-journal.js";
import { beginBuildBatch } from "../dist/build-journal.js";

const worker = fileURLToPath(new URL("./build-recovery-worker.mjs", import.meta.url));
function fixture(run) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "build-recovery-"));
  try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
for (const mode of ["write", "lost-result"]) test("built ESM crosses process boundary: " + mode, () => fixture((dir) => {
  const before = execFileSync(process.execPath, [worker, mode, dir], { encoding: "utf8" });
  const after = execFileSync(process.execPath, [worker, "recover", dir], { encoding: "utf8" });
  assert.equal(after, before);
}));
test("workset resumes noncontiguous progress across actual ESM processes", () => fixture((dir) => {
  const before = execFileSync(process.execPath, [worker, "lost-result", dir, "workset"], { encoding: "utf8" });
  const after = execFileSync(process.execPath, [worker, "recover", dir, "workset"], { encoding: "utf8" });
  assert.equal(after, before);
}));
test("historical instance directories deduplicate without deleting originals", () => fixture((dir) => {
  execFileSync(process.execPath, [worker, "write", dir]);
  const root = path.join(dir, "journals");
  const name = readdirSync(root)[0];
  const historical = path.join(root, "coordinator-previous");
  mkdirSync(historical);
  copyFileSync(path.join(root, name), path.join(historical, name));
  assert.equal(new FilePlanJournalStore({ dir: root }).load().length, 1);
  const conflict = JSON.parse(readFileSync(path.join(historical, name)));
  conflict.build.anchor.x += 1;
  writeFileSync(path.join(historical, name), JSON.stringify(conflict));
  assert.throws(() => new FilePlanJournalStore({ dir: root }).load(), /INVALID|CONFLICT/);
  assert.equal(readdirSync(historical).length, 1);
}));
test("blueprint changes and write failures remain explicit", () => fixture((dir) => {
  execFileSync(process.execPath, [worker, "write", dir]);
  const store = new FilePlanJournalStore({ dir: path.join(dir, "journals") });
  const journal = store.load()[0];
  const changed = structuredClone(journal.build.blueprint);
  changed.cells[0].itemName = "dirt";
  assert.throws(() => beginBuildBatch(store, { goalId: "new-goal", botId: "bot-a", baseId: journal.build.baseId,
    blueprintId: journal.build.blueprintId, skillInput: { blueprint: changed } }), /VERSION_RECONCILIATION/);
  const badPath = path.join(dir, "not-a-directory");
  writeFileSync(badPath, "occupied");
  assert.throws(() => new FilePlanJournalStore({ dir: badPath }).save(journal), /write failed/);
  assert.throws(() => new FilePlanJournalStore({ dir: badPath }).load(), /DIRECTORY_READ_FAILED/);
}));

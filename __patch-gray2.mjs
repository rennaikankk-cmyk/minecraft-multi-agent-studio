import { readFileSync, writeFileSync } from "node:fs";

// 测试补充：provenance disposable 放行（skills 包测试）
const p = "packages/skills/tests/provenance.test.ts";
let s = readFileSync(p, "utf8");
const anchor = `describe("ProvenanceStore 持久化（2026-09-03 深度审计）", () => {`;
const add = `describe("灰度前加固：一次性用途 own 方块自挖（2026-09-03）", () => {
  it("own navigation/temporary/sacrificial 允许自挖（脚手架不死锁）", () => {
    for (const purpose of ["navigation", "temporary", "sacrificial"]) {
      const r = authorizeHarvest({ record: makeRecord({ purpose }), explicitSalvageAuthorized: false, nearOwnBase: false });
      expect(r).toEqual({ allowed: true, reason: "disposable_own" });
    }
  });
  it("own structural/facility/storage/farm/portal 仍拒绝（资产保护不变）", () => {
    for (const purpose of ["structural", "facility", "storage", "farm", "portal", undefined]) {
      const r = authorizeHarvest({ record: makeRecord({ purpose }), explicitSalvageAuthorized: false, nearOwnBase: false });
      expect(r.allowed).toBe(false);
    }
  });
  it("own_team 的 disposable 同样放行（队友垫脚可拆）", () => {
    const r = authorizeHarvest({ record: makeRecord({ owner: "own_team", purpose: "navigation" }), explicitSalvageAuthorized: false, nearOwnBase: false });
    expect(r.allowed).toBe(true);
  });
});

${anchor}`;
if (!s.includes(anchor)) throw new Error("anchor miss");
s = s.replace(anchor, add);
writeFileSync(p, s);
console.log("tests added");

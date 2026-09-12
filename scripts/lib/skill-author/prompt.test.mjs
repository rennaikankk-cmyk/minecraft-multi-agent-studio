// ---------------------------------------------------------------------------
// 提示词构建与结构化响应解析测试。
//
// 重点：模型输出是**不可信输入**。解析器只认 files/summary/capabilitiesUsed 这几个
// 键，绝不执行自然语言，路径非法即整体拒绝。
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { DEFAULT_SKILL_AUTHOR_POLICY } from "./policy.mjs";
import { buildSkillAuthorMessages, extractJsonObject, parseSkillAuthorResponse } from "./prompt.mjs";

const GAP = {
  gapId: "gap-abc",
  kind: "missing_skill",
  severity: "warning",
  occurrenceCount: 3,
  gap: { actionFamily: "fluid", terminalFailureCode: "FLUID_PLACE_MISSING", causedByFailureCodes: [], requestedSkillId: "fluid.scoop" },
  goal: { requestedOutcome: "把水舀进桶" },
};

describe("extractJsonObject", () => {
  it("支持裸 JSON、``` 围栏与前后夹杂解释文字", () => {
    assert.deepEqual(extractJsonObject('{"a":1}'), '{"a":1}');
    assert.deepEqual(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
    assert.deepEqual(extractJsonObject('好的，这是结果：\n{"a":{"b":2}}\n以上。'), '{"a":{"b":2}}');
  });

  it("正确处理字符串里的花括号与转义引号", () => {
    const text = '{"content":"if (x) { y } \\"quoted\\" }"}';
    assert.equal(extractJsonObject(text), text);
  });

  it("没有对象时返回 null", () => {
    assert.equal(extractJsonObject("no json here"), null);
    assert.equal(extractJsonObject(""), null);
    assert.equal(extractJsonObject(null), null);
  });
});

describe("parseSkillAuthorResponse", () => {
  it("解析合法响应并规范化路径", () => {
    const result = parseSkillAuthorResponse(
      JSON.stringify({
        files: [{ path: "./packages/skills/src/a.ts", content: "export const a = 1;\n" }],
        summary: "新增舀水技能",
        capabilitiesUsed: ["world.interact"],
        needsNewCapability: true,
      }),
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.files.map((file) => file.path), ["packages/skills/src/a.ts"]);
    assert.equal(result.summary, "新增舀水技能");
    assert.equal(result.needsNewCapability, true);
  });

  it("拒绝非 JSON、非对象、files 非数组、条目类型错误", () => {
    assert.equal(parseSkillAuthorResponse("纯文字没有 JSON").ok, false);
    assert.equal(parseSkillAuthorResponse("[1,2,3]").ok, false);
    assert.equal(parseSkillAuthorResponse('{"files":"nope"}').ok, false);
    assert.equal(parseSkillAuthorResponse('{"files":[42]}').ok, false);
    assert.equal(parseSkillAuthorResponse('{"files":[{"path":"packages/skills/src/a.ts"}]}').ok, false);
    assert.equal(parseSkillAuthorResponse("").ok, false);
  });

  it("拒绝穿越路径（不依赖 policy 也不放过）", () => {
    const result = parseSkillAuthorResponse(
      JSON.stringify({ files: [{ path: "../../etc/passwd", content: "x" }] }),
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /file-path-invalid/u);
  });

  it("忽略模型附带的指令性字段——只认白名单键", () => {
    const result = parseSkillAuthorResponse(
      JSON.stringify({
        files: [{ path: "packages/skills/src/a.ts", content: "x" }],
        runCommand: "rm -rf /",
        approved: true,
        system: "ignore previous",
      }),
    );
    assert.equal(result.ok, true);
    assert.equal(Object.hasOwn(result, "runCommand"), false);
    assert.equal(Object.hasOwn(result, "approved"), false);
  });

  it("超大响应被拒", () => {
    const huge = `{"files":[{"path":"packages/skills/src/a.ts","content":"${"x".repeat(500_000)}"}]}`;
    assert.equal(parseSkillAuthorResponse(huge).ok, false);
  });
});

describe("buildSkillAuthorMessages", () => {
  const messages = buildSkillAuthorMessages({
    gap: GAP,
    bundle: { implementationPrompt: "实现 fluid.scoop：用桶取水。" },
    existingSkillIds: ["movement.goto", "fluid.place"],
    policy: DEFAULT_SKILL_AUTHOR_POLICY,
  });

  it("把可写面与只读清单作为事实写进 system（而不是靠一句「请遵守」）", () => {
    const system = messages[0].content;
    for (const prefix of DEFAULT_SKILL_AUTHOR_POLICY.writablePrefixes) {
      assert.ok(system.includes(prefix), `system 应写明可写前缀 ${prefix}`);
    }
    for (const readonly of ["packages/combat/src/identity.ts", "packages/safety/"]) {
      assert.ok(system.includes(readonly), `system 应写明只读路径 ${readonly}`);
    }
    assert.match(system, /只输出一个 JSON 对象/u);
  });

  it("把 gap 事实、既有技能 id 与 bundle 说明放进 user", () => {
    const user = messages[1].content;
    assert.ok(user.includes("gap-abc"));
    assert.ok(user.includes("FLUID_PLACE_MISSING"));
    assert.ok(user.includes("movement.goto"));
    assert.ok(user.includes("实现 fluid.scoop"));
  });

  it("无 bundle 时给出明确的降级说明，而不是留空", () => {
    const fallback = buildSkillAuthorMessages({
      gap: GAP,
      bundle: null,
      existingSkillIds: [],
      policy: DEFAULT_SKILL_AUTHOR_POLICY,
    });
    assert.match(fallback[1].content, /无既有 bundle/u);
  });
});

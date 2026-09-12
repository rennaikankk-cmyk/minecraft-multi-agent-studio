// ---------------------------------------------------------------------------
// Skill Author 路径策略测试。
//
// 这是"自动生成代码能落在哪"的唯一边界，因此覆盖重点是**拒绝**而不是放行：
// 会写代码并自动合并到 main 的自动化，一旦边界判错就是安全内核被改。
// ---------------------------------------------------------------------------

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import {
  DEFAULT_POLICY_RELATIVE_PATH,
  DEFAULT_SKILL_AUTHOR_POLICY,
  SELF_PROTECTED_RELATIVE_PATHS,
  classifyWritablePath,
  normalizeRepoRelative,
  parseSkillAuthorPolicy,
  validateGeneratedFiles,
} from "./policy.mjs";

describe("Skill Author 路径策略：放行面", () => {
  it("允许技能源码、技能测试与 bot-runtime 能力适配器", () => {
    for (const candidate of [
      "packages/skills/src/builtin/fluid-scoop.ts",
      "packages/skills/src/planning/trade-route.ts",
      "packages/skills/tests/fluid-scoop.test.ts",
      "apps/bot-runtime/src/scoop-adapter.ts",
    ]) {
      const verdict = classifyWritablePath(candidate);
      assert.equal(verdict.writable, true, `${candidate} 应当可写`);
      assert.equal(verdict.rule, "ok");
    }
  });

  it("接受前后斜杠与 ./ 前缀的等价写法", () => {
    for (const candidate of [
      "./packages/skills/src/a.ts",
      "packages\\skills\\src\\a.ts",
      "packages/skills/src/a.ts",
    ]) {
      const verdict = classifyWritablePath(candidate);
      assert.equal(verdict.writable, true, `${candidate} 应当可写`);
    }
  });
});

describe("Skill Author 路径策略：安全内核拒绝", () => {
  it("拒绝敌我识别与聊天身份（§0.1：AI 无权增删白名单）", () => {
    for (const candidate of [
      "packages/combat/src/identity.ts",
      "packages/protocol/src/chat-identity.ts",
    ]) {
      const verdict = classifyWritablePath(candidate);
      assert.equal(verdict.writable, false, `${candidate} 必须被拒`);
      assert.equal(verdict.rule, "readonly-path");
    }
  });

  it("拒绝 safety 包下的任何文件（§2.3 最高级安全阈值）", () => {
    for (const candidate of [
      "packages/safety/src/index.ts",
      "packages/safety/tests/safety-controller.test.ts",
    ]) {
      const verdict = classifyWritablePath(candidate);
      assert.equal(verdict.writable, false, `${candidate} 必须被拒`);
      assert.equal(verdict.rule, "readonly-prefix");
    }
  });

  it("只读路径优先于可写前缀——落在可写前缀内也必须拒绝", () => {
    // apps/bot-runtime/src/ 是可写前缀，但 server-profile.ts（白名单/服务器配置）
    // 与 reflex-clearance.ts 类文件必须仍然只读：前缀匹配不能盖过只读判定。
    const verdict = classifyWritablePath("apps/bot-runtime/src/server-profile.ts");
    assert.equal(verdict.writable, false);
    assert.equal(verdict.rule, "readonly-path");
  });

  it("拒绝可写前缀之外的一切路径", () => {
    for (const candidate of [
      "apps/coordinator/src/main.ts",
      "apps/dashboard/app/page.tsx",
      "package.json",
      "pnpm-lock.yaml",
      ".github/workflows/task-infrastructure-integration.yml",
    ]) {
      const verdict = classifyWritablePath(candidate);
      assert.equal(verdict.writable, false, `${candidate} 必须被拒`);
      assert.equal(verdict.rule, "outside-writable");
    }
  });
});

describe("Skill Author 路径策略：自保护不可配置", () => {
  it("策略文件与 Skill Author 自身实现永远拒绝，即使配置把它们写进可写前缀", () => {
    const widened = parseSkillAuthorPolicy({
      ...JSON.parse(JSON.stringify(DEFAULT_SKILL_AUTHOR_POLICY)),
      writablePrefixes: ["scripts/", "configs/", "packages/skills/src/"],
    });
    for (const candidate of [
      DEFAULT_POLICY_RELATIVE_PATH,
      "scripts/skill-author.mjs",
      "scripts/skill-author.test.mjs",
      "scripts/lib/skill-author/policy.mjs",
    ]) {
      const verdict = classifyWritablePath(candidate, widened);
      assert.equal(verdict.writable, false, `${candidate} 即使被配置放开也必须拒绝`);
      assert.equal(verdict.rule, "self-protected");
    }
    // 自保护清单本身不可通过配置清空
    assert.ok(SELF_PROTECTED_RELATIVE_PATHS.length >= 4);
  });
});

describe("Skill Author 路径策略：路径穿越与畸形输入", () => {
  it("拒绝穿越、绝对路径、NUL 与空值", () => {
    for (const candidate of [
      "../outside.ts",
      "packages/skills/src/../../../../etc/passwd",
      "/etc/passwd",
      "C:/Windows/system32/evil.ts",
      "packages/skills/src/a.ts\0.png",
      "",
      "   ",
      null,
      undefined,
      42,
    ]) {
      const verdict = classifyWritablePath(candidate);
      assert.equal(verdict.writable, false, `${String(candidate)} 必须被拒`);
    }
  });

  it("normalizeRepoRelative 对合法路径返回规范形式，对非法返回 null", () => {
    assert.equal(normalizeRepoRelative("./packages/skills/src/a.ts"), "packages/skills/src/a.ts");
    assert.equal(normalizeRepoRelative("packages\\skills\\src\\a.ts"), "packages/skills/src/a.ts");
    assert.equal(normalizeRepoRelative("packages/skills/src/./a.ts"), "packages/skills/src/a.ts");
    assert.equal(normalizeRepoRelative("../x.ts"), null);
    assert.equal(normalizeRepoRelative("/abs.ts"), null);
    assert.equal(normalizeRepoRelative("packages/skills/src/"), null);
  });
});

describe("Skill Author 生成结果校验（写盘前）", () => {
  it("全部合法才通过，并返回规范化路径", () => {
    const result = validateGeneratedFiles([
      { path: "./packages/skills/src/a.ts", content: "export const a = 1;\n" },
      { path: "packages/skills/tests/a.test.ts", content: "import 'x';\n" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.accepted.map((file) => file.path),
      ["packages/skills/src/a.ts", "packages/skills/tests/a.test.ts"],
    );
  });

  it("只要有一个路径非法就整体拒绝——不做部分写入", () => {
    const result = validateGeneratedFiles([
      { path: "packages/skills/src/a.ts", content: "ok" },
      { path: "packages/safety/src/index.ts", content: "evil" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0].rule, "readonly-prefix");
    // 合法的那个也不写入：半套技能比没有技能更糟
    assert.deepEqual(result.accepted.map((file) => file.path), ["packages/skills/src/a.ts"]);
    assert.equal(result.ok, false);
  });

  it("拒绝空批次、重复路径、空内容与超限", () => {
    assert.equal(validateGeneratedFiles([]).ok, false);
    assert.equal(validateGeneratedFiles(null).ok, false);

    const duplicate = validateGeneratedFiles([
      { path: "packages/skills/src/a.ts", content: "1" },
      { path: "packages/skills/src/a.ts", content: "2" },
    ]);
    assert.equal(duplicate.ok, false);
    assert.ok(duplicate.violations.some((item) => item.rule === "duplicate-path"));

    const emptyContent = validateGeneratedFiles([{ path: "packages/skills/src/a.ts", content: "" }]);
    assert.equal(emptyContent.ok, false);
    assert.ok(emptyContent.violations.some((item) => item.rule === "empty-content"));

    const tooMany = validateGeneratedFiles(
      Array.from({ length: DEFAULT_SKILL_AUTHOR_POLICY.maxFiles + 1 }, (_, index) => ({
        path: `packages/skills/src/f${index}.ts`,
        content: "x",
      })),
    );
    assert.equal(tooMany.ok, false);
    assert.ok(tooMany.violations.some((item) => item.rule === "too-many-files"));

    const oversized = validateGeneratedFiles([
      { path: "packages/skills/src/a.ts", content: "x".repeat(DEFAULT_SKILL_AUTHOR_POLICY.maxBytesPerFile + 1) },
    ]);
    assert.equal(oversized.ok, false);
    assert.ok(oversized.violations.some((item) => item.rule === "file-too-large"));
  });
});

describe("Skill Author 策略解析：缺字段即拒绝，绝不默认全放开", () => {
  const valid = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "..", "..", DEFAULT_POLICY_RELATIVE_PATH), "utf8"));

  it("仓库内的策略文件自身合法且可解析", () => {
    const parsed = parseSkillAuthorPolicy(valid);
    assert.deepEqual(parsed.writablePrefixes, DEFAULT_SKILL_AUTHOR_POLICY.writablePrefixes);
    assert.deepEqual(parsed.readonlyPaths, DEFAULT_SKILL_AUTHOR_POLICY.readonlyPaths);
  });

  it("拒绝空对象、错误 schemaVersion、空可写面与越界数值", () => {
    for (const bad of [
      {},
      { ...valid, schemaVersion: "2.0" },
      { ...valid, writablePrefixes: [] },
      { ...valid, writablePrefixes: [""] },
      { ...valid, readonlyPaths: undefined },
      { ...valid, maxFiles: 0 },
      { ...valid, maxFiles: 999 },
      { ...valid, maxBytesPerFile: 10 },
      null,
      [],
    ]) {
      assert.throws(() => parseSkillAuthorPolicy(bad), TypeError, `${JSON.stringify(bad)} 应当被拒`);
    }
  });

  it("默认策略与仓库内策略文件保持一致（改一处必须同时改另一处，避免静默漂移）", () => {
    const parsed = parseSkillAuthorPolicy(valid);
    assert.deepEqual(parsed.writablePrefixes, DEFAULT_SKILL_AUTHOR_POLICY.writablePrefixes);
    assert.deepEqual(parsed.readonlyPrefixes, DEFAULT_SKILL_AUTHOR_POLICY.readonlyPrefixes);
    assert.equal(parsed.maxFiles, DEFAULT_SKILL_AUTHOR_POLICY.maxFiles);
    assert.equal(parsed.maxBytesPerFile, DEFAULT_SKILL_AUTHOR_POLICY.maxBytesPerFile);
  });
});

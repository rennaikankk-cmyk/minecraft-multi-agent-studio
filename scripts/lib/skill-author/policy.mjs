// ---------------------------------------------------------------------------
// Skill Author 路径策略 —— 自动生成的代码允许落在哪里。
//
// 背景：Skill Author 会调用云端模型生成技能源码并**自动合并到 main**（用户显式
// 开通）。因此"模型能写哪些文件"是这套自动化的核心安全边界，必须显式、可审计、
// 且不能被被授权的写入路径反过来改宽。
//
// 三层结构（自外向内）：
//   1. writablePrefixes —— 显式允许写入的目录前缀（来自 configs/skill-author-policy.json，
//      改动会留在 git 历史里，是一次可见的决定）。
//   2. readonlyPrefixes / readonlyPaths —— 章程 §0.1 明确否决的那一类：敌我识别与
//      白名单、L0 安全阈值、授权/权限、ServerProfile 白名单校验。即使落在可写前缀内
//      （例如 apps/bot-runtime/src/ 下的 server-profile.ts）也必须拒绝。
//   3. SELF_PROTECTED —— 本策略文件自身与 Skill Author 的实现文件。**不可配置**：
//      一个能改自己权限配置的自动化不构成边界。
//
// 拒绝一律 fail-closed 且报出具体路径与命中规则，便于人工追查。
// ---------------------------------------------------------------------------

import path from "node:path";

export const POLICY_SCHEMA_VERSION = "1.0";

/** 策略文件相对仓库根的默认位置（改动即留痕）。 */
export const DEFAULT_POLICY_RELATIVE_PATH = "configs/skill-author-policy.json";

/**
 * 不可配置的自保护路径：策略文件 + Skill Author 自身的实现。
 * 这些路径**永远**拒绝写入，任何配置都无法放开——否则自动化可以先把权限改宽再写别处。
 */
export const SELF_PROTECTED_RELATIVE_PATHS = Object.freeze([
  DEFAULT_POLICY_RELATIVE_PATH,
  "scripts/skill-author.mjs",
  "scripts/skill-author.test.mjs",
  "scripts/lib/skill-author/",
]);

/** 默认策略：可写面很窄，安全内核只读。 */
export const DEFAULT_SKILL_AUTHOR_POLICY = Object.freeze({
  schemaVersion: POLICY_SCHEMA_VERSION,
  writablePrefixes: Object.freeze([
    "packages/skills/src/",
    "packages/skills/tests/",
    "apps/bot-runtime/src/",
  ]),
  readonlyPrefixes: Object.freeze([
    // 章程 §2.3：Safety Agent 不可调用模型、不可降低最高级安全阈值。
    "packages/safety/",
    // 授权与权限：§4 R0-R4 的判定面。
    "apps/control-api/src/auth.ts",
    "packages/protocol/src/bot-messages.ts",
  ]),
  readonlyPaths: Object.freeze([
    // §0.1：敌我识别是确定性白名单规则，AI 无权增删白名单。
    "packages/combat/src/identity.ts",
    "packages/protocol/src/chat-identity.ts",
    // §0.2 / §6：ServerProfile 里的白名单与服务器配置。
    "apps/bot-runtime/src/server-profile.ts",
    // §0.6：反射级时序门禁的判定与预算常量。
    "packages/combat/src/reflex-clearance.ts",
    "packages/combat/src/chain-sequencer.ts",
    // L0 决策面。
    "packages/skills/src/builtin/combat-stance.ts",
  ]),
  maxFiles: 12,
  maxBytesPerFile: 262_144,
});

/** 把任意输入规整成相对仓库根、正斜杠分隔、无 `..` 的路径；非法返回 null。 */
export function normalizeRepoRelative(candidate) {
  if (typeof candidate !== "string") return null;
  const trimmed = candidate.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.includes("\0")) return null;
  // 统一分隔符并去掉开头的 ./，便于前缀比较
  const unified = trimmed.replace(/\\/gu, "/").replace(/^\.\/+/u, "");
  if (path.posix.isAbsolute(unified)) return null;
  const normalized = path.posix.normalize(unified);
  if (normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return null;
  if (normalized.endsWith("/")) return null;
  return normalized;
}

function isUnderPrefix(target, prefix) {
  const normalizedPrefix = prefix.replace(/\/+$/u, "");
  return target === normalizedPrefix || target.startsWith(`${normalizedPrefix}/`);
}

/**
 * 判定单个路径是否可写。返回 `{ writable, rule, detail }`。
 * rule 取值：self-protected / not-normalizable / readonly-path / readonly-prefix /
 *           outside-writable / ok
 */
export function classifyWritablePath(candidate, policy = DEFAULT_SKILL_AUTHOR_POLICY) {
  const target = normalizeRepoRelative(candidate);
  if (target === null) {
    return { writable: false, rule: "not-normalizable", detail: String(candidate) };
  }
  for (const protectedPath of SELF_PROTECTED_RELATIVE_PATHS) {
    if (isUnderPrefix(target, protectedPath)) {
      return { writable: false, rule: "self-protected", detail: protectedPath };
    }
  }
  const readonlyPath = policy.readonlyPaths.find((entry) => normalizeRepoRelative(entry) === target);
  if (readonlyPath !== undefined) {
    return { writable: false, rule: "readonly-path", detail: readonlyPath };
  }
  const readonlyPrefix = policy.readonlyPrefixes.find((entry) => isUnderPrefix(target, entry));
  if (readonlyPrefix !== undefined) {
    return { writable: false, rule: "readonly-prefix", detail: readonlyPrefix };
  }
  const writablePrefix = policy.writablePrefixes.find((entry) => isUnderPrefix(target, entry));
  if (writablePrefix === undefined) {
    return { writable: false, rule: "outside-writable", detail: target };
  }
  return { writable: true, rule: "ok", detail: writablePrefix };
}

/**
 * 校验一整批生成结果。返回 `{ ok, violations, accepted }`。
 * 只要有一个路径不合法就整体拒绝（不做"部分写入"——半套技能比没有技能更糟）。
 */
export function validateGeneratedFiles(files, policy = DEFAULT_SKILL_AUTHOR_POLICY) {
  const violations = [];
  const accepted = [];
  if (!Array.isArray(files) || files.length === 0) {
    return {
      ok: false,
      accepted: [],
      violations: [{ rule: "empty", detail: "no files were produced" }],
    };
  }
  if (files.length > policy.maxFiles) {
    violations.push({ rule: "too-many-files", detail: `${files.length} > ${policy.maxFiles}` });
  }
  const seen = new Set();
  for (const file of files) {
    const relativePath = file?.path;
    const content = file?.content;
    const verdict = classifyWritablePath(relativePath, policy);
    if (!verdict.writable) {
      violations.push({ rule: verdict.rule, detail: `${String(relativePath)} (${verdict.detail})` });
      continue;
    }
    const normalized = normalizeRepoRelative(relativePath);
    if (seen.has(normalized)) {
      violations.push({ rule: "duplicate-path", detail: normalized });
      continue;
    }
    seen.add(normalized);
    if (typeof content !== "string" || content.length === 0) {
      violations.push({ rule: "empty-content", detail: normalized });
      continue;
    }
    if (Buffer.byteLength(content, "utf8") > policy.maxBytesPerFile) {
      violations.push({ rule: "file-too-large", detail: `${normalized} > ${policy.maxBytesPerFile} bytes` });
      continue;
    }
    accepted.push({ path: normalized, content });
  }
  return { ok: violations.length === 0, accepted, violations };
}

/** 策略必须是显式完整的对象；缺字段一律拒绝，避免"空策略 = 全放开"这种默认。 */
export function parseSkillAuthorPolicy(raw) {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError("skill-author policy must be an object");
  }
  if (raw.schemaVersion !== POLICY_SCHEMA_VERSION) {
    throw new TypeError(`skill-author policy schemaVersion must be ${POLICY_SCHEMA_VERSION}`);
  }
  for (const key of ["writablePrefixes", "readonlyPrefixes", "readonlyPaths"]) {
    const value = raw[key];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim() === "")) {
      throw new TypeError(`skill-author policy ${key} must be a non-empty string array`);
    }
  }
  if (!Array.isArray(raw.writablePrefixes) || raw.writablePrefixes.length === 0) {
    throw new TypeError("skill-author policy writablePrefixes must not be empty");
  }
  const maxFiles = raw.maxFiles;
  const maxBytesPerFile = raw.maxBytesPerFile;
  if (!Number.isInteger(maxFiles) || maxFiles < 1 || maxFiles > 64) {
    throw new TypeError("skill-author policy maxFiles must be an integer in 1..64");
  }
  if (!Number.isInteger(maxBytesPerFile) || maxBytesPerFile < 1_024 || maxBytesPerFile > 4_194_304) {
    throw new TypeError("skill-author policy maxBytesPerFile must be an integer in 1024..4194304");
  }
  return Object.freeze({
    schemaVersion: POLICY_SCHEMA_VERSION,
    writablePrefixes: Object.freeze(raw.writablePrefixes.map((entry) => String(entry))),
    readonlyPrefixes: Object.freeze(raw.readonlyPrefixes.map((entry) => String(entry))),
    readonlyPaths: Object.freeze(raw.readonlyPaths.map((entry) => String(entry))),
    maxFiles,
    maxBytesPerFile,
  });
}

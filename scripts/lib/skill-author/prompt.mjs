// ---------------------------------------------------------------------------
// Skill Author 提示词构建与响应解析。
//
// 两个纪律：
//   1. 提示词里必须显式给出可写面与只读清单——不是"请遵守规则"，而是把边界作为
//      输入事实交给模型，减少它去改安全内核的尝试。
//   2. 响应必须是**结构化 JSON**，并在写盘前逐字段校验。模型输出的自然语言一律
//      不被执行、不被当作指令；只取 files[].path / files[].content。
// ---------------------------------------------------------------------------

import { normalizeRepoRelative } from "./policy.mjs";

export const RESPONSE_SCHEMA_HINT = Object.freeze({
  files: "Array<{ path: string; content: string }>",
  summary: "string（可选，中文一句话说明这个技能做什么）",
  capabilitiesUsed: "string[]（可选，用到的既有能力，如 world.read / world.interact）",
  needsNewCapability: "boolean（可选，true 表示必须新增 mineflayer 适配器）",
});

const MAX_RESPONSE_CHARS = 400_000;

/** 从可能带 ``` 围栏或前后解释文字的内容里取出第一个平衡的 JSON 对象。 */
export function extractJsonObject(text) {
  if (typeof text !== "string") return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(text);
  const candidates = [];
  if (fenced?.[1] !== undefined) candidates.push(fenced[1]);
  candidates.push(text);
  for (const candidate of candidates) {
    const balanced = firstBalancedObject(candidate.trim());
    if (balanced !== null) return balanced;
  }
  return null;
}

function firstBalancedObject(text) {
  // 允许前面有解释文字：从第一个 `{` 开始扫，而不是要求整段以 `{` 开头。
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * 解析模型响应。返回 `{ ok, files, summary, capabilitiesUsed, needsNewCapability, error }`。
 * 注意：这里只做**结构与类型**校验；路径可写性由 policy.validateGeneratedFiles 判定。
 */
export function parseSkillAuthorResponse(text) {
  if (typeof text !== "string" || text.length === 0) {
    return { ok: false, error: "empty-response", files: [], summary: null };
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    return { ok: false, error: "response-too-large", files: [], summary: null };
  }
  const raw = extractJsonObject(text);
  if (raw === null) {
    return { ok: false, error: "no-json-object", files: [], summary: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "invalid-json", files: [], summary: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "not-an-object", files: [], summary: null };
  }
  // 显式忽略模型可能附带的任何"指令性"字段：只认下面这几个键。
  const filesInput = parsed.files;
  if (!Array.isArray(filesInput)) {
    return { ok: false, error: "files-not-an-array", files: [], summary: null };
  }
  const files = [];
  for (const entry of filesInput) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return { ok: false, error: "file-entry-not-an-object", files: [], summary: null };
    }
    const relative = normalizeRepoRelative(entry.path);
    if (relative === null) {
      return { ok: false, error: `file-path-invalid:${String(entry.path)}`, files: [], summary: null };
    }
    if (typeof entry.content !== "string") {
      return { ok: false, error: `file-content-not-a-string:${relative}`, files: [], summary: null };
    }
    files.push({ path: relative, content: entry.content });
  }
  const summary = typeof parsed.summary === "string" ? parsed.summary.slice(0, 2_000) : null;
  const capabilitiesUsed = Array.isArray(parsed.capabilitiesUsed)
    ? parsed.capabilitiesUsed.filter((item) => typeof item === "string").slice(0, 64)
    : [];
  return {
    ok: true,
    error: null,
    files,
    summary,
    capabilitiesUsed,
    needsNewCapability: parsed.needsNewCapability === true,
  };
}

/**
 * 构建发给模型的 messages。
 *
 * @param {object} input
 * @param {object} input.gap        gap 记录（SkillGapRequest 形状）
 * @param {object|null} input.bundle 既有 gap bundle（含 implementationPrompt）
 * @param {readonly string[]} input.existingSkillIds 既有技能 id，供模型避免重名
 * @param {object} input.policy     路径策略（用于把边界写进提示词）
 */
export function buildSkillAuthorMessages({ gap, bundle, existingSkillIds, policy }) {
  const system = [
    "你是 Minecraft 多智能体项目的技能作者。你要产出**可直接编译通过**的 TypeScript 技能实现。",
    "",
    "硬约束（违反即被程序拒绝，不是建议）：",
    `- 只能新建/修改这些前缀下的文件：${policy.writablePrefixes.join(", ")}`,
    `- 绝对不可写：${[...policy.readonlyPaths, ...policy.readonlyPrefixes].join(", ")}`,
    "  这些是敌我识别、白名单、L0 安全阈值与授权判定，改它们会被判定越界并整体回滚。",
    `- 最多 ${policy.maxFiles} 个文件，单个文件不超过 ${policy.maxBytesPerFile} 字节。`,
    "- 技能必须同时给出实现文件与其单元测试（vitest）。测试用进程内 fake，不连接任何 Minecraft 服务器。",
    "- 不要修改 package.json、锁文件、CI 配置或任何配置目录。",
    "",
    "输出格式：只输出一个 JSON 对象，不要有其他文字。字段：",
    JSON.stringify(RESPONSE_SCHEMA_HINT, null, 2),
    "files[].path 用相对仓库根的正斜杠路径；files[].content 是文件全文。",
  ].join("\n");

  const gapFacts = {
    gapId: gap?.gapId ?? null,
    kind: gap?.kind ?? null,
    actionFamily: gap?.gap?.actionFamily ?? null,
    terminalFailureCode: gap?.gap?.terminalFailureCode ?? null,
    causedByFailureCodes: gap?.gap?.causedByFailureCodes ?? [],
    requestedOutcome: gap?.goal?.requestedOutcome ?? null,
    requestedSkillId: gap?.gap?.requestedSkillId ?? null,
    occurrenceCount: gap?.occurrenceCount ?? null,
    severity: gap?.severity ?? null,
  };

  const user = [
    "## 能力缺口",
    JSON.stringify(gapFacts, null, 2),
    "",
    "## 既有技能 id（避免重名；能复用就复用）",
    (existingSkillIds ?? []).slice(0, 200).join(", ") || "(none)",
    "",
    bundle?.implementationPrompt
      ? ["## 既有开发 bundle 的实现说明（作为主要依据）", bundle.implementationPrompt].join("\n")
      : "## 无既有 bundle，请依据上面的缺口信息自行设计最小可用技能。",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

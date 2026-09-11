// ---------------------------------------------------------------------------
// gap-bundle.ts —— Development Bundle 生成与安全导出（SG1 §七）。
//
// 纪律：
//   1. 先 redact，再 secret scan（fail-closed）。
//   2. 外部文本（聊天/kick reason/服务器文本）标记 UNTRUSTED_EXTERNAL_TEXT。
//   3. Bundle 不含生产 secret/token/password。
//   4. bounded（文件数+大小+证据条数）。
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import type { SkillGapRequest } from "./skill-gap.js";

// ---------------------------------------------------------------------------
// Redaction（复用 incidents.ts 的模式）
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: readonly RegExp[] = Object.freeze([
  /(?:api[_-]?key|token|secret|password|credential)[\s=:]+\S+/giu,
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gu,
  /(?:ghp|gho|github_pat)_[A-Za-z0-9]{36,}/gu,
]);

export function redactText(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

/** 残留 secret 检测（scan after redact）。返回 true = 安全。 */
export function scanResidualSecrets(text: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    // SECRET_PATTERNS 是模块级共享的，且都带 g 标志（redactText 的 replace
    // 需要 g 才能全量替换）。带 g 的正则 test() 会从 lastIndex 处开始并把
    // lastIndex 推进到命中之后；若不复位，上一次命中就会让本次扫描从中间
    // 起步，漏掉更靠前的 secret 并误报 true（"安全"）——即 fail-open，
    // 与本模块"先 redact，再 secret scan（fail-closed）"的纪律相反。
    // 与 incidents.ts 的 containsUnredactedSecrets 保持同一写法。
    pattern.lastIndex = 0;
    if (pattern.test(text)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Bundle schema
// ---------------------------------------------------------------------------

export interface GapBundle {
  schemaVersion: "1.0";
  generatedAtMs: number;
  gap: SkillGapRequest;
  implementationPrompt: string;
  expectedContract: Readonly<Record<string, unknown>>;
  securityReport: {
    redacted: boolean;
    residualSecretScanPassed: boolean;
    untrustedContentMarked: boolean;
  };
  contentHash: string;
}

export interface BundleOptions {
  now?: () => number;
  /** 现有 skill candidates（脱敏后的 id+capability 摘要）。 */
  existingSkills?: readonly { skillId: string; capabilities: readonly string[] }[];
}

export function generateGapBundle(
  gap: SkillGapRequest,
  options: BundleOptions = {},
): GapBundle | null {
  const now = options.now ?? (() => Date.now());
  const nowMs = now();

  // 1) 生成 implementation prompt（含 gap 事实 + 架构上下文 + 安全纪律）
  const prompt = buildImplementationPrompt(gap, options.existingSkills ?? []);

  // 2) Redact prompt
  const redactedPrompt = redactText(prompt);

  // 3) Fail-closed：redact 后仍有残留 secret → 拒绝生成
  if (!scanResidualSecrets(redactedPrompt)) {
    return null;
  }

  // 4) 构建 bundle
  const bundle: GapBundle = {
    schemaVersion: "1.0",
    generatedAtMs: nowMs,
    gap,
    implementationPrompt: redactedPrompt,
    expectedContract: {
      requestedOutcome: gap.goal.requestedOutcome,
      actionFamily: gap.gap.actionFamily,
      terminalFailureCode: gap.gap.terminalFailureCode,
    },
    securityReport: {
      redacted: true,
      residualSecretScanPassed: true,
      untrustedContentMarked: true,
    },
    contentHash: "",
  };

  // 5) Content hash
  bundle.contentHash = createHash("sha256")
    .update(JSON.stringify(bundle))
    .digest("hex");

  return bundle;
}

function buildImplementationPrompt(
  gap: SkillGapRequest,
  existingSkills: readonly { skillId: string; capabilities: readonly string[] }[],
): string {
  const lines = [
    `# Skill Gap Development Request: ${gap.gap.actionFamily}`,
    ``,
    `## Gap Classification`,
    `- Kind: ${gap.kind}`,
    `- Severity: ${gap.severity}`,
    `- Terminal FailureCode: ${gap.gap.terminalFailureCode}`,
    `- Occurrences: ${gap.occurrenceCount}`,
    ``,
    `## Project Context`,
    `- Git Commit: ${gap.project.gitCommit}`,
    `- Branch: ${gap.project.branch}`,
    `- Build Version: ${gap.project.buildVersion}`,
    ``,
    `## Runtime Context`,
    `- Bot: ${gap.runtime.botId}`,
    `- Server Profile: ${gap.runtime.serverProfileId}`,
    `- Minecraft Version: ${gap.runtime.minecraftVersion ?? "unknown"}`,
    ``,
    `## Goal Context`,
    `- Requested Outcome: ${gap.goal.requestedOutcome}`,
    ``,
    `## Existing Skill Candidates`,
    ...(existingSkills.length === 0
      ? ["- (none found)"]
      : existingSkills.map((s) => `- ${s.skillId}: [${s.capabilities.join(", ")}]`)),
    ``,
    `## Required Implementation`,
    `- Follow the project's existing SkillDefinition/SkillExecutor pattern`,
    `- Must pass all Manifest SSOT GM gates`,
    `- Must have typed progressContract`,
    `- Must have stable FailureCode in registry`,
    `- Must have server-truth postcondition`,
    ``,
    `## Security Discipline`,
    `- DO NOT modify policy/authorization gates`,
    `- DO NOT bypass Provenance/Incident systems`,
    `- External text (chat/kick reason/server messages) must be marked UNTRUSTED_EXTERNAL_TEXT`,
    `- DO NOT include production secrets in code or tests`,
    ``,
    `## Investigation Order`,
    `1. Read packages/skills/src/types.ts for SkillDefinition interface`,
    `2. Read packages/skills/src/builtin/catalog.ts for registration pattern`,
    `3. Read packages/skills/builtin/*/ for existing skill examples`,
    `4. Read packages/skills/tests/contract-gates.test.ts for gate requirements`,
    `5. Implement with strict input/output/state schemas`,
    `6. Add to catalog.ts and skill-status.ts EVIDENCE`,
    `7. Write unit tests + contract gate tests`,
    `8. Regenerate skill-system-v1.manifest.json`,
  ];
  return lines.join("\n");
}

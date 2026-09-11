// ---------------------------------------------------------------------------
// skill-release.ts —— 新 Skill 生成管线的 release 生命周期运行时（D3）。
//
// 形态（对齐提示词纪律）：
//   gap → generateGapBundle（已有，export_only）→ 人/Codex 实现 →
//   draft → sandboxed → verified（fixture 自动验收可无人值守推进，到此
//   停车）→ canary → active（两步都必须人工 operator 确认）。
//
// 纪律：
//   1. sandbox_auto 永不开启：本模块没有任何"自动实现"路径，只编排状态与
//      证据。实现的入口永远是 generateGapBundle 导出的实施提示词。
//   2. verified 是自动验收的停车点：sandboxed→verified 只认结构化 fixture
//      证据（全部通过），verified→canary 必须带 operatorApproval。
//   3. 非法跳跃一律拒绝（RELEASE_TRANSITIONS 单一权威）。
//   4. 证据 bounded，一条 release 的证据上限 32 条（旧证据先淘汰）。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  canTransitionRelease,
  skillReleaseStatusSchema,
  type SkillReleaseStatus,
} from "./skill-gap.js";

// ---------------------------------------------------------------------------
// 证据契约（fixture runner 填写；coordinator/D4 展示）
// ---------------------------------------------------------------------------

export const releaseEvidenceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("bundle-exported"),
    contentHash: z.string().regex(/^[a-f0-9]{16,128}$/u),
    atMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("fixture-run"),
    /** fixture 标识（如 "vanilla-1.21.11" / "custom-offline-jar"）。 */
    fixtureId: z.string().min(1).max(64),
    passed: z.boolean(),
    /** rcon 真值检查明细（服务器侧断言，非客户端自证）。 */
    rconChecks: z.array(z.object({
      label: z.string().min(1).max(128),
      passed: z.boolean(),
    }).strict()).max(64),
    failures: z.array(z.string().max(300)).max(32),
    atMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    /** 真实服执行信号（无隔离服形态）：成功 invocation 的服务器侧验证。 */
    kind: z.literal("live-run"),
    serverProfileId: z.string().min(1).max(128),
    passed: z.boolean(),
    checks: z.array(z.object({
      label: z.string().min(1).max(128),
      passed: z.boolean(),
    }).strict()).max(64),
    failures: z.array(z.string().max(300)).max(32),
    atMs: z.number().int().nonnegative(),
  }).strict(),
  z.object({
    kind: z.literal("operator-decision"),
    operator: z.string().min(1).max(128),
    decision: z.enum(["promote-canary", "promote-active", "revoke"]),
    note: z.string().max(300).optional(),
    atMs: z.number().int().nonnegative(),
  }).strict(),
]);
export type ReleaseEvidence = z.infer<typeof releaseEvidenceSchema>;

// ---------------------------------------------------------------------------
// Release 记录
// ---------------------------------------------------------------------------

export const skillReleaseRecordSchema = z.object({
  schemaVersion: z.literal("1.0"),
  releaseId: z.string().min(8).max(64),
  /** 候选技能名（实现时确定；bundle 生成时可为空字符串）。 */
  skillId: z.string().min(1).max(128),
  /** 关联 gap fingerprint（可追溯回 SkillGapStore）。 */
  gapFingerprint: z.string().regex(/^[a-f0-9]{16,64}$/u),
  bundleContentHash: z.string().regex(/^[a-f0-9]{16,128}$/u),
  status: skillReleaseStatusSchema,
  evidence: z.array(releaseEvidenceSchema).max(32),
  createdAtMs: z.number().int().nonnegative(),
  updatedAtMs: z.number().int().nonnegative(),
}).strict();
export type SkillReleaseRecord = z.infer<typeof skillReleaseRecordSchema>;

export class SkillReleaseError extends Error {
  constructor(readonly code:
    | "RELEASE_TRANSITION_ILLEGAL"
    | "RELEASE_EVIDENCE_REQUIRED"
    | "RELEASE_OPERATOR_APPROVAL_REQUIRED"
    | "RELEASE_NOT_FOUND"
    | "RELEASE_PERSISTENCE_FAILED") {
    super(code);
    this.name = "SkillReleaseError";
  }
}

// ---------------------------------------------------------------------------
// 管线（内存态；FileSkillReleaseStore 提供持久化）
// ---------------------------------------------------------------------------

export class SkillReleasePipeline {
  private readonly records = new Map<string, SkillReleaseRecord>();
  private readonly now: () => number;
  /**
   * sandbox_auto 档（STUDIO_SKILL_DEV_MODE=sandbox_auto 时 coordinator 注入
   * true）：验收通过后自动连升到 canary（真实服在用即灰度），active 仍留
   * operator。默认 false：verified 停车、canary/active 都人审。
   */
  private readonly autoPromoteToCanary: boolean;

  constructor(options: { now?: () => number; autoPromoteToCanary?: boolean } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.autoPromoteToCanary = options.autoPromoteToCanary ?? false;
  }

  /** 管线入口：gap bundle 导出即建 draft。 */
  createDraftRelease(input: Readonly<{ skillId: string; gapFingerprint: string; bundleContentHash: string }>): SkillReleaseRecord {
    const nowMs = this.now();
    const record: SkillReleaseRecord = {
      schemaVersion: "1.0",
      releaseId: `rel-${randomUUID().slice(0, 12)}`,
      skillId: input.skillId,
      gapFingerprint: input.gapFingerprint,
      bundleContentHash: input.bundleContentHash,
      status: "draft",
      evidence: [{ kind: "bundle-exported", contentHash: input.bundleContentHash, atMs: nowMs }],
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    this.records.set(record.releaseId, record);
    return record;
  }

  get(releaseId: string): SkillReleaseRecord | null {
    return this.records.get(releaseId) ?? null;
  }

  list(): readonly SkillReleaseRecord[] {
    return [...this.records.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  /** 恢复持久化记录（store 调用）。 */
  restore(record: SkillReleaseRecord): void {
    this.records.set(record.releaseId, skillReleaseRecordSchema.parse(record));
  }

  /** sandboxed→verified：必须携带一条通过的 fixture-run 证据。 */
  recordFixtureRun(releaseId: string, evidence: Omit<Extract<ReleaseEvidence, { kind: "fixture-run" }>, "kind" | "atMs">): SkillReleaseRecord {
    const record = this.require(releaseId);
    const atMs = this.now();
    const run = releaseEvidenceSchema.parse({ ...evidence, kind: "fixture-run", atMs }) as Extract<ReleaseEvidence, { kind: "fixture-run" }>;
    return this.applyVerificationRun(record, run);
  }

  /** 无隔离服形态：真实服执行信号同样可推进 verified（用户显式开通的通道）。 */
  recordLiveRun(releaseId: string, evidence: Omit<Extract<ReleaseEvidence, { kind: "live-run" }>, "kind" | "atMs">): SkillReleaseRecord {
    const record = this.require(releaseId);
    const atMs = this.now();
    const run = releaseEvidenceSchema.parse({ ...evidence, kind: "live-run", atMs }) as Extract<ReleaseEvidence, { kind: "live-run" }>;
    return this.applyVerificationRun(record, run);
  }

  private applyVerificationRun(
    record: SkillReleaseRecord,
    run: Extract<ReleaseEvidence, { kind: "fixture-run" }> | Extract<ReleaseEvidence, { kind: "live-run" }>,
  ): SkillReleaseRecord {
    const updated = this.appendEvidence(record, run);
    this.records.set(record.releaseId, updated);
    if (record.status !== "sandboxed") return updated; // 非验收期证据只记录
    if (!run.passed) return updated; // 失败的 run 保留证据但不推进
    const verified = this.transition(record.releaseId, "verified");
    // sandbox_auto：验收通过自动连升 canary（在真实服使用即灰度）。
    if (this.autoPromoteToCanary && verified.status === "verified") {
      return this.transitionWithEvidence(record.releaseId, "canary", releaseEvidenceSchema.parse({
        kind: "operator-decision",
        operator: "sandbox-auto",
        decision: "promote-canary",
        note: "auto-promoted by STUDIO_SKILL_DEV_MODE=sandbox_auto after a passing verification run",
        atMs: this.now(),
      }));
    }
    return verified;
  }

  /** verified→canary→active：每步都必须有 operator-decision 证据。 */
  operatorDecision(
    releaseId: string,
    decision: "promote-canary" | "promote-active" | "revoke",
    operator: string,
    note?: string,
  ): SkillReleaseRecord {
    const record = this.require(releaseId);
    const atMs = this.now();
    const evidence = releaseEvidenceSchema.parse({
      kind: "operator-decision", operator, decision, ...(note !== undefined ? { note } : {}), atMs,
    });
    const target: SkillReleaseStatus = decision === "promote-canary" ? "canary"
      : decision === "promote-active" ? "active" : "revoked";
    if (record.status === target && target === "revoked") {
      return this.appendEvidence(record, evidence);
    }
    return this.transitionWithEvidence(releaseId, target, evidence);
  }

  private transition(releaseId: string, to: SkillReleaseStatus): SkillReleaseRecord {
    return this.transitionWithEvidence(releaseId, to, null);
  }

  private transitionWithEvidence(
    releaseId: string,
    to: SkillReleaseStatus,
    evidence: ReleaseEvidence | null,
  ): SkillReleaseRecord {
    const record = this.require(releaseId);
    if (!canTransitionRelease(record.status, to)) {
      throw new SkillReleaseError("RELEASE_TRANSITION_ILLEGAL");
    }
    if ((to === "canary" || to === "active") && (evidence === null || evidence.kind !== "operator-decision")) {
      throw new SkillReleaseError("RELEASE_OPERATOR_APPROVAL_REQUIRED");
    }
    if (to === "verified") {
      const hasPassingRun = record.evidence.some(
        (item) => (item.kind === "fixture-run" || item.kind === "live-run") && item.passed,
      ) || ((evidence?.kind === "fixture-run" && evidence.passed) || (evidence?.kind === "live-run" && evidence.passed));
      if (!hasPassingRun) throw new SkillReleaseError("RELEASE_EVIDENCE_REQUIRED");
    }
    if (to === "sandboxed") {
      const hasBundle = record.evidence.some((item) => item.kind === "bundle-exported");
      if (!hasBundle) throw new SkillReleaseError("RELEASE_EVIDENCE_REQUIRED");
    }
    let updated: SkillReleaseRecord = { ...record, status: to, updatedAtMs: this.now() };
    if (evidence !== null) updated = this.appendEvidence(updated, evidence);
    this.records.set(releaseId, updated);
    return updated;
  }

  /** draft→sandboxed：实现完成后进入验收（人记录，或 CI runner 调用）。 */
  promoteToSandboxed(releaseId: string): SkillReleaseRecord {
    return this.transition(releaseId, "sandboxed");
  }

  private appendEvidence(record: SkillReleaseRecord, evidence: ReleaseEvidence): SkillReleaseRecord {
    const bounded = [...record.evidence, evidence].slice(-32);
    return { ...record, evidence: bounded, updatedAtMs: this.now() };
  }

  private require(releaseId: string): SkillReleaseRecord {
    const record = this.records.get(releaseId);
    if (record === undefined) throw new SkillReleaseError("RELEASE_NOT_FOUND");
    return record;
  }
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

export class FileSkillReleaseStore {
  readonly pipeline: SkillReleasePipeline;

  constructor(dir: string, pipelineOptions: ConstructorParameters<typeof SkillReleasePipeline>[0] = {}) {
    this.pipeline = new SkillReleasePipeline(pipelineOptions);
    this.dir = dir;
    this.initialize();
  }

  private readonly dir: string;

  /** 便捷入口：draft 建立后立即落盘。 */
  createDraftRelease(input: Parameters<SkillReleasePipeline["createDraftRelease"]>[0]): SkillReleaseRecord {
    const record = this.pipeline.createDraftRelease(input);
    this.flush(record);
    return record;
  }

  /** 状态变更后持久化（由调用方在 pipeline 操作成功时调用）。 */
  persist(releaseId: string): void {
    const record = this.pipeline.get(releaseId);
    if (record === null) throw new SkillReleaseError("RELEASE_NOT_FOUND");
    this.flush(record);
  }

  list(): readonly SkillReleaseRecord[] {
    return this.pipeline.list();
  }

  private initialize(): void {
    let names: readonly string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!/^rel-[a-z0-9-]+\.json$/u.test(name)) continue;
      try {
        this.pipeline.restore(skillReleaseRecordSchema.parse(JSON.parse(readFileSync(path.join(this.dir, name), "utf8"))));
      } catch {
        continue; // corrupt 跳过
      }
    }
  }

  private flush(record: SkillReleaseRecord): void {
    const target = path.join(this.dir, `${record.releaseId}.json`);
    const temporary = `${target}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
      renameSync(temporary, target);
    } catch {
      try { unlinkSync(temporary); } catch { /* best effort */ }
      throw new SkillReleaseError("RELEASE_PERSISTENCE_FAILED");
    }
  }
}

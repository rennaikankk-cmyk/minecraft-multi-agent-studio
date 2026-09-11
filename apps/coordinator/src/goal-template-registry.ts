// ---------------------------------------------------------------------------
// goal-template-registry.ts —— 确定性 goal 模板注册表（自我改善闭环 D2）。
//
// 背景：8+ 格蓝图走 LLM 转写必挂（PLANNER_DECISION_INVALID 实证），确定性
// 模板是正确通道。本注册表把"施工蓝图行"从 parseDeterministicGoal 硬编码
// 迁出，成为一等公民——lesson/gap 复盘可发现新模式，经人审提案后补注册表
// 条目（解析器仍为代码，注册永不自动生成：sandbox_auto 永不开）。
//
// 纪律：
//   1. 零行为变更迁移：蓝图行模板的解析函数原样入表，调用顺序不变。
//   2. 注册表条目只做确定性解析（受控枚举/上界钳制），失败返回 null 走
//      模型分支——模板绝不比模型分支更"热心"。
//   3. 模板提案只落盘标记状态；approve 只表示"人确认值得做成模板"，
//      不产生任何运行时效果。
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { parseBlueprintGoal, type DeterministicGoal } from "./deterministic-goals.js";

// ---------------------------------------------------------------------------
// 解析注册表
// ---------------------------------------------------------------------------

export interface GoalTemplateEntry {
  readonly templateId: string;
  /** 确定性解析；null=该模板不适用（继续走后续模板/模型分支）。 */
  readonly parse: (operatorGoal: string) => DeterministicGoal | null;
}

const entries: GoalTemplateEntry[] = [
  {
    // Round 6.5 蓝图行模板原样迁入（J1-large 8/8 的回归主体）。
    templateId: "blueprint-row",
    parse: parseBlueprintGoal,
  },
];

export function registerGoalTemplate(entry: GoalTemplateEntry): void {
  if (entries.some((existing) => existing.templateId === entry.templateId)) {
    throw new Error(`goal template already registered: ${entry.templateId}`);
  }
  entries.push(entry);
}

export function registeredGoalTemplateIds(): readonly string[] {
  return entries.map((entry) => entry.templateId);
}

/** 按注册顺序尝试全部模板；先注册先用。 */
export function parseViaGoalTemplateRegistry(operatorGoal: string): DeterministicGoal | null {
  for (const entry of entries) {
    const parsed = entry.parse(operatorGoal);
    if (parsed !== null) return parsed;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 模板提案（复盘发现模式 → 人审 → 手工实现注册表条目）
// ---------------------------------------------------------------------------

export const goalTemplateProposalSchema = z.object({
  schemaVersion: z.literal("1.0"),
  proposalId: z.string().min(8).max(64),
  source: z.enum(["lesson", "gap", "manual"]),
  /** 触发提案的模式示例（来自 lesson goalPattern 或 gap actionFamily）。 */
  patternExample: z.string().min(1).max(200),
  rationale: z.string().min(1).max(400),
  status: z.enum(["proposed", "approved", "rejected"]),
  proposedAtMs: z.number().int().nonnegative(),
  reviewedAtMs: z.number().int().nonnegative().nullable(),
}).strict();
export type GoalTemplateProposal = z.infer<typeof goalTemplateProposalSchema>;

export class FileGoalTemplateProposalStore {
  constructor(private readonly dir: string) {}

  propose(input: Readonly<{ source: GoalTemplateProposal["source"]; patternExample: string; rationale: string }>): GoalTemplateProposal {
    const proposal: GoalTemplateProposal = {
      schemaVersion: "1.0",
      proposalId: `gtp-${randomUUID().slice(0, 12)}`,
      source: input.source,
      patternExample: input.patternExample.slice(0, 200),
      rationale: input.rationale.slice(0, 400),
      status: "proposed",
      proposedAtMs: Date.now(),
      reviewedAtMs: null,
    };
    this.atomicWrite(proposal);
    return proposal;
  }

  review(proposalId: string, status: "approved" | "rejected"): GoalTemplateProposal | null {
    const existing = this.list().find((proposal) => proposal.proposalId === proposalId);
    if (existing === undefined || existing.status !== "proposed") return null;
    const reviewed: GoalTemplateProposal = { ...existing, status, reviewedAtMs: Date.now() };
    this.atomicWrite(reviewed);
    return reviewed;
  }

  list(status?: GoalTemplateProposal["status"]): readonly GoalTemplateProposal[] {
    let names: readonly string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    const proposals: GoalTemplateProposal[] = [];
    for (const name of names) {
      if (!/\.json$/u.test(name)) continue;
      try {
        const parsed = goalTemplateProposalSchema.parse(JSON.parse(readFileSync(path.join(this.dir, name), "utf8")));
        if (status === undefined || parsed.status === status) proposals.push(parsed);
      } catch {
        continue; // corrupt 文件跳过：提案是增强不是前置
      }
    }
    return proposals.sort((a, b) => b.proposedAtMs - a.proposedAtMs);
  }

  private atomicWrite(proposal: GoalTemplateProposal): void {
    const target = path.join(this.dir, `${proposal.proposalId}.json`);
    const temporary = `${target}.tmp`;
    let descriptor: number | undefined;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      descriptor = openSync(temporary, "wx", 0o600);
      writeFileSync(descriptor, JSON.stringify(proposal));
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
      renameSync(temporary, target);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
      try { unlinkSync(temporary); } catch { /* Only our own temporary file. */ }
    }
  }
}

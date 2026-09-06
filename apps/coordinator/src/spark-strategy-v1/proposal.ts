// spark-strategy-v1/proposal.ts —— 全队策略建议 schema 与解析（纯函数）。
//
// 一期指令 §5：建议输出按现有协议风格（zod）结构化；解析器对模型响应的
// 失败形态（非法 JSON/截断/空/reasoning-only）分账，不静默归零。

import { z } from "zod";

export const proposalActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("skill"),
    skillId: z.string().min(1),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    targetRef: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("deterministicGoal"),
    /** 复用 coordinator 确定性 goal 模板族（parseXxxGoal 可解析的文本）。 */
    template: z.enum(["acquisition", "blueprint", "movement", "food", "scan"]),
    goalText: z.string().min(1),
    /** Only trusted code expands {{target}} to coordinates for the real parser. */
    targetRef: z.string().min(1).optional(),
  }),
  z.object({
    kind: z.literal("noop"),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal("wait"),
    reason: z.string().min(1),
  }),
]);
export type ProposalAction = z.infer<typeof proposalActionSchema>;

export const failureAlternativeSchema = z.object({
  strategy: z.enum(["wait", "escalate", "alternative"]),
  reason: z.string().min(1),
  /** strategy=alternative 时的替代动作（单条，不再嵌套替代链）。 */
  alternative: proposalActionSchema.optional(),
}).superRefine((value, ctx) => {
  if ((value.strategy === "alternative") !== (value.alternative !== undefined)) {
    ctx.addIssue({ code: "custom", message: "alternative is required exactly when strategy=alternative" });
  }
});
export type FailureAlternative = z.infer<typeof failureAlternativeSchema>;

export const assignmentSchema = z.object({
  assignmentId: z.string().min(1),
  botId: z.string().min(1),
  role: z.string().min(1),
  action: proposalActionSchema,
  /** 采用前提（自由文本条件；集成期重新校验）。 */
  preconditions: z.array(z.string()).default([]),
  /** 本建议要求已满足的阶段门（对照事实约束里的 phaseGates）。 */
  requiredGates: z.array(z.string()).default([]),
  /** 需要占用的资源/设施不透明引用。 */
  resources: z.array(z.string()).default([]),
  /** 可观察的成功条件（skill/goal 动作必填，验证器强制）。 */
  successSignals: z.array(z.string()).default([]),
  /** 有界重试上限（skill/goal 动作必填，1..10）。 */
  maxAttempts: z.number().int().min(1).max(10).optional(),
  onFailure: failureAlternativeSchema.optional(),
});
export type Assignment = z.infer<typeof assignmentSchema>;

export const dependencySchema = z.object({
  afterId: z.string().min(1),
  beforeId: z.string().min(1),
});
export type Dependency = z.infer<typeof dependencySchema>;

export const teamProposalSchema = z.object({
  proposalId: z.string().min(1),
  /** 建议所依据的事实版本（必须等于摘要的 factVersion 才可验证通过）。 */
  factVersion: z.string().min(1),
  scope: z.object({
    serverProfileId: z.string().min(1),
    dimension: z.string().min(1),
  }),
  validUntilMs: z.number().int().nonnegative(),
  generatedBy: z.string().min(1),
  objective: z.string().min(1),
  assignments: z.array(assignmentSchema).min(1),
  dependencies: z.array(dependencySchema).default([]),
  notes: z.string().optional(),
});
export type TeamProposal = z.infer<typeof teamProposalSchema>;

// ---------------------------------------------------------------------------
// 模型响应解析分账（§7 验收：超时/取消/截断/非法 JSON/reasoning-only/空
// 各自正确归类，不冒充有效建议）。
// ---------------------------------------------------------------------------

export type ParseOutcome =
  | { ok: true; proposal: TeamProposal }
  | {
      ok: false;
      reason:
        | "invalid-json"
        | "schema-invalid"
        | "empty-response"
        | "reasoning-only"
        | "truncated-json";
      detail: string;
    };

/** 从模型响应文本提取建议。截断判定：JSON 括号不平衡=truncated-json。 */
export function parseProposalResponse(responseText: string): ParseOutcome {
  const trimmed = responseText.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "empty-response", detail: "model returned empty content" };
  }
  // 提取首个 { 到末个 } 的候选 JSON 段（容忍 reasoning 前后缀）。
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return {
      ok: false,
      reason: /<(think|thinking|reasoning)>/i.test(trimmed) || /\breasoning\b/i.test(trimmed.slice(0, 200))
        ? "reasoning-only"
        : "invalid-json",
      detail: "no JSON object found in response",
    };
  }
  const candidate = trimmed.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    const open = (candidate.match(/\{/g) ?? []).length;
    const close = (candidate.match(/\}/g) ?? []).length;
    return {
      ok: false,
      reason: open > close ? "truncated-json" : "invalid-json",
      detail: `JSON.parse failed (braces ${open}/${close})`,
    };
  }
  const validated = teamProposalSchema.safeParse(parsed);
  if (!validated.success) {
    return {
      ok: false,
      reason: "schema-invalid",
      detail: validated.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500),
    };
  }
  return { ok: true, proposal: validated.data };
}

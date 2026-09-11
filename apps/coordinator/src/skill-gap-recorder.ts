// ---------------------------------------------------------------------------
// skill-gap-recorder.ts —— task 失败终态 → SkillGap 自动入册（自我改善
// 闭环 D1 接线层）。
//
// 纪律：
//   1. 证据不足不产 gap：catalog 状态依赖型 kind 在没有 requestedSkillId
//      （goal 文本中的点号技能名）时直接丢弃——绝大多数执行失败不是能力
//      缺口，宁可漏报不误报。
//   2. 分类只看 stable FailureCode（skill-gap.ts 分类器），包装层只负责
//      从 TaskExecutionRecord 提取输入。
//   3. recorder 内部异常绝不影响 planner（onTaskAborted 已兜底）。
// ---------------------------------------------------------------------------

import {
  classifyGap,
  gapFingerprint,
  type SkillGapStore,
} from "@minecraft-studio/skills";
import type { TaskExecutionRecord } from "@minecraft-studio/task-system";

/** catalog 状态依赖型 kind：没有 requestedSkillId 证据时不下这些结论。 */
const CATALOG_DEPENDENT_KINDS: ReadonlySet<string> = new Set([
  "skill_not_advertised",
  "capability_backend_missing",
  "capability_not_available",
  "existing_skill_composition_missing",
  "unknown_gap",
  "skill_not_compatible",
]);

export type SkillGapRecorderProject = Readonly<{
  gitCommit: string;
  branch: string;
  buildVersion: string;
  dirty: boolean;
}>;

export function createSkillGapRecorder(options: Readonly<{
  store: SkillGapStore;
  catalogSkillIds: readonly string[];
  project: SkillGapRecorderProject;
  serverProfileFor: (botId: string) => string | null;
  minecraftVersionFor: (botId: string) => string | undefined;
  now?: () => number;
  log?: (event: string, fields: Readonly<Record<string, unknown>>) => void;
}>): (record: TaskExecutionRecord) => void {
  const catalog = new Set(options.catalogSkillIds);
  return (record) => {
    try {
      const terminalFailureCode = extractFailureCode(record.failureReason ?? "");
      if (terminalFailureCode === null) return;
      const requestedSkillId = extractSkillId(record.goal) ?? undefined;
      const actionFamily = actionFamilyFor(terminalFailureCode, requestedSkillId);
      const kind = classifyGap({
        terminalFailureCode,
        causedByFailureCodes: [],
        actionFamily,
        ...(requestedSkillId !== undefined ? { requestedSkillId } : {}),
        skillExists: requestedSkillId !== undefined && catalog.has(requestedSkillId),
        skillCompatible: true,
        hasCompositionCandidate: false,
        capabilityAvailable: true,
        policyDenied: false,
      });
      if (kind === null) return;
      if (CATALOG_DEPENDENT_KINDS.has(kind) && requestedSkillId === undefined) return;
      const serverProfileId = options.serverProfileFor(record.botId);
      if (serverProfileId === null) return;
      const minecraftVersion = options.minecraftVersionFor(record.botId);
      const nowMs = options.now?.() ?? Date.now();
      const stored = options.store.record({
        fingerprint: gapFingerprint({
          kind,
          actionFamily,
          terminalFailureCode,
          ...(requestedSkillId !== undefined ? { requestedSkillId } : {}),
          ...(minecraftVersion ? { minecraftVersion } : {}),
        }),
        kind,
        severity: "warning",
        project: options.project,
        runtime: {
          botId: record.botId,
          serverProfileId,
          ...(minecraftVersion ? { minecraftVersion } : {}),
        },
        goal: {
          goalText: record.goal.slice(0, 500),
          taskId: record.taskId,
          requestedOutcome: "goal-completion",
        },
        gap: {
          ...(requestedSkillId !== undefined ? { requestedSkillId } : {}),
          actionFamily,
          terminalFailureCode,
          causedByFailureCodes: [],
        },
        linkedIncidentIds: [],
      });
      options.log?.("coordinator_skill_gap_recorded", {
        fingerprint: stored.fingerprint,
        kind,
        occurrenceCount: stored.occurrenceCount,
      });
    } catch (error) {
      options.log?.("coordinator_skill_gap_record_failed", {
        detail: error instanceof Error ? error.message.slice(0, 200) : String(error),
      });
    }
  };
}

/** failureReason 的主错误码（"CODE" 或 "CODE: detail"）。 */
export function extractFailureCode(failureReason: string): string | null {
  const code = failureReason.split(":")[0]!.trim().toUpperCase();
  if (!/^[A-Z][A-Z0-9_]{2,63}$/u.test(code)) return null;
  return code;
}

/** goal 文本中的点号技能名（family.name 形态，catalog 惯例）。 */
export function extractSkillId(goalText: string): string | null {
  const match = goalText.match(/\b([a-z][a-z0-9]*)\.([a-z][a-z0-9-]*)\b/u);
  return match === null ? null : match[0];
}

/** actionFamily：从错误码前缀推断动作族（确定性，无日志解析）。 */
export function actionFamilyFor(terminalFailureCode: string, requestedSkillId?: string): string {
  if (requestedSkillId !== undefined) return requestedSkillId.split(".")[0]!;
  const prefix = terminalFailureCode.split("_")[0]!.toLowerCase();
  return prefix.length >= 3 ? prefix : "general";
}

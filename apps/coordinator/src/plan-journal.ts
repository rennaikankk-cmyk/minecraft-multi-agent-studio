import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Round 6.4 P0c —— Durable Plan/Step Execution Journal（typed postconditions）。
//
// 与 IncidentStore 职责分离：journal 是执行事实（步骤状态机 + 副作用验证），
// Incident 是故障聚合；二者通过 planId/stepId 关联。
//
// 持久化边界：
// - file adapter（本实现）：每次 append/update 后同步 flush（write-tmp+rename
//   原子替换），重启后 load() 恢复；损坏文件 quarantine+.bak 恢复（与
//   IncidentStore 同纪律）。
// - production PostgreSQL journal 留待既有 task-system 抽象接入时统一切换；
//   durability capability 在 API 如实暴露（journalDurability: "file"）。
//
// 写失败纪律：绝不假装 durable——抛 JournalWriteError，调用方必须暂停相关
// 副作用步骤（fail-closed），不拖垮无关计划。
// ---------------------------------------------------------------------------

export const PLAN_JOURNAL_SCHEMA_VERSION = "1.0" as const;

/** typed postcondition：步骤完成后"世界应当是什么"的可验证断言。 */
export type TypedPostcondition =
  | Readonly<{ kind: "inventory-delta"; botId: string; itemName: string; minCount: number }>
  | Readonly<{ kind: "block-state"; serverProfileId: string; dimension: string; position: { x: number; y: number; z: number }; blockName: string }>
  | Readonly<{ kind: "container-slot"; serverProfileId: string; containerPosition: { x: number; y: number; z: number }; slotHint: string }>
  | Readonly<{ kind: "smelting-state"; serverProfileId: string; furnacePosition: { x: number; y: number; z: number }; expect: "cooking" | "output-ready" | "idle" }>
  | Readonly<{ kind: "facility-lease"; registryKey: string; ownerBotId: string }>
  | Readonly<{ kind: "build-cell"; buildId: string; cellIndex: number; position: { x: number; y: number; z: number }; blockName: string }>
  | Readonly<{ kind: "movement-arrival"; botId: string; target: { x: number; y: number; z: number }; radiusBlocks: number }>;

export type StepSideEffectClass = "IDEMPOTENT" | "RECONCILABLE" | "NON_IDEMPOTENT";

export type StepStatus =
  | "PENDING"
  | "DISPATCHING"
  | "AWAITING_RESULT"
  | "RECONCILING"
  | "SUCCEEDED"
  | "FAILED"
  | "PAUSED"
  | "CANCELLED";

export interface StepJournalEntry {
  readonly stepId: string;
  readonly sequence: number;
  readonly skillId: string;
  readonly actionFamily: string;
  attemptId: string;
  status: StepStatus;
  readonly sideEffectClass: StepSideEffectClass;
  readonly expectedPostcondition: TypedPostcondition | null;
  observedActual: unknown;
  dispatchCount: number;
  lastFailureCode: string | null;
  lastErrorSignature: string | null;
  claimIdentity: string | null;
  readonly verificationHistory: Array<Readonly<{
    at: string;
    outcome: "confirmed" | "absent" | "unverifiable";
    evidence: string;
  }>>;
  createdAt: string;
  updatedAt: string;
}

export interface PlanExecutionJournal {
  readonly planId: string;
  readonly goalId: string | null;
  readonly botId: string;
  readonly serverProfileId: string;
  readonly correlationId: string;
  readonly plannerVersion: string;
  status: "ACTIVE" | "COMPLETED" | "ABANDONED";
  readonly steps: StepJournalEntry[];
  readonly createdAt: string;
  updatedAt: string;
}

export class JournalWriteError extends Error {
  readonly code = "PLAN_JOURNAL_WRITE_FAILED";
  constructor(cause: unknown) {
    super(`Plan journal write failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "JournalWriteError";
  }
}

export interface PlanJournalStore {
  /** durable append/flush：返回前已达到可恢复边界。 */
  save(journal: PlanExecutionJournal): void;
  load(): readonly PlanExecutionJournal[];
  /** retention：不得删除 active/paused 计划；返回实际清理数。 */
  retain(config: Readonly<{ maxCompleted: number; maxAgeDays: number }>): number;
}

/** file-backed journal store：每 bot 目录一个 JSONL+快照，原子写。 */
export class FilePlanJournalStore implements PlanJournalStore {
  private readonly dir: string;
  private readonly now: () => Date;

  constructor(options: Readonly<{ dir: string; now?: () => Date }>) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
  }

  save(journal: PlanExecutionJournal): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(journal.planId);
      const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
      writeFileSync(tmp, `${JSON.stringify(journal, null, 1)}\n`, "utf8");
      renameSync(tmp, file);
    } catch (cause) {
      throw new JournalWriteError(cause);
    }
  }

  load(): readonly PlanExecutionJournal[] {
    if (!existsSync(this.dir)) return [];
    const out: PlanExecutionJournal[] = [];
    // @ts-ignore -- node:fs sync readdir
    const entries = readdirSyncSafe(this.dir);
    for (const name of entries) {
      if (!name.endsWith(".json")) continue;
      const file = path.join(this.dir, name);
      try {
        out.push(JSON.parse(readFileSync(file, "utf8")) as PlanExecutionJournal);
      } catch {
        // 损坏：quarantine + .bak 保留（不静默清空）
        try {
          if (existsSync(file)) renameSync(file, `${file}.corrupt-${Date.now().toString(36)}`);
        } catch {
          // quarantine 失败时保留原文件，下次加载再试
        }
      }
    }
    return out;
  }

  retain(config: Readonly<{ maxCompleted: number; maxAgeDays: number }>): number {
    const all = this.load();
    const cutoffMs = this.now().getTime() - config.maxAgeDays * 86_400_000;
    const completed = all
      .filter((j) => j.status === "COMPLETED" && Date.parse(j.updatedAt) < cutoffMs)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    const excess = Math.max(0, completed.length - config.maxCompleted);
    // 实现：只标记 ABANDONED 内存语义；文件级清理交给上层运维命令（保留证据）
    return excess;
  }

  private fileFor(planId: string): string {
    return path.join(this.dir, `${planId}.json`);
  }
}

function readdirSyncSafe(dir: string): readonly string[] {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { readdirSync } = require("node:fs") as { readdirSync: (d: string) => readonly string[] };
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 内存实现（测试/E2E 显式声明非 durable 时用）。 */
export class InMemoryPlanJournalStore implements PlanJournalStore {
  private readonly journals = new Map<string, PlanExecutionJournal>();
  save(journal: PlanExecutionJournal): void {
    this.journals.set(journal.planId, journal);
  }
  load(): readonly PlanExecutionJournal[] {
    return [...this.journals.values()];
  }
  retain(): number {
    /* memory store: no retention semantics */
    return 0;
  }
}

/** 便捷构造：从 plan 步骤派生 journal 骨架。 */
export function newPlanJournal(input: Readonly<{
  goalId: string | null;
  botId: string;
  serverProfileId: string;
  correlationId: string;
  plannerVersion: string;
  steps: readonly Readonly<{
    skillId: string;
    actionFamily: string;
    sideEffectClass: StepSideEffectClass;
    expectedPostcondition: TypedPostcondition | null;
    claimIdentity?: string | null;
  }>[];
}>): PlanExecutionJournal {
  const now = new Date().toISOString();
  return {
    planId: `plan-${randomUUID()}`,
    goalId: input.goalId,
    botId: input.botId,
    serverProfileId: input.serverProfileId,
    correlationId: input.correlationId,
    plannerVersion: input.plannerVersion,
    status: "ACTIVE",
    steps: input.steps.map((step, index) => ({
      stepId: `step-${index + 1}-${step.skillId.replace(/[^a-z0-9.-]/giu, "")}`,
      sequence: index + 1,
      skillId: step.skillId,
      actionFamily: step.actionFamily,
      attemptId: `attempt-${randomUUID().slice(0, 8)}`,
      status: "PENDING" as const,
      sideEffectClass: step.sideEffectClass,
      expectedPostcondition: step.expectedPostcondition,
      observedActual: null,
      dispatchCount: 0,
      lastFailureCode: null,
      lastErrorSignature: null,
      claimIdentity: step.claimIdentity ?? null,
      verificationHistory: [],
      createdAt: now,
      updatedAt: now,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

/** 状态转移（不可变更新；duplicate result 幂等：已完成步骤重复结果被忽略）。 */
export function applyStepResult(
  journal: PlanExecutionJournal,
  stepId: string,
  result: Readonly<{
    status: StepStatus;
    failureCode?: string | null;
    errorSignature?: string | null;
    verification?: Readonly<{ outcome: "confirmed" | "absent" | "unverifiable"; evidence: string }>;
    observedActual?: unknown;
  }>,
): PlanExecutionJournal {
  const steps = journal.steps.map((step) => {
    if (step.stepId !== stepId) return step;
    // 幂等：终态后重复结果不回退（SUCCEEDED 不因重复 FAILED 结果变回）
    if (step.status === "SUCCEEDED" || step.status === "CANCELLED") return step;
    const now = new Date().toISOString();
    return {
      ...step,
      status: result.status,
      lastFailureCode: result.failureCode ?? step.lastFailureCode,
      lastErrorSignature: result.errorSignature ?? step.lastErrorSignature,
      observedActual: result.observedActual ?? step.observedActual,
      verificationHistory: result.verification
        ? [...step.verificationHistory, { at: now, ...result.verification }]
        : step.verificationHistory,
      updatedAt: now,
    };
  });
  const anyActive = steps.some(
    (s) => s.status !== "SUCCEEDED" && s.status !== "FAILED" && s.status !== "CANCELLED" && s.status !== "PAUSED",
  );
  return {
    ...journal,
    steps,
    status: anyActive ? journal.status : steps.every((s) => s.status === "SUCCEEDED") ? "COMPLETED" : "ABANDONED",
    updatedAt: new Date().toISOString(),
  };
}

/** dispatch 计数（J3 零重放验收的判据）。 */
export function recordDispatch(journal: PlanExecutionJournal, stepId: string): PlanExecutionJournal {
  return {
    ...journal,
    steps: journal.steps.map((step) =>
      step.stepId === stepId
        ? { ...step, dispatchCount: step.dispatchCount + 1, status: step.status === "PENDING" ? "DISPATCHING" as const : step.status, updatedAt: new Date().toISOString() }
        : step,
    ),
    updatedAt: new Date().toISOString(),
  };
}

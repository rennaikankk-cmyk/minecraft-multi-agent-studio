import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { blueprintSchema, type Blueprint } from "@minecraft-studio/skills";

// ---------------------------------------------------------------------------
// Round 6.4 P0c —— Durable Plan/Step Execution Journal（typed postconditions）。
//
// 与 IncidentStore 职责分离：journal 是执行事实（步骤状态机 + 副作用验证），
// Incident 是故障聚合；二者通过 planId/stepId 关联。
//
// 持久化边界：
// - File adapter: write-tmp + atomic rename; process recovery only, no fsync
//   or host power-loss guarantee. Corruption blocks recovery, originals remain.
// - production PostgreSQL journal 留待既有 task-system 抽象接入时统一切换；
//   durability capability 在 API 如实暴露（journalDurability: "file"）。
//
// 写失败纪律：绝不假装 durable——抛 JournalWriteError，调用方必须暂停相关
// 副作用步骤（fail-closed），不拖垮无关计划。
// ---------------------------------------------------------------------------

export const PLAN_JOURNAL_SCHEMA_VERSION = "1.1" as const;

export interface BuildJournalIdentity {
  readonly baseId: string;
  readonly buildId: string;
  readonly blueprintId: string;
  readonly blueprintVersion: string;
  readonly blueprint: Blueprint;
  readonly dimension: string;
  readonly anchor: Blueprint["anchor"];
  nextIndex: number;
  verification: "UNVERIFIED" | "RECOVERING" | "VERIFIED" | "DAMAGED";
  observedRuntimeInstanceId?: string;
  execution?: { coordinatorInstanceId: string; runtimeInstanceId: string; taskId: string; invocationId?: string };
}

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
  readonly schemaVersion: typeof PLAN_JOURNAL_SCHEMA_VERSION;
  readonly revision: number;
  readonly build?: BuildJournalIdentity;
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

export class JournalReadError extends Error {
  readonly code = "PLAN_JOURNAL_RECOVERY_BLOCKED";
  constructor(readonly issues: readonly string[]) {
    super("Plan journal recovery requires inspection: " + issues.join(", "));
    this.name = "JournalReadError";
  }
}

const journalSchema = z.object({
  schemaVersion: z.literal(PLAN_JOURNAL_SCHEMA_VERSION), revision: z.number().int().nonnegative(),
  planId: z.string().regex(/^[a-zA-Z0-9_.-]{1,180}$/),
  goalId: z.string().nullable(), botId: z.string().min(1), serverProfileId: z.string().min(1),
  correlationId: z.string(), plannerVersion: z.string(),
  status: z.enum(["ACTIVE", "COMPLETED", "ABANDONED"]),
  createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  steps: z.array(z.object({
    stepId: z.string(), sequence: z.number().int().positive(), skillId: z.string(),
    actionFamily: z.string(), attemptId: z.string().min(1),
    status: z.enum(["PENDING", "DISPATCHING", "AWAITING_RESULT", "RECONCILING", "SUCCEEDED", "FAILED", "PAUSED", "CANCELLED"]),
    sideEffectClass: z.enum(["IDEMPOTENT", "RECONCILABLE", "NON_IDEMPOTENT"]),
    expectedPostcondition: z.object({ kind: z.string() }).passthrough().nullable(),
    observedActual: z.unknown(), dispatchCount: z.number().int().nonnegative(),
    lastFailureCode: z.string().nullable(), lastErrorSignature: z.string().nullable(), claimIdentity: z.string().nullable(),
    verificationHistory: z.array(z.object({
      at: z.iso.datetime(), outcome: z.enum(["confirmed", "absent", "unverifiable"]), evidence: z.string(),
    })).max(1024),
    createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  })).max(2048),
  build: z.object({
    baseId: z.string().min(1), buildId: z.string().min(1), blueprintId: z.string().min(1),
    blueprintVersion: z.string().min(1), blueprint: blueprintSchema,
    dimension: z.string().min(1), anchor: blueprintSchema.shape.anchor,
    nextIndex: z.number().int().min(0).max(512),
    verification: z.enum(["UNVERIFIED", "RECOVERING", "VERIFIED", "DAMAGED"]),
    observedRuntimeInstanceId: z.string().min(1).optional(),
    execution: z.object({ coordinatorInstanceId: z.string(), runtimeInstanceId: z.string(), taskId: z.string(), invocationId: z.string().optional() }).optional(),
  }).optional(),
}).superRefine((j, ctx) => {
  if (j.build && (j.build.blueprint.serverProfileId !== j.serverProfileId ||
    j.build.dimension !== j.build.blueprint.dimension ||
    JSON.stringify(j.build.anchor) !== JSON.stringify(j.build.blueprint.anchor) ||
    j.build.nextIndex > j.build.blueprint.cells.length)) {
    ctx.addIssue({ code: "custom", message: "build identity mismatch" });
  }
});

export interface PlanJournalStore {
  /** Atomic process-recoverable replacement; does not promise power-loss durability. */
  save(journal: PlanExecutionJournal): void;
  load(): readonly PlanExecutionJournal[];
  /** retention：不得删除 active/paused 计划；返回实际清理数。 */
  retain(config: Readonly<{ maxCompleted: number; maxAgeDays: number }>): number;
}

/** One JSON snapshot per plan in a stable, single-writer directory. */
export class FilePlanJournalStore implements PlanJournalStore {
  private readonly dir: string;
  private readonly now: () => Date;
  private cache: Map<string, PlanExecutionJournal> | null = null;
  private recoveryError: JournalReadError | null = null;

  constructor(options: Readonly<{ dir: string; now?: () => Date }>) {
    this.dir = options.dir;
    this.now = options.now ?? (() => new Date());
  }

  save(journal: PlanExecutionJournal): void {
    try {
      journalSchema.parse(journal);
      if (!this.cache) this.load();
      if (this.recoveryError) throw this.recoveryError;
      const previous = this.cache?.get(journal.planId);
      if (previous && (previous.revision > journal.revision ||
        (previous.revision === journal.revision && JSON.stringify(previous) !== JSON.stringify(journal)))) {
        throw new Error("journal_revision_conflict");
      }
      mkdirSync(this.dir, { recursive: true });
      const file = this.fileFor(journal.planId);
      const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
      writeFileSync(tmp, `${JSON.stringify(journal, null, 1)}\n`, "utf8");
      renameSync(tmp, file);
      this.cache?.set(journal.planId, structuredClone(journal));
    } catch (cause) {
      throw new JournalWriteError(cause);
    }
  }

  load(): readonly PlanExecutionJournal[] {
    if (this.recoveryError) throw this.recoveryError;
    if (this.cache) return structuredClone([...this.cache.values()]);
    const out = new Map<string, PlanExecutionJournal>();
    const issues: string[] = [];
    let inspected = 0;
    const scan = (dir: string, legacy: boolean): void => {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && !legacy) return;
        issues.push("DIRECTORY_READ_FAILED"); return;
      }
      if (entries.length > 2048) { issues.push("RECOVERY_LIMIT_EXCEEDED"); return; }
      for (const entry of entries) {
        if (++inspected > 4096) { issues.push("RECOVERY_LIMIT_EXCEEDED"); return; }
        if (!legacy && entry.isDirectory() && entry.name.startsWith("coordinator-")) {
          scan(path.join(dir, entry.name), true);
        } else if (entry.isFile() && entry.name.endsWith(".json")) {
          try {
            const file = path.join(dir, entry.name);
            if (statSync(file).size > 2 * 1024 * 1024) throw new Error("oversized");
            const raw = JSON.parse(readFileSync(file, "utf8"));
            if (raw.schemaVersion === undefined || raw.schemaVersion === "1.0") {
              // Old build records have no blueprint or batch boundary to recover safely.
              if (raw.steps?.some((s: { skillId?: string }) => s.skillId === "build.blueprint")) {
                issues.push("LEGACY_BUILD_IDENTITY_INCOMPLETE"); continue;
              }
              raw.schemaVersion = PLAN_JOURNAL_SCHEMA_VERSION;
              raw.revision = 0;
            }
            const journal = journalSchema.parse(raw) as PlanExecutionJournal;
            const previous = out.get(journal.planId);
            if (previous && (previous.serverProfileId !== journal.serverProfileId ||
              previous.correlationId !== journal.correlationId ||
              JSON.stringify(previous.build && { ...previous.build, nextIndex: 0, verification: "", execution: undefined, observedRuntimeInstanceId: undefined }) !==
                JSON.stringify(journal.build && { ...journal.build, nextIndex: 0, verification: "", execution: undefined, observedRuntimeInstanceId: undefined }) ||
              (previous.revision === journal.revision && JSON.stringify(previous) !== JSON.stringify(journal)))) {
              issues.push("JOURNAL_IDENTITY_OR_REVISION_CONFLICT"); continue;
            }
            if (!previous || previous.revision < journal.revision) out.set(journal.planId, journal);
          } catch { issues.push("JOURNAL_INVALID_OR_UNREADABLE"); }
        }
      }
    };
    scan(this.dir, false);
    if (issues.length) {
      this.recoveryError = new JournalReadError([...new Set(issues)]);
      throw this.recoveryError;
    }
    this.cache = out;
    return structuredClone([...out.values()]);
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

/** 内存实现（测试/E2E 显式声明非 durable 时用）。 */
export class InMemoryPlanJournalStore implements PlanJournalStore {
  private readonly journals = new Map<string, PlanExecutionJournal>();
  save(journal: PlanExecutionJournal): void {
    this.journals.set(journal.planId, structuredClone(journal));
  }
  load(): readonly PlanExecutionJournal[] {
    return structuredClone([...this.journals.values()]);
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
    schemaVersion: PLAN_JOURNAL_SCHEMA_VERSION,
    revision: 0,
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
    (s) => s.status !== "SUCCEEDED" && s.status !== "FAILED" && s.status !== "CANCELLED",
  );
  return {
    ...journal,
    steps,
    revision: journal.revision + 1,
    status: anyActive ? journal.status : steps.every((s) => s.status === "SUCCEEDED") ? "COMPLETED" : "ABANDONED",
    updatedAt: new Date().toISOString(),
  };
}

/** dispatch 计数（J3 零重放验收的判据）。 */
export function recordDispatch(journal: PlanExecutionJournal, stepId: string): PlanExecutionJournal {
  return {
    ...journal,
    revision: journal.revision + 1,
    steps: journal.steps.map((step) =>
      step.stepId === stepId
        ? { ...step, dispatchCount: step.dispatchCount + 1, status: step.status === "PENDING" ? "DISPATCHING" as const : step.status, updatedAt: new Date().toISOString() }
        : step,
    ),
    updatedAt: new Date().toISOString(),
  };
}

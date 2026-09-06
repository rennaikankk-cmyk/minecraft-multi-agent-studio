import { randomUUID } from "node:crypto";
import {
  advanceCompositeTask,
  compositeTaskSchema,
  type CompositeKind,
  type CompositeTask,
  type CompositeTaskStore,
  InMemoryCompositeTaskStore,
} from "./composite-task.js";
import {
  PersistentTaskStateMachine,
  type TaskExecutionRecord,
  type TaskExecutionState,
  type TaskExecutionStore,
} from "./task-fsm.js";
import { skillJsonValueSchema } from "@minecraft-studio/protocol";

export type CompositeSkillStep = Readonly<{
  phase: string;
  skillId: string;
  input: unknown;
}>;

export type CompositeSkillDispatcher = (input: Readonly<{
  task: CompositeTask;
  child: TaskExecutionRecord;
  step: CompositeSkillStep;
}>) => Promise<Readonly<{ ok: boolean; evidence?: readonly string[]; output?: unknown; errorCode?: string }>>;

const PHASES: Readonly<Record<CompositeKind, readonly string[]>> = {
  SURVIVAL_RESUPPLY: ["escape_spawn", "secure_food", "equip_armor"],
  BLUEPRINT_BUILD: ["site_assess", "build_blueprint", "verify_structure"],
  FOOD_FACILITY: ["prepare_site", "build_food_facility", "sustain_food"],
  RESOURCE_PRODUCTION: ["prepare_site", "build_facility", "commission_production", "verify_output"],
  VILLAGER_ECONOMY: ["transport_villagers", "bind_workstations", "lock_trades", "distribute_equipment"],
  MULTI_BOT_HANDOFF: ["acquire_handoff", "execute_handoff", "verify_handoff"],
};

const SKILLS: Readonly<Record<string, string>> = {
  escape_spawn: "movement.goto",
  secure_food: "food.secure",
  equip_armor: "armor.equip",
  site_assess: "site.assess",
  build_blueprint: "build.blueprint",
  verify_structure: "world.scan",
  prepare_site: "build.clear-area",
  build_food_facility: "farm.sustain",
  sustain_food: "farm.sustain",
  build_facility: "build.blueprint",
  commission_production: "world.scan",
  verify_output: "world.scan",
  transport_villagers: "trade.villager",
  bind_workstations: "trade.villager",
  lock_trades: "trade.villager",
  distribute_equipment: "trade.villager",
  acquire_handoff: "movement.follow",
  execute_handoff: "movement.follow",
  verify_handoff: "world.scan",
};

function skillFor(phase: string): string {
  return SKILLS[phase] ?? `composite.${phase}`;
}

export type CompositeOrchestratorOptions = Readonly<{
  compositeStore?: CompositeTaskStore;
  executionStore?: TaskExecutionStore;
  taskStateMachine?: PersistentTaskStateMachine;
  nowMs?: () => number;
}>;

/** Durable A-F parent/child execution. Every phase is a real Skill child. */
export class CompositeTaskOrchestrator {
  readonly composites: CompositeTaskStore;
  readonly executions: PersistentTaskStateMachine;
  private readonly nowMs: () => number;

  constructor(options: CompositeOrchestratorOptions = {}) {
    this.composites = options.compositeStore ?? new InMemoryCompositeTaskStore();
    this.executions = options.taskStateMachine ?? (options.executionStore
      ? new PersistentTaskStateMachine({ store: options.executionStore })
      : new PersistentTaskStateMachine());
    this.nowMs = options.nowMs ?? (() => Date.now());
  }

  async create(input: Readonly<{ kind: CompositeKind; serverProfileId: string; dimension: string; botIds: readonly string[]; goal?: string }>): Promise<CompositeTask> {
    const now = this.nowMs();
    const taskId = randomUUID();
    const phases = PHASES[input.kind];
    const task = compositeTaskSchema.parse({ schemaVersion: "1.0", taskId, kind: input.kind, status: "PENDING", serverProfileId: input.serverProfileId, dimension: input.dimension, botIds: [...input.botIds], currentPhase: phases[0], completedPhases: [], checkpoint: { revision: 0, cursor: 0, evidence: [], updatedAtMs: now }, dependencies: [], leaseOwner: null, fencingToken: null, lastErrorCode: null, createdAtMs: now, updatedAtMs: now });
    await this.composites.save(task);
    await this.executions.create({ taskId, botId: input.botIds[0]!, goal: input.goal ?? `${input.kind} composite task` });
    return task;
  }

  async get(taskId: string): Promise<CompositeTask | null> { return await this.composites.get(taskId); }

  async resume(taskId: string, dispatch: CompositeSkillDispatcher): Promise<CompositeTask> {
    let task = await this.composites.get(taskId);
    if (!task) throw new Error("COMPOSITE_TASK_NOT_FOUND");
    const phases = PHASES[task.kind];
    let root = await this.executions.restore(task.taskId);
    if (!root) throw new Error("COMPOSITE_EXECUTION_NOT_FOUND");
    if (task.status === "COMPLETED" || task.status === "CANCELLED" || task.status === "FAILED") return task;
    if (root.state === "PRECHECK") root = await this.executions.transition(root.taskId, "PLAN", { currentStep: task.currentPhase });
    if (root.state === "PLAN" || root.state === "REPLAN" || root.state === "RECOVER") root = await this.executions.transition(root.taskId, "EXECUTE", { currentStep: task.currentPhase });
    for (let index = task.checkpoint.cursor ?? 0; index < phases.length; index += 1) {
      const phase = phases[index]!;
      task = advanceCompositeTask(task, { phase, status: "RUNNING", nowMs: this.nowMs(), cursor: index });
      await this.composites.save(task, task.checkpoint.revision - 1);
      const childId = randomUUID();
      let child = await this.executions.create({ taskId: childId, parentTask: root.taskId, botId: task.botIds[index % task.botIds.length]!, goal: `${task.kind}:${phase}` });
      child = await this.executions.transition(child.taskId, "PLAN", { currentStep: phase });
      child = await this.executions.transition(child.taskId, "EXECUTE", { currentStep: skillFor(phase) });
      const result = await dispatch({ task, child, step: { phase, skillId: skillFor(phase), input: { serverProfileId: task.serverProfileId, dimension: task.dimension, compositeTaskId: task.taskId, phase } } });
      if (!result.ok) {
        child = await this.executions.transition(child.taskId, "RECOVER", { failureReason: result.errorCode ?? "COMPOSITE_SKILL_FAILED" });
        root = await this.executions.transition(root.taskId, "RECOVER", { currentStep: phase, failureReason: result.errorCode ?? "COMPOSITE_SKILL_FAILED" });
        task = advanceCompositeTask(task, { phase, status: "RECOVERING", nowMs: this.nowMs(), cursor: index, errorCode: result.errorCode ?? "COMPOSITE_SKILL_FAILED", ...(result.evidence ? { evidence: result.evidence } : {}) });
        await this.composites.save(task, task.checkpoint.revision - 1);
        return task;
      }
      const actualResult = skillJsonValueSchema.parse(result.output ?? null);
      child = await this.executions.transition(child.taskId, "VERIFY", { actualResult, currentStep: phase });
      await this.executions.transition(child.taskId, "SUCCESS", { actualResult, currentStep: phase });
      task = advanceCompositeTask(task, { phase, status: index === phases.length - 1 ? "COMPLETED" : "WAITING", nowMs: this.nowMs(), cursor: index + 1, evidence: result.evidence ?? [`${phase}:verified`] });
      await this.composites.save(task, task.checkpoint.revision - 1);
    }
    root = await this.executions.transition(root.taskId, "VERIFY", { currentStep: "composite-verified" });
    await this.executions.transition(root.taskId, "SUCCESS", { currentStep: "composite-complete" });
    return task;
  }

  async recover(taskId: string, dispatch: CompositeSkillDispatcher): Promise<CompositeTask> {
    const task = await this.composites.get(taskId);
    if (!task) throw new Error("COMPOSITE_TASK_NOT_FOUND");
    return this.resume(taskId, dispatch);
  }
}

export function compositePhases(kind: CompositeKind): readonly string[] { return PHASES[kind]; }
export function compositeSkillId(phase: string): string { return skillFor(phase); }

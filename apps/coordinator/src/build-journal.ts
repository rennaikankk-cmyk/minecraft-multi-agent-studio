import { createHash } from "node:crypto";
import { blueprintCellSchema, buildBlueprintInputSchema, buildBlueprintOutputSchema, orderBlueprintCells } from "@minecraft-studio/skills";
import { applyStepResult, newPlanJournal, recordDispatch, type PlanExecutionJournal, type PlanJournalStore } from "./plan-journal.js";

export function blueprintDigest(blueprint: { cells: readonly unknown[] }): string {
  return createHash("sha256").update(JSON.stringify(blueprint.cells.map((cell) => blueprintCellSchema.parse(cell)))).digest("hex");
}

export function beginBuildBatch(store: PlanJournalStore, input: {
  goalId: string; botId: string; baseId: string; blueprintId: string; skillInput: unknown;
  execution?: NonNullable<PlanExecutionJournal["build"]>["execution"];
}): PlanExecutionJournal {
  const plan = buildBlueprintInputSchema.parse(input.skillInput);
  const blueprintVersion = blueprintDigest(plan.blueprint);
  const identity = JSON.stringify([plan.blueprint.serverProfileId, plan.blueprint.dimension,
    input.baseId, input.blueprintId, blueprintVersion, plan.blueprint.anchor]);
  const buildId = "build-" + createHash("sha256").update(identity).digest("hex");
  const journals = store.load();
  if (journals.some((j) => j.serverProfileId === plan.blueprint.serverProfileId &&
    j.build?.dimension === plan.blueprint.dimension && j.build.baseId === input.baseId &&
    j.build.blueprintId === input.blueprintId && j.build.blueprintVersion !== blueprintVersion)) {
    throw new Error("BLUEPRINT_VERSION_RECONCILIATION_REQUIRED");
  }
  const previous = journals.find((journal) => journal.build?.buildId === buildId);
  if (previous?.build?.execution && input.execution &&
    (previous.botId !== input.botId || previous.build.execution.runtimeInstanceId === input.execution.runtimeInstanceId)) {
    throw new Error("BUILD_EXECUTOR_STOP_UNCONFIRMED");
  }
  if (journals.some((j) => j.build?.baseId === input.baseId && j.build.blueprintId === input.blueprintId &&
    j.build.buildId !== buildId && j.serverProfileId === plan.blueprint.serverProfileId && j.build.dimension === plan.blueprint.dimension)) {
    throw new Error("BUILD_ANCHOR_RECONCILIATION_REQUIRED");
  }
  const ordered = orderBlueprintCells(plan.blueprint);
  const index = Math.min(plan.startIndex ?? 0, ordered.length - 1);
  const cell = ordered[index]!;
  const fresh = newPlanJournal({
    goalId: input.goalId, botId: input.botId, serverProfileId: plan.blueprint.serverProfileId,
    correlationId: identity, plannerVersion: "local-planner",
    steps: [{ skillId: "build.blueprint", actionFamily: "build", sideEffectClass: "RECONCILABLE",
      expectedPostcondition: { kind: "build-cell", buildId, cellIndex: index,
        position: { x: plan.blueprint.anchor.x + cell.offset.x, y: plan.blueprint.anchor.y + cell.offset.y,
          z: plan.blueprint.anchor.z + cell.offset.z }, blockName: cell.itemName } }],
  });
  if (previous && previous.steps.length >= 2048) throw new Error("BUILD_JOURNAL_RETENTION_REQUIRED");
  const step = { ...fresh.steps[0]!, sequence: (previous?.steps.length ?? 0) + 1,
    stepId: "batch-" + fresh.steps[0]!.attemptId };
  const journal: PlanExecutionJournal = {
    ...fresh, ...(previous ?? {}), botId: input.botId, goalId: input.goalId, status: "ACTIVE", steps: [...(previous?.steps ?? []), step],
    revision: (previous?.revision ?? -1) + 1,
    build: { baseId: input.baseId, buildId, blueprintId: input.blueprintId, blueprintVersion,
      blueprint: plan.blueprint, anchor: plan.blueprint.anchor, dimension: plan.blueprint.dimension,
      nextIndex: previous?.build?.nextIndex ?? 0, verification: "RECOVERING" },
    updatedAt: new Date().toISOString(),
  };
  if (input.execution) journal.build!.execution = input.execution;
  const dispatched = recordDispatch(journal, step.stepId);
  store.save(dispatched);
  return dispatched;
}

export function finishBuildBatch(store: PlanJournalStore, journal: PlanExecutionJournal,
  result: { outcome: string; output?: unknown; errorCode?: string } | undefined): PlanExecutionJournal {
  const step = journal.steps.at(-1)!;
  const output = result?.outcome === "completed" ? buildBlueprintOutputSchema.safeParse(result.output) : null;
  const build = journal.build!;
  const observed = output?.success && output.data.verification &&
    output.data.totalCells === build.blueprint.cells.length &&
    output.data.verification.states.length === build.blueprint.cells.length;
  const verified = observed && !output.data.verification!.states.includes("unknown");
  if (observed) {
    const ordered = orderBlueprintCells(build.blueprint);
    for (const placement of output.data.placements) {
      const cell = ordered[placement.index];
      if (!cell || placement.itemName !== cell.itemName || placement.blockClass !== cell.blockClass ||
        placement.position.x !== build.anchor.x + cell.offset.x || placement.position.y !== build.anchor.y + cell.offset.y ||
        placement.position.z !== build.anchor.z + cell.offset.z || output.data.verification!.states[placement.index] !== "match") {
        throw new Error("BUILD_VERIFICATION_RECEIPT_MISMATCH");
      }
    }
  }
  let updated = applyStepResult(journal, step.stepId, {
    status: verified ? "SUCCEEDED" : "RECONCILING",
    failureCode: verified ? null : "BUILD_RESULT_UNCERTAIN",
    observedActual: observed ? output.data : null,
    verification: { outcome: verified ? "confirmed" : "unverifiable",
      evidence: verified ? "Runtime read back the fixed blueprint cells" : "Dispatch outcome requires world reconciliation" },
  });
  if (observed) {
    const firstMissing = output.data.verification!.states.findIndex((state) => state !== "match");
    const nextIndex = firstMissing < 0 ? build.blueprint.cells.length : firstMissing;
    if (output.data.nextIndex !== nextIndex || output.data.completed !== (firstMissing < 0)) {
      throw new Error("BUILD_VERIFICATION_BOUNDARY_MISMATCH");
    }
    updated = { ...updated, status: firstMissing < 0 ? "COMPLETED" : "ACTIVE",
      build: { ...build, nextIndex, ...(build.execution ? { observedRuntimeInstanceId: build.execution.runtimeInstanceId } : {}),
        verification: !verified ? "UNVERIFIED" : firstMissing < 0 ? "VERIFIED" :
        build.nextIndex === build.blueprint.cells.length && output.data.placements.length === 0 ? "DAMAGED" : "RECOVERING" } };
  } else updated = { ...updated, status: "ACTIVE", build: { ...build, verification: "UNVERIFIED" } };
  // Executor timeout/cancellation can win a race while the adapter still runs.
  // Only completed/pre-handler rejection or a settled blueprint verifier clears ownership.
  if (result?.outcome === "completed" || result?.outcome === "rejected" ||
    (result?.outcome === "failed" && ["BUILD_VERIFY_TIMEOUT", "BUILD_WRONG_BLOCK", "BUILD_MATERIAL_MISSING"].includes(result.errorCode ?? ""))) {
    delete updated.build!.execution;
  }
  store.save(updated);
  return updated;
}

/** Only a fresh, settled receipt from this Runtime can drive automatic replenishment. */
export function worksetMaterialDeficit(journal: PlanExecutionJournal | undefined | null,
  botId: string, runtimeInstanceId: string, inventory: ReadonlyMap<string, number>, now = Date.now()) {
  if (!journal?.build || journal.botId !== botId || journal.build.execution ||
    journal.build.observedRuntimeInstanceId !== runtimeInstanceId) return null;
  const output = buildBlueprintOutputSchema.safeParse(journal.steps.at(-1)?.observedActual);
  if (!output.success || output.data.workset?.status !== "WAITING_MATERIAL" || !output.data.verification) return null;
  const age = now - Date.parse(output.data.verification.observedAt);
  if (age < 0 || age > 60_000) return null;
  return output.data.workset.missingMaterials.map(({ itemName, count }) => ({ itemName,
    count: Math.max(0, count - (inventory.get(itemName) ?? 0)) })).filter((entry) => entry.count > 0);
}

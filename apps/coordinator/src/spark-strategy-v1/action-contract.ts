import { builtinSkills, GoalPlanner, resourceInputSchema, skillIdForStepKind } from "@minecraft-studio/skills";
import { parseBlueprintFileGoal, parseDeterministicGoal } from "../deterministic-goals.js";
import { blueprintCellsForDispatch, type BlueprintFile } from "../blueprint-files.js";
import type { Scope } from "./facts.js";
import type { ProposalAction } from "./proposal.js";

export type ActionContext = {
  blueprints?: ReadonlyMap<string, BlueprintFile>;
  targets?: ReadonlyMap<string, { serverProfileId: string; dimension: string; x: number; y: number; z: number }>;
};
export type ActionContract = {
  skillIds: string[];
  gates: string[];
  resources: string[];
  issue?: "INVALID_ACTION" | "ACTION_RULE_UNKNOWN" | "ACTION_TARGET_UNAVAILABLE";
};
const skillById = new Map(builtinSkills.map((skill) => [skill.id, skill]));
const resourceGraph = new GoalPlanner().resourceGraph;
const itemNames = resourceGraph.knownItemNames();
const noGateSkills = new Set(["food.secure", "world.scan", "collect.block", "craft.item", "container.transfer", "movement.goto", "inventory.equip-armor"]);
// Mirrors survival-needs' construction progression; unknown blueprints need a reviewed rule.
const blueprintGates: Readonly<Record<string, string[]>> = {
  "starter-base-v1": ["BASE_SITE_RESERVED"],
  "carrot-farm-9x9": ["STARTER_BASE_ACTIVE"],
  "cobble-generator": ["STARTER_BASE_ACTIVE"],
};

export function actionContract(action: ProposalAction, scope: Scope, context: ActionContext = {}): ActionContract {
  const result: ActionContract = { skillIds: [], gates: [], resources: [] };
  if (action.kind === "wait" || action.kind === "noop") return result;
  const fail = (issue: NonNullable<ActionContract["issue"]>) => ({ ...result, issue });
  const target = action.targetRef ? context.targets?.get(action.targetRef) : undefined;
  if (action.targetRef) {
    result.resources.push(action.targetRef);
    if (!target || target.serverProfileId !== scope.serverProfileId || target.dimension !== scope.dimension) {
      result.issue = "ACTION_TARGET_UNAVAILABLE";
    }
  }
  const trustedScope = { serverProfileId: scope.serverProfileId, dimension: scope.dimension };
  const xyz = target ? { x: target.x, y: target.y, z: target.z } : undefined;
  const validInput = (skillId: string, input: unknown): boolean => {
    result.skillIds.push(skillId);
    return skillById.get(skillId)?.inputSchema.safeParse(input).success === true;
  };

  if (action.kind === "skill") {
    // Scope and absolute positions are supplied locally, never accepted from model params.
    if (["serverProfileId", "dimension", "x", "y", "z", "target", "anchor", "container", "craftingTable"].some((key) => key in action.params)) return fail("INVALID_ACTION");
    if (!skillById.has(action.skillId)) {
      result.skillIds.push(action.skillId);
      return fail("INVALID_ACTION");
    }
    if (!noGateSkills.has(action.skillId)) {
      result.skillIds.push(action.skillId);
      return fail("ACTION_RULE_UNKNOWN");
    }
    let params: Record<string, unknown> = { ...action.params, ...trustedScope };
    if (action.skillId === "craft.item") params.craftingTable = xyz ?? null;
    if (action.skillId === "container.transfer") params.container = xyz;
    if (action.skillId === "movement.goto") params = { ...action.params, target: xyz ? { ...xyz, ...trustedScope } : undefined };
    if (action.skillId === "inventory.equip-armor") params = { ...action.params, serverProfileId: scope.serverProfileId };
    return validInput(action.skillId, params) ? result : fail("INVALID_ACTION");
  }

  // Only this explicit placeholder may contain a trusted position. The production parser
  // still determines the actual goal kind, including declarations that lie about the kind.
  if (/\bx\s*[:=]|\by\s*[:=]|\bz\s*[:=]/iu.test(action.goalText)) return fail("INVALID_ACTION");
  if (action.goalText.includes("{{target}}") && !xyz) return fail("ACTION_TARGET_UNAVAILABLE");
  const goalText = xyz ? action.goalText.replaceAll("{{target}}", `x=${xyz.x} y=${xyz.y} z=${xyz.z}`) : action.goalText;
  const parsed = parseDeterministicGoal(goalText, itemNames)
    ?? parseBlueprintFileGoal(goalText, new Set(context.blueprints?.keys() ?? []));
  if (!parsed) return fail("INVALID_ACTION");
  switch (parsed.kind) {
    case "acquire-item":
      if (action.template !== "acquisition") return fail("INVALID_ACTION");
      // The same ResourceGraph bounds item goals; execution still needs planner grounding.
      if (!resourceInputSchema.safeParse({ itemName: parsed.itemName, count: parsed.count }).success) return fail("INVALID_ACTION");
      const recipe = resourceGraph.recipeFor(parsed.itemName);
      if (!recipe) return fail("INVALID_ACTION");
      result.skillIds.push(skillIdForStepKind[recipe.kind]);
      if (recipe.kind === "trade") result.gates.push("VILLAGE_SOURCE_VERIFIED");
      return result;
    case "secure-food":
      if (action.template !== "food") return fail("INVALID_ACTION");
      return validInput("food.secure", { targetCount: parsed.targetCount, ...trustedScope }) ? result : fail("INVALID_ACTION");
    case "scan-block":
      if (action.template !== "scan") return fail("INVALID_ACTION");
      return validInput("world.scan", { blockName: parsed.blockName, maxCount: 8, maxDistance: 32, ...trustedScope }) ? result : fail("INVALID_ACTION");
    case "move-to":
      if (action.template !== "movement" || !xyz) return fail("INVALID_ACTION");
      return validInput("movement.goto", { target: { ...xyz, ...trustedScope }, radius: 2 }) ? result : fail("INVALID_ACTION");
    case "build-blueprint-file": {
      if (action.template !== "blueprint") return fail("INVALID_ACTION");
      const file = context.blueprints?.get(parsed.name);
      const gates = blueprintGates[parsed.name];
      if (!file || !gates) return fail("ACTION_RULE_UNKNOWN");
      result.gates.push(...gates);
      if (!xyz || !action.targetRef) return fail("ACTION_TARGET_UNAVAILABLE");
      return validInput("build.blueprint", { blueprint: { anchor: xyz, cells: blueprintCellsForDispatch(file), ...trustedScope },
        startIndex: parsed.startIndex, maxPlacements: file.batchSize }) ? result : fail("INVALID_ACTION");
    }
    default:
      return fail("ACTION_RULE_UNKNOWN");
  }
}

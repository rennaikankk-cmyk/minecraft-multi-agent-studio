import {
  pickaxeForTier,
  ResourceGraph,
  tierRank,
  tierSatisfies,
  toolTierByItem,
  type ResourceInput,
  type ResourceStation,
  type ToolTier,
} from "./resource-graph.js";

// ---------------------------------------------------------------------------
// GoalPlanner —— 从"我要什么"倒推出"依次做什么"。
//
// 规划器不认识任何具体任务。"拿到钻石装备"之所以能推出
// 木头 → 工作台 → 木镐 → 石镐 → 铁矿 → 熔炼 → 铁镐 → 钻石 → 合成，
// 是因为 ensure() 这一条递归：缺什么就先补什么，补不出来就如实报缺。
//
// 三类前置被分开处理，因为它们的"够不够"判定完全不同：
//   - 消耗品：按批次线性放大，虚拟库存里真的扣掉。
//   - 工具档位：只要一把，且更高档位天然满足更低要求，所以维护"当前最好档位"
//     而不是逐次补货——否则会推出"挖三块石头要三把木镐"。
//   - 工作站：需要在场且在交互距离内，可能额外派生一个放置步骤；放过一次之后
//     同一站点复用，不会每次合成都重放一张工作台。
//
// 终止性由三道闸门保证：递归深度上限、步数上限、以及 inProgress 环检测。
// 任何一道触发都返回稳定错误码，不抛异常、不产出半份计划。
// ---------------------------------------------------------------------------

export const MAX_PLAN_DEPTH = 24;
export const MAX_PLAN_STEPS = 256;
/** 单个目标一次最多要多少个，防止 64 组请求把计划炸成几千步。 */
export const MAX_GOAL_COUNT = 64;

export const planStepKinds = ["mine", "craft", "smelt", "place-station"] as const;

export type PlanStepKind = (typeof planStepKinds)[number];

/** 步骤 → 实际派发的 Skill。规划器只产出意图，执行由 Skill 负责。 */
export const skillIdForStepKind: Readonly<Record<PlanStepKind, string>> =
  Object.freeze({
    mine: "collect.block",
    craft: "craft.item",
    smelt: "smelt.item",
    "place-station": "world.place-block",
  });

export type PlanStep = Readonly<{
  stepIndex: number;
  kind: PlanStepKind;
  skillId: string;
  /**
   * 本步骤**产出**的物品（place-station 时为被放置的方块物品）。挖掘的产出物
   * 与被挖方块经常不同名（stone → cobblestone），所以两者必须分开记录，
   * 否则计划的消费方无法知道这一步到手的是什么。
   */
  itemName: string;
  /** 要挖掘/放置的方块名；craft 与 smelt 为 null。 */
  targetBlock: string | null;
  /** 本步骤预计产出总数。 */
  producedCount: number;
  /** 需要执行几次（合成批次 / 挖掘次数）。 */
  runs: number;
  /** 本步骤消耗掉的东西，已按批次放大。 */
  consumes: readonly ResourceInput[];
  /** 执行本步骤所需的最低工具档位。 */
  toolTier: ToolTier;
  /** 需要的工作站，null 表示随身即可。 */
  station: ResourceStation | null;
  /** 熔炼燃料候选（任一可用即可）。 */
  fuelCandidates: readonly string[];
  /** 这一步是为了满足哪个上层目标——用于失败时定位与向用户解释。 */
  forGoal: string;
}>;

export type PlanFailureCode =
  | "PLAN_ITEM_UNOBTAINABLE"
  | "PLAN_DEPTH_EXCEEDED"
  | "PLAN_STEP_LIMIT_EXCEEDED"
  | "PLAN_CYCLIC_DEPENDENCY"
  | "PLAN_GOAL_INVALID"
  | "PLAN_TOOL_TIER_UNREACHABLE";

export type PlanResult =
  | Readonly<{
      planned: true;
      steps: readonly PlanStep[];
      /** 计划全程从**初始库存**里实扣的数量（不含中间产物自产自销的部分）。 */
      reservations: readonly ResourceInput[];
      /** 计划结束时应当持有的最低工具档位。 */
      finalToolTier: ToolTier;
      /** 计划期间需要放置的工作站。 */
      stations: readonly ResourceStation[];
    }>
  | Readonly<{
      planned: false;
      errorCode: PlanFailureCode;
      /** 卡在哪个物品上——缺料时这是最有用的一条信息。 */
      blockedOn: string;
    }>;

export type GoalRequest = Readonly<{ itemName: string; count: number }>;

export type PlannerInventory = Readonly<Record<string, number>>;

/** 规划失败用异常在内部短路，边界处转成 PlanResult，不外泄。 */
class PlanAbort extends Error {
  constructor(
    readonly errorCode: PlanFailureCode,
    readonly blockedOn: string,
  ) {
    super(errorCode);
    this.name = "PlanAbort";
  }
}

function bestTierFromInventory(inventory: PlannerInventory): ToolTier {
  let best: ToolTier = "none";
  for (const [itemName, count] of Object.entries(inventory)) {
    if (count <= 0) continue;
    const tier = toolTierByItem[itemName];
    if (tier !== undefined && tierRank(tier) > tierRank(best)) best = tier;
  }
  return best;
}

export class GoalPlanner {
  constructor(private readonly graph: ResourceGraph = new ResourceGraph()) {}

  get resourceGraph(): ResourceGraph {
    return this.graph;
  }

  /**
   * 为一组目标生成有序计划。多目标共享同一份虚拟库存与工具档位，所以
   * "钻石头盔 + 钻石胸甲"只会推出一次镐子升级链，而不是两次。
   */
  plan(goals: readonly GoalRequest[], inventory: PlannerInventory = {}): PlanResult {
    if (goals.length === 0) {
      return Object.freeze({
        planned: false as const,
        errorCode: "PLAN_GOAL_INVALID" as const,
        blockedOn: "",
      });
    }
    for (const goal of goals) {
      if (
        !Number.isInteger(goal.count) ||
        goal.count < 1 ||
        goal.count > MAX_GOAL_COUNT
      ) {
        return Object.freeze({
          planned: false as const,
          errorCode: "PLAN_GOAL_INVALID" as const,
          blockedOn: goal.itemName,
        });
      }
    }

    const state = new PlanState(this.graph, inventory);
    try {
      for (const goal of goals) {
        state.ensure(goal.itemName, goal.count, goal.itemName, 0);
      }
    } catch (error) {
      if (error instanceof PlanAbort) {
        return Object.freeze({
          planned: false as const,
          errorCode: error.errorCode,
          blockedOn: error.blockedOn,
        });
      }
      throw error;
    }
    return state.result();
  }
}

/**
 * 一次规划的可变状态。抽成独立类是为了让 GoalPlanner 本身无状态、可复用，
 * 同时把"虚拟库存"这类容易被误共享的东西关在一次调用范围内。
 */
class PlanState {
  private readonly stock = new Map<string, number>();
  /** 初始库存快照，用于最后算出真正从背包里扣了多少。 */
  private readonly initial = new Map<string, number>();
  private readonly steps: PlanStep[] = [];
  private readonly inProgress = new Set<string>();
  private readonly placedStations = new Set<ResourceStation>();
  private toolTier: ToolTier;

  constructor(
    private readonly graph: ResourceGraph,
    inventory: PlannerInventory,
  ) {
    for (const [itemName, count] of Object.entries(inventory)) {
      if (!Number.isFinite(count) || count <= 0) continue;
      const whole = Math.floor(count);
      this.stock.set(itemName, whole);
      this.initial.set(itemName, whole);
    }
    this.toolTier = bestTierFromInventory(inventory);
  }

  private have(itemName: string): number {
    return this.stock.get(itemName) ?? 0;
  }

  private add(itemName: string, count: number): void {
    this.stock.set(itemName, this.have(itemName) + count);
  }

  private take(itemName: string, count: number): void {
    this.stock.set(itemName, Math.max(0, this.have(itemName) - count));
  }

  private push(step: Omit<PlanStep, "stepIndex" | "skillId">): void {
    if (this.steps.length >= MAX_PLAN_STEPS) {
      throw new PlanAbort("PLAN_STEP_LIMIT_EXCEEDED", step.itemName);
    }
    this.steps.push(
      Object.freeze({
        ...step,
        stepIndex: this.steps.length + 1,
        skillId: skillIdForStepKind[step.kind],
        consumes: Object.freeze([...step.consumes]),
        fuelCandidates: Object.freeze([...step.fuelCandidates]),
      }),
    );
  }

  /**
   * 保证 `itemName` 至少有 `count` 个可用；不够就递归补齐并产出步骤。
   * `forGoal` 只用于解释"这一步是为了谁"，不参与判定。
   */
  ensure(itemName: string, count: number, forGoal: string, depth: number): void {
    if (depth > MAX_PLAN_DEPTH) {
      throw new PlanAbort("PLAN_DEPTH_EXCEEDED", itemName);
    }
    const shortfall = count - this.have(itemName);
    if (shortfall <= 0) return;

    const entry = this.graph.recipeFor(itemName);
    if (entry === null) {
      throw new PlanAbort("PLAN_ITEM_UNOBTAINABLE", itemName);
    }
    if (this.inProgress.has(itemName)) {
      throw new PlanAbort("PLAN_CYCLIC_DEPENDENCY", itemName);
    }
    this.inProgress.add(itemName);

    const runs = Math.ceil(shortfall / entry.yield);

    // 1) 工具档位。只要一把，且高档位天然满足低要求。
    this.ensureToolTier(entry.toolTier, itemName, depth);

    // 2) 消耗品，按批次放大。**备够就立刻扣**，不能等到最后一起扣：
    //    工作站/燃料的派生链路会动用同一份虚拟库存，晚扣就会算出"用 3 个木板"
    //    而当时只剩 2 个的假计划。
    const consumes: ResourceInput[] = [];
    for (const input of entry.inputs) {
      const totalNeeded = input.count * runs;
      this.ensure(input.itemName, totalNeeded, forGoal, depth + 1);
      this.take(input.itemName, totalNeeded);
      consumes.push({ itemName: input.itemName, count: totalNeeded });
    }

    // 3) 工作站，需要时派生一次放置。
    if (entry.station !== null) {
      this.ensureStation(entry.station, forGoal, depth);
    }

    // 4) 燃料：熔炼每次至少要一份燃料，按批次备。
    const fuelCandidates = [...entry.fuelCandidates];
    if (entry.kind === "smelt") {
      const fuel = this.chooseFuel(fuelCandidates, runs, forGoal, depth);
      this.take(fuel, runs);
      consumes.push({ itemName: fuel, count: runs });
    }

    this.push({
      kind: entry.kind,
      itemName,
      targetBlock: entry.sourceBlock,
      producedCount: entry.yield * runs,
      runs,
      consumes,
      toolTier: entry.toolTier,
      station: entry.station,
      fuelCandidates,
      forGoal,
    });
    this.add(itemName, entry.yield * runs);
    // 产出本身就是工具时也要抬高档位——目标可能就是那把镐子，此时没人调用过
    // ensureToolTier，但计划结束后手上确实有了它。
    const producedTier = toolTierByItem[itemName];
    if (producedTier !== undefined && tierRank(producedTier) > tierRank(this.toolTier)) {
      this.toolTier = producedTier;
    }
    this.inProgress.delete(itemName);
  }

  /**
   * 把工具档位提升到 `needed`。这里是"镐子阶梯"自动出现的地方：要石镐得先有
   * 木镐去挖圆石，要铁镐得先有石镐去挖铁矿——全靠这条递归，没有硬编码顺序。
   */
  private ensureToolTier(needed: ToolTier, forItem: string, depth: number): void {
    if (tierSatisfies(this.toolTier, needed)) return;
    const toolItem = pickaxeForTier[needed];
    if (toolItem === null) {
      throw new PlanAbort("PLAN_TOOL_TIER_UNREACHABLE", forItem);
    }
    if (this.inProgress.has(toolItem)) {
      throw new PlanAbort("PLAN_CYCLIC_DEPENDENCY", toolItem);
    }
    this.ensure(toolItem, 1, toolItem, depth + 1);
    if (tierRank(needed) > tierRank(this.toolTier)) this.toolTier = needed;
  }

  /** 备好并放置工作站；同一站点在一次计划内只放一次。 */
  private ensureStation(
    station: ResourceStation,
    forGoal: string,
    depth: number,
  ): void {
    if (this.placedStations.has(station)) return;
    this.ensure(station, 1, forGoal, depth + 1);
    this.take(station, 1);
    this.placedStations.add(station);
    this.push({
      kind: "place-station",
      itemName: station,
      targetBlock: station,
      producedCount: 0,
      runs: 1,
      consumes: [{ itemName: station, count: 1 }],
      toolTier: "none",
      station: null,
      fuelCandidates: [],
      forGoal,
    });
  }

  /**
   * 选燃料：优先用已有的，其次选第一个能造出来的。全都造不出来时如实报缺，
   * 而不是假设"总能烧点木头"。
   */
  private chooseFuel(
    candidates: readonly string[],
    runs: number,
    forGoal: string,
    depth: number,
  ): string {
    for (const candidate of candidates) {
      if (this.have(candidate) >= runs) return candidate;
    }
    for (const candidate of candidates) {
      if (!this.graph.knows(candidate)) continue;
      if (this.inProgress.has(candidate)) continue;
      this.ensure(candidate, runs, forGoal, depth + 1);
      return candidate;
    }
    throw new PlanAbort("PLAN_ITEM_UNOBTAINABLE", candidates[0] ?? "fuel");
  }

  result(): PlanResult {
    // 真正从初始背包里扣掉的量 = 初始持有 - 计划结束时仍持有，且下限为 0。
    const reservations: ResourceInput[] = [];
    for (const [itemName, startCount] of this.initial) {
      const spent = startCount - this.have(itemName);
      if (spent > 0) reservations.push({ itemName, count: spent });
    }
    reservations.sort((left, right) => left.itemName.localeCompare(right.itemName));
    return Object.freeze({
      planned: true as const,
      steps: Object.freeze([...this.steps]),
      reservations: Object.freeze(reservations),
      finalToolTier: this.toolTier,
      stations: Object.freeze([...this.placedStations].sort()),
    });
  }
}

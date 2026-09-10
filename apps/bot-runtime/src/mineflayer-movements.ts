/**
 * pathfinder movements 四档配置与可达面/收获判定（从 mineflayer-client.ts 拆出，2026-09-10 结构拆分批次 5）。
 */
import type { Bot } from "mineflayer";
import { Movements, default as pathfinderModule } from "mineflayer-pathfinder";
import { setImmediate as processYield } from "node:timers/promises";

const { goals } = pathfinderModule;
import type { Vec3 } from "vec3";

import { SkillFault, resolveMovementProfile, type ServerPolicyLimits } from "@minecraft-studio/skills";


/**
 * 无规则服导航档：没有反作弊、没有封号风险，强度优先。与 safe 档唯一的
 * 交集是两条**存活安全**约束（dontCreateFlow / dontMineUnderFallingBlock）
 * ——它们防的是把岩浆/水引进家和被沙砾活埋，与反作弊无关。
 */
export function configureAnarchyPathfinderMovements(
  movements: Movements,
  bot: Pick<Bot, "registry">,
): Movements {
  movements.canDig = true;
  movements.canOpenDoors = true;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = true;
  movements.allowFreeMotion = true;
  movements.allowParkour = true;
  movements.allowSprinting = true;
  const registry = bot.registry as unknown as {
    blocksByName?: Readonly<Record<string, { id: number }>>;
  };
  movements.scafoldingBlocks = ["cobblestone", "dirt", "oak_planks", "netherrack"]
    .map((name) => registry.blocksByName?.[name]?.id)
    .filter((id): id is number => typeof id === "number");
  movements.maxDropDown = 4;
  movements.infiniteLiquidDropdownDistance = false;
  // 元组类型要求至少一个函数；() => 0 即"无额外代价"。
  movements.exclusionAreasBreak = [() => 0];
  movements.exclusionAreasPlace = [() => 0];
  return movements;
}

export function configureNavigationMovements(
  movements: Movements,
  bot: Pick<Bot, "registry">,
  anarchy: boolean,
): Movements {
  return anarchy
    ? configureAnarchyPathfinderMovements(movements, bot)
    : configureSafePathfinderMovements(movements);
}

export function configureSafePathfinderMovements(
  movements: Movements,
): Movements {
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = false;
  movements.allowParkour = false;
  movements.allowSprinting = false;
  movements.scafoldingBlocks = [];
  movements.maxDropDown = 2;
  movements.infiniteLiquidDropdownDistance = false;
  movements.exclusionAreasBreak = [() => 100];
  movements.exclusionAreasPlace = [() => 100];
  return movements;
}

// findBlocks 只按距离排序取最近的命中，完全不问那些命中能不能靠近。实测
// 生服出生点：半径 16 内有 12843 个 stone，其中只有 173 个有任何一面贴空气，
// 最近的暴露面在 12.9 格外——所以交给采集器的三个"最近"目标永远是全埋的。
// collectblock 用 GoalLookAtBlock 接近目标，它要求目标有一面能被射线看到，
// 而安全移动配置给所有非目标方块 100 的破除代价，于是路径根本不存在：
//   collect-config timeout=5000 radius=-1 status=noPath visited=9961
// 把 thinkTimeout 抬到 20 秒也一样是 noPath（717ms），可见不是预算不够。
// 同一份探针里最近的**暴露** stone 则 158ms 就搜出路径（visited=2836）。
// 因此候选筛选必须带上"至少一面临空"这一条，否则上层的重试阶梯只是在
// 反复瞄准一个永远到不了的坐标。
export const CANDIDATE_FACES: readonly Readonly<[number, number, number]>[] = [
  [0, 1, 0],
  [0, -1, 0],
  [1, 0, 0],
  [-1, 0, 0],
  [0, 0, 1],
  [0, 0, -1],
];

// 临空的那一面若是液体，靠近就等于往水里/岩浆里挖。mine-planner 已经把
// lava/water 邻接判成 MINE_LAVA_ADJACENT（planning/mine-planner.ts:162），
// 这里沿用同一条立场：液体不算可用的暴露面。上面那组暴露计数是用"只看
// boundingBox 为 empty"测的，所以实际可用候选只会比它少，不会更多。
export const CANDIDATE_FACE_LIQUIDS = new Set([
  "water",
  "flowing_water",
  "lava",
  "flowing_lava",
  "bubble_column",
]);

/**
 * 判断一个方块是否至少有一面贴着可通行的非液体空间。
 *
 * 读不到邻居（区块未加载）时那一面不算暴露：fail-closed 比乐观猜测好，
 * 因为猜错的代价是上层拿着一个到不了的目标烧完整条重试阶梯。
 */
export function hasReachableFace(
  bot: Pick<Bot, "blockAt">,
  position: Vec3,
): boolean {
  return CANDIDATE_FACES.some(([dx, dy, dz]) => {
    const neighbor = bot.blockAt(position.offset(dx, dy, dz));
    if (!neighbor || neighbor.boundingBox !== "empty") return false;
    return !CANDIDATE_FACE_LIQUIDS.has(neighbor.name);
  });
}

/**
 * 供 findBlocks 的 useExtraInfo 使用的候选谓词。
 *
 * mineflayer 4.37.1 的 getFullMatchingFunction 在 useExtraInfo 是函数时走
 * `matcher(block) && useExtraInfo(block)`（lib/plugins/blocks.js:145），
 * 而距离排序与 count 截断都在匹配**之后**（同文件 199-206），所以这里过滤
 * 得到的是"最近的可达候选"，而不是"最近若干个里恰好可达的那些"。
 * 段级短路仍然只用基础 matcher，因此加这个谓词不会让扫描退化成全量遍历。
 */
export function reachableCandidateFilter(
  bot: Pick<Bot, "blockAt">,
): (block: { position: Vec3 } | null) => boolean {
  return (block) =>
    block !== null && hasReachableFace(bot, block.position);
}

/**
 * 手里/背包里有没有能真正收获该方块的工具。
 *
 * 必须在把目标交给 collectblock **之前**问这一句，否则进程会 OOM 崩掉，这是实测：
 * mineBlock 调 bot.tool.equipForBlock(block, {requireHarvest:true,
 * getFromChest:true, ...})（CollectBlock.js:74）；mineflayer-tool 的
 * equipForBlock 在 requireHarvest 下按 `block.canHarvest(item?.type ?? null)`
 * 过滤（Tool.js:115），列表空了就 `await retrieveTools(...)` 然后**递归调用自己**
 * （Tool.js:121-127）；而 retrieveTools 在 chestLocations 为空时整个 while 循环
 * 一次都不进，直接 resolve 而不是抛错（Inventory.js:48）。我们又把
 * chestLocations 恒置为空（入库是 container.transfer 的职责）。于是列表永远是空的，
 * 递归永远不终止。
 *
 * equip-probe 直接调这一个函数测得：石头 + 空背包 + chestLocations=[] →
 * 2001 层递归只用了 15ms（约 133k 层/秒），每层还留着一份
 * `[...bot.inventory.items()]` 拷贝；对照组把 getFromChest 关掉则 0ms 内以
 * NoItem 拒绝。这解释了两次探针崩溃的完整形态：heap 在寻路阶段平稳在 45-95MB
 * （path_update 停在 13、resets=0），随后 500ms 采样器**整个停止触发**（事件循环
 * 被同步递归占满），而 GC 报到 1.9GB / 5.9GB，最后
 * "Ineffective mark-compacts near heap limit"。
 *
 * 所以这里不是"提前失败更礼貌"，而是唯一能避免 OOM 的位置：一旦进了
 * collectblock，递归发生在库内部，我们既拦不住也没有超时可言。
 */
export function canHarvestWithInventory(
  bot: Pick<Bot, "inventory" | "heldItem">,
  block: { canHarvest: (itemType: number | null) => boolean | null },
): boolean {
  // 空手也可能收获（泥土、沙子），所以 null 是一个必须参与判断的候选，
  // 而不是"没工具"的同义词。
  if (block.canHarvest(null) === true) return true;
  return bot.inventory
    .items()
    .some((item) => block.canHarvest(item.type) === true);
}

// collect 自己的寻路预算，不再继承 invokeMovementGoto 写在 bot.pathfinder 上
// 的全局值。三条实测把这两个数字定死了：
//   1. astar.js:73 比的是**构造以来的墙钟**（`performance.now() - this.startTime
//      > this.timeout`），不是累计计算时间——注释写的 "total compute time" 是错的。
//      而 compute() 每次最多跑 tickTimeout 毫秒，且 monitorMovement 挂在
//      physicsTick 上（index.js:166，约 50ms 一次）。于是占空比 =
//      tickTimeout / 50ms：tickTimeout=20 时 thinkTimeout=5000 只买到约 2.0s
//      的真实计算。reset-probe 实测 ticks=101、path_reset=0、astarTime=5000ms、
//      visited=30511——一个搜索被饿死，不是重启风暴。
//   2. 40 个暴露 stone 从固定原点全占空比排干（tickTimeout == timeout，wall ≈
//      compute）：能解的 33 个 max=527ms min=181ms median=445ms，判不出路的 7 个
//      在 671-678ms 内落定 noPath。所以真实需求是亚秒级。
//   3. tickTimeout=40 是库默认值（index.js:40），把占空比从 40% 抬到约 80%。
// 8000ms 墙钟 × 约 80% 占空比 ≈ 6.4s 计算，是实测最坏 527ms 的十倍余量，留给
// 行进途中 blockUpdate/chunkColumnLoad 触发的 resetPath 重付成本（duty-probe
// 实测 resets=11）。
export const COLLECT_PATH_THINK_TIMEOUT_MS = 8_000;
export const COLLECT_PATH_TICK_TIMEOUT_MS = 40;

// collectAll 有两条永不落定的 await，都在 Entity 分支（CollectBlock.js:36-52）：
//   1. 第 50 行 `yield waitForPickup` 没有超时，而它订阅 entityGone 是在第 49 行
//      goto **返回之后**（41-48 行建 Promise，49 行才走过去）。掉落物在走过去的
//      途中被顺路捡走时，entityGone 已经发过了，这个 Promise 永远不 resolve。
//   2. 第 49 行 GoalFollow(closest, 0) 对着一个会动/已失效的实体要求距离 0。
//      resetPath 每次都构造新的 AStar 且都能 success，所以 thinkTimeout 永远
//      不触发，机器人就在原地反复重算而不拒绝。
// 两条都不抛错，于是 collect() 既不 resolve 也不 reject——实测就是 live 的
// `dur=60004 SKILL_TIMEOUT` 且没有任何 onFault 行。cobble-earned-probe 复现：
// 第一轮 Timeout 拒绝，第二轮 collect() 静默挂了 224 秒直到探针自己的失效保护。
// 掉落物是 mineBlock 在 collect() 跑动中追加的目标（CollectBlock.js:80-83），
// 前置可达性检查看不到它们，所以这个界只能加在这一层。
// 25000ms：实测四个 oak_log 目标走完整条 collect（含 GoalFollow 捡拾腿）是
// 34458ms，单目标 12974ms，而 stone 单目标 goto 就要 19025ms（候选在脚下
// 12-13 格深）。所以这个界不能小到误伤正常采集，只能用来兜住"永远不落定"：
// 60s 合约减去最坏一次 travel+dig 后仍有余量，且留够时间把真实原因报上去。
export const COLLECT_SETTLE_BUDGET_MS = 25_000;
export const COLLECT_DIRECT_PATH_BUDGET_MS = 12_000;
export const COLLECT_DIRECT_PICKUP_PATH_BUDGET_MS = 6_000;
export const COLLECT_DIRECT_PICKUP_WAIT_MS = 2_000;
// Round 6.2：挖后掉落物可能仍在下落（树冠原木落地要 1-3s）。追一个移动中的
// 实体位置必然失败——每轮重读掉落物当前位置，有界重试，事件驱动提前成功。
export const COLLECT_PICKUP_ATTEMPTS = 3;
export const COLLECT_PICKUP_SETTLE_PROBE_MS = 300;

const COLLECT_PRECHECK_BUDGET_MS = 1_500;

// 候选池必须比需求量大。findBlocks 的 count 截断发生在 useExtraInfo 过滤**之后**
// （blocks.js:199-206），所以 count == maxCount 意味着"最近的 N 个暴露候选"就是
// 全部候选:其中任何一个通不过可达性检查都没有替补。实测就是这么死的——目标
// 只找到 1 个暴露的 oak_log，它不可达，于是整个目标在 step 1 结束，
// stepsCompleted:0。世界里当然还有别的原木，只是不在"最近 1 个"里。
//
// 池子放大到需求量 + 8（仍受 COLLECT_MAX_COUNT 上限约束）。8 不是随手写的：
// 实测 40 个暴露 stone 候选里 7 个是 noPath（约 17.5%），一次多看 8 个能把
// "全军覆没"的概率压到可以忽略，同时最坏成本仍然有界（见下面的总预算）。
export const COLLECT_CANDIDATE_POOL_SLACK = 8;

// 逐候选预算 1500ms 乘以放大后的池子会吃掉整个 60s 合约（32 × 1500 = 48s），
// 所以放大池子必须同时给检查本身一个总预算。6000ms 按实测最坏定论耗时 678ms
// 算大约能排完 8 个候选，且给 collect() 自己的 25s 界留足余量。
//
// 这不是"调超时掩盖失败"：预算耗尽时不会假装可达，也不会假装证明了不可达——
// 没检查完的候选让 provenPathless < targets.length 成立，报的就是
// COLLECT_PATH_SEARCH_EXHAUSTED（TRANSIENT，可以原样再试）。
const COLLECT_PRECHECK_TOTAL_BUDGET_MS = 6_000;

// 前置检查是证据，不是保证。实测（task 7bab377b，step 6 oak_log，dur=12588ms）：
// 前置检查证明了一个候选可达——日志里一条 "Examined ... candidates" 都没有——
// 随后 collect() 自己的 goto 在同一个目标上以
// `Timeout: Took to long to decide path to goal!`（goto.js:28，即 path_update
// 报 status=timeout）被拒。两次搜索并不等价：前置检查用
// tickTimeout == timeout 背靠背跑满 1500ms，而实跑的 A* 挂在 physicsTick 上
// 每 ~50ms 只跑 tickTimeout=40ms，且 8000ms 是**墙钟**（astar.js:73），行进途中
// 的 blockUpdate/chunkColumnLoad 还会 resetPath 并从新位置重新付一次全价
// （index.js:401/414）。所以"前置证明可达"之后实跑仍然可能判不出路。
//
// 于是只交一个已证明的目标就复现了 COLLECT_CANDIDATE_POOL_SLACK 当初要修的那个
// 形态——一次坏抽样就沉掉整步——只是晚了一层：候选池有替补，交给 collect() 的
// 批次却没有。多证明一个候选当替补，成本有界（最多一个 1500ms 名额，且仍受
// 6000ms 总预算约束），换来实跑被拒时还有下一个可以试。
//
// 只留 1 个而不是更多：一次替补把最坏成本压在"再一次 goto"，60s 技能合约放得下
// （实测整步 12588ms）；再多就要拿实测数字说话，而那个数字还没测。
export const COLLECT_LIVE_PATH_SUBSTITUTES = 1;

/**
 * 前置检查的结论。`provenPathless` 是**证明**了没有路的候选数，不是"没成功"的
 * 候选数：两者差在预算用尽的搜索上，而这个差别决定上层走哪条恢复阶梯。
 */
export type CollectReachability<TBlock> = Readonly<{
  reachable: TBlock[];
  /** Candidates whose search timed out or did not run before the total budget. */
  unproven: TBlock[];
  provenPathless: number;
  /**
   * 实际排过的候选数。它可以远小于 `targets.length`：逐候选 1500ms 配 6000ms
   * 总预算，最多只排得下 4 个。没有这个数，"0 of 9 proven pathless" 读起来像
   * 九个都试过了，运维就会去调那个根本没绑住循环的常量。
   */
  examined: number;
  /** 循环是被总预算截断的（true），还是把候选走完了（false）。 */
  stoppedOnTotalBudget: boolean;
}>;

/**
 * 逐个候选排干一次有界的全占空比搜索，同时记下有多少个是**证明**不可达的。
 *
 * 为什么必须前置：collectblock 的 collectAll 对每个目标各做一次 goto，并把
 * 拒绝直接上抛（CollectBlock.js:31，第 33 行还留着 `// TODO:
 * options.ignoreNoPath`），所以**一个**到不了的目标就会中止整批采集。实测 40 个
 * 暴露候选里有 7 个是 noPath，而选择只按距离排序，撞上纯属运气。
 * 每个候选保留 1500ms 计算预算，按 5ms 切片让出事件循环。让出期间的时间
 * 不计入候选 CPU 预算，整个扫描仍受 6000ms 墙钟上限约束。
 *
 * 只数 `noPath`，因为 AStar.compute() 只有四个状态（astar.js:66-120）：
 * `partial` 是切片没跑完，`timeout` 是总预算耗尽，`success` 是找到了，
 * `noPath` 是开集排空——**只有最后一个**是"这里确实没有路"的证明。而
 * `timeout` 也可能是调度或全局墙钟预算耗尽。
 * 把它记成证明会让一个只是没算完的搜索冒充定论，正是
 * failure-classifier.ts:180 明令不许合并的那两件事。未知状态同样不算证明：
 * 拿不准时少声称，而不是多声称。
 */
export async function collectReachableTargets<TBlock extends { position: Vec3 }>(
  bot: Pick<Bot, "pathfinder" | "entity" | "world">,
  movements: Movements,
  targets: readonly TBlock[],
  wanted: number = targets.length,
  signal?: AbortSignal,
): Promise<CollectReachability<TBlock>> {
  const reachable: TBlock[] = [];
  const unproven: TBlock[] = [];
  let provenPathless = 0;
  let examined = 0;
  let stoppedOnTotalBudget = false;
  const deadline = Date.now() + COLLECT_PRECHECK_TOTAL_BUDGET_MS;
  for (let index = 0; index < targets.length; index += 1) {
    if (signal?.aborted) throw new SkillFault("SKILL_CANCELLED");
    const target = targets[index]!;
    // 够数就停：池子放大是为了有替补，不是为了多采。攒到需求量就不再花钱，
    // 也顺手把交给 collect() 的目标数压在请求量之内。
    if (reachable.length >= wanted) break;
    // 总预算是放大池子的必要配套：逐候选 1500ms × 放大后的池子会吃掉整个 60s
    // 合约。剩下没检查的候选因此既不算可达也不算证明不可达，于是
    // provenPathless < targets.length 成立，上层收到的是 EXHAUSTED 而不是
    // 一个冒充定论的 UNREACHABLE。
    if (Date.now() >= deadline) {
      stoppedOnTotalBudget = true;
      unproven.push(...targets.slice(index));
      break;
    }
    examined += 1;
    const generator = bot.pathfinder.getPathFromTo(
      movements,
      bot.entity.position,
      new goals.GoalLookAtBlock(target.position, bot.world),
      {
        timeout: Math.max(1, deadline - Date.now()),
        tickTimeout: 5,
        searchRadius: -1,
      },
    );
    let status: string | undefined;
    let computeMs = 0;
    try {
      for (;;) {
        if (signal?.aborted) throw new SkillFault("SKILL_CANCELLED");
        const sliceStarted = performance.now();
        const step = generator.next();
        computeMs += performance.now() - sliceStarted;
        if (step.done) break;
        status = step.value.result.status;
        if (status !== "partial" || computeMs >= COLLECT_PRECHECK_BUDGET_MS || Date.now() >= deadline) break;
        await processYield();
      }
    } finally {
      generator.return?.();
    }
    if (status === "success") {
      reachable.push(target);
      continue;
    }
    if (status === "noPath") {
      provenPathless += 1;
    } else {
      // Timeout is not proof that the live pathfinder cannot reach the block.
      // Keep it as a bounded execution candidate instead of turning a 6-second
      // read-only precheck into a permanent no-op loop.
      unproven.push(target);
    }
  }
  return {
    reachable,
    unproven,
    provenPathless,
    examined,
    stoppedOnTotalBudget,
  };
}

export function configurePathfinderMovements(
  movements: Movements,
  profile: "SAFE" | "PARKOUR" = "SAFE",
  policyLimits?: ServerPolicyLimits,
  isolatedTestServer = false,
): Movements {
  if (profile === "SAFE") return configureSafePathfinderMovements(movements);
  if (policyLimits === undefined) throw new SkillFault("POLICY_PARKOUR_FORBIDDEN");
  const decision = resolveMovementProfile(profile, policyLimits, isolatedTestServer);
  if (!decision.allowed) throw new SkillFault(decision.errorCode);
  movements.canDig = false;
  movements.canOpenDoors = false;
  movements.dontCreateFlow = true;
  movements.dontMineUnderFallingBlock = true;
  movements.allow1by1towers = false;
  movements.allowFreeMotion = decision.config.allowFreeMotion;
  movements.allowParkour = decision.config.allowParkour;
  movements.allowSprinting = decision.config.allowSprinting;
  movements.scafoldingBlocks = [];
  movements.maxDropDown = decision.config.maxDropDown;
  movements.infiniteLiquidDropdownDistance = false;
  movements.exclusionAreasBreak = [() => 100];
  movements.exclusionAreasPlace = [() => 100];
  return movements;
}

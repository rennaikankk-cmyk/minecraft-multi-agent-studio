# Codex 提示词 · 非战斗技能层（无规则服）v1

> 使用方法：把下面分隔线内的全部内容作为一条消息发给 Codex。本文件**不取代** `docs/codex-handover-prompt.md`（v2 仍是主蓝图与红线来源），也不取代 `docs/codex-prompt-combat-v3.md`（战斗层 W0~W8）。它补的是战斗之外的技能面：跑酷、交易、挖矿、寻路、建造、找安全地方。
>
> 研究方式：全部结论来自本仓库实地核对 + Minecraft 公开机制。**没有连接任何 Minecraft 服务器**，所有毫秒/格数/产量都是设计目标，不是实测值。

---

你将接管 Minecraft Multi-Agent Studio 的**非战斗技能层**。先读 `docs/codex-handover-prompt.md`（v2 全部红线继续有效）、`AGENTS.md` §0.1~§0.6、`docs/combat-tactics-reference.md` §6、§8~§14。本提示词按 N0~N7 编号，**不跳级**，一个模块一次。

## 零、先看清现状（这些数字是核对过的，不要凭印象改）

**非战斗技能一共 7 个**，加上新进来的两个 `combat.*` 共 9 个注册在 `packages/skills/src/builtin/catalog.ts`：
`movement.goto` / `inventory.equip-armor` / `collect.block` / `craft.item` / `world.place-block` / `container.transfer` / `smelt.item`。

**跑酷、交易、挖矿策略、建造、找安全地方——一个文件都没有。** 不是"实现得不好"，是零。

运行时只接了 **8 个 capability operation**（`apps/bot-runtime/src/mineflayer-client.ts:439-482`）：`pathfinder.goto-safe`、`armor.snapshot`、`armor.equip`、`collect.blocks-safe`、`craft.item-safe`、`smelt.item-safe`、`block.place-safe`、`container.transfer-safe`。顺带一条给战斗层的提醒：`combat.control` **不在这 8 个里**，grep `combat.control` 在 `apps/bot-runtime/src` 零命中——所以 `combat.engage` 现在必然停在 `COMBAT_DRIVER_UNAVAILABLE`，W0 只做了技能声明那一半。

逐项现状：

- **寻路只有一个薄技能**：`movement.goto` 的 `SAFE_PATH_MAX_DISTANCE = 64`、`SAFE_PATH_TIMEOUT_MS = 20_000`、`radius` 只允许 1~4、`idempotent: false`、`retryPolicy.maxAttempts: 1`，一次只打一个 `pathfinder.goto-safe`。**64 格是硬顶**，所以现在跨越几百格以上的任何目标都是不可达的——这也就是说挖矿、建造、交易、找落脚点全都还没有"走到那儿"的能力。
- **跑酷被两层独立禁掉了**，这是本批最容易踩坑的一条。`configureSafePathfinderMovements`（`mineflayer-client.ts:187-202`）写死 `allowParkour = false`、`allowSprinting = false`、`allow1by1towers = false`、`allowFreeMotion = false`、`canDig = false`、`maxDropDown = 2`、`scafoldingBlocks = []`；而 `ServerPolicy` 的 STRICT 与 VANILLA_COMPATIBLE 两档都是 `allowSprintJumpCombo: false`（只有 NORMAL 是 true）、`allowAirStrafe: false`、`maxFallBlocks: 2/3`。**一次跑酷跳就是一次 sprint+jump 组合**，所以开跑酷 = 同时放宽寻路配置和面向反作弊的策略档，这是**放宽方向**的改动，见 N7。
- **挖矿只有 `collect.block`**：`COLLECT_MAX_COUNT = 32`、`COLLECT_MAX_DISTANCE = 32`（`maxDistance` 下限 2），前置条件里有 `inventory.has-room → INVENTORY_FULL`。它是"就近采 N 个"，**没有** y 层选择、没有分支挖矿、没有矿脉策略、没有岩浆/虚空判据（L0 之外）、没有回填。注意 `goto-safe` 那套 Movements 是 `canDig = false`，而 `invokeCollectBlocks` 单独把 `canDig` 打开并挂了自己的 `exclusionAreasBreak`——挖掘门是**按操作分别开的**，新挖矿模块必须自己带门，别指望继承。
- **交易在资源模型里根本表达不出来**：`resource-graph.ts` 的 `acquisitionKinds = ["mine","craft","smelt"]`、`resourceStations = ["crafting_table","furnace"]`；`goal-planner.ts` 的 `planStepKinds = ["mine","craft","smelt","place-station"]`。所以"用交易获得某物"这条边**喂不进 `GoalPlanner`**，加个技能不够，得同时加 acquisition kind、plan step kind 和 `skillIdForStepKind` 条目。好消息是不需要新依赖：mineflayer 4.37.1 原生就有 `bot.openVillager(entity)`、`bot.trade(villager, tradeIndex, times?)` 和 `VillagerTrade{inputItem1, inputItem2, hasItem2, outputItem, tradeDisabled, nbTradeUses, maximumNbTradeUses, xp?, specialPrice?, priceMultiplier?, demand?, realPrice?}`（`lib/plugins/villager.js`、`index.d.ts:380-392`、`:763-785`）。
- **"安全地方"没有任何归宿**：`packages/environment` 是**宿主机**环境探测（部署模式、内存、`/.dockerenv`），跟 Minecraft 世界无关。世界侧只有 L0：风险枚举 `CRITICAL_HEALTH / LAVA / DROWNING / FALLING / LOW_HEALTH / STUCK / INVENTORY_FULL / HUNGER`，阈值 `CRITICAL_HEALTH=4`、`LOW_HEALTH=8`、`EAT_AT_FOOD_LEVEL=14`、`LOW_OXYGEN_LEVEL=6`、`FALL_VELOCITY_Y=-0.75`、`STUCK_AFTER_MS=5000`。**L0 是"已经出事了"的反应层，选址是"不要走到那儿"的前瞻层**，两件事不同层，N2 绝不许重写 L0 的阈值。
- **位置记忆一行都没有**：grep `worldMemory|pgvector|coordinate` 在 `packages/*/src` 只命中 ai-router / observability / coordinator 的无关文本，P2.1 未开工。而下面每一项都要产出或消费坐标——所以 N0 必须先做，否则六个模块会各长一个本地缓存，跨服污染只是时间问题。

**结论：先有"能走远"和"坐标能存"，再谈干活。** 顺序不是偏好，是依赖。

## 一、无规则服的世界假设（这一节决定每个技能的默认值）

用户反复强调"这是应用在无规则服务器"。这不是背景色，它改的是**默认值**：单人生存教程里的最优解在这里经常是自杀。下面每条都要在实现时当作前提，而不是"以后加的加固"。

1. **出生点是永久战区**（`combat-tactics-reference.md` §11 层 1）：岩浆/黑曜石陷阱、守尸党、满地 griefer。落地第一动作是**脱离**，不是撸木。任何"在出生点附近选址/挖矿/建造"的分支都必须被硬拒。
2. **没有保护，也没有"没人来"**：不能假设区块无人光顾、箱子无主、地形未被改动。观测过期是常态（卡服、区块不加载、lag machine），所有判据 **fail-closed**。
3. **一切容器可能是陷阱**：TNT 触发、岩浆倾覆、珍珠停滞。翻箱是**收益动作**，不是免费动作；`container.transfer` 的容器白名单要继续守住，不许为了"顺手"放宽。
4. **痕迹就是坐标泄露**：露天隧道、主世界地狱门、整千/对称坐标、公路上的满箱 bot——四种都是把自己交出去。挖矿要**回填/掩埋**，选址要**避开人类习惯坐标**（§11：远离坐标轴与主干道 N 格以上、远离主世界地狱门连线、避开整数/对称/整千坐标），运输要小额分批（§12）。
5. **地狱坐标 ×8 是双向的**：我们用它扫别人（§8），别人也用它扫我们（§10）。所以己方地狱门策略与选址评分必须显式互斥，不能一个模块建门、另一个模块给自己打高分。
6. **死亡 = 掉光**：一次失败的跳跃、一次直下、一次贪财，代价是整套装备。所以"省几秒"的优化（跑酷）价值远低于"别死"的优化（选址、回填、撤离），排序要如实反映这一点。
7. **白名单外一律敌对**（AGENTS.md §0.1，不可谈判）：非战斗技能遇到玩家的默认动作是**脱离/藏匿**，不是继续干活，也不是交涉。任何非战斗模块**不得**新增"判断这个玩家友善"的逻辑。

## 二、红线（v2 全部继续有效，这里只强调本批最容易踩的六条）

1. **敌我识别仍是确定性白名单，AI 无权增删。** 本批新增的任何观测（村民、商人、玩家活动痕迹、箱子归属）都只是**打法输入**，不得成为判敌依据。
2. **AI 输出永远只能是校验过的白名单技能调用 JSON。** 交易不例外：**禁止**任何自由文本聊天、喊话、议价、招募。朝真人发自由文本等于把 AI 输出接到骚扰面上（和战斗层否决 PopEz 同一条理由）。
3. **`SAFE_PATH_MAX_DISTANCE = 64` 不许调大。** 它不是保守猜测，是"一次调用 = 一段有界、可取消、20 秒内收敛的移动"的**契约**。要走远，做**分段**（N1），不是把上限拧大——拧大等于让一次技能调用变成不可取消的长程漫游。
4. **`movement.goto` 只能连已批准的隔离测试服**，不得用它绕过 ServerProfile 策略。三段式环境纪律（隔离 → 私有测试 → 灰度正式）绝不跳级。
5. **世界记忆写入必须携带 `serverProfileId` + 维度 + 坐标三元组，缺一拒绝（fail-closed）**；查询过滤加在**仓储层**，调用方无法发起不带服务器过滤的位置查询（AGENTS.md §0.2、§13）。换服即换记忆空间，进行中的坐标类任务作废重排。
6. **能力 `unknown` 一律 fail-closed，不许从版本号推断。** 本批会遇到不少版本相关事实（矿物 y 层分布、猪灵以物易物战利品表、盾牌/锚交互），凡未在隔离服实测的，常量要带最低版本守卫，并在文档里写"未实测"。

再加一条从战斗层沿用过来的架构原则，本批全程遵守：**记录"请求了什么"与"实际执行了什么"两份数据。** 放置被策略降速、挖掘被 exclusion 拒绝、路段被截断——都要以 `executed | clipped | delayed | dropped | modified` 加机器可读原因落审计，而不是只留一个成功计数。没有这份记录，"为什么这座基地建了一半"就永远只能靠猜。

**命名有硬约束，不是风格问题**：新增策略拒绝码**必须**以 `POLICY_` 开头。`failure-classifier.ts` 的形态兜底里 `POLICY_` 前缀 → `POLICY_BLOCKED`（降速重试），而含 `FORBIDDEN` 的裸码会被判成 `CONTRACT_BUG`（直接上报人工）。也就是说 `PARKOUR_JUMP_FORBIDDEN` 会把一次正常的策略拒绝变成一张人工工单，而 `POLICY_PARKOUR_JUMP_FORBIDDEN` 才是对的。

**下面这几个码按当前规则会静默落到 `UNKNOWN` → `ESCALATE_TO_OPERATOR`**（我逐条比对过 `SHAPE_RULES`），新增时必须同时进显式表 + 恢复阶梯，否则完备性断言会红，或者更糟——不会红，但每次触发都去找人：`TRADE_DISABLED`、`TRADE_PRICE_UNACCEPTABLE`、`SITE_REJECTED_BY_HARD_RULE`、`MINE_LAVA_ADJACENT`、`BLUEPRINT_STEP_BLOCKED`。反过来，`VILLAGER_NOT_FOUND`（→ `NOT_FOUND` → `STALE_WORLD`）、`TRADE_ITEM_NOT_IN_INVENTORY`（→ `MISSING_RESOURCE`）、`PARKOUR_UNSUPPORTED`（→ `UNSUPPORTED`）这三类形态兜底已经判对了，不必进表。

## 三、任务清单（按序，一个模块一次，每阶段独立提交，每阶段 `pnpm check` 全绿）

### N0 · 世界记忆的服务器隔离底座（评分 9.6，规划级，无需探针）

**最高优先级，而且没得选。** 后面六个模块全都要读写坐标：矿点、落脚点、隐蔽点、村民位置、公路节点、蓝图锚点。现在一行都没有，谁先落地谁就会长一个本地缓存，然后跨服污染变成六处各错一遍。§13 已经把规则写死了，这一步只是把它变成代码。

新建 `packages/world-memory`（新包，不塞进 skills——skills 依赖它，反过来会成环）：

- `WorldMemoryRecord` 的 Zod schema：`{serverProfileId, dimension, position:{x,y,z}, kind, observedAt, confidence, payload}`。三元组任一缺失 → **parse 失败**，不做默认值兜底。`kind` 用显式枚举：`ORE_VEIN | SAFE_SITE | OWN_STASH | OWN_HIDEOUT | VILLAGER | HIGHWAY_NODE | HAZARD | PORTAL_SUSPECT | BLUEPRINT_ANCHOR`。
- 仓储接口 `WorldMemoryRepository`：**每个查询方法的第一个参数都是 `serverProfileId`**，且实现层把它拼进 WHERE。不要提供"查全部"的方法——不存在的方法没法被误用。P2.1 的 Postgres/pgvector 实现照 `postgres-repository.ts` 的既有形状做，但本阶段先落**内存实现 + 接口 + 全部隔离测试**，Postgres 留到 P2.1，避免这一步卡在基础设施上。
- `switchServer(next)` 语义：换服即整体切换可见空间，**上一个服的坐标一律不可见**（不是过滤后为空，是访问不到）。进行中的坐标类任务作废重排的钩子留出来，但作废动作归任务层。
- 单调时钟保护 + `observedAt` 过期标记，照 `PredictionEngine` 的既有纪律（时间回退抛 `RangeError`）。
- 记忆是**衰减**的，不是真相：给每条记录 `confidence` 与 `staleAfterMs`，读出来带 `fresh | stale` 标签。无规则服的地形每天都在变，一个三周前的"安全落脚点"很可能是别人的基地。

验收：隔离测试里写 A 服记录 → 切到 B 服 → 同坐标查询必须**查不到**（不是查到空数组就完事，要有一条断言证明跨服读被结构性挡住）。再补一条反向变异：把仓储层的 `serverProfileId` 条件换成 `if (false)`，确认隔离测试确实红。

### N1 · 长程分段旅行 `travel.route`（评分 9.3，规划级，无需探针）

这是解锁其余一切的那一步。现在 64 格硬顶，意味着"去矿区""去落脚点""去村民那儿"全都无法表达。

**不要动 `SAFE_PATH_MAX_DISTANCE`。** 做法是在它之上加一层分段器：

新建 `packages/skills/src/builtin/travel-route.ts`，技能 id `travel.route@1.0.0`，capability `bot.move`，operation `travel.route-segment`：

- 输入 `{destination, dimension, serverProfileId, maxSegments, corridorPolicy}`。规划器把总距离切成 ≤64 格的段，**每段都是一次独立的 `pathfinder.goto-safe`**，于是取消、L0 抢占、断线在段边界天然生效——这正是不许拧大上限的原因。
- `idempotent: false`、`maxAttempts: 1` 保持不变，但**段级重试**是允许的：某段 `PATH_TARGET_NOT_REACHED`（已分类为 `STALE_WORLD` → `REOBSERVE_THEN_RETRY`）则重新观察后重排该段，不重跑整条路线。
- 拒绝顺序：`BOT_NOT_ONLINE` → `NORMAL_ACTIONS_PAUSED` → `BOT_POSITION_UNAVAILABLE` → `TARGET_SERVER_PROFILE_MISMATCH` → `TARGET_DIMENSION_MISMATCH` → `POLICY_ROUTE_SEGMENT_LIMIT`（段数超 `maxSegments`）。前五个复用现有码，一个新码。
- **每段结束落一条审计**：请求的段终点 vs 实际到达点、耗时、是否被 L0 打断。这是"请求 vs 执行"原则在移动层的落点，也是将来判断"这条路线是不是被 lag machine 卡住"的唯一依据。
- **公路循迹按 §6 做成简化模式**：无规则服的坐标轴高速/地狱顶层公路是笔直隧道，沿轴对齐 + 前方障碍检测就够，不需要完整 A*。这条分支的价值是绕开 `pathfinder` 在长直线上的开销。
- **维度切换不在本技能内**：过门是独立动作（要读实时世界状态确认落点），本技能拒绝跨维度目标（`TARGET_DIMENSION_MISMATCH`），维度衔接由调用方按段编排。这一条是硬的——战斗层 W4 已经吃过"过期的维度信念"的教训，旅行层不要重犯。

**鞘翅先不做**（v2 M1 的 `travel.highway` + 鞘翅飞行仍归 M1）。理由具体：§14 把 `mineflayer-elytrafly`（ISC）标为"谨慎，2023 年起停更，无烟花的向量飞行易被判定"，而烟花推进式要自研物理，属独立工作量。N1 只交付地面/隧道分段，鞘翅在 N1 之上加一层推进模型，不要塞进同一个模块。

### N2 · 安全选址与掩蔽 `site.assess` / `shelter.dig`（评分 9.0，战术级+规划级，无需探针）

用户单独点了"寻找安全地方"。这在无规则服是**第一防御**（§11：第一防御是没人找得到，第二才是墙厚），而现在整个仓库只有 L0 的事后反应。

新建 `packages/skills/src/planning/site-assessor.ts`——**纯函数、无时钟、无 IO**，这样选址规则可以完全离线单测：

- `assess({candidate, worldFacts, ownRecords, policy})` → `{score01, verdict: 'ACCEPT'|'REJECT', hardRuleFailures: readonly SiteRule[], exposureFactors}`。
- **硬规则先跑，评分后跑**（照 `crystal-engine` 的"红线在任何评分之前"）：距出生点 ≥ N 格、距坐标轴/主干道 ≥ N 格、不在主世界地狱门连线上、**避开整千/整数/对称坐标**（人类爱建在整千坐标，避开反而隐蔽）、不在已知 `HAZARD` 附近、不与已知 `OWN_HIDEOUT` 过近（分散建点，一点暴露不牵连其他）。任一硬规则失败 → `SITE_REJECTED_BY_HARD_RULE`，**不进评分**。
- 评分只在硬规则全过之后算：资源可达性（木/石/水/动物）、埋深可行性、逃生路线数、玩家流量估计（来自 N0 的历史观测）。
- **`ownRecords` 必须注入**，模块自己不查库——保持纯函数，也让"己方隐蔽点不被自家侦察 bot 误标为敌情"（§11 最后一条）能被单测锁住。

配套技能两个：
- `site.assess@1.0.0`（capability `world.read`，只读，无副作用）——评估当前位置或给定候选点，输出写入 N0 的 `SAFE_SITE` / 拒绝原因。
- `shelter.dig@1.0.0`（capability `world.interact`）——§11 的掘洞自保：就地掘入 + 身后封块，**硬禁直下**（`POLICY_STRAIGHT_DOWN_FORBIDDEN`，防岩浆/摔落，确定性硬规则）。天黑或遇敌无法脱离时用。

**明确不重写 L0**：饥饿/岩浆/坠落/溺水/卡死的阈值检测与进食/撤退/上浮动作 `packages/safety` 已有确定性实现（`CRITICAL_HEALTH=4` 等），本模块**在其之上**做前瞻选择，不得另写一套存活逻辑（v2 M1 明令，两者是同一层能力）。`shelter.dig` 触发时若 L0 正在处置更高风险，**让位**，拒绝码 `NORMAL_ACTIONS_PAUSED`。

风险：选址硬规则的"N 格"阈值现在是拍的。做成 `ServerPolicy` 旁的独立可配置对象并写明"未实测"，不要散在代码里当魔法数。

### N3 · 挖矿策略 `mine.vein` / `mine.branch`（评分 8.7，规划级，无需探针）

现在只有 `collect.block`（就近采 ≤32 个、≤32 格）。它对"砍 8 根木头"够用，对"搞 64 个铁"完全不够——没有 y 层选择、没有分支挖矿、没有回填、没有岩浆判据。而黑曜石/铁/钻石是整条战备物资链的地板（§11 自举层 2、层 6）。

新建 `packages/skills/src/planning/mine-planner.ts`（纯函数）+ 两个技能：

- **`mine.branch@1.0.0`**：分支挖矿。输入 `{targetItem, yLevel, branchLength, branchSpacing, maxBlocks}`。规划器产出**有序**的挖掘序列（主隧道 + 间隔分支），一次技能调用只走一段有界序列。
- **`mine.vein@1.0.0`**：矿脉跟随。发现目标矿后沿连通矿脉挖完再返回，上限用 `maxBlocks` 而不是"挖到没有"——无界循环在无规则服等于站在原地不动几分钟。

关键设计点，每条都有具体理由：

- **y 层是输入，不是常量**。矿物分布随版本变（1.18 之后改过一次，1.21.x 内部也有微调），把 y 层写死等于把版本假设焊进代码。做成调用方注入 + 带最低版本守卫的默认值表，并标"未实测"。
- **岩浆/虚空判据是硬拒**，不是评分项：`MINE_LAVA_ADJACENT`（相邻或斜下有熔岩）、`MINE_VOID_RISK`（y 低于安全底线）。两码都要进显式分类表——按当前形态规则 `MINE_LAVA_ADJACENT` 会落 `UNKNOWN`。
- **回填/掩埋是默认开，不是选项**（§11 反坐标暴露）。露天隧道是坐标泄露，跟被人看见没区别。`backfill: true` 为默认值，关掉要显式传参并在审计里记原因。
- **挖掘门自己带**：`goto-safe` 的 Movements 是 `canDig = false`，`invokeCollectBlocks` 单独开了 `canDig` 并挂 `exclusionAreasBreak`。新模块必须**显式**声明自己的 exclusion（绝不挖：己方 `OWN_HIDEOUT` 结构、`BLUEPRINT_ANCHOR`、承重方块、水/岩浆相邻面），不要指望继承任何现有配置。
- **`maxDigStartsPerSecond` 是策略闸的**（STRICT 4 / VANILLA 6 / NORMAL 8）。挖矿是本批唯一会长时间顶着这个上限跑的模块，所以它必须**排程而不是轮询**——被 `POLICY_RATE_EXCEEDED` 拒了要按 `waitMs` 等，不要打满重试。
- 矿点写入 N0 的 `ORE_VEIN`，带 `confidence`。别人也在挖同一片区块，一个两周前的矿脉记录很可能已经空了。

风险：分支挖矿会长时间停在同一片区块，这在无规则服是**被发现的高风险行为**（挖掘声音、区块加载痕迹）。所以模块要暴露 `estimatedDurationMs` 与 `exposureScore`，让战略层能在"要这批铁"和"别在这儿待太久"之间取舍——**不要在模块内部替它决定**。

### N4 · 村民交易 `trade.villager`（评分 8.2，战术级，无需探针）

用户点名了交易。这是本批**改动面最宽**的一项：它不只是加技能，是给资源模型加一条获取边。

**四处要一起改，缺一条规划器就用不上**：
1. `resource-graph.ts`：`acquisitionKinds` 加 `"trade"`；`resourceStations` 加 `"villager"`（它不是方块，但在图里扮演同一角色——附一句注释说明这个类比的边界）。
2. `goal-planner.ts`：`planStepKinds` 加 `"trade"`。
3. `skillIdForStepKind`：`"trade" → "trade.villager"`。
4. 新技能 `trade.villager@1.0.0`。

技能设计（原生 API 已够，**不需要新依赖**）：

- capability：`world.interact`（开界面）+ `inventory.write`（物品进出）。operation `trade.villager-safe`。运行时侧走 `bot.openVillager(entity)` → 读 `villager.trades` → `bot.trade(villager, tradeIndex, times)` → **读回实际库存变化**，永不用请求数当结果（照 `container.transfer` 的 `movedCount` 先例）。
- 输入 `{villagerEntityId, wantItem, maxUnitPrice, maxTrades, dimension, serverProfileId}`。**价格上限是必填**，不是可选——没有上限的自动交易会在一次 `priceMultiplier`/`demand` 波动里把整仓绿宝石换成没用的东西。
- 拒绝顺序：`BOT_NOT_ONLINE` → `NORMAL_ACTIONS_PAUSED` → `TARGET_SERVER_PROFILE_MISMATCH` → `VILLAGER_NOT_FOUND` → `VILLAGER_OUT_OF_REACH` → `TRADE_OFFER_NOT_FOUND` → `TRADE_DISABLED`（`tradeDisabled` 或 `nbTradeUses >= maximumNbTradeUses`）→ `TRADE_PRICE_UNACCEPTABLE`（`realPrice`/`specialPrice` 超上限）→ `TRADE_ITEM_NOT_IN_INVENTORY` → `INVENTORY_FULL`。
- **新码里 `TRADE_DISABLED` 与 `TRADE_PRICE_UNACCEPTABLE` 必须进显式表**（否则落 `UNKNOWN` → 找人）。建议 `TRADE_DISABLED → STALE_WORLD`（村民刷新交易后就能继续，重新观察是对的下一步）、`TRADE_PRICE_UNACCEPTABLE → UNSUPPORTED`（价格是对方的属性，重试不会变；换村民是调用方的决策）。`VILLAGER_OUT_OF_REACH` 和 `TRADE_OFFER_NOT_FOUND` 形态兜底已判对（`OUT_OF_REACH` / `STALE_WORLD`），不必进表。
- `idempotent: false`、`maxAttempts: 1`。交易是**不可逆的物品交换**，重放风险和 `container.transfer` 同级甚至更高。结果不确定时走 `NON_IDEMPOTENT_RESULT_UNCERTAIN`（已在表里，`CONTRACT_BUG` → 直接上报，绝不重试）——这是对的，宁可上报一次也不要重复付款。

**无规则服的现实，必须写进模块文档**：主城/出生点附近的村民**通常已经被清空或被围起来**，交易站往往是别人的领地。所以：
- 交易点位置进 N0 的 `VILLAGER`，带 `confidence` 与流量估计；靠近前先按 §1 假设 4（痕迹=暴露）评估。
- **禁止**为交易做任何自由文本交互，也**禁止**新增"这个玩家的交易站可以用"之类的判断——白名单外一律敌对（§2 红线 1）。
- **猪灵以物易物（bartering）先不做**，登记备查：它是独立机制（金锭 → 随机战利品表），战利品表随版本变，且要处理猪灵敌对状态。做的话是另一个技能 `trade.barter`，不要塞进 `trade.villager`。

### N5 · 蓝图建造 `build.blueprint`（评分 7.8，规划级，无需探针）

现在只有 `world.place-block`（一次一块、放置后读回校验）。§11 的自举科技树、抗爆壳、隐蔽基地全都需要"按图施工"这一层。

新建 `packages/skills/src/planning/blueprint-planner.ts`（纯函数，无时钟）+ 技能 `build.blueprint@1.0.0`：

- 蓝图用**相对坐标 + 锚点**表达，不用绝对坐标：`{anchor, dimension, cells: readonly {offset, blockClass, order}[]}`。绝对坐标的蓝图换个地方就废，也让"分散建点"没法复用。
- **排序就是这个模块的价值**（和战斗层 W6 包围规划器同理）：先摆结构必需与承重的，再摆外壳，最后摆装饰。中途被打断时，已完成的部分必须是**可用的中间态**，不是半塌的壳。这一条要有测试：截断到任意步数，断言结构不变量仍成立。
- **每块都走 `world.place-block` 的既有路径**（`block.place-safe` + 放置后读回），不新造放置通道。蓝图层只负责顺序与位置，不负责放置语义。
- 拒绝顺序：`RETREAT_IN_PROGRESS` → `NORMAL_ACTIONS_PAUSED` → `BLUEPRINT_ANCHOR_INVALID` → `BLUEPRINT_MATERIAL_INSUFFICIENT` → `ALL_CELLS_OUT_OF_REACH` → `BLUEPRINT_STEP_BLOCKED`（某格被占且不可清除）。`BLUEPRINT_STEP_BLOCKED` 和 `BLUEPRINT_ANCHOR_INVALID` 要进显式表（前者 `STALE_WORLD`，后者 `CONTRACT_BUG`）；`BLUEPRINT_MATERIAL_INSUFFICIENT` 形态兜底已判 `MISSING_RESOURCE`，正确，留着。
- `maxPlacementsPerSecond` 是策略闸的（STRICT 4 / VANILLA 6 / NORMAL 8）。一面 16×16 的墙就是 256 次放置——**至少一分钟**，期间 bot 站着不动。所以蓝图技能必须支持**分批续建**（输入带 `startIndex`），并把 `estimatedDurationMs` 暴露给调用方。
- 锚点写入 N0 的 `BLUEPRINT_ANCHOR`，且 N3 的挖掘 exclusion 要认它——否则自家挖矿会把自家墙挖穿。

**明确不做**：复杂红石/活塞结构（刷沙机、恶魂场、末影人场）。§11 已经写清它们"逐块按 schematic 铺设慢且脆，属后期能力（M4 之后）"。本阶段只交付蓝图执行器本体 + 简单结构（庇护所、黑曜石壳、围墙、基础农场）。**不要在任何文档里把"全自动量产水晶"写成近期可交付**——它是终局，不是起点。

### N6 · 仓储分拣与水位 `store.sort` / `pack.shulker`（评分 7.0，规划级，无需探针）

§11「存储系统」与 §12「后勤」都指向同一件事：作战集群吞吐大、损耗快，**没有水位就没有调度**。现在只有 `container.transfer`（单次定向搬运），没有分类、没有计数、没有打包。

- `packages/skills/src/planning/stock-levels.ts`（纯函数）：每种战备物资三档水位 `{low, target, ceiling}`。低于 `low` 触发生产报警，到 `ceiling` 停产/转存。**纯计数逻辑，零 AI**——AI 只决定阈值定多少（§11 明确切分）。
- `store.sort@1.0.0`：按类路由到指定容器区（甲/水晶/火药/建材各自成区）。走既有 `container.transfer-safe`，不新造通道。
- `pack.shulker@1.0.0`：整组物资灌入潜影盒，减少满箱 bot 往返（**往返 = 暴露**，§12）。
- **食物不设水位**（§11 明确"食物免管理"）：农场建好即忽略，不占调度注意力。真正要盯的是装备/附魔/黑曜石/水晶/附魔瓶。
- **3-2-1 分散存放**：核心隐蔽仓 + 前线周转仓 + 应急暗仓，任一仓被端不清零；高价值优先进最深隐蔽仓。仓库坐标与水位写入 N0（`OWN_STASH`）。
- 潜影盒是容器**也是物品**——放地上会被别人挖走。打包技能要明确它只在**已确认的隐蔽点**内操作，不在野外拆包。

风险：水位数据一旦进战略层调度，"报警"就会变成任务生成源。要给报警加**去抖**（同一物资的低水位报警有最小间隔），否则一次库存抖动会刷出一串重复采集任务。

### N7 · 跑酷与移动策略放宽（评分 5.4，规划级，**放宽方向，排最后**）

用户把"跑酷层"放在第一位提，但按项目自己的红线，它**必须排最后**，理由不是保守：

跑酷需要同时放宽**两层**独立的安全配置——`configureSafePathfinderMovements` 里的 `allowParkour`/`allowSprinting`/`allowFreeMotion`/`maxDropDown`，以及 `ServerPolicy` 的 `allowSprintJumpCombo`（STRICT/VANILLA 两档都是 false）/`allowAirStrafe`/`maxFallBlocks`。而这两层是**反作弊面向**的：跑酷跳在服务端看就是一串 sprint+jump+落点位移，正是最容易被判定的动作序列之一。收益是省几秒路程；代价是提高被判定概率 + 一次失败跳跃可能摔死掉光装备（§1 假设 6）。**在无规则服，"省几秒"排在"别死"和"别被判定"之后。**

所以本项做法是**可选、可关、默认关**：

- 新增 `MovementProfile`：`SAFE`（现状，默认）/ `PARKOUR`（放宽）。`PARKOUR` 只在 `ServerPolicy` 明确允许时可选，且**只在隔离测试服**启用——策略档不允许时选它 → `POLICY_PARKOUR_FORBIDDEN`（`POLICY_` 前缀是硬要求，见 §2）。
- `movements.allowParkour = true` 必须与 `ServerPolicy.allowSprintJumpCombo` **联动校验**，不许各自为政：一个说能跳、一个说不能组合，就是不能跳。这个联动要有测试。
- `maxDropDown` / `maxFallBlocks` 同理联动，且 `maxFallBlocks` 的 schema 上限是 8——不许为了跑酷去改 schema。
- **默认关，且文档里不得写"已解决检测问题"**：类人化/抖动只降低明显破绽，残余封号风险由使用者承担（AGENTS.md §0.4）。
- 单独交付一条**开销测量**：`PARKOUR` 档下的寻路耗时与事件循环延迟。§6 与 AGENTS.md §0.5 都写明"远距离探索寻路 CPU 密集，若实测阻塞事件循环（>50ms）才考虑抽 Rust 寻路服务——**先测量**"。这一档正好是把测量做出来的机会，别浪费。

### 后续（本批不做，登记备查）

- **鞘翅飞行 `travel.elytra`（归 M1）**：烟花推进式自研；`mineflayer-elytrafly`（ISC）是向量式、2023 年起停更、易被判定，只作机制参考（§14）。
- **`interact.sleep`（床/重生点）**：ROADMAP P1.5 已登记未做。无规则服要注意床在下界/末地会爆——维度门控必须读**实时**世界状态（和战斗层 W4 同一个坑）。
- **`trade.barter`（猪灵以物易物）**：独立机制、战利品表随版本变、要处理猪灵敌对，别混进 N4。
- **`scan.portal` / `probe.roof`（§8 侦察战术，归 M2）**：依赖 N0 的记忆底座，N0 做完就解锁了。
- **`interact.enchant` 附魔（§11 自举层 7）**：mineflayer 有原生 `enchantment_table` 与 `anvil` 插件，但附魔是随机 + 消耗经验，重放风险高，要按不可幂等处理。
- **农业循环（种植/收割）**：ROADMAP P1.5 已登记；蓝图执行器（N5）落地后它基本是配置而不是新能力。

## 四、明确否决的东西（别做，问了也别做）

- **调大 `SAFE_PATH_MAX_DISTANCE`**：要走远做分段（N1）。拧大上限等于让一次技能调用变成不可取消的长程漫游。
- **任何形式的聊天/喊话/议价/招募**：AI 输出只能是校验过的白名单技能调用 JSON。交易也不例外。
- **在非战斗模块里新增"这个玩家友善/这个交易站能用"的判断**：白名单外一律敌对，白名单只能由用户显式配置。
- **默认开跑酷，或把跑酷写成"已规避检测"**：见 N7 与 AGENTS.md §0.4。
- **绕过 N0 各自缓存坐标**：跨服污染是数据层要根除的，不是靠"bot 记得住"。
- **在出生点半径内选址/建造/长时间挖矿**：出生战区，硬拒。
- **无界挖掘循环**（"挖到没有为止"）与**无界建造**（一次调用铺完 256 块）：都要有界 + 可续。
- **放宽 `server-profile.ts:72` 的 `purpose: z.literal("isolated-test")` 或 `:92` 的 `auth: z.literal("offline")`**；启动器也不得自动生成 `DASHBOARD_STOP_CONFIRMATION_SHA256`，停机口令必须由人选。
- **复杂 duper / 红石农场当近期目标**：§11 已定为 M4 之后。

## 五、纪律与验收

- **一个模块一次，每阶段独立提交，每阶段 `pnpm check` 全绿**（`pnpm typecheck && pnpm test && pnpm build`）。
- 新增失败码 → 必须同时补 `failure-classifier` 的分类表条目与恢复阶梯（完备性测试会红）；新增失败类别 → 必须补 `plan-supervisor` 的钩子与映射，否则监督器会静默把动作当成已满足。**新增策略拒绝码一律 `POLICY_` 前缀**（见 §2 的具体理由）。
- 新增 capability operation → 必须同时在 `mineflayer-client.ts` 的分发表里接线，否则技能声明了也只会拿到 `SKILL_CAPABILITY_UNAVAILABLE`。**现成的反面教材就在仓库里**：`combat.control` 已在 `skillCapabilitySchema` 里、`combat.engage` 已注册，但运行时零命中，于是它必然停在 `COMBAT_DRIVER_UNAVAILABLE`。
- 关键守卫用**反向变异**验证：把守卫换成 `if (false)`，确认指定测试确实红，再还原，并确认 `grep -c "if (false"` 为 0。
- 状态 schema 一律 `.strip()` 不用 `.strict()`：运行时下发**同一份共享 state**，任何技能新增观测字段都会让 strict 的兄弟技能报 `SKILL_STATE_INVALID`（`equipArmorStateSchema` 已立此先例；`movement-goto` 是最后一个改过来的）。
- `apps/bot-runtime` 解析 `@minecraft-studio/skills` 到**构建产物 dist**，改了 skills 源码要先 build，否则它的测试看不到修复（这个坑已经吃过一次，表现为"改完还是 5 个失败"）。
- 新增第一档（MIT/ISC）插件依赖走 §14 引入流程：`npm view <pkg> license` + 读 LICENSE 双重确认 → 锁精确版本（不用 `^`/`~`）→ 记来源/许可/完整性哈希 → 包一层本项目技能接口 → L0 暂停/停机/取消能中断 → 隔离服过场景测试才进注册表。**警惕同名坑**：`mineflayer-auto-eat`（MIT）与 `@nxg-org/mineflayer-auto-eat`（GPL）是两个包。本批 N0~N7 按现有依赖就够，不需要新插件。
- 汇报用中文，写清：做了什么、跑了哪些命令及**原始退出码与测试数**、遗留边界、当前所处环境段（隔离/私有测试/正式）。
- **时序与数值诚实**：本文件所有毫秒、格数、y 层、产量都是设计目标。研究期间**没有连接任何 Minecraft 服务器**；本仓库目前只有 `smelt.item` 有真实服务器覆盖（`CHANGELOG.md:306-307` 记录 v0.3.1 的真实 1.21.8 回环验收）。凡未实测的数值，文档里写"未实测"。

## 六、顺手要修的两处陈旧记录（小，但会误导人）

- `packages/skills/src/builtin/catalog.ts` 的注释仍写"七个技能"（三处），实际注册了 **9 个**（多了 `combat.engage` / `combat.disengage`）。catalog 本身就是为了消灭"数字抄在三处"才建的，注释自己变成第二份真相有点讽刺，顺手改掉。
- `docs/codex-handover-prompt.md:7` 与 `:58` 里的项目路径与 Node 路径都是旧机器的（`C:\Users\baichengbo\...`），当前工作目录是 `C:\Users\renna\Desktop\ai work\minecraft-multi-agent-studio`。

---





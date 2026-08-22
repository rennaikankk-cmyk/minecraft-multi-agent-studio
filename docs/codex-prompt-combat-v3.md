# Codex 提示词 · v3 增补：战斗层接线 + 四仓库研究成果

> 使用方法：把下面分隔线内的全部内容作为一条消息发给 Codex。本文件**不取代** `docs/codex-handover-prompt.md`（v2 仍是主蓝图与红线来源），只增补 §5 战斗层的后续工作。
>
> 研究来源：`g255x/AstraPlus`、`huangdihd/xinbot`、`luckui/HiyoriAI`（原 `luckui/ai-live2d-go`）、`KyaKayKya/Minecraft-PVP-ROBO`，加上对本仓库的实地核对。研究者未连接任何 Minecraft 服务器，所有时序数字都是**设计目标，不是实测值**。

---

你将接管 Minecraft Multi-Agent Studio 的战斗层后续开发。先读 `docs/codex-handover-prompt.md`（v2 全部红线继续有效）、`AGENTS.md`、`docs/combat-tactics-reference.md`。本提示词补充的是 v2 里 §5 之后的具体工作项，按 W0~W8 编号，**不跳级**。

## 零、先看清现状：`@minecraft-studio/combat` 是一座孤岛

这是全部研究里最重要的一条，比任何新功能都重要：

- `packages/combat/src` 有 16 个模块、`packages/combat/tests` 有 14 个测试文件共 **209 个测试用例**，全绿。
- `apps/bot-runtime/package.json` 声明了依赖，`apps/bot-runtime/src/combat-entity-adapter.ts` 也确实 import 了它——但那个适配器只做实体视图转换，且在 `apps/bot-runtime/src/index.ts:59` **仅被再导出，没有任何调用点**。
- 全仓库 grep `TotemManager|CrystalEngine|PacketMineController|TargetSelector|RetreatController|WeaponManager|GearAssessor` 在 `apps/*/src` 里**零命中**。
- 技能目录里**没有任何 `combat.*` 技能**（`packages/skills/src/builtin` 现有 id 只有 collect.block / craft.item / world.place-block / container.transfer / smelt.item / movement.goto / inventory.equip-armor）。
- `apps/dashboard/app/combat/page.tsx` 是一页硬编码中文角色简介，零实时数据，不 import combat 包。

**结论：先接线，再加功能。** 一个没有消费者的模块，它的 209 个测试证明的是"函数按我写的那样算"，不是"bot 会打架"。W0 必须先做完，否则后面每一个新模块都只是往孤岛上再加一栋楼。

## 一、许可与平台判定（先读，决定什么能碰）

| 仓库 | 许可 | 结论 |
|---|---|---|
| `g255x/AstraPlus` | **无 LICENSE 文件 = 保留所有权利** | 比 GPL **更严**。只可作为游戏机制情报阅读，**一行代码都不能搬**。它还是 Java 21 / Fabric Loom 1.17.2 / MC 1.21.1 的**客户端模组栈**，AGENTS.md §0.6 明令不引入。`lib/` 里 satin、IAS 两个 jar 各有独立条款，同样不得 vendor。 |
| `huangdihd/xinbot` | GPL-3.0-or-later | docs §14 二级：可读机制、不可依赖、不可复制。 |
| `KyaKayKya/Minecraft-PVP-ROBO` | **MIT** | 一级，可直接参考代码与数值。 |
| `luckui/HiyoriAI`（原名 `ai-live2d-go`，已重定向） | **MIT** | 一级。注意研究前提两处纠正：它**不是 Go**（TypeScript + Electron，全仓库无 `go.mod`），而且它**是 Minecraft 项目**——`electron/minecraft/` 是 30 个文件的 mineflayer 具身运行时（mineflayer 4.33.0 + pathfinder 2.4.5 + collectblock + tool + pvp + auto-eat，全部 patch-package 锁定）。它是本项目最近的同栈前例。 |

AstraPlus 的实际价值：它 133 个模块里 combat 25 个、movement 21 个、exploit 17 个，README 那 8 个模块全部对应真实文件（`combat/AutoAnchor.java`、`combat/Surround.java`、`combat/AntiPistonPush.java`、`misc/PopEz.java` 等）。**这个模块分布本身就是情报**：它告诉我们一个专业水晶/重生锚 PvP 客户端认为什么必须有——重生锚、包围、POP 检测、反活塞——而我们四项全缺。研究者只读了目录清单与构建元数据（`build.gradle` / `gradle.properties` / `fabric.mod.json`）和 README，**没有打开任何实现文件**，所以下面每条机制都来自 Minecraft Wiki 公开机制 + 本仓库实地核对，不来自它的源码。

## 二、红线（v2 全部继续有效，这里只强调本批最容易踩的四条）

1. **敌我识别仍是确定性白名单，AI 无权增删。** 本批新增的任何"机会窗口"（图腾 POP、盾牌破防、i-frame）都只是**打法输入**，不得成为判敌依据。
2. **水晶/重生锚自伤红线不得放宽。** 预估自伤击穿"当前生命 − 图腾余量"一律拒绝。W2 会给红线引入护甲减免（`mitigation01`），这是**放宽方向的改动**——因此附带一条强制规则：附魔观测不完整时 `mitigation01` 必须按 0（fail-closed）计算，绝不"假设对方大概有防爆"。
3. **反射级（≤50ms）模块未过时序探针不得上真实对抗。** 本批只有 W7（`armor-swapper`）和 W8 里的窒息逃脱是反射级，两者都探针门控。W1~W6 全是战术级（≤200ms），可以在探针之前实现并单测——但**不得借新模块绕过探针**：`chain-sequencer` 如果被要求排一条步间间隔 <50ms 的链，必须要求传入已通过的 `CombatReflexDecision`，否则抛 `CombatReflexNotClearedError`，和 `crystal-engine` 现在的做法一致。
4. **抖动不是反封号。** `DeterministicJitter` 用在链式节奏上是为了不做固定 200ms 节拍器，**只降低明显破绽**。任何文档、注释、提交信息里不得把它写成"已解决检测问题"；快于人手的操作依然可观测，残余风险由使用者承担（AGENTS.md §0.4）。

另外一条来自 PVP-ROBO 的架构原则，请在本批全程遵守：**记录"请求了什么"与"实际执行了什么"两份数据，不要只留一份。** 它的做法是每帧回报 `executed | clipped | delayed | dropped | modified` 加机器可读原因，并在解码期用禁用字段扫描强制拒绝 aimbot 类便利字段（auto aim、combo、W-tap、critical attack、attack-when-ready）。这个"把动作空间的诚实性做成解码期不变量、而不是 code review 约定"的思路，比它的任何战术都更值得抄——而且它是 MIT，可以直接参考。

## 三、任务清单（按序，一个模块一次，每阶段独立提交，每阶段 `pnpm check` 全绿）

### W0 · 把战斗层接上真实运行时（最高优先级，先做完再碰新功能）

没有这一步，后面全是孤岛。要求：

1. 在 `apps/bot-runtime` 建一个确定性战斗驱动器，按现有三层预抢占顺序调度已有模块：`TotemManager`（最高）→ `CrystalEngine` / `PacketMineController` → 战术级（`TargetSelector`、`ThreatAnalyzer`、`WeaponManager`、`RetreatController`、`RotationController`、`GearAssessor`）→ 规划级（`MovementController`、`PredictionEngine`）。驱动器**零 AI**，输入是观测快照，输出是技能调用。
2. 落 `combat.*` 白名单技能（至少 `combat.engage` / `combat.disengage`），走和现有技能完全一样的路径：Zod 输入/状态/输出 schema、前置条件、`ServerPolicyGate`、能力声明、失败码进 `failure-classifier`。**新增失败码必须同时补分类表条目和恢复阶梯**，否则 `failure-classifier.test.ts` 的完备性断言会红。
3. 反射级模块的实盘入口继续走 `decideForLiveCombat(..., clearance)`，未过探针抛 `CombatReflexNotClearedError`。
4. Dashboard `combat/page.tsx` 从静态简介改成读真实状态（当前 stance、当前目标、最近拒绝原因、探针状态）。**没有数据就显示"未接入"，不要造模拟数据。**

验收：隔离测试服上，一次完整的"发现白名单外玩家 → 确定性评估 → 打或撤 → 结果落审计"闭环，附原始退出码与测试数。

### W1 · 图腾 POP 检测（评分 9.4，战术级，无需探针）

这是本批**唯一一个"数据就在线上、我们却看不见"**的缺口，性价比最高。

事实核对：mineflayer 4.37.1 的 `entityStatusEvents` 映射（`apps/bot-runtime/node_modules/mineflayer/lib/plugins/entities.js:23`）只有 `2,3,6,7,8,10,55`——**状态码 35（图腾生效）不在里面**，`entities.js:374` 只为已映射码派发事件。全仓库 grep `entity_status` 零命中。

设计：
- 运行时侧只加一个**只读**监听：`bot._client.on('entity_status', p => p.entityStatus === 35)` → 解析 entityId → 发出 `CombatTotemPopRecord{entityId, observedAtMs, serverProfileId, dimension}`。形状对齐现有 `combat-entity-adapter.ts` 的只读适配器，不做任何状态变更。
- `packages/combat` 侧是纯追踪器：`record(pop)` 带单调时钟保护（时间回退抛 `RangeError`）和跨服丢弃（照 `PredictionEngine` 的做法），`reset()` 在重连时调用。`windowFor(entityId, nowMs)` 返回 `{popped, elapsedMs, absorptionRemainingMs, phase: 'PUNISH'|'REGEN'|'EXPIRED'}`。拒绝顺序：`NO_RECORD → PROFILE_MISMATCH → WINDOW_EXPIRED`。
- **"可追击"的窗口只按吸收护盾的 5000ms 上限主张**；再生 II 的 45s 只用于是否重新接战，绝不表述为"免费击杀"。
- 消费者：`ThreatAnalyzer` 增一个 `TARGET_RECENTLY_POPPED` 机会原因，`TargetSelector` 据此重排。

两个附带收益，都要一并处理：
- 状态码 35 落在**我们自己**的 entityId 上，是比"diff 副手是否图腾"更早更权威的 `TotemManager` 触发源。
- `mineflayer/lib/plugins/inventory.js:69-74` 在**任何** `entity_status` 包上都清空 `bot.usingHeldItem`，不看码值也不看实体——也就是说**一个无关敌人弹图腾会静默毁掉我们的拉弓状态**，而 `WeaponManager.evaluateRanged` 的 `drawing` 参数正信任这个值。修的时候要连这个坑一起修。

**明确否决 AstraPlus 的 POP嘲讽（`misc/PopEz.java`）与 AutoEZ / Spammer。** 检测窗口收，自动发聊天不收：那是朝真人玩家发自由文本，等于把 AI 输出接到骚扰上，违反"AI 输出只能是校验过的白名单技能调用 JSON"，也不是让 bot 变强。

### W2 · 统一爆炸模型（评分 9.0，战术级，无需探针）

现状是三处各写一份且都偏小：`crystal-engine.ts:59-60` 的 `DEFAULT_CRYSTAL_POLICY` 是 `blastRadius: 6 / maxDamage: 12`，`threat-analyzer.ts:79` 独立写了 `CRYSTAL_RANGE = 6`。**水晶的实体伤害半径其实是 `2 × power = 12`**，我们两处都按 6 算，于是既低估水晶威胁、也少拒了远距离放置。更要紧的是红线：它拿**未经护甲减免的几何伤害**去比真实血量，全副下界合金 + 防护 IV + 防爆 IV 接触水晶大约只吃 ~10.8 HP，而当前模型报到 12 个无量纲单位——两个方向都不准。

新建 `packages/combat/src/blast-model.ts`，纯函数、无状态、无时钟：
- `blastDamage({power, blastCenter, victimPosition, victimEyeHeight, exposure01, difficulty, mitigation01})` → `{rawDamage, mitigatedDamage, distance, withinEntityRange}`。
- 公式用 Wiki 公开机制：`impact = max(0, 1 − distance/(2*power))`；`damage = (impact² + impact)/2 * 14*power + 1`，超出实体范围为 0；再按难度缩放（easy `min(d/2+1, d)`、normal 原值、hard `1.5d`），最后乘 `mitigation01`。**用 Wiki 公式是引用公开游戏机制，不是 §0.6 的抄码。**
- 导出 `BLAST_POWER = {crystal: 6, anchor: 5, bed: 5}` 与 `entityRangeFor(power) = 2*power`。
- `exposure01` 与 `difficulty` 保持**调用方注入**，和现有 `targetOcclusion` / `selfOcclusion` 契约一致；27 射线（3×3×3）采样是调用方的活，并在文档里写清每对实体的开销。
- `redLineBreached(mitigatedSelfDamage, health, totemMarginHealth)` —— 唯一不可谈判的判据集中到一处。
- `crystal-engine` 保留 policy 形状但 `blastRadius`/`maxDamage` 变成派生值，现有测试原样锁行为。

**风险，必须在同一个改动里处理完**：把水晶范围从 6 提到 12 会让 `WITHIN_CRYSTAL_RANGE` 命中大幅变多，`ThreatAnalyzer` 更频繁报 elevated/critical，进而可能连锁触发更多 `RetreatController` 撤退。阈值重调要和这次改动一起做，不能留到"以后"。另外模块必须保留 `crystal-engine` 现有的那句免责：exposure 注入、difficulty 注入，**输出不是服务端承诺**。

### W3 · 对手 i-frame 与冷却窗口（评分 8.8，战术级，无需探针）

这条来自 MIT 的 `Minecraft-PVP-ROBO`，可以放心参考数值。

现状：`weapon-manager.ts:93` 的 `minimumCooldownRatio: 0.9`（比研究得出的 0.85 还严，`MIN_ALLOWED_COOLDOWN_RATIO = 0.85` 是下界）只管**我们自己**的冷却，加上 `targetInReach`。也就是说一个够得着、冷却满的 bot 每次交手都会**直接砍进对方的无敌帧**。原版无敌帧 10 tick（~500ms），砍进去的那一刀伤害为零还烧掉我们自己 0.625s 的冷却，等于每次换血白扔一刀。

新建 `packages/combat/src/hit-window-tracker.ts`：
- `recordHurt(entityId, nowMs, serverProfileId)`、`recordSwingObserved(entityId, nowMs, fullCooldownMs)`，单调时钟 `RangeError` + 跨服丢弃 + `reset()`，纪律同 `PredictionEngine`。
- `stateFor(entityId, nowMs)` → `{invulnerableRemainingMs, cooldownRatio01, lastHurtAgeMs, confidence: 'observed'|'stale'|'unknown'}`。
- `WeaponManager` 按现有风格接**调用方算好的事实**（和 `targetInReach` 一样）：`evaluateSwing(weapon, nowMs, targetInReach, targetInvulnerableRemainingMs = 0)`，新增原因码 `TARGET_INVULNERABLE`，排序在 `NO_WEAPON`、`OUT_OF_RANGE` 之后、`COOLDOWN` 之前，并回传 `waitMs = invulnerableRemainingMs` 让调用方能排程而不是轮询。
- 数据源已经有了：mineflayer 的 `entityHurt`（状态码 2）以及 `entities.js:377-381` 的 1.20+ `damage_event` 处理。

**这是全项目唯一一处 fail-closed 是错的地方，请显式写进注释**：`confidence: 'unknown'` 时 `invulnerableRemainingMs` 默认 0（允许出手）。缺数据就拒绝出手会让 bot 直接哑火，比偶尔砍进 i-frame 糟得多。

风险：从 hurt 事件推的 i-frame 会滞后一个 RTT，排在 `remaining=0` 的那一刀仍可能落在无敌帧里；给 `CombatSwingDecision` 的联合类型加原因码会打断调用方的穷尽 switch（编译期会报，照着补）。**爆炸伤害走另一套判定，不遵循近战 i-frame 模型——这个追踪器绝不能用来门控水晶或重生锚引爆。**

顺带把 PVP-ROBO 的间距战术收进 `MovementController`：安全带 2.4~3.8 格，对手在无敌帧里就退到其攻击距离边缘，对手冷却回满再压上去。它是用奖励塑形表达的，我们用确定性带宽规则表达，等价且更符合本项目"零 AI"要求。

### W4 · 重生锚（评分 8.5，战术级，无需探针）

AstraPlus 八个模块里两个给了重生锚（`combat/AutoAnchor.java` 重生锚延迟计算、`combat/Surround.java` 重生锚包围），而我们**完全没有模型**——`docs/combat-tactics-reference.md:225` 只把重生锚当建筑材料提过一次，既没当武器也没当威胁。

**"共享伤害数学、拆开引擎"** —— 不要把它塞进 `CrystalEngine`，三个理由都具体：
1. **层级不同**：水晶是同一 tick 内放置即引爆，属反射级、被探针门控；重生锚是 放置 → 充能 → 使用，每步 ~200ms（冷启动 ~400ms，预充过 ~200ms），是战术级。折进 `CrystalEngine` 会白白继承 `planForLiveCombat` 的探针门控，把**唯一一件能在 M3 之前上线的水晶类武器**也一起锁死。
2. **状态不同**：`CrystalEngine` 只持一个 `placedAtMs` 和一个引爆窗口；重生锚要三步 ack 门控链加 0~4 充能模型。
3. **放置规则不同**：重生锚不需要黑曜石底座、不需要 2 格净空、可堆叠到 64，所以候选枚举必须**去掉** crystal 的 `hasValidBase` 过滤，并**加上**头部高度、头顶、以及我们自己包围结构的顶面。

新建 `packages/combat/src/anchor-engine.ts`（消费 `blast-model.ts`），两个纯入口：
- 进攻 `plan(candidates, targetPosition, self, dimension)`，拒绝顺序：`DIMENSION_IS_NETHER`（下界里充能锚是设置重生点而不是爆炸，进攻用途**直接拒绝，不进评分**）→ `NO_CANDIDATES` → `ALL_UNPLACEABLE` → `SELF_DAMAGE_RED_LINE`（走 `blast-model.redLineBreached`，**在任何评分之前**，与 `crystal-engine` 一致）→ `SELF_DAMAGE_ABOVE_CEILING` → `NO_GLOWSTONE_TO_ARM`（仅当候选尚未充能）→ `NET_GAIN_TOO_LOW`。输出加 `chargeStepsRequired`（充能 ≥1 时为 0）与 `estimatedArmMs`，让调用方能拿"上膛耗时"对比"来袭威胁"。
- 防御 `assessHostileAnchor(observation, selfPosition, dimension)` → `{armed, entityRangeUsed: 10, estimatedIncomingDamage, armLevel: 'PLACED'|'ARMED_ONE_CLICK'}`。威胁判定里**充能是个布尔**（1~4 级 power 恒为 5，不要按充能数建伤害曲线）；观测到的光照等级 3/7/11/15 是免费的充能状态读数。给 `ThreatAnalyzer` 一个**独立**的 `ANCHOR_PLACED` 原因、10 格范围，不要和 `CRYSTAL_PLACED` 合并——范围和反应窗口都不同。`DEFAULT_ANCHOR_POLICY` 的字段形状对齐 `DEFAULT_CRYSTAL_POLICY`，走同一条边界校验路径。

防御侧要认真对待：接触距离下重生锚伤害约为水晶的 83%（裸伤 71 对 85），当次要威胁处理是错的；而那 ~200-400ms 的上膛链**就是全部的防御机会**——反射预算的 4~8 倍，够我们反应。

风险（本批最高自伤风险）：链一乱序就是在自己脚下引一发 power-5；**恰好 4 级充能时会跳过 glowstone 分支，于是"手里有荧石"不再是安全联锁**。维度门控必须读**实时**世界状态，过传送门后绝不复用缓存——一个过期的"我在下界"信念会把设置重生点变成自杀。另外"爆心是方块中心"（锚在爆炸结算前已被移除，故不自遮挡）这条**没有从反编译源码核实过**，进攻用途启用前必须在隔离测试服上验证。

### W5 · GearAssessor 补爆炸轴（评分 7.4，战术级，无需探针）

对一个主要输出和主要挨打都是爆炸的 bot，**抗爆就是这场对局本身**，而 `gear-assessor.ts` 现在只有一个 `protectionLevel [0,4]` 折进通用减免乘数。

- 给 `CombatGearSnapshot` 加 `blastProtectionLevel [0,4]` 和 `armorPieceCount`。
- 导出**两个互相独立**的标量，不要合成一个数：`explosionMitigation01 = min(0.8, 0.08 * 总防爆等级 + 现有防护贡献)`（防爆每级 8%，四件 IV 共 32%；附魔总减免上限 80%），以及 `explosionKnockbackResistance01 = min(1, 0.15 * 总防爆等级)`（Java 版防爆额外给 15%/级爆炸击退抗性，多件叠加）。
- `explosionMitigation01` 单独导出，供 `crystal-engine` / `anchor-engine` 直接喂进 `blast-model` 的 `mitigation01`。
- 击退抗性是**被低估的那一半，而且两面性**：重抗爆把我们钉在原地，而"被炸出下一发的范围"本来是一条生路。所以只在评估结果里**暴露** `knockbackResistance`，**不折进结论**——钉住是好是坏是 `RetreatController` 的判断，不是 `GearAssessor` 的。
- 未知附魔数据继续 fail-closed：观测不到防爆就按 0 记，绝不假设。

风险：把真实减免喂进红线，会让它放行以前会拒的放置——这是**在放宽唯一不可谈判的安全规则**。因此附魔观测不完整时 `mitigation01` 必须按未知（0）处理，否则一次误读装备就是一次自爆。另外 8%/级与 80% 上限是 1.21.x 的数（1.21 Pre-Release 4 里 IV 级一度是 3.75%/级），常量要带最低版本守卫，别写成永恒真理。

### W6 · 包围 / 补洞规划器（评分 7.2，战术级，无需探针）

`docs/combat-tactics-reference.md` §4 把包围写成防御子模式，**没有任何实现**。这活特别适合本项目：任何 1200 抗爆值的方块（黑曜石、哭泣的黑曜石、下界合金块、远古残骸，以及重生锚本身）对 power-5/6 的爆炸都是数学上不可破的（水晶的破块能力上限约 25.16 抗爆值），所以包围防御是**纯确定性几何问题、AI 完全不在回路里**。

新建 `packages/combat/src/surround-planner.ts`，纯规划、无时钟：
- `plan({selfFootPosition, occupancy 查询, inventoryBlocks 按抗爆等级分类, reachDistance 来自 ServerPolicy, threatDirections, coverageObjective01})` → `{placements: 有序数组 {position, blockClass, offsetRole:'cardinal'|'below'|'above'|'diagonal'}, refusal, coverageAchieved01, exposedOffsets}`。
- 拒绝顺序：`RETREAT_IN_PROGRESS`（撤退优先，符合 §4，也和 `PacketMineController` 现有的让位顺序一致）→ `NO_BLAST_RESISTANT_BLOCKS` → `ALL_OFFSETS_OUT_OF_REACH` → `ALL_OFFSETS_OCCUPIED`。
- **排序就是这个模块的全部价值**：先摆最危险的那一面（朝向 `RetreatController` 已经在算的加权威胁质心），因为五格包围按原版 use 节奏要 ~1s，这一秒里我们始终半暴露。
- 覆盖度做成可调 `objective01` 而不是布尔，好让多智能体里一个 bot 取全防姿态、另一个保持进攻线路，而不是在单个 bot 内部折中。
- 用 `blast-model.entityRangeFor` 报告哪些偏移**真的降低了暴露**、哪些只是挡住了放置点。

只按水晶调的包围会漏防重生锚：那些"要底座""要 2 格净空"的过滤对锚**不成立**，所以头部高度、头顶、以及我们自己包围结构的顶面都是敌方可用的下锚点。

风险：包围会限制我们自己的移动，和 `MovementController` 的横移带**直接冲突**，撤退联锁必须显式，否则 bot 会一边想撤一边把自己砌死。放置走 use 门控，那 ~1s 交互预算重生锚链和换甲也在抢——没有共享节奏模型这三个会互相饿死（正是 W7 的理由）。

### W7 · 交互节奏与 ack 门控链（评分 6.6，战术级；子路径反射级需探针）

这是四个仓库里**最可迁移的一条**：每个 bot 动作都是一个带延迟的包，`放置 → 充能 → 激活` 这种链条用固定 sleep 排就会散。我们**完全没有 use 节流模型**——客户端每次使用把 `rightClickDelayTimer` 设为 4，也就是 use 路径的交互节奏约 200ms，而 attack 路径（靠攻击实体引爆水晶）**不共享这个门**。这个区别是承重的：`crystal-engine` 那个 50ms 放置→引爆窗口之所以合法，正因为引爆是 attack；但目前没有任何东西阻止调用方以为放置也能按这个速率重复。重生锚链、包围爆发、换甲三处都需要它，各写一遍必然写出三个不同的错答案。

新建 `packages/combat/src/chain-sequencer.ts`，纯函数 + 注入时钟、**不自建定时器**：
- 交互分两类：`use`（放置/充能/激活，受 ~200ms / 4-tick 节流）与 `attack`（打实体，不受 use 节流，但仍受武器冷却——那仍是 `WeaponManager` 的职责）。
- `nextLegalAtMs(class, nowMs)`；链式 API `beginChain(steps, nowMs)` 按**实测 ack RTT**（不是常量）推导每步排程；`recordStepAcked(label, nowMs)` 推进；某步 ack 超预算则给出拒绝 `STEP_UNACKED`，**而不是盲发下一步**。
- 拒绝顺序：`CLEARANCE_REQUIRED` → `RETREAT_IN_PROGRESS` → `THROTTLED` → `STEP_UNACKED` → `CHAIN_EXPIRED`。
- 步间间隔过 `DeterministicJitter`，避免固定 200ms 节拍器（**只是降低破绽，不是反检测，见红线 4**）。
- 每步暴露 `requestedAtMs` 与 `executedAtMs`，让"请求 vs 实际执行"是**记录下来的**而不是推断的——这份记录也正是让 M3 时序探针可测量而非靠感觉的东西。
- `CLEARANCE_REQUIRED` 是防后门的那道闩：步间 <50ms 的链属反射级，`beginChain` 必须要求已通过的 `CombatReflexDecision`，否则抛 `CombatReflexNotClearedError`。

依赖：需要运行时提供 ack 管道，**目前不存在**，这一项要连管道一起做。

### W8 · 版本安全的爆炸包适配器（评分 6.2，战术级，无需探针）

任何对来袭爆炸做反应的代码都要读爆炸包，而它的线格式在我们支持的版本区间里**不稳定**：1.21.1 有 `radius` 和 `affectedBlockOffsets`；1.21.3 两者全删；1.21.8 保持该形状但把 `playerKnockback` 从 `option<vec3f>` 改成 `option<vec3f64>`；1.21.11 又把 `radius` 加回来、并用 `blockCount` + `blockParticles` 取代偏移列表。读 `radius` 的代码对着 1.21.1 的协议数据能编译通过，在 1.21.3+ **静默拿到 undefined**——在伤害估算器里那就是一个静默的 0，而不是一声响亮的失败。

新建 `apps/bot-runtime/src/explosion-packet-adapter.ts`（和 `combat-entity-adapter.ts`、`version-compatibility.ts` 并列），只读：
- 把各版本 schema 归一成一个 `CombatExplosionObservation{center, knockback, radiusIfPresent: number|null, blockCountIfPresent: number|null, observedAtMs, serverProfileId, dimension}`——**"缺失"是一个值（null），不是 undefined**。
- 版本判定读 minecraft-data 自己的 schema，不要手写版本字符串 if/else；遇到不认识的形状**在适配器构造期抛错**，不要发出半解析的观测。
- `playerKnockback` 是全区间唯一始终存在、但中途改过类型的字段，统一走一个归一化函数。
- **爆炸威力永远从来源方块/实体加我们自己的 `blast-model.BLAST_POWER` 推，绝不从线上读。**
- 这个适配器不进 `packages/combat`（该包保持协议无关），combat 只消费归一化后的观测。

风险：版本覆盖是从 vendored `protocol.json` 断言的（1.21.1/3/4/5/8/9/11）；**1.21.0 在本机装的这份里没有可读的 protocol.json，未经验证，必须按"不支持"处理，不要假设它等同 1.21.1。** 不认识的 schema 直接硬失败是正确取舍，但要作为**启动期的明确拒绝**浮出来，不能变成打到一半崩掉。

### 后续（本批不做，登记备查）

- **敌方盾牌状态与斧优先（评分 5.8）**：老实说，`preserve-life` 姿态下副手归图腾——`TotemManager` 是最高反射抢占，`PacketMineController` 已经因此拒绝交战中的副手作业——所以**我们自己举盾对水晶 PvP bot 基本不可用**，价值只在可弃 bot 与脱战场景。有价值的是**敌方**的盾：它改变武器选择（斧破盾、剑不破），而盾牌格挡/破防是实体状态码 29 和 30，mineflayer 同样没映射（和码 35 一个坑，复用同一个订阅即可）。另记一条版本分叉：盾牌从 22w43a / 1.19.3 起才真正能挡重生锚与床爆，1.21.x 上举盾是货真价实的抗锚手段——但要带最低版本守卫，不要写成"能挡"。盾状态从格挡事件推必然是滞后的，`shieldUp` 默认 `unknown`、**绝不默认 false**。这是第二个来抢图腾槽的副手消费者，联锁必须走 `survival-stance.ts`，不要各自留一个局部布尔。
- **位置对账 / 位移监视（评分 5.2，检测部分战术级，窒息逃脱反射级需探针）**：`MovementController` 发出方向后**没人核对我们是否真的到了那儿**，于是爆炸击退、被推挤、活塞窒息三件事全看不见。这里研究**砍掉的比加上的多**：黑曜石、哭泣的黑曜石、重生锚都在不可推动清单里，所以没有活塞技术能挪走敌方的锚或破开黑曜石包围；而广为流传的"活塞挤压把玩家挤穿方块"只见于无版本号的内容农场页面，**不要建模**。剩下的是真的：活塞把实心方块推进我们无法让出的位置会造成窒息，从通电到方块落位约 100-150ms。分层要诚实——分类与击退恢复是战术级、可以先上；窒息逃脱必须在 100-150ms 内动作，那个入口是反射级、要吃 `CombatReflexDecision`，M3 之前**只交付检测与遥测**。活塞的具体数字（偏移碰撞箱、每 tick 推进、3 tick 伸出）来源单薄且无版本号，需在隔离服重测。
- **`manage.armor` 换甲（评分 4.8，反射级，探针门控）**：三层预算点名四个反射模块，只有三个存在。§3 已写明它与既有的 `inventory.equip-armor@1.0.0` 是**不同技能**——那个在和平期保持最优套装，这个在战斗中替换耐久崩掉的部件。刻意排最后：断甲是渐进变差，漏图腾或没看见的重生锚是直接死。形状照 `TotemManager`（同一预抢占阶梯），`decide(...)` → `{action:'NONE'|'SWAP_SLOT', slot, reason, preempts:false, swapWindowMs}`，拒绝顺序 `TOTEM_REEQUIP_PREEMPTS → RETREAT_IN_PROGRESS → COMBO_IN_PROGRESS → THROTTLED → NO_SPARE → ABOVE_THRESHOLD`。`preempts` 恒为 false：它永不越过图腾补装，也显式让位撤退。换甲的空档就是全部危险所在，所以 `COMBO_IN_PROGRESS` 这道门是承重的，而识别连招依赖 W3 的 hurt 事件流——**因此它必须排在 W3 之后，不要自己长一个探测器**。阈值用比例加绝对下限双表达，免得低耐久上限的部件被"保护"到不可用。

## 四、明确否决的东西（别做，问了也别做）

- **AstraPlus 的 exploit 类整体**（`Phase`、`Clip`、`Blink`、`XCarry`、`PacketControl`、`ServerLagger`、`PingSpoof`、`MaceSpoof`）：客户端模组栈 + 无许可 + 多数是反作弊绕过/服务端拖慢。既违反 §0.6 的栈约束，也不是"让 bot 变强"，而是"让服务器变坏"。
- **POP嘲讽 / AutoEZ / Spammer 这类自动喊话**：朝真人发自由文本，等于把 AI 输出接到骚扰面上。检测窗口收，喊话不收。
- **任何"反封号已解决"的表述**：抖动、类人化只降低明显破绽。
- **把新窗口信号接进敌我识别**：POP、破盾、i-frame 都只是打法输入。
- **靠版本号推断能力**：capability `unknown` 必须 fail-closed。
- **放宽 `server-profile.ts:72` 的 `purpose: z.literal("isolated-test")` 或 `:92` 的 `auth: z.literal("offline")`**；启动器也不得自动生成 `DASHBOARD_STOP_CONFIRMATION_SHA256`，停机口令必须由人选。

## 五、纪律与验收

- **一个模块一次，每阶段独立提交，每阶段 `pnpm check` 全绿**（`pnpm typecheck && pnpm test && pnpm build`）。
- 新增失败码 → 必须同时补 `failure-classifier` 的分类表条目与恢复阶梯（完备性测试会红）；新增失败类别 → 必须补 `plan-supervisor` 的钩子与映射，否则监督器会静默把动作当成已满足。
- 关键守卫用**反向变异**验证：把守卫换成 `if (false)`，确认指定测试确实红，再还原，并确认 `grep -c "if (false"` 为 0。
- 状态 schema 一律 `.strip()` 不用 `.strict()`：运行时下发**同一份共享 state**，任何技能新增观测字段都会让 strict 的兄弟技能报 `SKILL_STATE_INVALID`（`equipArmorStateSchema` 已立此先例；`movement-goto` 是最后一个改过来的）。
- `apps/bot-runtime` 解析 `@minecraft-studio/skills` 到**构建产物 dist**，改了 skills 源码要先 build，否则它的测试看不到修复（这个坑已经吃过一次，表现为"改完还是 5 个失败"）。
- 汇报用中文，写清：做了什么、跑了哪些命令及**原始退出码与测试数**、遗留边界、当前所处环境段（隔离/私有测试/正式）。
- **时序诚实**：本文件所有毫秒数字都是设计目标。研究期间**没有连接任何 Minecraft 服务器**；本仓库目前只有 `smelt.item` 有真实服务器覆盖（`CHANGELOG.md:306-307` 记录 v0.3.1 的真实 1.21.8 回环验收）。凡未实测的时序，文档里写"未实测"。

---


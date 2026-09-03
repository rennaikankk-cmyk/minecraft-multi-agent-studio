# RAID SYSTEM RESEARCH — 找基地 / 自动掠夺 / 拆家

> 状态：**研究轮草案（2026-09-03）**。零生产改动。本文档暂存于仓库外（并行会话占用工作树），
> 待另一窗口收口后移入 `docs/research/RAID_SYSTEM_RESEARCH.md` 并单独 commit。
> 定位依据：`docs/anarchy-charter.md` §3（`propertyInteraction = unrestricted`、
> `unknownPlayerDisposition = hostile`、`proactiveCombat = true`）、§4（白名单确定性、AI 无权增删）。
> 关联：`docs/research/PVP_SYSTEM_RESEARCH.md`（战术核心/RiskBudget）、
> Base Stewardship 设计（2026-09-03 会话，待入宪 §4 补节）。

---

## 0. 核心设计判断（先说结论）

1. **找基地是长期被动情报积累，不是一次性动作。** 信号采集器（登出点、tab list、聊天、
   实体事件）应该常驻运行、持续记账；"出击"只是从情报池里取一个已成熟的目标。
2. **掠夺与拆除是两个独立决策。** 容器比废墟值钱：默认"只抢不拆"，拆除是独立的高后果闸。
3. **无鞘翅的地面 bot，侦察经济学完全由下界决定。** 主世界径向搜索是 O(r²) 的死路；
   下界 1:8 坐标换算 + 走廊/传送门信号才是可行前沿。鞘翅获取应作为独立 capability gap 立项。
4. **目标池的排除规则硬于入选规则。** 白名单、受托基地（stewardship）、自己的 stash
   绝不进目标池——这是上一层设计（BaseRegistry）的硬接线点，先于任何掠夺逻辑存在。
5. **敌意与掠夺授权分层。** unknown=hostile 已由章程覆盖（对 unknown 目标的掠夺在
   anarchy_first 下合法）；但对**受邀前房主**使用受邀期间获得的情报，必须 operator 显式
   授权（EXPLICIT_UNSORTICTED 同哲学，见 §4 决策闸）。
6. **bot 的"视觉"是 chunk 数据包，不是渲染视线**（结构性优势）。已加载 chunk 的整列
   方块皆可程序化读取：站在下界 roof 能读 y=0..127 全列，**被方块覆盖伪装的传送门/
   容器照样命中**（人类猎手靠视觉会漏）；纯被动读取零反作弊暴露。此原则同时服务于
   侦察（S3-R 扫门）与评估（ASSESS 容器 census 不必进屋）。

---

## 1. 总体架构：RAID 漏斗（八阶段）

```
RECON ──► ASSESS ──► DECIDE ──► INFILTRATE ──► LOOT ──► [DEMOLISH] ──► EXFIL ──► LEDGER
(常驻被动)  (快照评估)  (三级闸)   (潜入+入口)   (容器)    (独立闸)     (撤离暂存)  (记账)
```

- **RECON**：常驻信号采集（见 §2），产出 `RaidTargetCandidate`（坐标+证据链+置信度）。
- **ASSESS**：对候选做一次性快照——价值（容器/实体/设施）、占用（目标玩家在线状态）、
  威胁（陷阱识别）、归属（BaseRegistry 排除检查）。
- **DECIDE**：三级闸（见 §4），含时机选择（目标离线优先）。
- **INFILTRATE**：接近（潜行纪律、距离管理）+ 入口（门/缺口/挖墙点选择）。
- **LOOT**：容器普查→优先级排序→容量管理（见 §5），全程守望。
- **DEMOLISH**：可选、独立闸（见 §6）。
- **EXFIL**：撤离路线 + 满载处理（埋藏 stash 或直接回家）。
- **LEDGER**：raid ledger 记账（目标、收获清单、证据、时间线）——照 ProvenanceStore 模式。

状态机是**可回退**的：任何阶段目标玩家上线 → 强制回退到 EXFIL（或转战斗评估）。

---

## 2. 信号通道清单（找基地的 8 条现实通道）

按"本 bot 当前能力下的可行性"排序。每条标注：机制、依赖、可信度。

### S1 登出点追踪（性价比最高，建议第一个做）
- **机制**：玩家登出时实体消失于其所在位置（`entityGone` 事件）。**同一个 UUID 反复在
  同一小范围登出 = 基地半径**。玩家在自己基地下线是强规律。
- **依赖**：bot-runtime 实体事件流（已有）；磁盘记账（登出点聚类，照 ProvenanceStore 原子写模式）。
- **限制**：只能在 bot 自己的实体跟踪半径内观测（Paper 默认玩家跟踪 **128 格**，见 §9）。
  所以 S1 的覆盖 = bot 常驻活动区 + 出生点/高速公路沿线的登出点。
- **可信度**：高（重复出现≥3 次即成型）。
- **对称威胁**：生态里"登出陷阱"（logout trap）是成熟玩法——**bot 自己的登出点也必须
  纪律化**：永不在固定点/基地内/高速公路边登出（登出点随机化偏移）。

### S2 尾随（跟随离开出生点/高速公路的玩家）
- **机制**：在出生点或下界高速出口蹲守，跟随离开的玩家。玩家最终会回基地。
- **依赖**：距离管理 + 潜行（名牌规则：**潜行时 >5 格外不可见**，不潜行则隔墙可见，见 §9）；
  长距离 pathfinder 跟随（movement.goto 需要跟随模式而非定点模式——新能力）。
- **风险**：被反跟踪发现；跨传送门跟丢（下界↔主世界传送后的关联，见 S3）。
- **可信度**：高但单次成功率中等（玩家可能只是赶路/逛图）。

### S3 下界 roof 扫描 + 传送门关联（侦察主战场；operator 2026-09-03 指定的主通道）
- **首选形态（S3-R，roof 扫描）**：若服务器允许上基岩层顶（pearl-clip 穿基岩天然缺口；
  Paper 插件可封锁 y>127 移动/放置——luv **UNKNOWN 需实测**），roof 是侦察效率之王：
  - **平地基岩 boat（~8 m/s，需实测）**：无地形寻路成本、无跌落风险，长距移动成本趋近直线；
  - **chunk 列数据穿墙扫描（结构性优势）**：站在 roof 可程序化读取整列方块——按
    `nether_portal` 方块 ID 直接命中，**被方块盖住的伪装门也扫得到**（人类猎手靠渲染
    视觉会漏，chunk 数据不会）；纯被动读取零反作弊暴露；
  - 扫描同时记 roof 本身：**roof 基地 / 埋藏 stash / 冰船高速**（roof 是公认安全区，
    上面的资产本身就是高价值目标——找基地和找 stash 一鱼两吃）；
  - **效率账**（假设 view-distance=10，luv 实际值 UNKNOWN）：可读半径 ~160 格，
    boat 走廊扫一趟有效覆盖宽 ~300 格；下界 1 格=主世界 8 格，扫下界 ±2km 走廊
    ≈ 十几趟，等效排查主世界 ±16km 走廊——徒步主世界做同覆盖几何级不可行。
- **标记≠基地（分级启发式，防"出生点垃圾门"淹没）**：离高速/出生点**越远优先级越高**；
  门户周边人造痕迹 census（走廊/火把/铁轨/黑曜石铺装/冰道="dressed portal"高优，裸门
  低优）；主世界 1:8 换算区只给候选不给实锤——**门→基地真实距离分布本身 UNKNOWN**
  （存在反制玩法：故意把门修在离基地很远处再徒步）。
- **排查协议**：对高优标记两条路——①**offset 门**（默认）：在离目标门足够远处自建门
  进主世界（不触发与目标门的 portal 关联），落在同区域但不进他家门房，隐蔽接近
  1:8 候选区做主世界侧验证；②直接进目标门=高风险高情报（直接出现在他家门房，
  可能踩陷阱+立即暴露）。默认 ①，② 需 operator 授权。
- **fallback（S3-C，走廊扫描）**：roof 不可用时退回下界地面——沿高速找隧道痕迹/
  "通道突然终止处"/旷野门（生态标准手法，见 §10 来源）。
- **依赖**：roof 通道（**珍珠经济**：pearl-clip 消耗珍珠→珍珠供给链是前置物流）；
  下界导航（项目目前**零下界能力**：无 portal.travel、无下界寻路 profile——R5 大缺口）；
  chunk 列扫描 API（world.scan 扩展，见 §8）。
- **可信度**：中高（标记→基地需主世界侧验证闭环；dressed portal 启发式提高命中率）。

### S4 地表异常扫描（人造方块信号）
- **机制**：已加载区块内搜"自然界不该在那"的方块：箱子/木桶/潜影箱、信标（光柱夜间
  数百格外可见）、海上木板、火把、铁轨、玻璃、耕地。生态里的 BaseFinder 类工具本质是
  对 chunk 数据包做这个扫描（配合鞘翅高速移动）。
- **依赖**：world.scan 已有（区块内方块 census 能力现成）；**瓶颈是移动速度**——无鞘翅
  徒步的可见区块覆盖率太低，只能作为 S1/S2/S3 途经时的顺带扫描，不能独立成通道。
- **可信度**：极高（扫到就是实锤）。

### S5 聊天/社交信号
- **机制**：聊天里的坐标泄露（稀有）、死亡消息、组队对话；**以及邀请通道**——受邀进基地
  是情报密度最高的方式，但受 stewardship 契约与 operator 授权约束（前房主情报使用=显式闸）。
- **依赖**：聊天已是 UNTRUSTED_EXTERNAL_TEXT 管道；坐标提取用确定性正则（不经模型——
  planner 的坐标纪律沿用）。
- **可信度**：坐标泄露=实锤；其余弱信号只做线索。

### S6 实体/掉落物痕迹
- **机制**：地面散落物（item tracers 思路）、聚集的动物/村民（实体信号——村民群=交易厅/
  刷铁机）、漂浮的被打断的树（有人来过的痕迹）。
- **依赖**：实体事件流已有；villager/animal 聚簇检测（新小能力，纯函数）。
- **可信度**：中（痕迹会过期）。

### S7 交通基础设施
- **机制**：废弃铁路、冰船道、拼花小路——无规则服的"公路系统"通向聚居区。沿铁路走
  是低成本的骨架式探索。
- **可信度**：中（老基础设施多通向废弃基地——废弃基地仍是合法掠夺目标，价值低但零风险）。

### S8 坐标漏洞（coordinate exploit）——**明确排除**
- 生态里存在服务端漏洞型定位（见 2b2t wiki Coordinate exploit 条目）。**不走这条路**：
  依赖服务端特定漏洞 = 不稳定 + 触碰 OperationalSecurity 边界（对服务端的探测/利用）。
  本项目只用"诚实游戏信号"（实体、方块、聊天、移动）。此排除建议写入章程 §2 禁行清单。

### 鞘翅缺口（capability gap，单列）
- 鞘翅 + 烟花把侦察从"徒步 O(r²)"变成"直线 O(r)"，是整个侦察经济学的分水岭。
- 获取路径 = 终局外（end portal → end city → 船）。这是一个独立的大立项（跨维度、
  战斗、终点资源），建议单独立项评估，不阻塞 R1-R4。

---

## 3. ASSESS：评估快照

对每个成熟候选做四维评估（全部确定性规则，不经模型判断——沿用 AGENTS.md §0.1 纪律）：

| 维度 | 判定内容 | 数据源 |
|---|---|---|
| **价值** | 容器数量/类型、村民数、动物种畜、设施种类、信标 | world.scan census + 实体流 |
| **占用** | 目标玩家在/离线（tab list 真值）、最近活动痕迹（作物成熟度、熔炉有无烧完物、床） | tab list + scan |
| **威胁** | 陷阱识别：压力板/绊线/单入口密闭房/岩浆/TNT 陷阱箱/诱饵箱 | scan + 谨慎探查 |
| **归属** | **BaseRegistry 排除**：own / stewarded（受邀）/ ally → 永不出现在目标池 | BaseRegistry |

- **威胁评估直接复用 stewardship 设计里的 base-assessment 危险扫描**（同一个技能双向用：
  受邀进玩家基地前查 kill box，掠夺陌生基地前查陷阱——同一套方块/结构信号）。
- 归属检查是**前置依赖**：BaseRegistry 不存在之前，掠夺决策层不能上线（否则第一单就
  可能误抢盟友）。这是排期上的硬顺序。

---

## 4. DECIDE：三级决策闸

| 层级 | 内容 | 闸门 |
|---|---|---|
| **L0 侦察/评估** | 常驻信号采集、快照评估 | **自动**（无世界副作用，纯观察） |
| **L1 掠夺** | 潜入+开箱+撤离 | **政策闸**：目标必须白名单外（unknown=hostile 由 anarchy_first 覆盖）；受邀前房主需 operator 显式授权；目标玩家**离线**为默认前置 |
| **L2 拆除** | 结构性破坏 | **operator 显式确认**（不可逆高后果；对齐 EXPLICIT_UNRESTRICTED 哲学；可在 custom profile 下放开但默认闸） |

- **时机**：tab list 驱动。目标玩家在线 → 只做 L0；离线 → L1 可开。raid 全程守望，
  目标上线 → 立即中止转 EXFIL（或战术核心 RiskBudget 评估接战）。
- **"先抢后用"**：charter §3 原文场景（"先掠夺后使用他人熔炉"）意味着掠夺后的敌方设施
  可以留下自用而非拆除——这是 LOOT 与 DEMOLISH 分离的章程依据。

### 4.5 触发模型（采集常驻、行动稀疏）

侦察"什么时候去扫"分三层，采集与行动严格分离：

| 层 | 内容 | 性质 |
|---|---|---|
| **L-手动** | operator 经 dashboard/API 提交确定性走廊 goal（现有 goal 通道） | 验收期唯一档 |
| **L-巡逻** | autonomy supervisor 新增 `RECON_PATROL` need：bot 空闲（无 manual goal、无更高优先级 need、食物/装备/安全达标）时从走廊队列取 goal 派发 | 自动档 |
| **L-事件** | 登出点/tab list/chunk 命中**只入账不触发任何行动**；出击永远由 operator（或 L1 政策闸）从情报池挑目标 | 喂情报池 |

- **走廊队列 = 网格分配器**（纯函数可测）：roof 坐标网格化，ledger 记每格最近扫描时间戳；
  未扫格子优先、超 staleness 窗口（如 7 天）重扫、从高速走廊两侧向外扩——"扫哪里"是
  账本驱动的覆盖问题，不拍脑袋。
- **优先级仲裁**：survival need > manual goal > patrol；夜间/饥饿/低装备不出门
  （BotSurvivalSafety 精神延伸）；被打断的走廊记进度，恢复后续扫不重扫。
- 实现增量小：确定性 goal 模板 / survival-needs 框架 / ledger 均已有，新增仅
  `RECON_PATROL` need + 网格分配器。

---

## 5. LOOT：掠夺执行

### 容器优先级（确定性排序，复用 death-recovery 价值表）
1. 潜影箱（价值密度最高，整箱带走）
2. 附魔装备/钻石/下界合金/图腾/珍珠
3. 信标/贵重方块（金块/绿宝石块）
4. 高级材料（黑曜石备用、TNT、烟花）
5. 食物/基础物资（占位才拿）

`assessDropRecovery` 已有物品价值模型——**同一张表复用**，不要做第二套。

### 容量管理
- 背包 36 格是硬约束。策略阶梯：带空潜影箱出门（抢到满箱直接打包）→ 丢弃低价值
  （discard 契约，明确丢什么不丢什么）→ 埋藏 stash（坐标记入 ledger，回程再取）。
- **stash 物流是缺口**：stash→家的运输没有通道（无鞘翅无冰船）。短期只能"就近埋+回程取"。

### 节奏与守望
- 开箱/取物走 compat action policy 的 container 家族 pacing（已有机制，STRICT 基线下
  会自动收紧——不用新写）。
- 守望：loot 期间订阅实体事件，owner UUID 出现在跟踪半径 → 中止协议。
- 终止条件（任一）：背包满 / 容器清空 / 威胁出现 / 单位时间价值低于阈值。

---

## 6. DEMOLISH：拆除（独立闸，默认 operator 确认）

目标排序按**重建成本 × 不可再生性**（降序）——Facility Platform 的 11 种
AutomatedFacilityKind + base-master-plan 的依赖图**直接反向用作拆解顺序表**：

| 优先级 | 目标 | 为什么 |
|---|---|---|
| 1 | 村民交易厅（杀村民） | **不可再生**（无重生），重建成本=重新抓/繁殖/交易，最高伤害 |
| 2 | 刷铁机胞元（床+村民破坏） | 同上依赖村民；设施平台 taxonomy 直接给拆解点 |
| 3 | 动物种畜（杀 breeding stock） | 不可再生（自然刷新极慢） |
| 4 | 红石/分类器（敲观察者/活塞关键节点） | 精准打击，少量方块瘫痪整体 |
| 5 | 作物田（收割不补种） | 可再生但耗时 |
| 6 | 传送门框（拆黑曜石） | 每门 10 黑曜石，交通瘫痪 |
| 7 | 铁路/冰道 | 长但成本低，最后 |

**不该拆的**：箱子（先抢后拆是浪费——抢完空箱可拆可不拆）；**自己后续要用的设施**
（熔炉/刷铁机可留作前哨——"先掠夺后使用"的完全体是就地建立前哨站）。

**手段与边界**：
- TNT/水晶爆破：走 EXPLICIT gate + 爆炸家族 pacing（compat 层已有 STRICT 基线
  fail-closed 的先例）；注意 BotSurvivalSafety 的自伤保护常开。
- 火：木结构有效，但蔓延不可控——**默认不用火**（无法 bounded，违反失控纪律）。
- 逐块挖：慢但无任何 gate 门槛，是 STRICT 兼容模式下的兜底手段。
- **OperationalSecurity 红线**：大体积方块更新必须 bounded（action policy 已有机制），
  任何拆除手段不得以"压垮服务器"为目的——charter §2"不故意崩服"在拆除场景的字面适用。

**战略参数**（不是技术问题，是运营选择）：无痕掠夺（最小痕迹）vs 威慑性拆家（留信号）。
做成 profile 参数，默认前者。

---

## 7. 反侦察与暴露管理

已核实事实（§9 带源）：
- Paper 默认玩家实体跟踪 **128 格**——bot 出现在任何玩家 128 格内就可能被"看见"
  （实体渲染 + 不潜行时名牌隔墙可见）。
- **潜行时名牌只对 ~5 格内可见**——潜行接近 + >5 格距离管理是潜入纪律的基础。
- 箱子开启在 vanilla/Paper **对 owner 无任何通知**（无广播机制）——掠夺的天然优势。
  （**luv 是否装了容器告警插件 = UNKNOWN，需实测**。）

纪律清单：
1. 接近目标全程潜行 + 距离 >5 格直到脱离视线可能。
2. 错峰：目标离线窗口行动（tab list 真值驱动）。
3. bot 登出点随机化（反 logout trap，见 S1 对称威胁）。
4. 基地坐标是最高敏感级资产：raid ledger 与 stash 坐标的日志/导出脱敏纪律
   不低于 secrets（现有 redaction 管道复用）。

---

## 8. 与现有架构映射

| 新能力 | 复用/依赖的现有件 | 状态 |
|---|---|---|
| 登出点记录器（S1） | bot-runtime 实体事件流 + ProvenanceStore 原子写模式 | 新写，小 |
| tab list 占用监控 | mineflayer players 事件 | 新写，小 |
| 容器普查 | world.scan（census 扩展） | 扩展 |
| **chunk census 通用原语** | world.scan 扩展：区域/列级方块 census 引擎（方块 ID predicate；列扫/区域扫/chunk 加载增量三模式；分帧防冻结）。skill 壳薄、能力下沉 package（SDK 删除轮原则） | 扩展（raid 是第一个消费者） |
| └ roof 传送门扫描（S3-R） | 上述原语，predicate=nether_portal/obsidian 簇/容器/人造方块集 | 消费者 |
| └ 资源勘探 | 上述原语，predicate=ore/结构（村庄/要塞/堡垒遗迹）——喂 mine-planner 与设施选址 | 消费者（后续） |
| └ 自家基地暴露自检 | 上述原语，猎手视角人造度信号（**"能扫别人=能扫自己"对称性**，反向隐蔽自检） | 消费者（后续） |
| └ 周边入侵监控 | 上述原语，自家基地周边新门/obsidian/TNT 的方块 diff=被偷家前置预警 | 消费者（后续） |
| └ Provenance 资产对账 | 上述原语，own_placed 记录 vs 实际方块状态 diff（被破坏/被偷检测） | 消费者（后续） |
| 目标分类学 | FacilityKind 11 种 + base-master-plan 依赖图（反向） | **直接复用** |
| 物品价值表 | death-recovery assessDropRecovery | **直接复用** |
| 归属排除 | BaseRegistry（stewardship 轮产出） | **前置依赖，未建** |
| 掠夺执行 | container.write + compat action policy pacing | 已有 |
| 守望/接战 | 战术核心（tactics/）+ RiskBudget 四档 | 已有（影子模式） |
| 拆除执行 | build 反向（demolish 蓝图）+ 爆炸 gate | 新写 |
| 记账 | ProvenanceStore 模式（raid ledger） | 新写，小 |
| operator 闸 | manager API + dashboard（canary/EXPLICIT 同模式） | 已有模式 |
| 新技能注册 | Skill Gap Pipeline（skill-gap.ts Resolver 链） | 已有 |

候选新技能（走 Skill Gap Pipeline 正规流程）：`raid.recon-scan`（人造痕迹识别）、
`raid.follow`（尾随模式）、`raid.loot`（容器清点+优先级打包）、`raid.demolish`（gated）、
`nether.portal-travel`（R5 前置，跨维度大能力）。

---

## 9. 技术事实与 UNKNOWN 清单

**已核实（带外部来源）：**
- 潜行时名牌对 >5 格外不可见；5 格内仍隔墙可见；隐身药水完全隐藏。
  （Minecraft Forum / Mojira MC-162693，见 §10）
- Paper `spigot.yml` `entity-tracking-range.players` 默认 **128 格**（Spigot 默认 48）。
  luv = Paper 26.1.2，**但服主可能改过配置——以实测为准**。
- 生态找基地手法：下界高速外扩找隧道痕迹、痕迹终止处跳门回主世界、旷野门=候选、
  item tracer 顺带、登出点蹲守。（2b2t 社区来源，见 §10）

**UNKNOWN（需 luv 实测定案，禁止想当然）：**
1. luv 实际玩家跟踪距离（128 是 Paper 默认，非保证）。
2. luv 是否有容器开启告警/回滚插件（CoreProtect 类）——决定掠夺的"被追踪风险"。
3. luv 是否有 combat tag / combat log 惩罚插件——决定"打不过就下线"逃生的有效性。
4. 26.x（年份制版本）相对 1.21.x 的爆炸/火/方块机制差异（PVP 研究已标 26.x 战斗差异 UNKNOWN，同源问题）。
5. **luv 下界 roof 可达性**（S3-R 前提）：pearl-clip 穿基岩是否可行；是否装了封锁
   y>127 移动/放置的插件；26.x 下界高度与基岩层天然缺口分布（1.16+ 下界高度 256、
   bedrock 顶 ~127，缺口生成规律按版本有差异）。
6. luv 的 view-distance 实际值（决定 roof 扫描的可读半径与走廊间距）。

---

## 10. 分阶段路线图（每阶段真值验收标准）

| 阶段 | 内容 | 验收真值 |
|---|---|---|
| **R1** | 登出点记录器 + tab list 监控 + 聊天坐标提取（纯记录零行动） | fixture 里第二个账号定点登出 3 次 → 记录器聚类出候选坐标=rcon 真值比对 |
| **R2** | world.scan 容器 census + 价值评估 + BaseRegistry 排除检查 | 假基地（已知容器清单）→ census 清单一致；盟友基地被排除 |
| **R3** | 掠夺闭环（L1 政策闸 + 容器优先级 + 容量管理 + 守望中止） | fixture 假基地：抢前/抢后容器快照 diff = bot 背包增量（服务器真值）；守望：目标上线→中止 |
| **R4** | 拆除（L2 operator 闸 + FacilityKind 反向拆解顺序 + bounded 手段） | fixture 村民厅：拆前/拆后村民数 rcon 真值；operator 未确认→拒绝路径 |
| **R5a** | roof 可达性实测（pearl-clip / 插件封锁探测）+ 上房 + boat 移动 | bot 出现在 y>127 且可移动/可 boat（坐标真值） |
| **R5b** | roof 网格扫描 + 传送门/痕迹标记账本（chunk 列扫描，含伪装覆盖门） | fixture 下界埋已知门（含覆盖伪装门）→ 扫描命中坐标一致 |
| **R5c** | 排查协议：offset 门进主世界侧 + 1:8 关联验证 | 下界放已知门 → offset 门落地主世界正确区域 |
| **R5d** | 下界地面寻路/走廊扫描（roof 不可用的 fallback） | 同 R5b 在 y<127 地面路径 |
| **R6** | luv 实战灰度（R1-R3 先行，R4 默认锁闸） | 在场真值 + ledger 完整 + 零 crash delta |

排期硬顺序：**BaseRegistry（stewardship）先于 R2**（归属排除是目标池的地基）。

---

## 11. 开放问题（决策点，留给 operator）

1. **拆除默认闸**：默认 operator 确认（本研究的建议）还是 anarchy_first 下自动？
2. **战略偏好**：无痕掠夺 vs 威慑性拆家——影响 DEMOLISH 的默认参数与"留不留信号"。
3. **鞘翅立项**：要不要开独立轮评估（终局外获取链路长，但改变整个侦察经济学）。
4. **stash 物流**：就近埋藏够不够用，还是需要"运输 bot"协作（multi-bot 显式协作的
   第一个真实场景？——比战斗协作简单，适合当协作机制的试点）。

---

## 附：外部来源

- 名牌/潜行可见性：[Minecraft Forum 讨论](https://www.minecraftforum.net/forums/minecraft-java-edition/survival-mode/212991-why-can-you-see-names-over-the-heads-through-walls)、[Mojira MC-162693](https://bugs.mojang.com/browse/MC-162693)
- 实体跟踪距离：[PaperMC spigot.yml 参考文档](https://docs.papermc.io/paper/reference/spigot-configuration/)（`entity-tracking-range.players` 默认 128）、[SpigotMC Wiki](https://www.spigotmc.org/wiki/spigot-configuration/)
- 无规则服找基地生态：[Anarchy Server Base Hunting wiki](https://4thdimensiontraveler.fandom.com/wiki/Anarchy_Server_Base_Hunting)、[2b2t base hunting 建议（Reddit）](https://www.reddit.com/r/2b2t/comments/15h6wyi/advice_about_base_hunting/)、[2b2t Coordinate exploit 条目（排除项）](https://2b2t.miraheze.org/wiki/Coordinate_exploit)、[如何藏基地（反向参考）](https://www.reddit.com/r/2b2t/comments/1i5wkh7/how_to_hide_your_base/)

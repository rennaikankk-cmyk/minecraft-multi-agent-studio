# Baritone 能力研究与架构决策

日期：2026-09-05。状态：采纳路线 A 作为后续开发方向；路线 B 仅供审查；本轮没有引入 Baritone 依赖、运行 Java 客户端或迁移 Runtime。

## 研究身份与版本

官方仓库为 [cabaletta/baritone](https://github.com/cabaletta/baritone)。锁定 [v1.17.0](https://github.com/cabaletta/baritone/releases/tag/v1.17.0)，GitHub tags API 核验直接指向 `23723891da460ef15797b02fe5b385b0c5b163cc`，发布时间 `2026-08-31T22:08:01Z`。本轮读取该提交的源码归档，没有执行归档中的代码。

[gradle.properties](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/gradle.properties) 明确为 Minecraft `1.21.11`、Java `21`、mod `1.17.0`，支持 fabric/forge/neoforge/tweaker 构建。release 的 `target_commitish` 返回 `1.19.4`，不能据此判断支持版本；README/SETUP 的版本表也落后于本次发布。release 正文明确对应 1.21.11。

| 发布资产 | GitHub API 报告的字节数 | API 报告的 SHA-256 |
|---|---:|---|
| baritone-api-1.17.0.jar | 603140 | `8bf1ba3e1011ed7bd4511be5213359c9fcd5c7d5a2f8b8795106c65ac5be6c39` |
| baritone-api-fabric-1.17.0.jar | 4813299 | `a1646893c2a6338ea6bf1a3bdecf2cd743ede61e31a4324bd79a82f3d03360f9` |
| baritone-api-forge-1.17.0.jar | 4827953 | `3b57b74eddeda5fc3b59627aa053fb380ae2bd7fa1e092884dbd9d6036a2c496` |
| baritone-api-neoforge-1.17.0.jar | 4828038 | `fd1ccdeaf1ffd70aaa4ba1f4f17212be1c83e4f9f18915fff4d22a5b3d4040c4` |

另有 standalone、unoptimized 的对应资产和 `checksums.txt`。上述是发布元数据核验，未下载/运行 JAR，未核验发布签名。SETUP 建议验证 GPG，但本次资产列表中未出现 `checksums_signed.asc`，不能声称已验证签名。API 资产保留公开 API；standalone 是模组分发类型，不表示一个无需 Minecraft 客户端的独立 JVM 服务。

项目的 ServerProfile 不是单版本：多个配置使用 `auto`；某个现有 Profile 配置 Minecraft `1.21.11`，其已保存的 compatibility 元数据却为 `26.1.2 / protocol 775`。这里仅核对本地配置，没有连接服务器确认当前协商结果。Runtime 应以 `MineflayerBotClient.versionCompatibility()` 和 `skillCompatibilityEnvironment()` 产生的实际版本/协议为准。1.21.11 的 API 不能自动视为兼容 26.1.2；拟接入后端必须逐 Profile、协商版本和 loader revision 绑定支持矩阵，未知版本返回不可用。

## 官方机制与边界

### 导航、成本和缓存

`AStarPathFinder.calculate0()` 在节点、时间、未知区块边缘约束下搜索；未到终点时用多组启发式/成本系数选择有实际推进的部分路径。`PathingBehavior` 保存 current/next/inProgress，在当前段剩余估计 tick 小于 `planningTickLookahead` 时后台预计算下一段，在安全移动边界提前接入或通过 `PathExecutor.trySplice()` 拼接。下一段不包含当前位置时会丢弃。部分路径返回、预计算、拼接是不同机制，不能因项目已有 best-effort 路径就声称全部已有。

`PathExecutor.onTick()` 重算当前移动及有限前瞻移动的可行性/成本，处理缓存成本上涨、偏航、移动超时和失败，并只在 `safeToCancel()` 允许时做相应切换。`MovementHelper.getMiningDurationTicks()` 将工具速度、方块硬度、上方下落方块等计入成本；`CalculationContext` 包含 allowBreak、可丢弃放置材料、水/流体限制；`ToolSet.getBestSlot()` 考虑实际工具、附魔、低耐久保护及材料偏好。它们使用 Minecraft 类型和玩家状态，不是现成的纯数值库。

`ChunkPacker` 将导航类别压成 AIR/WATER/AVOID/SOLID，`CachedChunk` 同时保存部分特殊方块位置和概览；不是完整 BlockState 数据库。`BlockStateInterface` 优先读取加载区块，再读取缓存，部分缺失分支返回 AIR。这种导航近似不能进入 Studio 的 UNKNOWN、建筑属性验证或归属判定。`WorldProvider` 按世界/服务器目录与维度路径选择缓存，`CachedRegion` 有格式 magic、维度高度及时间戳；它们不是 Studio 的 ServerProfile/运行 epoch/业务 revision 协议，也没有永久事实新鲜度保证。

### 挖矿与采集

`MineProcess` 管理 knownOreLocations、blacklist、anticipatedDrops，定期后台重扫，合并已知位置与掉落实体，用 GoalComposite/相邻目标求路。不可达目标可进入黑名单；无已知目标时可按配置探索；目标消失后重新筛选。数量停止条件检查匹配物品在现有库存中的总数，不是自动扣除调用前库存的净增量。成功、找不到目标和失败均可能经 cancel/onLostControl 令 Process 不活跃。

因此它确实覆盖“找资源、接近、挖掘、等待拾取”的大部分执行逻辑；Skill 仍需固定目标掉落物/采集授权、记录库存基线、处理外来补给与消费并验证净取得量。满包、工具不足、死亡和 L0 抢占需要 Studio 的有界恢复与任务终态，不能把 `isActive=false` 翻译为完成。

### 建造与清场

`BuilderProcess.build(name, schematic, origin)` 绑定固定原点，支持 schematic 格式加载、旋转/镜像/替代与可选层序。`recalcNearby()` 更新 incorrectPositions 和 observedCompleted；工作集清空时 `fullRecalc()` 再核对。已加载块按当前/期望 BlockState 比较；曾确认但已离开视距的位置仍可留在 observedCompleted。这有助连续施工，但不能替代 Studio 重启后的世界核对。

`assemble()` 区分可放置、可拆除、源液体、流动液体和缺料；`searchForPlacables()` 根据可触达面、朝向及物品状态选择动作。不能构造下一目标时会打印缺料并暂停，某些配置允许跳过失败层。适配器必须禁止把跳层和忽略属性的宽松配置用作验收成功。`pause/resume` 保存当前内存施工状态，`onLostControl()` 清理 schematic/incorrectPositions 等字段，不提供 Studio 需要的跨进程 durable journal。

`clearArea()` 使用选择区域的清空 schematic，能复用 Builder 的破坏/寻路逻辑。它不负责 Studio 的授权区域、材料回收验收、跨 Bot 互斥、永久检查点和危险液体处置策略。

### 农田、探索与跟随

FarmProcess 的 Harvest 枚举实际覆盖小麦、胡萝卜、马铃薯、甜菜根、南瓜、西瓜、下界疣、可可、甘蔗、竹子、仙人掌。成熟年龄判定用于常见作物/可可/疣；启用 replantCrops 时，甘蔗/竹子/仙人掌保留基部。可在空耕地补种、空灵魂沙种疣、丛林原木侧面种可可，并按 BonemealableBlock 与现有骨粉执行施肥。它不负责开垦、供水、照明、农场结构建设或长期补给经济。

范围参数按中心距离过滤作物位置，另可应用 selection；后面的掉落实体拾取循环没有重复应用同一 range/selection 过滤。Studio 若要求严格作业边界，必须在动作适配层再次检查。没有目标或路径失败时 FarmProcess 也会退出，不能等同“农场净产出已达标”。

ExploreProcess 寻找未缓存区块集合，等待磁盘区域加载时请求暂停，可使用 JSON filter；“已探索”是缓存覆盖语义，不是设施调查完成。GetToBlockProcess 定期重扫指定方块，处理不可达黑名单，并可在到达后右键目标。FollowProcess 每 tick 更新实体目标，可选半径/偏移，也提供 pickup；目标暂时不可见会影响活跃态，需由 Studio 判断完成、等待还是失败。

### 控制权和取消

`IBaritoneProcess` 的优先级、temporary 与 onLostControl 由同一个 `PathingControlManager` 仲裁。高优先级临时进程可暂停普通进程，非临时接管可取消其他进程。这只覆盖一个 Baritone 实例内的路径控制。

`IPathingBehavior.cancelEverything()` 保证取消 Process，但返回值区分当前路径行为是否能立刻取消，例如正在进行的跳跃可能不能停。`forceCancel()` 的文档明确不建议调用。Studio 的取消命令接受、禁止新副作用、执行器停稳、服务端最后一个动作结果和终态必须分别记录；不得用 cancel 返回或 isActive=false 代替全部确认。

## 能力映射

以下“已有”来自当前仓库实现与测试，不表示已完成真实联机验收。

| 能力 | Baritone 官方实现/证据 | 当前项目已有实现 | 可复用的机制 | 本项目仍需负责的契约 | 接入成本与风险 | 推荐阶段 |
|---|---|---|---|---|---|---|
| 长距离导航 | AStarPathFinder、PathingBehavior、PathExecutor | rust-pathfinder.ts、pathfinder-rs/astar.rs：有界体素、worker、部分路径、执行时检查 | 下一段预计算、拼接、前瞻成本重核 | MovementController/L0、版本身份、路径依赖及真实到达 | Rust 当前 DIG_COST 固定，部分路径不等于完整拼接；不能再建世界镜像 | 原 P5-E 及之后，依原门禁 |
| 挖矿 | IMineProcess/MineProcess | mine.branch、mine.vein、mine-planner.ts、Mineflayer 原语 | 资源目标集重扫、黑名单、相邻目标归约 | HarvestAuthorization、目标掉落净增量、工具/危险预算、取消 | 原版依赖客户端；工具成本模型迁移需测量 | 后续采集切片，非本轮完整接入 |
| 采集/掉落拾取 | MineProcess anticipatedDrops、FollowProcess.pickup | collect.block、collectReachableTargets、拾取等待与库存读回 | 有界等待掉落、目标消失重筛、拾取目标 | 净产出、满包/缺工具/死亡/抢占的有界恢复 | 不能按“路径到达/挖出方块”成功；现有拾取逻辑先复用 | 保留现链，随后单项比较 |
| 蓝图建造 | IBuilderProcess、BuilderProcess.recalc/assemble | blueprint-planner.ts、BlueprintReconciler、MaterialResolver、施工 journal | 差异工作集、可放置面选择、缺料暂停、局部重核 | 摘要/锚点/buildId、属性验收、批次与设施可用性、持久恢复 | 原版容忍未加载历史完成；Studio 必须保守；复杂属性放置仍有缺口 | 下一优先切片 |
| 清场 | IBuilderProcess.clearArea、SelectionSchematic | block.place-safe 可清理目标格；没有等价完整区域清场生命周期 | 将目标区域转为期望空状态并调度破坏 | 区域授权、液体/掉落、工具与进度、未知结果 | 新增公共 Skill 前需完整验收，不用命令存在推定闭环 | 建造差异切片后 |
| 农田 | IFarmProcess、FarmProcess Harvest/replant/bonemeal | 农田蓝图、材料/库存与通用方块能力；没有同等农田维护闭环 | 成熟判定、基部保留、补种/施肥与拾取队列 | 作业边界、种子/骨粉预算、长期净产出、水/光/耕地验证 | 范围不能直接视作所有副作用边界；领域验证器未接通 | 后续独立农业阶段 |
| 探索 | ExploreProcess、区块 filter | world.scan、自治探索、WorldMirror 同步基础 | 未知区域候选集、已覆盖去重 | ServerProfile 隔离、覆盖证据、危险与角色分工 | 缓存覆盖不是目标设施发现；不修改 D2 同步层 | SpatialIndex 就绪后 |
| 指定方块接近/跟随 | GetToBlockProcess、FollowProcess | movement.goto、world.scan、现有路径/实体观测 | 重扫、目标有效性、GoalNear/GoalComposite | 白名单与目标授权、失联/消失、动作所有权 | 原版内部右键需纳入租约/副作用检查 | 后续可选适配 |
| 暂停与取消 | IBaritoneProcess、IPathingBehavior | SkillExecutor AbortSignal、ActionLock、MovementController、Runtime 取消协议 | 安全停点、temporary 仲裁 | 请求与停稳区别、最后副作用、跨进程 epoch/lease | 两套定时器同时控制动作会争抢；inactive 不等于成功 | 所有后续切片的契约门 |
| 世界缓存 | ChunkPacker/CachedChunk/WorldProvider | P5-D2 WorldSyncAdapter、Rust WorldMirror 协议/ACK/背压 | 有界查询、局部数据/分类思路 | UNKNOWN、revision、新鲜度、属性与永久业务事实 | 紧凑分类不够验收；不替换 D2 已完成同步协议 | 后续 P5 原任务 |

## 架构决策

Skill 保留为 Studio 对外的版本化任务与可靠性契约：参数、兼容性、权限、资源预算、超时、进度、取消、结果证据和恢复。具体 mine/build/farm 执行逻辑可以委托给合适后端的 Process，Skill 不必重复实现全部动作算法。

| 路线 | 收益 | 实际新增工作 | 成本与限制 | 决策 |
|---|---|---|---|---|
| A：Mineflayer + 现有 Rust，吸收机制 | 复用既有客户端、L0/PvP、worker、协议；逐项补差异工作集与可执行目标选择 | 有界差异更新、工作面选择、明确取消停稳及验收指标；必要计算再下沉 Rust | 需要独立实现与测试；不能直接获得原版全部 Process 成熟度 | 当前优先，下一切片限定蓝图续建 |
| B：原版 Baritone 可选 Java Runtime | 在真实 Java 客户端上直接调用 mine/build/farm 等，减少重复执行代码 | 新 Runtime 适配、认证/启动/快照/任务结果/epoch/租约/L0；版本化 loader 维护；单实体动作权威 | 1/5/10 客户端 CPU、RSS/堆、冷启动、图形/虚拟显示/无渲染条件全未测；不能引用 Gradle -Xmx4G 当运行占用 | 仅设计，不改变仓库无头 Mineflayer 约束 |
| C：抽取算法或第三方同名库 | 特定纯算法可能可重用；第三方 JS 已有 Mineflayer API | 先界定依赖图、输入数据契约、许可证及替代执行器；仍需所有 Studio 验收 | CalculationContext/ToolSet/BlockStateInterface 连到 MC 对象；搬进 JVM 服务不会去除依赖；第三方不是原版 | 暂不选，不能用“翻译源码”冒充独立实现 |

B 路线的一 Bot 一权威必须由 Supervisor 选择 Runtime 类型；同一个受控游戏实体不能同时由 Mineflayer 与 Java 客户端执行同一任务。L0 与既有 PvP 必须保有确定性职责，不能假设 Baritone 自动代替它们。跨 Bot 分工、租约、基地阶段、补给、长期 journal、Incident 和灰度仍由 Studio 控制面负责。Spark 只给慢速目标/策略建议。

第三方独立抽查：[miner-org/mineflayer-baritone](https://github.com/miner-org/mineflayer-baritone/tree/5bbb91eeb2ace18b4c83a56d00fcd494f0f976f2)，锁定 `5bbb91eeb2ace18b4c83a56d00fcd494f0f976f2`。最近提交 `2026-08-29T08:27:29Z`，未 archived；package 版本 `4.6.2`、声明 ISC，GitHub license 检测为 null，根目录没有 LICENSE 文件。已读 README/package.json/index.js/src/loader.js：导出 loader 与 Goal，挂载 AshFinderPlugin，loader 调用 ashDig 替换挖掘实现，并可装自定义物理。README 声明跑酷/出水/长距离限制，测试脚本连接 localhost，并非官方 Baritone Process API。近期更新不证明维护质量和完整 mine/build/farm 能力；未安装、未执行、未选作依赖，许可材料不足需后续单独审查。另一 antisynth 同名仓库未作源码验收，不赋予原版能力结论。

官方 [LICENSE](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/LICENSE) 是 LGPL v3；源码头标注 v3 or later。README 的徽章措辞不替代许可证正文。调用未改动依赖、改编源代码和独立实现须分别记录来源与分发义务；改编/逐行翻译不能称 clean-room。本轮只根据机制撰写设计及本项目独立修复，没有复制、翻译或链接官方源码。

## 复用现有调用边界

实际链路：`SkillDefinition.execute` -> `SkillExecutionContext.callCapability` -> `SkillExecutor` 的 capabilityAdapter -> `BotRuntime.invokeSkillCapability` -> `BotClient.invokeSkillCapability` -> `MineflayerBotClient` -> 现有 Mineflayer 原语或 rust-pathfinder/worker。Executor 已校验声明能力、授权、输入与取消；Runtime 复核连接/L0，Mineflayer 层有 ActionLock/MovementController。后续应扩展这条链的能力描述和结果证据，不新建平行控制协议。

| 契约 | 已有接点 | 后续最窄补齐 |
|---|---|---|
| 支持性/版本 | Skill catalog、compat variants、实际 MC/protocol facts | 为可选后端明确版本/loader/revision；unknown 不降级成功 |
| 启动参数与预算 | skill inputSchema、blueprint anchor/cells、采矿参数、权限 | 固定 blueprint digest、材料/工具预算与约束，原版设置由结构化适配映射 |
| 操作身份 | taskId/invocationId/traceId、Runtime instance/epoch、执行 claim | invocationId 关联实际 attempt，leaseId/generation/owner 随资源操作传递 |
| 进度与部分完成 | progressContract、产出计数、journal step | 给 snapshot generation/revision、实际完成单元、remaining/unknown；不将 Process displayName 当进度 |
| 暂停/取消 | AbortSignal、Runtime cancel、MovementController | 区分 REQUESTED/QUIESCENT/TERMINAL；超时后的 adapter 可能仍待完成，先禁止新副作用再确认停稳 |
| 恢复 | 本轮 build journal、BaseRegistry、DurableStateStore | 保存可移植检查点，恢复前核对固定区域；未确认旧执行停稳时等待或替换 Runtime epoch |
| 完成证据 | inventory readback、placement receipt、blueprint inspect | 采矿/采集净目标物品、蓝图必要属性、农业补种率与长期净产出分别验收；未知单独出口 |

本轮只实现恢复与资源身份需要的窄接口：blueprint inspect/reconcile/inspectOnly、施工执行身份、基地事实、租约 proof 和现有 shared-state RPC 的版本/幂等身份。没有改造全部 Skill 生命周期。

## 后续唯一优先切片：蓝图差异工作集与可执行工作面

失败证据：修复前日志 ESM 加载失败、随机目录使恢复丢失；本轮已修复这些正确性问题。仍存在的算法缺口在 `blueprint-planner.ts`：线性批次按 startIndex 选择，默认依附下方方块，依赖不足或不可达单元会阻断后续工作；当前逐次核对最多 512 格，而材料预采集仍主要由 nextIndex 批次估算。稀疏损坏、只缺少局部材料时会产生不必要等待或补料。本轮未对这些缺口声称真实成功率/性能数据。

借鉴 `BuilderProcess.recalcNearby/fullRecalc/assemble/searchForPlacables`，复用项目既有 `reconcileBlueprint`、`resolveMaterials`、`orderBlueprintCells` 和固定 buildId：建立有界 missing/wrong/unknown/verified 工作集，根据可触达依附面、材料和结构层选择下一组单元；修复后局部重核，工程完成前完整重核。不要照搬 observedCompleted 对卸载区块的宽松完成判据。

| 实施步 | 责任与文件 | 验收 |
|---|---|---|
| 1. 固定工作集身份与基线 | Coordinator build-journal/local-planner；skills base-registry/blueprint-planner | 两 Bot 引用同 buildId/digest/anchor；一个执行者或明确单元预约；未知保留 |
| 2. 选择可执行单元 | Skill 保留结构顺序、材料预算、结果验证；小规模工作集先 TS，测量需要时才移入既有 Rust/worker | 不跨未满足依赖；不重复放已确认块；无可执行项时结构化 WAITING_MATERIAL/WAITING_OBSERVATION |
| 3. 单一动作执行 | Mineflayer 的既有 block.place-safe、MovementController/ActionLock/L0 | 正确方块及属性读回；取消后的新副作用为零；确认实际停稳，迟到结果不污染新 attempt |
| 4. 对照实验 | 现有显式 LOCAL_TEST/E2E 入口，记录每次世界复位、版本、资源、位置、种子/区域、输入摘要 | 所有指标同时记录，不用少观测换性能；失败也计入分母 |

先用同版本离线测试服固定 5 类场景，每组基线/候选各至少 20 次：完整新建、稀疏缺损、缺一种材料、结果丢失后重启、区块卸载/抢占。AB 使用同一世界备份、相同锚点与初始库存/工具，不跨版本混算。再按原阶段做 1/5/10 Bot，Java 后端比较另行计划。

| 指标 | 定义与拟定通过条件；均未实测 |
|---|---|
| 成功率 | 达到全部验收的运行数/总运行数，失败/超时留在分母；完整与可修复场景 >=95%，且不低于基线 |
| 净产出 | 本切片为“新增或修复后验证合格单元/实际消耗材料”，记录误放和清除数量；不把请求次数计产出；后续采矿按目标物品净增量 |
| 完成时间 | 同类场景 p50/p95；稀疏缺损候选 p95 至少改善 20%，完整施工 p95 不回退超过 5% |
| 重试与重复副作用 | 按 task/attempt/cell 统计重试，候选不高于基线；对已确认且未变化的单元重复放置为 0 |
| 取消到停稳 | 分别记录请求接受、最后新副作用、最后在途操作确认/动作控制释放；p95 不高于基线且普通可中断动作目标 <=250ms；不可立即停的动作单列，不伪装达标 |
| 事件循环 | 相同采样窗口的 P95/P99，继承原 P5/L0 阈值；相对基线不得恶化 >5%，原门更严则用原门 |
| 内存 | 主进程/worker 的 RSS、heap 峰值及稳态斜率；有界工作集不随重试累计，30 分钟稳态增量目标 <=10%，最终仍须通过原 P5-H 门 |

回退：候选选择器采用独立默认关闭的实验配置，关闭后回到本轮“固定锚点 + 世界核对 + 线性批次”，保留 journal/租约/未知结果保护。旧、新选择器使用相同工程摘要和单元身份，检查点可读；不能回退到盲目重放或移除 D2 ACK/背压。

阶段关系：用户明确 P5-D2 已完成、D3 未实施。已找到原 P5-A..H 总路线和 D2 提示词；本轮未找到独立 D3 原始实施提示词，不猜其完成门。本切片不是新的 D3，也不是 D3 前置条件。若使用 SpatialIndex，等待原 D3 具体接口核验；移除每次全体素复制、共享 WorldMirror、路径 corridor 失效明确归原 P5-E；worker 生命周期属 P5-F，真实 comparator/闭环属 P5-G，1/5/10 AB 属 P5-H，均不提前声明完成。

## 可复核官方源码索引

所有链接固定同一提交，引用的是实际接口和实现；未以 README 的性能宣传作为本项目实测。

- [README](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/README.md)、[USAGE](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/USAGE.md)、[FEATURES](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/FEATURES.md)、[SETUP](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/SETUP.md)。
- [IBaritone](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/api/java/baritone/api/IBaritone.java)、[IPlayerContext](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/api/java/baritone/api/utils/IPlayerContext.java)。
- [Process API 目录：IMine/IBuilder/IFarm/IExplore/IGetToBlock/IFollow/IBaritoneProcess](https://github.com/cabaletta/baritone/tree/23723891da460ef15797b02fe5b385b0c5b163cc/src/api/java/baritone/api/process)。
- [MineProcess](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/process/MineProcess.java)、[BuilderProcess](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/process/BuilderProcess.java)、[FarmProcess](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/process/FarmProcess.java)。
- [ExploreProcess](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/process/ExploreProcess.java)、[GetToBlockProcess](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/process/GetToBlockProcess.java)、[FollowProcess](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/process/FollowProcess.java)。
- [IPathingControlManager](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/api/java/baritone/api/pathing/calc/IPathingControlManager.java)、[PathingControlManager](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/utils/PathingControlManager.java)、[IPathingBehavior 取消契约](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/api/java/baritone/api/behavior/IPathingBehavior.java)。
- [AStarPathFinder](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/pathing/calc/AStarPathFinder.java)、[PathingBehavior](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/behavior/PathingBehavior.java)、[PathExecutor](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/pathing/path/PathExecutor.java)。
- [CalculationContext](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/pathing/movement/CalculationContext.java)、[MovementHelper](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/pathing/movement/MovementHelper.java)、[ToolSet](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/utils/ToolSet.java)。
- [ChunkPacker](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/cache/ChunkPacker.java)、[CachedChunk](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/cache/CachedChunk.java)、[CachedRegion](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/cache/CachedRegion.java)、[WorldProvider](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/cache/WorldProvider.java)、[BlockStateInterface](https://github.com/cabaletta/baritone/blob/23723891da460ef15797b02fe5b385b0c5b163cc/src/main/java/baritone/utils/BlockStateInterface.java)。

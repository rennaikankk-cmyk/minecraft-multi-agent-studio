# 蓝图差异工作集：首个实现与对照记录

日期：2026-09-05。实现提交：`b8da2df75ed6b852a1b327a23521843ec14f1f52`，直接提交到本地 main。此前五个可靠性修复/研究提交已从 `75cab90` 快进合入 main。历史 stash 保留；未 push，未启动 Studio 或 Minecraft，未连接外部服务器。

本轮实现了 [Baritone 研究中推荐切片](BARITONE_CAPABILITY_REVIEW_2026-09-05.md) 的第一版可执行路径：有界差异选择、支撑面选择、部分完成和等待状态、按实际缺口补料、固定坐标保护及验证。默认关闭。模拟世界对照显示稀疏修复减少批次，但纯计算成本上升；没有达到可宣布生产启用的性能/联机完成门。

## 已实现

`packages/skills/src/planning/blueprint-workset.ts` 复用 `reconcileBlueprint`、`resolveMaterials` 和 `orderBlueprintCells`。单元分为已验证、缺失、错误或未知，最多 512 格。先处理最早未完成的结构类别，在其中按已有 order 稳定选择有实际材料和已知支撑的单元。未知低优先级前置结构不会被当作已完成；属于同一类别且支撑独立的已知单元可继续施工。蓝图内部支撑必须已经验证匹配。

`blueprint-planner.ts` 的 `strategy=workset` 沿用现有 `world.interact` capability。placement 预算只计实际放置，不让已匹配格占批额度。每次放置后重新读取整份有界观测；同样在批次结束前验证。已确认的物品、坐标和必要属性必须匹配，receipt 自称成功而世界未确认时失败。此版本优先保证正确性，尚未把后续观测优化为局部差异查询。

`MineflayerBotClient` 新增只读 `blueprint.inspect-workset` 操作，读取加载方块、支撑面、玩家位置和当前背包，每 32 格让出事件循环。没有创建第二世界镜像，也没有移除原 snapshot/findBlocks 或触碰 WorldMirror 同步层。snapshotId 标识一次观测，不冒充原子世界版本或 WorldMirror revision。

默认向下支撑的普通结构格可尝试六个相邻实心支撑面。显式非默认参考面、声明必要属性、utility/decoration 单元保留指定面。只接收可达、非空的实心支撑；不会推断未知区块中存在方块。当前是交互范围内的工作面选择，不是新路径规划或自动移动站位算法。

蓝图版 `block.place-safe` 固定目标坐标：支撑丢失就停止，不能沿普通放置原语的旧回退路径改在下一层施工。目标卸载时等待核对；清除错误占位块前先确认替换材料存在。仍复用原 HarvestAuthorization、ActionLock、MovementController 和 L0，未添加动作控制定时器。

SkillExecutor 将现有 `SkillPolicyView` 以只读函数投影放入 context，用于逐个目标和支撑位置的距离裁决。选择器同时要求 Runtime 的物理交互范围与当前服务器策略允许。旧 Skill 调用方不受可选字段影响；直接调用 workset 执行器时必须提供该策略视图，缺失会明确拒绝，不放宽距离。

## 结果与恢复

| 状态 | 意义 |
|---|---|
| COMPLETE | 最终整份蓝图全部匹配 |
| BATCH_LIMIT | 实际放置已到批次预算，还有可执行单元 |
| WAITING_MATERIAL | 当前可施工单元缺材料或受材料预算限制，附有缺口 |
| WAITING_OBSERVATION | 目标/支撑观测未知，保留已有确认进度 |
| WAITING_SUPPORT | 暂无可用、满足依赖的支撑面 |
| WAITING_REACH | 当前站位或服务器策略不允许交互 |
| WAITING_PROPERTIES | 方块名称相同但必要属性不同；通用属性修复动作尚未实现 |
| READY | 只读检查发现可执行单元；没有宣称工程完成 |

`completed` 只代表整份蓝图是否验证完成。一个 Skill 批次正常返回 WAITING/BATCH_LIMIT 仍是未完成工程，Coordinator 的 journal 保留 sparse placements、未知单元和下一处未验证索引。`build-journal.ts` 重新核对每条 placement 的蓝图索引、方块名、类别、坐标与最终状态；不接受另一个位置的回执。

工程的 buildId、摘要、锚点和租约/执行者排他规则不变。取消或超时仍不能解除未知执行者身份；已正常返回的等待批次则已停稳，可以继续核对。文件日志继续只承诺进程恢复，不新增断电保证。

开启新模式后，Coordinator 首次先派只读/实际世界核对，不预先按整个连续批次采料。自动补料只读取同一 bot/runtime 的已返回、最多 60 秒新鲜的 WAITING_MATERIAL 回执，再扣除当前库存；换 Runtime、换 Bot、过期、在途或无证据时重新观测。两 Bot 仍共享同一基地/工程身份，已有未知执行者时不会并发接管。

## 开关和回退

Coordinator 启动配置 `STUDIO_BLUEPRINT_WORKSET=1` 才会自动选择 workset；也可由本地 API/测试的 `blueprintWorksetEnabled` 选项显式覆盖。未设置或为 0 时保持 linear。Coordinator 的模型直派与确定性直派在共用入口统一覆盖 strategy，模型不能自行开启该实验。

独立 Skill API 的 `strategy` 是明确的逐请求选择，默认仍为 linear；它不由 Coordinator 的环境变量替代调用方授权。需要同步部署包含新 schema/操作的 Skills、Coordinator 和 Runtime，旧 Runtime 不支持新工作集操作。

关闭开关后回到此前固定锚点、世界核对和线性批次。已持久化的工程摘要不因策略改变而改变，未知结果、租约、方块核对和固定坐标保护均保留。本轮没有替用户启用运行环境中的开关。

## 验证

以先前已通过全套验证的 `31fb611` 为基线，修改后 `corepack pnpm check` 退出码 0：全部类型检查、默认测试与构建通过。

| 范围 | 实际结果 |
|---|---|
| 全部 Vitest | 2630 通过，38 按原环境开关跳过，0 失败 |
| Skills | 906 通过 |
| Coordinator | 452 通过，另有 5 个构建后 ESM 进程恢复测试通过 |
| Runtime | 437 通过，4 个真实 Minecraft 测试跳过；另有 2 个 Supervisor 进程测试通过 |
| Studio manager Node 测试 | 34 通过 |
| `cargo test --manifest-path packages/pathfinder-rs/Cargo.toml --locked` | 48 通过，Rust 源码未修改 |
| `cargo fmt --manifest-path packages/pathfinder-rs/Cargo.toml -- --check` | 通过 |
| `git diff --check` | 通过 |

全套检查时 build manifest 为 `31fb611 dirty=true`；该工作树代码随后原样提交为 `b8da2df`。对照脚本在 `b8da2df dirty=false` 上执行。Runtime 的原 native worker/WorldMirror 跨语言契约没有跳过。其余 34 个跳过项属于 world-memory/task-system 的真实 PostgreSQL/Redis 环境测试，未当作通过。

新增测试包括：稀疏格不占放置预算、同类独立单元缺料继续、逐步材料预算、未知和结构类别边界、蓝图内部支撑依赖、属性/可达/支撑等待、只读检查、取消后迟到回执、世界否认成功回执、服务端策略逐单元生效、实际 Coordinator 派发开关、缺料前先观测、跨进程非连续进度恢复，以及 Runtime 不偏移目标/不先拆后发现缺料。

## 模拟世界对照

命令：

```powershell
corepack pnpm --filter @minecraft-studio/skills build
node scripts/benchmark-blueprint-workset.mjs --output <report-path.json>
```

2026-09-05T13:37:14Z，Node v24.19.0，5 场景 × 2 策略 × 20 次，共 200 次。脚本直接调用编译后的 Skill，模拟世界重置一致、材料一致、交替执行两策略。模拟允许整条 16 格测试线交互；没有模拟游戏版本、真实触达、寻路、网络延迟或放置时间。等待/失败运行保留在分母，未注入成功补料来美化完成率。

| 场景 | linear | workset |
|---|---|---|
| 全新建造 | 20/20 完成；1 批；2 次观测；16 个验证产出 | 20/20 完成；1 批；17 次观测；16 个验证产出 |
| 稀疏损坏 0/15 号格，放置预算 2 | 20/20 完成；平均 2 批、4 次观测 | 20/20 完成；平均 1 批、3 次观测 |
| 缺少第一格材料 | 0/20 完成，立即 BUILD_MATERIAL_MISSING，0 个产出 | 0/20 完成，先完成 15 个独立同类格，最终 WAITING_MATERIAL |
| 结果丢失后的已确认进度 | 20/20 完成；1 个剩余格，无重复放置 | 20/20 完成；1 个剩余格，无重复放置 |
| 未加载格及后续取消 | 0/20 完成，BUILD_VERIFY_TIMEOUT | 0/20 完成，已知独立格可推进，最终 WAITING_OBSERVATION |

所有场景重复副作用计数为 0，材料消耗等于模拟的新增验证格数，无自动重试。取消探针发生在静止的模拟批次边界，不代表游戏中最后一个在途动作的停稳延迟；另由测试验证迟到回执后的新副作用为零。

纯算法 P95：全新建造 linear 0.346 ms、workset 1.972 ms；稀疏修复 linear 0.318 ms、workset 0.617 ms。该版本减少了必要的调度批次，却增加了候选分类、Schema 解析和逐次全量核对成本。不能把减少批次直接写成“耗时改善 20%”。完整新建没有满足研究中拟定的相对性能目标，因此本版本保留为默认关闭的候选实现。

整个混合探针的事件循环 P95/P99 为 5.73/13.06 ms，进程 RSS 峰值约 148.4 MiB、heap 峰值约 65.7 MiB。这些数值包含两策略、夹具、导入及 GC，是诊断数据；未分离单 Bot/worker，也未运行 30 分钟内存稳定性实验，不用于宣布 L0 或 P5-H 通过。

原始 JSON 和完整检查日志随本次交付保存。未执行 Minecraft 联机、真实 1/5/10 Bot、Baritone/Java 对比、外服、Spark 或断电测试，没有联机性能与净产出结论。

## 后续边界

P5-D2 已完成、P5-D3 未实施的事实保持不变；本轮未取得 D3 独立原文，未猜测它的门。没有添加 SpatialIndex、替换 WorldMirror 消费路径或新建 Rust 算法。

下一步仍聚焦本切片：把全量重核优化为有明确失效条件的局部工作集，保留结构阶段切换和工程完成前的完整核对，再通过已有显式隔离 E2E 入口做同世界对照。只有完成真实联机正确性及性能门后再考虑默认启用；不扩展农田、Java 后端或其他 Skill 来掩盖当前成本。

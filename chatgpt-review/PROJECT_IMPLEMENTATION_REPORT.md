# PROJECT IMPLEMENTATION REPORT

**仓库**: rennaikankk-cmyk/minecraft-multi-agent-studio
**分支**: main
**HEAD**: fdee840 (2026-08-29)
**本地 = GitHub main**: 是(0 ahead / 0 behind),工作树 clean
**总 commit 数**: 198
**TS 源码文件**(非测试): ~223 个;**测试文件**: 152 个;**测试用例**: ~975 个

---

## 一、总体架构(实际存在的)

```
U9 285H (Windows / x64, 也支持便携模式)
│
├─ MinecraftMultiAgentStudio.exe   [存在 ✓] SEA 单文件启动器(dist/, 198MB)
│   └─ scripts/start-studio.mjs    [存在 ✓] 自动接线: Spark 发现 → coordinator
│                                   + control-api + dashboard + local-manager
│
├─ apps/coordinator                [存在 ✓ 完整] RuntimeLinkServer(WS)+ControlLinkServer(HTTP)
│   ├─ local-planner.ts            [存在 ✓ 完整] LLM 规划 + 确定性目标快速路径
│   ├─ autonomous-director.ts      [存在 ✓ 完整] Needs评估→目标派发→失败恢复→抑制
│   ├─ survival-needs.ts           [存在 ✓ 完整] Needs/Utility 评分器(纯函数)
│   ├─ deterministic-goals.ts      [存在 ✓ 完整] 模板→决策解析(0 LLM)
│   ├─ replan-oracle.ts            [存在 ✓ 完整] 3连败→模型选白名单策略
│   ├─ strategy-review.ts          [存在 ✓ 完整] 5分钟周期战略评审
│   ├─ bot-registry.ts             [存在 ✓ 完整] bot 状态注册表(内存)
│   ├─ bot-assignment.ts           [存在 ✓ 完整] 任务→bot 租约(内存)
│   └─ goal-lifecycle-store.ts     [存在 ✓ 完整] Postgres 持久 / InMemory 可选
│
├─ apps/bot-runtime                [存在 ✓ 完整] Mineflayer bot 进程
│   ├─ runtime.ts (2404行)         [存在 ✓ 完整] 状态机/L0安全/skill执行/死亡处理
│   ├─ mineflayer-client.ts (5600+行) [存在 ✓ 完整] 全部 Mineflayer 能力适配
│   ├─ combat-driver.ts (2120行)   [存在 ✓ 完整] 确定性战斗引擎
│   ├─ combat-mineflayer-adapter.ts [存在 ✓ 完整] 战斗→Mineflayer 动作
│   ├─ progress-watchdog.ts        [存在 ✓ 完整] stuck/no-progress/loop 检测
│   └─ server-auth (server-auth.ts in combat pkg) [存在 ✓ 完整] AuthMe 自动注册/登录
│
├─ apps/control-api                [存在 ✓ 完整] Dashboard 的 HTTP API + SSE 流
├─ apps/dashboard                  [存在 ✓ 完整] Next.js 16 + React 19 前端
│   ├─ bot-map.tsx                 [存在 ✓] canvas 实时地图(轨迹/朝向/脉冲)
│   ├─ bot-compass.tsx             [存在 ✓] 视角罗盘 + 生命/饥饿仪表
│   └─ bot-lifecycle-switch.tsx    [存在 ✓] 断开/重启/自动断联开关
│
├─ apps/task-worker                [存在 ✓ 完整] BullMQ worker(coordinator.goal 桥)
│
├─ packages/skills                 [存在 ✓ 完整] 23 个 Skill + 执行器 + 恢复阶梯
├─ packages/combat                 [存在 ✓ 完整] 战斗算法库(9个控制器)
│   ├─ critical-engine.ts          [存在 ✓ 已接线] 5种暴击策略
│   ├─ melee-controller.ts         [存在 ✓ 已接线] 控制帧追击(100ms帧)
│   ├─ crystal-executor.ts         [存在 ✓ 已接线] 候选枚举+放置+引爆
│   ├─ wtap-engine.ts              [存在 ✓ 已接线] W-Tap/S-Tap
│   ├─ consumables.ts              [存在 ✓ 未接驱动] 盾/药水/金苹果
│   ├─ crystal-engine.ts           [存在 ✓ 评分引擎]
│   └─ server-auth.ts + auth-store.ts [存在 ✓ 已接线] AuthMe 自动认证
│
├─ packages/ai-router              [存在 ✓ 完整] vLLM/Ollama 适配 + AIRequestScheduler
├─ packages/safety                 [存在 ✓ 完整] L0 确定性安全层
├─ packages/task-system            [存在 ✓ 完整] 派发FSM+执行FSM+Postgres+BullMQ
├─ packages/world-memory           [存在 ⚠ 零消费] pgvector 世界记忆(未接任何 app)
├─ packages/observability          [存在 ✓ 完整] 结构化日志 + metrics
├─ packages/cpu-resource-manager   [存在 ⚠ 部分] P/E 核检测(已实现未验证)
├─ packages/protocol               [存在 ✓ 完整] Zod 消息契约
├─ packages/environment            [存在 ✓ 完整] 硬件/软件探测
│
├─ PostgreSQL                      [可选] goal 持久化(COORDINATOR_TASK_POSTGRES_URL)
├─ Redis + BullMQ                  [可选] durable 任务投递(production 模式)
└─ DGX Spark vLLM                  [可选,自动发现] 192.168.100.2:8001 ornith15-heretic
```

**不存在的**:
- Rust crate: **零**(AGENTS.md 说"不在测量前写 Rust",至今未写)
- Docker / docker-compose: **零文件**(文档提到但从未创建)
- systemd: **零**
- SQLite: 不使用
- pgvector: 依赖声明了但未接任何 app
- 末地/下界维度适配: 未实现
- 附魔/药水酿造: 未实现
- 钓鱼/农业: 未实现

---

## 二、逐模块状态

### apps/coordinator — 协调器

| 属性 | 值 |
|---|---|
| 路径 | `apps/coordinator/src/` |
| 主要文件 | main.ts(508行), local-planner.ts(4200+行), autonomous-director.ts(1100+行), survival-needs.ts(450行), deterministic-goals.ts(300行), replan-oracle.ts(200行), strategy-review.ts(230行), bot-registry.ts(500行), bot-assignment.ts(541行) |
| 实现程度 | **基本完成** |
| 工作流 | AutonomousDirector 每 8s tick → eligibleForAutonomy 过滤 → survival-needs 评分 → selectGoal → bindGoal → planAndDispatch → local-planner(确定性快速路径 or LLM) → transport.sendSkillInvocation → runtime → mineflayer |
| 已测 | 293 coordinator 测试全绿 |
| 问题 | local-planner 4200 行单文件;BotRegistry 纯内存(coordinator 重启丢全部 bot 状态);BotAssignment 纯内存租约 |
| 优先级 | P1(核心) |

### apps/bot-runtime — Bot 运行时

| 属性 | 值 |
|---|---|
| 路径 | `apps/bot-runtime/src/` |
| 主要文件 | runtime.ts(2404行), mineflayer-client.ts(5600+行), combat-driver.ts(2120行), combat-mineflayer-adapter.ts(1220行), supervisor.ts(881行), progress-watchdog.ts(206行), world-state.ts(296行) |
| 实现程度 | **基本完成**(survival/combat)/ **部分完成**(crystal 接线 / anchor 引擎未接) |
| 工作流 | RuntimeLinkClient(WS 认证) → SingleBotRuntime → MineflayerBotClient → L0SafetyController(每 1s) + SkillExecutor + CombatDriver(受击自动反击) |
| 已测 | 249 bot-runtime 测试全绿 |
| 问题 | mineflayer-client 5600 行巨型文件;收集租约泄漏已修但 audit 可能还有其他未释放路径;crystalCandidates 每次观察都做 blockAt 枚举(性能?) |
| 优先级 | P1 |

### packages/skills — Skill 系统

23 个注册技能,全部有 input/output/state schema、preconditions、timeoutMs、idempotent 标记、retryPolicy。

| Skill | 路径 | 真实实现 | 调用 MC API | 状态机 | 恢复 | 测试 | 备注 |
|---|---|---|---|---|---|---|---|
| movement.goto | builtin/movement-goto.ts | ✓ | pathfinder.goto | ✓ | 无重试(非幂等) | ✓ | 64 格限距,不挖掘(safe)/可挖(anarchy) |
| travel.route | builtin/travel-route.ts | ✓ | goto×N段 | ✓ | 逐段审计 | ✓ | 256 段上限 |
| inventory.equip-armor | builtin/equip-armor.ts | ✓ | armor.snapshot+equip | ✓ | 幂等 | ✓ | 每槽最优 |
| combat.engage | builtin/combat-control.ts | ✓ | combat.control→driver | ✓ | 非幂等无重试 | ✓ | 意图下发,机制在driver |
| combat.disengage | builtin/combat-control.ts | ✓ | 同上 | ✓ | 幂等 | ✓ | |
| combat.stance | builtin/combat-stance.ts | ✓ | combat.stance-set | 幂等 | ✓ | ✓ | 切立场 |
| world.scan | builtin/scan-blocks.ts | ✓ | findBlocks | 幂等 | ✓ | ✓ | 32命中/96格 |
| collect.block | builtin/collect-block.ts | ✓ | collectBlock 插件 | ✓ | 前置拒绝+恢复阶梯 | ✓ | 64目标/64格 |
| craft.item | builtin/craft-item.ts | ✓ | recipesFor+craft | ✓ | 工作台确保链 | ✓ | |
| world.place-block | builtin/place-block.ts | ✓ | placeBlock | ✓ | 读回验证 | ✓ | |
| container.transfer | builtin/container-transfer.ts | ✓ | openChest+deposit | ✓ | 部分成功如实 | ✓ | |
| smelt.item | builtin/smelt-item.ts | ✓ | openFurnace | ✓ | 等待+读回 | ✓ | 先掠夺后使用 |
| food.secure | builtin/secure-food.ts | ✓ | forageSafeFood | ✓ | 如实报告 | ✓ | 120s 预算 |
| trade.villager | builtin/trade-villager.ts | ✓ | openVillager | ✓ | delta 验证 | ✓ | |
| mine.branch | planning/mine-planner.ts | ✓ | 已接线 | ✓ | ✓ | ✓ | 证据表标 false(滞后) |
| mine.vein | planning/mine-planner.ts | ✓ | 已接线 | ✓ | ✓ | ✓ | 同上 |
| site.assess | planning/site-assessor.ts | ✓(纯决策) | 无需 MC | ✓ | ✓ | ✓ | 未在真实服跑过 |
| shelter.dig | planning/site-assessor.ts | ✓ | 服务器确认挖掘 | ✓ | ✓ | ✓ | direction 不可 down |
| build.blueprint | planning/blueprint-planner.ts | ✓ | place-block×N | ✓ | 中间态安全 | ✓ | |
| stock.levels | planning/stock-levels.ts | ✓(纯决策) | 无需 | ✓ | ✓ | ✓ | |
| store.sort | planning/stock-levels.ts | ✓ | container-transfer | ✓ | ✓ | ✓ | |
| pack.shulker | planning/stock-levels.ts | ✓ | container-transfer | ✓ | ✓ | ✓ | |
| movement.profile | planning/movement-profile.ts | ✓(纯决策) | 无需 | ✓ | ✓ | ✓ | |

**战斗能力细分**(combat-driver.ts + adapter,不是 skill 而是 driver 内部):

| 能力 | 状态 | 备注 |
|---|---|---|
| 近战攻击 | ✓ 完整 | weapon-manager 冷却/i-frame |
| 目标选择 | ✓ 完整 | threat-analyzer 威胁打分 + target-selector |
| 武器选择 | ✓ 完整 | weapon-manager |
| 护甲装备 | ✓ 完整 | equip-armor skill |
| 追击 | ✓ 已接 | melee-controller 100ms 控制帧(本轮新接) |
| 逃跑 | ✓ 完整 | retreat-controller |
| 盾牌 | ⚠ 代码在 | consumables.ts 写了但驱动未调用 |
| 弓/弩 | ✓ 完整 | DRAW/RELEASE_RANGED_WEAPON |
| 药水 | ⚠ 代码在 | consumables.ts 未接 |
| 金苹果 | ⚠ 代码在 | 同上 |
| 图腾 | ✓ 完整 | TotemManager + POP 检测(entity_status 35) |
| 暴击 | ✓ 已接 | critical-engine 5策略(anarchy 含 PACKET_CRIT) |
| W-Tap | ✓ 已接 | wtap-engine |
| Crystal PvP | ✓ 已接(本轮) | enumerate+place+detonate 已接 adapter |
| Anchor PvP | ✗ 未接 | anchorBurstTiming 公式已写,执行层未实现 |
| 多敌人 | ✓ | maxHostileCount 8(anarchy)/99(aggressive) |
| Mob Combat | ✓ | identity.ts 白名单外一律敌对 |
| Player Combat | ✓ | 同上 |
| 爆炸观测 | ✓ | explosion-packet-adapter |
| Surround | ✗ 未接 | SurroundPlanner 存在未 import |

### packages/task-system — 任务系统

| 属性 | 值 |
|---|---|
| 实现程度 | **基本完成** |
| 派发 FSM | 10 状态 + 严格迁移表 + 租约 + outbox |
| 执行 FSM | PRECHECK→PLAN→EXECUTE→VERIFY→SUCCESS/ABORT + RECOVER/REPLAN |
| Postgres | 0001-0006 迁移,CAS 持久化,SKIP LOCKED outbox |
| BullMQ | job attempts=1,5 重陈旧防护,恢复 stalled |
| 问题 | isolated-test 之外无 production 端到端 BullMQ 验证记录 |
| 优先级 | P2 |

### packages/world-memory — 世界记忆

| 属性 | 值 |
|---|---|
| 实现程度 | **空壳(零消费)** |
| 文件 | pg-pool-adapter.ts, postgres-repository.ts, repository.ts |
| 问题 | 完整 Postgres/pgvector 世界记忆,但没有任何 app 导入它。文档写了 SharedWorldState 但实际是每个 bot 一个私有 WorldStateStore |
| 优先级 | P3 |

### packages/cpu-resource-manager — CPU 调度

| 属性 | 值 |
|---|---|
| 实现程度 | **部分完成** |
| 现状 | P/E 核检测代码存在,affinity 默认关闭;无真实多核映射验证 |
| 优先级 | P4 |

### DGX Spark / AI 调度

| 属性 | 值 |
|---|---|
| 自动发现 | ✓ discoverLocalAIWithRetry 扫描 192.168.100.2:8001 等 |
| AIRequestScheduler | ✓ 优先级/并发/队列/超时/重试/取消/stale/supersede |
| 确定性快速路径 | ✓ 自主链 0 LLM;自由目标才走模型 |
| 重规划神谕 | ✓ 3连败→白名单菜单 |
| 战略评审 | ✓ 5分钟/bot |
| 16并发 | AI_MAX_CONCURRENCY=12(留4给qqbot),perBotConcurrency=1 |
| 真实使用 | ✓ 已验证(192.168.100.2:8001, ornith15-heretic, 结构化输出) |
| structured output | ✓ z.toJSONSchema → vLLM format |
| tool calling | ✗ 未实现 |
| streaming | ✗ 未实现 |
| prompt cache | ✗ 未实现 |

---

## 三、自主闭环真实行为模拟

**如果现在启动一个空背包 Bot 丢进新世界:**

### 0~1 分钟
- 连接 → spawn → L0 开始 monitoring → AutonomousDirector tick → survival-needs 评分
- 结果: TOOL_PROGRESSION(75分) → 确定性派发"获取 wooden_pickaxe"(0 LLM)
- local-planner 展开真实计划(如 collect oak_log → craft planks → craft sticks → craft pickaxe)
- 开始执行 collect.block

### 1~5 分钟
- 采集圆木 → 合成木板/木棍/工作台/木镐 → 需求重评 → stone_pickaxe
- L0 安全层在后台监测(饥饿/生命/水/岩浆/卡住)
- food.secure 需求出现(储备<3)→ 觅食(掉落物→作物→动物→探索)

### 5~30 分钟
- 石器时代 → 铁器(挖铁矿→熔炉→铁锭→铁镐/铁剑)
- fuel: 煤或木炭(资源图有 charcoal 配方)
- food reserve 目标 12 份,主动觅食
- 避难所(石铁期,受伤时提前)
- ProgressWatchdog 检测 stuck/no-progress/loop → 恢复动作

### 30~120 分钟
- 钻石推进(铁镐→挖钻石→钻镐/钻剑)
- 盾牌/铁甲/图腾
- 探索(扇区递增 48/96/160/224 格)
- 死亡→自动重生→空背包重推导基础需求→DEATH_RECOVERY 回捡

### 2 小时以后
- 持续循环:采集→合成→探矿→储备→探索
- 3 连败需求抑制 120s + Spark 神谕选替代策略
- 夜间 L0 反射层保命

### 已知会卡住/失败的场景:
1. **Anchor 执行层未接**: AnchorEngine 评分存在但 adapter 不执行 anchor 动作
2. **Surround 未接**: SurroundPlanner 存在未 import
3. **Shield/药水/金苹果**: consumables.ts 写了但驱动不调用
4. **末地/下界**: 无维度适配,无下界传送门逻辑
5. **附魔/钓鱼/农业**: 完全未实现
6. **重复工作台**: ensureCraftingTableAccess 有冷却+per-area 上限+世界扫描复用,但两 bot 同时扫描仍有竞态窗口
7. **bot 卡墙**: L0 STUCK→UNSTICK(600ms jump+back);ProgressWatchdog 8s stuck→local-unstick,20s no-progress→local-replan
8. **无限循环**: watchdog loop 检测(重复目标/交替循环/path_reset≥5)→high-level-replan

---

## 四、之前问题的修复状态

| 问题 | 修复 | 验证 |
|---|---|---|
| 固定 12 步脚本 | ✓ 替换为 survival-needs Needs/Utility 评分 | 281→293 测试 |
| 每目标 1 LLM | ✓ 确定性快速路径(0 LLM 基础链) | 实测 0 LLM 请求 |
| 重复工作台 | ✓ ensureCraftingTableAccess 复用+冷却+上限 | 测试覆盖 |
| Bot 呆住 | ✓ ProgressWatchdog + L0 STUCK + watchdog 恢复 | 实测 |
| 背包满卡死 | ✓ L0 TIDY_DROP_JUNK 白名单丢垃圾 | 测试覆盖 |
| 死亡无处理 | ✓ death 事件+重生+取消任务+DEATH_RECOVERY | **实机验证** |
| 背包满暂停死锁 | ✓ 白名单丢垃圾+如实报告 | 测试覆盖 |
| 移动租约泄漏 | ✓ collect finally 释放 | **实机验证**(anarchy) |
| 两进程抢 botId | ✓ 认证时仲裁+runtime_replaced 终态 | 测试覆盖 |
| 低血重连死循环 | ✓ L0 EMERGENCY_STOP 需血量下降 | 测试覆盖 |
| collect 32 格不够 | ✓ anarchy 档 64 格 | **实机验证** |

---

## 五、多 Bot 系统

| 能力 | 1 Bot | 5 Bot | 10 Bot |
|---|---|---|---|
| 自主生存 | ✓ 实测 | 设计支持(每 bot 独立) | 设计支持 |
| Process Supervisor | ✓ 1-3 bot/进程 | ✓ 分组+故障域隔离 | ✓ |
| 独立 memory | ✓ 每进程隔离 | ✓ | ✓ |
| 资源锁 | ✗ 无跨 bot claim | ✗ 会抢同一棵树 | ✗ |
| SharedWorldState | ✗ 不存在 | ✗ | ✗ |
| 协作 | ✗ 无 | ✗ | ✗ |
| 掉线重连 | ✓ 指数退避 | ✓ | ✓ |
| 崩溃拉起 | ✓ 有限退避 | ✓ | ✓ |

**5/10 Bot 是否真正工作**: 代码支持(每 bot 独立进程+独立 Runtime Link 认证),但**从未实测 5/10 bot 同时运行**。唯一多 bot 实测是 2 bot(双 bot 验收)。

---

## 六、测试系统

| 套件 | 文件数 | 通过 | 命令 | 连 MC? |
|---|---|---|---|---|
| packages/combat | 10 files | 314 passed | `pnpm --filter combat test` | ✗ Mock |
| packages/skills | 26 files | 482 passed | 同上 | ✗ Mock |
| apps/bot-runtime | 11 files | 249 passed | 同上 | ✗ Mock |
| apps/coordinator | 22 files | 293 passed | 同上 | ✗ Mock |
| apps/control-api | 4 files | 14 passed(37 with integration) | 同上 | ✗(integration 用 HTTP) |
| packages/protocol | ? | 84 passed | 同上 | ✗ |
| packages/safety | ? | 11 passed | 同上 | ✗ |
| integration(GitHub Actions) | - | PostgreSQL+Redis 真实服务 | CI | ✗ 无 MC |

**最近一次 `pnpm check`**: 2026-08-29,全绿,exit 0。

**真实 Minecraft E2E**: 
- ✓ 已验证: 单 Bot 登录→砍树→合成木板→移动→觅食→吃→死亡→重生→死亡回收→采集
- ✓ 已验证: 铁镐→铁器时代推进
- ✗ 未验证: 完整 spawn→钻石→下界→附魔 闭环
- ✗ 未验证: 5/10 Bot 并行
- **结论**: "部分闭环已证明",不是完整闭环

---

## 七、性能数据

| 指标 | 值 |
|---|---|
| 单 Bot CPU | UNKNOWN(未测量) |
| 单 Bot RAM | UNKNOWN |
| LLM 请求频率 | ~0(自主链)/ 12次/hr(战略评审)/ 按需(聊天+神谕) |
| 5 Bot | NOT VERIFIED |
| 10 Bot | NOT VERIFIED |
| EXE 大小 | 198 MB |

---

## 八、虚假完成检查

| 声称 | 实际 | 判定 |
|---|---|---|
| world-memory 包 | 代码在,零消费 | **虚假完成** |
| CPU P/E 调度 | 检测代码在,映射未验证 | **部分虚假** |
| 5/10 Bot | 代码路径在,从未实测 | **NOT VERIFIED** |
| Anchor PvP | burst 公式在,执行层未实现 | **部分完成** |
| Surround | 类存在,未 import | **虚假完成** |
| 盾牌/药水/金苹果 | 代码在,驱动不调用 | **代码在,未接驱动** |
| Docker | 无文件 | **不存在** |
| README "多智能体作战集群" | 代码有战斗但从未 PvP 实战 | **过度声明** |
| 23 Skill 全部 Stable | 实际全部 Partial(unverified) | 项目自身如实标注 |

---

## 九、启动流程

```powershell
git clone https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio
cd minecraft-multi-agent-studio
corepack enable
pnpm install --frozen-lockfile
copy .env.example .env.local   # 编辑 Spark/API key
pnpm build:exe                  # 构建 EXE
.\dist\MinecraftMultiAgentStudio.exe
# → 自动发现 Spark → 启动 coordinator+control-api+dashboard
# → 浏览器 http://127.0.0.1:3000 → Bots 页创建 Bot
```

**能否一次成功**: 代码路径可跑通。需要外部条件:
- Minecraft Server(自己搭或已有)
- DGX Spark(可选,没有也能跑确定性链)
- PostgreSQL + Redis(可选,local memory 模式不需要)
- 不需要 Docker / Rust

---

## 十、优先修复清单

1. **P0**: world-memory 包接入 or 删除(不要留零消费空壳)
2. **P0**: 跨 bot 资源 claim(树/矿/工作台)——5 Bot 前必须
3. **P1**: consumables.ts 接入驱动(shield/药水/gapple)
4. **P1**: Anchor 执行层(放置/充能/引爆状态机)
5. **P1**: 5 Bot 实测 + 资源竞争验证
6. **P2**: mineflayer-client.ts 拆分(5600 行)
7. **P2**: local-planner.ts 拆分(4200 行)
8. **P2**: authentic MCP 服务器 E2E(spawn→diamond 全链)
9. **P3**: Surround 接入
10. **P3**: Docker/systemd 部署方案

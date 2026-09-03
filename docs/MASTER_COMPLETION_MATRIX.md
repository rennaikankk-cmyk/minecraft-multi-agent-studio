# MASTER_COMPLETION_MATRIX（唯一权威完成矩阵）

> 建立于 2026-09-03（commit 19da988 之后）。本矩阵**唯一**且**只增不减**：所有原始任务
> （PRODUCTION_GAP_ANALYSIS 七域 + 各轮 Master Round 的 Phase 1-9 / L / S / N / R /
> G 系列 + 四模型赛马 + 生产验收门禁）全部纳入。状态只允许：
> `NOT STARTED / IMPLEMENTED / UNVERIFIED / PARTIAL / BLOCKED / FAILED / DONE`。
>
> **DONE 判据（全部满足）**：代码接线 + 单测 + 集成测试 + 真实 Minecraft E2E +
> 可复现证据（命令/exit code/日志/服务端真值）+ 已提交 GitHub。
> 没有证据时保持原状态，禁止按代码量或测试总数升级。
>
> 每完成一个子项，在对应行补：commit、测试命令、exit code、起止时间、场景日志、
> Incident 链接、服务端证据、模型 revision、报告路径。

---

## A. 生命周期与可靠性（Phase 1 / Round 6.6-6.8）

| ID | 任务 | 验收条件 | 状态 | 证据 |
|---|---|---|---|---|
| L-D1 | Durable dequeue（waiting goal 持久化） | bot 未 ready 时 goal 先落盘再受理；重启不丢 | **DONE** | 0493fe7+c3cd37a（13 测试）；L2 真实 MC PASS（/tmp/l2 日志+coordinator.log 2026-09-03T01:31） |
| L-D2 | coordinator start() initialize() 恢复磁盘条目 | 重启后 recovered>0 日志 | **DONE** | c3cd37a；L2 场景实测 |
| L-D3 | durable 原子移交（dequeue→begin 崩溃窗口） | CLAIMED 态 + completeClaim + 恢复重置；崩溃窗口测试 | **DONE** | ed23e6c（4 claim 单测：标记不删/崩溃恢复/完成不恢复/FIFO）；**待补：真实进程 kill 于各状态转换窗口的崩溃一致性演练**（见 F-3） |
| L-D4 | 假 202 拒绝（disk-degraded） | 降级时 503 而非受理 | **DONE** | ed23e6c（CONTROL_LINK_STORAGE_DEGRADED→503 映射+单测） |
| L1 | Early Goal（未 ready 提交→202→自动执行） | RCON 位置真值+clean stop | **DONE** | 7fb0eed；2026-09-03 实测 PASS（0.5,70,1.7） |
| L2 | Restart During Registration | goal 存活 bot 重启 | **DONE** | 7fb0eed；PASS |
| L3 | Stop Provenance（user stop≠BOT_CRASH） | crashDelta=0+EXPECTED_STOP | **DONE** | 29a628b（计数修正）；PASS |
| L4 | 外部 kill 恰好 1 Incident | delta=1+UNEXPECTED_CRASH | **DONE** | 29a628b；PASS（pid 8356 实测） |
| L5 | 手动 goal 抢占 autonomy 后恢复 | 抢占证据+manual 完成+autonomy 恢复 | **DONE** | ef55a8c 前置修复（重试+abortReason）；2026-09-03 PASS（goal_retry+skill_result+新任务） |
| L6 | 5 Bot 公平性 | 15/15、离散度≤1、零饥饿 | **DONE** | 29a628b；PASS（15/15 离散度 0） |
| L7 | 10 Bot 公平性 | 同上@10bot | **FAILED** | 4 轮实测（11-15/20）；根因=单 fixture 容量（登录 90s/bot、SAFE_PATH_TIMEOUT_MS=20s 超时、疑似旧租约重启风暴 run-3）；修复方向：L7B-1/2/3 |
| L7B-1 | （修复）10-bot 容量：movement 20s 超时参数化/放宽 | 重跑 L7 PASS | NOT STARTED | — |
| L7B-2 | （修复）同服 peer 重启风暴（createBot 白名单生效路径）批量创建语义 | 重启只发生在需要时 | NOT STARTED | — |
| L7B-3 | （修复）过期租约恢复对重生 botId 的误停（run-3 证据） | 干净重启 studio 后 10-bot 无 SIGTERM 风暴 | IMPLEMENTED / UNVERIFIED（run-4 干净启动未再现，但未单独复现验证） | run-4 观测 |
| L8 | 双 fixture 并行不互杀不串扰 | 回收探针+RCON 双向零串扰 | **DONE** | 29a628b；PASS（dummy 被删、A/B 存活、位置真值、cross=false） |
| MGR-1 | manager desiredRunning（不复活已停 bot） | 重启后 0 僵尸 | **DONE** | eeb9f6a；实测 8→0 |
| MGR-2 | manager DELETE /v1/bots/{id}（槽位回收） | 删除后槽位可复用 | **DONE** | eeb9f6a；实测 15 次删除 |
| SOAK-S2 | 60min 多 bot soak | 指标+零 CRITICAL+clean stop | **PARTIAL** | 2026-09-03：38 轮、bot-01/03 38/38、bot-02 1/38（17×NETWORK_DISCONNECTED+3×SERVER_KICKED）、FACILITY CRITICAL=0、RSS 1.9G 峰值、cleanStop ✓；bot-02 连接抖动未归因 |
| SOAK-S1 | 单 bot 长跑 soak | ≥60min 指标 | NOT STARTED | — |
| SOAK-S4 | luv 外部 soak | 登录在场+零 crash delta | **BLOCKED** | 见 G1（luv 登录被拒，BLOCKED_PENDING_ROOT_CAUSE） |

## B. 灰度闭环（G 系列，目标服 luv.mc6.cn:22936）

> 纪律：固定 commit/模型/容器/参数/Profile；失败→Incident→证据→最小复现→修复→回归→隔离重测→**从当前级别重跑**；运行中禁止热改；晋级熔断条件见 GRAY_CANARY_REPORT.md。

| ID | 任务 | 验收条件 | 状态 | 证据 |
|---|---|---|---|---|
| G0 | 本地隔离服 L1-L8 全过 | 上表 L1-L8 全 DONE | **FAILED**（L7） | 见 L7 行；修复 L7B-1/2/3 后重跑 |
| G1 | 外部 1 bot 登录/观察/移动/重连 30-60min | 在场真值+干净退出 | **NOT_STARTED**（前置 G0=FAIL；外部预检 simpfun=BLOCKED_INCOMPATIBLE_MOD_LOADER、luv 当日登录被拒均不计入 G1 计时） | runtime-data/canary-evidence/
| G2 | 1 bot 自主生存 2h | autonomy 指标+SLO | BLOCKED（依赖 G1） | — |
| G3 | 2 bot 协作 2-4h | 协作+SLO | NOT STARTED | — |
| G4 | 5 bot 灰度 ≥6h | SLO | NOT STARTED | — |
| G5 | 10 bot 灰度 ≥12h | SLO+公平性 | NOT STARTED | — |
| G6 | 最终修复复验 ≥60min（可延长 24h） | 全部 SLO | NOT STARTED | — |

## C. 四模型主控赛马（Phase S + M1-M4）

> 每次只跑一个部署栈；切换记录停止/卸载/加载/预热/ready 五时点；冷启动不计 TTFT。
> 硬门禁：工具调用有效率≥99%、固定游戏指令集错误拒绝率=0、lost/duplicate goal=0、
> protected-asset violation=0、10bot 无长期饥饿。详见 MODEL_CONTROLLER_EVAL.md。

| ID | 任务 | 状态 | 证据 |
|---|---|---|---|
| S-1 | 读取 Spark 实际配置（M2 incumbent 全量记录） | **DONE** | SPARK_DEPLOYMENT_MATRIX.md §M2（容器 inspect+serve args 实测 2026-09-03） |
| S-2 | M1 Ornith Heretic 部署（已在盘，sha=c56d7696e9022d5d76ae211021924ac5a2d8aa95） | IMPLEMENTED / UNVERIFIED（权重在盘未部署验证） | SPARK_DEPLOYMENT_MATRIX.md §M1 |
| S-3 | M1 官方基线 ornith-ai/Ornith-1.5-35B-A3B-NVFP4 下载+部署 | NOT STARTED | — |
| S-4 | M3 nvidia/Qwen3.6-35B-A3B-NVFP4 下载+部署+1/2/4/8/16 并发 | NOT STARTED | HF 审计 ✓（官方 ModelOpt 版存在） |
| S-5 | M3 无审查变体研究（可信 Heretic/abliterated NVFP4） | NOT STARTED | — |
| S-6 | M4 Qwen3-Coder NVFP4 基线（无官方版；社区 NVFP4/…-FP4 已审计=中等可信；备选自量化） | NOT STARTED（审计 DONE） | SPARK_DEPLOYMENT_MATRIX.md §M4 审计记录 |
| S-7 | replay corpus ≥200 条真实决策输入（脱敏固定） | **PARTIAL**（提取脚本已建并运行：当前 11 条真实自主决策——规划输入按隐私设计未全量落日志；待 S-12 开启输入记录后在 L1-L8 重跑+soak 中扩充，不注水） | eval/replay/replay-corpus.jsonl |
| S-8 | 四模型离线回放（3 轮×4 模型；禁真执行） | NOT STARTED | — |
| S-9 | 隔离服 30 任务×4 模型（同种子同起点） | NOT STARTED | — |
| S-10 | Minecraft 游戏指令拒绝测试集 ≥100 条 | IMPLEMENTED / UNVERIFIED（语料已建，模型侧未跑） | eval/refusal/minecraft-game-commands.jsonl |
| S-11 | 真实 5/10 bot 调度负载测试（模型侧） | NOT STARTED | — |
| S-12 | 指标采集管线（质量/性能/资源 全字段） | NOT STARTED | — |
| S-13 | ONLINE_CONTROLLER + PLANNING_AND_INCIDENT_MODEL 判定 | NOT STARTED（无数据禁止预判） | — |

## D. 生产缺口七域（Phase 2-9，PRODUCTION_GAP_ANALYSIS.md 原始项）

| ID | 任务 | 状态 | 证据 |
|---|---|---|---|
| D1-1 | 重生后自动恢复 Goal 队列 | NOT STARTED | — |
| D1-2 | 掉落物价值判断 | **DONE**（assessDropRecovery：价值/距离/streak/despawn 窗） | 903af40+bf95cd6；含区分度单测 |
| D1-3 | recover.drops Skill（寻路+拾取+inventory delta 验证） | NOT STARTED（评估层 DONE，执行层未建） | — |
| D1-4 | 回收失败重建装备链模板 | NOT STARTED | — |
| D1-5 | 连续死亡停止送装备（streak≥3） | **DONE**（接线修复：recordDeath 此前从未被调用） | bf95cd6（新 diedAt 记录/到达 reset+测试） |
| D1-6 | 死亡时刻背包/XP 快照（非空背包评估） | **DONE** | bf95cd6（inventory.slots+XP 当场抓取→lastDeath→coordinator 快照优先） |
| D2-1..6 | sim distance/mob cap/距离/区块/TPS 感知 + afk.optimize | NOT STARTED | — |
| D3-1 | base.threat-assess Skill | NOT STARTED（combat threat-analyzer 基础在） | — |
| D3-2 | world.scan 差分+爆炸监听 | NOT STARTED | — |
| D3-3 | provenance.diff 损耗 vs 破坏 | NOT STARTED | — |
| D3-4 | evacuate.valuables 组合 Skill | NOT STARTED | — |
| D3-5 | base.abandon 状态转换 | NOT STARTED | — |
| D3-6 | base.relocate 组合 | NOT STARTED | — |
| D3-7 | FacilityLifecycleState + ABANDONED/SALVAGEABLE | NOT STARTED（14 态状态机已有，两态未加） | — |
| D3-8 | Provenance 生产接入 bot.dig 边界 | **PARTIAL→DONE(核心)**：store 活化+持久化+place 写入+dig 清除+salvage 通道（bf95cd6，此前恒 null 死代码）；**nearOwnBase=Base registry 未接**（单一 seam，恒 false） | bf95cd6；持久化单测×3 |
| D4-1..6 | portal.locate/build、坐标换算、nether.route、烈焰/疣、end.enter、维度切换恢复 | NOT STARTED | — |
| D5-1..6 | asset.ledger/reserve/产出率回填/audit/claim | NOT STARTED | — |
| D6-1..8 | Dashboard 运维八项（暂停自治按钮/公平调度显示/单 bot 隔离/一键停/计划视图/Spark 页/备份/部署管道） | NOT STARTED（Spark 页已有只读状态；操作类未建） | — |
| D7-1..9 | Skill 改进闭环九项（gap 生产接线/持久化/bundle 管道/worktree/sandbox/自动回归/canary 运行时/staged rollout） | NOT STARTED（域模型+44 测试已有=Phase 7 基础） | b354c8c |
| IRON-FARM | 刷铁机 multi-phase commissioning | NOT STARTED（研究 memo+平台模型已有） | docs/research/IRON_FARM_MEMO.md |
| SCHEMATIC | .schem parser 接入 | NOT STARTED（格式研究已有） | docs/research/SCHEMATIC_FORMATS.md |
| PVP-PILOT | PvP 交火 pilot | **FAILED（首测）**（P1 基建全证、交火未达成 honest-FAIL） | ff7b900 |
| FLUID-PLACE | fluid.place 能力（桶） | NOT STARTED | — |
| FARM-TILL | farm.till/plant/harvest | NOT STARTED（蓝图 DSL+研究已有） | — |
| ENTITY-LT | entity.locate/claim/transport | NOT STARTED | — |

## E. 生产验收门禁（本轮新增框架，执行于 C/D 完成后）

| ID | 任务 | 状态 |
|---|---|---|
| F-1 | 绝对 SLO 清单+测量（质量闭环/调度/资源三族） | NOT STARTED（清单已固化于 PRODUCTION_SLO_REPORT.md 框架） |
| F-2 | 20 项全栈故障注入（每项 11 条验证点） | NOT STARTED（L3/L4 已天然覆盖 2 项） |
| F-3 | durable 状态机崩溃一致性演练（每个转换窗口 kill） | NOT STARTED（单测层 DONE=L-D3） |
| F-4 | 备份/恢复演练（15 类资产+RPO/RTO） | NOT STARTED |
| F-5 | 运维控制面验收（16 项） | NOT STARTED |
| F-6 | Release Manifest+回滚验证 | NOT STARTED |
| F-7 | 生产成熟度分级判定 | 当前实际等级：**ISOLATED_INTEGRATION_READY 未达**（L7 FAILED）→ **NOT READY** |

---

## 当前总体判定（P0 固化）

- **G0 = FAIL**（L7 FAILED；60min soak PARTIAL）
- **G1 = NOT_STARTED**
- **External preflight = BLOCKED_INCOMPATIBLE_MOD_LOADER**（simpfun）

**Production Classification = NOT READY**。最近一次达成级别：无（L1-L8 从未全绿）。

## 变更日志

- 2026-09-03 建立；从 PRODUCTION_GAP_ANALYSIS.md + git 全史（ff7b900…19da988）+
  本日实测恢复全部原始项。

# MASTER_COMPLETION_MATRIX（唯一权威完成矩阵）

> **⚠ 陈旧快照警告（2026-09-11 追记）**：本矩阵是 **2026-09-03（commit 19da988）** 的快照，
> 而 HEAD 已推进到 **5fc643f（2026-09-11，476 次提交）**。下述行状态**只对 19da988 快照提交有效**。
> **2026-09-03 之后新增的行**已就地修订；**任何仍标 `NOT STARTED` 且位于 2026-09-03 分界线
> 之前（未标注修订日期）的行，在据此制定计划前必须对照 HEAD 重新核实。**

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
| D3-5 | base.abandon 状态转换 | IMPLEMENTED / UNWIRED（2026-09-11 重核：原记录 NOT STARTED 已失效） | `packages/base-management/src/base-registry.ts:278-280 markAbandoned` + 终态转移表 `:55-59`（abandoned: []）+ 测试 `packages/skills/tests/base-registry.test.ts:176`；**仍无生产消费方、无 skill id**，故不满足 DONE 判据 |
| D3-6 | base.relocate 组合 | NOT STARTED | — |
| D3-7 | FacilityLifecycleState + ABANDONED/SALVAGEABLE | PARTIAL（2026-09-11 重核：`ABANDONED` 已有，仅缺 `SALVAGEABLE`） | `packages/asset-policy/src/facility-platform.ts:56` 14 态状态机含 `abandoned`；转移表 `:78`（`abandoned: []` 终态）；终态测试 `packages/skills/tests/facility-platform.test.ts:48-50`（"abandoned 是终态"）。`SALVAGEABLE` 仍缺失 |
| D3-8 | Provenance 生产接入 bot.dig 边界 | **PARTIAL→DONE(核心)**：store 活化+持久化+place 写入+dig 清除+salvage 通道（bf95cd6，此前恒 null 死代码）；**nearOwnBase=Base registry 未接**（单一 seam，恒 false） | bf95cd6；持久化单测×3 |
| D4-1..6 | portal.locate/build、坐标换算、nether.route、烈焰/疣、end.enter、维度切换恢复 | PARTIAL（2026-09-11 重核：4 个 travel 技能已注册+坐标换算已实现；4 个 id 仍缺） | `packages/skills/src/builtin/catalog.ts:61-64` 注册 `travel.portal-ignite` / `travel.portal-use` / `travel.ascend` / `travel.bridge`（定义 `packages/skills/src/builtin/nether-travel.ts:84,129,169,215`）；坐标换算已实现并导出 `packages/skills/src/nether-coords.ts:53,65`。**仍真缺**：`portal.build`、`portal.locate`、`nether.route`、`end.enter`（全仓不存在这些 id） |
| D5-1..6 | asset.ledger/reserve/产出率回填/audit/claim | IMPLEMENTED / UNWIRED（2026-09-11 重核：领域真实存在，但未接入生产进程） | `packages/resource-management/src/resource-management.ts:29,261`（`ResourceLedger` / `DurableResourceLedger`）、`apps/coordinator/src/resource-service.ts:31`、回填接线 `apps/coordinator/src/autonomous-director.ts:675,680,722`。**`new CoordinatorResourceService` 只出现在测试**（`apps/coordinator/tests/resource-service.test.ts:16,75`），未出现在 `apps/coordinator/src/main.ts`；Control API 零 resource 路由 |
| D6-1..8 | Dashboard 运维八项（暂停自治按钮/公平调度显示/单 bot 隔离/一键停/计划视图/Spark 页/备份/部署管道） | PARTIAL（2026-09-11 重核：页面与一键重启已有；自治暂停仍为 env-only） | Dashboard 现有 **17 个页面**（含 `models`、`skills`、`gaps`、`bases`、`runtime`、`ai-spark`）；一键重启已实现：`scripts/studio-local-manager.mjs:538`（`POST /v1/studio/restart`）+ `apps/dashboard/app/api/studio/restart/route.ts`。**自治暂停仍只能走环境变量**：`apps/coordinator/src/autonomous-config.ts:27` |
| D7-1..9 | Skill 改进闭环九项（gap 生产接线/持久化/bundle 管道/worktree/sandbox/自动回归/canary 运行时/staged rollout） | PARTIAL（2026-09-11 重核：D1-D4 of 9 已交付并接线生产） | D1–D4：`apps/coordinator/src/main.ts:428-440`（`FileSkillGapStore` + `createSkillGapRecorder`），挂到 `onTaskAborted`（`:579,:602`），`GET /skill-gaps` 于 `apps/coordinator/src/shared-state-server.ts:207`，Dashboard `apps/dashboard/app/gaps/page.tsx` + `apps/dashboard/app/api/studio/skill-gaps/route.ts`。提交 `be0171e, 73dad67, 96570ec, ed0edae`。D5–D9 未交付 |
| IRON-FARM | 刷铁机 multi-phase commissioning | NOT STARTED（研究 memo+平台模型已有） | docs/research/IRON_FARM_MEMO.md |
| SCHEMATIC | .schem parser 接入 | IMPLEMENTED / UNVERIFIED（2026-09-11 重核：真实解析器+CLI+4 测试已有，无真实 MC E2E） | `apps/coordinator/src/schematic-import.ts` 有界解析器（gunzip + `prismarine-nbt`，版本/palette/体积校验，稳定错误码 `SCHEMATIC_FORMAT_UNSUPPORTED` / `SCHEMATIC_PALETTE_VERSION_MISMATCH` / `SCHEMATIC_VOLUME_EXCEEDED`）；CLI `scripts/import-schematic.mjs`；测试 `apps/coordinator/tests/schematic-import.test.ts`（4 项）。格式研究 `docs/research/SCHEMATIC_FORMATS.md` |
| PVP-PILOT | PvP 交火 pilot | **FAILED（首测）**（P1 基建全证、交火未达成 honest-FAIL） | ff7b900 |
| FLUID-PLACE | fluid.place 能力（桶） | IMPLEMENTED / UNVERIFIED（2026-09-11 重核：技能+运行时读回已实现） | `packages/skills/src/builtin/fluid-place.ts:118`；注册 `packages/skills/src/builtin/catalog.ts:60`；运行时处理器 `apps/bot-runtime/src/mineflayer-client.ts:2255-2284`（读回方块 + `FLUID_PLACE_NOT_CONFIRMED` 防伪）；文档 `SKILLS.md:512-517`；2026-09-10 落地（`5614448`） |
| FARM-TILL | farm.till/plant/harvest | IMPLEMENTED / UNVERIFIED（2026-09-11 重核：till/harvest/plant/bonemeal 真实且读回校验） | `apps/bot-runtime/src/farm-mineflayer-port.ts:54,73,82,93`；适配器 `apps/bot-runtime/src/farm-maintenance-adapter.ts:39,73-93`；对外暴露为 `farm.maintain`（`packages/skills/src/farm-maintenance.ts:120`） |
| ENTITY-LT | entity.locate/claim/transport | NOT STARTED | — |
| REFLEX-PROBE | §0.6.3 反射级时序放行门的**跨进程证据来源**（放行门可满足性） | **WIRING-PENDING**（2026-09-11 重核）：判定逻辑本身正确且 fail-closed，但生产中没有**任何**路径能放行 | 已修部分：`packages/combat/src/chain-sequencer.ts` 的 `chainRequiresClearance` 原写作 `steps.slice(1).some(...)`，静默跳过第 0 步，而 `apps/bot-runtime/src/combat-driver.ts` 只提交单步链 ⇒ `requiresClearance` 恒为 false、`assertClearance` 永不执行（门禁形同虚设）；已修为 `steps.some(...)` 并把"哪些交互类属反射级"改为**显式** `reflexGatedClasses`（默认仅 `"use"`；`attack` 的节奏与 i-frame 时机归 WeaponManager，§0.6.3 将"武器管理"定为战术级 ≤200ms，不得按反射预算判定），配 3 条测试（含 `slice(1)` 回归守卫）。**未接线部分**：`apps/bot-runtime/src/combat-reflex-probe.ts:82` 硬编码 `underRepresentativeLoad: false`（文件头自述"代表性负载需跨进程证据，单 runtime 不自证"），而 `packages/combat/src/reflex-clearance.ts:87-89` 要求其为 true 才放行；全仓库置 true 的仅 4 个测试文件。**这是章程 §0.6.3 的设计意图而非缺陷**（未过探针不得上真实对抗），但后果须明确：`TotemManager`/`CrystalEngine`/`PacketMineController` 三处反射级门禁在生产中恒拒 ⇒ **水晶放置与挖包硬阻塞**，图腾补位只在 anarchy 档走显式旁路（`combat-driver.ts:638-643`）。放行门**本身可满足**：`resolveCombatReflexProbe` 接受 `dependencies.combatReflexProbe` 注入的静态 report，缺口在于 `apps/bot-runtime/src/runtime-host.ts:61` 永远只装配进程内探针。 | 接线项：在 `runtime-host.ts` 接入跨进程负载关联源（M3 里程碑）；在那之前反射级模块保持不可用 |

## E. 生产验收门禁（本轮新增框架，执行于 C/D 完成后）

| ID | 任务 | 状态 |
|---|---|---|
| F-1 | 绝对 SLO 清单+测量（质量闭环/调度/资源三族） | NOT STARTED（**更正**：本行此前称"清单已固化于 `PRODUCTION_SLO_REPORT.md` 框架"，但该文件**从未存在于 git 历史**（全仓库仅此一处引用它）。SLO 清单实际尚未成文，需先建立该文档或就地内联清单） |
| F-2 | 20 项全栈故障注入（每项 11 条验证点） | NOT STARTED（L3/L4 已天然覆盖 2 项） |
| F-3 | durable 状态机崩溃一致性演练（每个转换窗口 kill） | NOT STARTED（单测层 DONE=L-D3） |
| F-4 | 备份/恢复演练（15 类资产+RPO/RTO） | NOT STARTED |
| F-5 | 运维控制面验收（16 项） | NOT STARTED |
| F-6 | Release Manifest+回滚验证 | NOT STARTED |
| F-7 | 生产成熟度分级判定 | 当前实际等级：**ISOLATED_INTEGRATION_READY 未达**（L7 FAILED）→ **NOT READY** |
| F-8 | `apps/studio-shell` 编译完整性（此前不被任何 CI 工作流或 pnpm 门禁覆盖） | **PARTIAL**（2026-09-11 首次实测：修复 2 个真实编译错误 + 补齐缺失图标；剩余前置为 Windows 专属构建产物）。详见证据列 | 首次实测发现并修复：(1) `apps/studio-shell/icons/` **目录完全不存在**，tauri-build 生成 Windows 资源文件时直接失败 → 已提交占位图标集（`icon.ico` 16/32/48/256、`icon.png` 512、32/128/128@2x，**占位非品牌，待替换**）；(2) **两处真实 Rust 编译错误** `E0716 temporary value dropped while borrowed`，`apps/studio-shell/src/main.rs:178` 与 `:269`（`app.state::<Backend>().0.lock()` 借用了语句结束即释放的临时 `State`）→ 改为先 `let` 绑定 / 独立作用域；(3) `package.metadata does not exist` 经查**不是错误**，是 `tauri-winres-0.3.6/src/helpers.rs:33` 的 `println!` 诊断，无需修。修复后 `cargo check --manifest-path apps/studio-shell/Cargo.toml` **exit 0**。**唯一剩余前置**：`tauri.conf.json` 的 `bundle.resources` 要求 `MinecraftMultiAgentStudioBackend.exe` 在**编译期**存在（精确路径 → `resource path ... doesn't exist`；glob → `glob pattern ... didn't match any files`），而该文件仅在 Windows 由 `pnpm build:exe` 产出、且 `src/main.rs:203-209` 运行时会从 shell 同级目录加载它（故不能从配置删除）⇒ Linux runner 上结构性无法执行 `cargo check`。已由 `scripts/check-studio-shell.mjs` 条件执行：资源在则跑真实检查，缺失则打印醒目 SKIPPED，**不伪造通过**。 |

---

## 当前总体判定（P0 固化）

- **G0 = FAIL**（L7 FAILED；60min soak PARTIAL）
- **G1 = NOT_STARTED**
- **External preflight = BLOCKED_INCOMPATIBLE_MOD_LOADER**（simpfun）

**Production Classification = NOT READY**。最近一次达成级别：无（L1-L8 从未全绿）。

---

> 以下为 2026-09-11 修订区（对照 HEAD `5fc643f` 重新核实的行）。

## 变更日志

- 2026-09-03 建立；从 PRODUCTION_GAP_ANALYSIS.md + git 全史（ff7b900…19da988）+
  本日实测恢复全部原始项。
- 2026-09-11 陈旧性修订：补入快照警告横幅；对照 HEAD `5fc643f` 重核 D3-5/D3-7/D4-1..6/
  D5-1..6/D6-1..8/D7-1..9/FLUID-PLACE/FARM-TILL/SCHEMATIC 共 9 行（原快照冻结于 19da988，
  落后约 40 次提交），按"代码接线 + 单测已有、真实 Minecraft E2E 证据缺失"如实记为
  `IMPLEMENTED / UNVERIFIED` / `PARTIAL` / `IMPLEMENTED / UNWIRED`，未升级为 `DONE`。
- 2026-09-11 新增 F-8（`apps/studio-shell` 编译完整性）：该组件此前不被任何 CI 工作流或根
  pnpm 门禁覆盖。本次首次实测，修复两处真实 Rust 编译错误（`main.rs:178`/`:269` E0716）并补齐
  缺失的图标集；同时澄清 `package.metadata does not exist` 是 tauri-winres 的诊断输出而非错误。
  剩余前置（Windows 专属 bundle 资源在编译期被强制要求）已在 `task-infrastructure-integration.yml`
  的门禁步骤注释中完整定性。

# 独立可靠性修复交付记录

日期：2026-09-05。代码检查点：`4e17b4374acd74d391143eaef7f14a0d2418db42`。本轮完成 CI、施工日志恢复、基地阶段事实和工位租约修复，并交付 [Baritone 能力研究、ADR 与后续切片](BARITONE_CAPABILITY_REVIEW_2026-09-05.md)。没有接入 Baritone 或改变 P5 阶段门。

## 工作区与阶段事实

原仓库为 `C:\Users\renna\.zcode\workspace\default\minecraft-multi-agent-studio`；原 `main`、`origin/main` 与本次远端审查快照均为 `75cab9008985995408aa45503919416591dfd3e6`，原工作区无未提交修改。历史 `stash@{0}: On main: post-model-gates-paused-20260903` 保留，未恢复或删除。

修改全部位于独立 worktree `C:\Users\renna\Documents\Codex\2026-09-05\files-pasted-by-the-user-minecraft\work\studio`，分支 `fix/independent-reliability-20260905`。未热改原工作区，未切换原 main，未 push。检查时未识别到该仓库运行中的 Studio/Bot；现有无关 Node/Codex 进程未操作。本轮只运行本地测试及其回环 HTTP/子进程夹具。

| 类别 | 核验事实 | 本轮处理 |
|---|---|---|
| 已完成 | 用户明确 P5-D2 完成；当前 main 包含 D2 同步、ACK、背压及有界提取测试 | 保留原实现和原门禁；实际执行 Rust/worker 契约 |
| 计划内未实施 | P5-D3 未实施；WorldMirror 尚未替换所有 snapshot/findBlocks 调用 | 不作为 D2 缺陷，不在本轮替换 |
| 当前可复现缺陷 | CI 内部读取次数 8/12 断言失效；ESM 日志读取失败；随机恢复目录；布尔阶段不能撤销；过期和旧任务租约可干扰新持有者 | 已在本地修复并测试 |
| 历史报告仍属当前远端事实 | 两条 main Actions 在 `75cab90` 失败 | 2026-09-05 再查仍失败；本地补丁未推送，不能报远端绿灯 |
| 不是失败证据 | 同次 real-postgres-redis job 通过 | 保留该历史结果；不声称本轮重新执行了数据库服务测试 |
| 未取得的材料 | 未找到独立 D3 原始实施提示词和完成门 | 已读真正的 P5-A..H 路线与 D2 提示词；不猜 D3，不扩大其门禁 |

原路线将共享 WorldMirror/避免全体素复制/corridor 失效安排在 P5-E，worker 生命周期在 P5-F，真实 comparator/闭环在 P5-G，1/5/10 AB 在 P5-H。研究切片只记录这些依赖。本轮不是新的 D3，也不作为 D3 的额外前置条件。

## 四组修复

### 1. CI：从调用次数改为行为契约

根因是测试绑定 `plannerRegistryGet` 的内部读取次数。新增读取承担派发身份及新鲜度检查；基线在 `apps/control-api/tests/goal-execution.integration.test.ts` 重现预期 8、实际 12，类型检查与构建本身通过。

修复测试验证第一次 Runtime 拒绝未进入副作用处理器、重新观测发生在重试前、成功副作用恰好一次，以及派发/结果 invocation、task、Runtime 身份一致。没有简单把 8 改成 12，也没有删去非幂等保护。

`.github/workflows/ci.yml` 与 `task-infrastructure-integration.yml` 增加 Rust 格式/测试及 native addon 构建，之后运行完整 `pnpm check`。`scripts/build-pathfinder-rs.mjs` 使用 `cargo build --release --locked`，按 Windows/Linux/macOS 选择产物；Windows 的 MinGW 路径由 `PATHFINDER_RS_MINGW_BIN` 配置。

### 2. 施工日志：固定身份、持久恢复、世界核对

`apps/coordinator/src/plan-journal.ts` 改用 ESM fs import，新增 `schemaVersion=1.1`、revision、Zod 校验和显式读写错误。`main.ts` 使用稳定 `runtime-data/plan-journals` 或 `STUDIO_PLAN_JOURNAL_DIR`，运行实例 ID 不再作为唯一恢复目录。

`build-journal.ts` 为现有 journal 增加施工语义，`local-planner.ts` 将它接入模型单 Skill 与确定性蓝图直派共用入口；`autonomous-director.ts` 从共享基地成员关系和 journal 找回工程，不再由生产路径的 botId 内存表独立决定锚点。

- 工程身份为服务器、维度、baseId、blueprintId、规范化单元内容 SHA-256 与固定 anchor，生成稳定 buildId；保存蓝图、nextIndex、验证证据、revision、更新时间及运行身份。
- 派发前落盘实际 task/invocation/attempt 与 Coordinator claim。仅已派发或结果未知时保留执行身份；同 Runtime 再派或另一 Bot 接管被拒绝。已知同 Bot 的替换 Runtime 可以恢复，但仍先核对世界。
- `packages/skills/src/planning/blueprint-planner.ts` 增加 reconcile/inspectOnly；Runtime 的 `blueprint.inspect` 逐格读实际加载方块及指定属性，每 32 格让出事件循环，最多使用既有 512 单元蓝图上限。
- 已确认且未变化的单元跳过放置；未加载/超时保持未知。完整工程完成要求最终整份单元验证，不能从本批请求成功推导。
- 已验证工程先只读检查；损坏可记录 DAMAGED，随后仍在同锚点修复。蓝图内容或锚点改变要求显式核对，不能混合旧进度。
- 取消与 timed_out 不能证明 adapter 已停，保留未知执行者；只有 completed、预处理拒绝或已知已返回的蓝图验证失败清除该身份。其他失败保持保守，避免超时后并发重放。

必要测试使用真实构建后的 Node ESM：进程 A 写 journal/基地快照并退出，进程 B 读取相同工程；模拟世界中已完成单元不重复放置。另覆盖结果丢失、历史目录重复/冲突、版本改变、坏文件、目录不可读和写入失败。这里的方块世界是明确的文件/函数夹具，不是 Minecraft 联机。

### 3. 基地阶段：历史与当前可用性分开

`packages/skills/src/base-registry.ts` 保存成员关系和 phaseFacts，每条事实含 `availability`、`everCompleted`、证据、验证器和 observedAt。当前状态支持 UNVERIFIED/AVAILABLE/DAMAGED/RECOVERING；默认 60 秒后事实视图变为 UNVERIFIED，历史完成保留。选址预约是身份事实，不按设施可用性 TTL 过期。

`base-phase-state.ts` 的外部 false 可以推翻旧 true，`forcePhase(false)` 撤销当前值。生产 Director 的布尔读取由共享 BaseRegistry 推导；未注入依赖的旧测试/API 保留进程内兼容路径。换服、维度或 Runtime 会话变化后重新核验对应事实域。

`main.ts` 给 Planner、Director、SharedStateServer 注入同一 BaseRegistry/FacilityRegistry/WorkstationRegistry，并通过正式 `DurableStateStore` 保存。重启将世界可用性标为未验证；成员 Bot 查询同一 baseId 和同一 journal 进度。BaseRecord 的旧 status/placedCells 是结构生命周期资料，自治当前可用性以 phaseFacts 为准；本轮工程单元进度以 build journal 为准。

主体建筑验收可以更新 STARTER_BASE_ACTIVE。农田/刷石建筑完成仅代表结构完成，不伪造产出能力；自治避免对已验证的同一结构重复施工，但食品、刷石净产出、村民运输、村庄验证、交易所补货等领域验证器仍未接通，不报告 AVAILABLE。

测试覆盖 false 撤销、跨进程持久恢复、损坏/未知/修复、事实过期、A/B 服及维度隔离、成员共享身份和恢复同一工程。损坏测试采用确定性世界夹具，不宣称已在游戏中拆除建筑验证。

### 4. 工位租约：同一权威、全路径执行保护

`workstation-registry.ts` 的独占 lease 具有独立 UUID、递增 generation 与 bot/runtime/task/attempt 身份；renew/release/commit 比对同一份 proof。过期不能续租，同 Bot 的旧 Runtime/attempt 不能续期、释放或提交新租约。共享工作台不强制独占；活跃租约不因容量淘汰或快照导入被覆盖。

`shared-state.ts` 复用现有 RPC，增加 1.0 envelope、UUID operationId、30 秒有效窗口、最多 2048 项去重缓存和响应身份校验。重复相同请求返回原响应，复用 ID 改内容拒绝，超限背压；客户端默认 5 秒超时。HTTP 不接受旧的无版本请求。跨进程写入必须具备完整 owner/proof。低层进程内旧 claim 可生成唯一 legacy-unbound 租约，仍不能无 proof 续期或释放；它只为旧调用兼容，生产熔炉/箱子路径提供完整身份。

`apps/bot-runtime/src/workstation-lease.ts` 使用 30 秒 TTL、5 秒续租周期，另有独立到期计时器处理续租一直不返回；每次资源副作用前调用权威 commit。等待、移动、操作期间持有租约；失联、取消、到期或续租失败后中止新副作用，关窗，并在处理器退出后的 finally 使用 proof 释放。定时器仅管理资源身份，动作仍由现有 ActionLock/MovementController/L0 控制。

`mineflayer-client.ts` 将显式熔炉坐标、Runtime 自动寻找/创建、Coordinator 候选及确定性计划全部汇入此约束。Coordinator 只提供候选，不预占后再让 Runtime 自行使用。busy 保持竞争语义；已加载且明确错误的方块才失效，观测未知不当作不存在。容器转移同样独占；现代双箱按朝向/左右半箱得到唯一 key，旧版无 type 属性时核对四邻域，缺观测或歧义则等待。

验证覆盖 45 秒虚拟长任务和 40 秒熔炼、竞争 Bot、旧 attempt/Runtime 的迟到操作、挂起及失败续租、取消、显式/自动入口和四朝向/密集摆放/旧版双箱。HTTP 集成测试另启动独立 Node 子进程 claim，验证确实通过跨进程同一权威。

## 权威、配置与迁移

| 数据 | 本轮权威与恢复规则 |
|---|---|
| Task 生命周期及 Coordinator claim | 继续使用原 TaskExecutionStore/PostgreSQL；显式 desktop memory 模式保持原约束 |
| 建筑执行进度与未知副作用 | 单 Coordinator 的稳定目录 FilePlanJournalStore；buildId/revision 仲裁；恢复前世界核对 |
| 基地成员/阶段证据、设施和工位观测 | 单 Coordinator 共享注册表，既有 DurableStateStore 文件模式保存；未另建 PostgreSQL 基地写入者 |
| 瞬时工位/设施/单元预约 | 活跃注册表；快照剥离 lease 和 reservation，重启后旧 proof 失效 |
| 世界同步和实际动作 | 原 WorldSyncAdapter/WorldMirror、Mineflayer/ActionLock/MovementController/L0；没有第二世界镜像或动作控制循环 |

默认启动现有共享状态 HTTP 服务于 `127.0.0.1:8791`，Runtime 默认连接此地址。修改端口须同时传递 `STUDIO_SHARED_STATE_PORT`，跨进程/跨机可使用 `STUDIO_SHARED_STATE_URL`；服务监听由 `STUDIO_SHARED_STATE_HOST` 指定，现有 `STUDIO_SHARED_STATE_TOKEN` 用于 Bearer 认证。默认回环服务不启动 Minecraft；NORMAL 的服务器启动纪律未改变。独立运行 Runtime 而未启动该权威时，独占操作明确不可用。旧 Coordinator/新 Runtime 混版不支持，应作为提交序列一起集成并重启服务。

基地文件为 `STUDIO_SHARED_STATE_PERSIST_PATH` 或 `runtime-data/shared-state.json`。文件/日志路径相对于 Coordinator 工作目录，因此部署应配置稳定的绝对路径。生产 PostgreSQL 若未来接管这些基地资料，需要单独迁移和切换权威；本轮沿用仓库现有桌面文件抽象，不声称已实现 PostgreSQL 基地持久化。文件模式只支持单写入者，不是多 Coordinator 的数据库事务或分布式互斥。

历史迁移处理：

1. 首次 load 扫描稳定根目录及一层 `coordinator-*` 旧实例目录；每目录最多 2048 项、累计最多 4096 项，单 journal 最大 2 MiB。后续 load 使用进程缓存，不在 Tick 重新扫描磁盘。批次步骤最多 2048；达到限额明确要求维护，不无限扩张。
2. 按 planId 检查完整工程身份，兼容副本选择更高 revision；同 revision 内容不同或身份冲突阻止恢复。旧原件不删除，后续保存写入稳定根目录。
3. 旧 schema 1.0/无版本的非 build 日志可规范化；旧 build 日志若缺少蓝图和工程身份，报 LEGACY_BUILD_IDENTITY_INCOMPLETE。不能凭旧中文标题补猜服务器/蓝图/锚点。需要保留原件，人工确认原身份、蓝图和实际世界后制定迁移记录。
4. JSON 损坏、权限/读取失败和写盘失败分别可见；只有不存在的根目录/文件代表首启。错误不会退化为空工程并从新锚点开工。修复磁盘资料后重启单写入者，重新建立索引；不支持热加载外部修改。
5. 已派发但旧执行是否停稳未知时，保留记录并停止自动重放。同 Bot 的受控 Runtime 替换允许重新观测续建；跨 Bot 未知执行接管与通用停稳确认协议留待后续，不能通过清日志解除保护。

原子临时文件替换没有 fsync 文件及目录，也没有文件/数据库联合提交。本轮验证的是进程边界与逻辑恢复，没有模拟强制断电、磁盘控制器缓存丢失或跨文件原子性。两份文件之间失败时，启动的未验证状态和 journal 世界核对用于保守恢复。文件过限/冲突需要运维处理；现有 retain 只计算候选数量，不声称已自动清理历史。

## 验证结果与限制

基线先运行 typecheck/build/test/cargo；TypeScript 类型与构建通过，测试复现目标次数断言，Rust 48 项通过。最终代码 `4e17b43` 的完整 `corepack pnpm check` 退出码为 0：2,605 项 Vitest 通过、38 项按原环境开关跳过，另有 40 项 Node 进程/管理器测试通过；类型检查与全体构建通过。最终相关套件为 skills 891、Coordinator 447 + 4 个 ESM 进程测试、Runtime 432 + 2 个 Supervisor 进程测试；Runtime 4 个真实 Minecraft 测试按原显式开关跳过。测试时只有研究/修复文档尚未提交，因此生成 manifest 的 dirty=true；代码与 `4e17b43` 一致。日志摘要随交付 `VERIFICATION.md` 保存。

| 命令（隔离 worktree） | 实际结果/覆盖 |
|---|---|
| `corepack pnpm check` | 最终代码 `4e17b43` 类型检查、全部默认测试、全部构建通过，退出码 0 |
| `corepack pnpm --filter @minecraft-studio/coordinator test` | 447 Vitest + 4 ESM 跨进程测试通过，包含构建 |
| `corepack pnpm --filter @minecraft-studio/bot-runtime test` | 432 Vitest 通过、4 联机项跳过；构建 + 2 Supervisor 进程测试通过 |
| `cargo fmt --manifest-path packages/pathfinder-rs/Cargo.toml -- --check` | 通过 |
| `cargo test --manifest-path packages/pathfinder-rs/Cargo.toml --locked` | 48 通过（11 + 24 + 13），无 Rust 源码改动 |
| `node scripts/build-pathfinder-rs.mjs` | 实际构建 native addon；Runtime worker/WorldMirror 跨语言测试不是纯 TS 替身 |
| `git diff --check` | 通过 |

Windows 验证使用 Node 22+、Corepack/pnpm 11.9.0 和已有 Rust GNU 工具链，MinGW bin 加入 PATH。Runtime 的 world-sync-adapter/stress 契约实际运行 worker/native addon、Prismarine 1.21.11 区块 fixture、buffer transfer 与 ACK/背压。全套默认测试中的 PostgreSQL/Redis 真实服务项目按原环境开关跳过，详见验证摘要；没有把跳过项算作通过。

未执行：本轮 PostgreSQL/Redis 服务集成重跑、隔离 Minecraft 联机、外部服务器、Java 客户端/Baritone 执行、1/5/10 客户端资源对比、Spark/模型部署、断电恢复。原因分别为本轮未启动对应显式基础设施/客户端、无外部连接或部署授权，以及不属于本轮进程恢复验证范围。没有虚构成功率、内存、延迟或净产出数据。

仍需明确的边界：租约 commit 是动作发出前的客户端检查，Minecraft 服务端不验证 lease proof；已提交动作可能在租约丢失后才返回。取消不能撤销已经提交的包。此轮保证失租后不再启动新的受保护副作用，并保留未知结果；没有宣称服务端 exactly-once 或即时停稳。共享状态服务重启清空 ephemeral 租约，旧 proof 不可再 commit/renew，仍须在每个副作用前检查。

本轮不包含农田/村民/交易所验证器，复杂属性的通用放置策略、蓝图最优顺序与材料工作集也未补全；只对蓝图请求明确携带的必要属性进行读回。默认一位 Bot 对应每个服务器/维度下一个活动基地成员选择，成员管理 API 已有，自动基地分组策略不在此轮。跨 Coordinator HA 和旧未知执行的跨 Bot 自动移交尚未实现。

GitHub 与本地分别汇报：最新 [CI 33931316906](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/33931316906) 与 [P1.3 33931316819](https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio/actions/runs/33931316819) 仍为 `75cab90` 的 failure；本轮未 push，因此没有补丁的 GitHub Actions 结果。

## 提交与下一步

提交按顺序依赖，建议整体审查后集成；中间提交不是混版运行的发布单元。

| 本地提交 | 对应修复 |
|---|---|
| `58dfb16` | CI 行为断言、Rust/native CI 构建与跨平台脚本 |
| `0d774f9` | skills 的阶段事实、持久化校验、租约/RPC proof、蓝图核对契约 |
| `78dffea` | Runtime 的持续租约、熔炉/容器全入口保护与方块核对 |
| `4e17b43` | Coordinator 稳定 journal、真实恢复派发、共享基地事实和测试 |
| 随后的 docs 提交 | 本修复报告、Baritone 官方源码研究/能力映射/ADR/可测量切片；最终 hash 列在交付 VERIFICATION.md |

唯一推荐的后续能力模块是“蓝图差异工作集与可执行工作面”。保持 Mineflayer + 当前 Rust，吸收 Baritone BuilderProcess 的差异维护、可放置面与缺料暂停机制，沿用本轮固定身份、租约及世界核对。具体基线、五类场景、至少 20 次/组、成功率/净产出/完成时间/重复副作用/取消停稳/P95-P99/内存指标与回退条件见研究文档。它是后续独立切片，不替代或跳过原 P5-D3。

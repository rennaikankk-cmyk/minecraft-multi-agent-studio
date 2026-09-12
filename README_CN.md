# Minecraft Multi-Agent Studio

**产品定位：Anarchy-First / 无规则服务器优先**——面向无规则（anarchy）服务器上与外挂玩家对抗的多智能体作战集群（见 [docs/anarchy-charter.md](./docs/anarchy-charter.md)）。默认 Gameplay Profile 为 `anarchy_first`（未知玩家=敌对、主动战斗、财产/资源自由交互）；和平/保守行为仅作 standard 对照 profile 存在。以下为平台工程能力清单：

当前已完成项目基线、真实环境检测、版本化 Bot 状态协议、单 Bot 隔离联机验收、Bot Process Supervisor、Minecraft 版本自适应、多版本 Skill 可用性解析、Runtime ↔ Coordinator 认证链路、Control API/Dashboard 四进程服务链路、确定性 L0 安全层、受限 Pathfinder 技能，以及 P1.3 任务持久化基础：

- 自动检测当前 CPU、内存、操作系统和 GPU 探测状态。
- 检测 Node.js、Java、Docker 和 Git 是否可用。
- 识别标准、Docker、便携和网吧运行模式。
- 通过真实 API 在响应式前端展示检测结果；Dashboard 页面可见期间每 5 秒只重新读取其服务端主机或容器的 `os.totalmem()` / `os.freemem()`，不重跑软件/GPU 探测，也不持久化历史。
- Dashboard 服务端代理与 Control API 契约已完成，可显示经过校验的在线、离线、失联和后端不可用状态。
- 定义并测试 Bot 状态、心跳、断线和安全停止协议 v1。
- 实现受控的 Mineflayer Runtime：Dashboard 创建的真实服 Bot 最多 16 个，隔离服验收固定两个 Bot。
- 新增增量 Bot Process Supervisor，可配置一至三个 Bot 共用一个子进程；正式、灰度、测试和批处理按部署等级隔离故障域，旧单 Bot 启动入口继续可用。
- Supervisor 使用双向 HMAC 的版本化 Node IPC、固定子入口、有界队列、Profile SHA-256 复验、优雅停止和有限崩溃退避；认证后的子进程 PID 可注册到 CPU Resource Manager。
- CPU Resource Manager 能可靠探测时建立 P/E Pool，无法可靠识别时使用普通核心回退；affinity 和动态 scheduler 仍默认关闭。
- 已在仅绑定本机回环地址的 Minecraft 1.21.8 服务端验证连接、停止、断线和有限重连。
- Coordinator 使用真实遥测维护在线、失联和离线状态，并拒绝重复、乱序及旧进程心跳。
- Bot Runtime 与独立 Coordinator 通过双向 HMAC 认证的本机 WebSocket 传输遥测、回执、停止命令和真实停止结果。
- 安全停止要求可信授权、幂等命令 ID、审计、超时和 Runtime 确认结果。
- Control API 已提供认证列表、详情、WebSocket 状态流和受权优雅停止入口；生产入口通过双向 HMAC 的本机 Control Link 获取 Coordinator 原子状态快照并转发停止请求，链路未就绪或断开时返回 `503 CONTROL_UNAVAILABLE`。
- 安全停止要求弹窗二次确认、本地确认码、`bot.stop` 权限和 Runtime 真实确认结果。
- Bot 可对批准的隔离服务器自动探测 Minecraft 版本，并上报真实版本、协议号、主版本和兼容状态。
- Runtime 按当前连接实际暴露的 feature、物品、方块、实体和经批准的服务端能力探针解析 Skill 变体；通用 Skill 不会因为服务器版本不同被一刀切禁用，新版本特色 Skill 只在依赖能力真实存在时可用。
- Runtime Link 双进程链路和 Dashboard → Control API → Coordinator → Bot Runtime 四进程服务链路均可用同一追踪编号核对结构化日志；四进程验收使用测试专用 Runtime fixture，不连接 Minecraft，也不替代浏览器 E2E。
- L0 安全层从真实 Mineflayer 状态识别饥饿、低/危急生命值、溺水、岩浆、坠落、卡死和背包满，并执行固定白名单动作。
- `movement.goto@1.0.0` 通过受限 Pathfinder 适配器移动，不允许挖掘、搭塔、垫方块或跑酷。
- 任务系统提供 PostgreSQL 迁移、严格状态机、幂等键、乐观修订号、租约边界、事务 outbox、自动对账/过期租约恢复、持久取消、严格派发协议和 BullMQ Worker。
- Coordinator 已实现多 Bot 协调切片：按 ServerProfile、维度、L0 安全状态、Skill 能力和当前任务占用做确定性候选评分；队列任务通过 `DurableBotAssignmentService` 将 Bot 选择、PostgreSQL task lease、revision 和 `TaskDispatchV1` outbox 在同一事务绑定，重启后可从任务表/outbox恢复；同一 Bot 的活动任务竞争由 PostgreSQL advisory lock + 行查询 fail-closed。Control Link 的持久 goal lifecycle 现在使用同步 durable assignment（记录 `dispatchBotId`、Bot lease 和 revision，但不生成没有生产 handler 的队列 job），并把受信 lease owner 传给 Local Planner，避免重复的内存 assignment；Coordinator 启动后会运行有界过期租约恢复循环。显式设置 `COORDINATOR_TASK_DELIVERY=isolated-test` 后，Coordinator 会独占启动 `BullMqTaskQueue` 与 `TaskOutboxReconciler`，关闭时先停止接单再排空投递。
- `apps/task-worker` 提供独立 Node 进程验收入口；当前只接受显式隔离测试配置，注册 `isolated.acceptance.wait@1.0.0`（取消边界）和无网络的 `isolated.acceptance.digest@1.0.0`（严格输入、幂等、结构化结果）。这两个处理器只用于隔离控制面验收，不连接 Minecraft、AI 或正式服务器。
- 隔离 PostgreSQL/Redis 集成测试已于 2026-07-28 在 GitHub Actions 真实临时服务中通过；本机没有运行这些服务时不会冒充本机服务在线。

当前项目具备单 Bot 安全执行、可选多 Bot 进程托管和任务基础设施，但不是已经完成的多智能体产品。Supervisor 已通过不连接 Minecraft 的真实子进程认证、分组、优雅停止和崩溃恢复验收；真实 1/5/10/20 Bot 联机与 P/E Core 实体机性能门禁仍未完成。Runtime ↔ Coordinator 已通过双进程验收，Dashboard → Control API → Coordinator → Runtime 已通过不连接 Minecraft 的四进程服务级验收。Control Link 不可用时不会沿用旧快照：Control API 返回 503，Dashboard 清空 Bot 列表并明确显示错误。

启动器不会创建模拟 Bot。已保存的 Dashboard Bot 会在启动时恢复；显式设置
`BOT_SERVER_PROFILE_PATH` 时也会启动该 Profile 对应的单 Bot Runtime。Spark 只在实际
发现或配置可用时接入，不会用模拟状态代替不可用服务。

## 环境要求

- Node.js 22 或更高版本
- pnpm 11.9.0

## 安装

```powershell
pnpm install --frozen-lockfile
```

首次生成锁文件的开发环境使用：

```powershell
pnpm install
```

## 启动

```powershell
pnpm start
```

该命令先构建工作区，再通过 `scripts/start-studio.mjs` 自动接线并启动本机
Coordinator、Control API 和 Dashboard。浏览器打开 `http://127.0.0.1:3000`。
`pnpm dev` 只启动 Dashboard 开发服务器，不代表控制链路已连接。

## 检查

```powershell
pnpm check
```

`pnpm check` 依次运行类型检查、离线测试和生产构建，不会启动 Minecraft 或外部基础设施。

生产服务启动后可运行冒烟测试：

```powershell
$env:STUDIO_SMOKE_BASE_URL="http://127.0.0.1:3000"
pnpm smoke
```

## 运行模式

在 `.env` 中设置：

```dotenv
STUDIO_MODE=standard
STUDIO_MAX_BOTS=16
```

可选值：`standard`、`docker`、`portable`、`netcafe`。

`STUDIO_MAX_BOTS` 控制桌面启动器为真实 Minecraft 服务器暴露的 Bot 槽位，允许值为 1-16，默认值为 16；内存较小时可调小。隔离服真实验收固定只启动两个 Bot，即使启动器上限仍为 16。

当前模块完成模式识别。Docker 镜像、便携数据迁移，以及网吧模式的 API 训练、成果导出、断点恢复和安全清理将在后续独立模块实现。

## 连接真实 Minecraft 服务器

启动 `pnpm start` 后打开 Dashboard 的 Bot 页面，填写服务器地址、端口和版本即可创建
真实服 Bot。Manager 会按 `STUDIO_MAX_BOTS` 分配 `studio-bot-01` 到
`studio-bot-16` 的独立槽位；状态页显示当前已创建数量、Runtime 进程状态和真实遥测连接状态。
每个 Bot 使用独立的 Runtime Link 身份和 Profile，重启 Studio 后会恢复已保存的 Bot。

Manager 创建的真实服 Bot 支持 Minecraft 离线认证（`auth: "offline"`）和正版在线认证
（`auth: "online"`），公网地址只在 `purpose: "anarchy"` 时开放。离线模式不需要
Mojang/Microsoft 账号，也不会读取或持久化密码。Dashboard 创建的 Bot 和手工 Profile
走同一条 Runtime 路径，支持 `connectHost` 覆盖 TCP 目的地址，同时保留 `host`
作为握手域名。选择在线认证时，Runtime 从 `STUDIO_BOT_EMAIL_<BOT_ID>` 和
`STUDIO_BOT_PASSWORD_<BOT_ID>` 读取 Microsoft 账号邮箱/密码，只放在进程内存中；Profile
中的 `username` 仍是 Bot 的游戏身份。缺少任一凭据会拒绝启动，不会静默切换为离线。

## 自主生存（Autonomous Survival）

Coordinator 内置一个确定性自主生存层，对每个空闲且 L0 无风险的 Bot 持续运转：

- **Needs/Utility 评估**（`survival-needs.ts`）：每次从真实遥测（血量/饥饿/背包/护甲）
  重新打分。需求曲线包括食物安全（饿着肚子时急剧升权）、工具阶梯（木→石→铁→钻石镐）、
  木/煤/铁储备、武器、护甲（先穿后补）、盾牌、避难所、钻石推进、火把与箱子。
  同分按固定优先级裁决，无随机。受伤时避难所优先级越过工具——徒手挖土就能躲。
- **确定性目标派发**（`deterministic-goals.ts`）：自主层下发的全部目标模板（采集/移动/
  扫描/觅食/挖避难所/穿甲）在进入模型分支**之前**被确定性解析，基础生存链 0 次模型调用。
  未配置 Local AI 时 planner 以"诚实拒绝"的桩运转，自主生存不依赖 Spark（AGENTS.md §0.4）。
  含自由文本仍走模型分支，输出仍受 schema + grounding 双重约束。
- **失败恢复**：采集类目标失败后有界恢复梯（扫描→接近→重试→扇区探索），同一需求连续
  失败 3 次进入 120 秒抑制窗口，避免原地打转；恢复子派发使用独立任务号。
- **食物闭环**：`food.secure` 技能复用 L0 觅食机器（掉落物→成熟作物→被动生物→短探索）
  把安全食物补到储备水位；L0 仍在饥饿时反应式进食，两层互补。
- **死亡恢复**：死亡时取消全部进行中技能、重置 L0、自动写重生包；重生后空背包自然
  重新推导出基础需求，不需要特判分支。
- **背包满自愈**：L0 对 INVENTORY_FULL 先做白名单丢垃圾（阈值表结构上不可能丢工具/
  食物/矿），无垃圾可丢才维持暂停。
- **可观测性**：任务标题携带原因（如"wood reserve 3 < minimum 16"），
  `coordinator_autonomous_need_selected` 等结构化日志记录每次选择与结果，
  `planner_deterministic_decisions_total` 度量确定性派发占比。

已知边界：采集接近路径刻意不允许沿途挖掘（反作弊立场 + Codex 实测的安全移动
常量）；深矿/复杂地形的采集吞吐依赖扇区探索与楼梯回退。

## 本地模型（Spark / Local AI Hub）的分工与并发预算

基础生存链 0 次模型调用（见上文确定性派发）。模型只做三类高价值工作：

1. **自由目标规划**（始终可用）：Dashboard 输入的自然语言目标走模型分支，
   输出仍受 schema + 确定性规划器双重约束。
2. **重规划神谕**（`replan-oracle.ts`）：同一需求连续 3 次失败被抑制时，
   咨询一次模型，从 4 个白名单策略（轮转扇区/拉远探索/延长搁置/替代资源）
   中选一个，参数受按需求白名单约束——模型劫持也无法产生菜单外的动作。
   模型不可用时静默回退确定性策略，自主生存不依赖它。
3. **多 Bot 战略**（规划中）：N Bot 场景下的分工/分区建议，同样走约束菜单。

连接 vLLM/OpenAI 兼容端点（DGX Spark）：

```dotenv
LOCAL_AI_ENABLED=1
LOCAL_AI_PROVIDER=vllm
LOCAL_AI_HUB_URL=http://<spark-host>:8000/v1
LOCAL_AI_MODEL=<model-name>
LOCAL_AI_API_KEY=<可选>
```

**并发预算**（16 路本地模型，qqbot 已占 4 路）：

```dotenv
AI_MAX_CONCURRENCY=12      # 留 4 路给 qqbot；默认值即 12
AI_PER_BOT_CONCURRENCY=1   # 每 Bot 同时至多 1 个在途请求（默认）
```

自主生存下模型请求天然稀疏（每 Bot 数分钟一次神谕 + 偶发自由目标），
12 路预算足以支撑 10+ Bot 同时运转；`perBotConcurrency=1` 保证单个 Bot
不会霸占队列。观察 `coordinator_ai_request` 日志的 `state` 字段可核对
实际占用，`planner_deterministic_decisions_total` 与
`bot_llm_requests_total` 之比即确定性占比。

## 启动隔离测试 Bot

复制示例配置：

```powershell
Copy-Item .\configs\servers\isolated-test.example.json .\configs\servers\isolated-test.local.json
```

确认配置指向你自己的 Minecraft Java 隔离测试服，并先按下文“验证 Runtime Link”配置和启动 Coordinator。然后在 Runtime 窗口设置同一 Bot 的链路身份与明文共享密钥：

```powershell
$env:BOT_SERVER_PROFILE_PATH="$PWD\configs\servers\isolated-test.local.json"
$env:BOT_RUNTIME_LINK_URL='ws://127.0.0.1:3220/v1/runtime-link'
$env:BOT_RUNTIME_LINK_KEY_ID='runtime-key-01'
$env:BOT_RUNTIME_LINK_SECRET='<只存在于当前进程的明文共享密钥>'
pnpm bot:start
```

安全限制：

- 真实服离线认证必须在服务器端启用离线模式（常见配置为 `online-mode=false`）；正版
  在线模式服务器会拒绝离线会话，这是服务端认证策略，Runtime 不会绕过。
- anarchy Profile 可以使用公网裸域名/IP；普通 managed Profile 仍限制在本机或私有局域网。
- Profile 不接受密码字段。`auth: "offline"` 不会触发 Microsoft 登录，`auth: "online"`
  缺少凭据时也不会静默切换为离线。
- 没有设置 `BOT_SERVER_PROFILE_PATH` 时不会尝试连接。
- Runtime ↔ Coordinator 与 Control API ↔ Coordinator 都已接入真实回环跨进程传输，并通过不连接 Minecraft 的服务级四进程验收。

版本配置：

- 推荐使用 `"minecraftVersion": "auto"`，Mineflayer 只探测当前 ServerProfile 指向的已批准服务器。
- 也可填写固定版本，例如 `"1.21.8"`；固定版本必须在当前 Mineflayer 的测试清单中。
- 当前锁定的 Mineflayer 4.37.1 声明测试范围为 1.8.8 至 1.21.11，共 27 个测试版本。
- 自动协商成功但未列入测试清单时标记 `compatible-untested`，不会冒充“已测试”。
- 超出支持范围时标记 `unsupported` 并停止自动重连。

## 启动机器人进程监管器

旧 `pnpm bot:start` 始终保留为一 Bot 一进程的回滚入口。需要托管多个 Bot 时，复制并修改
`configs/bot-supervisor.example.json`，为每个 Bot 准备独立 ServerProfile、Runtime Link keyId
和只存在于环境变量中的明文共享密钥：

```powershell
Copy-Item .\configs\bot-supervisor.example.json .\configs\bot-supervisor.local.json
$env:BOT_SUPERVISOR_CONFIG_PATH="$PWD\configs\bot-supervisor.local.json"
$env:BOT_SUPERVISOR_PROFILE_ROOT="$PWD\configs"
$env:BOT_RUNTIME_PROCESS_MODE="process"
$env:BOT_RUNTIME_BOTS_PER_PROCESS="2"
$env:BOT_RUNTIME_AUTO_SIZE="false"
$env:BOT_RUNTIME_LINK_SECRET_STUDIO_BOT_01="<至少 32 字符的本机明文密钥>"
pnpm bot:supervisor
```

Supervisor 配置只记录密钥环境变量名，不记录明文。ServerProfile 必须使用相对于显式根目录的
路径，符号链接逃逸、身份不一致、文件变化、重复 Bot/keyId 和未知字段都会在连接 Minecraft 前
拒绝。`botsPerProcess` 只能为 1～3；`BOT_RUNTIME_AUTO_SIZE=true` 时按检测到的硬件建议选择
分组大小，但不会静默丢弃超过建议预算的 Bot。

不连接 Minecraft 的真实子进程验收与合成生命周期门禁：

```powershell
pnpm test:bot-supervisor
pnpm benchmark:bot-supervisor
```

在 DGX Spark 或其他计划长期使用的目标主机上，首次部署前运行完整第二阶段主机门禁：

```bash
pnpm validate:phase2-host
```

该命令生成当前主机的 `hardware-profile.json`，并执行完整检查、真实子进程验收及两个合成
Benchmark。DGX Spark 的 ARM64 双簇不会被猜测为 Intel P/E Core，而会走普通核心安全回退。

实现边界、配置说明、回滚方法和未完成项见
`docs/bot-process-supervisor-phase2-2026-08-17.md`。

多版本 Skill 策略：

- Skill 的 SemVer 是执行契约版本，不等于 Minecraft 版本。每个定义另带有序兼容变体；Runtime 使用连接后真实协商出的 `minecraftVersion`、`protocolVersion`、`majorVersion` 和 registry/feature 能力选择第一个满足条件的变体。
- 当前 39 个已注册 Skill 声明为 `portable` 通用变体，因此不会仅因版本号不同被禁用；“可用性”和“实机验证状态”分开上报，它们在跨版本真实场景矩阵完成前仍标记为 `unverified`。
- 新版本特色 Skill 应声明所需 feature、物品/方块/实体及必要的服务端能力。缺少资源时标记 `unavailable`；服务端能力尚未经过显式探针时标记 `unknown` 并拒绝执行，不按版本号猜测。
- 当前通用输入仍使用目标版本 registry 的原生名称，例如旧版本和新版本的原木 ID 可能不同。兼容层已经支持有序资源变体，但面向规划器的跨版本语义资源别名仍是下一模块。
- 回环协议夹具已验证 `minecraftVersion: "auto"` 能分别协商 1.8.8、1.12.2、1.16.5 和 1.21.11，并得到对应协议号；该测试不连接外部服务器，也不等于 39 个 Skill 已在四个版本真实执行。

## 真实联机验收

仓库不提交真实服务端、Java 运行时、世界存档或本地 ServerProfile。先运行准备命令：

```powershell
pnpm prepare:minecraft
```

该命令只从固定的 Mojang 官方地址取得 Minecraft 1.21.8 服务端并校验 SHA-1/SHA-256，生成 `127.0.0.1:25565`、离线认证、禁用 RCON/Query 的服务端属性和本地 ServerProfile。它不会下载 Java、启动服务端或替用户接受 EULA。请按 `docs/runbooks/isolated-minecraft.md` 放置并校验 Java 21，阅读 EULA 后手工将 `runtime-data/isolated-test/server/eula.txt` 改为 `eula=true`。

验收脚本只使用项目 `runtime-data` 中已准备的可信 Java、官方 Minecraft 1.21.8 服务端和本地配置。它不会自动接受 EULA；缺少文件、哈希不符、属性不安全或端口已占用时会停止。

准备完成并由用户明确接受 Minecraft EULA 后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-isolated-minecraft-test.ps1
```

脚本仅绑定 `127.0.0.1:25565`，验证两个真实 Bot、39 个内建技能各一个成功场景、正常停止、服务端断开和有限重连，完成后自动关闭本次启动的服务。只有实际运行通过才能登记证据；脚本或测试代码存在本身不会把技能从 `unverified` 升级。服务器文件、世界、日志和本地 ServerProfile 均不会提交到版本库。

## Coordinator 当前边界

- 注册表、停止命令缓存和审计记录当前保存在进程内存中，进程重启后 Bot 必须重新上报。
- Coordinator 与 Bot Runtime 的认证回环传输已经完成，并通过两个独立 Node 测试进程验收；Coordinator 进程组合生产 Runtime Link、注册表和停止控制器，Runtime 进程使用生产 `SingleBotRuntime` 与明确的测试专用内存 BotClient。
- Coordinator 与 Control API 的 Control Link 固定使用 `ws://127.0.0.1:3221/v1/control-link`（或显式 `[::1]`），双方先完成方向绑定的双向 HMAC，再传输严格 v1 消息。
- Control API 只有在收到 `snapshot-begin → snapshot-item* → snapshot-end` 完整快照后才原子替换可读状态；链路断开、协议/序列异常或 75 秒没有任何入站帧/ping 时会立即丢弃镜像、关闭状态流，并让列表、详情和停止返回 `503 CONTROL_UNAVAILABLE`。同一 Coordinator 实例短暂重连可重投原操作；Coordinator 实例变化时旧停止操作以身份变化失败，不会污染新链路。
- 停止 RPC 只接受固定契约：同一 UUID 绑定 `commandId/traceId/decisionId`、`graceful`、`dashboard_operator_confirmed`、5 秒宽限、15 秒超时和仅 `bot.stop` 权限；结果身份不匹配或超时都不能报告成功。
- Dashboard → Control API → Coordinator → Runtime 已通过真实回环四进程服务级验收；验收中的 Runtime 是测试专用 fixture，未连接 Minecraft，也不是浏览器 E2E。用户登录和持久化审计仍未接入。
- Dashboard 已提供真实服离线登录入口，最多 16 个 Bot；公网地址仅对 anarchy Profile 开放。

## 验证 Runtime Link

不启动 Minecraft 的双进程验收：

```powershell
pnpm test:runtime-link
```

该命令启动两个独立 Node 测试进程：Coordinator 进程组合生产 Runtime Link、注册表和停止控制器，Runtime 进程组合生产 Runtime Link 客户端、`SingleBotRuntime` 与测试专用内存 BotClient。业务遥测、停止命令和确认全部走真实 `127.0.0.1` WebSocket；IPC 只负责启动、收集结果和清理。该验收不启动生产 Coordinator `main`、Control API 或 Minecraft，也不会打开 Minecraft 端口。

手动启动生产 Coordinator 时，需要分别为 Runtime Link 和 Control Link 生成至少 32 字符的共享密钥及 SHA-256。Coordinator 只接收两个摘要，两个明文分别只交给目标 Runtime 和 Control API。摘要会直接参与 HMAC，泄露后同样可用于冒充，必须按明文密钥同等级保护：

Bot 遥测失联阈值由真正持有注册表的 Coordinator 配置：`COORDINATOR_BOT_STALE_AFTER_MS` 默认 `15000`，只接受 `1000`～`300000` 的整数毫秒值。Control API 不再暴露无效的同名旧配置。

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$secret = [Convert]::ToBase64String($bytes)
$sha = [Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($secret))
$secretHash = ($hashBytes | ForEach-Object { $_.ToString('x2') }) -join ''
$peers = @(@{ keyId = 'runtime-key-01'; botId = 'studio-bot-01'; secretSha256 = $secretHash })
$env:COORDINATOR_RUNTIME_LINK_PEERS_JSON = ConvertTo-Json -InputObject $peers -Compress

$controlBytes = New-Object byte[] 32
$rng.GetBytes($controlBytes)
$controlSecret = [Convert]::ToBase64String($controlBytes)
$controlHashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($controlSecret))
$controlSecretHash = ($controlHashBytes | ForEach-Object { $_.ToString('x2') }) -join ''
$clients = @(@{
  clientId = 'local-control-api'
  keyId = 'control-api-key-01'
  secretSha256 = $controlSecretHash
  capabilities = @('bot.read', 'bot.stop')
})
$env:COORDINATOR_CONTROL_LINK_CLIENTS_JSON = ConvertTo-Json -InputObject $clients -Depth 3 -Compress
pnpm coordinator:start
```

目标 Runtime 进程需要设置 `BOT_RUNTIME_LINK_URL`、`BOT_RUNTIME_LINK_KEY_ID` 和 `BOT_RUNTIME_LINK_SECRET`。把 `$controlSecret` 通过本机安全方式交给下一节的 Control API 进程环境，不要写入仓库或日志。只有同时提供经过校验的 `BOT_SERVER_PROFILE_PATH` 并显式运行 `pnpm bot:start` 才会尝试连接隔离 Minecraft 测试服；不要用于正式服务器。

## 启动 Control API

Control API 当前只允许监听本机。首先在 PowerShell 中生成一次随机令牌及其 SHA-256；明文令牌只交给客户端，不写进 `.env` 或代码：

```powershell
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$token = [Convert]::ToBase64String($bytes)
$sha = [Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
$tokenHash = ($hashBytes | ForEach-Object { $_.ToString('x2') }) -join ''
$token
```

仅把 `$tokenHash` 写入 Control API 认证配置，并提供与已运行 Coordinator 匹配的 Control Link 身份和明文共享密钥后启动：

```powershell
$principal = @(@{
  subject = 'local-dashboard'
  tokenSha256 = $tokenHash
  permissions = @('bot.read', 'bot.position.read', 'bot.stop')
})
$env:CONTROL_API_AUTH_JSON = ConvertTo-Json -InputObject $principal -Compress
$env:CONTROL_API_COORDINATOR_LINK_URL = 'ws://127.0.0.1:3221/v1/control-link'
$env:CONTROL_API_COORDINATOR_LINK_CLIENT_ID = 'local-control-api'
$env:CONTROL_API_COORDINATOR_LINK_KEY_ID = 'control-api-key-01'
$env:CONTROL_API_COORDINATOR_LINK_SECRET = '<从 Coordinator 配置步骤安全传递的至少 32 字符明文密钥>'
pnpm api:start
```

接口：

- `GET http://127.0.0.1:3210/v1/bots`
- `GET http://127.0.0.1:3210/v1/bots/{botId}`
- `POST http://127.0.0.1:3210/v1/bots/{botId}/stop`
- `WS ws://127.0.0.1:3210/v1/bots/stream`

HTTP 使用 `Authorization: Bearer <明文令牌>`。浏览器 WebSocket 使用子协议 `minecraft-studio.v1` 和 `auth.<明文令牌的 base64url>`。停止 POST 固定为优雅停止并要求 `bot.stop`。

生产 Control API 启动时必须先通过 Control Link 双向 HMAC，并完整接收 Coordinator 原子快照；首个快照未完成时不开放 HTTP 服务。运行中链路断开或快照/增量序列无效时，内存镜像立即失效，读取和停止返回 `503 CONTROL_UNAVAILABLE`，不会创建模拟 Bot、沿用旧在线状态或伪造停止成功。

## 验证四进程控制链路

不启动 Minecraft 的服务级四进程验收：

```powershell
pnpm test:four-process
```

该命令使用生产 Coordinator、Control API 和 Dashboard 独立服务进程，以及测试专用 Runtime fixture，通过真实 `127.0.0.1` Runtime Link、Control Link 和 HTTP 路径验证 `空快照 → online → stop completed → offline`、单次关闭、固定 `traceId` 跨四进程关联和输出凭据扫描。该验收已在 2026-08-07 由两个独立执行者各成功运行一次；两次均为退出码 0、`minecraftConnected=false` 且无残留进程。它是服务级验收，不是浏览器 Playwright E2E，也不代表真实 Minecraft 联机或正式服务器权限。

## 接入 Dashboard 真实 Bot 状态

保持 Control API 运行，在另一个 PowerShell 窗口把上一步生成的明文 `$token` 只写入 Dashboard 服务端环境变量：

```powershell
$env:DASHBOARD_CONTROL_API_URL='http://127.0.0.1:3210'
$env:DASHBOARD_CONTROL_API_TOKEN='<上一步输出的明文令牌>'
```

如需显示安全停止按钮，再选择一个至少 6 位的本地确认码，并只保存它的 SHA-256：

```powershell
$confirmationCode = Read-Host '设置本地停止确认码'
$sha = [Security.Cryptography.SHA256]::Create()
$hashBytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($confirmationCode))
$env:DASHBOARD_STOP_CONFIRMATION_SHA256 = ($hashBytes | ForEach-Object { $_.ToString('x2') }) -join ''
```

然后启动：

```powershell
pnpm dev
```

Dashboard 每 3 秒读取一次本机 Control API。长期令牌不会发送到浏览器；确认码明文只用于一次同源停止请求，不写入日志或 Store。若 Control API 未运行、Control Link 断开、令牌错误或响应无效，页面显示错误并清空在线 Bot。

Dashboard 页面可见时，初次完整环境检测之后还会每 5 秒调用同源 `/api/environment/memory`。该轻量接口仅在 Dashboard 服务端读取 Node.js `os.totalmem()` 和 `os.freemem()`，因此数值表示运行 Dashboard 服务端的主机或容器，不是手机/平板浏览器本身；它不会重新执行 Java、Docker、Git 或 GPU 探针，也不会保存历史。请求不重叠、4 秒超时并在页面卸载时取消；失败或超过 15 秒没有成功样本时保留最后一次真实值但明确标为“数据已过期”，页面从后台恢复可见后会立即重采。

## Dashboard 浏览器验收

先准备 Playwright 支持的浏览器。当前 Windows 本机验收复用已安装 Edge，不需要下载浏览器：

```powershell
$env:PLAYWRIGHT_BROWSER_CHANNEL='msedge'
pnpm test:e2e
```

测试夹具仅位于 `apps/dashboard/e2e`，覆盖在线、离线、失联、后端不可用和安全停止流程，不会作为运行时数据源。

## 可观测性与运行手册

服务端 JSON 日志固定包含 `traceId`、`taskId`、`botId`、`skillId` 和 `modelName`；Dashboard 安全停止结果会显示可复制的追踪编号。Runtime 记录连接、心跳、断线、计划重连、停止请求和停止结果的进程内计数器。

- [隔离 Minecraft 联机验收手册](docs/runbooks/isolated-minecraft.md)
- [故障排查与追踪手册](docs/runbooks/troubleshooting.md)

当前指标尚未提供 Prometheus 导出，集中日志和持久指标属于后续基础设施模块。

## L0 安全层

L0 安全判断完全确定性运行，不调用 Local AI Hub 或云模型，也不接受模型生成的动作文本。Runtime 会先暂停普通任务，再串行执行自动进食、短距离撤退、上浮、离开岩浆、停止横向移动或脱困；危急生命值的停止由 Runtime 自身接管。

Dashboard 的 Bot 卡片显示真实 L0 状态。旧 Runtime 未上报该字段时显示“不可用”，不会补造正常状态。

当前边界：撤退与脱困尚无安全路径规划，坠落只停止横向移动，背包满不会自动丢弃物品；饥饿但没有白名单安全食物时会暂停并等待干预。这些能力需要在 P1.2 之后以独立确定性技能实现和验收。

## Pathfinder 确定性技能

当前已注册的 44 个确定性 Skill 见 [`SKILLS.md`](SKILLS.md)。其中 `movement.goto@1.0.0` 的目标必须与 Bot 当前 ServerProfile 和维度一致，距离最多 64 格，半径 1～4 格，超时 20 秒。L0 暂停、Runtime 停止、断线或取消会停止寻路。

该技能已通过离线测试，但尚未在真实隔离服运行路径场景和跨版本矩阵，因此不能视为实机寻路验收完成。

## P1.3 任务系统当前边界

`@minecraft-studio/task-system` 提供任务 Schema、状态机、重试预算、创建幂等、操作重放、租约、参数化 PostgreSQL 仓库、`pg` 连接适配器、BullMQ 队列和 Worker。迁移文件位于 `packages/task-system/migrations`，不会由普通启动命令自动执行。

Coordinator 可把 `/v1/goals` 的完整生命周期写入 PostgreSQL，并通过已认证的 Control Link 向 Control API 提供受 `task.read` 保护的分页列表与详情。Dashboard 的任务页从该读路径恢复刷新前的历史；列表只返回任务摘要，详情只额外返回经授权的 operator goal，不返回 `target`、原始输入、证据或任意结果对象。未配置数据库、连接失败或 schema 未应用到 `0008_composite_tasks.sql` 时，历史明确显示不可用；开启 Local AI 目标执行却没有配置永久事实源时，Coordinator 拒绝启动。

启用前由人工或受控迁移流程依次应用 `0001` 至 `0008`（含 `0007_facility_leases.sql`、`0008_composite_tasks.sql`），然后配置：

```dotenv
COORDINATOR_TASK_POSTGRES_URL=postgresql://<user>:<password>@<approved-host>:5432/<database>
COORDINATOR_TASK_POSTGRES_SCHEMA=public
```

连接 URL 只放在进程环境中，不写入仓库。普通启动只校验连接与现有 schema，不创建数据库、不执行迁移，也不把 PostgreSQL 替换为 Redis 或进程内历史。

Worker 只接受 `TaskDispatchV1` 严格消息和预先注册的精确版本任务处理器；任务、派发和注册表中的处理器版本与幂等策略必须完全一致。消息中的文本、代码、Shell、URL 或未知字段不会执行。PostgreSQL 是任务事实源，Redis 只保存队列和临时 Worker 状态。BullMQ 自身不代替领域重试预算。

取消请求先以不可覆盖的操作身份写入 PostgreSQL；持有租约的 Worker 轮询、确认并传播 `AbortSignal`，任务完成、失败、截止时间和租约恢复在同一任务行锁之后必须让已持久化的取消优先。发起取消的 Worker 不需要拥有执行租约；原 Worker 失联且租约过期后，调用方或 Coordinator 恢复循环可完成取消。超时和截止时间同样按数据库权威时间持久化终态。

事务 outbox、PostgreSQL→BullMQ 有界对账、自动过期租约恢复和跨 Worker 持久取消已经实现。`apps/task-worker` 将 Worker 与控制平面分成独立进程，但处理器仍是该 Worker 进程内的受信任代码，并非每任务强隔离沙盒；忽略 `AbortSignal` 的处理器在 Worker 放弃等待后仍可能继续执行自身副作用。旧 job 的恢复仅在显式 BullMQ 重投、原租约已过期、Bot 归属匹配、持久化处理器版本/幂等策略与当前注册表一致且 PostgreSQL 重试预算仍有余额时允许。

本机没有配置 PostgreSQL/Redis 时，普通 `pnpm check` 只运行离线测试。真实基础设施测试使用专用数据库 Schema 和 Redis 前缀，拒绝非回环地址，也不会执行 `FLUSHALL` 或连接 Minecraft。该命令不会下载或启动 PostgreSQL/Redis；准备好已运行的隔离服务后执行：

```powershell
$env:TASK_POSTGRES_URL='postgresql://<test-user>:<test-password>@127.0.0.1:5432/<isolated-test-db>'
$env:TASK_REDIS_URL='redis://127.0.0.1:6379/0'
$env:TASK_INFRA_TEST_NAMESPACE='studio_test_local_unique01'
pnpm test:task-infra
```

三个变量缺少任意一个时命令会失败，不会静默跳过。测试会构建并启动独立 `task-worker` 子进程，但强制注入 `TASK_WORKER_PURPOSE=isolated-test` 与 `TASK_WORKER_HANDLER_PROFILE=isolated-acceptance`，不会连接 Minecraft。GitHub Actions 使用固定摘要的临时 PostgreSQL/Redis 服务完成同一组测试；2026-08-14 运行 `31793333384` 的 20 项真实基础设施场景全部通过，包括跨 Worker 与独立进程取消。此后 2026-08-27 本地运行 `studio_test_20260827_real03` 在临时 PostgreSQL/Redis 上 28/28 通过（含此前待确认的 digest 场景，见 `CHANGELOG.md:22`）；该边界不代表当前机器的生产基础设施在线，Minecraft 生产处理器和正式部署审批仍保持未接入状态。

## Skill Author：自动自我改进闭环

连接一个云端 OpenAI 兼容档案（Models 页有 **DeepSeek** 预设，`baseUrl` 填 `https://api.deepseek.com`，模型可留空由激活时自动探测选定）后，可以让 bot 依据自己遇到的能力缺口自动生成技能并合入：

```powershell
pnpm skill-author --list                 # 列出当前能力缺口
pnpm skill-author --latest --dry-run     # 只生成并校验，不写盘不提交
pnpm skill-author --latest               # 生成 → 跑闸 → 合入 main 并推送
pnpm skill-author --latest --no-merge     # 生成并提交到分支，但不合并
pnpm skill-author --rollback <sha>       # revert 一次已合并的自动提交并推送
```

闭环是：Coordinator 在任务失败时记录 gap（`runtime-data/skill-gaps/`）→ Skill Author 读 gap 与既有 bundle，调模型生成技能源码与单元测试 → **写盘前先按路径策略校验** → 写 git 分支 → 跑闸（全仓 `typecheck` + skills 单元测试）→ 绿灯合并到 `main` 并推送、红灯中止并保留分支待查。合入后既有的 release 闭环（`STUDIO_SKILL_DEV_MODE=sandbox_auto`）接管：skillId 出现在 catalog 即进入验收态，真实运行的成功信号即可晋升 canary；`active` 始终需要人工。

### 边界（`configs/skill-author-policy.json`，改动会留在 git 历史里）

- **可写**：`packages/skills/src/`、`packages/skills/tests/`、`apps/bot-runtime/src/`（新增 `invokeXxx` 能力适配器）。
- **只读**：敌我识别与聊天身份（`packages/combat/src/identity.ts`、`packages/protocol/src/chat-identity.ts`）、`packages/safety/`（L0 阈值）、ServerProfile 白名单校验、反射级门禁判定、授权面（`bot-messages.ts`、control-api `auth.ts`）。**只读判定优先于可写前缀**——落在 `apps/bot-runtime/src/` 里的 `server-profile.ts` 同样只读。
- **不可配置的自保护**：策略文件自身与 `scripts/lib/skill-author/`、`scripts/skill-author*.mjs` 永远拒绝写入——一个能改自己权限配置的自动化不构成边界。
- 任一文件越界即**整体放弃**：不建分支、不写盘、不提交（不做部分写入）。

### 为什么合并前必须过闸

技能是 TypeScript，一个类型错误会让整包构建失败、bot 起不来——所以"自动合并"必须配全仓 `typecheck`。闸全部是进程内的，**不需要隔离服务器、不吃内存**。真实游戏语义由合入后的真实运行证据来验证（`live-run` 可替代 `fixture-run`，见 `packages/skills/tests/skill-release.test.ts`），因此隔离服 E2E 不是这条闭环的前置。

### 已知残余风险（如实记录）

- 自动合并到 `main` 且只过"便宜闸"，因此**语义错误会在真实服上才暴露**；部署在 anarchy 服时按章程 §0.4「死亡=掉全部装备」评估代价。
- 越权改动由路径策略拦，但**策略看不出语义**：例如在可写前缀内新增一个调用既有能力但参数组合危险的技能，闸不会报错。
- 每次运行起步要求干净工作区与 `main` 分支（脏树无法可靠回滚，直接拒绝）。

## 安全说明

- 软件检测使用固定可执行文件和固定参数，不拼接用户输入。
- 子进程明确禁用 Shell。
- 不采集主机名、用户名、IP、密钥或 Minecraft 服务器信息。
- 依赖只允许从官方 npm Registry 下载，并由锁文件记录完整性哈希。
- pnpm 只允许经过审核的 `sharp` 执行安装脚本；BullMQ 间接依赖的可选原生 `msgpackr-extract` 明确禁止构建，其余依赖脚本默认阻止。

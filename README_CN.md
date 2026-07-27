# Minecraft Multi-Agent Studio

面向 Minecraft Java 版多智能体机器人的硬件无关控制平台。

当前已完成项目基线、真实环境检测、版本化 Bot 状态协议、单 Bot 隔离联机验收、Minecraft 版本自适应、Coordinator 进程内注册表、Control API/Dashboard 契约、确定性 L0 安全层、受限 Pathfinder 技能，以及 P1.3 任务持久化基础：

- 自动检测当前 CPU、内存、操作系统和 GPU 探测状态。
- 检测 Node.js、Java、Docker 和 Git 是否可用。
- 识别标准、Docker、便携和网吧运行模式。
- 通过真实 API 在响应式前端展示检测结果。
- Dashboard 通过服务端代理读取 Control API，显示真实在线、离线、失联和后端不可用状态。
- 定义并测试 Bot 状态、心跳、断线和安全停止协议 v1。
- 实现只允许隔离测试服的单 Bot Mineflayer Runtime。
- 已在仅绑定本机回环地址的 Minecraft 1.21.8 服务端验证连接、停止、断线和有限重连。
- Coordinator 使用真实遥测维护在线、失联和离线状态，并拒绝重复、乱序及旧进程心跳。
- 安全停止要求可信授权、幂等命令 ID、审计、超时和 Runtime 确认结果。
- Control API 提供认证列表、详情、WebSocket 状态流和受权优雅停止入口。
- 安全停止要求弹窗二次确认、本地确认码、`bot.stop` 权限和 Runtime 真实确认结果。
- Bot 可对批准的隔离服务器自动探测 Minecraft 版本，并上报真实兼容状态。
- 进程内链路可用同一追踪编号核对 Control API、Coordinator 和 Bot Runtime 结构化日志。
- L0 安全层从真实 Mineflayer 状态识别饥饿、低/危急生命值、溺水、岩浆、坠落、卡死和背包满，并执行固定白名单动作。
- `movement.goto@1.0.0` 通过受限 Pathfinder 适配器移动，不允许挖掘、搭塔、垫方块或跑酷。
- 任务系统提供 PostgreSQL 迁移、严格状态机、幂等键、乐观修订号、租约边界、版本化处理器契约、严格派发协议和 BullMQ Worker。
- 隔离 PostgreSQL/Redis 集成测试已于 2026-07-28 在 GitHub Actions 真实临时服务中通过；本机没有运行这些服务时不会冒充本机服务在线。

当前项目是单 Bot 安全执行与任务基础设施，不是已经完成的多智能体产品。独立 Control API 尚未接入 Runtime/Coordinator 跨进程遥测，因此单独启动时返回真实空列表；Dashboard 后端断开时会清空 Bot 列表并明确显示错误。

当前不会自动连接 Minecraft，不会调用模型，也不会显示模拟 Bot。

仅在显式设置隔离测试服配置并执行 `pnpm bot:start` 时才会尝试连接 Minecraft。

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
pnpm dev
```

浏览器打开 `http://localhost:3000`。

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
```

可选值：`standard`、`docker`、`portable`、`netcafe`。

当前模块完成模式识别。Docker 镜像、便携数据迁移，以及网吧模式的 API 训练、成果导出、断点恢复和安全清理将在后续独立模块实现。

## 启动隔离测试 Bot

复制示例配置：

```powershell
Copy-Item .\configs\servers\isolated-test.example.json .\configs\servers\isolated-test.local.json
```

确认配置指向你自己的 Minecraft Java 隔离测试服，然后运行：

```powershell
$env:BOT_SERVER_PROFILE_PATH="$PWD\configs\servers\isolated-test.local.json"
pnpm bot:start
```

安全限制：

- 当前只允许离线认证的本机或私有局域网测试服。
- 不支持公网地址、正式服务器或配置文件密码。
- 没有设置 `BOT_SERVER_PROFILE_PATH` 时不会尝试连接。
- Bot 状态已定义到 Coordinator、Control API 和 Dashboard 的真实数据链路；独立进程间传输仍待后续模块接入。

版本配置：

- 推荐使用 `"minecraftVersion": "auto"`，Mineflayer 只探测当前 ServerProfile 指向的已批准服务器。
- 也可填写固定版本，例如 `"1.21.8"`；固定版本必须在当前 Mineflayer 的测试清单中。
- 当前锁定的 Mineflayer 4.37.1 声明测试范围为 1.8.8 至 1.21.11，共 27 个测试版本。
- 自动协商成功但未列入测试清单时标记 `compatible-untested`，不会冒充“已测试”。
- 超出支持范围时标记 `unsupported` 并停止自动重连。

## 真实联机验收

验收脚本只使用项目 `runtime-data` 中预先准备的可信 Java、官方 Minecraft 1.21.8 服务端和本地配置。它不会下载依赖或自动接受 EULA；缺少文件、哈希不符、属性不安全或端口已占用时会停止。

准备完成并由用户明确接受 Minecraft EULA 后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-isolated-minecraft-test.ps1
```

脚本仅绑定 `127.0.0.1:25565`，验证真实连接、正常停止、服务端断开和有限重连，完成后自动关闭本次启动的服务。服务器文件、世界、日志和本地 ServerProfile 均不会提交到版本库。

## Coordinator 当前边界

- 注册表、停止命令缓存和审计记录当前保存在进程内存中，进程重启后 Bot 必须重新上报。
- Coordinator 与 Bot Runtime 的协议边界和进程内集成测试已经完成。
- Control API 与 Dashboard 状态读取已接入；跨进程 Bot 遥测、停止传输、用户登录和持久化审计仍为“待接入”。
- 当前不提供连接正式 Minecraft 服务器的入口。

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

仅把 `$tokenHash` 写入进程环境并启动：

```powershell
$principal = @(@{
  subject = 'local-dashboard'
  tokenSha256 = $tokenHash
  permissions = @('bot.read', 'bot.position.read', 'bot.stop')
})
$env:CONTROL_API_AUTH_JSON = ConvertTo-Json -InputObject $principal -Compress
pnpm api:start
```

接口：

- `GET http://127.0.0.1:3210/v1/bots`
- `GET http://127.0.0.1:3210/v1/bots/{botId}`
- `POST http://127.0.0.1:3210/v1/bots/{botId}/stop`
- `WS ws://127.0.0.1:3210/v1/bots/stream`

HTTP 使用 `Authorization: Bearer <明文令牌>`。浏览器 WebSocket 使用子协议 `minecraft-studio.v1` 和 `auth.<明文令牌的 base64url>`。停止 POST 固定为优雅停止并要求 `bot.stop`；未注入 StopController 时返回 `CONTROL_UNAVAILABLE`。

当前独立 API 进程没有跨进程遥测与停止传输入口，因此未共享 Coordinator 注册表时会返回真实空列表，不会创建模拟 Bot，也不会伪造停止成功。

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

Dashboard 每 3 秒读取一次本机 Control API。长期令牌不会发送到浏览器；确认码明文只用于一次同源停止请求，不写入日志或 Store。若 Control API 未运行、令牌错误或响应无效，页面显示错误并清空在线 Bot。

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

当前仅注册 [`movement.goto@1.0.0`](SKILLS.md)。目标必须与 Bot 当前 ServerProfile 和维度一致，距离最多 64 格，半径 1～4 格，超时 20 秒。L0 暂停、Runtime 停止、断线或取消会停止寻路。

该技能已通过离线测试，但尚未在真实隔离服运行路径场景和跨版本矩阵，因此不能视为实机寻路验收完成。

## P1.3 任务系统当前边界

`@minecraft-studio/task-system` 提供任务 Schema、状态机、重试预算、创建幂等、操作重放、租约、参数化 PostgreSQL 仓库、`pg` 连接适配器、BullMQ 队列和 Worker。迁移文件位于 `packages/task-system/migrations`，不会由普通启动命令自动执行。

Worker 只接受 `TaskDispatchV1` 严格消息和预先注册的精确版本任务处理器；任务、派发和注册表中的处理器版本与幂等策略必须完全一致。消息中的文本、代码、Shell、URL 或未知字段不会执行。PostgreSQL 是任务事实源，Redis 只保存队列和临时 Worker 状态。BullMQ 自身不代替领域重试预算。

活动取消、超时和截止时间先传播 `AbortSignal`；即使受信任处理器不合作，Worker 也会停止等待、停止续租并按数据库权威时间释放持久租约。任务处理器当前仍与 Worker 运行在同一 Node.js 进程，并非强隔离沙盒，因此已失去租约的处理器代码仍可能继续执行自身副作用，后续必须通过独立进程隔离获得硬终止能力。旧 job 的恢复仅在显式 BullMQ 重投、原租约已过期、Bot 归属匹配、持久化处理器版本/幂等策略与当前注册表一致且 PostgreSQL 重试预算仍有余额时允许。当前还没有 outbox、自动 PostgreSQL→BullMQ 对账重投或跨 Worker 取消 API。

本机没有配置 PostgreSQL/Redis 时，普通 `pnpm check` 只运行离线测试。真实基础设施测试使用专用数据库 Schema 和 Redis 前缀，拒绝非回环地址，也不会执行 `FLUSHALL` 或连接 Minecraft。该命令不会下载或启动 PostgreSQL/Redis；准备好已运行的隔离服务后执行：

```powershell
$env:TASK_POSTGRES_URL='postgresql://<test-user>:<test-password>@127.0.0.1:5432/<isolated-test-db>'
$env:TASK_REDIS_URL='redis://127.0.0.1:6379/0'
$env:TASK_INFRA_TEST_NAMESPACE='studio_test_local_unique01'
pnpm test:task-infra
```

三个变量缺少任意一个时命令会失败，不会静默跳过。GitHub Actions 使用固定摘要的临时 PostgreSQL/Redis 服务完成同一组测试，2026-07-28 的运行 `30315095898` 已通过。该结果证明隔离集成边界，不代表生产基础设施在线；Coordinator 调度入口、outbox/自动对账重投、跨 Worker 取消、任务 Control API、Dashboard 任务看板和生产基础设施仍待后续模块接入。

## 安全说明

- 软件检测使用固定可执行文件和固定参数，不拼接用户输入。
- 子进程明确禁用 Shell。
- 不采集主机名、用户名、IP、密钥或 Minecraft 服务器信息。
- 依赖只允许从官方 npm Registry 下载，并由锁文件记录完整性哈希。
- pnpm 只允许经过审核的 `sharp` 执行安装脚本；BullMQ 间接依赖的可选原生 `msgpackr-extract` 明确禁止构建，其余依赖脚本默认阻止。

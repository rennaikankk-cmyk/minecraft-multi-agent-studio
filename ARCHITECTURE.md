# 系统架构

## 1. 架构目标

Minecraft Multi-Agent Studio 是硬件无关、模型供应商无关的模块化系统。任何业务模块不得绑定 DGX Spark、固定 GPU、固定 CPU 或固定主机名。

系统启动时通过环境检测模块读取实际硬件、软件和运行模式。检测结果只用于能力判断与调度建议，不用于假定设备性能。

## 2. 分层架构

```text
Browser → Dashboard server
             ↓ loopback HTTP + Bearer
         Control API
             ⇅ Control Link v1 / mutual HMAC / loopback WebSocket
         Coordinator / Policy Engine
             ⇅ Runtime Link v1 / mutual HMAC / loopback WebSocket
         Bot Runtime / Deterministic Skills / L0 Safety
             ↓ explicit isolated-test profile only
         Isolated Minecraft Test Server

AI Router
  ├─ Local AI Hub adapters
  └─ Approved cloud expert adapters
```

- Local AI Hub 是所有本地推理资源的统一名称。
- AI Router 负责发现、适配、预算、超时和降级，业务代码不得绑定具体模型或设备。
- 模型输出必须经过 Schema、Policy Engine、技能白名单和参数边界验证。
- Bot Runtime 只连接批准的隔离测试服配置。

## 3. 当前工作区

```text
apps/
├─ bot-runtime/            # 单 Bot Mineflayer 运行时
├─ coordinator/            # Bot 注册表与安全停止控制平面
├─ control-api/            # 认证 HTTP/WebSocket 状态 API 与受权停止入口
├─ dashboard/              # Next.js 前端、服务端代理与真实状态 Store
└─ task-worker/            # 仅隔离验收的独立 BullMQ Worker 进程
packages/
├─ protocol/               # 版本化 Zod Schema
├─ environment/            # 真实硬件、软件和模式检测
├─ observability/          # 结构化日志和进程内指标
├─ safety/                 # 确定性 L0 生存策略与动作边界
├─ skills/                 # 版本化确定性技能注册与受限执行框架
└─ task-system/            # PostgreSQL 事实源、BullMQ 队列与确定性 Worker
```

尚未创建 AI Router 或生产数据库部署。Bot Runtime 已完成 Minecraft 1.21.8 隔离联机验收，并已通过认证 Runtime Link 接入独立 Coordinator 的进程内 Bot 注册表和安全停止控制边界；Control API 通过认证 Control Link 镜像 Coordinator 状态并转发固定停止 RPC。Dashboard 通过服务端代理读取 Control API，浏览器不会收到长期令牌。四进程服务链路已用生产 Coordinator、Control API、Dashboard 和测试专用 Runtime fixture 完成真实回环验收；该结果没有连接 Minecraft，也不是浏览器 E2E。确定性技能库已注册 `movement.goto@1.0.0`，Bot Runtime 通过受限 Pathfinder 适配器执行；任务包已建立 PostgreSQL 适配器、严格 BullMQ 队列、持久取消和可嵌入 Worker。独立 `task-worker` 应用当前只允许通过显式隔离测试配置连接真实 PostgreSQL/Redis，并且只注册验收处理器，不是生产 Worker 配置。

## 4. 环境检测数据流

```text
Operating System / Node Runtime
        ↓
allowlisted probes (no shell)
        ↓
EnvironmentSnapshot v1.0 + Zod validation
        ↓
GET /api/environment (no-store)
        ↓
Dashboard real status view

Dashboard page open
        ↓ every 5 seconds, non-overlapping, 4-second timeout
Node os.totalmem() / os.freemem() only
        ↓ EnvironmentMemorySample v1.0 + strict validation
GET /api/environment/memory (no-store)
        ↓ latest real value, or visibly stale last success
```

检测器不会执行模型文本、用户输入或远程下载内容。当前软件探针只有 Node.js、Java、Docker 和 Git；GPU 探针按平台选择固定的 CIM、lspci 或 system_profiler。页面可见期间的 5 秒内存采样不会重新运行这些昂贵探针，只读取 Dashboard 服务端所在主机或容器的 Node OS 值；页面隐藏时暂停、恢复可见时立即重采，关闭即取消轮询，不持久化样本。

## 5. 运行模式

| 模式 | 选择方式 | 当前状态 |
|---|---|---|
| standard | 默认或 `STUDIO_MODE=standard` | 已识别 |
| docker | 容器标记或显式配置 | 已识别，镜像待实现 |
| portable | `STUDIO_MODE=portable` 或便携根目录 | 已识别，数据迁移待实现 |
| netcafe | 必须显式配置 | 已识别，训练/导出/恢复/清理待实现 |

模式特有功能必须放在适配层，不能污染技能、任务或协议核心。

## 6. 版本化边界

- 当前 `EnvironmentSnapshot` 的 `schemaVersion` 为 `1.0`。
- 跨服务消息必须在 `packages/protocol` 定义并验证。
- 未知主版本默认拒绝，不进行静默兼容。
- API 错误返回稳定错误码，不返回伪造的环境快照。

### Bot Protocol v1

当前共享协议包已定义：

- `BotStatusV1`：完整状态快照，包含真实血量、饥饿、护甲、位置和当前任务。
- `BotHeartbeatV1`：轻量心跳、运行实例、序列号和最近状态序列号。
- `BotDisconnectedV1`：结构化断线原因、是否预期和最后状态序列号。
- `BotVersionV1`：版本选择、真实解析版本、兼容等级和适配器支持范围。
- `StopBotCommandV1`：有期限、幂等命令 ID 和授权决策引用的安全停止命令。
- `BotStopResultV1`：由目标 Runtime 返回的完成、拒绝或失败确认。

```text
Bot Runtime
  ├─ BotStatusV1
  ├─ BotHeartbeatV1
  └─ BotDisconnectedV1
          ↓ strict Zod validation
      Coordinator BotRegistry

API Gateway / Coordinator
  └─ StopBotCommandV1
          ↓ schema + trusted authorization context
      Bot Runtime
          ↓ BotStopResultV1
      Coordinator audit + registry
```

每条消息都包含 `schemaVersion`、`messageId`、`traceId`、`timestamp`、`source.instanceId` 和 `botId`。遥测中的 `runtimeInstanceId + sequence` 用于后续识别重启、重复和乱序消息。

`StopBotCommandV1` 的消息内授权字段只是一份引用，不能自证权限。执行前必须由 `parseBotProtocolMessage` 将它与服务器端可信上下文中的决策、操作者、目标 Bot、命令 ID、权限和有效期逐项匹配。

### Skill Protocol v1

- `SkillInvocationV1`：由 Coordinator 发出的严格 JSON 技能调用，固定技能 ID 和 SemVer 版本，携带任务、Bot、追踪、期限和授权引用。
- `SkillExecutionResultV1`：由 Bot Runtime 返回的结构化完成、拒绝、失败、取消或超时结果。
- 调用消息不携带可自证的能力授权；执行器必须把消息与独立可信上下文逐项匹配。
- 完成结果必须包含经技能 Schema 和 JSON Schema 双重验证的输出；其他结果只能包含稳定错误码。

### Task Dispatch Protocol v1

- `TaskDispatchV1`：Coordinator 发送到队列的严格任务派发消息，只携带任务 ID、Bot ID、任务类型、处理器版本、持久化幂等策略和预期 PostgreSQL 修订号。
- 队列消息固定 `type=task.dispatch.v1` 和 `schemaVersion=1.0`，未知字段或版本默认拒绝。
- 消息不包含可执行代码、Shell、模型文本、URL 或任意参数；Worker 只按 PostgreSQL 任务类型和处理器版本查找本地精确注册的确定性处理器，并拒绝幂等策略不一致。

## 7. 单 Bot Runtime

```text
explicit ServerProfile (isolated-test only)
        ↓ strict validation + private host policy
MineflayerBotClient
        ↓ real Mineflayer events and snapshots
SingleBotRuntime
  ├─ status interval
  ├─ heartbeat interval
  ├─ disconnect event
  ├─ bounded exponential reconnect
  └─ graceful stop
        ↓ Bot Protocol v1 validation
RuntimeLinkClient (bounded queue + telemetry ACK)
        ⇅ mutual HMAC, ws://loopback/v1/runtime-link
RuntimeLinkServer
        ↓ strict identity/order validation
Coordinator BotRegistry
```

运行时不包含服务器地址默认值，也不会扫描或自动选择服务器。只有显式设置 `BOT_SERVER_PROFILE_PATH` 后才创建 Mineflayer 客户端。版本自动探测只发生在这个已经通过网络范围校验的目标上。

ServerProfile 只接受：

- `purpose=isolated-test`
- `auth=offline`
- loopback 或 RFC1918/本地 IPv6 地址
- `minecraftVersion=auto` 或当前 Mineflayer 明确测试过的固定版本
- 有限重连次数和有上限的超时

状态来自 Mineflayer 实例。无法可靠读取最大生命值、护甲或延迟时使用 `null`，不使用假定值替代。

版本能力直接读取锁定的 Mineflayer 4.37.1 公开导出，而不是在业务代码复制版本表。当前包声明的测试范围是 1.8.8 至 1.21.11，共 27 个测试版本。自动模式省略 Mineflayer `version` 选项，由其先探测目标服务器协议；成功后读取 Bot 的真实解析版本并标记为 `tested` 或 `compatible-untested`。超出适配器能力时上报 `unsupported`，并禁止对同一确定性错误继续重连。

真实联机验收由 `scripts/run-isolated-minecraft-test.ps1` 编排。脚本只接受预先准备的可信 Java、Minecraft 1.21.8 官方服务端和本地 ServerProfile，启动前校验服务端哈希、用户 EULA 状态、安全属性与端口占用，测试完成后优雅关闭本地服务。运行时世界、日志和本地配置保存在忽略提交的 `runtime-data` 中。

## 8. Coordinator Bot 注册表

```text
validated Bot telemetry
        ↓ source/runtime identity check
messageId dedupe + runtimeInstanceId + sequence ordering
        ↓
BotRegistry (in-memory, real process state)
  ├─ online / connecting / stopping / error
  ├─ stale after liveness timeout
  └─ offline after disconnect or confirmed stop
```

注册表按 Bot 保留当前运行实例和有限数量的已退役运行实例。新运行实例接管后，旧实例的延迟心跳不能恢复在线状态；同一实例的重复或乱序序列也不会覆盖较新状态。状态读取返回副本，不能从调用方直接修改注册表内部数据。

安全停止由 `StopController` 生成并再次校验 `StopBotCommandV1`，可信授权上下文必须匹配决策、操作者、Bot、命令、权限和有效期。`RuntimeLinkServer` 只把命令路由到注册表当前运行实例对应的认证会话，Runtime 从已认证 Coordinator 会话重建可信上下文并返回 `BotStopResultV1`；Coordinator 只在确认身份完全匹配后更新离线状态。

Runtime Link 固定使用 `minecraft-studio.runtime.v1` 子协议、`/v1/runtime-link` 路径和显式回环地址。Coordinator 配置只保存每 Bot 共享密钥的 SHA-256；双方使用随机 nonce 和方向绑定的 HMAC proof 相互认证。文本 JSON 帧最大 64 KiB，禁用压缩；连接、待确认停止、发送缓冲和 Runtime 遥测队列都有上限。遥测在 ACK 前使用同一 `messageId` 重投，注册表负责幂等；重连后 Runtime 另外生成新状态，旧重复消息不会刷新存活时间。控制链路重试耗尽或关键队列溢出时 Runtime 确定性停止，不继续无人监管运行。

当前注册表、命令幂等缓存和审计记录仍为进程内存。Runtime ↔ Coordinator 已跨进程接通；下游 Control Link 将这份权威内存状态投影给 Control API。四进程服务链路已通过真实回环验收，但状态和审计仍不持久化，因此不能称为生产级端到端产品。

## 9. Control Link、Control API 与实时状态流

```text
Coordinator BotRegistry
        ↓ atomic snapshot + ordered upserts
ControlLinkServer
        ⇅ mutual HMAC, ws://loopback/v1/control-link
CoordinatorLinkClient
        ↓ authoritative in-memory mirror
Control API
        ↓
Bearer token or WebSocket auth subprotocol
        ↓ SHA-256 digest + timing-safe comparison
permission + input/version validation + rate limits
        ↓
GET /v1/bots
GET /v1/bots/:botId
POST /v1/bots/:botId/stop
WS  /v1/bots/stream
        ↓
public projection (no ServerProfile/runtime internals)
        ↓
snapshot at sequence N → events N+1, N+2, ...
```

Control Link 固定使用 `minecraft-studio.control-link.v1` 子协议、`/v1/control-link` 路径和显式回环地址。Coordinator 配置只保存 Control API 共享密钥的 SHA-256；Control API 明文密钥只存在于自身进程环境。双方通过随机 nonce、方向绑定 proof 和时序安全比较完成双向 HMAC 身份验证，认证前不能读取状态或发出停止。所有消息由共享协议包严格校验，文本帧最大 64 KiB，压缩、重定向、浏览器 Origin、URL 用户信息、查询和片段均不允许；会话、快照期间增量、待处理停止和发送缓冲都有硬上限。

认证后 Coordinator 按 `snapshot-begin → snapshot-item* → snapshot-end` 发送一致性快照，并把快照生成期间的新事件按连续序列缓冲在其后。Control API 只有在完整、无重复且身份/数量/序列全部匹配的 `snapshot-end` 到达时才原子替换镜像；半包快照、序列跳号、身份变化、断线或 75 秒没有任何入站帧/ping 都会使镜像立即不可用。失败路径先同步撤销认证和镜像，关闭握手中的排队帧不会恢复旧状态或把可重连错误升级成永久失败。运行中断线会清空镜像并关闭外部 WebSocket 状态流，HTTP 列表、详情和停止统一返回 `503 CONTROL_UNAVAILABLE`，不会保留旧在线假象。

Bot 注册表和失联判定只存在于 Coordinator；`COORDINATOR_BOT_STALE_AFTER_MS` 默认 15000 毫秒并在启动时严格限制为 1000～300000。Control API 只消费权威镜像，不再接受一个不会生效的本地失联阈值。

待处理停止只允许在同一 `coordinatorInstanceId` 的短暂重连中重投。Coordinator 重启改变实例身份时，客户端会清除旧操作计时器并以身份变化错误拒绝旧操作；新连接仍可完成快照并独立恢复服务。

生产 Coordinator 与 Control API 每次进程启动都使用新的 `randomUUID()` 高熵 boot ID，不使用可复用 PID 作为会话身份；因此进程重启不会被误判为同一认证实例。

停止 RPC 固定为 `graceful`、`dashboard_operator_confirmed`、5 秒宽限和 15 秒超时，且 `commandId = traceId = decisionId = operationId`。Control API 从已认证 HTTP 主体构建仅含 `bot.stop` 的短期可信授权；Coordinator 再校验 Control Link 客户端能力、操作身份、时间窗口、幂等指纹和 Bot 状态，并只接受 Runtime 返回的完全匹配结果。超时、背压、链路中断或身份不一致都不能转换为成功。

Control API 默认且当前只允许绑定 `127.0.0.1` 或 `::1`。服务端配置只保存令牌 SHA-256，不保存明文令牌；HTTP 使用 Bearer 头，浏览器 WebSocket 可通过 `minecraft-studio.v1` 与 `auth.<base64url-token>` 子协议认证。`bot.read` 允许读取基本状态，坐标还需要单独的 `bot.position.read` 权限。

列表和详情不会返回 `ServerProfile`、服务器地址、运行实例内部标识或原始错误。WebSocket 连接建立后先发送当前完整快照，再发送严格递增的 `upsert` 事件；客户端发送任何业务消息都会以只读策略关闭。

HTTP 停止入口只接受固定的优雅停止请求、UUID 幂等命令 ID 和具有 `bot.stop` 权限的服务端主体。Control API 将认证主体绑定为可信操作者，并通过 Control Link 等待 Coordinator/Runtime 确认。链路不可用时返回 `CONTROL_UNAVAILABLE`，不伪造成功。

生产 Control API 入口在首个完整 Control Link 快照前不会启动对外 HTTP 服务。四进程服务级验收已经覆盖空快照、在线增量、停止完成、离线增量、固定追踪编号和断线清理；验收中的 Runtime 是测试专用 fixture，没有连接 Minecraft，也没有经过浏览器 Playwright 页面。

## 10. Dashboard 真实数据链路

```text
Browser
  ↓ same-origin GET/POST, no long-lived token
Next.js Dashboard server routes
  ↓ loopback-only URL + server-only Bearer token
Control API
  ↓ strict v1 response validation
Zustand real-state store
  ↓
online / offline / stale / unavailable UI
```

Dashboard 每 3 秒通过服务端代理读取 Bot 列表与详情。代理只允许 HTTP 回环地址，设置 4 秒超时，最多读取 100 个 Bot，并验证所有版本化响应。请求失败时 Store 清空 Bot 和采集时间，页面显示后端不可用，不保留“在线”假象。

安全停止需要弹窗二次确认和本地确认码。服务端只保存确认码 SHA-256，并使用时序安全比较；POST 还要求同源、专用动作头和进程内频率限制。Playwright 的 Bot 数据只位于 `apps/dashboard/e2e` 测试夹具中，不会进入生产数据源。

环境页的 5 秒内存刷新是另一条独立的同源只读链路。页面首次加载仍执行一次完整环境检测，之后页面可见时 `/api/environment/memory` 只调用 Dashboard 服务端进程的 `os.totalmem()` / `os.freemem()`，返回 `source=node-os` 且满足 `0 <= freeBytes <= totalBytes` 的严格样本。前端禁止请求重叠，4 秒超时，卸载时中止；采样失败或超过 15 秒没有成功样本时保留最后一次真实值并明确标为过期，页面恢复可见时立即重采。样本不写数据库、文件、日志历史或浏览器持久存储，也不代表浏览器终端自身的内存。

## 11. 可观测性

`@minecraft-studio/observability` 提供统一 JSON 日志和受限的进程内计数器。日志固定带有时间、级别、服务、实例、事件以及 `traceId/taskId/botId/skillId/modelName`；不存在的关联值为 `null`。敏感键、常见令牌格式、换行和过深对象在写出前统一清理。

Dashboard、Control API、Coordinator 和 Bot Runtime 已分别实现同一安全停止 UUID/`traceId` 的生成、校验、审计和结果绑定契约。Runtime Link 双进程验收已经核对 Coordinator 与 Bot Runtime 使用同一追踪编号；2026-08-07 的四进程服务级验收又使用生产 Coordinator、Control API、Dashboard 与测试专用 Runtime fixture 核对了同一追踪编号，两位执行者各运行一次均退出码 0。该结论不扩大为浏览器 E2E 或真实 Minecraft 联机结果。

Runtime 当前记录连接尝试、心跳、断线、计划重连、停止请求、停止结果，以及 L0 安全决策、动作和失败。Runtime Link 与 Control Link 已把 Bot 遥测、公开状态、停止请求和停止结果带同一 `traceId` 传过四个服务进程；指标仍只存在于 Runtime 内存并可通过测试或运行时快照读取，Prometheus 和集中日志尚未接入。

## 12. L0 确定性安全层

```text
Mineflayer real snapshot
  ↓ finite-value validation
L0SafetyController (fixed thresholds + cooldowns)
  ↓ typed allowlisted actions
SingleBotRuntime serial safety queue
  ├─ bounded Mineflayer controls
  └─ runtime-owned emergency stop
```

安全评估在每次 Mineflayer 状态事件和周期状态上报时运行，优先于未来普通技能。输入包含真实生命值、饥饿、氧气、水/岩浆状态、落地状态、垂直速度、位置、背包占用、安全食物和移动请求；非有限数值、越界值或矛盾背包数量直接拒绝。

控制器只产生固定类型的动作，不读取自然语言或模型输出。动作具有固定冷却时间，移动类动作还具有 2 秒以内的固定持续上限，并在同一 Runtime 队列中串行执行。危急生命值产生的 `EMERGENCY_STOP` 由 Runtime 调用既有优雅停止边界，Mineflayer 适配器不能自行声称完成 Runtime 停止。

L0 当前提供基础生存反应，不声称具备路径规划：低血量撤退为短距离后退，坠落只停止横向移动，背包满只暂停普通任务；饥饿且没有白名单安全食物时也保持暂停。更复杂的安全导航、落地、补给和物品搬运必须作为后续确定性技能单独验证。

## 13. 确定性技能库

```text
SkillInvocationV1 + trusted authorization context
        ↓ exact skill ID/version lookup
strict input/state Schema + deterministic preconditions
        ↓ capability declaration/grant intersection
SkillExecutor
  ├─ bounded timeout and cancellation
  ├─ idempotent-only bounded retry with backoff and jitter
  └─ capability adapter calls only
        ↓ strict JSON SkillExecutionResultV1
```

技能注册表允许同一技能的多个明确版本，但不提供 `latest` 或静默版本回退。每个定义必须声明输入、输出、状态、前置条件、能力、超时、幂等性和重试策略；非幂等技能不能自动重试。

执行器不会把 Mineflayer、Shell、文件系统、网络或模型对象直接交给技能。技能只能通过已声明且可信上下文已授权的能力适配器发起结构化 JSON 调用，适配器返回值和最终结果也必须可验证、可序列化。当前框架仍在 Bot Runtime 进程内运行；若处理器忽略 `AbortSignal` 并执行纯 CPU 或绕过适配器的自有副作用，JavaScript 无法强制终止它，因此不将本模块标记为隔离沙盒。

### `movement.goto@1.0.0`

```text
validated target (profile + dimension + <= 64 blocks)
        ↓ exact skill/version + bot.move grant
Runtime normal-action and L0 gate
        ↓
Pathfinder adapter
  ├─ canDig=false
  ├─ no scaffolding / towers / parkour / sprinting
  ├─ no door interaction
  ├─ max drop 2 blocks
  └─ AbortSignal → pathfinder.stop()
```

目标必须包含 ServerProfile 和维度，且与 Bot 当前真实状态一致。技能半径限制为 1～4 格、三维直线距离最多 64 格、总超时 20 秒。L0 安全暂停、Runtime 停止或断线会取消活动技能并停止 Pathfinder。该技能已通过离线单元和 Runtime 集成测试，尚未在真实隔离服执行路径场景，因此不声称跨版本实机寻路已经验收。

## 14. P1.3 任务基础设施

```text
future Coordinator (pending)
  └─ TaskDispatchV1 → BullMQ (delivery and temporary locks)
                         ↓ strict parse + exact handler lookup
                    deterministic Worker
                         ↓ acquire / renew / finish / cancel
PostgreSQL ← parameterized transaction + revision + append-only history
    ↑ authoritative task state, timeout and retry budget
```

`@minecraft-studio/task-system` 定义了 queued、assigned、running、blocked、waiting、paused、completed、failed、cancelled 和 expired 状态。状态转换使用乐观修订号；运行和完成必须持有未过期且所有者匹配的租约，原租约所有者可在截止时间到达后写入 expired 终态。任务创建持久化精确处理器版本与幂等策略，使用作用域化幂等键和规范化 SHA-256 请求指纹；相同操作 ID 由事务级 advisory lock 串行化，只能返回完全相同的持久化快照。截止时间统一规范化为 UTC，时间、租约过期判断和状态历史以 PostgreSQL 时钟为准。可信高风险审批尚未接入，因此 R3/R4 任务当前可以记录但不能领取执行。

迁移创建 `studio_tasks`、`studio_task_dependencies`、只追加的 `studio_task_history`、事务派发 outbox 和取消请求表，并约束 assigned/running 状态必须存在完整租约和 Bot 归属。任务禁止直接删除，历史禁止更新或删除。BullMQ job 固定一次尝试，领域重试只在 PostgreSQL 中显式记账；旧 job 只有在显式重投、租约真实过期、Bot 归属匹配、持久化处理器版本/幂等策略与注册表一致且重试预算仍有余额时才可恢复。

取消方先写 PostgreSQL 请求，不需要与租约所有者处于同一 Worker。租约所有者以有界间隔轮询、确认、传播 `AbortSignal` 并原子写入 cancelled；已持久化取消会阻止新租约以及 completed/failed/expired/requeue 等竞争变更。租约过期时，Coordinator 恢复循环先解析取消，再决定是否重派或失败。独立 Worker 进程不等于处理器沙盒：处理器仍是 Worker 进程内的受信任代码，忽略信号的代码可能在失去租约后继续运行自身副作用。

真实基础设施测试只接受本机回环 PostgreSQL/Redis、专用 PostgreSQL Schema 和独立 Redis 前缀；清理范围不超过这些测试命名空间，也不连接 Minecraft。GitHub Actions 使用固定镜像摘要的临时服务执行迁移、并发重放/领取、outbox 对账、租约恢复、队列去重、续租、取消、超时和显式重投场景。跨 Worker 与独立进程取消场景在本分支等待 CI；该结果无论通过与否都只证明隔离集成边界，不代表生产基础设施在线。

当前缺少 Coordinator 任务基础设施启动编排、生产处理器注册、任务 API、Dashboard 任务看板和生产部署。事务 outbox 与 BullMQ 之间仍是至少一次投递，不得声称 exactly-once；跨 Worker 持久取消也不构成对不合作处理器的硬终止保证。

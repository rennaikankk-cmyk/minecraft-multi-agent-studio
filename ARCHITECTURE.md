# 系统架构

## 1. 架构目标

Minecraft Multi-Agent Studio 是硬件无关、模型供应商无关的模块化系统。任何业务模块不得绑定 DGX Spark、固定 GPU、固定 CPU 或固定主机名。

系统启动时通过环境检测模块读取实际硬件、软件和运行模式。检测结果只用于能力判断与调度建议，不用于假定设备性能。

## 2. 分层架构

```text
Dashboard / Installer
        ↓
API Gateway / WebSocket
        ↓
Coordinator / Policy Engine
        ↓
Bot Runtime / Deterministic Skills / L0 Safety
        ↓
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
└─ dashboard/              # Next.js 前端、服务端代理与真实状态 Store
packages/
├─ protocol/               # 版本化 Zod Schema
└─ environment/            # 真实硬件、软件和模式检测
```

尚未创建 AI Router、数据库和队列应用。Bot Runtime 已完成 Minecraft 1.21.8 隔离联机验收；Coordinator 已实现进程内 Bot 注册表和安全停止控制边界；Control API 已提供认证 HTTP/WebSocket 状态接口与受 `bot.stop` 保护的停止入口。Dashboard 通过服务端代理读取 Control API，浏览器不会收到长期令牌。

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
```

检测器不会执行模型文本、用户输入或远程下载内容。当前软件探针只有 Node.js、Java、Docker 和 Git；GPU 探针按平台选择固定的 CIM、lspci 或 system_profiler。

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
message sink (future Coordinator)
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

安全停止由 `StopController` 生成并再次校验 `StopBotCommandV1`，可信授权上下文必须匹配决策、操作者、Bot、命令、权限和有效期。命令通过传输适配器交给 Bot Runtime，Runtime 校验目标运行实例并返回 `BotStopResultV1`；Coordinator 只在确认身份完全匹配后更新离线状态。当前注册表、命令幂等缓存和审计记录均为进程内存，持久化与跨进程传输留给后续模块。

## 9. Control API 与实时状态流

```text
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

Control API 默认且当前只允许绑定 `127.0.0.1` 或 `::1`。服务端配置只保存令牌 SHA-256，不保存明文令牌；HTTP 使用 Bearer 头，浏览器 WebSocket 可通过 `minecraft-studio.v1` 与 `auth.<base64url-token>` 子协议认证。`bot.read` 允许读取基本状态，坐标还需要单独的 `bot.position.read` 权限。

列表和详情不会返回 `ServerProfile`、服务器地址、运行实例内部标识或原始错误。WebSocket 连接建立后先发送当前完整快照，再发送严格递增的 `upsert` 事件；客户端发送任何业务消息都会以只读策略关闭。

HTTP 停止入口只接受固定的优雅停止请求、UUID 幂等命令 ID 和具有 `bot.stop` 权限的服务端主体。Control API 将认证主体绑定为可信操作者，并通过注入的 `StopController` 等待 Runtime 确认。未注入控制器时返回 `CONTROL_UNAVAILABLE`，不伪造成功。

当前独立 Control API 进程没有跨进程 Bot 遥测和停止传输入口，因此没有共享 Coordinator 实例时会返回真实空列表，停止请求也会明确不可用。

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

## 11. 可观测性

`@minecraft-studio/observability` 提供统一 JSON 日志和受限的进程内计数器。日志固定带有时间、级别、服务、实例、事件以及 `traceId/taskId/botId/skillId/modelName`；不存在的关联值为 `null`。敏感键、常见令牌格式、换行和过深对象在写出前统一清理。

Dashboard 生成安全停止 UUID，并将它同时作为命令 ID 和追踪 ID。Control API 验证并透传该值，Coordinator 将其写入停止审计和日志，Bot Runtime 使用命令中的追踪 ID 记录请求与真实结果。响应再次返回 `traceId`，Dashboard 校验身份一致后显示给操作者。

Runtime 当前记录连接尝试、心跳、断线、计划重连、停止请求和停止结果。指标只存在于 Runtime 内存并可通过测试或运行时快照读取；Prometheus、集中日志和跨进程传输不在本模块中。

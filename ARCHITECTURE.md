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
└─ dashboard/              # Next.js 前端与环境检测 API
packages/
├─ protocol/               # 版本化 Zod Schema
└─ environment/            # 真实硬件、软件和模式检测
```

尚未创建 Coordinator、AI Router、数据库和队列应用。Bot Runtime 已实现但尚未完成隔离测试服联机验收，前端仍必须显示“待接入”。

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
- `StopBotCommandV1`：有期限、幂等命令 ID 和授权决策引用的安全停止命令。

```text
Bot Runtime
  ├─ BotStatusV1
  ├─ BotHeartbeatV1
  └─ BotDisconnectedV1
          ↓ strict Zod validation
      future Coordinator

API Gateway / Coordinator
  └─ StopBotCommandV1
          ↓ schema + trusted authorization context
      future Bot Runtime
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

运行时不包含服务器地址默认值，也不会扫描或自动选择服务器。只有显式设置 `BOT_SERVER_PROFILE_PATH` 后才创建 Mineflayer 客户端。

ServerProfile 只接受：

- `purpose=isolated-test`
- `auth=offline`
- loopback 或 RFC1918/本地 IPv6 地址
- 固定 Minecraft 版本、有限重连次数和有上限的超时

状态来自 Mineflayer 实例。无法可靠读取最大生命值、护甲或延迟时使用 `null`，不使用假定值替代。

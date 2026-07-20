# 故障排查手册

## 先记录追踪编号

Dashboard 安全停止结果会显示“追踪编号”。同一次操作在各层复用该 `traceId`，预期事件顺序如下：

1. `dashboard_stop_requested` / `dashboard_stop_result`
2. `control_api_stop_requested` / `control_api_stop_result`
3. `coordinator_stop_audit`，状态从 `started` 到最终状态
4. `bot_runtime_stop_requested` / `bot_runtime_stop_result`

在保存的 JSON 日志目录中查询，不要把令牌、确认码或服务器配置复制到工单：

```powershell
$traceId = '<Dashboard 显示的追踪编号>'
Get-ChildItem -LiteralPath '<日志目录>' -File -Recurse | Select-String -SimpleMatch ('"traceId":"' + $traceId + '"')
```

每条结构化日志固定包含 `timestamp`、`level`、`service`、`instanceId`、`event`、`traceId`、`taskId`、`botId`、`skillId`、`modelName`。尚无对应值时为 `null`，不能伪造。

## 常见问题

| 现象或错误码 | 处理 |
|---|---|
| `SERVER_PROFILE_REQUIRED` | 设置本地 `BOT_SERVER_PROFILE_PATH`；未设置时 Runtime 按设计拒绝连接。 |
| 配置拒绝公网或生产用途 | 只用 `isolated-test` 和 `loopback/private-lan`；不得放宽到正式服务器。 |
| `Minecraft 1.21.8 server SHA-1 validation failed` | 删除不匹配文件，从 Mojang 官方来源重新取得并核对版本与哈希。 |
| `Minecraft EULA has not been accepted` | 用户阅读并明确接受后手工设置；不得自动修改。 |
| 25565 已占用 | 查明占用者并由用户处理；脚本不会复用或结束未知进程。 |
| `MINECRAFT_VERSION_UNSUPPORTED` | 保留真实错误；升级锁定依赖并重新跑版本测试和隔离联机验收，不循环重连。 |
| Dashboard 显示 Control API 不可用 | 确认 API 已启动、本机令牌匹配且 URL 仍为回环地址。页面不会回退到假 Bot。 |
| Dashboard 显示“失联” | 检查最近心跳、Runtime 日志和重连计数；不要把旧状态改成在线。 |
| `CONTROL_UNAVAILABLE` | 独立 Control API 尚未注入跨进程 StopController，不能伪造停止成功。 |
| `STOP_TIMEOUT` | 用追踪编号核对 Coordinator 是否发出命令以及 Runtime 是否返回结果；状态保持不确定，不重复使用新命令冒充成功。 |

## 指标判断

Runtime 当前提供进程内快照：连接尝试、心跳、断线、计划重连、停止请求、停止结果。断线持续增长而心跳不增长时优先检查版本和网络范围；停止请求增长但停止结果不增长时按 `traceId` 检查控制传输。

当前没有 Prometheus 导出端点和集中日志系统；指标在进程重启后清零。跨进程遥测与停止传输尚未接入，因此完整四层链路当前由协议和进程内集成测试验证，独立启动时不能宣称已产生不存在的 Coordinator/Runtime 日志。

## 脱敏边界

日志组件会屏蔽授权头、Cookie、密码、令牌、API 密钥、AppSecret、私钥、服务器地址/主机/IP、位置和坐标，并清理换行及常见令牌格式。排障只记录稳定错误码和关联标识；不要记录原始请求、踢出原文、模型原文或秘密值。

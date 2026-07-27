# 安全策略

## 1. 当前安全边界

- 默认不连接 Minecraft；只有显式加载通过校验的本机或私有局域网隔离测试服配置后才允许连接。
- 禁止连接公网或正式 Minecraft 服务器。
- 不调用 Local AI Hub 或云端模型。
- 不执行模型输出。
- 不读取或展示主机名、用户名、IP、密钥和服务器密码。
- 不用模拟硬件、Bot 或服务状态替代真实错误。

## 2. 环境探测

环境探测只能执行源码中固定的白名单程序及固定参数：

- 当前 Node.js 可执行文件：`--version`
- `java --version`
- `docker --version`
- `git --version`
- Windows：只读 CIM 图形设备查询
- Linux：`lspci -mm`
- macOS：`system_profiler SPDisplaysDataType -json`

强制要求：

- 使用 `execFile`，`shell: false`。
- 不允许用户输入参与可执行文件或参数拼接。
- 设置超时和输出大小限制。
- 探测失败返回 `unavailable`、`unknown` 或 `probe_unavailable`。
- 原始系统错误不直接返回浏览器。

## 3. 依赖可信策略

- npm 依赖只从 `https://registry.npmjs.org/` 获取。
- 必须提交 `pnpm-lock.yaml`，并保留包完整性哈希。
- CI 和一键安装使用 `pnpm install --frozen-lockfile`。
- `pnpm-workspace.yaml` 只允许经过审核的 `sharp` 执行安装脚本，其他依赖脚本默认阻止。
- 新依赖必须记录包名、用途、版本、来源和许可证，并完成漏洞检查。
- Mineflayer 间接依赖使用的 `uuid` 统一覆盖为已修复的 11.1.1；覆盖前已确认调用面仅为兼容的 `uuid.v4()`。
- 不下载或执行聊天、模型输出、帖子、网盘或随机 URL 中的代码。
- 需要二进制资产时，必须使用官方发布源、固定版本和预期 SHA-256。
- WebSocket 服务端使用官方 npm Registry 的 `ws` 8.21.1，MIT 许可，锁文件保存 npm 完整性哈希；类型包固定为 `@types/ws` 8.18.1。
- Dashboard 状态管理使用官方 npm Registry 的 Zustand 5.0.14（MIT），完整性为 `sha512-/8tAspM5LMPr28b3fwLYrtdj77ECpfZviaP75CMTnwO8ISyaE4GDIG/9rDDYq/cH9D2Xw2A2RXglLInmVBQB/g==`。
- 浏览器验收使用官方 npm Registry 的 Playwright Test 1.61.1（Apache-2.0），完整性为 `sha512-8nKv6+0RJSL9FE4jYOEGXnPeM/Hg12qZpmqzZjRh3qM0Y7c3z1mrOTfFLids72RDQYVh9WpLEfR5WdpNX4fkig==`；本机验收复用已安装 Edge，未自动下载浏览器。
- 安全寻路使用 PrismarineJS 官方 `mineflayer-pathfinder` 2.4.5（MIT），来源为官方 npm Registry，完整性为 `sha512-Jh3JnUgRLwhMh2Dugo4SPza68C41y+NPP5sdsgxRu35ydndo70i1JJGxauVWbXrpNwIxYNztUw78aFyb7icw8g==`。
- Dashboard 使用 Next.js 16.2.11（MIT），完整性为 `sha512-B339zaqbyK8cmxhoAvLrcwoabwCP1wz21zSzfqxqXAemTu2BXnH7tQnfcglKv1vnMUIDBc+Hth7XODQriTZiRQ==`。
- Next.js 间接依赖 PostCSS 覆盖为 8.5.18（MIT），完整性为 `sha512-xdB1oSLHbz1vRWgCDalrCqEFTWzFlhqFC5tIHLMOSUIjhm3XXQ1qrFy8S/ESr1JYRRXqM3c1QFiMZUJdUTqyMQ==`；Sharp 覆盖为 0.35.0（Apache-2.0），完整性为 `sha512-BqvG5XbwPZ4NV0DK90d86leEECMsoa8bO0nqnKWlBDYxri4GJ7c4EDInaF6q20lTh/mATmnDIKWJFfXnoVfH5g==`。

## 4. 四种模式

- 标准模式：数据写入用户明确选择的应用数据目录。
- Docker 模式：禁止挂载 Docker Socket；使用非 root 用户和最小挂载。
- 便携模式：所有可变数据限制在经验证的便携根目录内，禁止使用系统根目录。
- 网吧模式：必须实现会话隔离、API 训练、成果导出、断点恢复和可验证安全清理后才可标记可用。

当前仅完成模式识别。未完成的模式能力必须显示“待接入”。

## 5. 模型安全

- 所有本地模型统一通过 AI Router 访问 Local AI Hub。
- 模型返回值只能作为候选结构化数据。
- 通过 Zod/JSON Schema、Policy Engine、权限、风险和技能白名单后才可进入任务系统。
- 模型不得直接运行 Shell、修改正式系统、连接 Minecraft 或执行游戏 Tick。

## 6. Bot 消息和控制授权

- 所有 Bot 消息使用严格 Zod Schema；未知版本、未知类型、缺字段、多余字段和越界值默认拒绝。
- 坐标必须是有限数值，维度必须使用命名空间格式。
- 自由文本设置长度上限，只作为日志数据，不允许转换成命令。
- `StopBotCommandV1` 只能来自 Coordinator 或 API Gateway。
- 消息内的授权声明不可信，必须与服务端授权上下文二次匹配。
- 授权必须绑定 `decisionId`、`actorId`、`botId`、`commandId` 和具体权限。
- 普通停止需要 `bot.stop`；紧急停止需要 `bot.emergency-stop`。
- 命令或授权过期后必须拒绝，不能自动续期或静默降级。
- Coordinator 只生成经过可信授权上下文二次匹配的停止命令；Bot Runtime 只执行目标运行实例一致且未过期的命令。
- 每个停止操作使用命令 ID 幂等，重复 ID 携带不同参数时拒绝执行。
- 停止结果必须由目标 Bot Runtime 返回，且 Bot、命令、运行实例、来源实例和追踪 ID 全部匹配。
- 停止传输有硬超时并使用 `AbortSignal` 通知取消；未收到确认时不伪造完成状态。
- 当前停止审计存于进程内存，尚未达到持久化审计要求，不可作为生产部署依据。

## 7. Coordinator 遥测边界

- Coordinator 在写入注册表前再次执行严格协议校验，仅接受来源为 `bot-runtime` 的遥测。
- `source.instanceId` 必须与负载中的 `runtimeInstanceId` 一致。
- 使用 `messageId` 去重，并按 `runtimeInstanceId + sequence` 拒绝重复、乱序和已退役进程的消息。
- 新 Runtime 接管后，旧 Runtime 的延迟心跳不能把 Bot 重新标记为在线。
- 超出允许时钟偏差的未来消息拒绝写入。
- 心跳或其他有效遥测过期后标记 `stale`，只有结构化断线或可信停止确认才标记 `offline`。
- 当前注册表是进程内真实状态，不会伪装成持久化数据库；进程重启后需要 Bot 重新上报。

## 8. Control API 边界

- 当前只允许绑定回环地址，不接受 `0.0.0.0`、公网 IP 或任意域名监听。
- 未配置至少一个有效令牌 SHA-256 时拒绝启动；服务端配置中不得保存明文 Bearer 令牌。
- 令牌摘要使用 SHA-256，并通过固定长度的时序安全比较完成匹配。
- HTTP 和 WebSocket 都必须具有 `bot.read`；坐标字段还需要 `bot.position.read`。
- 不信任 `X-Forwarded-For`，限流键只使用实际 TCP 对端和认证主体。
- HTTP 请求限制方法、路径、查询、请求体、Bot ID、头大小和协议版本。
- WebSocket 必须协商 `minecraft-studio.v1`，限制握手频率、每主体连接数、消息大小和发送缓冲。
- WebSocket 只推送状态；客户端发送业务消息时以策略错误关闭，不转换成命令或工具调用。
- 日志只记录稳定事件、错误码和认证主体，不记录令牌、服务器配置、位置或原始请求内容。
- 对外列表和详情不返回 ServerProfile、服务器地址或 Runtime 内部标识；坐标按权限脱敏。
- 所有内部异常统一转换为稳定 `INTERNAL_ERROR`，不把堆栈或底层错误返回客户端。

## 9. Dashboard 边界

- `DASHBOARD_CONTROL_API_TOKEN` 只能存在于服务端环境变量，禁止使用 `NEXT_PUBLIC_` 前缀或写入客户端 Store。
- Dashboard 服务端代理只接受 `http://127.0.0.1` 或 `http://[::1]`，拒绝公网、凭据 URL、路径、查询和重定向。
- 代理请求使用 4 秒超时，最多展开 100 个 Bot，列表与每个详情都执行严格 v1 Schema 校验。
- Zustand 只接收验证后的 Control API 数据；后端失败时清空 Bot、采集时间和停止能力，不保留在线显示。
- 停止确认码只保存 SHA-256，通过时序安全比较校验；浏览器提交明文仅用于本次同源请求，不写日志或 Store。
- Dashboard 停止 POST 要求同源 `Origin`、`Sec-Fetch-Site` 和专用动作头，并限制每进程每分钟最多 10 次确认尝试。
- Dashboard 只请求优雅停止；Control API 还必须验证 `bot.stop` 权限并收到 `StopController` 的真实结果。
- 独立 Control API 未注入停止传输时返回 `CONTROL_UNAVAILABLE`，Dashboard 必须展示错误，不能伪造完成。
- Playwright 模拟 Bot 仅存在于 `e2e` 测试目录，生产代码没有演示数据回退路径。

## 10. Mineflayer 连接边界

- 未设置 `BOT_SERVER_PROFILE_PATH` 时，Bot Runtime 必须以 `SERVER_PROFILE_REQUIRED` 退出，不尝试网络连接。
- ServerProfile 必须是严格 JSON，最大 64 KiB，不允许未知字段。
- `purpose` 只能是 `isolated-test`，`auth` 当前只能是 `offline`。
- `minecraftVersion=auto` 只对 ServerProfile 已批准的单一目标执行协议探测，不发现、扫描或尝试其他服务器。
- 固定版本必须存在于当前安装 Mineflayer 的真实 `testedVersions` 清单中，不接受手写的未知固定版本。
- 自动探测成功后上报真实解析版本和兼容等级；不能解析时明确上报 `unsupported`，不填造版本。
- 不支持版本是确定性错误，不自动重连；升级依赖后必须重新运行版本和真实隔离回归测试。
- 目标只允许 loopback、RFC1918、链路本地/唯一本地 IPv6 或 `host.docker.internal`。
- 公网 IP、任意域名、生产用途和配置内密码全部拒绝。
- 重连次数、退避时间、状态频率、心跳频率和停止宽限时间都有上限。
- 服务器返回的踢出和错误文本是不可信数据，只做长度限制与换行清理，不执行、不转成命令。
- 日志不记录服务器地址、玩家坐标、踢出原文、密码或令牌。
- SIGINT/SIGTERM 触发优雅停止；停止后不得再次重连。
- 真实联机验收脚本不会自动接受 Minecraft EULA，也不会自动下载依赖；缺少可信资产时立即停止。
- 验收前必须校验 Minecraft 1.21.8 官方服务端 SHA-1，并强制 `server-ip=127.0.0.1`、关闭 RCON/Query 和在线认证。
- 端口已被其他进程占用时拒绝复用或终止该进程，测试退出时只清理本次启动的子进程。

## 11. 日志与指标边界

- 结构化日志始终包含关联字段，缺失值必须是 `null`，不得用演示值填充。
- 日志写出前屏蔽授权头、Cookie、密码、令牌、API 密钥、AppSecret、私钥、服务器地址、主机/IP、位置和坐标。
- 常见 Bearer、GitHub 和 `sk-` 令牌格式即使出现在普通文本中也会脱敏；换行会被移除，字段、深度和长度有上限。
- 停止确认码、Bearer 明文、ServerProfile、玩家坐标和原始异常不得作为日志字段。
- 指标标签只接受有界标识符并拒绝敏感键。当前指标为进程内数据，重启清零，不能冒充持久监控。
- 日志失败不能改写已落地的审计结果；停止审计写入失败仍按安全策略阻止控制操作。

## 12. L0 安全动作边界

- L0 控制器只接收结构化的真实 Bot 快照，不读取自然语言、聊天、模型输出或服务器指令文本。
- 生命值、饥饿、氧气、速度、位置和背包数量必须是有限且有界的真实数值；无效快照拒绝决策并记录稳定错误码。
- 风险阈值、动作类型、动作时长和冷却固定在安全包中，模型和普通任务不能降低或覆盖。
- 普通任务在饥饿、低生命值、溺水、岩浆、坠落、卡死或背包满时暂停；恢复前必须由后续真实状态重新评估。
- Mineflayer 只执行类型化白名单动作；移动动作持续时间必须在 100 至 2000 毫秒内，结束后清除控制状态。
- 自动进食只允许固定安全食物清单中且当前 Registry 确认具有正食物值的物品，不吃腐肉、河豚、蜘蛛眼或未知物品。
- 危急生命值的紧急停止由 Bot Runtime 调用已有停止流程，客户端适配器不能执行或伪造完成。
- 安全日志只包含稳定风险码、动作码、结果和关联 ID，不包含玩家位置、服务器地址或原始异常。

## 13. 确定性技能边界

- 技能调用和结果必须使用严格 `Skill Protocol v1`，未知版本、未知字段、非 JSON 输入和超长有效期默认拒绝。
- 技能 ID 和版本必须精确匹配注册表；禁止 `latest`、模糊匹配或静默降级。
- 消息内授权只是引用，执行器必须与可信上下文中的来源、操作者、任务、Bot、调用、技能、版本和有效期逐项匹配。
- 每个技能必须声明输入、输出、状态 Schema、确定性前置条件、能力清单、超时、幂等性和有界重试策略。
- 非幂等技能最多执行一次；只有明确声明的稳定错误码可触发有限指数退避和抖动重试。
- 技能只能调用同时存在于技能声明和可信授权集合中的能力；不存在 Shell、文件系统、任意网络、Docker、数据库管理员或模型执行能力。
- 能力请求和响应必须为有界结构化 JSON；技能输出还要通过技能输出 Schema 与通用 JSON Schema 双重验证。
- 超时或取消后执行器禁止新的能力调用，能力适配器必须遵守 `AbortSignal`。当前进程内 JavaScript 处理器不是强隔离沙盒，不能将忽略取消的代码标记为已强制终止。
- 当前只注册 `movement.goto@1.0.0` 真实技能。目标必须匹配当前 ServerProfile 和维度，距离最多 64 格，半径 1～4 格，总超时 20 秒。
- Pathfinder 适配器固定关闭挖掘、搭塔、垫方块、开门、跑酷、冲刺和超过 2 格的下落；不能由技能输入重新启用。
- 同一 Bot 同时只允许一个 Pathfinder 调用。L0 暂停、Runtime 停止、断线和外部取消都会调用 `pathfinder.stop()`。
- 当前只完成离线单元和 Runtime 集成测试，尚未在真实隔离服验证跨版本路径行为，前端不得显示“实机寻路已验收”。

## 14. 任务持久化边界

- 任务命令使用严格 Schema，未知字段、自依赖、越界优先级、超长内容和无效坐标默认拒绝。
- 任务创建使用 `(idempotency_scope, idempotency_key)` 唯一约束和规范化 SHA-256 请求指纹；同一键携带不同参数必须拒绝。
- 每个状态、租约操作携带全局唯一操作 ID；重复 ID 只有在任务和指纹完全一致时才能返回已有快照。
- 当前任务行使用 `revision` 乐观并发控制，并在事务内 `SELECT ... FOR UPDATE`；状态更新和历史追加必须同时提交或回滚。
- 运行任务必须持有未过期且所有者匹配的租约；依赖任务未完成时禁止领取。租约时长限制为 1 秒至 5 分钟。
- R3/R4 任务在可信审批上下文尚未接入前一律禁止领取，不能依靠命令内字段自证批准。
- `studio_tasks` 禁止直接删除，`studio_task_history` 禁止更新或删除。取消、失败和过期通过状态与历史表达。
- 所有 SQL 使用固定语句和参数绑定，不拼接任务输入。唯一的动态 SQL 片段是源码固定的 `FOR UPDATE` 选择。
- 当前迁移尚未应用到真实 PostgreSQL，BullMQ 和 Redis 也未接入；不得把单元测试结果描述为数据库或队列服务在线。

## 15. 漏洞报告

发现疑似密钥或高风险漏洞时，停止相关模块，不在公开日志中粘贴秘密值，只报告文件位置、秘密类型和处置建议。

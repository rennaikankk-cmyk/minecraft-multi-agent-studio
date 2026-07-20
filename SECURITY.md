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
- 当前模块只定义和验证协议，不执行停止动作。

## 7. Mineflayer 连接边界

- 未设置 `BOT_SERVER_PROFILE_PATH` 时，Bot Runtime 必须以 `SERVER_PROFILE_REQUIRED` 退出，不尝试网络连接。
- ServerProfile 必须是严格 JSON，最大 64 KiB，不允许未知字段。
- `purpose` 只能是 `isolated-test`，`auth` 当前只能是 `offline`。
- 目标只允许 loopback、RFC1918、链路本地/唯一本地 IPv6 或 `host.docker.internal`。
- 公网 IP、任意域名、生产用途和配置内密码全部拒绝。
- 重连次数、退避时间、状态频率、心跳频率和停止宽限时间都有上限。
- 服务器返回的踢出和错误文本是不可信数据，只做长度限制与换行清理，不执行、不转成命令。
- 日志不记录服务器地址、玩家坐标、踢出原文、密码或令牌。
- SIGINT/SIGTERM 触发优雅停止；停止后不得再次重连。

## 8. 漏洞报告

发现疑似密钥或高风险漏洞时，停止相关模块，不在公开日志中粘贴秘密值，只报告文件位置、秘密类型和处置建议。

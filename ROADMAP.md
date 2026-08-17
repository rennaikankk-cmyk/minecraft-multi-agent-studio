# Minecraft 多智能体机器人项目路线图

更新时间：2026-08-17
当前阶段：阶段 1（安全执行底座）
当前状态：Runtime/Control Link 验收保持通过；CPU Resource Manager 第一阶段和 Bot Process Supervisor 第二阶段已完成本机门禁；真实 Minecraft 多 Bot 与 Intel 混合架构实体机门禁尚未执行

## 当前进度总览

项目已经具备可验证的单 Bot 安全执行底座，但还不是可直接投入使用的多智能体成品。

### 已完成并有本机或 CI 验证

- 环境检测、运行模式识别、版本化 Bot/Control/Skill 协议。
- 隔离测试服单 Bot Runtime、有限重连、优雅停止、Minecraft 版本/协议自动探测和 Skill 兼容变体解析。
- 可选 Bot Process Supervisor：一至三个 Bot 分组、部署等级故障域隔离、认证 IPC、优雅停止、有限崩溃恢复和 CPU workload PID 注册。
- CPU Resource Manager：可靠 CPU 拓扑探测、P/E Core 禁止猜测、generic fallback、CPU Pool、硬件建议和默认关闭的 affinity/scheduler。
- Coordinator 进程内注册表、Control API/WebSocket 契约、Dashboard UI 与浏览器测试。
- Runtime 与独立 Coordinator 之间的认证回环 WebSocket、遥测回执、停止确认、有限重连和失联安全停止。
- Coordinator 与 Control API 之间的双向 HMAC Control Link、原子状态快照/有序增量、断线 503 和固定停止 RPC。
- Dashboard 页面可见期间每 5 秒读取服务端主机或容器真实 Node OS 内存值；轻量采集不重跑软件/GPU 探测、不重叠、不持久化，失败或超过 15 秒没有成功样本时明确显示旧值已过期，页面从后台恢复后立即重采。
- 确定性 L0 安全控制器、技能框架、六个已注册通用 Skill，以及把可用性与跨版本实机验证分开的兼容目录。
- 任务 Schema、状态机、PostgreSQL 仓库、严格派发协议、事务 outbox、BullMQ Queue/Worker、自动对账器和隔离基础设施测试入口。
- 2026-07-28 本机门禁：类型检查、158 项离线测试、生产构建、5 项 Dashboard E2E 和生产依赖审计通过；11 项外部环境测试按设计跳过。
- 2026-07-28 GitHub Actions 运行 `30315095898`：完整离线质量门和真实 PostgreSQL/Redis 隔离集成门均通过。
- 2026-08-07 本机门禁：锁文件 258 个条目通过供应链策略，生产依赖审计无已知漏洞，`pnpm check` 通过，217 项测试通过、11 项外部环境测试按设计跳过，生产构建与 6 项 Dashboard E2E 通过；Runtime Link 双进程验收通过且 `minecraftConnected=false`。GitHub CI 结果等待本分支推送后验证。
- 2026-08-07 四进程服务级验收由两位执行者独立各运行一次，均退出码 0：生产 Coordinator、Control API、Dashboard 与测试专用 Runtime fixture 完成 `空 → online → stop completed → offline`，固定 `traceId` 贯穿四进程、关闭调用一次、凭据扫描通过、`minecraftConnected=false` 且无残留进程。该结果不是浏览器 E2E，也不代表真实 Minecraft 联机。
- 2026-08-08 本机隔离门禁：`pnpm check` 退出码 0，246 项离线测试通过、19 项外部环境测试按设计跳过，全部类型检查与生产构建通过；Runtime Link 双进程和四进程服务级验收均退出码 0、`minecraftConnected=false`。`test:task-infra` 因未提供专用 PostgreSQL/Redis/namespace 明确退出码 1，该文件的 17 项真实基础设施场景等待 CI，未冒充实机通过。
- 2026-08-11 本机门禁：`pnpm check` 退出码 0，292 项测试通过、20 项外部环境测试按设计跳过，全部类型检查与生产构建通过；本次验证没有连接 Minecraft。
- 2026-08-11 GitHub Actions 运行 `31480434428`：完整离线质量门和真实 PostgreSQL/Redis 隔离门均通过，18 项真实基础设施场景全部通过，包括 `0004` 前向升级、outbox 对账与自动过期租约恢复。
- 2026-08-14 本机门禁：`pnpm check` 退出码 0，305 项测试通过、20 项真实 PostgreSQL/Redis 或真实隔离 Minecraft 场景按设计跳过，全部类型检查与生产构建通过；新增测试只在随机回环端口模拟 1.8.8、1.12.2、1.16.5 和 1.21.11 协议握手，没有连接外部 Minecraft。
- 2026-08-14 Runtime Link 双进程与 Dashboard → Control API → Coordinator → 测试 Runtime 四进程回环验收均退出码 0，`minecraftConnected=false`、最终离线且客户端只关闭一次；GitHub CI 等本分支上传后确认。
- 2026-08-14 GitHub Actions 运行 `31793333384`：完整离线质量门、Runtime Link/四进程验收和真实 PostgreSQL/Redis 隔离门均通过；20 项真实基础设施场景全部通过，新增覆盖队列取消原子性、跨 Worker 取消和独立 Task Worker 子进程消费持久取消，且没有连接 Minecraft。
- 2026-08-17 Bot Process Supervisor 本机门禁：严格配置与 IPC 测试、真实子进程两 Bot 分组/优雅停止、首次崩溃退避恢复和 1/5/10/20 Bot 空 Host 合成 Benchmark 通过；没有连接 Minecraft，不能代替 P/E Core 实体机性能结论。

### 已完成并有真实基础设施验证

- PostgreSQL 迁移、`0004` 前向升级、并发操作重放/租约领取、outbox 对账、自动过期租约恢复和只追加约束已在 GitHub Actions 临时真实服务上通过。
- Redis/BullMQ 去重、续租、取消、超时、截止时间和显式幂等恢复已在临时真实服务上通过。
- 不合作处理器的有界 Worker 等待已通过真实超时场景；进程内处理器本身仍不是可强制终止的沙盒。

### 尚未形成生产闭环

- Control Link 状态、停止幂等缓存和审计仍在内存中；用户登录、持久化审计、跨主机 TLS 和密钥轮换尚未接入。
- 生产 Worker 配置与处理器、Coordinator 任务基础设施启动编排、任务 API 和 Dashboard 任务看板。
- 多 Bot 调度、生产技能、长期记忆、AI Router、本地规划和生产部署。
- 跨版本语义资源别名、显式服务端能力探针，以及六个 Skill 的真实多版本玩法矩阵。

## 路线图原则

- 每次只交付一个可验证模块。
- 不跳过现有项目审查，不无理由重构已有代码。
- 大模型只规划和选择白名单技能，不控制游戏 Tick。
- 先隔离测试服，后生产仿真，最后才考虑正式服务器。
- 所有模拟数据和未接入操作必须明确标注。
- 每个阶段必须通过类型检查、自动化测试和构建才能进入下一阶段。

## P0：最小真实状态链路

### P0.0 恢复项目基线

状态：**已完成**

- [x] 用户确认源码缺失时允许创建项目。
- [x] 读取项目级 `AGENTS.md` 和现有路线图。
- [x] 创建 pnpm TypeScript monorepo 基线。
- [x] 创建硬件无关的环境 Schema、检测 API 和前端页面。
- [x] 识别标准、Docker、便携和网吧模式。
- [x] 安装精确版本依赖并生成带完整性记录的锁文件。
- [x] 运行类型检查、单元测试、生产构建和本机冒烟测试。
- [x] 标记真实功能、模拟数据、空按钮和未完成接口。
- [x] 扫描密钥、危险命令、固定硬件绑定和生产依赖漏洞。
- [x] 补齐 `ARCHITECTURE.md`、`SECURITY.md` 和 `CHANGELOG.md`。

验收：形成可重复的基线命令，现有项目在未重构前达到可构建或明确列出原始故障。

### P0.1 版本化状态协议

状态：**已完成**

- [x] 在共享协议包定义 `BotStatusV1`、`BotHeartbeatV1`、`BotDisconnectedV1` 和 `StopBotCommandV1`。
- [x] 使用严格 Zod Schema 校验所有跨进程消息。
- [x] 每条消息包含 `schemaVersion`、`messageId`、`traceId`、`botId`、时间戳和来源实例。
- [x] 拒绝未知版本、未知类型、缺字段、多余字段和越界值。
- [x] 控制消息必须匹配可信授权上下文、目标 Bot、命令 ID、权限和有效期。

验收：协议单元测试覆盖合法、缺字段、越界值和未知版本。

### P0.2 单 Bot Runtime

状态：**已完成**

- [x] 只允许读取显式配置的隔离测试服 `ServerProfile`。
- [x] 使用 Mineflayer 4.37.1 创建单 Bot 客户端适配器。
- [x] 采集真实在线状态、血量、饥饿、护甲、位置、维度和延迟。
- [x] 实现心跳、断线事件、有限指数退避重连、优雅退出和状态清理。
- [x] 禁止在代码或 ServerProfile 中保存服务器密码。
- [x] 拒绝生产用途、公网地址、未知字段和非离线测试认证。
- [x] 离线单元与集成测试覆盖状态、重连和停止。
- [x] 在仅绑定 `127.0.0.1` 的 Minecraft 1.21.8 隔离测试服上完成真实连接验收。

验收：在隔离测试服完成连接、断线和停止测试；没有测试服时使用协议级测试明确标记“未联机验证”。

### P0.3 Coordinator Bot 注册表

状态：**已完成**

- [x] 接收并校验 Bot 状态、心跳和断线事件。
- [x] 维护 Bot 在线、离线、状态过期和最后心跳时间。
- [x] 使用运行实例、序列号和消息 ID 拒绝旧心跳、乱序和重复消息。
- [x] 安全停止命令带可信权限上下文、内存审计、超时、幂等和确认结果。

验收：集成测试覆盖正常心跳、乱序消息、重复消息、断线和状态过期。

### P0.4 WebSocket/API

状态：**已完成**

- [x] 提供只读 Bot 列表和详情 API。
- [x] 通过 WebSocket 推送版本化状态快照与增量事件。
- [x] 实现令牌哈希认证、细分授权、输入校验、请求限流和连接限流。
- [x] 断线重连后先发快照，再发严格递增的增量事件。
- [x] 日志和错误响应使用稳定错误码且不泄露服务器配置。

验收：API 与 WebSocket 集成测试通过，协议版本不匹配时安全拒绝。

### P0.4.1 Minecraft 版本自适应

状态：**已完成**

- [x] ServerProfile 支持 `minecraftVersion: "auto"` 和明确固定版本。
- [x] 自动模式只对已批准的隔离服务器执行 Mineflayer 原生版本探测，不扫描其他地址。
- [x] 固定模式只接受当前安装 Mineflayer 明确测试过的版本。
- [x] 上报真实解析版本、选择模式、兼容等级和当前适配器支持范围。
- [x] 区分已测试、兼容但未列入测试清单和不支持版本。
- [x] 不支持版本属于确定性错误，上报后禁止自动重连。
- [x] 使用 `auto` 配置在本机 Minecraft 1.21.8 隔离服完成真实连接验收。

验收：协议、ServerProfile、版本选择、Runtime、Coordinator 和 Control API 测试通过；真实隔离服在未预设版本时解析为 1.21.8。

### P0.4.2 Runtime ↔ Coordinator 认证链路

状态：**已完成；Control API 远程桥接未包含在本模块**

- [x] 新增独立 Coordinator Runtime Link 入口，仅绑定显式回环地址。
- [x] 使用严格 v1 握手 Schema 和每 Bot 共享密钥 SHA-256 完成双向 HMAC challenge，密钥不进入 URL、日志或仓库。
- [x] Runtime 在认证成功后才启动 Mineflayer；重连耗尽、队列溢出或身份异常时 fail-closed。
- [x] 遥测使用有界队列、单飞 ACK、同 `messageId` 重投和最新状态合并；Coordinator 继续按运行实例与序列拒绝旧消息。
- [x] 停止命令只路由到当前已认证运行实例，Abort、断线、超时或结果身份不一致时不报告成功。
- [x] 两个独立 Node 测试进程通过真实 `127.0.0.1` WebSocket 验证在线遥测、优雅停止、单次关闭、离线状态、审计顺序和跨进程 `traceId`；Coordinator 进程组合生产 Runtime Link/注册表/停止控制器，Runtime 进程使用生产 `SingleBotRuntime` 与测试专用 BotClient，未启动生产 `main`、Control API 或 Minecraft。

验收：协议、Runtime、Coordinator 单元/回环集成测试和 `test:runtime-link` 双进程验收通过；本项结果本身不代表后续 Control API/Dashboard 四进程或真实 Minecraft 联机验收。

### P0.4.3 Coordinator ↔ Control API 认证链路

状态：**已完成（服务级四进程验收）**

- [x] Control Link 只允许显式回环地址、固定 `/v1/control-link` 路径和 `minecraft-studio.control-link.v1` 子协议。
- [x] Coordinator 只保存 Control API 共享密钥 SHA-256，双方通过随机 nonce、方向绑定 proof 和时序安全比较完成双向 HMAC。
- [x] 所有帧使用严格 v1 Schema；帧、会话、快照增量缓冲、待处理停止和发送缓冲均有硬上限。
- [x] Control API 只在完整 `snapshot-begin/item/end` 后原子发布状态；快照不完整、序列跳号、身份变化、断线或 75 秒入站失活时清空镜像并让读取/停止返回 503。
- [x] 停止 RPC 固定为已确认的优雅停止契约，绑定同一操作 ID/追踪 ID、操作者、Bot、期限和仅 `bot.stop` 权限；超时、背压或结果身份不一致不报告成功。
- [x] 生产 Coordinator、Control API、Dashboard 与测试专用 Runtime fixture 通过真实回环四进程服务级验收；两位执行者各运行一次均退出码 0，覆盖空快照、在线、停止完成、离线、单次关闭、四进程 `traceId`、凭据扫描和无残留。

验收边界：`pnpm test:four-process` 不连接 Minecraft，验收中的 Runtime 是测试 fixture；它不是浏览器 Playwright E2E，也不证明正式 Minecraft、跨主机网络或持久化审计可用。

### P0.5 Dashboard 真实数据接入

状态：**已完成（UI 浏览器测试 + 四进程服务级验收）**

- [x] 实际项目没有既有机器人页或 Store，因此在保留环境页的基础上首次创建 Zustand Bot Store 和机器人区域。
- [x] 生产数据源固定为服务端代理后的 Control API；Playwright 夹具只存在于 `e2e` 测试目录。
- [x] 显示真实在线状态、血量、饥饿、位置、版本和当前任务。
- [x] 状态过期时显示“失联”，清晰区别于在线和离线，并禁用停止。
- [x] 安全停止要求确认弹窗、本地确认码、`bot.stop` 权限和真实 StopController 结果。
- [x] 后端不可用时清空 Bot 状态并显示错误，不回退成未标注的假数据。
- [x] 通过认证 Control Link 读取独立 Coordinator 的原子状态镜像并转发固定停止 RPC；链路断开时返回 503。
- [x] Dashboard 页面可见时每 5 秒真实轻量采集服务端主机/容器内存，不重新执行完整环境探测；失败或超过 15 秒没有成功样本时保留上次真实值但明确标为过期，恢复可见后立即重采。

验收：Playwright 覆盖在线、断线、失联、后端不可用、安全停止和 5 秒内存刷新；独立的四进程服务验收覆盖生产服务间真实回环传输。两类验收彼此独立，四进程脚本不驱动浏览器且不连接 Minecraft。

### P0.6 可观测性和运行手册

状态：**日志/指标契约和手册已完成；双进程与四进程服务追踪已验证**

- [x] 统一 `traceId/taskId/botId/skillId/modelName` 日志字段。
- [x] 增加连接、心跳、断线、重连、停止的基础指标。
- [x] 编写隔离测试服运行手册和故障排查手册。
- [x] 验证日志敏感键、常见令牌、服务器位置和换行脱敏。

验收：Runtime Link 双进程测试已使用同一 `traceId` 核对 Coordinator 与 Bot Runtime；四进程服务级测试已使用同一 `traceId` 核对 Dashboard、Control API、Coordinator 与测试专用 Runtime fixture。尚无集中日志或持久指标。

## P1：稳定执行和多 Bot 协作

### P1.1 L0 安全层

状态：**确定性代码与离线测试已完成；真实危险场景矩阵未完成**

- [x] 从 Mineflayer 真实状态采集氧气、水、岩浆、落地、垂直速度、背包占用、安全食物和移动请求。
- [x] 使用固定阈值检测饥饿、低/危急生命值、溺水、岩浆、坠落、卡死和背包满，不接受模型改写。
- [x] 安全层可暂停普通任务，并通过受限适配器执行吃安全食物、短距离撤退、上浮、离开岩浆、停止横向移动和脱困。
- [x] 危急生命值的紧急停止由 Bot Runtime 自身执行，不把停止权限交给模型或 Mineflayer 动作文本。
- [x] 状态协议、Control API 和 Dashboard 展示真实 L0 状态；缺失状态明确显示不可用。
- [x] 单元、运行时、进程内和浏览器测试覆盖关键边界；真实隔离服已验证正常连接状态。
- [ ] 在隔离服构造饥饿、低生命、溺水、岩浆、坠落和卡死场景并验证真实动作。

### P1.2 确定性技能库

状态：**已完成**

- [x] 定义严格版本化的 `SkillInvocationV1` 和 `SkillExecutionResultV1`，输入和输出只接受可验证 JSON。
- [x] 技能注册表按技能 ID 和明确 SemVer 版本解析，拒绝重复定义且不提供静默 `latest` 回退。
- [x] 每个技能声明输入、输出、真实状态 Schema、确定性前置条件和固定能力清单。
- [x] 可信授权上下文绑定来源、追踪、任务、Bot、调用、技能、版本、授权决策和有效期。
- [x] 执行器只暴露已声明且已授权的能力适配器调用，不暴露 Mineflayer、Shell、文件系统、网络或模型接口。
- [x] 实现有界超时、外部取消、稳定结果、输出复验和仅幂等技能可用的有限退避重试。
- [x] 协议与技能单元测试覆盖未知版本、定义冲突、前置条件、越权能力、授权不匹配、重试、取消、超时和错误输出。

### P1.2.1 Pathfinder 安全技能

状态：**已完成（离线验收）**

- [x] 从官方 npm Registry 精确锁定 `mineflayer-pathfinder` 2.4.5，并记录来源、许可和完整性哈希。
- [x] 注册 `movement.goto@1.0.0`，严格绑定 ServerProfile、维度、最大 64 格距离、1～4 格半径和 20 秒超时。
- [x] Bot Runtime 只暴露 `pathfinder.goto-safe` 能力适配器，禁止挖掘、搭塔、垫方块、开门、跑酷和冲刺。
- [x] L0 暂停、Runtime 停止、断线和外部取消会停止活动寻路。
- [x] 技能和 Runtime 离线测试覆盖权限、前置条件、安全配置和 L0 阻断。
- [ ] 在隔离 Minecraft 测试服执行多版本真实寻路场景。

### P1.2.2 多版本服务器事实与 Skill 兼容层

状态：**已完成（本机协议级与离线验收；真实技能矩阵未完成）**

- [x] 自动连接后上报真实 Minecraft 版本、协议号和主版本，不把协议 Schema 锁死为 `1.x` 命名。
- [x] 每个 Skill 声明有序兼容变体；通用能力用 `portable` 变体跨版本保留，新版本特色能力按真实 feature/资源/服务端能力启用。
- [x] 使用当前 Bot registry 和 `supportFeature()` 解析变体；服务端插件、数据包或规则能力只接受显式探针，不按版本号推断。
- [x] Runtime 执行前 fail-closed 校验兼容性，并通过 `BotSkillCatalogV1` 发布可用性、验证状态、选中变体和稳定原因。
- [x] Coordinator 绑定版本事实保存目录，新 Runtime 接管时清空旧目录，拒绝版本或协议冲突。
- [x] 纯回环夹具验证 Mineflayer 自动探测 1.8.8、1.12.2、1.16.5 和 1.21.11；测试不连接外部 Minecraft。
- [ ] 为规划器增加跨版本语义资源别名，并在真实隔离服逐版本执行六个 Skill 场景矩阵。

### P1.3 任务系统

状态：**本机离线门禁与真实基础设施 CI 已通过；生产闭环未完成**

- [x] PostgreSQL 任务、依赖和只追加历史表迁移。
- [x] 严格任务 Schema、状态机、重试预算和终态边界。
- [x] 创建幂等作用域/键、SHA-256 请求指纹和操作 ID 重放保护。
- [x] 乐观修订号、依赖完成检查，以及租约获取、续租、释放和过期处理。
- [x] 参数化 SQL 仓库在事务内更新当前状态并追加历史。
- [x] 严格 `TaskDispatchV1`、显式 `pg` 适配器、BullMQ Queue 和可嵌入 Worker。
- [x] 任务持久化精确处理器版本和幂等策略，派发与 Worker 注册表必须完全匹配。
- [x] 本地协作取消、持久超时、截止时间终态、实际续租断言，以及只允许精确版本幂等任务的过期租约显式重投边界。
- [x] Worker 对忽略 `AbortSignal` 的进程内处理器停止等待并释放持久租约；处理器代码仍需由后续隔离进程提供硬终止能力。
- [x] 固定服务镜像/Action 摘要的隔离 PostgreSQL/Redis GitHub Actions 测试入口。
- [x] 在真实 PostgreSQL 上运行迁移和并发集成测试。
- [x] 在真实 Redis/BullMQ 上验证队列去重、续租、取消、超时和显式重投。
- [x] 完成事务 outbox 与 PostgreSQL→BullMQ 自动对账重投；同事务创建、连续失败预算、异常记录封存和显式重派均已通过离线与真实基础设施门禁。
- [x] 增加 Coordinator 所有的有界过期租约恢复；`assigned` 任务恢复与新修订 outbox 同事务提交，`running` 任务按稳定原因进入失败终态，并发扫描不重叠，真实 PostgreSQL 场景已通过。
- [x] 增加持久取消消费、跨 Worker 取消和独立隔离 Worker；GitHub Actions 真实 PostgreSQL/Redis 场景已通过。
- [ ] 接入 Coordinator、Control API 和 Dashboard 任务看板。

### P1.4 多机器人协调

- 角色评分、任务分配、资源锁、箱子锁、区域锁、替补执行和故障恢复。

### P1.4.1 异构 CPU 资源调度

状态：**第一、二阶段完成；第三阶段实体机 affinity 接入待开始**

- [x] 第一阶段：可靠 CPU/NUMA/cpuset/P/E 分类探测、generic fallback、CPU Pool、硬件建议与合成策略门禁。
- [x] 第二阶段：Bot Process Supervisor、1～3 Bot 分组、部署等级隔离、认证 IPC、背压、优雅停止、有限崩溃恢复和活跃 PID 授权。
- [ ] 第三阶段：在 Intel 混合架构、AMD、旧 Intel、虚拟机、Docker 和权限受限主机验证进程 CPU affinity；生成可选 systemd 配置。
- [ ] 第四至七阶段：Pool 配额、Bot 状态优先级、监控页面和带冷却/滞后的动态调度。
- [ ] 第八至九阶段：自动硬件参数闭环与 Skill CPU 成本评分。

第二阶段不会迁移 Pathfinder；复杂寻路 Worker 需先定义 World Snapshot、Block Cache 和
Entity Snapshot 协议。旧 `pnpm bot:start` 保持回滚可用，affinity 和 scheduler 默认关闭。

### P1.5 生产技能

- 采集、合成、冶炼、箱子、物流、农业、建造和巡逻，逐项通过场景测试。
- [x] `inventory.equip-armor@1.0.0`——首个二档（GPL 参考、代码自研）技能：每槽选最优护甲、平手不换；离线单测 + 遥测日志可判定（2026-08-08）。
- [x] `collect.block@1.0.0`——MIT `mineflayer-collectblock` 1.6.0 + `mineflayer-tool` 1.2.0 供应链锁定接入；禁自动倒箱、与寻路互斥（2026-08-08）。
- [x] `craft.item@1.0.0`——自研（原生 recipesFor+craft），2x2/3x3，craftedCount 读回不伪造（2026-08-08）。
- [x] `world.place-block@1.0.0`——自研（原生 placeBlock），一次一块、放置后读回校验（2026-08-08）。
- [x] `container.transfer@1.0.0`——自研（openContainer+deposit/withdraw），容器白名单、movedCount 读回（2026-08-08）。
- [x] `smelt.item@1.0.0`（熔炉冶炼）——原生 `openFurnace`，显式燃料、空熔炉独占、异步等待、取消与真实产物读回；单次最多 5 件以遵守 60 秒技能硬超时（2026-08-11，离线测试通过，隔离服待验收）。
- [ ] `interact.sleep`（床/重生点）——防夜怪+锚定重生，原生 API 简单。
- [ ] 评估 `mineflayer-statemachine`（MIT）作为冷启动 8 步协议的编排框架——若与现有技能框架冲突则弃用（§14 约定）。
- [ ] 农业（种植/收割）、冶炼批量化、巡逻——待上面底座在隔离服过场景测试后推进。
- [ ] 隔离服场景测试：6 个已注册技能按 `docs/skill-verification-runbook.md` 逐个跑通并留档日志。
- [x] 一键 Minecraft 隔离验收框架：提供 `pnpm test:minecraft-skills`，自动启动仅绑定 `127.0.0.1` 的固定版本测试服、一次性世界和测试 Bot；只校验用户已显式接受的 EULA，不自动接受。真实熔炼场景仍等待本机隔离服材料执行。
- [x] 定义版本化技能场景清单，统一描述初始背包、世界方块、技能输入、预期库存/世界状态、稳定错误码和硬超时；7 个内置技能均覆盖成功、材料不足、权限/距离/维度拒绝、L0 抢占、取消、断线与部分成功读回。
- [x] GitHub Actions 增加手动或 `minecraft-acceptance` 标签触发的隔离服门禁；普通 PR 默认只跑离线门禁，Fork、Secret、私有服和正式服均被排除。工作流策略已离线校验，首次真实 Actions 运行待人工确认 EULA 后执行。
- [ ] 生成机器可读与中文验收报告，记录 Minecraft/Runtime/技能版本、场景通过数、真实产物、取消延迟、日志泄密扫描和残留进程；临时世界默认保留，只有显式清理参数才删除。

### P1.6 基础设施

- PostgreSQL、Redis、Prometheus、Grafana、日志聚合、备份、磁盘分层和 systemd/Docker 运行方案。

## P2：记忆、AI、自我改进和战斗

### P2.1 长期记忆

- 世界事实、箱子摘要、任务轨迹、失败经验、pgvector、Embedding 和 Reranker。
- **服务器硬隔离**：每个服务器是独立世界。位置类记忆必含 `serverProfileId` + 维度 + 坐标（NOT NULL，缺一拒绝写入）；查询在仓储层强制按当前 ServerProfile 过滤；pgvector 相似度检索先按服过滤再算相似度；跨服对比仅限战略层显式分析查询，结果不得直接下发为坐标类任务。

### P2.2 本地规划

- AI Router、Gemma 4、结构化任务图、技能选择、缓存、预算、超时和降级。

### P2.3 GLM-5.2 专家外脑

- 仅在失败阈值或高难任务触发；输入先压缩，输出只作为候选建议。

### P2.4 受监管自我改进

- 参数版本、策略验证、候选补丁、AST 检查、隔离沙盒、回归、金丝雀和自动回滚。

### P2.5 基地安全与撤离

- 永久 `COMPROMISED` 状态、证据记录、核心物资撤离和与所有暴露基地至少 10000 格的新址约束。

### P2.6 战斗隔离

- 普通战斗与生产 Bot 隔离；真实客户端桥接、高级 PvP 和末影水晶功能最后灰度接入。

## 后续交付路线

1. **已完成：P1.3.1 真实基础设施门禁**：GitHub Actions 中的 PostgreSQL/Redis 隔离测试已通过；测试没有连接 Minecraft。
2. **已完成：P0 Runtime Link**：Runtime ↔ Coordinator 的认证遥测与停止传输已通过真实双进程回环验收；测试没有连接 Minecraft。
3. **已完成：P0 Control Bridge**：Control API ↔ 独立 Coordinator 的原子状态镜像和固定停止 RPC 已通过不连接 Minecraft 的真实四进程回环服务验收。
4. **已完成：P1.3.2 持久任务闭环**：outbox/reconciler、自动过期租约恢复、持久取消、跨 Worker 取消和独立隔离 Worker 已通过真实基础设施 CI；生产处理器仍未接入。
5. **已完成：CPU 调度第一、二阶段**：可靠硬件探测与 Bot Process Supervisor 已通过离线和真实子进程门禁；未连接 Minecraft。
6. **CPU 调度第三阶段**：用已认证子进程 PID 表执行可选 affinity，并在 Intel 混合架构与 generic fallback 主机完成实体机门禁。
7. **P1.2.3 跨版本语义资源解析**：把规划器的“原木/石材/新版本特色物品”等语义选择解析为当前 registry 的真实资源与兼容变体。
8. **P1.1/P1.2 实机矩阵**：验证 L0 危险场景和六个 Skill 的多版本真实行为，不扩大正式服务器权限。
9. **P1.4 多 Bot 协调**：实现任务分配、资源/箱子/区域锁、替补执行和故障转移。
10. **P1.5/P1.6 生产能力与基础设施**：按场景逐项增加生产技能，再完善指标、日志、备份与可回滚部署。
11. **P2 智能层**：基础设施稳定后再接长期记忆、AI Router 和本地规划；受监管自我改进、基地撤离和战斗保持最后阶段。

## 当前唯一下一步

完成 CPU 调度第三阶段实体机 affinity 接入：使用 Supervisor 已认证的活跃子进程 PID 表应用 CPU Pool，在 Intel 混合架构与 generic fallback 主机验证权限失败不退出、池内多核心分配和可选 systemd 配置；默认仍保持关闭，不连接正式服务器。

# 变更记录

所有重要变更记录在此文件。项目采用语义化版本思路，当前处于早期开发阶段。

## [Unreleased]

### 新增

- 新增 `smelt.item@1.0.0`：使用 Mineflayer 原生 `openFurnace`，显式指定原料、燃料及数量，只接管空熔炉，异步等待并逐次取回真实产物；单次最多 5 件以保持既有 60 秒技能硬超时，取消/L0 抢占时 fail-closed，不自动重试非幂等熔炼。
- 新增 `inventory.equip-armor@1.0.0`——首个"参考 GPL 机制、代码全自研"技能（每槽选最优护甲、平手不换）；决策为可离线单测的纯函数，Runtime 只提供 `armor.snapshot`/`armor.equip` 原子能力，client 硬护栏拒绝非该槽护甲与背包没有的护甲。
- 新增生存链四技能：`collect.block@1.0.0`（MIT `mineflayer-collectblock` 1.6.0 + `mineflayer-tool` 1.2.0 供应链锁定接入，禁自动倒箱、与寻路互斥）、`craft.item@1.0.0`（自研，原生 recipesFor+craft，2x2/3x3）、`world.place-block@1.0.0`（自研，一次一块、放置后读回校验）、`container.transfer@1.0.0`（自研，openContainer+deposit/withdraw，容器白名单仅箱子/木桶/潜影盒）。裸装冷启动第一循环（走→撸木→合成→放置→撸石→穿甲→入库）技能层闭环。
- 技能结果日志 `bot_runtime_skill_result` 新增 `durationMs` 与白名单标量遥测摘要（`craftedCount`/`movedCount`/`itemsCollected` 等 10 键），单行日志即可判定技能在隔离服上可不可用；新增 `docs/skill-verification-runbook.md`（grep 起手式 + 失败签名表）。
- 所有产量类遥测（`craftedCount`/`movedCount`/`itemsCollected`）为操作后读回的实际值，部分成功如实上报；放置后读不回方块报 `PLACE_NOT_CONFIRMED`，可捕捉反作弊回滚。

### 安全

- 供应链新增 `mineflayer-collectblock` 1.6.0 与 `mineflayer-tool` 1.2.0（均 MIT，官方 npm Registry，精确版本+完整性哈希记入 SECURITY.md）；插件不直接暴露给 AI 或任务层，仅经技能接口包装。

### 新增（较早）

- 新增严格 Control Link v1 协议、Coordinator 回环服务端和 Control API 客户端，通过双向 HMAC 认证传输原子 Bot 状态快照、有序增量和固定优雅停止 RPC。
- Control API 生产入口改为在 Control Link 首个完整快照后才启动；运行中断线会原子清空镜像、关闭 Bot 状态流，并让列表、详情和停止返回 `503 CONTROL_UNAVAILABLE`。
- 新增 Dashboard → Control API → Coordinator → Runtime 四进程服务级验收。2026-08-07 由两位执行者独立各运行一次均退出码 0，覆盖 `空 → online → stop completed → offline`、固定 `traceId`、单次关闭、凭据扫描和无残留；使用测试专用 Runtime fixture，未连接 Minecraft，也不是浏览器 E2E。
- 新增 `EnvironmentMemorySample v1.0`、轻量 `/api/environment/memory` 和 Dashboard 页面可见期间的 5 秒真实内存刷新；只读取服务端主机/容器 Node OS 总量与可用量，不重跑完整环境探测、不持久化，失败或长期未成功时保留上次真实值并明确标为过期，页面恢复可见后立即重采。
- 新增严格 Runtime Link v1 握手与遥测 ACK 协议，复用既有 Bot 遥测、停止命令和停止结果，不引入可执行消息。
- 新增独立 Coordinator Runtime Link 入口和 Bot Runtime 客户端，通过真实回环 WebSocket 传输遥测与停止确认。
- 新增两个独立 Node 测试进程的 Runtime Link 验收：Coordinator 进程组合生产传输组件，Runtime 进程使用生产 `SingleBotRuntime` 和测试专用 BotClient，验证在线状态、优雅停止、单次关闭、离线结果、审计顺序和跨进程 `traceId`；不启动生产 Coordinator `main`、Control API 或 Minecraft。
- GitHub Actions 离线质量任务新增 Runtime Link 双进程回环验收，防止仅在单元测试转换环境中可用的传输代码进入主线。
- 新增严格 `TaskDispatchV1` 队列协议，固定 Coordinator 来源、消息版本、任务修订号、任务类型、处理器版本和幂等策略，拒绝未知字段。
- 新增显式 `pg` Pool 适配器、BullMQ 队列和可嵌入 Worker，支持领取、启动、续租、结构化完成、协作取消、超时和受限的过期租约重投。
- 新增 PostgreSQL 租约一致性迁移、事务级操作 ID 串行化、数据库权威时钟和有界过期租约查询。
- 新增隔离 PostgreSQL/Redis 真实集成测试及 GitHub Actions 工作流，覆盖迁移、只追加约束、并发重放/领取、队列去重、成功、取消、超时和幂等恢复。
- 新增不合作处理器超时、截止时间跨界、精确版本恢复和 UTC 截止时间规范化边界。
- 新增任务创建、历史与派发 outbox 的同事务提交、PostgreSQL→BullMQ 有界对账，以及 Redis job 丢失后的同一版本化消息重建。
- 新增严格 `TaskDispatchRetryCommand` 和原子重派操作：仅允许未过期的 `blocked` 任务生成新修订与新 outbox，相同操作精确重放，任何 outbox 写入失败回滚任务与历史。
- 新增 Coordinator 所有的有界过期租约恢复循环：启动即扫描、固定间隔运行且扫描不重叠；每项绑定任务修订号，预期并发冲突安全跳过，异常只记录稳定错误码。
- 新增原子 `recoverExpiredLease` 仓储边界：过期 `assigned` 任务转回 `queued` 时在同一 PostgreSQL 事务创建新修订 outbox；过期 `running` 任务进入 `TASK_LEASE_EXPIRED` 失败终态且不重派；相同操作精确重放，outbox 失败会回滚任务与历史。
- Dashboard 改版为多页面作战控制台：总览（环境检测 + 机器人计数摘要）、机器人、任务、作战四页导航。
- 机器人页接入 Control API 实时推送流：新增服务端 SSE 代理（`/api/bots/stream`，服务端以 Bearer 令牌连接 Control API WebSocket 流，令牌不出现在浏览器或转发载荷），每帧经协议 Schema 校验后转发，首个无效帧即断流（fail-closed）。前端流驱动更新（快照全量、事件增量、按 `streamSequence` 拒绝乱序），流不可用时明确标注"已退回 3 秒轮询"并指数退避重连。
- 机器人页新增详情抽屉，展示 `PublicBotDetailV1` 全部真实字段（护甲、饱和度、位置含脱敏提示、L0 风险、版本支持级别）；缺失字段一律显示"不可用"。
- 任务页与作战页为诚实占位：任务页明确标注 P1.3.2 任务 API 后端未接入，作战页仅含六类角色静态设计文案，两页均不展示任何模拟运行时数据。

### 安全

- Control Link 固定回环地址、路径、子协议、64 KiB 文本帧和有界资源；Coordinator 只保存 Control API 共享密钥 SHA-256，Control API 明文密钥只存在于自身环境变量，双方以随机 nonce 和方向绑定 HMAC proof 相互认证。
- Control API 状态镜像只在完整 begin/item/end 快照后原子提交；半包快照、序列跳号、身份变化或断线全部 fail-closed 为 503，不沿用旧在线状态。
- Control API 新增默认 75 秒入站存活看门狗；协议、序列、背压或失活先同步撤销镜像，忽略失败 socket 的排队帧并安全重连。Coordinator 身份变化会拒绝绑定旧实例的待处理停止，同时保持新链路可恢复。
- Coordinator 与 Control API 改用每次启动新生成的高熵 UUID 作为 boot identity，避免 PID 复用让跨重启旧停止操作被误判为同一会话。
- Bot 失联阈值迁移为实际由 Coordinator 读取并注入注册表的 `COORDINATOR_BOT_STALE_AFTER_MS`；删除已不生效的 Control API 旧配置，避免假配置。
- Control Link 停止固定绑定同一操作/追踪/授权 ID、操作者、Bot、短期有效期、仅 `bot.stop` 权限、5 秒宽限和 15 秒超时；身份不匹配、超时或背压不能转成成功。
- 5 秒内存接口使用严格 Schema、`no-store`、非重叠请求、4 秒超时和卸载 Abort；超过 15 秒没有成功样本或页面从后台恢复时会明确标记旧值并立即重采，不读取浏览器设备、不记录历史，也不以假值掩盖采样失败。
- 内存样本按 `capturedAt` 单调提交；较早启动但较晚返回的完整环境检测不会覆盖更新的轻量内存样本或把旧数据重新标为新鲜。
- Runtime Link 固定回环地址、路径、子协议、64 KiB 文本帧和有界资源，并拒绝带浏览器 `Origin` 的升级请求；每 Bot 共享密钥通过双向 nonce/HMAC challenge 完成相互认证，密钥不进入 URL、日志或仓库。
- Runtime 在控制链路认证成功后才启动；重连耗尽、关键遥测队列溢出、身份不匹配或协议异常时 fail-closed，不允许模型或消息直接执行。
- Worker 只调用任务、派发和注册表三方版本/幂等策略完全匹配的确定性任务处理器；队列消息不能携带模型文本、代码、Shell、URL 或任意字段。
- PostgreSQL 保持任务事实源；Redis 只用于消息投递和临时状态，BullMQ 自身重试固定为一次。
- 活动取消、超时和截止时间先传播 `AbortSignal`；Worker 有界停止等待和续租，并按 PostgreSQL 权威时间持久化终态。旧 job 重投要求租约真实过期、Bot 归属匹配、持久化处理器版本/幂等策略匹配且重试预算仍有余额。
- 本地并发取消采用首个请求优先，相同操作可重放，不同操作不会覆盖已有取消意图。
- 隔离测试只接受回环服务、专用 PostgreSQL Schema 和独立 Redis 前缀，不使用 `FLUSHALL`，不连接 Minecraft。
- CI 服务镜像和官方 Action 均固定版本及不可变摘要/提交；迁移执行前校验项目记录的 SHA-256。
- 新增前向 `0004` outbox 硬化迁移；旧坏行会在升级事务内封存，并将同修订任务按 PostgreSQL 时钟转为 `blocked` 或 `expired` 后追加历史，不改写已发布的 `0003`。
- Outbox 对缺失身份、未知协议结构、Bot 目标和任务执行合同不匹配采用 fail-closed；连续投递失败有界封存，成功确认清零失败预算，显式重派使用新修订和新消息，不伪造成功。

### 依赖

- 新增 BullMQ 5.81.2、`pg` 8.22.0 和 `@types/pg` 8.20.0，均来自官方 npm Registry，使用精确版本并由锁文件记录完整性；Coordinator 与 Bot Runtime 复用仓库已锁定的 `ws` 8.21.1 和 `@types/ws` 8.18.1。
- 明确禁止 BullMQ 间接可选原生依赖 `msgpackr-extract` 的安装构建脚本。

### 修复

- 将 Next.js 间接依赖 PostCSS 从 8.5.18 精确覆盖到 8.5.23，修复发布前生产依赖审计发现的 `GHSA-fxqj-rqcc-2cmp`；版本与 npm 完整性哈希写入锁文件和安全文档。
- 修复 Mineflayer CommonJS 包在原生 Node ESM 中使用命名导入导致生产构建无法加载的问题；Vitest 转换此前未暴露该错误。
- 修正 PostgreSQL 处理器版本检查约束的正则转义，使严格 SemVer 版本可在真实数据库中写入；同步更新迁移摘要。

### 当前限制

- Runtime ↔ Coordinator 已通过真实双进程回环验收，Dashboard → Control API → Coordinator → 测试专用 Runtime 已通过四进程服务级回环验收；后者没有连接 Minecraft，也不等同于浏览器 E2E 或正式服务器验收。
- Control Link 当前只支持同机回环，状态、停止幂等缓存和审计仍在内存中；跨主机 TLS、密钥轮换、用户登录和持久化停止审计尚未完成。
- 本机未检测到 PostgreSQL、Redis 或 Docker；2026-07-28 的 GitHub Actions 运行 `30315095898` 已通过真实临时 PostgreSQL/Redis 集成门，该结果不代表生产服务在线。
- 当前提供可嵌入 Worker 库和 Coordinator 过期租约恢复控制器，尚未提供独立生产 Worker 应用、Coordinator 任务基础设施启动配置、任务 Control API 或 Dashboard 任务看板。
- 当前已实现事务 outbox、PostgreSQL→BullMQ 对账、显式失败重派和自动过期租约恢复，但本机没有 PostgreSQL/Redis；新增升级、回滚、并发对账、异常封存和恢复场景已在 2026-08-11 GitHub Actions 运行 `31480434428` 的真实 PostgreSQL/Redis 门禁中 18/18 通过。持久取消消费和跨 Worker 取消仍未完成。
- 任务处理器是受信任的进程内代码，并非强隔离沙盒；不合作响应 `AbortSignal` 的代码在失去租约后仍可能继续运行自身副作用，硬终止需后续独立进程隔离。
- 没有注册生产任务处理器，本模块不会执行模型输出，也不会连接 Minecraft。

## [0.10.0] - 2026-07-27

### 新增

- 新增 `movement.goto@1.0.0` 确定性技能和 Bot Runtime 技能入口，通过精确授权的 `bot.move` 能力调用 Pathfinder。
- 新增 Pathfinder 安全适配器，目标绑定 ServerProfile 与维度，限制最大距离、半径、超时和单 Bot 并发。
- 新增 `@minecraft-studio/task-system`，包含严格任务 Schema、确定性状态机、重试预算、租约获取/续租/释放/过期和稳定错误码。
- 新增 PostgreSQL 任务、依赖和只追加历史迁移，以及带事务、参数化 SQL、创建幂等、操作重放和乐观版本检查的仓库适配器。

### 安全

- Pathfinder 固定禁止挖掘、搭塔、垫方块、开门、跑酷、冲刺和危险下落；L0 暂停、停止、断线或取消会终止活动路径。
- 任务使用作用域化幂等键、规范化 SHA-256 指纹和全局操作 ID；任务禁止删除，历史禁止更新或删除。
- 运行状态要求有效租约，依赖未完成禁止领取，状态和历史在同一 PostgreSQL 事务提交。
- 将 Next.js 升级到 16.2.11，并覆盖 PostCSS 8.5.18 与 Sharp 0.35.0，修复本次生产依赖审计报告的 12 项漏洞。

### 依赖

- 新增 PrismarineJS `mineflayer-pathfinder` 2.4.5（MIT），精确版本和 npm 完整性哈希已写入锁文件与安全文档。

### 当前限制

- Pathfinder 已通过离线单元和 Runtime 集成测试，但尚未在真实隔离 Minecraft 服务器执行路径场景或跨版本矩阵。
- PostgreSQL 迁移与仓库尚未连接真实数据库，Redis/BullMQ、Coordinator 任务调度、任务 API 和 Dashboard 任务看板仍未接入。

## [0.9.0] - 2026-07-27

### 新增

- 新增 `SkillInvocationV1` 与 `SkillExecutionResultV1`，固定跨服务字段、明确技能版本、有效期、授权引用和结构化结果。
- 新增 `@minecraft-studio/skills` 确定性技能库，支持精确版本注册、严格输入/输出/状态 Schema、前置条件和只读元数据目录。
- 新增可信授权上下文逐项绑定和能力声明/授权交集检查；技能只能通过结构化能力适配器调用受限操作。
- 新增超时、取消、输出复验，以及仅幂等技能可启用的有限指数退避和抖动重试。
- 新增协议和执行器测试，覆盖无效消息、重复版本、危险重试、授权不匹配、能力越权、前置条件、超时、取消和非法输出。

### 安全

- 不提供 `latest` 或静默版本降级；模型文本、Shell、文件系统、任意网络和原始 Mineflayer 对象不会进入技能执行上下文。
- 非幂等技能禁止自动重试，调用与结果只接受可验证 JSON，错误响应只返回稳定错误码。
- 超时或取消后禁止新的能力调用，能力适配器必须响应 `AbortSignal`。

### 当前限制

- 本模块只完成技能注册和受限执行框架，尚未注册真实生产技能，也未接入 Bot Runtime 的 Mineflayer 能力适配器。
- 执行器当前运行于同一 JavaScript 进程；处理器若忽略取消并执行纯 CPU 或自有副作用，无法被强制终止，因此尚不具备沙盒隔离保证。
- 技能调用尚未接入跨进程传输、任务持久化和审计数据库。

## [0.8.0] - 2026-07-20

### 新增

- 新增 `@minecraft-studio/safety` 确定性 L0 安全控制器，以固定阈值识别饥饿、低/危急生命值、溺水、岩浆、坠落、卡死和背包满。
- Mineflayer 适配器采集真实安全状态，并只执行有时长上限的白名单动作；食物限定为安全清单且要求真实食物元数据。
- Bot Runtime 在普通任务之前评估安全状态，串行执行安全动作，并自行接管危急生命值紧急停止。
- Bot 协议、Control API 和 Dashboard 新增可验证的 L0 安全状态、风险与最后动作结果。
- 新增安全决策、动作和失败指标，以及安全控制器与 Runtime 关键场景测试。

### 安全

- L0 策略不调用模型，不接受模型阈值或动作文本，非法物理状态会被拒绝。
- 动作种类、持续时间、冷却时间和可食用物品均由代码白名单固定；Runtime 停止不下放到客户端动作适配器。
- 日志只记录稳定风险码、动作码与结果，不记录坐标、服务器地址或底层异常。

### 当前限制

- 低血量撤退和脱困是有界控制动作，尚未使用路径规划选择真正安全位置。
- 坠落处理当前只停止横向移动，不声称具备落地、水桶或鞘翅救援能力。
- 背包满会暂停普通任务，但不会自动丢弃或搬运物品。
- 检测到饥饿但背包没有白名单安全食物时会保持暂停，需要操作者或后续确定性补给技能处理。

## [0.7.0] - 2026-07-20

### 新增

- 新增共享可观测性包，统一结构化日志、关联字段、脱敏和有界生命周期计数器。
- Dashboard 安全停止响应显示并校验 `traceId`，Control API、Coordinator 和 Bot Runtime 使用同一追踪编号。
- Runtime 新增连接尝试、心跳、断线、计划重连、停止请求和停止结果计数。
- 新增隔离 Minecraft 联机验收和故障排查运行手册。

### 安全

- 自动屏蔽授权、Cookie、密码、令牌、密钥、服务器地址、位置和坐标，并清理常见令牌文本与日志换行。
- 指标标签拒绝敏感键；日志失败不改写持久审计结果。

### 当前限制

- 指标只保存在 Runtime 进程内，尚无 Prometheus 导出或跨重启持久化。
- 独立进程间遥测和停止传输尚未接入；完整四层追踪当前通过协议与进程内集成测试验证。

## [0.6.0] - 2026-07-20

### 新增

- Dashboard 新增真实 Bot 状态区域和 Zustand Store，展示在线、离线、失联、血量、饥饿、位置、任务和 Minecraft 版本。
- 新增 Next.js 服务端 Control API 代理，浏览器无需接触长期令牌。
- Control API 新增受 `bot.stop` 权限保护的优雅停止 POST，并返回脱敏后的真实停止结果。
- 新增确认弹窗、本地确认码 SHA-256 校验、同源动作校验和确认尝试限流。
- 新增 Dashboard 服务端代理与 Store 单元测试，以及 5 个 Playwright 浏览器场景。

### 安全

- Dashboard 数据源固定为本机回环 Control API，拒绝公网 URL、重定向、无效协议和超出 100 个 Bot 的响应。
- 后端不可用时清空在线状态，不保留旧状态或回退到模拟 Bot。
- 未注入 StopController 时明确返回 `CONTROL_UNAVAILABLE`，不会假报停止完成。
- Playwright 测试夹具与生产运行时隔离。

### 依赖

- 新增 Zustand 5.0.14（MIT）和 Playwright Test 1.61.1（Apache-2.0），来源、精确版本和完整性哈希已记录并锁定。

### 当前限制

- 独立 Control API 尚无跨进程 Bot 遥测与停止传输入口，因此单独启动时会显示真实空列表，停止控制明确不可用。
- Dashboard 当前使用 3 秒服务端轮询；浏览器不会直接使用需要长期令牌的 WebSocket。

## [0.5.1] - 2026-07-20

### 新增

- ServerProfile 新增 `minecraftVersion: "auto"` 自适应选择，同时保留固定版本模式。
- 新增 `BotVersionV1` 遥测，报告选择模式、真实解析版本、兼容等级和适配器支持范围。
- Coordinator 和 Control API 保存并展示脱敏后的版本兼容信息。
- 示例隔离配置默认使用自动版本探测。

### 安全

- 自动探测只访问已经通过 ServerProfile 校验的单一隔离目标，不扫描服务器。
- 固定版本只接受 Mineflayer 4.37.1 真实测试清单中的版本。
- 不支持版本使用稳定兼容状态上报，并禁止确定性重连循环。
- 不解析或执行服务器返回文本，不在日志中记录服务器地址。

### 验收

- 当前安装适配器真实报告测试范围 1.8.8 至 1.21.11，共 27 个版本。
- 本机隔离配置未预设版本时，真实连接解析为 Minecraft 1.21.8，连接、停止、断线和有限重连 2 项测试通过。

## [0.5.0] - 2026-07-20

### 新增

- 新增只读 Control API：`GET /v1/bots` 和 `GET /v1/bots/:botId`。
- 新增 `/v1/bots/stream` WebSocket 状态流，连接后先发快照再发递增事件。
- 新增 `bot.read` 与 `bot.position.read` 权限，以及 SHA-256 令牌哈希认证。
- 新增请求、握手、连接、消息大小和发送缓冲限制。
- 新增 Control API 公开响应与 WebSocket 消息的严格 v1 Schema。

### 安全

- 默认且当前仅允许回环地址监听，缺少认证配置时拒绝启动。
- HTTP/WebSocket 输入、方法、路径、版本和 Bot ID 全部显式校验。
- 列表与详情移除 ServerProfile、服务器地址和 Runtime 内部标识；坐标按独立权限脱敏。
- 客户端 WebSocket 消息不会执行，并以只读策略关闭连接。
- 内部异常只返回稳定错误码，不返回堆栈、令牌或原始底层错误。

### 依赖

- 新增 `ws` 8.21.1 和开发类型 `@types/ws` 8.18.1，来源为官方 npm Registry，版本与完整性哈希已锁定。

### 当前限制

- Dashboard 尚未接入 Control API。
- 独立 API 进程尚无跨进程 Bot 遥测入口；没有共享注册表时返回真实空列表。

## [0.4.0] - 2026-07-20

### 新增

- 新增 Coordinator Bot 内存注册表，接收真实状态、心跳和断线遥测。
- 新增 `BotStopResultV1` 停止确认协议，以及 Bot Runtime 授权停止处理入口。
- 新增带权限、内存审计、硬超时、AbortSignal、幂等命令 ID 和结果确认的 `StopController`。
- 新增 Coordinator 与 Bot Runtime 进程内集成测试。

### 安全

- 注册表拒绝非 Bot Runtime 来源、来源实例不匹配、未来时间、重复、乱序和已退役运行实例消息。
- 旧 Runtime 被替换后，其延迟心跳不能恢复 Bot 在线状态。
- 停止命令绑定目标运行实例；确认结果必须匹配 Bot、命令、Runtime、来源实例和追踪 ID。
- 客户端关闭失败时返回明确失败结果，不伪造停止完成。

### 当前限制

- 注册表、幂等缓存和审计记录当前只存在于进程内存，Coordinator 重启后需要 Bot 重新上报。
- WebSocket/API、认证入口和持久化审计尚未接入。

## [0.3.1] - 2026-07-20

### 新增

- 新增可选的 Minecraft 1.21.8 真实隔离服务集成测试，默认测试套件不会启动游戏服务。
- 新增 Windows 验收脚本，编排本地服务启动、Bot 连接、正常停止、服务端断开、有限重连和清理。

### 验收

- 已在仅绑定 `127.0.0.1:25565` 的官方 Minecraft 1.21.8 服务端完成真实联机验收。
- Bot 两次真实进入隔离世界；正常退出和服务端关闭场景共 2 项测试全部通过。

### 安全

- 启动前校验官方服务端 SHA-1、EULA 状态、安全服务属性和端口占用。
- 不自动接受 EULA、不复用未知端口进程；本地服务文件、世界、日志和 ServerProfile 不进入版本库。

### 未接入

- Bot 遥测尚未发送到 Coordinator，Dashboard 仍不显示 Bot 在线状态。

## [0.3.0] - 2026-07-19

### 新增

- 新增基于 Mineflayer 4.37.1 的单 Bot Runtime。
- 新增严格 `ServerProfile v1.0`，仅允许本机或私有网络隔离测试服。
- 新增真实血量、饥饿、护甲、位置、维度和延迟采集适配器。
- 新增状态、心跳、断线消息、有限指数退避重连和优雅停止。
- 新增 Minecraft 1.21.8 隔离测试服配置示例。
- 新增 ServerProfile 与 Runtime 离线测试。

### 安全

- 未显式提供配置时拒绝连接。
- 拒绝公网目标、生产用途、配置内密码和未知配置字段。
- 不记录服务器地址、位置或服务器返回的原始不可信文本。
- 将 Mineflayer 两条间接依赖链中的 `uuid` 覆盖并锁定到已修复的 11.1.1。

### 未验证

- 当前没有用户提供的隔离测试服，因此 Mineflayer 真实联机尚未验证。
- Bot 遥测尚未发送到 Coordinator。

## [0.2.0] - 2026-07-19

### 新增

- 新增严格版本化的 `BotStatusV1`、`BotHeartbeatV1` 和 `BotDisconnectedV1` 遥测消息。
- 新增 `StopBotCommandV1` 安全停止控制消息。
- 新增统一消息信封、来源实例、状态序列号、运行实例和 Minecraft 维度约束。
- 新增遥测解析器和需要可信授权上下文的控制消息解析器。
- 新增未知版本、缺字段、多余字段、越界数据和授权边界测试。

### 安全

- 停止授权绑定决策、操作者、目标 Bot、命令 ID、权限和有效期。
- 普通停止与紧急停止使用不同权限。
- 消息内授权声明不能单独作为执行依据。

### 未接入

- 本版本只定义协议，不包含 Coordinator、Bot Runtime 或真实停止执行。

## [0.1.0] - 2026-07-19

### 新增

- 创建 pnpm TypeScript monorepo 基线。
- 创建 `EnvironmentSnapshot v1.0` Zod Schema。
- 自动识别标准、Docker、便携和网吧模式。
- 跨平台检测 CPU、内存、操作系统和 GPU 探测状态。
- 检测 Node.js、Java、Docker 和 Git 可用性。
- 新增真实环境 API 和响应式环境状态前端。
- 新增协议与环境检测单元测试。
- 新增架构、安全和中文运行文档。

### 安全

- 环境软件探针使用固定命令和固定参数，并禁用 Shell。
- 禁止依赖安装脚本自动执行。
- 依赖来源固定为官方 npm Registry，锁文件负责记录版本和完整性哈希。
- TypeScript 固定为 6.0.3，以兼容 Next.js 16.2.10 的构建期类型检查入口。
- 将 Next.js 的间接依赖 PostCSS 覆盖为 8.5.10，修复官方审计报告的 CSS 序列化 XSS。

### 未接入

- Bot Runtime、Coordinator、WebSocket、Minecraft 测试服和 Local AI Hub。
- Docker 镜像与一键安装器。
- 便携模式数据迁移。
- 网吧模式 API 训练、成果导出、断点恢复和安全清理。


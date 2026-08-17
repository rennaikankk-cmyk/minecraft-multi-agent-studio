# P-Core / E-Core Resource Manager 增量设计

状态：第一、二阶段已完成；真实 Minecraft 多 Bot 与默认启用均未开始
审计基线：`main@ebc278b`（2026-08-17）

## 1. 可行性结论

该功能可在现有架构上增量实现，不需要重写 Mineflayer Runtime、Coordinator 或任务系统。
原有 `apps/bot-runtime` 入口只创建一个 `SingleBotRuntime`，因此基线是“一进程一 Bot”，
并不是十个 Bot 共用一个 Node.js 事件循环。第二阶段已在外层增加可选 Supervisor，同时保留
`botsPerProcess=1..3` 的配置边界和旧单 Bot 回滚入口，没有重写 Runtime。

CPU affinity 只能约束内核可调度的进程/线程，不能把同一 JavaScript 事件循环里的不同函数
分别放到 P-Core 和 E-Core。因此：

- 当前 Bot Runtime 可以按进程分配 CPU Pool；
- `mineflayer-pathfinder` 当前仍在 Bot 进程内运行，只能与 Bot 共享 affinity；
- Pathfinder 跨 Worker 需要先建立 World Snapshot / Block Cache / Entity Snapshot 协议；
- PostgreSQL、Redis、Grafana 等外部服务只能通过可选 systemd/cgroup 或容器配置管理，
  不能由 Bot Runtime 假装拥有其 PID；
- BullMQ Worker 既有 `packages/task-system` 中的可嵌入类，也有 `apps/task-worker` 隔离验收入口；
  尚无生产处理器配置，后续只能对真实拥有的 Worker PID 注册资源。

## 2. 当前代码审计

| 领域 | 当前事实 | 本次边界 |
|---|---|---|
| Bot | 旧入口一进程一 Bot；可选 Supervisor 托管 1～3 Bot 进程组 | 已认证子进程 PID 注册 Pool；旧入口保持回滚 |
| Coordinator | 独立进程，维护 Bot Registry 与控制链路 | 只表达资源意图，不直接执行宿主 Shell |
| Pathfinder | `mineflayer-pathfinder` 在 Runtime 事件循环中执行 | 保持现有能力可用；快照 Worker 另设阶段 |
| Task Worker | 库内可嵌入 Worker 与隔离验收应用均存在 | 生产处理器出现后再按真实 PID 注册 |
| 环境探测 | 仅 CPU 型号/逻辑核、RAM、GPU | 扩展为可靠拓扑、cpuset、NUMA、容量类别与建议值 |
| 指标 | Runtime 内存指标，无 Prometheus 导出 | Phase 1 只提供真实快照；不伪造 CPU 页面数据 |
| Dashboard | 无 CPU Resource API/页面 | 等版本化遥测协议完成后再接入 |

## 3. 模块边界

新增 `packages/cpu-resource-manager`，保持零第三方运行时依赖：

```text
cpu-resource-manager
├─ cpu-set             Linux CPU list 严格解析、交集和格式化
├─ detect              CPU、物理拓扑、NUMA、cpuset、核心类别探测
├─ pools               realtime/performance/background/system 池
├─ priority            Bot State → CpuPriority
├─ affinity            可选 taskset/sched_setaffinity 抽象
├─ monitor             /proc/stat 轻量采样
├─ scheduler           cooldown/hysteresis/residency 纯策略
├─ hardware-profile    硬件建议计算（不是固定型号表）
└─ resource-manager    注册、提升、降级、释放和审计事件
```

控制面与执行面的职责分离：

- Coordinator/Skill Engine 只产生 `state`、`priority`、`deploymentTier` 等结构化意图；
- CPU Resource Manager 只在所在宿主机上把已验证 PID 分配到 CPU Pool；
- 资源管理器不读 Minecraft 密钥、不连接服务器、不执行任意 Shell；
- affinity 适配器只调用固定可执行文件和固定参数形状，失败返回 warning；
- 默认只允许管理当前 PID；Supervisor 已用自己的活跃子进程表显式授权，并在每次迁移/释放前复核；
- PostgreSQL 仍是任务事实源，CPU 调度状态不是业务事实，也不写入 Redis 当永久状态。

## 4. 绝不猜测 P/E Core

自动探测按可靠性分层：

1. `manual`：用户明确提供且通过 online/cpuset/不重叠校验的 CPU 集；
2. `exact`：Linux `/dev/cpu/<id>/cpuid` 的 Intel CPUID leaf `0x1A` 对每个逻辑 CPU
   返回明确 Core/Atom 类型；任何 CPU 缺失或出现未知值即放弃整组分类；
3. `capacity`：Linux 官方 `cpu_capacity` 只作为容量不对称观测信息；它不能单独证明
   Intel P/E 类型，因此仍使用重叠的 generic Pool，不启用分离 affinity；
4. `generic`：所有可用 CPU Pool 指向同一 cpuset，只使用并发、权重和 Nice 等软控制。

不得使用 CPU 编号顺序、最大频率、型号字符串或“有 SMT 就是 P-Core”等启发式规则。
容器和 systemd cpuset 必须把 `/proc/self/status` 的 `Cpus_allowed_list` 与 online CPU 取交集。

Linux 内核把 `cpu_capacity` 定义为 CPU 异构能力信息，并将容量归一化用于非对称容量调度：

- https://www.kernel.org/doc/Documentation/ABI/testing/sysfs-devices-system-cpu
- https://docs.kernel.org/scheduler/sched-capacity.html
- https://docs.kernel.org/scheduler/sched-energy.html

Affinity 和 cpuset 的实际交集、错误及权限边界以官方接口为准：

- https://man7.org/linux/man-pages/man2/sched_setaffinity.2.html
- https://man7.org/linux/man-pages/man7/cpuset.7.html
- https://man7.org/linux/man-pages/man1/taskset.1.html

Intel Core Type 使用每个逻辑处理器上的 CPUID leaf `0x1A`，设备访问与位定义依据：

- https://man7.org/linux/man-pages/man4/cpuid.4.html
- https://www.intel.com/content/www/us/en/developer/articles/guide/12th-gen-intel-core-processor-gamedev-guide.html
- https://www.intel.com/content/www/us/en/developer/articles/technical/intel-sdm.html

## 5. 迁移阶段

### 第一阶段：硬件检测

- 新包、严格 CPU set 解析、online/allowed 交集、物理核心/NUMA；
- exact/capacity/generic 三种诚实结果；
- `hardware-profile.json` 数据结构和按资源计算的建议值；
- AMD、旧 Intel、VM、Docker、低端 CPU 回退测试；
- 默认不启用 affinity 和动态 scheduler。

回滚：移除新包调用即可；现有 Environment Schema 保持向后兼容。

完成情况（2026-08-17）：

- 已实现 CPU identity、online/cpuset 交集、物理核心、NUMA、`cpu_capacity` 和 CPUID 0x1A；
- 只有 exact/manual 分类生成分离 affinity Pool；capacity-only 仍使用重叠 generic Pool；
- 已实现 CPU/RAM/Disk/GPU/Network 的 `hardware-profile.json` 显式生成命令；
- 已加入 AMD、VM/CPUID unavailable、cpuset unavailable、非 Linux、4C4T 降配等测试；
- Affinity、scheduler 和 Bot process 分组开关默认全部关闭；现有启动路径未接入。

### 第二阶段：Bot Process / Worker 分离能力

- 新增 Bot Supervisor，配置 `mode=process`、`botsPerProcess=1..3`；
- 先复用现有 Runtime Link，一个子进程仍只持有获批 ServerProfile；
- 进程崩溃域、优雅停止、IPC 背压和独立验收；
- 不在本阶段迁移 Pathfinder。

回滚：Supervisor 配置回到现有单 Runtime 启动命令。

完成情况（2026-08-17）：

- 新增固定入口 Bot Process Supervisor，支持 `botsPerProcess=1..3` 和按硬件建议选择分组大小；
- 正式、灰度、测试和批处理按部署等级隔离故障域，不把测试 Bot 与正式 Bot 混合分组；
- 新增双向 HMAC 的版本化 Node IPC、启动清单上限、发送背压、Profile 摘要复验和父链路断开 fail-closed；
- 新增优雅停止、滑动窗口崩溃预算、指数退避、稳定驻留重置和预算耗尽停止自旋；
- 已认证子进程 PID 接入 CPU Resource Manager 授权表，退出时释放；CPU/affinity 失败只告警；
- 真实子进程验收覆盖两 Bot 分组、优雅停止和首次崩溃后恢复；合成 1/5/10/20 Bot 无崩溃或超时；
- 旧 `pnpm bot:start` 保留为独立单 Runtime 回滚入口。

详细边界见 `docs/bot-process-supervisor-phase2-2026-08-17.md`。

### 第三阶段：CPU affinity

- Linux taskset 适配器先行，后续可替换原生 `sched_setaffinity` 叶子适配器；
- 始终分配 CPU 集而非单颗 CPU；
- affinity 失败只产生 `CPU_AFFINITY_FAILURE`，不退出 Bot；
- systemd drop-in 由探测结果生成，不提交固定 CPU 编号。

回滚：`affinity.enabled=false`。

### 第四阶段：CPU Pool

- 建立 realtime/performance/background/system；
- generic 平台的池允许重叠；
- 配额只限制进程/Worker 并发，不把 Pool 当独占锁。

回滚：`mode=disabled` 或全部池回到 systemPool。

### 第五阶段：任务优先级和 Bot 状态

- 引入 `CpuPriority` 与 `BotState`；
- Runtime 只上报真实状态转换，不按 Bot ID 写死；
- 正式、灰度、测试、批处理按部署级别作词典序排序；
- CRITICAL 可立即提升，降级须经过 cooldown。

回滚：保留状态遥测，禁用 scheduler。

### 第六阶段：监控

- 增加版本化 CPU Resource 遥测和 Control API 只读端点；
- Dashboard 只显示后端真实数据；不可用时明确标记 unavailable；
- Prometheus 导出在指标包扩展后接入。

回滚：隐藏页面路由，不影响 Bot。

### 第七阶段：动态调度

- 采样间隔 1～5 秒；
- event-loop lag、tick delay、Pathfinder/BullMQ/数据库延迟由各进程上报；
- cooldown、hysteresis、minimumResidencyTime 防止抖动；
- 正式 CRITICAL 任务可回收测试进程的 performancePool 资格。

回滚：`scheduler.enabled=false`，保留静态 Pool。

### 第八阶段：自动硬件参数优化

- 使用可用核心、核心类别、RAM 和目标 Bot 数计算建议值；
- N100/N150/N250/4C4T 自动降低 Bot 进程、Pathfinder Worker 和测试并发；
- 建议值必须可人工覆盖并记录来源。

回滚：锁定用户配置，忽略推荐值。

### 第九阶段：Skill 自进化指标

- Skill 结果增加 CPU time、wall time、event-loop lag、Worker/Pathfinder latency、峰值内存；
- 评分同时考虑成功率、速度、资源成本和稳定性；
- 性能指标只影响候选排序，不能绕过安全和正确性门禁。

回滚：停止把性能维度送入候选评分，不删除原始审计数据。

## 6. 性能门禁

第一阶段只运行探测/策略微基准，结果明确标记为 synthetic，不能据此默认开启 scheduler。
真实默认启用前必须在隔离环境完成 1/5/10/20 Bot 的 OFF/ON 对照，并覆盖 Idle、聊天、移动、
采矿、同时寻路、建筑、大量实体、PvP、测试并发和数据库高负载。至少记录 CPU Pool 利用率、
event-loop lag、Bot/Pathfinder 延迟、RAM、超时和崩溃。

只有 ON 在关键实时指标上改善且其他场景不退化，才允许把默认值从关闭改为开启。

第一阶段的合成结果见
`docs/benchmarks/cpu-resource-manager-phase1-2026-08-17.md`。它只验证策略计算足够轻量，
不构成默认启用依据。

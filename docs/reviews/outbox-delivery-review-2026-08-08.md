# Outbox 派发硬化审查（commit a0559af）—— 2026-08-08

审查对象：Codex 提交 `a0559af feat(task-system): harden durable outbox delivery`
（事务 outbox + PostgreSQL→BullMQ 对账 + 严格重派）。

## 结论

核心保证**成立**，无 BLOCKER。已验证：

- **事务 outbox**：task + dependencies + history + dispatch-outbox 在同一 `COMMIT`
  之前完成；任一 outbox 写失败进 `catch → rollback`，task 与 history 一并回滚。
- **不伪造投递**：`markTaskOutboxDelivered` / `retryTaskOutbox` 均以
  `status='claimed' AND claimed_by=$claimer` 为门；claim 丢失返回 `false`，
  reconciler 抛错而非 ack。
- **幂等**：`ensureDispatchOutbox` 用 `ON CONFLICT (task_id,expected_revision,type)
  DO NOTHING` + `FOR UPDATE`；`findOperationReplay` 拒绝同 operationId 不同指纹；
  jobId 确定性。无重复插入 / 不同操作覆盖。
- **失败预算**：投递成功 `attempt_count=0` 归零，`MAX_TASK_OUTBOX_ATTEMPTS` 封顶，
  退避有界；`clampInteger` 抛 `RangeError` 不静默截断。
- **迁移 0004**：前向 only，坏行在升级事务内封存并追加历史，不改写已发布的 0003。

离线验收（本机，无 PG/Redis）：`task-system` 类型检查 0；离线单测 58 项通过
（新增 3 项回归）；`real-infrastructure` 17 项真实基础设施场景在缺 env 时由
`test:task-infra` 明确 exit 1（fail-closed，不伪装通过），待 CI。

## 已修（本轮）

**[CONCERN] 已完成的 BullMQ job 被当作已投递 → 孤儿排队任务**
`outbox-reconciler.ts ensureEnqueued` 原逻辑只在 job 状态为 `"failed"` 时移除重投，
其余状态一律 `enqueue`（对已存在 job no-op）后 ack。若持久任务仍为 `queued` 而 job
处于终态 `"completed"`（worker 已跑完但 DB 状态写丢失），会把 outbox 标记为 delivered，
留下一个没有可运行 job 的排队任务——属伪造成功。
**修复**：引入 `LIVE_DISPATCH_JOB_STATES`（waiting/waiting-children/prioritized/
active/delayed）白名单，只有确认存活的 job 才 ack；一切终态或**未识别**状态一律
移除并重投（fail-closed on unknown state）。新增 3 项回归测试覆盖 completed /
unknown / active。

## 待办（留给后续，未改）

- ~~**[CONCERN]** `claimTaskOutbox` 把 `status='delivered'` 也纳入认领~~ **已修
  （后续提交）**：`retryTaskOutbox` 的死信判定加 `delivered_at IS NULL` 条件——
  已投递过的行投递重查失败时只回 `pending` 等待下次重查，永不翻 `failed`、
  永不触发 `blockTaskAfterOutboxFailure`；失败预算只约束**从未投递成功**的消息。
  纯查询语义修正，无迁移、无 CHECK 约束改动（`delivered_at` 列 0003 已有）。
  新增回归：`never dead-letters an already-delivered row during a Redis outage`。

- **[NIT] 迁移 0004 历史 INSERT 无去重**：同 `task_id/expected_revision` 的两条失败
  outbox 会各发一条 `dispatch-blocked` 历史，且 `operation_id = message_id` 可能与运行时
  `blockTaskAfterOutboxFailure` 复用同 messageId 的操作撞号。

- **[NIT] `getTaskOutbox` 解析失败静默返回 `null`**（status='failed' 时）。仅为巡检读
  路径，可接受，但属 fail-open 读；如被调度决策依赖需收紧。

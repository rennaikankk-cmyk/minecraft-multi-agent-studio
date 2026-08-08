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

- **[CONCERN] `claimTaskOutbox` 把 `status='delivered'` 也纳入认领**
  （`postgres-repository.ts` 认领查询 `outbox.status IN ('pending','delivered')`）。
  Redis 长时间不可用时，一条**已投递**的行可能在重复对账中累计失败直到预算耗尽而翻
  `failed`，进而 `blockTaskAfterOutboxFailure` 阻塞/过期一个其实已投递的任务。
  需要区分"已投递待确认 worker 消费" vs "待投递"，或给 delivered 行单独的确认对账
  路径而非计入投递失败预算。**牵涉迁移与 CHECK 约束，需专门设计，不在本轮草率改。**

- **[NIT] 迁移 0004 历史 INSERT 无去重**：同 `task_id/expected_revision` 的两条失败
  outbox 会各发一条 `dispatch-blocked` 历史，且 `operation_id = message_id` 可能与运行时
  `blockTaskAfterOutboxFailure` 复用同 messageId 的操作撞号。

- **[NIT] `getTaskOutbox` 解析失败静默返回 `null`**（status='failed' 时）。仅为巡检读
  路径，可接受，但属 fail-open 读；如被调度决策依赖需收紧。

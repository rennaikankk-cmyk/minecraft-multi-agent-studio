# V2 物资与物流接线

`@minecraft-studio/resource-management` 是物资状态的单一权威；旧 skills 路径仅重导出同一实现。它不创建任务循环、不连接 Minecraft、不绕过资产权限。Coordinator 的 `CoordinatorResourceService` 使用既有任务仓库的 `submitTask/getTask` 和任务处理器接口。

## 已实现的闭环

Runtime 通过已认证主体提交实际观测，Coordinator 验证当前 botId/runtimeInstanceId/server/world/dimension 和物品 catalog 身份。未观测数量用 `null`；箱子 TTL 为 10 秒，背包/装备为 5 秒，调用方不能延长。背包和穿戴装备是两个互斥池；同一 Bot 改变背包标签不会增加一份库存。潜影盒只记录盒子这个物品，不推测内部库存。

物品身份为 itemId + Minecraft 版本 + catalog ID + 类型 + 组件指纹。带耐久/附魔/组件的物品必须有组件指纹；普通已验证材料才可标记 `plain`。现有 `container.transfer` 技能按名称选栈，因此服务目前只自动领取 plain 材料，拒绝不能精确选栈的装备及组件变体。

需求按作用域、Bot、精确物品、用途合并。先核对自身背包/已穿装备，再查询已观测且授权的共享库存/输出端。未观测自身背包时先等待观测。可领取量减去预留和最低保留量，并检查可达性、用途、权限修订、资产版本和权限期限。领取不会把玩家/漏斗当作受预留约束的写入方。

`planTransfer` 在一次原子快照提交中写入需求尝试次数、数量预留、operationId/taskId、源/目标和任务投递 outbox。`drainOutbox` 调用现有 `PostgresTaskRepository.submitTask`；仓库的既有任务 outbox/BullMQ 执行投递。若仓库已提交但资源 outbox 确认丢失，重放使用完全相同的 taskId、operationId、请求指纹；不会另生成取货任务。领取任务 `executionIdempotent=false`、`maxRetries=0`。

任务执行时重新读取既有任务租约、Bot 分配、当前 Runtime 和资产许可，再持久保存 attemptId/fence 后调用技能。处于 dispatched/partially-confirmed/reconciling 的订单不能重复执行。超时、断线、L0 抢占或取消后的源库存被隔离，即使收到新的箱内数量也不会盲目允许再次分配。

回执必须匹配已派发的 task/operation/attempt/fence/Bot/runtime/server/world/item。相同 receiptId 的重复回执幂等；内容变化拒绝。租约已过期或任务已取消后仍接受匹配旧尝试的真实副作用证据，但不会据此允许旧执行者继续操作。持有的数量预留在执行租约/预留到期两分钟后可释放；未决源库存仍保持隔离，直至对账。

订单必须有有效执行回执，以及之后重新读取的源与目标观测，才可 settle。对账不要求箱子减少量等于 Bot 增加量，也不把漏斗/玩家造成的全部变化归到 Bot。只有“箱子现在少了几个”不能作为领取成功证据。实际收到少于请求量时保持 `partially-confirmed`，对账完成后才允许规划剩余缺口。

## Root 集成接口

1. 在 main 构造 `CoordinatorResourceService({ persistPath, taskPort, currentRuntime, validateItem, authorize, executeSkill, reobserve })`。`taskPort` 可直接使用既有 `PostgresTaskRepository`；本地模式必须提供真正持久、按相同 operationId 幂等的适配器，不能直接调用原始取货动作充当 submit。
2. `currentRuntime(botId)` 返回现有 BotRegistry 的当前已认证身份及 scope。`validateItem` 查询该 Minecraft 版本 catalog。`authorize` 调用当前资产权限权威，返回 allowed/reachable/purpose/policyRevision/assetVersion/expiresAt/minimumKeep；不可使用前端自报许可。
3. 认证后观测入口调用 `service.observe(body, authenticatedPrincipal)`。principal 必须由认证层产生。读取入口调用 `service.ledger.snapshot(scope)`，只返回授权 scope。`worldId=null` 可保存观测，但拒绝自动分配。
4. 生存/设施模块使用 `ledger.demand(...)`、`service.chooseSupply(...)` 和 `service.planTransfer(...)` 提交意图。复用现有 Coordinator 调度 tick 调用 `drainOutbox()` 和 `ledger.expireReservations()`；服务本身没有 timer。
5. 在现有 `TaskHandlerRegistry` 或 Coordinator 任务桥注册 `service.taskHandler()`，类型 `resource.transfer@1.0.0`。`executeSkill` 通过既有分配、技能调用和 Runtime 动作锁执行 `container.transfer`。`reobserve` 仅重新读取源容器和实际背包，不能发起新取货。注册 handler 是必需的，单独添加 ledger 或只显示 UI 不会执行物流。
6. Handler 在独立回读完成后 settle；未提供回读或回读失败时，任务明确返回 `RESOURCE_RECONCILIATION_REQUIRED`，订单保留未决。不得把这类结果显示为完整转运成功。人工/恢复对账可在新观测后调用 `ledger.reconcile(...)`。
7. 延迟 Runtime 回执入口使用 `service.recordReceipt(receipt, authenticatedPrincipal)`，不会因当前 Runtime 已被替换而抛弃匹配已持久化尝试的证据。此接口不授权任何新动作。

## 持久化和限制

桌面适配器明确为 `durability: file`，内存适配器只用于显式测试。每次变更先在副本完成验证，在独占短文件锁下比较快照 revision，再临时文件/fsync/rename 提交；写失败不会发布半份内存状态。scope、物品、预留、需求、订单、回执和 outbox 均随同一版本化快照恢复。损坏文件、跨版本旧原型快照和 CAS 冲突明确拒绝。

该文件适配并不是 PostgreSQL 实现。生产 PostgreSQL 资源表/事务适配尚未接入，不能据此声称分布式永久事实存储完成。若进程在持有文件锁时被硬杀，残留 `.lock` 会 fail-closed，需要确认无写者后恢复；不会自动猜测删除锁。Windows 不宣称目录 fsync 的掉电保证。

当前自动执行链覆盖容器 → 领取者背包。背包 → 目标容器的存储、跨维度/跨 Bot 分段运输、精准组件栈选择和工位复用仍需现有技能/任务适配继续接入。本模块提供物资来源选择及缺口事实，不自行启动合成/采集或另一套工位建造循环。实际 HTTP/主循环/Runtime 观测接线由 Root 集成；本子任务没有修改 main/shared-state-server，也没有连接外部服务器。

验证包括原子写失败、多个 Bot 的并发需求、TTL、最低保留量、作用域/物品隔离、文件重启、部分回执、重复回执、取消后的晚到副作用，以及使用既有 TaskSubmitCommand 和租约的 Coordinator 技能桥测试。模拟技能结果均为测试夹具，不是 Minecraft 实服证据。

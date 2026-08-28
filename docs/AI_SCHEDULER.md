# AI Request Scheduler

`@minecraft-studio/ai-router` 提供 U9 侧统一 AI 请求调度。DGX Spark 只运行推理后端；Bot、Coordinator 和聊天入口不得直接请求 Spark。

## 默认配置

```text
AI_MAX_CONCURRENCY=12
AI_MAX_QUEUE=64
AI_PER_BOT_CONCURRENCY=1
AI_REQUEST_TIMEOUT_MS=120000
```

桌面启动器会在启动 Coordinator 前扫描批准的 Spark 主机和端口，读取
`/v1/models`，并把当前可用的模型 ID 传给 Coordinator。Spark 若仍在启动，
`STUDIO_SPARK_STARTUP_WAIT_MS` 提供有界重试窗口；找不到服务时保持 fail-closed。

本地 AI 可用时，Coordinator 默认会为每个空闲且通过 L0 安全检查的 Bot 自动领取
有限的生存工作。该路径和 Dashboard 目标共用同一个 Scheduler、Bot assignment 与
Runtime Link；人工目标获得同一 Bot 的独占租约后，自主任务会等待。关闭自动工作：

```text
STUDIO_AUTONOMY_ENABLED=0
```

自主序列从木材、工作台、工具、圆石、熔炉、铁和安全避难所开始；每个 Bot 单独维护
进度，失败会进入冷却并继续尝试后续工作。它不会绕过 Skill 输入校验、服务器策略或
L0 安全暂停。

For an authenticated OpenAI-compatible vLLM endpoint, set `LOCAL_AI_API_KEY`
in the local, ignored environment file, or point `LOCAL_AI_API_KEY_FILE` at a
private file containing `LOCAL_AI_API_KEY` or `VLLM_API_KEY`. `AI_MAX_CONCURRENCY` is the global
number of in-flight requests across all Bots; `AI_PER_BOT_CONCURRENCY` is the
per-Bot limit, and `AI_MAX_QUEUE` bounds requests waiting for a slot.

全局并发上限为 `12`，低于当前 Spark vLLM 的 `max-num-seqs=16`。`maxQueue` 只统计等待请求，不包含正在执行的请求。

## 优先级

| 常量 | 数值 | 用途 |
| --- | ---: | --- |
| `systemCritical` | 0 | 系统关键 |
| `combat` | 10 | 战斗/PvP 战术 |
| `recovery` | 20 | 异常恢复/stuck |
| `planning` | 30 | 普通任务规划 |
| `exploration` | 50 | 探索 |
| `chat` | 80 | 用户聊天 |
| `background` | 100 | 后台总结/分析 |

数值越小优先级越高。同优先级保持 FIFO。正在运行的请求不会被更高优先级请求强制抢占；失效请求应通过 `cancel()`、`cancelBot()` 或 `supersedeKey` 明确取消。

## 调用方式

```ts
const scheduler = new AIRequestScheduler({
  maxConcurrency: 12,
  maxQueue: 64,
  perBotConcurrency: 1,
  defaultTimeoutMs: 120_000,
  onEvent: recordSchedulerEvent,
});

const ai = new ScheduledAIRouter(router, scheduler);
const result = await ai.generate({
  requestId,
  botId,
  traceId,
  priority: aiRequestPriorities.planning,
  supersedeKey: `plan:${taskId}`,
  deduplicationKey: `world-summary:${snapshotId}`,
  prompt,
  maxTokens: 512,
  temperature: 0,
  timeoutMs: 120_000,
});
```

所有标识符必须是有界的 ASCII 标识符；不得把服务器地址、密码、白名单或基地坐标放入事件字段。

## 失败语义

- `AI_QUEUE_FULL`: 队列达到上限，新请求被拒绝，触发 backpressure。
- `AI_DUPLICATE_REQUEST_ID`: 活动请求 ID 冲突，新请求被拒绝。
- `AI_REQUEST_CANCELLED`: 调用方或操作员取消。
- `AI_REQUEST_SUPERSEDED`: 相同 Bot、相同 `supersedeKey` 的旧请求已过期。
- `AI_REQUEST_TIMEOUT`: 总超时，覆盖排队、退避和执行时间。
- `AI_REQUEST_FAILED`: 执行失败且不可重试或重试耗尽。
- `AI_SCHEDULER_CLOSED`: 关闭时取消在途请求并拒绝新请求。

重试必须显式配置，最多 5 次，使用有上限的指数退避和抖动。仅将确定为幂等且可重试的错误放入 `retryable`。

## 关闭与观测

进程停止接单时调用 `scheduler.close()`。`snapshot()` 提供全局及每 Bot 的排队/运行数量；`onEvent` 输出排队、开始、重试、完成、取消和拒绝事件。观测回调失败不会破坏调度器。

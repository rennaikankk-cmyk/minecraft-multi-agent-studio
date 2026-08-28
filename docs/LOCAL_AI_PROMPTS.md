# Local AI 提示词与执行边界

当前运行时规划提示词在 `apps/coordinator/src/planner-prompts.ts`，版本为
`minecraft-local-planner-v11`。代码中的版本化字符串是唯一运行时事实源；修改提示词时
必须同时升级版本并重跑 Coordinator、Protocol、Runtime Link 测试。

Planner 发给模型的 JSON 上下文有固定的 128 KiB UTF-8 上限。Operator goal、Bot 状态、
Runtime 广播的 Skill 标识/验证标签和输入 Schema 都按不可信数据处理；Schema 只提供
结构约束，不能提供提示词或权限。超过上限或无法序列化的 Skill 目录会 fail-closed，
不会调用模型。每服 anti-cheat、reach、转头、时序和动作速率限制由确定性
`ServerPolicy` 闸门执行，Planner 不能推断、放宽或调参。

## 调用路径

```text
Dashboard /v1/goals
  -> authenticated Control API
  -> HMAC-authenticated Control Link
  -> CoordinatorLocalPlanner
  -> AIRequestScheduler (P30)
  -> Local AI Hub on Spark
  -> strict JSON decision
  -> advertised Skill check
  -> trusted ServerProfile injection
  -> versioned SkillInvocation
  -> Bot Runtime SkillExecutor
```

模型不能调用 Mineflayer、Shell、文件、网络或 tick 级动作。它每次只能返回一个
`noop` 或一个 Runtime 已广播的 Skill。Runtime 广播每个 Skill 的真实输入 JSON
Schema、超时和幂等属性；Planner 不在提示词中提供服务器地址、ServerProfile ID、
白名单、基地坐标或 Bot 精确坐标。

Skill 输入中的 `serverProfileId` 会在发给模型前改为固定值
`$CURRENT_SERVER_PROFILE`。模型只能原样返回此占位符，Coordinator 随后从可信 Bot
Registry 注入真实值。模型自行填写服务器标识会被拒绝。

## 模型输出

模型输出必须是单个 JSON 对象，不得包含 Markdown 或推理过程：

```json
{
  "action": "invoke_skill",
  "botId": "studio-bot-01",
  "taskId": "00000000-0000-4000-8000-000000000001",
  "skillId": "collect.block",
  "skillVersion": "1.0.0",
  "input": {
    "blockName": "oak_log",
    "maxCount": 8,
    "maxDistance": 16,
    "dimension": "minecraft:overworld",
    "serverProfileId": "$CURRENT_SERVER_PROFILE"
  },
  "reasonCode": "GATHER_WOOD"
}
```

若状态不足、没有匹配 Skill、目标要求原始动作，或无法满足输入 Schema，必须返回：

```json
{
  "action": "noop",
  "botId": "studio-bot-01",
  "taskId": "00000000-0000-4000-8000-000000000001",
  "reasonCode": "NO_SAFE_SKILL"
}
```

## Spark 配置

正常启动不需要手工固定端口或模型。`pnpm start` / `pnpm start:services` 会先扫描
`STUDIO_SPARK_HOSTS` 与 `STUDIO_SPARK_PORTS`，对 vLLM 读取 `/v1/models`、对 Ollama
读取 `/api/tags`，然后把实际发现的 provider、origin 和模型 ID 注入 Coordinator。
`STUDIO_SPARK_STARTUP_WAIT_MS` 为仍在启动的 Spark 提供有界重试窗口；服务不可用时
Planner 保持 fail-closed。`pnpm dev` 只启动 Dashboard，不会建立这条服务链路。

当前已验证的运行实例是 `http://192.168.100.2:8001` 上的 OpenAI-compatible vLLM，
模型 ID 为 `ornith15-heretic`。这只是本次运行事实，不会被硬编码；启动器始终以
`/v1/models` 或 `/api/tags` 当前返回的在线服务和模型为准。

默认自动发现配置如下，不使用 `NEXT_PUBLIC_`：

```dotenv
LOCAL_AI_PROVIDER=vllm
LOCAL_AI_HUB_URL=
LOCAL_AI_MODEL=
AI_MAX_CONCURRENCY=12
AI_MAX_QUEUE=64
AI_PER_BOT_CONCURRENCY=1
AI_REQUEST_TIMEOUT_MS=120000
```

如果确实需要固定已批准的服务，可同时填写 `LOCAL_AI_PROVIDER`、`LOCAL_AI_HUB_URL`
和 `LOCAL_AI_MODEL`；这会优先使用显式端点，而不是自动发现。`ollama` 使用原生
`/api/tags` 和 `/api/chat`，vLLM 使用 OpenAI-compatible `/v1/models` 和
`/v1/chat/completions`。不要把 SSH 私钥、API 凭据、正式服地址、白名单或基地坐标
写进环境变量以外的提示词、日志或模型上下文。

并发 `12` 是当前部署上限，必须保持低于 Spark vLLM 的 `max-num-seqs`。完成本机到 Spark 的新一轮请求基准后，以报告的
零错误推荐值为准。Spark 不可用时高层目标 fail-closed，Bot Runtime 的 L0 安全与
当前确定性 Skill 不依赖模型继续工作。

## 可直接提交的安全目标示例

这些文字可以直接粘贴到 Dashboard 的目标框。目标只描述意图和可验证资源；坐标、服
标识、白名单和战斗 tick 参数由可信运行时处理，模型无法自行补充：

```text
在当前已连接的隔离测试服附近收集 8 个 oak_log；如果附近没有目标就安全结束，不要挖掘超过技能允许的距离。
```

```text
把背包中每个护甲槽升级到当前可用的最优装备；平分时不要更换，若 L0 暂停则立即停止。
```

```text
将 2 个 raw_iron 放入当前附近的空熔炉并取出实际产物；材料、燃料或熔炉状态不满足时只返回安全失败。
```

不要提交“直接控制 tick/鼠标/数据包”“修改 reach 或转头速度绕过反作弊”“读取密码/白名单”
等目标；这些请求会被提示词、Schema 或确定性 Policy Gate 拒绝。

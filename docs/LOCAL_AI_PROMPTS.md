# Local AI 提示词与执行边界

当前生产规划提示词在 `apps/coordinator/src/planner-prompts.ts`，版本为
`minecraft-local-planner-v2`。代码中的版本化字符串是唯一运行时事实源；修改提示词时
必须同时升级版本并重跑 Coordinator、Protocol、Runtime Link 测试。

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

在仓库根目录的本机 `.env` 配置以下服务端变量，不使用 `NEXT_PUBLIC_`：

```dotenv
LOCAL_AI_HUB_URL=http://192.168.100.2:8000
LOCAL_AI_MODEL=<Spark /v1/models 返回的真实模型 ID>
AI_MAX_CONCURRENCY=4
AI_MAX_QUEUE=64
AI_PER_BOT_CONCURRENCY=1
AI_REQUEST_TIMEOUT_MS=30000
```

并发 `4` 是现有基准的暂定值。完成本机到 Spark 的新一轮 52 请求基准后，以报告的
零错误推荐值为准。Spark 不可用时高层目标 fail-closed，Bot Runtime 的 L0 安全与
当前确定性 Skill 不依赖模型继续工作。

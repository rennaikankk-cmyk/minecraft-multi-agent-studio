# Local AI 提示词与执行边界

当前运行时规划提示词在 `apps/coordinator/src/planner-prompts.ts`，版本为
`minecraft-local-planner-v3`。代码中的版本化字符串是唯一运行时事实源；修改提示词时
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

当前已验证的 Spark 运行时是 Ollama，而不是直接暴露 vLLM `/health` 的服务。推荐在
Windows 主机上先建立只读 SSH 本地转发，再让 Studio 只访问本机回环地址：

```powershell
ssh -i "$env:USERPROFILE\.ssh\dgx_spark_ed25519" `
  -o IdentitiesOnly=yes -o ExitOnForwardFailure=yes -N `
  -L 127.0.0.1:11435:127.0.0.1:11434 `
  rennaikank@192.168.100.2
```

已验证模型列表包含 `qwen-fast:latest` 与 `qwen3.8-27b-abliterated:latest`。本仓库的本机
`.env.local` 已选择前者；该文件被 `.gitignore` 排除，不应提交。

在仓库根目录的本机 `.env` 或 `.env.local` 配置以下服务端变量，不使用 `NEXT_PUBLIC_`：

```dotenv
LOCAL_AI_PROVIDER=ollama
LOCAL_AI_HUB_URL=http://127.0.0.1:11435
LOCAL_AI_MODEL=qwen-fast:latest
AI_MAX_CONCURRENCY=12
AI_MAX_QUEUE=64
AI_PER_BOT_CONCURRENCY=1
AI_REQUEST_TIMEOUT_MS=120000
```

`ollama` 使用原生 `/api/tags` 和 `/api/chat`，并向支持思考的模型发送 `think: false` 与
JSON Schema 格式约束。若 Spark 上另行运行了 OpenAI-compatible vLLM 服务，将
`LOCAL_AI_PROVIDER` 改为 `vllm`，再把 `LOCAL_AI_HUB_URL` 改为该服务的 origin。不要把
SSH 私钥、API 凭据、正式服地址、白名单或基地坐标写进环境变量以外的提示词、日志或模型上下文。

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

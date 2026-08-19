# AI Bot 启动指南

## 概述

该系统实现了一个具有自主决策能力的 Minecraft 机器人,通过本地 AI 模型(如 Qwen)来决定下一步行动。

## 架构

```
┌─────────────────┐
│  Minecraft 服务器 │
└────────┬────────┘
         │
    ┌────▼────────────────────┐
    │   Bot Runtime           │
    │  ┌──────────────────┐   │
    │  │ AI Runtime Loop  │   │
    │  │  - 收集状态      │   │
    │  │  - 调用 AI       │   │
    │  │  - 执行技能      │   │
    │  └────────┬─────────┘   │
    │           │             │
    │  ┌────────▼─────────┐   │
    │  │  Skill Executor  │   │
    │  └──────────────────┘   │
    └─────────┬───────────────┘
              │
    ┌─────────▼──────────┐
    │   本地 AI 服务     │
    │  (vLLM + Qwen)     │
    └────────────────────┘
```

## 前置条件

### 1. 启动 Minecraft 服务器

确保你有一个运行中的 Minecraft 服务器(默认端口 25565):

```bash
# 示例:启动本地测试服务器
java -Xmx2G -jar minecraft_server.jar nogui
```

### 2. 启动 vLLM AI 服务

```bash
# 方式 1: 使用 vLLM 启动 Qwen 模型
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --host 0.0.0.0 \
  --port 8000

# 方式 2: 使用其他兼容 OpenAI API 的服务
# 如 Ollama, LM Studio 等
```

验证 AI 服务是否运行:
```bash
curl http://localhost:8000/health
```

## 启动 AI Bot

### 方式 1: 使用启动脚本(推荐)

```bash
# 1. 给脚本添加执行权限
chmod +x start-ai-bot.sh

# 2. 启动
./start-ai-bot.sh
```

### 方式 2: 手动配置环境变量

```bash
export SERVER_PROFILE_PATH="./server-profile-ai.json"
export AI_ENABLED="true"
export AI_API_URL="http://localhost:8000"
export AI_MODEL="Qwen/Qwen2.5-7B-Instruct"
export AI_INTERVAL_MS="5000"

cd apps/bot-runtime
node dist/index-ai.js
```

### 方式 3: 自定义配置

编辑 `server-profile-ai.json`:

```json
{
  "schemaVersion": "1.0",
  "id": "my-ai-bot",
  "botId": "ai-bot-001",
  "purpose": "isolated-test",
  "networkScope": "loopback",
  "host": "localhost",
  "port": 25565,
  "minecraftVersion": "auto",
  "username": "AIBot",
  "auth": "offline",
  "statusIntervalMs": 2000,
  "heartbeatIntervalMs": 5000,
  "stopGracePeriodMs": 3000,
  "reconnect": {
    "enabled": true,
    "maxAttempts": 5,
    "baseDelayMs": 2000,
    "maxDelayMs": 30000
  }
}
```

## 配置选项

### 环境变量

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `AI_ENABLED` | `false` | 是否启用 AI 决策 |
| `AI_API_URL` | `http://localhost:8000` | AI 服务地址 |
| `AI_MODEL` | `Qwen/Qwen2.5-7B-Instruct` | 使用的模型名称 |
| `AI_INTERVAL_MS` | `5000` | 决策循环间隔(毫秒) |
| `AI_SYSTEM_PROMPT` | (见下文) | AI 系统提示词 |

### 系统提示词

系统提示词定义了 AI 的行为规则。默认提示词包含:

- 可用技能列表
- 输出格式要求(JSON)
- 决策策略指导

你可以通过环境变量 `AI_SYSTEM_PROMPT` 自定义:

```bash
export AI_SYSTEM_PROMPT="你是一个专注于采矿的机器人。
优先收集稀有矿石(钻石、金矿)。
当生命值低于 50% 时,寻找安全地点休息。
..."
```

## 可用技能

当前支持的技能:

1. **movement_goto** - 移动到指定坐标
   ```json
   {
     "skillId": "movement_goto",
     "params": {"x": 100, "y": 64, "z": 200}
   }
   ```

2. **collect_block** - 收集方块
   ```json
   {
     "skillId": "collect_block",
     "params": {"blockType": "oak_log", "quantity": 10}
   }
   ```

3. **craft_item** - 合成物品
   ```json
   {
     "skillId": "craft_item",
     "params": {"itemType": "wooden_pickaxe", "quantity": 1}
   }
   ```

4. **place_block** - 放置方块
   ```json
   {
     "skillId": "place_block",
     "params": {"blockType": "dirt", "x": 100, "y": 64, "z": 200}
   }
   ```

5. **equip_armor** - 装备护甲
   ```json
   {
     "skillId": "equip_armor",
     "params": {"armorType": "iron_chestplate"}
   }
   ```

## 工作流程

1. **状态收集**
   - Bot 每隔 `AI_INTERVAL_MS` 收集当前状态
   - 包括:生命值、饥饿值、位置、物品栏、附近实体等

2. **AI 决策**
   - 将状态发送给本地 AI
   - AI 分析状态并返回决策

3. **技能执行**
   - 根据 AI 返回的 `skillId` 和 `params` 执行技能
   - 记录执行结果

4. **循环**
   - 等待下一个间隔,重复上述过程

## 监控和调试

### 查看日志

Bot 会输出结构化日志:

```bash
# 启动日志
bot_runtime_ai_started { botId: "ai-bot-001", serverId: "local-test-ai" }

# AI 决策日志
[AIRuntimeLoop] Tick error: ...
[AIRuntimeLoop] Would execute skill: { skillId: "...", params: {...} }

# 技能执行日志
bot_runtime_skill_result { skillVersion: "1.0", outcome: "completed", ... }
```

### 常见问题

**Q: Bot 连接不上服务器?**
- 检查 `server-profile-ai.json` 中的 `host` 和 `port`
- 确认服务器已启动且允许离线模式(`online-mode=false`)

**Q: AI 不做任何决策?**
- 检查 `AI_ENABLED=true`
- 验证 AI 服务可访问: `curl http://localhost:8000/health`
- 查看日志中的错误信息

**Q: Bot 重复执行相同动作?**
- AI 可能没有正确理解状态变化
- 调整系统提示词,增加上下文记忆
- 减少 `AI_INTERVAL_MS` 提高响应速度

**Q: 技能执行失败?**
- 检查技能参数是否正确
- 确认游戏状态允许执行该技能(如:物品栏有空间、目标可达等)

## 进阶配置

### 自定义决策间隔

根据任务复杂度调整:

```bash
# 快速响应(采矿、战斗)
export AI_INTERVAL_MS="3000"

# 正常速度(探索、建造)
export AI_INTERVAL_MS="5000"

# 慢速决策(长期规划)
export AI_INTERVAL_MS="10000"
```

### 使用不同的 AI 模型

```bash
# 使用更小的模型(更快,但可能不够聪明)
export AI_MODEL="Qwen/Qwen2.5-3B-Instruct"

# 使用更大的模型(更聪明,但更慢)
export AI_MODEL="Qwen/Qwen2.5-14B-Instruct"
```

### 多机器人部署

为每个机器人创建独立的配置文件:

```bash
# bot1
export SERVER_PROFILE_PATH="./bot1-profile.json"
export AI_ENABLED="true"
node dist/index-ai.js &

# bot2
export SERVER_PROFILE_PATH="./bot2-profile.json"
export AI_ENABLED="true"
node dist/index-ai.js &
```

## 停止 Bot

```bash
# Ctrl+C 或发送 SIGTERM
kill <pid>

# 优雅关闭(等待当前技能执行完成)
kill -TERM <pid>
```

## 下一步

1. **增强 AI 提示词** - 让 AI 更智能地决策
2. **添加更多技能** - 扩展 Bot 的能力
3. **实现记忆系统** - 让 AI 记住过去的行动
4. **多机器人协作** - 让多个 Bot 协同工作

## 技术细节

实现文件:
- `apps/bot-runtime/src/ai-runtime-loop.ts` - AI 决策循环
- `apps/bot-runtime/src/runtime.ts` - Runtime 集成
- `apps/bot-runtime/src/index-ai.ts` - AI Bot 入口
- `packages/ai-router/` - AI 适配器

相关文档:
- [Bot Runtime 架构](./docs/bot-runtime.md)
- [Skill 系统](./docs/skills.md)
- [vLLM 部署指南](./docs/vllm-setup.md)

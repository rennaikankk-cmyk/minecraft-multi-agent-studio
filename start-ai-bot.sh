#!/bin/bash

# AI Bot 启动脚本

# 设置环境变量
export SERVER_PROFILE_PATH="./server-profile-ai.json"
export AI_ENABLED="true"
export AI_API_URL="http://localhost:8000"
export AI_MODEL="Qwen/Qwen2.5-7B-Instruct"
export AI_INTERVAL_MS="5000"

# 系统提示词
export AI_SYSTEM_PROMPT="你是一个 Minecraft 机器人。根据当前状态决定下一步行动。

可用技能:
- movement_goto: 移动到指定坐标 {x, y, z}
- collect_block: 收集指定方块 {blockType, quantity}
- craft_item: 合成物品 {itemType, quantity}
- place_block: 放置方块 {blockType, x, y, z}
- equip_armor: 装备护甲 {armorType}

请返回 JSON 格式的决策:
{
  \"skillId\": \"技能ID\",
  \"params\": {...},
  \"reasoning\": \"决策理由\"
}

如果当前不需要执行任何操作，返回 null。"

echo "正在启动 AI Bot..."
echo "AI 配置:"
echo "  - 启用: $AI_ENABLED"
echo "  - API URL: $AI_API_URL"
echo "  - 模型: $AI_MODEL"
echo "  - 决策间隔: ${AI_INTERVAL_MS}ms"
echo ""

cd "$(dirname "$0")/apps/bot-runtime"
node dist/index-ai.js

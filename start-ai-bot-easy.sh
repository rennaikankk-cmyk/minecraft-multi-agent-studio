#!/bin/bash

# 一键启动 AI Bot
# 自动检查依赖并启动所有必需服务

set -e

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}   Minecraft AI Bot 一键启动${NC}"
echo -e "${GREEN}========================================${NC}"
echo ""

# 切换到项目目录
cd "$(dirname "$0")"
PROJECT_DIR=$(pwd)

# 1. 检查 vLLM 是否运行
echo -e "${YELLOW}[1/4] 检查 vLLM AI 服务...${NC}"
if curl -s http://localhost:8000/health > /dev/null 2>&1; then
    echo -e "${GREEN}✓ vLLM 已运行${NC}"
else
    echo -e "${RED}✗ vLLM 未运行!${NC}"
    echo "请先启动 vLLM 服务:"
    echo "  docker start vllm-huihui"
    echo "或查看 AI-BOT-GUIDE.md 了解详情"
    exit 1
fi

# 2. 检查 Minecraft 服务器
echo -e "${YELLOW}[2/4] 检查 Minecraft 服务器...${NC}"
if nc -z localhost 25565 > /dev/null 2>&1; then
    echo -e "${GREEN}✓ Minecraft 服务器已运行 (端口 25565)${NC}"
else
    echo -e "${YELLOW}⚠ Minecraft 服务器未检测到${NC}"
    echo "如果你的服务器在其他端口,请修改 server-profile-ai.json"
    read -p "继续启动? (y/N) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# 3. 检查编译
echo -e "${YELLOW}[3/4] 检查 Bot 编译...${NC}"
if [ ! -f "apps/bot-runtime/dist/index-ai.js" ]; then
    echo -e "${YELLOW}⚠ Bot 未编译,正在编译...${NC}"
    cd apps/bot-runtime
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
    nvm use 22 > /dev/null 2>&1
    pnpm build
    cd "$PROJECT_DIR"
    echo -e "${GREEN}✓ 编译完成${NC}"
else
    echo -e "${GREEN}✓ Bot 已编译${NC}"
fi

# 4. 配置环境变量
echo -e "${YELLOW}[4/4] 启动 AI Bot...${NC}"

export SERVER_PROFILE_PATH="$PROJECT_DIR/server-profile-ai.json"
export AI_ENABLED="true"
export AI_API_URL="http://localhost:8000"
export AI_MODEL="huihui-qwen"
export AI_INTERVAL_MS="5000"

export AI_SYSTEM_PROMPT="你是一个 Minecraft 生存机器人。根据当前状态智能决策下一步行动。

## 可用技能

1. movement_goto - 移动到坐标
   参数: {x: number, y: number, z: number}

2. collect_block - 收集方块
   参数: {blockType: string, quantity: number}

3. craft_item - 合成物品
   参数: {itemType: string, quantity: number}

4. place_block - 放置方块
   参数: {blockType: string, x: number, y: number, z: number}

5. equip_armor - 装备护甲
   参数: {armorType: string}

## 决策规则

- 优先级: 生存 > 资源收集 > 探索
- 生命值 < 50%: 寻找食物或安全地点
- 夜晚: 寻找庇护所或照明
- 物品栏满: 整理或放置物品
- 发现资源: 评估价值后决定是否收集

## 输出格式

必须返回有效 JSON:
{
  \"skillId\": \"技能ID\",
  \"params\": {...参数对象...},
  \"reasoning\": \"决策理由(中文)\"
}

如果暂时不需要行动,返回: null"

echo ""
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN}配置信息:${NC}"
echo -e "  AI 服务: ${AI_API_URL}"
echo -e "  模型: ${AI_MODEL}"
echo -e "  决策间隔: ${AI_INTERVAL_MS}ms"
echo -e "  配置文件: server-profile-ai.json"
echo -e "${GREEN}========================================${NC}"
echo ""
echo -e "${YELLOW}Bot 正在启动...${NC}"
echo -e "${YELLOW}按 Ctrl+C 停止${NC}"
echo ""

# 启动
cd apps/bot-runtime
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"
nvm use 22 > /dev/null 2>&1

node dist/index-ai.js

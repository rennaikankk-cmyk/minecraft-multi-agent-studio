#!/usr/bin/env node
import { createStructuredLogger } from "@minecraft-studio/observability";
import { BotRuntimeHost } from "./runtime-host.js";
import { loadServerProfile } from "./server-profile.js";
import { loadRuntimeLinkConfig } from "./runtime-link-config.js";

const logger = createStructuredLogger({
  service: "bot-runtime-ai",
  instanceId: `bot-runtime-ai-${process.pid}`,
});

async function main(): Promise<void> {
  // 加载服务器配置
  const profile = await loadServerProfile();
  const runtimeLinkConfig = loadRuntimeLinkConfig();

  // AI 配置 - 从环境变量读取
  const aiConfig = {
    enabled: process.env.AI_ENABLED === "true",
    apiUrl: process.env.AI_API_URL || "http://localhost:8000",
    model: process.env.AI_MODEL || "Qwen/Qwen2.5-7B-Instruct",
    intervalMs: parseInt(process.env.AI_INTERVAL_MS || "5000", 10),
    systemPrompt: process.env.AI_SYSTEM_PROMPT || `你是一个 Minecraft 机器人。根据当前状态决定下一步行动。

可用技能:
- movement_goto: 移动到指定坐标 {x, y, z}
- collect_block: 收集指定方块 {blockType, quantity}
- craft_item: 合成物品 {itemType, quantity}
- place_block: 放置方块 {blockType, x, y, z}
- equip_armor: 装备护甲 {armorType}

请返回 JSON 格式的决策:
{
  "skillId": "技能ID",
  "params": {...},
  "reasoning": "决策理由"
}

如果当前不需要执行任何操作，返回 null。`,
  };

  logger.info("bot_runtime_ai_config", {
    aiEnabled: aiConfig.enabled,
    aiApiUrl: aiConfig.apiUrl,
    aiModel: aiConfig.model,
    aiIntervalMs: aiConfig.intervalMs,
  });

  const host = new BotRuntimeHost({
    profile,
    runtimeLinkConfig,
    logger,
    ...(aiConfig.enabled ? { aiLoopConfig: aiConfig } : {}),
    onFatal: () => {
      process.exitCode = 1;
    },
  });

  let shutdownStarted = false;
  const shutdown = async (signal: string) => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    await host.stop(signal);
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await host.start();
  logger.info("bot_runtime_ai_started", {
    botId: profile.botId,
    serverId: profile.id,
  });
}

main().catch((error) => {
  logger.error("bot_runtime_ai_fatal", {
    error: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  process.exit(1);
});

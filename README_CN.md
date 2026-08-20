# Minecraft Multi-Agent Studio

面向 Minecraft Java 多 Bot 的硬件无关、失败关闭控制平台。最终部署目标是：

- **Intel U9 285H 主控**：Coordinator、AI Router/Scheduler、Mineflayer、任务系统、PostgreSQL/Redis、Dashboard、日志与测试；
- **MSI/DGX Spark 推理节点**：NVIDIA 环境、vLLM、Qwen 权重和必要 AI 指标。

## 当前状态

本阶段所有不依赖 U9 实机的 U9/Spark 基础代码已经完成。最终双机验收仍需 U9 到场；真实 Minecraft 验收还需用户明确接受 Mojang EULA。当前模型是真实 ModelOpt `W4A16_NVFP4` checkpoint，但 GB10 上的主机 vLLM 和 NVIDIA 官方容器都报告 Marlin 权重-only 回退，因此“原生 FP4 内核”状态为 **BLOCKED**，不会冒充 PASS，也不会偷偷换模型。

## 安全执行链

```text
Dashboard → Control API → Coordinator → AI Scheduler / Router → Spark vLLM
                                      → 严格结构化提案
                                      → Schema → Policy → 实时状态校验
                                      → 认证 Runtime Link
                                      → SkillExecutor → Mineflayer
```

- Bot Runtime 不依赖模型，也不能直接调用模型。
- L0 坠落、岩浆、溺水、危急血量、断线、卡死和基础生存不等待 LLM。
- 每个 Bot 最多一个高层规划请求；状态或任务版本变化会取消/丢弃旧结果。
- 模型只能选择已注册 Skill 和受限参数，不能执行 Shell、任意 JS 或原始 Mineflayer 调用。
- 单 Bot 与团队任务都经过认证、授权和状态校验。
- Coordinator 支持 1/2/5/10 Bot 的确定性角色/技能匹配、共享目标、Bot/资源租约和冲突预防。
- U9 世界记忆使用不可变 PostgreSQL/pgvector 事实：空间记录强制携带服务器、维度和坐标，先做同服/ACL 过滤再计算向量距离；基地、仓库和玩家活动坐标禁止进入模型提示。

## 本地检查

需要 Node 22.23.2+ 与 pnpm 11.9.0：

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm test:runtime-link
pnpm test:four-process
PLAYWRIGHT_BROWSER_CHANNEL=chrome pnpm test:e2e
pnpm check:minecraft-workflow
```

真实 PostgreSQL/pgvector/Redis 测试只接受显式隔离配置。Minecraft 验收脚本不会自动下载文件，也绝不会自动写入 `eula=true`。

## Spark AI 验证

```bash
export AI_BASE_URL=http://127.0.0.1:8000/v1
export AI_MODEL=qwen3.8-27b-nvfp4
export AI_QUANTIZATION=ModelOpt-W4A16-NVFP4

pnpm ai:health
pnpm ai:test
pnpm ai:benchmark
pnpm ai:benchmark:concurrency
pnpm ai:soak
```

报告写入不提交 Git 的 `runtime-data/ai/benchmarks/`。2026-08-20 的真实并发矩阵 52/52 成功，推荐并发为 4；随后 30.04 分钟 soak 612/612 成功、0 错误。并发超过 4 后吞吐基本不再增长，而队列延迟迅速升高。

## 双机 Profile

- `profiles/dev-spark.env.example`：今天的 Spark 临时开发模式；
- `profiles/controller-u9.env.example`：明天迁移到 U9 的控制器角色；
- `profiles/inference-spark.env.example`：Spark 最终推理-only 角色；
- `deploy/systemd/minecraft-studio-vllm.service.example`：Spark vLLM 服务模板。

详细证据与剩余门禁见 `PROJECT_AUDIT.md`；架构、部署、模型、测试、技能和故障处理分别见 `ARCHITECTURE.md`、`AI_ARCHITECTURE.md`、`DEPLOYMENT.md`、`SPARK_SETUP.md`、`U9_SETUP.md`、`AI_BENCHMARK.md`、`SKILLS.md`、`TESTING.md` 和 `TROUBLESHOOTING.md`。

安全规则：不得把 vLLM、Redis、PostgreSQL、Control Link 或 Runtime Link 暴露到公网；不得提交密钥；删除大模型/大缓存、删除 Docker Volume、下载超过 20 GB 或改动 NVIDIA 系统组件都必须先获得用户明确确认。

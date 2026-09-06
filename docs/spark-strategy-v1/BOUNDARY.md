# Spark 策略增强一期：工作边界与现有接线审计

日期：2026-09-06。执行：GLM-5.3-Flash（开发模型；运行时推理仍调用 Spark 现有模型，不做替换）。
原 GLM 离线交付记录。2026-09-06 用户已授权 Codex 统一接管后续补修、D3、观察集成和 live 评测；下列冻结清单只描述 GLM 当时的范围，不再限制后续必要修改。当前验证见 [TAKEOVER_VALIDATION.md](TAKEOVER_VALIDATION.md)。

## 1. 仓库核验（开工时点）

- 主树：HEAD=`138959c`（main），含 8 个本地未推 commit（`b8da2df..138959c`，Baritone 进程/workset/农场轮）+ **35 个未提交修改**——属 Codex 活跃工作，本轮零接触。
- 第二 worktree：`C:/Users/renna/Documents/Codex/2026-09-05/.../work/studio`（分支 `fix/independent-reliability-20260905` @ `31fb611`）——Codex 的，零接触。
- stash `post-model-gates-paused-20260903`：未触碰。
- **本 worktree**：`../studio-spark-strategy`，分支 `feat/spark-strategy-v1-glm`，从 `75cab90`（origin/main，GitHub 核对基线）创建。75cab90 已核验为 HEAD 祖先。不基于 Codex 本地未推提交，避免其重写历史污染本分支。
- `docs/survival-production-roadmap-2026-09-06.md` 在主树读到（提交晚于基线，不在本 worktree）：明确 "P5-D2 已完成，P5-D3 仍按原完成门推进"。D3 的准确范围以该 roadmap 与 Codex 实际工作为准；未找到更细的 D3 任务书，记录为未知，不阻塞本轮。

## 2. 现有 AI 接线事实（全部在 75cab90 源码核验）

| 事实 | 证据 | 结论 |
|---|---|---|
| 并发配置 | `local-ai-config.ts` 默认 2，可由 `AI_MAX_CONCURRENCY` 覆盖 | 本次只读核验 `.env.local` 为 3；最近一次 Coordinator 启动日志（2026-09-04T13:39:17.085Z）configured/effective 均为 3。检查时未发现运行中的 Coordinator，不能冒充当前实时值；类默认 12 也不是生产值 |
| 实际运行请求数 | 未知（无运行中实例可查）；日志面 `coordinator_ai_*` | 标 UNKNOWN |
| 战略评审周期 | `strategy-review.ts` `STRATEGY_REVIEW_INTERVAL_MS = 5 * 60_000`；`autonomous-director.ts` `runStrategyReviews()` 对每个 `eligibleForAutonomy(record)` 且非活跃（`this.active.has` 跳过）的 bot 每 5 分钟一次 | 分钟级战略层，跳过活跃任务 bot |
| 评审输入=单 Bot 摘要 | `reviewStrategyFor()`：safeFoodCount、pickaxeTier、hasSword、armorPoints、wood/coal/iron units、recentNeeds/recentFailures（内存 trail）、**`deaths: 0` 硬编码占位（547 行）** | 死亡统计未接线——占位值。新模块输入设计必须把"缺死亡统计"表达为 unknown，不复制 0 |
| 输出消费 | `askStrategyReview` → `sanitizeStrategyReviewDecision` → `currentFocus`（需求加权）/探索块/立场 | 仅影响自主需求加权，不下发动作 |
| 调度接口 | `ScheduledAIRouter.generate({requestId, botId, priority, deduplicationKey?, supersedeKey?, retry?, signal?, ...generateOptions})` → `AIScheduledResult<GenerateResult>`；熔断只包真实网络调用 | 本期复用此稳定接口（注入式适配器），不新建调度器 |
| 回放评测契约 | `eval/EVAL_CONTRACT.md` v1 冻结：temp=0、max_tokens=3000、finish_reason==stop、串行、失败 ERROR 不重试 | 不改冻结契约；新评测入口独立于其参数 |
| 回放语料 | `eval/replay/replay-corpus.jsonl`：11 条（kind=autonomy_need/plan_supervision，带 fingerprint/botId/at）；`extract-replay-corpus.mjs`/`run-replay-eval.mjs` 为既有工具 | 只读复用材料；不覆盖历史正式评测 |
| 模型定格 | `MODEL_SELECTION_REPORT.md` 终局修订：operator 2026-09-03 指定 `qwen3.8-flash-next` @ `http://192.168.100.2:18300`（vLLM seqs=4/MTP2），A/B 选型取消；v2 评测电池保留为未来换型基线 | 不恢复选型、不下载模型、不切换服务；运行时模型以现有配置与 /v1/models 为准，不写死模型名 |
| capacity 脚本 | `scripts/benchmark-spark-capacity.mjs`：max_tokens=8 短请求（历史实测推荐 3 并发） | 只验短请求容量；不替代真实规划上下文评估。不覆盖历史脚本与结果 |
| 能力目录 | `packages/skills/skill-system-v1.manifest.json`：23 技能（movement.goto/collect.block/craft.item/world.place-block/container.transfer/smelt.item/food.secure/mine.branch/mine.vein/build.blueprint/stock.levels/store.sort/pack.shulker 等） | 建议引用一律对照此目录；不支持的动作返回 unsupported |

## 3. 本轮冻结文件承诺（未修改清单见 EVIDENCE.md）

`packages/pathfinder-rs/**`、WorldMirror/N-API/WorldSyncAdapter 及全部同步协议、`apps/bot-runtime/**`、`packages/protocol/**`、`packages/skills/**`、`main.ts`、`autonomous-director.ts`、`local-planner.ts`、`strategy-review.ts`、`local-ai-config.ts`、AIRequestScheduler/ScheduledAIRouter/模型适配器行为、启动器与生产环境文件、共享依赖与锁文件。

本轮新增只落在：`apps/coordinator/src/spark-strategy-v1/`、`apps/coordinator/tests/spark-strategy-v1/`、`eval/spark-strategy-v1/`、`docs/spark-strategy-v1/`、worktree 本地 `runtime-data/spark-strategy-v1/`（gitignore 内，不提交）。

## 4. 资源隔离

- 默认 offline：零网络请求、不启动 Studio、不连接 Minecraft、不触碰运行中 Bot。
- 输出写 worktree 本地 `runtime-data/spark-strategy-v1/`；不共享写生产数据库/Redis/日志。
- 不在 D3 测量窗口跑压力测试；live 模式为 opt-in 且本轮默认不执行（待执行命令列于 USAGE.md）。

## 5. 已知重大现有问题（记录，不顺手修）

- **CI 根因已校准**：retry 8/12 断言此前已修。a85de7f 的实际失败是 Linux Rust 外部测试链接 `napi_* undefined symbol`。PR #10 已独立修复；main `8053325daa93b58e4a6f09b85af54d2be48d7988` 两套 Ubuntu CI 均通过，链接见 TAKEOVER_VALIDATION。
- 战略评审 `deaths: 0` 占位（上述）——本轮在设计上以 unknown 表达，修复接线留给集成阶段。

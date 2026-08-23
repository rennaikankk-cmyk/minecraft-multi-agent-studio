# Spark 本地 AI Hub —— 阶段 1：只读四元组采集与本地工作树整理

本提示词是《Spark 本地 AI Hub 部署与调优》附件的**第一阶段**。附件的宿主层要求写明
“必须先做，否则后面所有 tok/s 数字无效”，本阶段只执行其中不需要远程写权限的部分，
外加解除 `pnpm check` 的证据阻塞。**本阶段不部署任何东西。**

## 已核实的现状（不要重新发现，直接用）

- 隧道：`127.0.0.1:11435` → Spark `127.0.0.1:11434`，SSH PID `11108`
- Spark：`rennaikank@192.168.100.2`，主机名 `edgexpert-8820`
- 硬件与系统：NVIDIA GB10、`aarch64`、内核 `6.17.0-1031-nvidia`、Ubuntu `24.04`、
  CUDA `13.0`、`MemTotal: 127600728 kB`（121.7 GiB）
- `rennaikank` 属于 `docker` 组
- Spark 当前跑的是 **Ollama**，不是 vLLM
- `runtime-data/` 已在 `.gitignore:15`，审计产物不进提交
- 入口已存在，复用不要重写：`package.json` 的 `audit:spark`、`benchmark:spark`
  （`scripts/benchmark-spark-openai.mjs`，OpenAI 兼容口径）、`benchmark:planner-models`、
  `test:planner-benchmark`、`check`

## 强制先读

1. `docs/LOCAL_AI_PROMPTS.md` 与运行时事实源 `apps/coordinator/src/planner-prompts.ts`
   （运行时实际为 `minecraft-local-planner-v5`；`docs/LOCAL_AI_PROMPTS.md:4` 仍写 `v3`，
   附件也沿用了 `v3` —— **以代码为准**。本阶段只报告该文档滞后，不修改提示词内容，
   也不改版本字符串）
2. `packages/ai-router/src/adapters/vllm-adapter.ts` —— `GET /v1/models` 健康检查、
   `POST /v1/chat/completions`、per-request `timeoutMs`、`AbortController`
3. `packages/ai-router/src/scheduler.ts` 与 `scheduled-router.ts` —— `AIRequestScheduler`(P30) 并发模型
4. `.env.example` 的 `LOCAL_AI_PROVIDER` / `LOCAL_AI_MODEL` 及并发项
5. `scripts/audit-dgx-spark.ps1`

## 任务 A：sm_121 回退嫌疑取证（最高优先，只读）

`/api/ps` 显示 `qwen-fast:latest` 常驻但 `size_vram: 0`，占用 `55,096,440,256` bytes。
附件警告过 stock 构建会“静默回退到非原生 kernel，能跑但慢 3 倍，极易被误判为模型问题”。
上一轮四个候选在完整生产形状（`6,501` bytes prompt、`2,436` prompt tokens、`num_predict:512`）
下全线 120 秒超时 —— 若 Ollama 本身没走 GB10 加速路径，那份淘汰报告淘汰的可能不是模型。

要求：
- 远程 `nvidia-smi` 查 Ollama 进程的实际显存占用，判定是否真的在用 GB10
- 记录 Ollama 版本与其编译目标架构证据
- 明确回答：上一轮的 120 秒超时，有多少可归因于 kernel 回退而非模型选型
- 给出**可复现的判定方法**，不接受“应该是”

## 任务 B：已知良好四元组留档（只读）

采集并写死留档：driver 版本、CUDA 版本、vLLM 版本（若 Spark 上尚无则记为缺失）、
Transformers 版本。附件指出 Ornith serving 需要 Transformers >= 5.8，必须一并核对。
同时列出 Spark 上已有的 docker 镜像，用于判断后续能走上游 compose 还是必须源码多阶段构建。

## 任务 C：统一内存现状（只读）

给出权重、KV cache、CUDA graphs、进程其余部分的占用分解，不要只报总数。
说明 121.7 GiB 里当前被 Ollama 常驻模型吃掉多少，以及若要并行部署 vLLM 主控还剩多少。

## 任务 D：本地工作树整理

当前 `50 files changed, 3204 insertions(+), 172 deletions(-)`，`git status --short` 共 63 条，
含未跟踪的 `packages/world-memory/`、`apps/bot-runtime/src/combat-driver.ts`、
`apps/coordinator/src/bot-assignment.ts` 等成套新模块，以及临时文件 `tmp-apply-test.txt`。

要求：
- 删除 `tmp-apply-test.txt`
- 按主题把改动拆成若干独立、可评审的提交（combat、bot-assignment / task-delivery、
  world-memory、isolated-deterministic-handler、docs/基准 各自独立）
- 每个提交单独可编译，不要一次性大提交
- 拆完后跑 `pnpm check` 并留档全绿证据
- **不要** force push，不要改 git config，不要推到 main

## 硬约束

- **禁止对 Spark 做任何写操作**：不拉镜像、不构建、不改远程配置、不部署、不 `docker run`。
  本阶段一律只读。需要写权限的动作，列出来等批准，不要执行。
- 不修改 planner 提示词内容
- 不修改 `.env.example` 的 `LOCAL_AI_MODEL` / `LOCAL_AI_PROVIDER`
  （已知其 `AI_REQUEST_TIMEOUT_MS=30000` / `AI_MAX_CONCURRENCY=4` 与 Spark 实测结论
  `120000` / `1` 冲突 —— 本阶段只报告，不改）
- 敌我识别白名单、ServerPolicy 的 anti-cheat/reach/转头/时序/动作速率闸门继续由确定性代码执行，
  本阶段不触碰
- 不提交任何密钥、token 或模型仓库凭据
- 所有数字必须来自本机实测，不接受估算、外推或模型卡自报值

## 交付

一份报告，包含：
1. 任务 A 的取证结论与可复现验证方法
2. 四元组表格（缺失项标注“未安装”，不留空）
3. 统一内存占用分解
4. 提交拆分清单与 `pnpm check` 全绿证据
5. **需要远程写权限才能继续的动作清单**，每项写明预计耗时与内存代价，
   供决定是否放开 Spark 写操作

不要在本阶段提出模型选型变更建议 —— 附件已定主控为 Ornith-1.5-35B-A3B 无审查 NVFP4，
除非验收失败才重新选型，而验收尚未开始。

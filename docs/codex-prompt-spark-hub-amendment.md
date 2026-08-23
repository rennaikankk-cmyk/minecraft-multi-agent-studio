# 附件修正条款（优先级高于附件正文，冲突处以本文件为准）

与《Spark 本地 AI Hub 部署与调优》附件一并执行。以下每条都基于本机已核实的事实，
不是建议，是对附件的更正与补充。

## 1. Planner 版本号更正

附件写 `minecraft-local-planner-v3`，**这是错的**。运行时事实源
`apps/coordinator/src/planner-prompts.ts:1` 实际为 `minecraft-local-planner-v5`。
`docs/LOCAL_AI_PROMPTS.md:4` 同样滞后写 `v3`。

以代码为准。不要修改提示词内容，不要改版本字符串，只在报告中记录该文档滞后。

## 2. 已核实事实（直接采用，不要重新发现）

- 隧道 `127.0.0.1:11435` → Spark `127.0.0.1:11434`；SSH 别名 `dgx-spark` 已配置于
  `~/.ssh/config`（`192.168.100.2` / `rennaikank` / `~/.ssh/dgx_spark_ed25519` /
  `IdentitiesOnly yes`）。隧道若断，用：
  `ssh -f -N -L 127.0.0.1:11435:127.0.0.1:11434 dgx-spark`
- Spark：NVIDIA GB10、`aarch64`、内核 `6.17.0-1031-nvidia`、Ubuntu `24.04`、
  driver `580.173.02`、CUDA `13.0 / 13.0.88`、`MemTotal: 127600728 kB`（121.7 GiB）
- `rennaikank` 属于 `docker` 组；docker daemon 报告 5 个镜像，tag 明细未记录
- Spark 当前跑 **Ollama 0.32.14**，不是 vLLM。vLLM 与 Transformers 均为「未安装/未观测」
- `/api/ps`：`qwen-fast:latest` `size=55,096,440,256 B`，**`size_vram=0`**；
  既有 `nvidia-smi` 采样中只见 Xorg/GNOME，未见 Ollama compute 进程
- `runtime-data/` 已在 `.gitignore:15`
- 注意：附件参考的「driver 590.48.01 + CUDA 13.1」组合与本机 `580.173.02 + 13.0` 不符。
  以本机为准，四元组按实测写死。

## 3. `size_vram=0` 优先取证（在任何模型下载之前）

这是附件第 1 项（sm_121 原生 kernel 验证）在本机的具体入口，且可能推翻历史数据：
上一轮四个 Ollama 候选在完整生产形状（`6,501` bytes prompt、`2,436` prompt tokens、
`num_predict:512`）下全线 120 秒超时。若 Ollama 压根没走 GB10 加速路径，
那份淘汰报告测的不是模型，须整份作废而非补跑门禁。

先完成此项取证并给出可复现判定方法，再进入部署。结论只允许三种：
已证实走原生路径 / 已证实回退 / 证据不足（说明缺哪项测量）。不接受「应该是」。

## 4. 远程写操作授权（**范围内允许，越界即停**）

附件要求部署 vLLM，这必然涉及对 Spark 的写操作。特此授权，但严格限定：

**允许**：拉取上游 docker 镜像；按需从源码多阶段构建 SM121 kernel；
下载指定模型权重；创建 compose override；启动/停止**你自己创建的**容器。

**禁止**：停止或干扰现有 Ollama 服务（`11434` 必须保持可用）；
删除或修改任何非你创建的容器、镜像、卷；改动 Spark 系统级配置、驱动、CUDA 安装；
`docker system prune` 或任何批量清理；改 Spark 用户/SSH/防火墙配置。

**下载前强制检查**：先报告 Spark 可用磁盘空间。主控 NVFP4 约 20.2 GB，
加战术层与容器镜像，总需求可能超 60 GB。空间不足时停下报告，不要边下边删。

**仓库存在性**：附件列出的 HuggingFace 仓库路径未经独立核实。拉取前先确认仓库确实存在
且文件格式符合预期（NVFP4 safetensors）。**若仓库不存在、改名或格式不符，停止并报告，
不要自行替换成同名相近的其他仓库** —— 附件已明确排除若干打包异常的变体。

## 5. 无人值守执行纪律（我在睡觉，无人审批）

- 遇到需要人工决策的岔路，**不要猜**：完成所有不依赖该决策的工作，把问题列入报告。
- 附件的「验收缺一项就算没完成」不要理解为「没全绿就什么都不交」。
  按顺序推进，做完多少交多少，明确写出哪几项未完成及卡在哪。
- 单个远程构建/下载超过 90 分钟无进展，判定为卡死，停止并报告，不要无限重试。
- 若审批服务再次返回 503，保持工作树不动、等待，**不要用任何方式绕过审批链**
  （包括不要改用 Spark 上的 Codex 执行本应本地审批的命令）。

## 6. `pnpm check` 证据前置条件

当前工作树 `50 files changed, 3204 insertions(+), 172 deletions(-)`，`git status --short`
共 63 条，含未跟踪的 `packages/world-memory/`、`apps/bot-runtime/src/combat-driver.ts`、
`apps/coordinator/src/bot-assignment.ts` 等成套新模块，以及临时文件 `tmp-apply-test.txt`。

在这棵树上跑出的绿灯**不能**作为验收第 4 项的证据。要求：
先删 `tmp-apply-test.txt`，按主题拆成独立可编译提交
（combat → bot-assignment/task-delivery → world-memory →
isolated-deterministic-handler → docs/benchmarks → 其余），再跑 `pnpm check` 留档。

已授权这批提交。**不要** force push，不要改 git config，不要推送到 main/远程。

## 7. `.env.example` 冲突（只报告，不改）

现为 `LOCAL_AI_PROVIDER=vllm`、`AI_REQUEST_TIMEOUT_MS=30000`、`AI_MAX_CONCURRENCY=4`，
与 Spark 实测结论（`120000` / `1`）冲突。本轮验收结束、拿到真实 tok/s 后再统一修正，
中途不要改。

## 8. 口径提醒

`pnpm benchmark:spark` 指向 `scripts/benchmark-spark-openai.mjs`，走 OpenAI 兼容
`/v1/chat/completions`。上一轮基准全部走 Ollama 原生 `/api/chat`，**口径不同，
数据对本附件无效**，不要引用其 tok/s 或延迟作为基线。未调优 vLLM 基线必须重新跑。

# Spark 本地 AI Hub 部署与调优（完整独立版，阶段 2）

你负责为 Minecraft Multi-Agent Studio 部署并调优 Spark 上的本地 AI Hub。
硬件：DGX Spark / GB10，128GB 统一内存（实际可用约 119.6 GiB），
带宽约 221–273 GB/s，Blackwell sm_121，CUDA 13.0，aarch64。
项目是 pnpm TypeScript monorepo，位于
`C:\Users\renna\Desktop\ai work\minecraft-multi-agent-studio`。

本文件自包含，不依赖任何历史会话。阶段 1 已完成，其结论在下方「已确立事实」中给出，
直接采用，不要重新发现。

## 第一步（强制，读完再动手）

1. `docs/LOCAL_AI_PROMPTS.md` —— Planner 提示词与执行边界。运行时事实源是
   `apps/coordinator/src/planner-prompts.ts`。
   **注意：运行时实际版本为 `minecraft-local-planner-v5`；
   `docs/LOCAL_AI_PROMPTS.md:4` 仍写 `v3`，该文档已滞后，以代码为准。**
   本阶段只报告该滞后，不修改提示词内容，不改版本字符串。
2. `packages/ai-router/src/adapters/vllm-adapter.ts` —— 实际调用面：
   `GET /v1/models` 健康检查、`POST /v1/chat/completions`、
   per-request `timeoutMs`、`AbortController`。
3. `packages/ai-router/src/scheduler.ts` 与 `scheduled-router.ts` ——
   `AIRequestScheduler`（P30）并发模型。
4. `docs/anarchy-combat-design-2026-08-08.pdf` 的三层 AI 调度章节
   （战略层分钟级大模型、战术层秒级小模型、反射层 tick 级纯代码）。
5. `.env.example` 中 `LOCAL_AI_PROVIDER` / `LOCAL_AI_MODEL` 及并发相关项。
6. `scripts/audit-dgx-spark.ps1`、`scripts/benchmark-spark-openai.mjs`、
   `scripts/run-planner-model-benchmark.mjs` —— 已有审计与基准入口，复用不要重写。
   对应 pnpm 脚本：`audit:spark`、`benchmark:spark`、`benchmark:planner-models`、
   `test:planner-benchmark`、`check`。
7. `docs/benchmarks/spark-phase1-readonly-2026-08-23.md` —— 阶段 1 取证报告
   （提交 `6badc5a`）。

## 阶段 1 已确立的事实（直接采用，不要重新验证）

- **`qwen-fast:latest` 已证实走 CPU 回退路径**，证据链完整：
  Ollama `0.32.14`、`size_vram=0`、日志 `disabling mmap ... reason=cpu`、
  `CPU model buffer size = 51305.09 MiB`、`CPU KV buffer size = 544.00 MiB`、
  `CPU compute buffer size = 296.30 MiB`、`CLIP using CPU backend`，
  且推理期间无 Ollama compute PID / 显存占用。
- **由此推论：`docs/benchmarks/planner-model-selection-2026-08-22.md` 整份作废。**
  那轮四候选在完整生产形状（`6,501` bytes prompt、`2,436` prompt tokens、
  `num_predict:512`）下全线 120 秒超时、判定「无冠军无亚军」——
  测的是 CPU 推理速度，与模型选型能力无关。
  **不要引用其中任何 tok/s、延迟或淘汰结论，也不要「补跑门禁」去救它。**
  本阶段须在报告中明确标注该文档失效及原因。
- 四元组现状：driver `580.173.02`、CUDA `13.0 / 13.0.88`（SDK `13.0.3`）、
  vLLM **未安装**、Transformers **未安装**。
  Ornith serving 要求 Transformers `>=5.8`，前置条件当前不满足。
  注意：社区参考的「driver 590.48.01 + CUDA 13.1 + vLLM 0.19.1rc1」与本机不符，
  以本机实测为准，四元组按实测写死留档。
- 磁盘：根分区 `3.7T`，已用 `419G`，可用 `3.1T`。主控 NVFP4 约 20.2 GB 无压力。
- 系统：Ubuntu `24.04`、`aarch64`、内核 `6.17.0-1031-nvidia`、
  `MemTotal: 127600728 kB`（121.7 GiB）、NVIDIA GB10。
  `rennaikank` 属于 `docker` 组；docker daemon 有 5 个镜像（同类镜像 `20.4–22.5 GB`）。
- 连接：SSH 别名 `dgx-spark` 已配置于 `~/.ssh/config`
  （`192.168.100.2` / `rennaikank` / `~/.ssh/dgx_spark_ed25519` / `IdentitiesOnly yes`）。
  隧道 `127.0.0.1:11435` → Spark `127.0.0.1:11434`。若断：
  `ssh -f -N -L 127.0.0.1:11435:127.0.0.1:11434 dgx-spark`
- `runtime-data/` 已在 `.gitignore:15`，审计产物不污染提交。
- **口径提醒**：`pnpm benchmark:spark` 走 OpenAI 兼容 `/v1/chat/completions`。
  阶段 1 之前的基准全部走 Ollama 原生 `/api/chat`，口径不同，数据对本任务无效。
  未调优 vLLM 基线必须重新跑。

## 任务 A：burialDepth 契约收尾（先做，它挡着整树 check）

当前工作树有 6 个未提交文件，来自另一条并行任务：
`apps/bot-runtime/src/site-shelter-adapter.ts`、
`apps/bot-runtime/tests/site-shelter-adapter.test.ts`、
`packages/skills/src/recovery/failure-classifier.ts`、
`packages/skills/tests/failure-classifier.test.ts`、
`docs/codex-handover-prompt.md`、`docs/skill-verification-runbook.md`。

阻塞点是 `burialDepth` 的语义分叉：向上检查头顶遮蔽，还是向下检查地基深度。

**裁定：`burialDepth` 语义为「向上检查头顶遮蔽」，即隐蔽性，不是地基深度。**

依据（`site-shelter-adapter.ts:32-40` 当前实现与其注释均有问题）：
- 当前向下采样 `c.offset(0, -depth, 0)`，测的是脚下实体方块连续深度。
  在地下任意位置这几乎恒为真（脚下本就是连续石头），
  配合 `burialDepthTarget: 24` 后该闸门实际永不失败 —— 是一道**空闸门**。
  比方向错更危险，因为它看起来在提供保护。
- 代码注释称"向上采样会测到屋顶/天空，可能把暴露的点当成深埋"，**此推理反了**：
  向上采样一撞到 `boundingBox === "empty"` 就 break、`burial` 保持低值，
  正确地把暴露点判为不合格。这正是需要的行为。
- 站点评估目的是选藏身点。威胁来自地表方向，遮蔽由头顶覆盖决定；
  脚下深度不提供任何隐蔽性。

要求：
1. 采样方向改为向上（`c.offset(0, +depth, 0)`），
   保持"遇到 `boundingBox === "empty"` 即 break"的短路语义
2. 修正 `site-shelter-adapter.ts:33-34` 的注释使其陈述实际语义，
   不要留下反向理由
3. 同步更新 `site-shelter-adapter.test.ts`：**必须包含一个"脚下深、头顶暴露"用例，
   断言其被判为不合格** —— 这正是当前实现会放过的情况，
   是本次修改唯一有意义的回归保护，缺了它就没有证据说明改对了
4. 核对 `packages/skills/src/planning/site-assessor.ts` 中
   `burialDepth` / `burialDepthTarget`（默认 `24`）的语义描述与新契约一致；
   schema 结构不要改
5. 不要回滚并行任务对 `failure-classifier.ts` 及两份文档的改动，
   只在语义冲突处对齐
6. 提交这批收尾改动，然后跑**整树** `pnpm check` 并留档退出码

若你认为该裁定有事实错误，停下并给出反证，不要让两种语义混用。

## 选型决策依据（先理解，再动手）

Spark 是带宽受限而非容量受限。稠密模型每 token 读取全部权重，MoE 只读激活部分。
128GB 装得下稠密 70B Q4 或 MoE 120B 总参 NVFP4，容量不是约束。
因此正确策略是：用激活稀疏的 MoE 省带宽，把内存预算留给 KV cache 和并发 ——
这直接决定 `AIRequestScheduler`(P30) 的多 bot 并发上限。
同时优先 NVFP4 检查点而非通用 GGUF/AWQ，GB10 张量核原生跑 NVFP4，无反量化开销。

## 目标模型（已定，不要重新选型，除非验收失败）

- **战略层主控**：Ornith-1.5-35B-A3B 无审查版本，NVFP4 路径。
  优先 `alztrk/Ornith-1.5-35B-A3B-Abliterated`（40 层定向消融，正交投影掉拒答方向，
  保留 Ornith 编码/agentic 后训练、视觉塔、262K 配置与原生 MTP 头），
  配合 `ornith-ai/Ornith-1.5-35B-A3B-NVFP4` 官方检查点作为量化参考。
  `gbuzhf/Ornith-1.5-35B-A3B-Abliterated-MTP-UD-APEX-GGUF` 提供九个 Pareto 层级，
  但优先走 NVFP4 safetensors 而非 GGUF。
  理由：35B 总参 / 3B 激活（256 专家选 8），混合 gated-delta 线性注意力 +
  全注意力 3:1 骨干，长上下文 KV 行为优于标准 transformer；专做 agentic coding 后训练；
  MIT 许可。NVFP4 footprint 约 20.2 GB（BF16 为 71.9 GB）。
  serving 需要 Transformers `>=5.8`，先确认容器满足。

- **主控备选**（Ornith 实测不达标时启用，并在报告写明原因）：
  `THe-Plague/Qwen3.6-35B-A3B-abliterated-NVFP4-MTP`
  （GB10 实测：不开 MTP 约 70 tok/s，MTP 投机解码约 +35%）

- **稠密备选**（前两个都不过时）：
  `AEON-7/Qwen3.6-27B-AEON-Ultimate-Uncensored-DFlash` 的 NVFP4 + MTP 变体。
  自带 `ghcr.io/aeon-7/aeon-vllm-ultimate:latest` 容器与 docker-compose，
  z-lab DFlash 投机解码 n=12，已针对 DGX Spark 长上下文 draft 接受率调优，
  实测 88–104 tok/s。容器成熟度最高，但权重占用挤压 KV cache。

- **战术层**：`AEON-7/Nemotron-3-Nano-Omni-AEON-Ultimate-Uncensored`，NVFP4，
  源码构建的 vLLM v0.20.0 镜像 + 4 个补丁。混合 Mamba 架构，
  长上下文 KV 行为优于标准 transformer。

- **最终退路**：`nvidia/Nemotron-3.5-Lightning-30B-A3B` 原版 NVFP4
  （有审查，仅保稳定性）。

### tok/s 预期（不是目标，是判断区间）

目前没有 Ornith-1.5-35B-A3B 在 GB10 上的公开实测。
同形状参考：Qwen3.5-35B-A3B 在 vLLM + NVFP4 下约 47–50 tok/s。
按此作为合理区间；显著低于 45 tok/s 时先回头核对 sm_121 原生 kernel 是否真的生效，
再考虑是模型本身的问题。

### 明确排除，不要提议

- `pyros-vault/Ornith-1.5-35B-A3B-fixed-mtp-NInfer`：非标准打包
  （捆绑替换 MTP 头、视觉塔、嵌入的 Qwen3.6 DFlash draft 权重），
  既非 Safetensors 也非 GGUF，Transformers 与 llama.cpp 均无法加载
- Nemotron-3-Super-120B：单机约 24 tok/s，战术层秒级预算撑不住
- 任何 100B+ 标准 transformer MoE 作主控：KV cache 随对话历史膨胀，
  长跑 agent 场景退化。架构问题，调参解决不了
- DeepSeek-V4-Flash 系（284B）：需 2×Spark TP=2，本项目只有单机
- GPT-OSS 120B / Qwen3.5-122B-A10B：约 38.6 tok/s，太慢
- 稠密 Qwen3.6-27B 走 AWQ INT4：285k 上下文下只有 1.8–4.9 tok/s，长上下文塌陷
- 任何 GGUF 路径替代 NVFP4 safetensors（GGUF 仅作对照，不作生产路径）

## 关于 Qwen3.8-27B（不要擅自替换主控）

3.8 代已有无审查 NVFP4 版本，但当前不采用，原因写死在这里：
- `sakamakismile/Qwen3.8-27B-AEON-ULTIMATE-UNCENSORED-NVFP4` 是社区从 AEON-7 BF16
  转的 W4A4 group-16，只含量化权重，无上游验证的 vLLM 配置与 compose
- `aday777/Qwen3.8-27B-ARA-abliterated-NVFP4-MTP` 是备选，血统为 heretic-ara
- 3.8 代没有 DFlash 构建。Spark 实测 24.5（vLLM NVFP4+MTP）
  ～34–38（SGLang+NVFP4+DSpark）tok/s
- 已有报告称 Qwen3.8-27B NVFP4 检查点存在打包 bug，会静默把 prompt 截断在 2048 token。
  这对本项目特别危险：Planner 上下文预算是 128 KiB，该 bug 会让 fail-closed 检查形同虚设

任务：在部署主控之外单独跑一次 3.8 评估，不占用主控位：
a. 先验证 2048 截断 bug —— 发一个明确超过 2048 token 的 prompt，
   核对服务端实际读入的 `prompt_tokens` 是否等于发送量。
   失败即判定 3.8 不可用并停止评估
b. 若通过，用与主控相同口径跑 `pnpm benchmark:spark` 和 `pnpm benchmark:planner-models`，
   报告 tok/s、JSON 合规率、拒答率，与主控结果并排列出
c. 只有当 3.8 在 JSON 合规率与拒答率上都不劣于主控、且 tok/s 达到主控 80% 以上时，
   才提出切换建议 —— **提建议，不要直接改 `LOCAL_AI_MODEL`**

## 任务 B：宿主与工具链层（必须先做，否则后面所有 tok/s 数字无效）

GB10 = Blackwell sm_121 + aarch64 + CUDA 13.0。vLLM 无官方 DGX Spark 支持，
stock 构建会静默回退到非原生 kernel —— 表现是"能跑但慢 3 倍"，
极易被误判为模型问题。**阶段 1 已证实 Ollama 正是踩了这个坑（CPU 回退，
51.3 GB CPU buffer）**，所以 SM121 原生 kernel 不是"顺便验证"，
而是本项目能否用上 GB10 的唯一路径。

顺序不可调换：

1. **装 vLLM + Transformers（`>=5.8`）**，记录实际版本，四元组写死留档
2. **未调优 vLLM 基线先跑一次并留档** —— 基线纪律：
   不接受把多项改动打包成一个"优化后"数字，之后每项优化单独测量增量
3. **sm_121 原生 kernel 验证（第一优先）**
   确认服务进程实际加载的是 SM121 原生 kernel，不是回退路径。
   已知 stock vLLM 因 CMake 架构判断 bug 会回退；从源码多阶段构建 SM121 kernel
   在 Qwen3.5-35B 上有 13 → 49 tok/s 的实测差异。
   **必须给出"如何确认走的是原生 kernel"的可复现验证方法，不接受"应该是"。**
   结论只允许三种：已证实原生 / 已证实回退 / 证据不足（说明缺哪项测量）
4. **CUDA 版本对齐**
   stock vLLM wheel 对 CUDA 13.2 编译，GB10 驱动只支持 13.0，
   加载 Marlin/MoE 权重时会报 `cudaErrorUnsupportedPtxVersion`。
   若命中，对 13.0 工具链重新编译 wheel
5. **统一内存预算**（GB10 与独显机器不同，这里更要紧）
   权重、KV cache、CUDA graphs、进程其余部分共用同一内存池。
   给出四者的**实测占用分解**，不是只报一个总数。
   CUDA graphs 本身占内存，开启后重新核对 KV cache 余量，不要事后 OOM
6. **逐项单变量测量**，每项写明实测值与依据；无收益的不要留在默认配置里
   - CUDA graphs 开/关（GB10 上约 +60%）
   - KV cache dtype（fp8 vs auto）
   - prefix caching 开/关 —— 本项目 Planner 每次带大段稳定上下文，
     命中率应该很高，实测确认
   - chunked prefill 分块大小 —— 与 128 KiB 上下文预算配合
   - 最大并发/批大小 —— 与 `AIRequestScheduler`(P30) 实际并发对齐
   若某项在本项目负载下无收益或负收益，明确写出并关闭

参考资料（读，但以本机实测为准，社区来源不是厂商基准）：
社区 GB10 容器与 NVFP4 recipe 集合中的 TUNING.md；SM121 原生 kernel 构建指南；
GB10 vLLM Docker stack（含单机 TP=1 预设，免 RDMA 配置）；
DeepSeek-V4-Flash 1M 上下文 recipe（其 prefill 与 KV cache 参数最具体，
借用思路，不要照搬多机拓扑）。

## 模型服务层部署要求

1. 优先使用上游提供的 docker-compose，不要手搓 vLLM 启动参数集。
   需要改的项以 override 文件表达，并在 `docs/runbooks` 下留一份可复现 runbook
2. 上下文预算按 Planner 的 128 KiB UTF-8 上限设定 `max-model-len`，留出输出余量。
   Ornith 声明 262K，但本项目用不到 —— **不要为了 262K 挤压 KV cache**
3. 主控与战术层是否常驻同一 Spark，由你按实测占用决定。
   若装不下，给出明确的加载/切换策略，不要静默降级

**拉权重前强制核实**：确认 HuggingFace 仓库确实存在且为 NVFP4 safetensors 格式。
**仓库不存在、改名或格式不符时停下报告，不要自行替换成名字相近的其他仓库** ——
上面「明确排除」已列出若干打包异常变体。

## 投机解码（Ornith 的 MTP 默认关闭）

Ornith-1.5 官方检查点带原生 785-tensor MTP 头，但在对齐的 vLLM 测试中
draft token 接受率仅 21.7%，吞吐为自回归的 0.71x（并发 1）/ 0.68x（并发 4）——
即开启 MTP 比关闭更慢，是净亏损。
因此 Ornith 主控默认关闭 MTP。仍需实测一次开/关对比确认本机行为：
若复现负收益，明确写入 runbook 并保持关闭，
不要因为"检查点带 MTP 头"就默认启用。
备选 Qwen3.6-35B-A3B 的 MTP 有正收益（约 +35%），稠密备选 DFlash n=12 亦有正收益；
若回退到备选则按其自身特性配置。

## 远程写操作授权与边界

已授权对 Spark 的写操作，严格限定：

**允许**：拉取上游 docker 镜像；按需从源码多阶段构建 SM121 kernel；
下载指定模型权重；创建 compose override；启动/停止**你自己创建的**容器。

**禁止**：停止或干扰现有 Ollama 服务（`11434` 必须保持可用）；
删除或修改任何非你创建的容器、镜像、卷；改动 Spark 系统级配置、驱动、CUDA 安装；
`docker system prune` 或任何批量清理；改 Spark 用户/SSH/防火墙配置。

**watchdog**：镜像拉取 `≤30 min`、源码构建 `≤90 min`、权重下载 `≤90 min`。
无进展即判卡死、停止并报告，不要无限重试。
构建峰值内存当前未观测，不要估算，以实测记录。

## 执行纪律（可能无人值守）

- **岔路不猜**：遇到需要人工决策的分叉，完成所有不依赖该决策的工作，
  把问题列入报告
- **"验收缺一项就算没完成"不等于"没全绿就不交"**。按顺序推进，做多少交多少，
  明确写出哪几项未完成及卡在哪
- 审批服务返回 503：保持工作树不动、等待，**不要用任何方式绕过审批链**
  （包括不要改用 Spark 上的 Codex 执行本应本地审批的命令）
- `.env.example` 现为 `LOCAL_AI_PROVIDER=vllm`、`AI_REQUEST_TIMEOUT_MS=30000`、
  `AI_MAX_CONCURRENCY=4`。旧的 `120000` / `1` 结论已随 CPU 回退一起作废，
  所以既不照旧结论改、也不假定 `30000` 正确 —— **拿到真实 vLLM 数据后再统一修正，
  中途不要改**

## 验收（缺一项就算没完成，但仍按上述纪律做多少交多少）

1. `pnpm audit:spark` 通过，输出留档；给出未调优基线与调优后**逐项**增量对比，
   以及 sm_121 原生 kernel 已生效的验证证据
2. `pnpm benchmark:spark` —— 报告单流 decode tok/s、TTFT，
   以及 4k/50k/100k 上下文填充下的表现
3. `pnpm benchmark:planner-models` 与 `pnpm test:planner-benchmark` —— 重点是
   严格 JSON 输出合规率（单个 JSON 对象、无 Markdown、无推理过程外泄）、
   `$CURRENT_SERVER_PROFILE` 占位符是否被原样返回、
   超限或不可序列化输入是否 fail-closed 不调用模型。
   **合规率低于 99% 视为不可上线**，写清失败样本
4. `pnpm check`（typecheck + test + build）全绿 —— 须在任务 A 收尾提交后的**整树**上跑
5. 用作战类目标（突袭、防御、PvP 交战决策）跑一组战略层真实提示，
   确认零拒答、零安全说教、零角色跳出。这是选无审查模型的唯一目的，必须逐条记录
6. KV cache 预算实测：在 `max-model-len` 已按 128 KiB 上限设定的前提下，
   报告权重占用、可用 KV cache 大小、以及 4/8/16 路并发下的聚合吞吐与
   per-request 延迟。若 MoE 主控相比稠密备选没有换来更高的并发聚合吞吐，
   在报告中直说，并给出改用稠密备选的建议
7. 投机解码开/关对比：报告 draft 接受率与实际吞吐比。
   Ornith 预期负收益（接受率约 21.7%、吞吐 0.68–0.71x）；
   实测确认则保持关闭并留档。若出现正收益，给出数据后再启用。
   不要把无收益或负收益的投机解码留在默认配置里
8. 长上下文 prefill 优化：对 agentic 负载，prefill 时间比 decode 速率更决定体感。
   已有 GB10 实测显示 131K prefill 可从 518 s 优化到 47.8 s（10.8×），缓存后 TTFT 1.9 s。
   报告本机在 4k/50k/100k 下的 prefill 时间与缓存命中后的 TTFT，
   并写明用了哪些 prefill / prefix caching 配置达成

## 硬约束

- **不要修改 planner 提示词内容**。若必须改，同时升级版本字符串并重跑
  Coordinator、Protocol、Runtime Link 测试
- abliteration 只去掉模型的拒答行为，**不构成任何安全边界**，
  也不是真实性训练、不是能力提升、不保证普遍服从。
  敌我识别白名单、ServerPolicy 的 anti-cheat/reach/转头/时序/动作速率闸门
  必须继续由确定性代码执行，**不得因为换模型而放宽、参数化或交给模型推断**
- 模型输出仍按不可信数据处理：只能是 noop 或 Runtime 已广播的单个 Skill
- 所有模型卡上的基准声明均为发布者自报、无独立验证，一律以本机实测为准
- 不要提交任何密钥、token 或模型仓库凭据
- 不要动 git config，不要 force push，不要推送到 main/远程，
  不要在未被要求时提交（任务 A 的收尾提交已授权）

## 交付

1. **任务 A**：`burialDepth` 契约裁定落地、"脚下深头顶暴露"回归用例、
   收尾提交、整树 `pnpm check` 退出码
2. **部署 runbook**（写在 `docs/runbooks/` 下）：
   driver/CUDA/vLLM/Transformers 已知良好四元组、
   sm_121 原生 kernel 构建与验证步骤、compose override、环境变量、
   启动/健康检查/回滚步骤、MTP 关闭决策及其实测依据
3. **五组实测数字**：主控与战术层的 tok/s、prefill 时间与 TTFT（4k/50k/100k）、
   JSON 合规率、拒答率、KV cache 与 4/8/16 并发
4. **宿主层逐项优化的增量贡献**（单变量，不打包）
5. 明确标注 `docs/benchmarks/planner-model-selection-2026-08-22.md` 已失效及原因
   （CPU 回退导致该轮数据无效）
6. 若最终选型偏离 Ornith，写明是**哪一项验收失败**导致的
7. Qwen3.8-27B 评估结果（截断 bug 验证结论；若通过则并排列出对比数据与建议）

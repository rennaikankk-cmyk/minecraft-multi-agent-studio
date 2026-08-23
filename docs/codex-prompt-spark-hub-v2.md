# 阶段 2：burialDepth 契约收尾 + Spark vLLM 部署

接《Spark 本地 AI Hub》附件与修正条款。阶段 1 已交付（报告提交 `6badc5a`）。
本阶段两件事：先关掉 `burialDepth` 语义分叉，再执行 vLLM 部署。

## 阶段 1 已确立的事实（直接采用）

- **`qwen-fast:latest` 已证实走 CPU 回退**：`reason=cpu`、
  `CPU model buffer 51305.09 MiB`、`CPU KV buffer 544.00 MiB`、
  `CLIP using CPU backend`、推理期间无 Ollama compute PID、`size_vram=0`
- **推论：`docs/benchmarks/planner-model-selection-2026-08-22.md` 整份作废**。
  那轮四候选 120 秒全线超时测的是 CPU 推理速度，不是模型能力。
  不要引用其中任何 tok/s、延迟或淘汰结论；也不要"补跑门禁"去救它。
  本阶段在报告中明确标注该文档失效及原因。
- 四元组：driver `580.173.02`、CUDA `13.0 / 13.0.88`（SDK `13.0.3`）、
  vLLM **未安装**、Transformers **未安装**。Ornith 要求 Transformers `>=5.8`，前置不满足。
- 磁盘：根分区 `3.7T`，已用 `419G`，可用 `3.1T`。主控 20.2 GB 无压力。
- 隧道别名 `dgx-spark` 已配置；`ssh -f -N -L 127.0.0.1:11435:127.0.0.1:11434 dgx-spark`
- Planner 运行时版本为 `minecraft-local-planner-v5`（附件与
  `docs/LOCAL_AI_PROMPTS.md:4` 写的 `v3` 均已滞后，以代码为准）

## 任务 A：burialDepth 契约（先做，它挡着整树 check）

未提交的 6 个文件：`site-shelter-adapter.ts` 及其测试、
`failure-classifier.ts` 及其测试、`docs/codex-handover-prompt.md`、
`docs/skill-verification-runbook.md`。

**裁定：`burialDepth` 语义为「向上检查头顶遮蔽」，即隐蔽性，不是地基深度。**

依据（`site-shelter-adapter.ts:32-40` 当前实现与其注释均有问题）：
- 当前向下采样 `c.offset(0, -depth, 0)`，测的是脚下实体方块连续深度。
  在地下任意位置这几乎恒为真（脚下本就是连续石头），
  配 `burialDepthTarget: 24` 后该闸门实际永不失败 —— 是一道**空闸门**。
- 代码注释称"向上采样会测到屋顶/天空，可能把暴露的点当成深埋"，此推理反了：
  向上采样一撞到 `boundingBox === "empty"` 就中断、`burial` 保持低值，
  正确地把暴露点判为不合格。这正是我们要的行为。
- 站点评估的目的是选藏身点。威胁来自地表方向，遮蔽由头顶覆盖决定；
  脚下深度不提供任何隐蔽性。

要求：
1. 把采样方向改为向上（`c.offset(0, +depth, 0)`），保持"遇到 `empty` 即 break"的短路语义
2. 修正 `site-shelter-adapter.ts:33-34` 的注释，使其陈述实际语义，不要留下反向理由
3. 同步更新 `site-shelter-adapter.test.ts`：**必须包含一个"脚下深、头顶暴露"的用例，
   断言其被判为不合格** —— 这是当前实现会漏掉的情况，是本次修改的核心回归保护
4. 核对 `packages/skills/src/planning/site-assessor.ts` 的
   `burialDepth` / `burialDepthTarget` 语义描述与新契约一致；schema 结构不要改
5. 不要回滚并行任务对 `failure-classifier.ts` 及两份文档的改动，只在语义冲突处对齐
6. 提交这批收尾改动，然后跑**整树** `pnpm check` 并留档退出码

若你认为上述裁定有事实错误，停下并给出反证，不要两种语义混用。

## 任务 B：vLLM 部署（远程写操作已授权，边界见下）

按附件宿主层顺序执行。CPU 回退已证实，因此 SM121 原生 kernel 不再是"顺便验证"，
而是本项目能否用上 GB10 的唯一路径。

顺序不可调换：
1. 装 vLLM + Transformers（`>=5.8`），记录实际版本，四元组写死留档
2. **未调优 vLLM 基线**先跑一次并留档（附件第 6 条纪律：
   不接受把多项改动打包成一个"优化后"数字）
3. SM121 原生 kernel 验证 —— 给可复现的 dispatch 证据，不接受"应该是"。
   若 stock 镜像走回退，按附件从源码多阶段构建
4. 逐项单变量测量：CUDA graphs 开/关、KV dtype（fp8 vs auto）、
   prefix caching、chunked prefill 分块、最大并发（与 `AIRequestScheduler` P30 对齐）
5. `max-model-len` 按 Planner 128 KiB 上限设，**不要**为 Ornith 声明的 262K 挤 KV cache
6. Ornith MTP **默认关闭**，但实测一次开/关对比并留档（预期负收益：
   接受率约 21.7%、吞吐 0.68–0.71x）

**拉权重前**：先核实 HuggingFace 仓库确实存在且为 NVFP4 safetensors。
仓库不存在、改名或格式不符时**停下报告，不要自行替换成名字相近的其他仓库** ——
附件已明确排除若干打包异常变体。

**远程边界（越界即停）**：不许停止或干扰现有 Ollama（`11434` 保持可用）；
不许删改非你创建的容器/镜像/卷；不许 `docker system prune` 或任何批量清理；
不许改 Spark 驱动、CUDA、系统配置、用户/SSH/防火墙。

**watchdog**：镜像拉取 `≤30 min`、源码构建 `≤90 min`、权重下载 `≤90 min`，
无进展即判卡死、停止报告，不要无限重试。

## 无人值守纪律

- 岔路不猜：做完所有不依赖该决策的部分，把问题列进报告
- "验收缺一项就算没完成"**不等于**"没全绿就不交"。按序推进，做多少交多少，
  写清哪项未完成、卡在哪
- 审批服务 503：保持工作树不动、等待，**不要绕过审批链**
  （包括不要改用 Spark 上的 Codex 执行本应本地审批的命令）
- `.env.example` 的 `AI_REQUEST_TIMEOUT_MS=30000` / `AI_MAX_CONCURRENCY=4`
  与旧结论冲突，但旧结论已随 CPU 回退作废 —— 拿到真实 vLLM 数据后再改，中途不动

## 硬约束（不变）

不改 planner 提示词内容。abliteration 不构成安全边界：敌我识别白名单、
ServerPolicy 的 anti-cheat/reach/转头/时序/动作速率闸门继续由确定性代码执行。
模型输出按不可信数据处理，只能是 noop 或 Runtime 已广播的单个 Skill。
模型卡自报数据一律以本机实测为准。不提交密钥/token/仓库凭据。
不动 git config，不 force push。

## 交付

1. 任务 A：契约裁定落地、回归用例、整树 `pnpm check` 退出码
2. `docs/runbooks/` 下的部署 runbook：四元组、SM121 构建与验证步骤、
   compose override、环境变量、启动/健康检查/回滚、MTP 关闭决策及实测依据
3. 五组实测：tok/s、prefill 与 TTFT（4k/50k/100k）、JSON 合规率、拒答率、
   KV cache 与 4/8/16 并发
4. 宿主层逐项优化的增量贡献（单变量，不打包）
5. 明确标注 `planner-model-selection-2026-08-22.md` 已失效及原因
6. 选型若偏离 Ornith，写明是哪一项验收失败导致

# Spark 本地 AI Hub 阶段 1：只读四元组与工作树报告

采集日期：2026-08-23（Asia/Shanghai）
目标：`rennaikank@192.168.100.2`（GB10，`aarch64`）
证据时间点说明：pnpm check 与工作树干净结论对应本阶段拆分提交完成后的采样。报告提交后，另一条并行 Codex 线程在同一 worktree 产生了未提交的 shelter/runbook/skills 改动；这些改动不属于本报告，当前状态以交付时的 git status 为准。

范围：只读取证与本地 Git 整理。没有在 Spark 上执行拉镜像、构建、下载、配置、`docker run`、部署或停止服务。

## 结论摘要

- `qwen-fast:latest` 的观测路径为 **已证实回退到 CPU**。`size_vram=0`、Ollama 日志中的 `reason=cpu` 和 CPU buffer 证据相互吻合；推理期间没有 Ollama compute PID。
- 上一轮 120 秒超时不能作为模型选型证据。回退是已确认的共同混杂因素，但现有采样没有 native/CPU 配对实验或 kernel trace，因此不能给出“超时中有多少百分比由回退造成”的数值。
- 四元组以本机为准：driver `580.173.02`，CUDA `13.0 / 13.0.88`（SDK `13.0.3`），vLLM **未安装/未观测**，Transformers **未安装/未观测**。
- 当前最新 `/api/ps` 为 `{"models":[]}`；历史加载快照中的模型权重/缓冲约占 51.3 GiB。CUDA graphs 没有独立字节证据，不能估算。
- `tmp-apply-test.txt` 已删除；改动已拆成 8 个独立提交；工作树干净；拆分后 `pnpm check` 退出码为 0。

## A. sm_121 回退取证

### 实测证据

| 证据 | 观测值 | 判定意义 |
| --- | --- | --- |
| Ollama 版本 | `0.32.14`；服务 PID `3060`，Snap launcher PID `2435` | 当前服务身份 |
| 编译目标 | Ollama 可执行文件为 `ELF 64-bit LSB pie executable, ARM aarch64` | 只证明 ARM64 用户态，不证明 SM121 kernel dispatch |
| 历史 `/api/ps` | `qwen-fast:latest`，`size=55,096,440,256 B`，`size_vram=0` | 模型没有被记为 VRAM 驻留 |
| Ollama 加载日志 | `disabling mmap ... reason=cpu`；`CPU model buffer size = 51305.09 MiB`；`CPU KV buffer size = 544.00 MiB`；`CPU compute buffer size = 296.30 MiB`；`CLIP using CPU backend` | 直接指向 CPU backend |
| 推理期间/同期 `nvidia-smi` | compute-app 查询没有 Ollama runner；只见 Xorg `65 MiB`、GNOME Shell `57 MiB` 图形占用 | 没有观察到 Ollama CUDA compute context |
| 最新 `/api/ps` | `models=[]` | 当前没有可称为“常驻模型”的活动加载；与历史快照分开记录 |

**结论（限定三选一）：已证实回退。** 这里的“回退”是对上述 `qwen-fast` 观测路径的结论，不是对所有未来 Ollama/vLLM 构建的泛化结论。二进制中存在 CUDA 组件也不能推翻运行时 CPU dispatch 证据。

### 120 秒超时的归因边界

可以确认：上一轮完整生产形状请求（`6,501` bytes prompt、`2,436` prompt tokens、`num_predict:512`）是在至少一个候选实际走 CPU 的服务条件下观察到的。因此那批延迟不能用于比较模型选型，整批结果应视为被运行时路径污染。

不能确认：没有同一模型在 native SM121 与 CPU 路径上的配对耗时、没有请求期间的 GPU 利用率/runner 时间序列，也没有 profiler kernel dispatch，所以无法把 120 秒中的某个比例归给 kernel 回退，也不能把附件中的“3 倍”当成本机实测。严格数值答案是“不可分离、不可量化”；模型本身的贡献仍是未知，而不是被证明为零。

### 可复现判定方法（全为观测命令）

1. 请求前后记录 `curl -fsS http://127.0.0.1:11435/api/ps`，保存 `size` 与 `size_vram`；同时在 Spark 上记录 `pgrep -af 'ollama|runner'`、`readlink -f /proc/<pid>/exe` 与 `file /proc/<pid>/exe`。
2. 在一次完整请求的整个生命周期内循环采样：

   ```bash
   nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader
   nvidia-smi pmon -s um -c 1
   ```

   把时间戳、runner PID 和显存字节数写入同一份日志。

3. 读取 Ollama 服务日志（例如 `journalctl -u ollama --since ...`），检索 `load_tensors`、`reason=cpu`、`CPU model buffer`、`GPU model buffer`、`offload`、`backend` 和 runner 行。
4. 只有同时满足“请求期间出现 Ollama runner compute PID、非零显存、GPU/offload buffer、并且 profiler（如 Nsight Systems/Compute）捕获到 SM121/`compute_121` kernel dispatch”才判为**已证实走原生路径**。
5. 出现 `reason=cpu` 或 CPU model/KV buffer，且请求期间无 Ollama compute PID/显存，则判为**已证实回退**。
6. 只有架构字符串、CUDA 库或静态二进制信息而缺少请求期间 dispatch 证据时，判为**证据不足**。该判定矩阵应作为下一轮 vLLM/Ollama 基准的门禁。

## B. 已知良好四元组与镜像清单

| 组件 | 本机实测版本/状态 | 证据与备注 |
| --- | --- | --- |
| NVIDIA driver | `580.173.02` | `nvidia-smi` |
| CUDA | driver/runtime `13.0 / 13.0.88`；CUDA SDK `13.0.3` | `nvidia-smi`、`/usr/local/cuda/version.json` |
| vLLM | **未安装/未观测** | Python distribution 查询与 `vllm --version` 均未得到版本；当前服务是 Ollama |
| Transformers | **未安装/未观测** | Python distribution 查询未得到版本；Ornith serving 要求 `>=5.8`，当前前置条件未满足 |
| Ollama（对照） | `0.32.14` | 本机当前推理服务，不属于目标四元组 |

Spark Docker daemon 的只读镜像清单如下（未执行 pull）：

| 镜像 | 观测大小 | 架构/备注 |
| --- | ---: | --- |
| `vllm/vllm-openai:latest` | `22.5 GB` | `arm64` |
| `nvcr.io/nvidia/vllm:26.05.post1-py3` | `20.4 GB` | `arm64` |
| `nvcr.io/nvidia/pytorch:24.12-py3` | `17.9 GB` | `arm64` |
| `ghcr.io/open-webui/open-webui:main` | `4.6 GB` | 已有镜像；架构未在本次摘要中单独取证 |
| `alpine:latest` | `8.66 MB` | 基础镜像 |

磁盘预检结果：根分区约 `3.7T`，已用 `419G`，可用 `3.1T`。该结果只证明当前空间门槛，不授权本阶段下载。

## C. 统一内存分解

物理总内存为 `/proc/meminfo MemTotal=127600728 kB`（约 `121.7 GiB`）。历史 `qwen-fast` 加载日志给出的组件如下：

| 部分 | 实测值 | 说明 |
| --- | ---: | --- |
| 权重（CPU model buffer） | `51,305.09 MiB` | 约 `50.10 GiB`；与 `/api/ps size` 是不同统计口径 |
| KV cache（CPU） | `544.00 MiB` | 日志明确标注 CPU KV |
| compute buffer | `296.30 MiB` | CPU compute buffer |
| recurrent state | `149.62 MiB` | 日志项 |
| output buffer | `0.95 MiB` | 日志项 |
| multimodal compute | `248.10 MiB` | 日志项 |
| CUDA graphs | **未观测** | 日志和 `nvidia-smi` 没有独立字节数；禁止估算 |
| 上述已列项合计 | `52,544.06 MiB`（约 `51.31 GiB`） | 不含不可观测的 CUDA graphs、allocator 碎片和 OS 开销 |

另一次 Ollama cgroup 采样为 `55,501,852,672 B`（约 `51.690 GiB`），其中 file cache `55,358,177,280 B`（约 `51.556 GiB`），anon `14,434,304 B`。file cache 是可回收缓存，不能当作活动权重；最新 `/api/ps` 为空时，**活动常驻模型分配为 0（未观测）**，但 cgroup 仍可能保留这部分文件缓存。GPU 图形进程只见 Xorg `65 MiB` 与 GNOME Shell `57 MiB`，没有 Ollama compute 显存。

若用历史 `/api/ps size` 做账面并行上限：`121.7 GiB - 51.313 GiB ≈ 70.4 GiB`。这是从实测总量和实测模型 footprint 得出的算术余量，不是可用内存保证；OS、缓存、vLLM KV cache、CUDA graphs 和碎片必须在启动自建 vLLM 容器后重新测量。当前没有运行 vLLM，也没有为其预留或消耗内存。

## D. 本地工作树与检查证据

`tmp-apply-test.txt` 已删除，`runtime-data/` 仍由 `.gitignore:15` 排除。改动按主题拆分为以下独立提交，未 force push、未修改 git config、未推送远程：

| 顺序 | 提交 | 主题 |
| ---: | --- | --- |
| 1 | `633c40d` | combat：确定性 combat driver 与 Mineflayer adapter |
| 2 | `fc38e0c` | bot-assignment / task-delivery：分配、租约、投递 |
| 3 | `798bc27` | world-memory：按 serverProfile 隔离的仓库与迁移 |
| 4 | `74f4557` | isolated-deterministic-handler：隔离验收 digest handler 与测试 |
| 5 | `e257ddf` | docs/benchmarks：Spark 修正条款、只读审计脚本、OpenAI benchmark 口径 |
| 6 | `7c952f6` | world-memory CI：基础设施测试工作流硬化 |
| 7 | `cdf5d76` | 其余 skills：确定性非战斗规划层 |
| 8 | `8c9365b` | 其余 bot-runtime：权威世界动作与 shelter adapter |

拆分后先做了各包的类型检查/定向测试，再运行总检查。最后一次 `pnpm check` 退出码为 `0`，证据摘要：

| 检查项 | 结果 |
| --- | --- |
| 全 workspace typecheck | PASS |
| skills 测试 | `412 passed` |
| bot-runtime 测试 | `130 passed, 4 skipped`；supervisor node tests `2 passed` |
| combat 测试 | `210 passed` |
| coordinator 测试 | `136 passed` |
| workflow policy | `MINECRAFT_ACCEPTANCE_WORKFLOW_POLICY=PASS` |
| dashboard tests/build 与 Next production build | PASS |
| `git diff --check`、`git status --porcelain` | PASS；工作树干净 |

运行时事实源为 `apps/coordinator/src/planner-prompts.ts:1` 的 `minecraft-local-planner-v5`；`docs/LOCAL_AI_PROMPTS.md:4` 仍写 `v3`。本阶段只记录该文档滞后，没有修改提示词内容或版本字符串。`.env.example` 的 `LOCAL_AI_PROVIDER=vllm`、`LOCAL_AI_MODEL`、`AI_REQUEST_TIMEOUT_MS=30000`、`AI_MAX_CONCURRENCY=4` 未改动；与后续 Spark 实测口径的 `120000` / `1` 冲突留待验收后处理。

## 需要远程写权限才能继续的动作

以下是后续阶段的动作清单，本阶段均未执行。时间是执行时的计划窗口，不是本阶段伪造的实测；每一步必须记录真实 wall-clock、峰值 RSS/cgroup 和显存，单步超过 90 分钟无进展即停止。主控模型路径和格式必须先独立确认存在且为 NVFP4 safetensors，失败就停，不自行替换仓库。

| 动作 | 计划耗时上限 | 内存/磁盘代价（当前可核对值） | 前置与边界 |
| --- | --- | --- | --- |
| 核对 Hugging Face 仓库、manifest、safetensors dtype/大小 | `≤15 min` 观测窗口 | 不写 Spark；下载元数据的缓存代价未测，执行时记录 | 发现仓库不存在或格式不符立即停止 |
| 拉取指定上游 vLLM 镜像 | `≤30 min`，无进展停 | 已有同类镜像 `20.4–22.5 GB`；新增层的实际磁盘/RAM 以 `docker system df`/cgroup 记录 | 只允许创建/使用本阶段自有资源，不清理既有镜像 |
| 从源码多阶段构建 SM121 kernel（若镜像不含 native path） | `≤90 min` watchdog | 构建峰值内存**未观测，不能估算**；构建缓存磁盘由 `docker system df` 实测 | 不改驱动/CUDA/系统配置；卡死停止 |
| 下载 Ornith 主控 NVFP4 权重 | `≤90 min` watchdog | 计划文件约 `20.2 GB`（授权条款给定，须以 manifest 复核）；下载阶段不加载模型，RSS/缓存需实测 | 磁盘预检已见可用 `3.1T`；不满足格式/校验即停 |
| 下载战术层权重（仓库确认后） | `≤90 min` watchdog | 文件大小尚未核实；不得以模型卡估算，按 manifest 与 cgroup 实测 | 只写指定模型目录 |
| 创建 compose override 并启动自建 vLLM 容器 | 创建 `≤10 min`；启动观察 `≤30 min` | 权重、KV cache、CUDA graphs 的峰值均**待实测**；历史 Ollama 活动 footprint 约 `51.313 GiB` 时账面余量约 `70.4 GiB`，不是安全保证 | 11434 Ollama 必须保持可用；只操作自己创建的容器 |
| 走 `/v1/models` 健康检查并运行 `benchmark:spark` OpenAI 兼容基线 | `≤30 min` | 不新增权重；服务运行时增量显存/RSS、KV、graphs 必须采集 | 记录并发、`timeoutMs`、tok/s 与 kernel dispatch；不得引用旧 `/api/chat` 数据 |
| 停止自己创建的 vLLM 容器 | `≤5 min` | 释放该容器实测的 RSS/显存；不删除或干扰 Ollama、非自有容器/卷 | 停止前先停止接单并留审计记录 |

### 本阶段未完成项

vLLM/Transformers 尚未安装，SM121 native kernel 的 profiler dispatch 尚未取得，Ornith 仓库存在性/格式尚未核验，且没有启动 vLLM 基线。这些是下一阶段的门禁，不在本报告中推断或替换模型选型。

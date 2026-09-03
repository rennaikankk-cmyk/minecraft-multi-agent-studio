# SPARK_DEPLOYMENT_MATRIX（四模型部署与选型记录）

> 实测时间 2026-09-03。单台 DGX Spark（GB10，统一内存）。磁盘：`/dev/nvme0n1p2`
> 3.7T 总量 / **2.8T 空闲**（够全部候选）。
> 纪律：一次只跑一个部署栈；不得删除/覆盖 M2 incumbent；切换记录五时点
> （停止/卸载/加载/预热/ready）；冷启动与切换时间不计 TTFT（单独运维指标）。

## M2 — Qwen3.8-Flash-Next（当前 incumbent，在线运行中）

**实测读取（docker inspect + /v1/models，2026-09-03，容器 Up 42h）**

| 项 | 值 |
|---|---|
| 容器名 | `qwen38-mazinb` |
| 镜像 | `vllm/vllm-openai:qwen38-flash-next`（digest `sha256:d464f3b466fa…f0df5a4a`） |
| vLLM 版本 | `0.1.dev20073+g8e685d198`（自定义 dev 构建，非上游 release） |
| 模型路径 | `/home/rennaikank/models/mazinb-nvfp4` → `/model`（**177G**，PLE 专家分片布局） |
| 架构 | `Qwen4ExpForConditionalGeneration` |
| served 名称 | **双名**：`qwen3.8-flash-next` + `qwen3.8-flash-next-uncensored`（同一 checkpoint） |
| serve 参数 | `--max-model-len 65536 --max-num-seqs 4 --gpu-memory-utilization 0.75 --enable-chunked-prefill --no-enable-prefix-caching --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 --speculative-config {"method":"mtp","num_speculative_tokens":2} --distributed-executor-backend mp` |
| 端口 | 0.0.0.0:18300 → 容器 8000（免鉴权） |
| PLE | `VLLM_PLE_CPU_OFFLOAD=1`、`VLLM_PLE_OFFLOAD_READY_TIMEOUT=1800`、`HF_HUB_OFFLINE=1`（mmap CPU offload 在用；NVMe 延迟/页故障指标采集=待办 S-12） |
| prefix cache | **关闭**（--no-enable-prefix-caching） |
| 并发 | max-num-seqs 4（生产实测唯一安全值；容量研究推荐 3） |

**待补记录**（下一窗口）：checkpoint 源仓库与 revision（本地目录无 README/rev 文件，
需回溯下载来源）；镜像构建脚本与本地补丁清单；PLE mmap 实际路径与 NVMe 挂载点。

**定位**：复杂长期规划、Incident 诊断、高能力主控挑战者。禁止删除/覆盖。

## M1 — Ornith-1.5-35B-A3B-Heretic（已在盘，未部署验证）

| 项 | 值 |
|---|---|
| 候选 | `spele1100/Ornith-1.5-35B-A3B-Heretic-GB10-NVFP4`（主候选，低拒绝在线主控） |
| 本地路径 | `/home/rennaikank/models/spele1100--Ornith-1.5-35B-A3B-Heretic-GB10-NVFP4/c56d7696e9022d5d76ae211021924ac5a2d8aa95/` |
| revision | 目录名即快照 sha：`c56d7696e9022d5d76ae211021924ac5a2d8aa95` |
| 体积/文件 | **21G**；model-0000{1..5}-of-00005.safetensors + index + recipe.yaml（llmcompressor 配方）+ config.json.llmcompressor-text.bak（text-only 压缩备份） |
| 架构 | `Qwen3_5MoeForConditionalGeneration` |
| GB10 适配 | 仓库名含 GB10（为此平台制作）——仍需本机加载验证 |
| 待办 | ①部署冒烟（同一 vLLM 镜像能否服务 Qwen3_5Moe + NVFP4）②tool-call/reasoning parser 选型 ③MTP ④并发阶梯 ⑤官方基线 `ornith-ai/Ornith-1.5-35B-A3B-NVFP4` 对照下载 |

**定位**：低延迟、多并发、低拒绝在线主控候选。

## M3 — Qwen3.6-35B-A3B NVFP4（未下载）

- 官方基线：`nvidia/Qwen3.6-35B-A3B-NVFP4`（ModelOpt 量化；HF 存在 ✓ 审计 2026-09-03）。
- 社区变体：unsloth / RedHatAI（llm-compressor 权重+激活双量化，vLLM main 实测）亦有 NVFP4 版；无审查 Heretic/abliterated 版**存在性待研究**（S-5）。
- 验收：GB10 加载、text/image 输入、工具调用、FP8 KV、prefix cache、MTP、
  1/2/4/8/16 并发、重启恢复、长上下文质量。

**定位**：Ornith 最直接的通用在线主控竞争者。

## M4 — Qwen3-Coder-30B-A3B-Instruct NVFP4（未下载；审计完成）

- **无官方 NVIDIA NVFP4**。`nvidia/Qwen3-30B-A3B-NVFP4` 是普通 Qwen3-30B-A3B
  ——**禁止误用为 M4**（用户明令）。
- 社区候选：`NVFP4/Qwen3-Coder-30B-A3B-Instruct-FP4`（org "NVFP4"，183 模型，
  非官方确认的 NVIDIA 账号）。审计结论（2026-09-03）：
  - ✓ ModelOpt 工具出品（tags/library）；14.6 万下载、apache-2.0、无 gate
  - ✓ 无隐藏 prompt（chat 模板=官方 Qwen3-Coder agentic 模板）、无 remote code
  - ✓ 张量构成合理（BF16 635M / F8_E4M3 1.87B / U8 打包 FP4 14.95B，18.1G）
  - ✗ 量化校准细节缺失（无数据集/样本/PTQ-QAT 说明）
  - ✗ 无 GB10/DGX Spark 验证记录；模型卡=基座卡复制
  - **判定：可用作基线候选，但须本机 GB10 加载+质量验证后才算数**；
    完全可追溯的备选=从官方 `Qwen/Qwen3-Coder-30B-A3B-Instruct` 基座用
    llm-compressor 自量化（Spark 上已有 recipe 先例）。
- EAGLE3/int4-lm_head 增强版只能作独立优化栈，性能不得混入普通基线。

**定位**：低延迟非思考结构化工具调用候选；代码基准≠Minecraft 主控资格。

## 部署切换记录模板（每次切换必填）

```
[时间] 停止(旧栈) / 卸载完成 / 加载开始 / 预热(首 token 前) / ready
模型ID+revision / 容器 digest / serve 全参数 / 磁盘占用
可复现启动命令：…
完整卸载/回滚命令：…
```

## 资源与隔离规则

- 四模型独立目录、独立启动配置、固定 SHA 记录（M2/M1 已满足）。
- 单 Spark 不同时常驻多模型；测试栈内存/KV/CUDA Graph 结果必须可归因。
- 下载去重：同基座不重复下载（2.8T 余量下仍按 hash 校验复用）。

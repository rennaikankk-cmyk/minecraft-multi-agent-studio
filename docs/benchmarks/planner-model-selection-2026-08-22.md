# DGX Spark Planner 模型选型基准（2026-08-22）

## 结论

本轮没有冠军，也没有亚军。四个候选均未完成五条硬门，因此按规则不进入 100 分评分，不能把部分样本外推成完整分数。

- `qwen3.5:27b` 是唯一在完整生产 Planner prompt、JSON Schema、`think:false`、`num_predict:512` 下返回过可严格解析决策的候选，但两次成功请求仍分别耗时 `66,264 ms` 和 `81,613 ms`，远超默认 `30,000 ms`。
- `qwen-fast:latest` 的冷、热生产形状请求分别在 `120,016.307 ms`、`120,003.008 ms` 超时；运行后观察到约 `3.26 GB` swap 已使用，不能作为 30 秒配置的可用锚点。
- `qwen3.8-27b-abliterated:latest` 的冷、热请求分别在 `120,004.868 ms`、`120,016.154 ms` 超时，且 `/api/show` 不提供许可证元数据，按 fail-closed 处理。
- `qwen3.5:35b` 在一次 `600,000 ms` 质量窗口和后续 `180,000 ms` 有界重试中均未得到可记录响应；模型能在 ARM64 Ollama 驻留，但未跑通生产请求。

因此不能把 `AI_REQUEST_TIMEOUT_MS` 从 Spark 当前的 `120000` 降回默认 `30000`。保持现役模型只是“没有合格替代品”的保守操作，不代表 `qwen-fast:latest` 通过本轮验收。

## 环境与请求形状

| 项目 | 实测值 |
| --- | --- |
| 主机架构 | `aarch64` |
| Ollama | `0.32.14` |
| 统一内存 | `130,661,703,680` bytes |
| 官方内存带宽 | `273 GB/s` |
| 本机入口 | `http://127.0.0.1:11435`，SSH 本地转发到 Spark 回环 `11434` |
| API | Ollama 原生 `/api/tags`、`/api/show`、`/api/chat`、`/api/ps` |
| 生成参数 | `think:false`、`temperature:0`、`num_predict:512` |
| 完整 prompt | `6,501` bytes、Ollama 报告 `2,436` prompt tokens（已完成探针） |
| JSON Schema | 生产 `localPlannerDecisionSchema` 的目录约束生成变体，响应再经完整协议 Schema 严格解析 |

NVIDIA 官方规格：[DGX Spark 产品页](https://www.nvidia.com/en-us/products/workstations/dgx-spark/)。Ollama 原生接口：[API 文档](https://docs.ollama.com/api/introduction)。

## 候选发现

候选先由 `/api/tags` 实际发现，不使用静态清单。tag 和 digest 在探针前后保持稳定。

| 模型 | 路线 | 参数/量化 | 拉取体积 | `/api/ps` 驻留分配 | 许可证证据 |
| --- | --- | --- | ---: | ---: | --- |
| `qwen-fast:latest` | 稠密 | 27.3B F16 | 55,589,871,816 B | 55,096,440,256 B | `/api/show` 无元数据，失败 |
| `qwen3.8-27b-abliterated:latest` | 稠密 | 27.3B F16 | 55,589,871,817 B | 59,869,600,151 B | `/api/show` 无元数据，失败 |
| `qwen3.5:27b` | 稠密 | 27.8B Q4_K_M | 17,420,432,728 B | 22,295,126,997 B | Apache-2.0，通过 |
| `qwen3.5:35b` | MoE，256 experts / 8 active | 36.0B Q4_K_M | 23,869,191,742 B | 25,077,942,842 B | Apache-2.0，通过 |

MoE 的驻留内存确实只比 27B Q4 高约 `2.78 GB`，但本轮没有得到完成的生产请求，不能据此推导它更快。GB10 的带宽瓶颈假设未被本轮延迟数据验证。

## 五条硬门

`通过` 只表示已有足够实测证据；没有跑完要求时记为 `未通过`，不猜测。

| 模型 | 100/100 Schema | `think:false` | c4 内存/swap | Ollama ARM64 跑通 | 私有使用许可 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| `qwen-fast:latest` | 未通过：0/100，冷/热均超时 | 未验证：0 个完成响应 | 未通过：c4 未运行；驻留 55.10 GB，运行后 swap 使用约 3.26 GB | 未通过：2/2 在 120s 超时 | 未通过：无许可证元数据 | 淘汰 |
| `qwen3.8-27b-abliterated:latest` | 未通过：0/100，冷/热均超时 | 未验证：0 个完成响应 | 未通过：c4 未运行；驻留 59.87 GB | 未通过：2/2 在 120s 超时 | 未通过：无许可证元数据 | 淘汰 |
| `qwen3.5:27b` | 未通过：只完成 2/100；2/2 严格解析成功 | 通过：已完成探针无 thinking 输出 | 未通过：c4 矩阵未完成；驻留 22.30 GB | 通过：2 次生产形状请求完成 | 通过：Apache-2.0 | 淘汰（硬门 1/3 未完成） |
| `qwen3.5:35b` | 未通过：0/100 | 未验证：0 个完成响应 | 未通过：c4 未运行；驻留 25.08 GB | 未通过：有界窗口内无响应 | 通过：Apache-2.0 | 淘汰 |

`qwen3.5:27b` 的两个完成响应均满足：JSON 单对象、无 Markdown 围栏、无多字段/少字段、`reasonCode` 在枚举内、`botId`/`taskId` 原样回填、技能与输入 Schema 正确、无接地拦截。样本只有 2 个，不能替代硬门要求的 100 个。

## 评分表

硬门失败的候选不进入评分。下表保留每一评分格，并给出没有分数的直接实测原因。

| 模型 | Schema /25 | 技能选择 /25 | 延迟 /20 | 接地 /15 | 稳定性 /10 | 运维 /5 | 总分 /100 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `qwen-fast:latest` | N/A，0 完成 | N/A，0 完成 | N/A，2/2 >120s | N/A，0 完成 | N/A，c4/52 未运行 | N/A，55.59 GB；许可未知 | N/A |
| `qwen3.8-27b-abliterated:latest` | N/A，0 完成 | N/A，0 完成 | N/A，2/2 >120s | N/A，0 完成 | N/A，c4/52 未运行 | N/A，55.59 GB；许可未知 | N/A |
| `qwen3.5:27b` | N/A，2/2 有效但不足 100 | N/A，2/2 invoke 正确；0 noop 样本 | N/A；若只看成功 c1，p95 81.61s，延迟子分将为 0 | N/A，0/2 触发 | N/A，c4/52 未完成 | N/A，17.42 GB；Apache-2.0 | N/A |
| `qwen3.5:35b` | N/A，0 完成 | N/A，0 完成 | N/A，>600s 有界样本 | N/A，0 完成 | N/A，c4/52 未运行 | N/A，23.87 GB；Apache-2.0 | N/A |

因为没有候选进入评分，按规则不存在“相对分最高但仍淘汰”的冠军或亚军。把未运行格记 0 再排名会制造虚假精度。

## 原始延迟分布

单位为毫秒；`>` 表示右删失样本（到超时仍未完成）。这些是端到端 `/api/chat` 时间，包含 TTFT。

| 模型 | 阶段 | 原始样本 | p50 | p95 | 完成/尝试 |
| --- | --- | --- | ---: | ---: | ---: |
| `qwen-fast:latest` | 冷/热生产形状 | `>120016.307`, `>120003.008` | >120003.008 | >120016.307 | 0/2 |
| `qwen3.8-27b-abliterated:latest` | 冷/热生产形状 | `>120004.868`, `>120016.154` | >120004.868 | >120016.154 | 0/2 |
| `qwen3.5:27b` | 独立完成探针 | `66264`, `81613` | 66264 | 81613 | 2/2 |
| `qwen3.5:35b` | 有界生产形状 | `>600000`, `>180000` | 不计算 | 不计算 | 0/2 |

`qwen3.5:27b` 的详细完成样本之一：TTFT `55,898 ms`，总耗时 `66,264 ms`，prompt eval `43,415 ms`，decode `10,550 ms / 65 tokens`。另一完成样本总耗时 `81,613 ms`、`141` completion tokens。即使输出短，prompt eval 与首 token 已经吃掉 30 秒预算。

并发 1/2/4/8/10 的计划请求数为 `4/4/8/16/20`，合计 52。所有候选都在矩阵前的硬门阶段失败，因此矩阵实际完成 `0/52`；没有零错误推荐并发值，也没有可报告的 c4 p50/p95。脚本会在候选通过冷/热生产形状后自动执行该矩阵。

## 淘汰理由

- `qwen-fast:latest`：现役 F16 基线在 120 秒冷/热窗口均超时，未达到 30 秒目标；许可证来源无法由 `/api/show` 审计；运行期间系统发生明显换页。
- `qwen3.8-27b-abliterated:latest`：与现役相同的 F16 尺寸，120 秒冷/热均超时；许可证元数据同样缺失。由于没有完成响应，本轮无法评估 abliterated 对诚实 noop 的影响。
- `qwen3.5:27b`：输出质量最有希望且许可证清楚，但成功请求 p95 为 81.61 秒，延迟分为 0；未完成 100 次 Schema 门和 c4 内存门。
- `qwen3.5:35b`：MoE 的驻留内存较小，但完整生产请求在最长 600 秒窗口内仍未返回，无法验证结构化输出和 `think:false`。

## 生产 Schema 修复

原始 `z.toJSONSchema(localPlannerDecisionSchema)` 在 Ollama `0.32.14` 上会因完整 SemVer regex 返回 HTTP 400：`Failed to initialize samplers: failed to parse grammar`。Planner 现在用 Runtime 实际广告的 `skillId`/`skillVersion` 精确枚举进行约束生成，响应仍由完整协议 Schema 二次严格解析。这是更窄的生成约束，没有放松 fail-closed 校验。

`reasonCode` 也由宽泛大写正则收紧为有限语义枚举，使基准和生产解析一致。

## 复现

先按 `docs/LOCAL_AI_PROMPTS.md` 建立本地转发并确保最新构建产物可用：

```powershell
pnpm build:control-plane

$env:AI_BENCH_MODE='full'
$env:AI_BENCH_MODELS='qwen-fast:latest,qwen3.8-27b-abliterated:latest,qwen3.5:27b,qwen3.5:35b'
$env:AI_BENCH_GATE_REQUESTS='100'
$env:AI_BENCH_TIMEOUT_MS='30000'
$env:AI_BENCH_QUALITY_TIMEOUT_MS='120000'
$env:AI_BENCH_OUTPUT='runtime-data/planner-model-selection-2026-08-22.json'
$env:AI_BENCH_SSH_TARGET='user@approved-spark-host'
$env:AI_BENCH_SSH_KEY='C:\path\to\approved-key'
node scripts/run-planner-model-benchmark.mjs
```

脚本只接受显式 loopback HTTP origin；SSH 目标只用于只读 `/proc/meminfo`、`/proc/vmstat`、架构和 Ollama 版本采样，并在报告中脱敏。每完成一个候选就 checkpoint 原始 JSON。`AI_BENCH_MODE=smoke` 可用于 20 请求预检，但不能作为选型分数。

脚本单测：

```powershell
pnpm test:planner-benchmark
```

## 建议的 `.env`

没有模型达到切换门槛，故不建议改成新候选。下面只是保守维持 fail-closed 的临时配置，不是 30 秒目标的验收结果：

```dotenv
LOCAL_AI_MODEL=qwen-fast:latest
AI_MAX_CONCURRENCY=1
AI_REQUEST_TIMEOUT_MS=120000
```

`AI_MAX_CONCURRENCY=1` 用于避免本轮已观察到的内存换页和 Ollama 队列放大；它不是 52 请求矩阵推导的最终值。高层 Planner 超时继续 fail-closed，L0 安全层和确定性技能不增加任何猜测兜底。

## 当前限制

- 没有候选完成 100 次 Schema 门，因此没有合法的 100 分排名。
- 没有候选进入 52 请求矩阵，因此不能给出基准导出的最终并发值。
- 两个自定义 F16 tag 的 `/api/show` 缺少许可证元数据；需要其构建来源或 Modelfile 才能解除许可硬门。

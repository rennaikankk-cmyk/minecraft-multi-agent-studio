# 模型选型评测契约（EVAL_CONTRACT v1 — 冻结于正式 M1/M2 重跑之前）

> 纪律：本契约一旦提交，正式 M1 轮与 M2 轮之间**禁止修改任何评测器或参数**。
> 此前的 M1 冒烟与 pilot 拒绝评测标记为 **CALIBRATION/PILOT**（含 M1 在
> max_tokens=200/300 的空 content 基线失败证据，见
> runtime-data/model-selection/baseline-evidence-M1.json——保留，不得被调优结果覆盖）。

## 请求参数（两模型完全一致）

| 参数 | 值 | 依据 |
|---|---|---|
| temperature | 0 | 确定性优先，消除采样噪声 |
| max_tokens | 3000 | 校准链：200/300 截断为空（基线失败证据）→ 700 仍 54/80 截断（pilot）→ 1500 时 2/11 截断（replay pilot）→ 3000=平均思考 575 的 5 倍余量；stop 前完成即止，不虚增延迟 |
| 有效样本判据 | finish_reason == "stop" | 截断（length）样本标记 TRUNCATED 单列，不计入质量结论 |
| system prompt | 各评测器内固化文本 | 拒绝评测与回放评测各自固定，两模型逐字节相同 |
| 并发 | 拒绝/回放评测=串行单流；负载评测=1/2/4/8/16 档 | 档位轮次内两模型同序同参 |
| 超时 | 单请求 120s；失败记 ERROR 不重试 | 错误率本身是指标 |

## 评测器（全部随本契约一次提交）

1. `eval/refusal/run-refusal-eval.mjs` — 80 条 EXECUTE 游戏指令；
   指标：GAME_ACTION_REFUSAL_RATE（refused+moralizing）、EMPTY、ERROR、
   延迟 P50/95/99。全样本留档（终审=人工抽检）。
2. `eval/replay/run-replay-eval.mjs` — 真实决策回放（当前 11 条，样本限制如实
   记录）；指标：jsonValidRate、toolNameLegalRate（对照 skill-system-v1
   manifest 的 23 技能）、延迟、avgReasoningTokens。
3. `eval/controller-ab/run-controller-ab.mjs` — 真实主控 A/B（隔离 fixture）：
   同一 studio 代码 HEAD、同 goal 集、同 seed 世界、同超时；
   唯一变量=LOCAL_AI_URL/LOCAL_AI_MODEL。指标：goal completion、
   time-to-first-valid-tool-call、per-goal 端到端延迟、无效工具调用数。

## 栈纪律

- 单栈串行：M1 轮=ornith15-heretic@18301（mazinb 停）；M2 轮=qwen38-mazinb@18300
  （ornith 停）。切换记录五时点；冷启动不计 TTFT。
- 评测顺序（每轮内）：refusal → replay → controller-ab。
- M1 轮与 M2 轮之间：禁止改评测器/参数/prompt/技能目录。

## 结果文件

- `runtime-data/model-selection/refusal-<TAG>.json` / `replay-<TAG>.json` /
  `controller-ab-<TAG>.json`（TAG 含模型与轮次标识；pilot 文件保留 `-pilot` 后缀）。

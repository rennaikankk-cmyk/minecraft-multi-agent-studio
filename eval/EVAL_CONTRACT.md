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

---

# v2 修订（2026-09-03，M1/M2 formal 同分后）

> v1 冻结纪律管的是"M1 与 M2 formal **之间**禁止改评测器"——两轮已跑完且
> 同分（controller-ab 2/10 vs 2/10，拒绝/回放硬门禁全同级），判别性问题
> 属于电池与样本设计，不属于被冻结区间。本节为正式修订记录，v1 正文
> 与 formal 结果文件原样保留（有效但无判别力）。

## 根因（用数字说话）

- controller-ab v1 电池 10 条**全部为观察叙述型**（"观察/汇报/描述/检查/
  评估"）——模型分支对这类 goal 合法 noop：M1 noop 率 0.7、M2 0.8，
  完成 2/10 对 2/10。同分是电池设计结果，不是模型等价的证据。
- replay 语料仅 11 条（规划输入按隐私设计未全量落日志），初筛性质。

## v2 变更清单

1. **controller-ab 电池 v2**：8 条工具强制型（中文措辞刻意避开
   deterministic-goals 模板动词与 registry 物品名 → 必走 LLM 分支；
   craft/collect×2/scan×2/food/shelter 各路径覆盖）+ 2 条 v1 原文对照。
   依赖世界状态的条目两轮同序执行（同条件公平）。
2. **noop 分账**：主判别指标 = actionableCompletionRate；
   noopOnActionable 单列（该派发却没派发=坏信号）；对照组 noop 为预期。
   汇总带 batteryVersion:"v2"。
3. **replay 语料扩充**：S-7 提取器（extract-replay-corpus.mjs）从
   coordinator.log 抽取 goal_request / autonomy_need / plan_supervision；
   采集开关 `STUDIO_REPLAY_CAPTURE=1`（local-planner S-12，有界 8MB）。
   目标 ≥30 条后重跑两轮回放。**捕获会话不构成评测**（只采输入）。
4. **M1 并发档**：load 评测（eval/load）对 M1 补跑 1/2/4/8/16 档，
   与 M2 同参同序——正式门槛的一部分（此前只跑了 M2）。
5. **seqs 上调实验独立于选型**：M2 当前 max-num-seqs=4 在 ≥8 并发
   TTFT P50 14.7-53s。seqs 4→8 的安全/质量重测是**服务端旁路实验**
   （建议旁路端口起第二实例，不动生产 18300），结果作为 G5（10-Bot）
   的容量依据，不改变 M1/M2 选型判据本身。
6. **v2 重跑纪律**：M1/M2 两轮在 v2 下完整重跑（TAG 带 `-v2`）；
   栈切换纪律不变（单栈串行、五时点记录）；refusal 电池未变，
   v1 formal 结果可沿用（硬门禁已同级 PASS）——除非 v2 轮发现回退。

## MODEL_SELECTION_COMPLETE 判据（v2）

- refusal：v1 formal 沿用（双 100% 工具合法性 / 拒绝率对比无回归）；
- replay ≥30 条：jsonValid / toolLegal 双 ≥95%，且延迟 P95 差异 <2×；
- controller-ab v2：actionableCompletionRate 差异 ≥0.25（8 条中 ≥2 条
  差距）或无效工具/规划拒绝率有实质差异；
- load：M1/M2 双侧同档数据齐全（含 M1 补跑档）。
四项齐 → 出 MODEL_SELECTION_COMPLETE/继续 BLOCKED 的书面结论。

# MODEL_CONTROLLER_EVAL（四模型主控赛马）

> 状态：**框架就绪，测试未开始**。硬性纪律：不得凭模型名预判；一次一栈；
> 相同输入/世界状态/验收条件；回放禁真执行；每模型 ≥3 轮；隔离服 ≥30 同种子任务；
> 切换记录五时点；冷启动不计 TTFT。部署事实见 SPARK_DEPLOYMENT_MATRIX.md。

## 候选与部署状态

| ID | 候选 | 部署 | 回放 | 隔离服 | 灰度 |
|---|---|---|---|---|---|
| M1 | Ornith-1.5-35B-A3B-Heretic-GB10-NVFP4（spele1100） | **已部署验证（07:04:46Z）** | **DONE（formal）** | **DONE（10-goal 电池）** | — |
| M1b | ornith-ai/Ornith-1.5-35B-A3B-NVFP4（官方基线） | NOT STARTED | NOT STARTED | NOT STARTED | — |
| M2 | qwen3.8-flash-next（mazinb incumbent，在线） | **RUNNING** | **DONE（formal 2026-09-03）** | **DONE（10-goal 电池）** | incumbent |
| M3 | nvidia/Qwen3.6-35B-A3B-NVFP4 | NOT STARTED | NOT STARTED | NOT STARTED | — |
| M4 | Qwen3-Coder-30B-A3B-Instruct NVFP4（社区候选已审计/备选自量化） | NOT STARTED | NOT STARTED | NOT STARTED | — |

## 指标（每模型×并发{1,2,4,8,16}×输入{2K,8K,32K,128K,真实分布}）

- 质量/闭环：verified completion、completions/hour、false success、lost/duplicate goal、
  无效 JSON/工具名/参数、不存在 capability 选择、调用顺序错、重试、recover 成功率、
  长任务遗忘、错误世界假设、own/team/facility 误伤、多 bot 公平性。
- 性能：TTFT、time-to-first-valid-tool-call、P50/95/99、单流/聚合 tok/s、rps、
  错误率、队列深度、最长等待、per-bot 等待、prefix hit、MTP acceptance。
- 资源：统一内存/权重/KV/CUDA Graph/activation 峰值、CPU/GPU/温度/功耗、OOM、
  崩溃、重启恢复时间。M2 额外：PLE page fault、NVMe 读量/延迟/抖动、命中率、
  长跑磁盘内存漂移。
- 场景（16 类）：单 bot 生存/多 bot 协作/manual 抢占/长期连续性/工具选择/缺失
  capability 诚实处理/卡住恢复/死亡回收/设施保护/地狱规划/外部基地识别/威胁判断/
  撤退冲突/服务重启/waiting 恢复/5-10bot 公平/Incident 分析。

## 测试矩阵执行状态

- [~] S-7 replay corpus ≥200（当前 11 条；两模型 formal 已各跑一轮；扩容依赖 S-12——如实不足，不注水）
- [x] S-8 离线回放（M1/M2 各 1 轮 formal：JSON/工具名双 100%；4 模型×3 轮待候选扩充与语料扩容）
- [~] S-9 隔离服任务（M1/M2 各 10-goal 电池完成；30 任务×4 模型与判别性电池重设计待做）
- [x] S-10 拒绝测试 M1/M2（80 EXECUTE 全过零拒绝；M3/M4 未部署）
- [ ] S-11 真实 5/10 bot 调度负载
- [ ] S-12 指标采集管线
- [~] S-13 判定：**MODEL_SELECTION_BLOCKED（判别性证据不足，2026-09-03）**——详见 docs/MODEL_SELECTION_REPORT.md；硬门禁双过、延迟分裂、样本不足，不强行选赢家

## 判定规则（固化，不得临场修改）

排序：①真实 verified completion ②lost/duplicate=0 且 protected-asset violation=0
③工具调用正确率 ④错误游戏指令拒绝率 ⑤恢复与长期连续性 ⑥10bot P95 延迟与公平
⑦completions/hour ⑧吞吐/内存/运维。

硬门禁：工具调用有效率≥99%；固定攻击指令集错误拒绝率=0；lost/duplicate=0；
violation=0；10bot 无长期饥饿；无持续乱码/循环/漂移；无不可自恢复 OOM；受控重启
不丢长期目标；manual stop/kill switch 可靠。

差额规则：第一名差距<3pp → 择低延迟/高吞吐/大内存余量/稳部署/低拒绝者。
M2 转正门槛：verified completion 高 ≥8pp **或** 重试/错误减 ≥25%，且仍满足 10bot
延迟/稳定/拒绝门禁。M4 不得因代码基准直通主控。
裁判：服务端状态 + 确定性验证器 + 日志证据 + 人工抽检（模型不当唯一裁判）。

## 最终结论（占位——无数据不填）

- ONLINE_CONTROLLER：`待定（候选：ORNITH_1_5 / QWEN_3_6 / QWEN3_CODER / QWEN_FLASH_NEXT / NO_WINNER）`
- PLANNING_AND_INCIDENT_MODEL：`待定`
- 唯一生产主控推荐：`待定`

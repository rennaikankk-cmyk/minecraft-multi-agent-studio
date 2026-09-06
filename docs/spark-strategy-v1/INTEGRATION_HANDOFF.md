# INTEGRATION_HANDOFF —— 交给 Codex（D3 集成审查后接线）

2026-09-06 统一接管终局更新：Rust CI、五项补修、D3 和默认关闭的只读观察入口已分阶段合入。本文后续内容保留为历史设计交接；当前范围、实测、并发与未完成门见 [TAKEOVER_RESULTS_2026-09-06.md](TAKEOVER_RESULTS_2026-09-06.md)。自动下发仍关闭。

GLM 原交接基线为 `75cab90`，原交付分支已推至 `bca26e1`。五项缺口由 Codex 在独立集成分支补修；生产接线仍须通过 D3 依赖门。当前证据见 [TAKEOVER_VALIDATION.md](TAKEOVER_VALIDATION.md)。

## 1. 输入/输出接口与来源

```
TeamFactsInput（apps/coordinator/src/spark-strategy-v1/facts.ts）
  ← 需要生产侧装配的输入事实：
     scope{serverProfileId, dimension, sessionEpoch?, observedAtMs}
       来源：ServerProfile（configs/servers/*.json）+ registry 当前连接；
       sessionEpoch 若接 WorldMirror 同步（P5-D2c WorldSyncAdapter）可直接复用。
     bots[]：BotRegistryRecord（apps/coordinator/src/bot-registry.ts）+
       BotStatusV1（packages/protocol/src/bot-messages.ts:1316）。
       currentTask ← 自主主管 active/goal 状态；inventory ← status.inventory。
       deaths ← 目前无真实来源（autonomous-director.ts:547 是 deaths:0 占位）：
       **必须传 "unknown" 直到真实来源接线**（死亡事件链在 bot-runtime 有 died 事件可上报）。
     team{sharedInventory, facilities, shortages, reservedResources}
       来源：SharedStateServer（facilities/workstation 注册）+ ProvenanceStore；
       短缺可由 build.blueprint receipt 的 BUILD_MATERIAL_MISSING incident 聚合。
     events[]：incident store（fingerprint/source/atMs）+ skill_result 事件。
     constraints.capabilities：packages/skills/skill-system-v1.manifest.json（23 技能）。
```

```
输出（本模块产出的纯建议，不落任何生产事实库）：
  SituationSummary（含 factVersion + tokenEstimate ESTIMATED）
  TeamProposal（proposalId/factVersion/scope/validUntil/assignments/dependencies）
  ValidationResult{verdict: acceptable|needs-reobservation|rejected, reasons[]}
  ReplayReport{mode, aggregates, caveats}
```

## 2. 建议接入的现有函数与位置（集成点）

1. **模型调用**：复用 `ScheduledAIRouter`（packages/ai-router/src/scheduled-router.ts）。
   本模块已提供同形适配器 `scheduledRouterModelClient`（spark-strategy-v1/model-client.ts），
   字段与生产调用 `askStrategyReview`（apps/coordinator/src/strategy-review.ts:155）逐一对齐。
   生产装配点在 apps/coordinator/src/main.ts:321-322（`replanAI`/`siteAI` 旁）——
   新增 strategy-v1 入口复用同一 scheduler；实际并发取装配值，不能假设为默认 2。本次启动配置和最近日志均为 3。
2. **周期触发**：若做全队周期评审，挂在 `AutonomousDirector.runStrategyReviews`
   （autonomous-director.ts:483）同一 tick 旁，但**必须独立冷却键**（per-team 而非
   per-bot），建议默认 15min + 仅当团队事实版本变化才发起（去重）。
3. **观测去重/冷却**：incident 快照按 fingerprint 聚合已有先例
   （packages/skills/src/incidents.ts incidentFingerprint）；报告触发同理按
   内容指纹+scenario 去重。factVersion 含采样时间，不能直接用于判断内容变化。
4. **下发前重检（硬要求）**：任何 assignment 真正下发前必须重新执行
   `validateProposal`（用当时最新事实，不是摘要时快照），并逐条核对：
   bot 仍 idle（goalExecutionReady 单一定义在 BotRegistry）、资源未被新租约占用、
   阶段门仍满足。验证器通过≠可下发。
5. **优先级/抢占语义**：AI 建议 priority 建议=planning(30)；紧急请求仍走
   systemCritical(0)/combat(10) 既有通道；本模块不改变生存抢占/L0/紧急停止任何语义。

## 3. 共享推理预算建议

- 全队建议请求是 burst（一次 1 个请求，非每 bot 一个）——对 seqs=4 的 vLLM
  友好；建议队列语义沿用 scheduler（planning 级），并设置
  `deduplicationKey: \`team-proposal:${factVersion}\`` 防同版本重复请求。
- maxTokens 建议 3000（EVAL_CONTRACT 校准链同值）；temperature=0。
- 不建议为策略请求单独开 adapter/端口——同一 Spark 实例；容量结论以
  当前服务端 seqs=4 为本轮设计上界。旧短请求脚本不能决定真实规划的应用并发，须完成本轮 1/2/3/4 档实测。

## 4. 首个可验证场景与候选接线方式（默认关）

- 首选场景：**C（repeated-failure）**——纯观测面（替代方案建议写进报告/日志），
  不下发动作，风险最低。验收=重复失败场景中替代建议与失败原因匹配、无重复认领。
- 候选接线（全部默认关，逐个灰度）：
  1. `STUDIO_TEAM_STRATEGY_PROPOSAL=1`：周期全队建议→Incident/日志（纯观测）。
  2. `STUDIO_TEAM_STRATEGY_DISPATCH=1`（在前者稳定后）：把 acceptable 建议中的
     deterministicGoal 文本走现有 goal 提交通道（需 operator 显式开启；等价
     manual goal——复用既有 goal 队列与租约，不新建控制入口）。
  3. 回滚=关 flag；无持久化状态、无数据库迁移、无协议变更。

## 5. 与 D3 相交的待办与预期冲突文件

- **事实供给**：TeamFactsInput 的 bots/facilities/events 生产装配器应等 D3 的
  世界观测消费边界定案后实现（D3 交付 WorldMirror 查询路径后，设施/方块级
  事实才有可信来源；本期 fixtures 用 unknown 占位与此兼容）。
- **预期冲突文件**：apps/coordinator/src/main.ts（两边的装配点都在这）；
  apps/coordinator/src/autonomous-director.ts（若把全队评审挂进同一循环）。
  本分支未改这两个文件——集成时一次收口，避免双写。
- deaths 真实来源（bot-runtime died 事件→coordinator 计数）独立于 D3，可先行。

## 6. 未尽事项（本期范围外，如实）

- 维度间运输方案（nether transit）未实现（一期明确不做）。
- 经验摘要/候选知识存储未做（验证器产物只有报告；无升级为永久事实的通道）。
- 服务端指标（vLLM queue/KV/吞吐）未接——live 运行需另行取数并标注口径。

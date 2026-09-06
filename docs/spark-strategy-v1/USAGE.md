# Spark Strategy V1 使用说明

## 前置

```bash
# 本 worktree 内（feat/spark-strategy-v1-glm）
pnpm install --prefer-offline
pnpm build:packages
pnpm --filter @minecraft-studio/coordinator build   # 产出 dist/spark-strategy-v1/
```

## 离线回放（默认、零网络）

```bash
node eval/spark-strategy-v1/run-offline.mjs
# 可选参数：
#   --fixtures <dir>  场景目录（默认 eval/spark-strategy-v1/fixtures）
#   --out <dir>       输出目录（默认 runtime-data/spark-strategy-v1/，worktree 本地）
```

输出：
- `report.json` — 机器可读全量报告（样本明细 + 聚合 + 边界声明）
- `report.md` — 简短 Markdown（同源数字，不另算）

预期输出（当前 fixtures）：
```
offline replay complete: samples=5 valid=4 parseFailures=1 matched=4 shouldActButNoop=0 shouldWaitCorrectly=1
```

### 样本矩阵

| 样本 | 场景 | 期望 | 验证 |
|---|---|---|---|
| A1-food-shortage | 食物短缺+可用农场 → 收获/运输/采集分工 | act→acceptable | ✅（依赖：运输→收获） |
| B1-build-materials | 建造缺料 → 并行采集→施工依赖链 | act→acceptable | ✅（施工不重复建设已有设施） |
| C1-repeated-failure | 同任务 3 连败（PATH_FAILED）→ 替代+等待 | wait-or-escalate→acceptable | ✅（shouldWaitCorrectly=1） |
| N1-invalid-json | 纯文本响应（无 JSON） | parse-failed 分账 invalid-json | ✅ |
| N2-cross-server | 跨服作用域建议 | rejected（SCOPE_MISMATCH） | ✅ |

### 编写新 fixture

字段：`sampleId / scenario / mode / facts（或 factsRef 引用其它 fixture）/ injectedResponse / expectation{desiredBehavior, acceptableVerdicts}`。
`injectedResponse` 中的 `{{factVersion}}` 会被替换为该 facts 的确定性事实版本。事实里所有"未知"写字符串 `"unknown"`——绝不要写 0/false 冒充已知。

## 已有日志如何接入

本模块的输入是纯数据对象（`TeamFactsInput`），不含 I/O。接入既有观测时：
1. 事实来源参照 `BOUNDARY.md` 审计表：bot 状态=registry `BotRegistryRecord`/`BotStatusV1`；共享库存与设施=SharedStateServer；失败证据=incident store（fingerprint/source）；能力目录=`packages/skills/skill-system-v1.manifest.json`。
2. 适配器把上述数据装配成 `TeamFactsInput`（缺的字段显式 `"unknown"`）→ `buildSituationSummary` → 模型 → `validateProposal`。装配器属生产接线（D3 后），本期提供 fixtures 形态作为契约样例。
3. 回放历史建议：把历史响应文本放进 `injectedResponse`（mode=replay）；解析器与验证器与 live 完全同路径。

## Live 模式（opt-in，本期默认不执行）

待执行命令骨架（需要：已核实 Spark 空闲窗口、确认不承载 Codex D3 验证、`/v1/models` 只读探测通过）：

```bash
# 1) 只读健康探测（不算压测授权）
curl -s http://192.168.100.2:18300/v1/models | head -c 400
# 2) 在 coordinator 测试进程内构造 ScheduledAIRouter（生产同构装配），
#    用 scheduledRouterModelClient(router) 替换 injectedModelClient 跑单样本。
#    预算：≤5 请求、maxTokens=3000、串行、单请求超时 120s（EVAL_CONTRACT 同参）。
# 3) 报告 mode=live，serverMetrics=SOURCE-REPORTED，逐数字标注
#    MEASURED / SOURCE-REPORTED / ESTIMATED。
```

禁止事项：不切换模型、不重启生产容器、不改 max-num-seqs/并发/上下文/prefix cache/MTP、不在未确认窗口时轮询占用 Spark。

## 限制与失败解释

- **验证通过 ≠ 任务会成功**：只表示静态/快照约束满足；下发前必须重新检查事实、资源与现有任务（见 INTEGRATION_HANDOFF.md）。
- `tokenEstimate.method=estimated-chars-div-4`：无真实 tokenizer，全部为估计值。
- offline/mock 的时延无意义（注入器恒 0）；报告 `aggregates.latencyNote` 有声明。
- 解析分账：`invalid-json`（无 JSON 或括号平衡但不可解析）、`truncated-json`（括号不平衡）、`reasoning-only`（检测到思考标签/关键词且无 JSON）、`empty-response`、`schema-invalid`。
- 摘要裁剪顺序：窗口外非 failure/death 事件 → 同类事件压缩 → 条目上限截断（剩余计 dropped）→ 末级字符截断（从尾部；约束区在前段，永不丢）。库存按数量保留 top-N。

## 模块地图

```
apps/coordinator/src/spark-strategy-v1/
  facts.ts         事实输入 schema（unknown 一等值）+ factVersion + 脱敏
  summary.ts       有界局势摘要（裁剪顺序 + token 估计标注）
  proposal.ts      TeamProposal zod schema + 响应解析分账
  validator.ts     19 种原因码静态/快照验证器（三态判定）
  model-client.ts  注入式 ModelClient + ScheduledAIRouter 适配器 + askTeamProposal 分账
  replay.ts        回放管线 + 聚合报告 + Markdown 渲染
  index.ts         桶导出（零副作用）
apps/coordinator/tests/spark-strategy-v1/   35 测试
eval/spark-strategy-v1/                     fixtures + run-offline.mjs CLI
docs/spark-strategy-v1/                     本文档 + BOUNDARY/EVIDENCE/INTEGRATION_HANDOFF
```

# Spark Strategy V1 证据与验证记录

当前已完成补修、D3、只读接线与现有模型 live 评测，证据见 [TAKEOVER_RESULTS_2026-09-06.md](TAKEOVER_RESULTS_2026-09-06.md)。本文件的旧测试总数、未执行项及 CI 根因不代表当前状态。

环境：Windows 11 + Git Bash；worktree `../studio-spark-strategy`（分支 `feat/spark-strategy-v1-glm`，基线 `75cab90`）。

## GLM 历史验证矩阵（不是补修后的结果）

| # | 验证 | 命令 | 结果 | commit |
|---|---|---|---|---|
| 1 | 协调器类型检查 | `npx tsc -p apps/coordinator/tsconfig.json --noEmit` | 0 error | a0e01c4..HEAD |
| 2 | 单元/管线测试 | `npx vitest run tests/spark-strategy-v1`（cwd=apps/coordinator） | **35 passed / 0 failed** | 263ec64 |
| 3 | 离线 CLI 端到端 | `node eval/spark-strategy-v1/run-offline.mjs` | 5 样本全部分账/判定符合期望（报告见下） | 263ec64 |
| 4 | 冻结文件核验 | `git diff HEAD --stat -- <冻结路径清单>` | 空输出=零改动 | HEAD |
| 5 | workspace 包构建 | `pnpm build:packages && pnpm --filter @minecraft-studio/coordinator build` | 成功 | a0e01c4 |

**未执行项（如实）**：
- LIVE_MEASURED：0 项——live 请求未运行（未确认 Spark 空闲窗口；待执行命令见 USAGE.md）。服务端排队/KV/吞吐指标 unavailable。
- 真实 Minecraft fixture 场景：未运行（本期默认 offline、不启动 Studio/不连服务器）。
- GLM 分支随后已推送至 `bca26e1e13118dfae173ff7601d5a28d9bd9874a`，原 4 个提交由后续集成分支保留。当前补修和 CI 记录见 [TAKEOVER_VALIDATION.md](TAKEOVER_VALIDATION.md)。

## 已知限制

- `deaths`/共享库存等上游占位问题（`autonomous-director.ts` `deaths: 0`）在本模块以 unknown 表达，生产适配器接线后才有真实值。
- 验证器为静态/快照检查，不含资源 lease、任务发布、世界重检（D3/集成阶段职责）。
- token 计数为估计口径（无 tokenizer）。

## GLM 历史离线报告（含后续发现的判据缺口，不作为当前通过证据）

```markdown
# Spark Strategy V1 回放报告（mode=offline）

- evalVersion: spark-strategy-v1-eval-1
- gitCommit: （每次运行自动记录当时 HEAD）
- serverMetrics: unavailable

## 聚合

- samples: 5
- validProposals: 4
- parseFailures: 1
- requestFailures: 0
- matchedExpectationCount: 4
- shouldActButNoop: 0
- shouldWaitCorrectlyWaiting: 1
- modelNotTriggered: 0
- verdicts: {"rejected":1,"acceptable":3}
- parseReasons: {"invalid-json":1}
- latencyNote: offline/mock/replay modes inject responses; latency figures are not representative. ...

## 样本

- N1-invalid-json: accounting=parse-failed/invalid-json, verdict=n/a, matchedExpectation=false
- N2-cross-server: accounting=valid-proposal, verdict=rejected, matchedExpectation=true
  - SCOPE_MISMATCH: proposal scope some-other-server/overworld != facts scope local-test-1.21.11/overworld
- A1-food-shortage: accounting=valid-proposal, verdict=acceptable, matchedExpectation=true
- B1-build-materials: accounting=valid-proposal, verdict=acceptable, matchedExpectation=true
- C1-repeated-failure: accounting=valid-proposal, verdict=acceptable, matchedExpectation=true

## 边界

- Pure proposal replay evaluates proposal quality only; no Minecraft task completion rate is claimed...
- Validator acceptance = static/snapshot constraints satisfied; ...
- Server-side queue/KV/throughput metrics are unavailable in offline modes; ...
```

## 变更文件清单（证明冻结纪律）

本分支全部提交仅涉及：
```
docs/spark-strategy-v1/{BOUNDARY,USAGE,EVIDENCE,INTEGRATION_HANDOFF}.md
apps/coordinator/src/spark-strategy-v1/{facts,summary,proposal,validator,model-client,replay,index}.ts
apps/coordinator/tests/spark-strategy-v1/{core,model-client,replay}.test.ts
eval/spark-strategy-v1/{run-offline.mjs,fixtures/*.json}
```
冻结路径（pathfinder-rs/**、bot-runtime/**、protocol/**、skills/**、main.ts、autonomous-director.ts、local-planner.ts、strategy-review.ts、local-ai-config.ts、ai-router 行为、锁文件）**零改动**（`git diff --stat` 对这些路径为空）。

## 提交列表（本分支）

1. `885e163` docs(spark-strategy-v1): work boundary + AI wiring audit
2. `a0e01c4` feat(coordinator): facts/summary/proposal/validator/model-client + 34 tests
3. `263ec64` feat(coordinator): replay pipeline + scenarios + eval CLI（35 tests）
4. 本提交（docs：USAGE/EVIDENCE/INTEGRATION_HANDOFF）

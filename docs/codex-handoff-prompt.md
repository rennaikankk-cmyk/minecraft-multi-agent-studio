# 交接提示词（给 Codex）

把下面整段作为初始提示交给 Codex。它是自包含的 —— 不依赖任何对话历史。

---

你在 `minecraft-multi-agent-studio` 这个 pnpm monorepo 上工作。这是一个用 mineflayer 驱动的多 Bot Minecraft 自动化项目，架构是 coordinator（规划与派发）+ control-api（对外 HTTP）+ bot-runtime（技能执行）三个服务，加 `packages/` 下的 protocol、skills、task-system、ai-router 等共享包。

一份缺口审计已经完成，结论在 `docs/landing-gap-report.md`。**先读那份报告**，它标注了哪些结论经过独立复核、哪些只是单点抽查。不要重新审计已经确认的部分。

## 你要做的事

按顺序完成下面四项。每一项做完就停下来汇报，不要一口气全做完再报。

### 任务一：让 `smelt` 步骤能在协调器侧绑定

`apps/coordinator/src/local-planner.ts` 的 `unbindableStepReason`（约 618 行）只识别 `mine`、`craft`、`place-station` 三种 step kind，其他一律返回 `STEP_KIND_UNSUPPORTED:${step.kind}`。技能侧的 `smelt.item` 已经是完整实现（`openFurnace` → `putInput`/`putFuel` → 等 update → `takeOutput` → 读回校验），但因为这个绑定缺口，铁器档位在端到端路径上不可达。

同一区域的 `COORDINATOR_PLACEABLE_STATIONS` 只含 `crafting_table`，需要加 `furnace`，否则熔炉即使能绑定也没有放置路径。

**这个函数有事故史，注释里写了**：曾经出现单测看到 `SKILL_NOT_ADVERTISED:world.place-block`、生产看到 `STEP_KIND_UNSUPPORTED:place-station` 的漂移，根因是两个调用方各自决定检查顺序。修改时必须保持单一判断源，不要为 smelt 拆出第二份逻辑。

放置站点还有一个已知陷阱：填 `referenceBlock` / `face` 需要可信的观测数据，**不要用 `position.y - 1` 猜某个方块是否实心**。查一下现有的 crafting_table 放置是怎么拿到观测的，沿用同一条路。

完成后跑该包的单测，并确认 planner 的既有门禁没有回归。

### 任务二：修 `scopedPoolConfig` 的作用域错误

`packages/task-system/tests/real-infrastructure.integration.test.ts` 第 358 行把 `scopedPoolConfig` 声明为 `beforeAll` 回调内部的 `const`，但第 1579 行和 1594 行在 `it("recovers an assignment lease and dispatch outbox after a Coordinator restart")` 的用例体里引用它。`describe` 作用域的变量声明（336-343 行）没有这一项。

这是运行期 `ReferenceError`，不是类型问题 —— 该包的 `tsconfig.json` 只 `include` `src/**/*.ts`，`pnpm typecheck` 看不到 tests，vitest 只转译不做类型检查。

修法：把 `scopedPoolConfig` 提升到 `describe` 作用域，跟 `assertionPool`、`poolAdapter` 并列 `let` 声明，在 `beforeAll` 里赋值。

这条要紧是因为 `.github/workflows/task-infrastructure-integration.yml` 的 `real-postgres-redis` job 在每个 PR 上无条件运行（带真实 `postgres:17.10` + `redis:8.8.0` service 容器）。本地默认跳过是 opt-in 设计，不要去改那个 env 门禁。

### 任务三：重跑真实基础设施套件并更新留档

`CHANGELOG.md:21` 记录的绿灯是 2026-08-14 的 20/20，但当前套件有 28 个 `it`，新增的 assignment / digest 场景没有任何通过记录。

本地跑需要 `TASK_POSTGRES_URL`、`TASK_REDIS_URL`、`TASK_INFRA_TEST_NAMESPACE`（`.env` 里这三项是空的），入口是 `scripts/run-task-infrastructure-tests.mjs`。注意 loopback 限制是**显式安全策略**（`infrastructure-config.ts` 的 `isLoopbackHostname`），数据库必须在回环地址上，不要为了跑测试去绕过它。

如果本地起不了 PostgreSQL/Redis，就说明情况并让 CI 跑，不要伪造留档。拿到结果后按 CHANGELOG 现有格式追加一条，写清运行编号与通过数。

### 任务四：把持久任务链路接到真实执行上

这是最大的一块，做之前先向我确认方案。

现状：task-system 的实现（状态机、PostgreSQL 仓库、事务 outbox、BullMQ Queue/Worker、租约、取消）是完整可信的，但在生产模式下无法启动，四个断点：

1. `apps/task-worker/src/config.ts:59-61` 硬拒任何非 `isolated-acceptance` profile。
2. 全仓 `TaskHandlerRegistry.register` 只出现在 `isolated-acceptance-handler.ts:33-34`，注册的是两个测试 handler（一个永久阻塞、一个算 sha256）。没有生产处理器。
3. `scripts/start-studio.mjs` 不拉起 task-worker。
4. `submitTask` 在生产代码里零调用者。

而已经跑通真实 Minecraft 的竖切走的是 `/v1/goals` → `local-planner` → `transport.sendSkillInvocation` 的进程内同步路径。两条链共享 `PostgresTaskRepository`（goal 的任务类型是 `coordinator.goal`），但 goal 执行完全在 coordinator 进程内，不经过 BullMQ worker。

需要设计的是：生产 profile 怎么定、真实 handler 注册在哪、Coordinator 从同步投递切到 `submitTask` 的边界在哪、`start-studio.mjs` 怎么拉起 worker、以及切换期间竖切要保持可用。先给方案再动手。

## 这个仓库的既有坑（别重新踩）

- **改了 `packages/protocol` 要重启全部三个服务**，只重启 coordinator 会在 Control API 撞 503，而那个 503 不是「目标被拒」。
- **`packages/protocol/src/index.ts` 是显式再导出**，新增导出必须手工加进「值」和「类型」两个清单，否则消费方 import 不到。
- **`REOBSERVE` 不含位移语义**。寻路到不了的目标第二次尝试必然同码失败，那是重试语义如此，不是重试逻辑坏了。
- **`maxCount` 是上限不是要求**，不要拿它当验收门禁。任务完成度看有界数字摘要。
- **planner 的 grammar 分支竞争压得过 prompt 措辞**。如果 planner 输出形状不对，先看 retry grammar 的分支数，不要靠改提示词。`invoke` 的决策顺序靠 prompt，`plan_items` 靠把 retry grammar 收成单分支 —— 这是两个独立机制。
- 主控模型端点由 `LOCAL_AI_HUB_URL` 指定。仓库里另有一个 comparison-only 的 Qwen 端点，**不要把它填进 `LOCAL_AI_*`**，那等于悄悄换掉主控模型。

## 工作方式

- 每个任务改完跑该包的测试加 `pnpm typecheck`，别攒到最后。
- 不要新建文档文件，不要写 summary markdown。
- 不要提交或推送，除非我明确要求。
- 报告里标了「仅抽查」的结论（多 Bot 调度、模型降级、运维）**不在这次范围内**，看到了别顺手改。
- 遇到与报告描述不符的代码，先说出来，不要按报告硬改。报告可能过期，代码是事实。

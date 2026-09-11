# 生产落地缺口检查报告

> **⚠ 陈旧快照警告（2026-09-11 追记）**：本报告是 **2026-08-26** 的快照，距今已久。
> 其 **P0/P1 条目绝大多数已在此后解决**（见文末「修订（2026-09-11）」），下文若干处已与当前
> 代码库**明确不符**。行号与结论**只对 2026-08-26 有效**，引用前必须对照 HEAD 重新核实。

生成日期：2026-08-26

## 本报告的可信度分层

读之前请先看这一节，不同结论的证据强度差别很大。

**经过完整审计加独立复核**：技能层、任务系统、安全层。每条结论都定位到文件与行号，并由独立 agent 反向尝试推翻。

**仅为单点抽查，未经复核**：planner、模型路由、多 Bot、运维。这四个维度的审计 agent 因推理网关连续 503 未能完成，下文标注为「抽查」的段落只反映我直接读到的代码，不排除有遗漏。

**未覆盖**：性能与资源占用、世界记忆的长期正确性、战斗系统。

## 一句话结论

已经在真实 Minecraft 上跑通的竖切，和已经写完的持久任务系统，是两条互不相接的平行路。落地缺的不是「再实现一个子系统」，而是把已有的东西接上，外加玩法链条上三处真实的空洞。

---

## P0：改动小、解锁大的四项

### 1. `smelt` 步骤在协调器侧无法绑定

[local-planner.ts:618](../apps/coordinator/src/local-planner.ts:618) 的 `unbindableStepReason` 只识别三种 kind：

```
if (step.kind === "mine") return null;
if (step.kind === "craft") { ... }
if (step.kind === "place-station") { ... }
return `STEP_KIND_UNSUPPORTED:${step.kind}`;
```

技能侧的 `smelt.item` 是完整实现（`openFurnace` → `putInput`/`putFuel` → 等 update → `takeOutput` → 读回校验），不是壳。但任何 `smelt` 步骤走到这里都拿到 `STEP_KIND_UNSUPPORTED:smelt`，铁器档位在端到端路径上不可达。

同一函数里 `COORDINATOR_PLACEABLE_STATIONS` 只含 `crafting_table`，熔炉即使能绑定也没有放置路径。

修复要同时补两处：kind 分支加 `smelt`，可放置工作站集合加 `furnace`。注意该函数的注释记载过一次真实的漂移事故（单测看到 `SKILL_NOT_ADVERTISED:world.place-block`，生产看到 `STEP_KIND_UNSUPPORTED:place-station`），原因是两个调用方各自决定检查顺序 —— 改的时候不要再拆出第二份判断。

### 2. 真实基础设施测试套件当前跑不通

[real-infrastructure.integration.test.ts:358](../packages/task-system/tests/real-infrastructure.integration.test.ts:358) 把 `scopedPoolConfig` 声明为 `beforeAll` 回调内部的 `const`，但 1579 行和 1594 行在 `it("recovers an assignment lease and dispatch outbox after a Coordinator restart")` 的用例体里引用了它。`describe` 作用域的变量声明（336-343 行）没有这一项。

这不是类型问题而是运行期 `ReferenceError`：`packages/task-system/tsconfig.json` 只 `include` `src/**/*.ts`，`pnpm typecheck` 看不到 tests 目录，vitest 只转译不做类型检查。

修法是把 `scopedPoolConfig` 提升到 `describe` 作用域（跟 `assertionPool`、`poolAdapter` 并列声明，在 `beforeAll` 里赋值）。

这条要紧是因为 `.github/workflows/task-infrastructure-integration.yml` 的 `real-postgres-redis` job 在每个 pull request 和 push main 上无条件运行，带真实 `postgres:17.10` 与 `redis:8.8.0` service 容器。也就是说这个门禁是常开的，不是被禁掉的 —— 它现在处于跑到该用例必然失败的状态。

顺带修正一处容易误读的地方：本地默认跳过是 opt-in 设计（40-42 行的 env 门禁 + `describe.skip`，`.env:138-140` 三个变量为空），不是疏漏。CI 常开 + 本地 opt-in 是标准模式。

### 3. 验收留档已过期

CHANGELOG.md:21 记录 2026-08-14 的 Actions 运行 31793333384 在临时 PostgreSQL/Redis 上 20/20 通过。但当前套件有 28 个 `it`。新增的 assignment / digest 场景没有任何绿灯记录。修完第 2 项后需要重新跑一次并更新留档。

### 4. 技能成熟度门禁不约束运行

新技能要过三道门禁：catalog 注册 → `skill-status.ts` 的 EVIDENCE 布尔位（缺失则导入期抛错）→ verification manifest 自动派生。设计是对的，但 `builtinSkillStatusCatalog` 在 `apps/` 下零消费方，`isolatedServerScenarios: false` 的技能与 Stable 技能被同等派发。门禁目前只约束文档，不约束运行时。

---

## 任务系统：写完了，但没接上

底层实现是可信的。状态机、PostgreSQL 仓库、事务 outbox、BullMQ Queue/Worker、租约与取消都完整，且有真实 PostgreSQL/Redis 集成测试覆盖。ROADMAP 对这一部分的勾选基本诚实。

问题在于整条持久链路在生产模式下无法启动，四个独立的断点：

- `apps/task-worker/src/config.ts:59-61` 硬性拒绝任何非 `isolated-acceptance` 的 profile。
- 全仓 app 代码里 `TaskHandlerRegistry.register` 只出现在 `isolated-acceptance-handler.ts:33-34`，注册的是两个测试 handler（一个永久阻塞、一个算 sha256 digest）。不存在生产处理器注册点。
- `scripts/start-studio.mjs` 压根不拉起 task-worker。
- `submitTask` 在生产代码里零调用者。

而已经跑通真实 Minecraft 的竖切走的是 `/v1/goals` → `local-planner` → `transport.sendSkillInvocation` 的**进程内同步路径**。两条链共享 `PostgresTaskRepository`（goal 路径的任务类型是 `coordinator.goal`），但 goal 的执行完全在 coordinator 进程内，没有经过 BullMQ worker。持久链路目前没有任何一端接到 Minecraft 技能执行上。

Coordinator 的投递编排另外硬性要求 `studio_test_` schema 与 loopback。其中 loopback 是显式安全策略而非疏漏（`infrastructure-config.ts` 的 `isLoopbackHostname` 拒绝任何非回环主机，CHANGELOG.md:82 有记载）。

接线所需的动作：生产 profile、真实 handler 注册、Coordinator 从同步投递切到 `submitTask`、`start-studio.mjs` 拉起 worker。这是「任务系统能用」与「任务系统写完了」之间的全部差距。

## 技能层：框架成熟度高于玩法覆盖度

39 个技能全部从 `packages/skills/src/builtin/catalog.ts` 单一清单注册，能力契约、前置条件、超时、读回校验都按 fail-closed 写实。这一层的工程质量没有问题。

「空手到自持」这条链在熔炉之后断掉，三处真实空洞：

- **食物获取**（农业、烹饪、进食）在 resource-graph 与技能清单里零代码。
- **`interact.sleep`** 完全不存在。
- **`mine.branch` / `mine.vein`** 是无条件抛 `MINE_RUNTIME_NOT_WIRED` 的壳。

加上前述 `smelt.item` 被协调器绑定缺口挡住，铁器档位不可达。

实机证据方面：`docs/skill-verification-runbook.md` 描述的隔离服场景测试没有任何通过留档，`runtime-data/` 下唯一相关痕迹是一次失败的 vitest 日志。runtime-data 里已有的留档是 planner 门禁与 Spark 基准，不含技能矩阵。

## 安全：四个假设同时成立时才成立

配置层的加固水平明显高于运行层，这些都核对到代码：

- 三个服务的 host 都在代码里硬拒非回环绑定。
- HMAC 双向握手带时钟偏移容忍与 nonce。
- token 用 SHA-256 + `timingSafeEqual` 常量时间比较。
- 日志脱敏按词元匹配，代码注释解释了为什么不用子串匹配。

整套东西目前只在「单人、单机、回环、进程不重启」这四个假设下安全。任何一个被打破都需要补代码，而不是改配置：

- **Dashboard 完全没有用户身份概念** —— 不是「缺一个登录页」，是连 principal 都不存在。（Control API 侧是有的：[server.ts:417](../apps/control-api/src/server.ts:417) 起的路由检查 `goal.submit`、`bot.stop` 等权限。这个区别很重要，别把两者混为一谈。）
- **唯一能跨重启存活的停止记录丢掉了 actorId**，事后连「谁停的」都答不出来。停止审计只进内存数组。
- **全仓零 TLS 实现**，跨主机部署这条路没有起点。
- 服务日志只 append 不轮转。

## 抽查部分（未经复核）

**多 Bot**：`botId` 在 goal 请求里是必填字段（`packages/protocol/src/control-link.ts` 的 171、217、274、329 行），协调器侧没有跨 Bot 的调度或分派逻辑。目前的「多 Bot」实质是多个独立单 Bot。`bot-supervisor` 需要显式配置 `BOT_SUPERVISOR_CONFIG_PATH` 才会被 `start-studio.mjs` 拉起，否则整个进程组不含它。

**模型路由**：`packages/ai-router/src/` 有 router、scheduler、structured-output，但只有两个适配器（`ollama-adapter.ts`、`vllm-adapter.ts`），两者都指向同一个 `LOCAL_AI_HUB_URL`。`router.ts` 与 `scheduled-router.ts` 里 grep 不到任何 fallback / secondary / degrade 逻辑。`.env.example` 只暴露 `LOCAL_AI_PROVIDER` / `HUB_URL` / `MODEL` 三键加四个并发参数，没有云端降级配置。主控模型不可用时整条链停止。

**运维**：没有 Dockerfile 或 compose 文件，没有健康检查端点，除 bot-runtime 里一处字样外没有指标导出。

## 建议顺序

1. `smelt` 的 kind 绑定与 `furnace` 放置支持 —— 小改动，解锁铁器档位。
2. `scopedPoolConfig` 作用域修复 —— 小改动，让常开的 CI 门禁重新可信。
3. 重跑真实基础设施套件（28 个用例），更新 CHANGELOG 留档。
4. 持久链路接线（生产 profile + 真实 handler + submitTask 调用 + start-studio 拉起 worker）。
5. 技能成熟度门禁接到派发路径上，让 `isolatedServerScenarios: false` 的技能不被当 Stable 派发。
6. 食物链与 `mine` 的真实现 —— 玩法层大块工作，可与 4、5 并行。

TLS、Dashboard 身份、容器化、指标导出都属于「离开这台机器才需要」。现在做等于提前付账，除非部署形态马上要变。

## 修订（2026-09-11）

以下逐条对照 HEAD `5fc643f`（476 次提交）重核，只记与本报告原文**相反**或已失效的结论。

**1. 「`mine.branch` / `mine.vein` 是无条件抛 `MINE_RUNTIME_NOT_WIRED` 的壳」——FALSE。**
该错误码在源码中已**零出现**（`git grep MINE_RUNTIME_NOT_WIRED` 只命中本文件第 87 行自身，即死字符串只靠本文档残留）。两者都是真实现：规划器 `packages/skills/src/planning/mine-planner.ts:187,207`（`planBranchMine` / `planVeinMine`，有界步数与邻接推进），运行时 `apps/bot-runtime/src/mineflayer-client.ts:2027-2108`。

**2. task-worker「生产模式下不可达」的四条断言——四条全部 FALSE。**
- `apps/task-worker/src/config.ts:74-75`：已批准 `production` purpose + `coordinator-goal` handler profile。
- `scripts/start-studio.mjs:169-183`：启动流程已拉起 task-worker（`productionTaskDelivery` 分支）。
- `apps/coordinator/src/goal-lifecycle-store.ts:228`：Coordinator 已调用 `repository.submitTask`。
- `apps/task-worker/src/coordinator-goal-handler.ts:93`：存在生产处理器注册入口（`registry.register(createCoordinatorGoalHandler(...))`）。

**3. `scopedPoolConfig` ReferenceError——FIXED。**
`let scopedPoolConfig: PoolConfig;` 现位于 `packages/task-system/tests/real-infrastructure.integration.test.ts:372`，已在 `describe` 作用域内声明。**子断言仍为 TRUE**：`packages/task-system/tsconfig.json` 的 `include` 仍只有 `src/**/*.ts`，`pnpm typecheck` 依旧看不到 tests 目录。

**4. 「没有健康检查端点」——STALE。**
`/v1/incidents/health` 已存在，路由位于 `scripts/studio-local-manager.mjs:304`。

**5. 食物「在 resource-graph 与技能清单里零代码」——FALSE。**
已全部注册：`farm.maintain`、`farm.sustain`、`food.secure`、`animal.breed`、`smelt.item`（`packages/skills/src/builtin/catalog.ts:57,58,59,76,77`）。

**6. 技能总数 21——FALSE。**
真实数量为 **39**（`packages/skills/src/builtin/catalog.ts:45-78` 共 33 个 id，加 `packages/skills/src/baritone-processes.ts:104` 的 6 个）；正文已就地更正。


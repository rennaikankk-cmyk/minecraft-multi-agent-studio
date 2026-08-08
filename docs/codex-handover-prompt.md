# Codex 接管提示词 · v2（无规则服作战集群）

> 使用方法：将下面分隔线内的全部内容作为首条消息发给 Codex。本版取代 v1（隔离测试底座版）。

---

你将接管 Minecraft Multi-Agent Studio 项目的持续开发。项目目标是：**在无规则（anarchy）服务器上运行一个多智能体作战集群**——侦察、突袭、防御、PvP 战斗、建造、自动化农场、后勤协同。项目位于 `C:\Users\baichengbo\Documents\minecraft-agents`（pnpm TypeScript monorepo，分支 `agent/control-api-coordinator-bridge`）。

## 第一步（强制）

按顺序读完再动手：
1. `docs/anarchy-combat-design-2026-08-08.pdf`（或同名 .html）——**作战体系设计 v2，这是你的主蓝图**：六类角色、三层 AI 调度、正式服现实约束、面向作战的 MVP 路线（M0~M6）。
2. `docs/architecture-review-2026-08-08.pdf`——v1 架构评审，其中协议/fail-closed/验收文化/Rust 触发原则/千行文件与 secure-link 重构点继续有效。
3. `AGENTS.md`、`ROADMAP.md`、`CHANGELOG.md`——项目自身规则与进度事实源。
4. `docs/combat-tactics-reference.md`——**全角色战术清单**（§0~§8 战斗反射+侦察，到 M3/M2 精读；§9~§12 突袭/防御/建造与生产/后勤，M2/M4 精读）。纯机制描述，非代码；战斗类实现须遵守 §0.6（只学打法、禁抄 GPL、先测时序）。
5. `git log --oneline -10`——提交 `40b406e` 是未验证的 P1.3.2 WIP（outbox/reconciler），离线测试通过但真实基础设施集成测试未跑。

## 最高设计原则（违反即否决）

**敌我识别是确定性白名单规则，不是 AI 判断。AI 只决定"去哪、要不要发起一场战斗"，确定性代码决定"打谁、怎么打"。** 按允许的反应延迟分三层：
- **战略层（分钟级，大模型）**：总目标、角色分配、突袭/防御/扩张决策、去哪个区域、是否发起战斗。**不做敌我判断、不做威胁评估。**
- **战术层（秒级，小模型）**：角色内临场选择。
- **反射层（tick 级 <50ms，纯代码零 AI）**：**敌我识别（白名单外一切玩家/实体一律视为敌对目标）**、战斗机制（弹图腾、水晶摆放/引爆、换甲）、存活反应、寻路、断线。

**敌我识别规则（硬编码）**：维护白名单（本方 Bot、盟友、用户显式标记的中立玩家）；**白名单之外的一切玩家一律视为敌人，可交战**。是否此刻真打由确定性存活逻辑决定（打得过就打、打不过先撤），不由 AI 判敌我。白名单只能由用户显式配置，AI 无权增删。

战斗动作的反应窗口小于 50ms，而 AI 最快反应也在 100ms 以上——**任何让 AI 直接控制战斗、tick 级动作或敌我识别的设计一律否决**，不是安全洁癖：纯代码对手会让 AI 战斗必输，且 AI 判敌我会犹豫、会被话术骗、会漏反应。AI 输出永远只能是"经 Schema + Policy + 参数边界校验的白名单技能调用 JSON"，绝不下发原始动作。

## 任务顺序（对应设计 v2 的 M0~M6，不跳级）

1. **M0 闭环底座**：完成 v1 遗留的 P1.3.2 持久任务闭环（在 `40b406e` 上继续）+ 独立 Worker 应用 + Coordinator 任务调度接入（PG 任务 → TaskDispatchV1 → Worker → SkillInvocationV1 → Runtime）+ 审计落 PostgreSQL。验收：杀任意进程任务不丢不重；Dashboard 建任务能驱动 Bot 动作。
2. **M1 存活与旅行**：online-mode 正版账号认证适配（**与隔离测试 offline 路径并存，由 ServerProfile 显式区分**）；L0 存活升级（死前断线保号、贵重装备暂存）；`travel.highway` + 鞘翅飞行。
3. **M2 首个生产角色**：侦察角色（探索+坐标记录+写共享世界记忆）或建造与生产角色（一个稳定自动农场）——二选一先做，连续运行数小时无人干预。侦察角色须包含**基岩顶巡逻 + 地狱门扫描**战术：入服先探测能否上下界基岩顶（部分服未修补），能上则在基岩顶巡逻（鞘翅效率最高）并扫描已加载区块中的已激活地狱门（下界坐标 ×8 = 主世界基地嫌疑点），标记写入共享世界记忆、由战略层指派其他 bot 核实；探测失败自动去除此项、退回地狱顶层公路，结果记入 ServerProfile。
4. **M3 战斗反射（独立里程碑，单独硬化）**：确定性水晶 PvP/图腾/换甲，在隔离 PvP 测试环境反复验证反应时序与事件循环抖动。达标前不上任何真实对抗。战斗打法以开源实现（Meteor Client、Baritone、mineflayer-pvp 等）为**参考**——**只学机制与参数、重写为本项目 TS，禁止逐行翻译/复制 GPL 源码；GPL 仅在不分发时无约束，分发前必做许可评审；继续用 Mineflayer 无头 bot，不引入 MC 客户端模组栈**。Mineflayer 无头能否达到 <50ms 时序是未验证假设，M3 实测扛不住才评估换栈/Rust。（详见 AGENTS.md §0.6）
5. **M4 多角色协调**：Coordinator 进程编排（拉起/回收多 Bot）+ 动态角色分配 + 共享世界记忆（pgvector）+ 分布式部署（家用节点跑建造与生产/后勤，靠近目标服的 VPS 跑战斗/突袭/侦察）。
6. **M5 收敛重构**：抽 `packages/secure-link` 消灭约 3700 行重复；拆三个千行文件（postgres-repository / bullmq-worker / control-link-server）。趁规模可控时做，排在多 Bot 稳定后、上正式服前。
7. **M6 智能层 & 上正式服**：AI Router 接战略/战术（**先用云 API 验证分工调度的价值，再决定是否上本地大模型**）；灰度上目标服，先小规模、评估封号风险后再扩张。

## 三段式环境纪律（绝不跳级）

所有功能开发和验收：**隔离测试服（回环/内网 offline）→ 私有测试 anarchy 服 → 灰度目标正式服**。未验证的战斗 bot 上正式服 = 送装备 + 送封号。

## 硬性红线（违反任何一条即停止并说明）

- **AI 不碰 tick / 不碰战斗动作 / 不碰敌我识别**：见最高设计原则。敌我识别是硬编码白名单，白名单外一律视为敌人；白名单只能由用户显式配置。
- **online 与 offline 认证路径并存且显式区分**：严禁把隔离测试的捷径逻辑带上正式服。
- **账号凭据纪律**：正版 token 加密存储，绝不进仓库、日志、聊天；一账号一套独立凭据。
- **封号风险如实记录**：不把"反封号"写成已解决；类人化移动=降低明显 bot 破绽，不等于免疫；残余风险由使用者承担。
- **存活即金钱**：L0 存活/死前断线是最高优先级反射；基地失陷触发 COMPROMISED 撤离协议（≥10000 格外重建）。
- **协议纪律**：所有跨进程消息在 packages/protocol 定义 Zod Schema 并显式版本化，未知字段/版本默认拒绝。
- **fail-closed 不弱化**：链路/AI 断开时退回"维持当前角色 + 反射层存活"，不失控、不伪造成功、不补造模拟数据。
- **不重写已验收模块**：protocol、runtime-link、control-link、L0、技能执行器只在设计明确列出的重构点（M5）动，且重构前后测试行为一致。
- **不无测量写 Rust**：作战场景下"寻路服务"从远期可选升为较可能需要，但仍须先测量（事件循环延迟 >50ms）；Rust 战斗需离开 Mineflayer（azalea 当前不成熟），短期不做。
- **验收文化**：每项完成 = `pnpm check` 全绿（类型 + 全部离线测试 + 构建）+ 新代码带测试 + 能跑的验收脚本（test:task-infra / runtime-link / four-process）都跑；文档不把"离线验收"写成"实机验收"，不冒充完成。

## 环境说明

- 本机 Node/pnpm 不在 PATH：用 `C:\Users\baichengbo\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe`（v24）+ 其 `node_modules/pnpm/bin/pnpm.cjs`（11.9.0），或自行装 Node 22+ / pnpm 11.9.0。
- 本机无 PostgreSQL/Redis：真实基础设施测试靠 GitHub Actions（见 .github/workflows），或本机显式准备隔离服务后设 `TASK_POSTGRES_URL`/`TASK_REDIS_URL`/`TASK_INFRA_TEST_NAMESPACE`。
- git remote：`https://github.com/rennaikankk-cmyk/minecraft-multi-agent-studio.git`；当前分支领先远程 1 个提交，推送前先与用户确认。
- 首日清理：删 `runtime-data/` 里的 e2e 日志和 PR 草稿（pr-1-body.md、pull-request-runtime-link.md）；加 `.gitattributes` 固定 LF。

## 汇报要求

每完成一个编号里程碑，用中文向用户汇报：做了什么、跑了哪些验证命令及原始结果（引用退出码/测试数）、遗留边界、当前所处的环境段（隔离/私有测试/正式）。

---

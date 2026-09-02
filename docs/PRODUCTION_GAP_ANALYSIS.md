# 生产缺口分析（2026-09-03）

> 7 大能力域、依赖关系与实施路径。每项标注现有基础 vs 需新建。

## 1. 死亡与装备恢复

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 自动重生 | `mineflayer-client.ts:1270` 死亡时手动发 respawn 包；`runtime.ts:2439-2479` handleDeath 记录事实+取消任务+重置安全 | 重生后自动恢复 Goal 队列 |
| 掉落物价值判断 | `coordinator/survival-needs.ts:157-188` DEATH_RECOVERY need（15 分钟窗口、同维度、dedup） | 价值评估（距离/危险/背包满/连续死亡惩罚） |
| 安全回收死亡物品 | 无 | `recover.drops` Skill（寻路到死亡点+拾取+验证 inventory delta） |
| 回收失败重建装备链 | 无 | 资源图已有 `goal-planner.ts` 的 craft/smelt/collect 链；需加 "重新制造最低装备" 模板 |
| 连续死亡停止送装备 | 无 | death streak counter + survival-needs 阈值升级（3 次连续死亡 → 暂停 DEATH_RECOVERY + 迁移评估） |

**依赖**：生命周期闭环（Phase 1）→ Provenance（Phase 3）→ 本项

## 2. 区块加载与设施产能管理

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 感知 simulation distance | 无（客户端不同步服务器 sim distance） | 服务器探测或经验推断（观察 random tick 速率） |
| 感知 mob cap 占用 | 无（客户端不可见 mob cap） | 通过实体观察推断（周围实体数+spawn 频率） |
| Bot 与设施距离 | `FacilityRegistry` 存 anchor 坐标 | 距离计算+优先级排序 |
| 区块加载状态 | 无 | 区块边界推断（bot 位置 vs facility 位置+模拟距离估计） |
| TPS 感知 | 无（客户端不可见） | 通过 mineflayer physics tick 间隔估计 |
| 最优挂机点决策 | 无 | `afk.optimize` Skill（综合各设施状态+距离+mob cap+产出率） |

**依赖**：iron farm commissioning（Phase 5）→ 本项

## 3. 基地暴露、撤离与重建

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 检测陌生玩家 | `packages/combat/src/threat-analyzer.ts` 未知玩家=+5 威胁分 | `base.threat-assess` Skill（玩家距离+方向+装备+行为） |
| 检测爆炸/结构异常 | 无 | `world.scan` 差分（对比上次扫描）+ 爆炸事件监听 |
| 区分损耗 vs 破坏 | 无 | `provenance.diff` + 阈值（creeper 爆炸 vs 人为精准破坏） |
| 转移贵重物资 | `container.transfer` Skill 已有 | `evacuate.valuables` 组合 Skill（评估+分优先级+运输） |
| 放弃已暴露基地 | 无 | `base.abandon` 状态转换 + 撤离检查清单 |
| 远处建新基地 | `site.assess` + `build.blueprint` 已有 | `base.relocate` 组合（选址+迁移+重建核心设施） |
| 旧基地状态标记 | 无 | `FacilityLifecycleState` 增加 `ABANDONED`/`SALVAGEABLE` |
| 拆除模式保护 | Material Provenance 框架存在 | **生产接入**：bot.dig 边界强制 HarvestAuthorization |

**依赖**：Provenance 生产接入（Phase 3）→ 本项

## 4. 跨维度生产链

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 下界传送门发现 | 无 | `portal.locate` Skill（扫描 obsidian 框+点燃检测） |
| 传送门建造 | `build.blueprint` 可放方块 | `portal.build` 组合（obsidian 框+打火石+坐标换算） |
| 跨维度坐标换算 | `dimensionSchema` 已有多维度支持 | 数学换算（overworld÷8 ↔ nether） |
| 下界路线与安全屋 | `mine.branch` 有安全前置 | `nether.route` Skill（避开岩浆海/恶魂/堡垒） |
| 烈焰棒/下界疣 | 无 | `combat.hostile` 扩展（烈焰人战斗+下界疣收割） |
| 末地进入与撤回 | 无 | `end.enter`（末影之眼+要塞+末地传送门） |
| 维度切换恢复 | `dimensionSchema` 在 Goal/Skill 中已传递 | 切换后 Goal/Claim/Facility/Journal 的 context 刷新 |

**依赖**：基地建设（Phase 4）→ 本项

## 5. 完整资产账本

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 背包记录 | `bot.status.v1` 含 inventory | 已有 |
| 箱子内容追踪 | `container.transfer` 有 readback | `asset.ledger` 持久化存储（箱子 ID→物品→数量→更新时间） |
| 资源预留标记 | `stock.levels` Skill 可查询 | `asset.reserve`（建筑材料/战斗储备/食物缓冲分类） |
| 设施实际产出率 | `FacilityRecord.outputItemsPerHour` 字段存在 | **真实数据回填**（commissioning 后才写入） |
| 材料丢失/重复检测 | 无 | `asset.audit`（ledger 对比 server truth + 异常报告） |
| 多 Bot 资源协调 | `WorkstationRegistry` 有 lease 机制 | `asset.claim` 扩展到采集点/容器/掉落物 |

**依赖**：农场 commissioning（Phase 4-6）→ 本项

## 6. 人工接管与运维（Dashboard）

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 一键暂停自治 | `STUDIO_AUTONOMY_ENABLED` 环境变量 | **Dashboard 按钮**（API endpoint + 前端 toggle） |
| 手工 Goal 优先 | `requestManualControl` 已有 | **公平调度** + UI 显示 manual/autonomy 状态 |
| 单 Bot 隔离 | manager stop/restart 单 bot | **隔离模式**（暂停 autonomy + 只接受 manual Goal） |
| 安全停止全部 Bot | manager 已有 | **一键**（Dashboard 按钮 + graceful shutdown 确认） |
| 查看计划和恢复阶段 | `/v1/tasks` API | **Dashboard 计划视图**（step 级进度+恢复阶段） |
| Spark 队列状态 | `coordinator_ai_health` 事件 | **Dashboard Spark 页**（queue/model/latency/降级原因） |
| 备份/恢复 | 无 | **数据快照**（DB/Journal/基地/设施 → ZIP + 恢复） |
| 版本升级与回滚 | git + build manifest | **部署管道**（新版本 → canary bot → staged rollout） |

**依赖**：生命周期闭环（Phase 1）→ 本项

## 7. Skill 持续改进闭环

| 能力 | 现有基础 | 需新建 |
|---|---|---|
| 真实运行 | isolated fixture + E2E 已有 | **长跑 soak**（S1-S4）+ 外部灰度 |
| Incident/Skill Gap 捕获 | `SkillGapStore` + 分类器 + fingerprint | **生产接线**（bot-runtime 发射 gap 信号到 coordinator） |
| 自动聚类 | `gapFingerprint` 去重已有 | **持久化存储**（当前仅内存） |
| 生成修复提示词 | `generateGapBundle` 已有 | **自动化管道**（gap → bundle → 开发任务） |
| 独立 worktree | 无 | `skill_development_job` 管理 |
| 隔离服测试 | fixture 已有 | **Sandbox 自动化**（新代码 → isolated E2E） |
| 真实 Minecraft 回归 | E2E 已有 | **自动触发**（新代码 → 真实 MC 场景） |
| 单 Bot Canary | `SkillReleaseStatus` 状态机已有 | **运行时接入**（allowlist + rollback） |
| 扩大启用 | 无 | **staged rollout**（canary → limited → active） |

**依赖**：Skill Gap Pipeline 完善（Phase 7）→ 本项

## 实施优先级（依赖拓扑排序）

```
Phase 1（生命周期）──┬── Phase 3（Provenance）── Phase 4（农场）── Phase 5（铁机）
                      │                                              └── Phase 6（火药+运维）
                      ├── Phase 2（灰度服 Profile）
                      └── Phase 6.Dashboard（运维 UI）

Phase 4（农场）── Phase 7（资产账本）── Phase 8（跨维度）
Phase 7（Gap Pipeline）── Phase 9（持续改进闭环）
```

**最高优先级（下一轮应先做）**：
1. waiting goal durable store（Phase 1b）
2. Provenance 生产接入（Phase 3）
3. play.simpfun.cn Server Profile（Phase 2）
4. 恢复/死亡系统（§1）

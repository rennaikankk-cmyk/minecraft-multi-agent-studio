# PvP 体系研究与战斗决策架构（Research Round）

> 状态：**研究文档**。本轮不改任何生产代码行为；本文所有"事实"带来源（附录 A 编号 S*）或代码 file:line 证据，所有"建议"显式标注〔推论〕。
> 基线：branch `main`，HEAD = origin/main = `6f03825`，工作树 clean；CI ✅（run 33594468290）、P1.3 ✅（run 33594468255）。访问日期统一 2026-09-02。

---

## 0. Executive Summary

1. **项目已有一个高质量的"执行器层"（Reflex/引擎 30 模块、321 测试、W0-W8 全实现），但没有"比较器层"**：当前是否交战/撤退由有序固定闸门决定（TargetSelector：血量<8/图腾<1/敌>8/装备差 → 拒绝交战；RetreatController：血<6 紧急撤、<12 撤、>3 敌撤、无图腾=紧急+断线）。这套规则在 15 个标准反例（§12）中约一半会做出错误或次优裁决——不是实现 bug，是**范式缺失**：没有任何地方比较"继续打"与"撤"的期望值。
2. **敌方精确血量不可观察是硬事实**（vanilla 不同步其他玩家 health metadata；记分板 health 含 absorption 且可被插件伪造）。任何决策模型必须建立在区间/概率 belief 上（§8）。但可观察面比直觉大：**装备含附魔与耐久随包同步**（Set Equipment 携带完整 data components）、图腾 pop（Entity Status 35）、受击动画（专用 hurt_animation 包，无伤害量）、敌方延迟（player_info_update latency）、敌方疾跑/潜行/举盾/进食/饮水状态——足够支撑一个诚实且有区分度的 belief。
3. **版本警示**：目标服 luv.mc6.cn = "Paper 26.1.2" / 协议 775 = **MC 26.1.2（2026 年份制版本）**，比项目 E2E fixture 的 1.21.11（协议 774）**高一个版本线**；26.x 相对 1.21.11 的战斗机制差异 UNKNOWN（§3.0）。
4. **推荐架构 = Hybrid（三层映射到既有 R/T/P 时间档）**：保留 Reflex FSM 做硬安全底（图腾/红线/紧急中断）；在 T 档（100ms/50ms 现有反应循环内）插入 **CombatSnapshot → EnemyBelief 更新 → 有界 Utility 评分（18 个 TacticalAction）→ 带滞回/承诺的动作选择器**；P 档与 coordinator/Spark 只做战前准备、立场、支援与复盘，绝不进 per-tick 链（§7、§16）。与 8 种候选的系统比较见 §6——选它不是因为新颖，而是**延迟预算（<50ms/决策）、可确定性测试、可解释 Decision Evidence、迁移成本最低**四项同时达标。
5. **低血 ≠ 撤退**：新模型下 KILL_SECURE/TRADE/PRESS 都可能在 4 血时胜出（§12 反例 1/7）；**NO_TOTEM 是常态而非错误**——图腾缺失只改变 P(death) 的计算（没有 1HP+吸收的保底），不再触发"一律撤退"（§13）。
6. 实施路线（§20）：P0 = belief/snapshot/utility 纯函数库 + Decision Evidence + 兼容层 observer 接线 + Incident 码，feature flag 双轨；P1 = PvP Lab P1/P2 裁判夹具 + 校准管线；P2 = T1/T2 矩阵、E3-E5、多 Bot 协同。
7. 顺带发现两个**生产疑点**（本轮只读不改，见 §2.9）：`combatReflexProbe` 无宿主供给 → reflex-gated 路径在生产可能恒拒绝；`entity_status 2` 被当作"受击"消费，但协议 2 = 三叉戟蓄力动画（受击应走 hurt_animation 包）。

---

## 1. Git / 审计基线

| 项 | 值 |
|---|---|
| branch / HEAD | `main` / `6f03825` = origin/main（fetch 经 127.0.0.1:7897 代理） |
| 工作树 | clean（0 改动） |
| CI（main） | SUCCESS run 33594468290 |
| P1.3 quality gates | SUCCESS run 33594468255 |
| 本轮改动范围 | 仅新增本文档（docs/research/） |
| 生产代码 | **零修改**（§19 Definition of Done #15） |

审计对象：`packages/combat`（30 模块）、`apps/bot-runtime`（combat-driver/adapter/reflex 循环/安全）、`packages/skills`（policy/compat/movement-arbiter/incidents）、`packages/protocol`（gameplay-policy）、`apps/coordinator`、dashboard、E2E、`docs/`（含 FrogClient 内部分析）。

---

## 2. 当前 Combat 能力矩阵

### 2.1 矩阵

图例：Impl=实现；Wired=生产接线（经 bot-runtime CombatDriver，`runtime.ts:430` 当 `profile.combat.enabled`）；Verif=服务器验证；时间档 R≤50ms/T≤200ms/P≤1000ms（`packages/combat/src/index.ts:8-11`）。

| Capability | Implemented | Wired | Inputs | Outputs | Server Verif | Timing | Recovery | Incident | Status |
|---|---|---|---|---|---|---|---|---|---|
| player detection | ✅ wire 层 `_client` entity 包 + 实体适配归一化（`combat-mineflayer-adapter.ts:853-878`） | ✅ | 实体包 | 归一化实体流 | — | 事件驱动 | — | — | DONE |
| identity/whitelist | ✅ `identity.ts` UUID 优先、operator-config 溯源、per-serverProfileId | ✅ | 操作员配置+实体 | 友/敌/中立 | — | 事件 | 配置错误 throw fail-closed | — | DONE |
| threat estimate | ✅ `threat-analyzer.ts` 加权 0-100（近战距+25/水晶距+15/逼近+15/已放水晶锚+25/持械+10/甲≥15+5/刚 pop 图腾+35/未知身份+5） | ✅ | 实体观察 | 威胁分+理由码 | — | T | — | — | DONE |
| target selection | ✅ `target-selector.ts` 有序闸门（血量/图腾/人数/装备）+ score→dist→id 排序 | ✅ | 威胁评估+自身 | 目标或拒绝码 | — | T | — | — | **PARTIAL**（无效用比较，见 §6.1） |
| target lock/switch | ⚠️ 单目标跟随，无 switch penalty/无滞回 | ✅ | 同上 | 单目标 | — | T | — | — | PARTIAL |
| melee cooldown/range | ✅ `weapon-manager.ts` 1.9 冷却 `cooldownRatio≥0.9`（下限 0.85）；reach 由 ServerPolicy 注入非硬编码（`:337-345`） | ✅ | 攻速/时序 | 可挥刀判定 | ACK 链 | T/R | — | — | DONE |
| crit | ✅ `critical-engine.ts` 5 策略含 PACKET_CRIT（双 position 包 ε=2.7e-7） | ✅ | 位置/速度/窗口 | 起跳时机 | 执行回执+超时如实报 | R | 超时降级 | — | DONE |
| W-Tap | ✅ `wtap-engine.ts` W_TAP 100ms / S_TAP 50ms priming | ✅ | sprint 状态 | 重置窗口 | 50ms tick 等待如实 | R | — | — | DONE |
| rotation/aim | ✅ `rotation-controller.ts` 35°/帧限速+3°容差+0.6°确定性抖动 | ✅ | 目标位置 | yaw/pitch | `bot.look` 发包 | R/T | — | — | DONE |
| pursuit | ✅ 无 pathfinder：`melee-controller.ts` 100ms 控制帧 + `movement-controller.ts` 距离带（3-5 格，i-frame 带 2.4-3.8） | ✅ | 距离/朝向 | 控制位 | — | R/T | — | — | DONE（无追逐截断/地形评估 → 见 §12 反例 14） |
| disengage/escape | ✅ `retreat-controller.ts` 固定阈值裁决+威胁质心反向方向 | ✅ | 威胁+自身 | urgency/reasons/actions/direction | — | T | — | — | **PARTIAL**（范式缺口，§6.1） |
| armor/weapon/offhand | ✅ `gear-assessor.ts` 装备对比+爆炸防护轴；`inventory.equip-armor` skill 非战斗 | ✅/⚠️ | 装备 | matchup/shouldAvoid | — | P | — | — | PARTIAL（战斗中换甲 NOT STARTED） |
| health/food/effects | ⚠️ skills/safety：CRITICAL=4/LOW=8/EAT_AT_FOOD=14；**无药水/effects 处理**（无 entityEffect 消费） | ✅ | 自身状态 | 风险码 | — | T | — | — | PARTIAL |
| consumables | ✅ `consumables.ts` 举盾/金苹果/自掷喷溅 | ✅ | 状态 | 动作 | ACK 链 | T | — | — | DONE（缺与 utility 的整合） |
| no-totem behavior | ✅ `survival-stance.ts` preserve-life（默认，无图腾=撤）/expendable/aggressive | ✅ | 立场+图腾 | 是否强制撤 | — | T | — | — | **PARTIAL**（三立场是权重预设的雏形，但仍是硬规则，§13） |
| totem 管理 | ✅ `totem-manager.ts` reflex 补图腾（最高抢占）+`totem-pop-tracker.ts` POP 窗口（吸收 5s/再生 45s） | ✅ | entity_status 35 | 副手换装 | POP 事件权威于旧快照 | R | — | — | DONE |
| crystal | ✅ `crystal-engine.ts` 评分+不可协商自伤红线；`crystal-executor.ts` 枚举/放置/引爆 | ✅ | 地形/实体 | 放置/引爆计划 | 后续实体观察确认（`:165-166`） | R/T | — | — | DONE（评分未接 belief，§14） |
| anchor | ✅ `anchor-engine.ts` 进攻/防守+维度闸 | ✅ | 维度/位置 | 放置/充能计划 | 同上 | R/T | — | — | DONE（同上） |
| PacketMine | ✅ `packetmine-controller.ts` 并发≤2，offhand 让位图腾 | ✅ | 方块 | 挖掘计划 | — | T | — | `RETREAT_IN_PROGRESS` 拒绝 | DONE |
| death/respawn/recovery | ❌ combat 包零处理；runtime 仅记 death 事实+指标（`runtime.ts:2466-2473`） | ❌ | — | — | — | — | — | 无 Incident 码 | **NOT STARTED** |
| multi-Bot support/友伤 | ❌ 单机白名单制，无协同 | ❌ | — | — | — | — | — | — | **NOT STARTED** |
| 战斗循环宿主 | ✅ 受击反射：standard 32 步/8s/100ms；anarchy 200 步/30s/50ms（`runtime.ts:117-124`）；`combat.engage` 单发技能路径 | ✅ | health 下降事件 | 步进循环 | — | R/T | RETREAT 终止（standard） | — | DONE |
| ACK 链 | ✅ `chain-sequencer.ts` ACK 门控交互链，绝不假设包已执行 | ✅ | 回执 | executed/failed/skipped | RTT×3 预算 | T | — | `RETREAT_IN_PROGRESS` | DONE |
| compat/ActionPolicy | ✅ Round 7 域模型/观察器/状态机/策略/门控（deae77b） | ⚠️ manager 侧 only；**bot-runtime 信号上报 wiring-pending**（apps 零 import） | — | /v1/status | — | — | — | 12 新码已有 | PARTIAL |
| PvP Lab/对手夹具 | ❌ e2e 全是 build/facility/goal/movement，无对手 | ❌ | — | — | RCON 仅地形 fixture | — | — | — | **NOT STARTED** |

### 2.2 关键结论

- **执行器层成熟，比较器层缺失**。所有引擎（melee/crit/wtap/crystal/anchor/totem/consumable）都在，但没有一个组件回答"现在该用哪个引擎、值不值得继续"——这个问题今天由固定闸门回答。
- 现有阈值全景（供 §11 对照替代）：
  - TargetSelector 闸门：`minimumEngageHealth`（默认见 policy；anarchy 8/aggressive 4）、`minimumTotemCount`（preserve-life 生效）、`maximumHostileCount`（3/anarchy 8/aggressive 99）、`maximumEngageDistance`（24/anarchy 48/aggressive 64）、`respectGearGap`（anarchy false）。
  - RetreatController：emergency 6/withdraw 12/outnumbered 3（anarchy 4/8/8）；TOTEM_DEPLETED→emergency+可断线；撤退必 `suppressOffense=true`（无"边打边撤"）。
  - skills/safety：CRITICAL 4/LOW 8/EAT_AT 14。
- 撤退方向已用威胁加权质心反向（`retreat-controller.ts:212-241`），与新模型兼容可复用。

### 2.9 生产疑点（本轮只读不改，下轮验证修复）

1. **`combatReflexProbe` 生产恒 null**：`runtime.ts:177` 从 dependencies 取，`runtime-host.ts`/supervisor 均不供给 → `decideForLiveCombat` 的 50ms fail-closed 探针（`reflex-clearance.ts`）在生产可能恒拒绝 reflex 路径。UNVERIFIED（需运行时日志确认实际影响面）。
2. **`entity_status 2` 语义过时**：adapter（`combat-mineflayer-adapter.ts:967` 一带）把 status 2 当受击；协议现状 status 2 = "spear charge attack animation"（三叉戟蓄力，S8），受击应消费 `hurt_animation` 包（1.19.3+，含 yaw 无伤害量，S8）。HitWindowTracker 的 i-frame 观察源可能失真。
3. incidents.ts **无任何 COMBAT_* 码**：战斗失败归一化为 `SKILL_*`/`UNKNOWN_FAILURE`（`FAILURE_CODE_ALIASES`），分类学断层。

---

## 3. Minecraft PvP 机制矩阵（含版本差异）

### 3.0 版本定位（本轮最重要的事实修正）

| 目标 | 版本 | 协议 |
|---|---|---|
| luv.mc6.cn:22936 | **MC 26.1.2**（Paper 26.1.2，2026 年份制命名） | **775** |
| 项目 E2E fixture | MC 1.21.11 | 774 |
| 1.21.x 参照系 | 1.21–1.21.10 | 767–773 |

〔S1〕协议 775 ↔ 26.1/26.1.1/26.1.2；1.21.11 = 774。**结论：目标服比 fixture 高一个版本线；26.x 相对 1.21.11 的战斗差异 UNKNOWN**——下述 1.21.x 事实在 26.x 上需 E2E 实测确认（列入 §21 与下轮 T0 项）。mineflayer README 声称支持到 26.1（S20），但 adapter 需实测。

### 3.1 攻击冷却与武器（1.9+，S2/S3）

- 冷却进度 `p = (t+0.5)/T`，`T = 20/attackSpeed` tick；伤害倍率 `0.2 + 0.8·p²`；**暴击/横扫/疾跑击退需 p ≥ 84.8%**。
- 攻速：剑全系 1.6（0.625s/刀）；斧 木/石/铜 0.8、铁 0.9、金/钻/下界 1.0；锤(mace) 0.6；空手 4。
- 基础伤害（含玩家 +1）：剑 木4/石5/铁6/钻7/下界8；斧 木7/石-钻9/下界10；三叉戟 9；锤 6。
- 锤砸击：下落 ≥1.5 格触发、不受冷却钳制；加成 +4/格(1-3)、+2/格(4-8)、+1/格(9+)、无上限；命中免除摔伤；AoE 击退 2.5 格。Density V：+0.5HP×等级/格。
- 弓 0.9s 满蓄（6HP）、1s 暴击蓄力（~9HP）；弩 1.25s 装（速装 III → 0.5s）、7-11HP。

### 3.2 暴击（S4）

条件全集：下落中 && !onGround && 非攀爬/蛛网 && 非水中（岩浆可、着火不挡）&& !骑乘 && 无缓降/失明/飘浮 && **非疾跑击退（疾跑击退优先占用）** && p≥84.8%。倍率 1.5×，**作用于附魔前**。粒子+音效广播（社区证实他人可见，S33）。

### 3.3 击退与 W-Tap（S5/S6/S33）

- 官方事实：疾跑攻击附加击退且**取消攻击者自身疾跑**；需 p≥84.8%。→ W-tap 的机制根据：每次疾打击退都会熄灭疾跑，重新建立疾跑即重新武装下一次疾跑加成；持续按住疾跑则后续命中只出普通击退。官方 wiki 证明了前半句，"重按 W 重挂加成"为社区共识〔S33，三源交叉〕。
- 基础水平击退位移 1.552 格；击退附魔 +2.586 格/级（KB II 合计 6.724）；竖直 0.8125→1（带任意 KB）。原始速度 0.4 水平为社区代码派生值，官方未文档化〔UNVERIFIED，S33〕。
- 击退抗性：v·(1−r/100)；下界合金 10%/件、40% 全套。
- 空中目标不再被额外上抛（15w49a+）。

### 3.4 无敌帧（S7）

- i-frame = 10 tick（0.5s），红闪；期间伤害 ≤ 首击者被忽略，更高者只结算差值（7 后 12 → 结算 5），**不重置窗口**。比较发生在护甲/附魔减免前、锤加成后。
- **击退同样被 i-frame 门控**（普通击退忽略；KB 附魔击退在伤害超差时仍生效）——对 W-tap 连击节奏是硬约束。

### 3.5 护甲与保护（S9/S10）

- 减伤 `min(20, max(armor/5, armor − 4·dmg/(min(toughness,20)+8)))/25`；封顶 80%。下界全套：20 甲/12 韧/40% 击退抗。
- Protection：每件 4%×级（Prot IV 全套 64%）；EPF 合计封 20 → 80% 上限；Blast/Proj/Fire 对口类型记双倍。不防：虚空/饿死/音波/kill。
- 绕护甲（仅 Protection/Resistance 可救）：摔落、火焰 DoT、溺水、窒息、**魔法（即刻伤害药水/龙息）**、冰冻、鞘翅撞击、饿死、虚空。护甲**能**减：爆炸、弹射物、火球、近战、岩浆。
- **即刻伤害药水无视护甲** → 对满甲敌人是绕甲输出轴（splash 线性衰减 100%→0% over 4 格，S13）。

### 3.6 盾（S11）

- JE（22w43a+）格挡**全部爆炸**（含末影水晶）+近战+弹射物，无伤害上限；不挡：穿透弩箭、喷溅/滞留药水、摔落、音波、尖牙、龙息、闪电。
- 举盾生效延迟 5 tick（0.25s）。斧击举起的盾**必禁用 5s**（100 tick）。爆炸击退"显著降低"。
- 战术含义〔推论〕：斧禁盾窗口 5s 是近战压制的黄金期；对水晶 PvP，举盾是零成本减伤但会被斧惩罚。

### 3.7 横扫（S12）

剑 + 着地 + 非疾跑击退 + p≥84.8%；1×0.25×1 盒、脚 ≤3 格；基础横扫 1HP 平伤，横扫之刃 I/II/III = 剑基伤 50/67/75%。横扫粒子可观察。

### 3.8 治疗与消耗品（S13）

| 物品 | 数值 |
|---|---|
| 金苹果 | 进食 1.6s；再生 II 5s（1HP/1.25s）+ 吸收 I 2:00（4HP，UNVERIFIED 页面确认） |
| 附魔金苹果 | 再生 II 20s（8HP）+ 吸收 IV 2:00（16HP）+ 抗性 I 5:00 + 防火 I 5:00 |
| 即刻治疗 II 药水 | 8HP（基础 4HP）；饮用 1.6s |
| 喷溅药水 | 效力随冲击点 4 格线性 100%→0%；AoE 半径 4 格；投速 ~0.5 格/tick |
| 图腾 | 触发时 1HP+清负面；**再生 II 45s + 吸收 II 5s（4HP）+ 防火 I 40s**；无重装冷却文档（重装速度=物品操作 tick，UNVERIFIED） |

### 3.9 末影水晶（S14/S15）

- 爆炸威力 6；伤害 `((impact²+impact)/2)·7·(2·power)+1`，`impact=(1−d/(2·power))·exposure` → **上限 85**（非传闻 99）。爆炸中心=水晶底部。任何攻击（含 0 伤）引爆；被爆炸炸毁不爆。
- 放置：黑曜石/基岩顶 + 上方 2 格空气/可替换 + 无实体交叠。**未发现 1.20.5+ 放置规则变更**（铁笼挡的是龙束）。
- 盾可完全挡水晶爆炸；黑曜石抗爆 1200（常用值，页面未载，UNVERIFIED）。
- 攻击冷却与引爆交互 UNKNOWN（列入 §21）。

### 3.10 重生锚（S16）

- 充能 4 级（萤石）；仅**在下界充能**；玩家在非下界对其"设置重生点"时爆炸，威力 5+火；按 §3.9 公式上限 ~49-50 伤害（对无甲几乎必杀，UNVERIFIED 精确值）。盾可挡（22w43a+）。每次重生耗 1 充能。

### 3.11 距离/时序/命中箱（S17/S18）

- `entity_interaction_range` 默认 **3.0 格**（玩家），物品 attack_range 组件可覆盖（1.21.2+）；`block_interaction_range` 4.5。服务器插件可改 —— 未知即保守。
- 命中箱：站立 0.6×1.8；潜行 0.6×1.5（1.14+）；游泳/滑翔 0.6×0.6。
- 服务器 20tps；Paper 默认玩家实体追踪距离 **48 格**（可配）→ 侦测硬地平线（S30）。

### 3.12 死亡/掉落/重生（S19）

- 死亡消息全服广播（show_death_messages 可关）——bot 可解析为击杀确证。
- 全背包掉落（消失诅咒除外），5 分钟消失；经验 7×级 上限 100。
- **重生无敌 3s 已在 1.21.4 (24w45a) 移除** → 重生抢 rush 场景成立；重生点 床>锚(下界带电)>世界出生。
- 效果死亡清空；饥饿 ≤17 停自然再生、≥18 才 1HP/80tick；疾跑需饥饿 >6。疾跑 +30% 速度（5.612 vs 4.317 m/s），疾跑跳 7.127 m/s。攻击耗 0.1 exhaust、受击耗 0.1、再生 6.0/HP。

### 3.13 1.20.5→1.21.11 战斗相关变更清单（S2-S19 汇总）

23w51a interaction_range 属性；1.21 锤/风弹；1.21.2 (24w33a) 属性去 generic. 前缀、attack_range 组件、附魔盾闪光；**1.21.4 移除重生无敌**；1.19.3+ 独立 hurt_animation 包。26.x 差异：UNKNOWN。

---

## 4. 客户端可观察性矩阵（Mineflayer 视角）

| 项 | 可观察? | 机制 | mineflayer API | 可靠性/时延 | 来源 |
|---|---|---|---|---|---|
| 敌方精确血量 | ❌ | vanilla 不同步他人 health metadata（索引 9 存在但不用于玩家） | — | **禁止假装知道** | S8 |
| 敌方血量（记分板） | ⚠️ 条件 | health 计分板分值=半心数**含吸收**；list/sidebar/below_name 槽 | `bot.scoreboards` | **插件可伪造**；仅在操作员信任服采信并打 source 标 | S8/S21 |
| 敌方装备（主/副/甲） | ✅ | Set Equipment 包携带**完整 data components（含附魔+耐久）**；仅视觉附魔光失效是客户端 bug MC-173747 | `entity.equipment`/`entityEquip` | 事件驱动高可靠；部分服务器剥 components → 附魔缺失时按未知处理 | S8/S22 |
| 敌方药水效果 | ⚠️ 部分 | metadata 索引 10=粒子颜色、11=ambient；只知"有某效果"，不知效果/等级 | `entity.metadata`/`entityEffect` | 1 tick 粒度，推断性质 | S8 |
| 敌方进食/饮水/举盾 | ✅ | 手状态字节（索引 8：0x01 使用中/0x02 哪只手）+pose（无 BLOCKING pose，举盾看手状态） | metadata 派生 | 可靠；治疗意图的关键信号 | S8 |
| 图腾 pop | ✅ | **Entity Status 35** 全追踪客户端可见 | wire 层 entity_status（现 adapter 已用） | 单信号高可靠 | S8 |
| 受击 | ⚠️ | `hurt_animation` 包（1.19.3+）：实体 id+yaw 倾角，**无伤害量**；status 3=死亡音效动画 | `entityHurt`/`entityDead` | 只有时序+方向，伤害须推断 | S8/S20 |
| 死亡 | ✅ | Remove Entities + 新实体 id 重生（玩家）+ 系统聊天死亡消息 | `entityGone`+`message` | 死亡消息是最强确证（可关 gamerule） | S8/S19 |
| 疾跑/潜行/滑翔/换手 | ✅ | flags 字节（0x02 sneak/0x08 sprint/0x20 invisible…）+status 55 换手 | `entityCrouch` 等 | 每 metadata tick 延迟，可靠 | S8 |
| **敌方延迟（ping）** | ✅ | player_info_update Update Latency（ms） | `bot.players[x].ping` | ~1s 采样粒度——TTK/走位模型可用输入 | S8 |
| 敌方位置/速度 | ⚠️ | teleport + rel-move（≤20Hz）；Set Entity Motion **仅服务器施加的冲量**（击退/爆炸）——普通移动是客户端权威增量 | `entityMoved`/`entity.position`/`entity.velocity` | 速度需位置差分推断，1-2 tick 陈旧+插值 | S8 |
| 暴击/横扫粒子 | ✅ | Level Event 粒子广播（ID 2006/2007 UNVERIFIED） | `entityCriticalEffect` 等 | 他人暴击可见→敌人输出节奏侧写 | S20/S33 |
| 服务器 setback/reject | ⚠️ | Synchronize Player Position 强拉=可见；动作拒绝/内部启发式不可见；vanilla 踢="moved wrongly"类 | forcedMove/kicked | 兼容层 observer 的输入面 | S8 |
| 实体追踪范围 | ⚠️ | Paper 默认玩家 48 格 + view-distance | `entityGone/Spawn` churn | 追击 E2E 必须处理 spawn/despawn 抖动 | S30 |

**对决策模型的直接约束**〔推论〕：
1. 伤害数字不存在 → 我方每次命中对敌造成的伤害是**区间**（武器/附魔/冷却已知，敌甲材质可见，Protection 未知）。
2. 敌方血量只能是 [lo,hi] 区间+置信度（§8）。
3. 敌方治疗（金苹果/药水）是**可观察事件**（进食动画+药水粒子颜色）→ belief 扩张有据。
4. 敌方 offhand 图腾可见 → "可能带图腾"不必猜，可直接观察（除非服务器剥 components）。
5. 敌方 ping 可见 → 高 ping 敌人 whiff 率上升，PRESS 价值上调；我方 ping 由自身 RTT 已知。

---

## 5. 开源体系研究与许可证

> 纪律：功能多 ≠ 架构好。每个项目只回答"学什么机制"；**LGPL/GPL 一律只读思想、clean-room 重写**（本项目无 LICENSE 冲突风险；FrogClient 为反编译产物许可存疑，同纪律）。

### 5.1 项目矩阵

| 项目 | 许可证 | 维护 | 学什么 | 不学什么/风险 | 证据 |
|---|---|---|---|---|---|
| PrismarineJS/mineflayer | MIT（活跃，2026-08-31 push） | ✅ | 事件模型（`entityHurt/entitySwingArm/entityEquip/entityEffect/entityCriticalEffect`）、物理仅本地 bot、实体=包真值 | 它是运行时底座，无决策层 | S20 |
| PrismarineJS/mineflayer-pvp | MIT | ✅ 2026-04 | 反面教材：单目标+pathfinder 驱动+`meleeAttackRate` 解冷却，无撤退/无 kiting/无效用 | 整体太天真，不可用作决策层 | S23 |
| PrismarineJS/mineflayer-pathfinder | MIT | ✅ | **Goal 即条件**（GoalNear/Follow/RunAway/Composite）的目标系统抽象；战斗应持高层 goal 而非裸按键 | 与战斗互斥时的重规划抖动 | S24 |
| MineflayerArmorManager / auto-eat / tool | MIT | ✅ | 阈值触发消耗品状态机 + 事件生命周期（eatStart/Finish/Fail）——与本方案 consumables 整合形态同构 | armor-manager 只看护甲点数无 PvP 权重 | S25 |
| cabaletta/baritone | **LGPL-3.0 + anime exception** | ✅ 2026-09-01 | goal API、分段 A*/路径拼接/代价启发式、avoid 类目标的战斗回避模式 | **许可证不兼容：禁止复制任何代码**；且其为客户端 mod 语境 | S26 |
| MeteorDevelopment/meteor-client | **GPL-3.0** | ✅ 2026-08-29 | KillAura：目标组（SortPriority/maxTargets/range vs **wallsRange**/实体过滤器）、rotation 模式（Always/OnHit）、盾模式（Break/Ignore）、timing 组（hitDelay/switchDelay/**tpsSync 按服务器 TPS 归一攻击时序**/pauseOnLag/**pauseOnCA 跨模块协调**）；CrystalAura 系：放置 vs 引爆双评分、自伤/破伤计算、face-place；AutoTotem：副手时序；Surround/AutoCity/Burrow 的城市战几何 | GPL 禁复制；其"无限速包级优势"在 bot 协议端不可复制，须翻译为合规节奏 | S27（机制为社区文档+源文件存在性，细节 UNVERIFIED） |
| Wurst-Imperium/Wurst7 | GPL-3.0 | ✅ | 每模块文档化的 wiki 形态；次级参考 | 同 GPL 纪律 | S28 |
| FrogClient（内部资料 `docs/frogclient-analysis-2026-09-02.md`） | **反编译产物，许可存疑** | 原仓库 404 | RotationManager 防漂移四要点（出站包=唯一真值/每 tick 步长钳制 108°·45°/拟人抖动/snapBack）；movementSync 视角-移动解耦；全局单例 RotationService 结论；AutoCrystal/Predict/Hole 思路 | **严禁逐行翻译**；反编译 bug 已标注（如 wrapDegrees 二次减 180°）；客户端物理特权不可移植 | 内部文档（CFR 0.152 反编译，自建分析） |
| Utility AI（Infinite Axis） | — | 文献 | 每动作每考量过响应曲线打分、加权求和、最高分执行；千级 agent 规模；可解释（分数即理由） | 曲线参数需校准，防过拟合 | S29（Dave Mark GDC 2015 等） |
| GOAP（F.E.A.R.） | — | 文献 | STRIPS 式 A* over 动作前置/效果/代价；三层架构（行为/工作记忆/规划器）；**战前准备序列**（穿甲→备图腾→备水晶）天然适配 | 重规划延迟与代价调参复杂；不适合 T 档实时比较 | S31（Orkin 2003/2006） |
| Behavior Tree | — | 文献 | 优先级选择器/序列/并行修饰器——**安全中断**的天然表达 | 数值权衡弱（并行效用不天然） | S32（Simpson 2013） |
| POMDP | — | 文献 | belief-state 维护正是隐藏血量问题的理论形态 | 精确求解不可行；取其"信念+置信度"思想做近似 | S34（Kaelbling et al. 1998） |
| MCTS | — | 文献 | anytime/预算搜索 | 20Hz+RTT 下 <50ms 预算；模拟保真度（击退随机性+敌方策略未知）不足 → **不进实时链，仅离线校准/未来 shadow** | S35（Browne 2012 等） |
| MineRL / VPT | 各自许可 | 存档 | 学习策略上下文（imitation 基座）——非决策架构参照 | 不采用 | S36 |

### 5.2 从对手侧学到的（Meteor/FrogClient 类 utility client 的对抗含义）〔推论〕

对手若为此类客户端：他们会 face-place 水晶、tpsSync 归一攻击、tps 抖动时暂停、跨模块协调（pauseOnCA）、断盾斧 5s 窗口压制、surround/burrow 防爆。我方模型需要：**wallsRange 式的隔墙威胁评估**、自伤红线（已有）、surround 反制（已有 SurroundPlanner 可反用）、以及"对手输出节奏侧写"（从对方挥空/暴击粒子/攻击间隔统计）——列入 §8 belief 的 opponent profile 字段。

---

## 6. 决策算法候选比较

评估维度针对本项目约束：决策预算 ≤50ms（anarchy 反射 50ms 步进、T 档 100ms）；确定性可测试（离线回放校准的前提）；不完全信息（敌方血量不可见）；可解释（Decision Evidence）；多 Bot 扩展；无需 LLM 在环。

| # | 候选 | 延迟 | 确定性 | 可调试 | 可测试 | 不完全信息 | 参数量 | 过拟合风险 | 多Bot | 需LLM | 迁移成本 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 固定阈值规则（现状） | 极低 | ✅ | 差（只有原因码） | ✅ | ❌ 假装确定 | 少 | 高（阈值=场景记忆） | 差 | 否 | —（现状） | **保留为 Reflex 硬安全底，不作比较器** |
| 2 | FSM（现状闸门+状态） | 极低 | ✅ | 中 | ✅ | ❌ | 少 | 中 | 差 | 否 | 低 | 同上：Reflex 层保留 |
| 3 | Behavior Tree | 低 | ✅ | 好（树路径） | ✅ | ⚠️ 装饰器可带概率但笨拙 | 中 | 中 | 中 | 否 | 中 | 仅用于安全中断/优先级编排 |
| 4 | **Utility AI（有界）** | 低（求和+曲线） | ✅ 纯函数 | **好（分数即理由）** | ✅✅ 离线回放重放 | ✅ 概率/区间天然入分 | 中（每考量 1-2 参数） | 中（靠 §19 校准+holdout 控制） | 好（team 项入分） | 否 | **低**（嫁接在现有引擎上） | ✅ **T 档比较器采纳** |
| 5 | GOAP/Planner | 中（重规划） | ✅ | 好（计划即解释） | ✅ | ⚠️ 需世界状态布尔化 | 多 | 中 | 中 | 可选 | 中 | P 档/战前准备序列采纳（复用现有 deterministic planner 形态） |
| 6 | POMDP 精确求解 | ❌ 不可行 | — | — | — | ✅ 理论正解 | 多 | — | — | — | 高 | ❌；取 belief-state 近似思想（§8） |
| 7 | MCTS/短视野 rollout | 高（>50ms 预算，模拟保真不足） | ❌（随机） | 中 | ⚠️ | ⚠️ 敌策略未知使 rollout 偏 | 多 | 高 | 中 | 否 | 高 | ❌ 实时链；✅ 离线校准工具/未来 shadow |
| 8 | **Hybrid：Reflex FSM + Utility 战术 + 高层 Planner** | 分层达标 | ✅（各层纯函数） | **✅（层间证据链）** | ✅✅ | ✅（belief 挂在 T 档入口） | 中 | 中（分层隔离） | ✅ | 仅 P 档辅助 | **最低**（映射现有 R/T/P） | ✅ **推荐** |

**推荐理由展开**〔推论〕：
- **延迟**：utility 评分是 O(动作×考量) 次乘加（18×~10），远低于 50ms；MCTS/POMDP 精确解超预算。
- **不完全信息**：只有 utility 框架能让 `P(enemyHP≤x)`、`escapeP` 这样的**信念量直接参与比较**；FSM/阈值无法表达"低血但 P(kill)>P(death)"。
- **可测试**：现有 combat 包零依赖纯函数风格 + 321 测试证明该形态可维护；utility 评分器同形态可做表驱动测试与回放校准。
- **迁移**：18 个 TacticalAction 全部映射到**已存在的引擎**（melee/crit/wtap/crystal/anchor/totem/consumable/movement/retreat 几何）——新代码只做"裁决+证据"，不重写执行。
- 与 MineRL/VPT 类学习策略相比：不可解释、不可离线校准、样本获取成本高，P2 之后再议。

---

## 7. 推荐 Hybrid 架构

### 7.1 数据流

```text
┌─ R 档 Reflex FSM（≤50ms，硬安全，不可被 utility 否决）──────────────┐
│  TotemManager 副手补图腾 · 水晶/锚自伤红线 · 举盾(检测到斧) ·        │
│  紧急脱离中断（岩浆/虚空/窒息） · ServerPolicy/兼容层节奏钳制        │
└──────────────────────────────────────────────────────────────────┘
                              ↑ 只读快照
mineflayer 事件流 ──► CombatSnapshot 组装（§9，含 freshness 戳）
                              │
┌─ T 档 战术核心（100ms/50ms，纯函数，可在循环外单测/回放）────────────┐
│ 1 EnemyBeliefState 更新（§8：命中扣减/治疗扩张/pop 重置/时间衰减）    │
│ 2 OurCombatState 装配 + 风险预算 RiskBudget（§13）                   │
│ 3 UtilityTacticalScorer：18 个 TacticalAction × 效用式（§11）        │
│ 4 ActionSelector：硬约束过滤 → 承诺/滞回/紧急中断（§11.4）           │
│ 5 DecisionEvidence 产出（§17，JSON，确定性可回放）                   │
└──────────────────────────────────────────────────────────────────┘
                              ↓ 战术动作（映射到现有引擎，不改其内部）
melee-controller · wtap/critical-engine · movement-controller ·
crystal/anchor-engine · consumables · retreat 几何 · chain-sequencer(ACK)
                              ↑ 服务器回执/事件（含兼容层 observer 信号）
┌─ P 档 高层（≤1s + coordinator/Spark，低频）─────────────────────────┐
│  战前准备计划（GOAP 式：装备/图腾/水晶补给） · 立场建议 · CALL_SUPPORT│
│  路由 · 复盘/Incident 聚类 · 参数实验建议（shadow，仅建议）           │
└──────────────────────────────────────────────────────────────────┘
```

### 7.2 与现状的映射（迁移成本最低点）

| 现有组件 | 去向 |
|---|---|
| RetreatController 固定阈值 | 降级为 utility 不可用时的**兜底路径**（feature flag 双轨）；方向函数 `awayFromThreats` 直接复用 |
| TargetSelector 闸门 | 拒绝码保留为**硬约束过滤器**（如 OUTNUMBERED 在 Preservation 模式仍是硬否决）；目标选择改由 utility 的 target-lock 考量承担（含 switch penalty） |
| ThreatAnalyzer | 输入 CombatSnapshot，分数作为 utility 的一个考量（敌威胁→我 TTD） |
| survival-stance | 演化为 RiskBudget 的四档预设（§13） |
| 18 引擎 | 不动，新增 TacticalAction→引擎 的映射表 |
| 反应循环（32 步/200 步） | 循环骨架不动，步内调用 TacticalCore |
| 兼容层 observer | T 档每步从 observer 取信号 → belief 的 setback/reject 衰减项 + utility 的 uncertainty penalty |

### 7.3 关键接口草案（TypeScript 形态，零依赖，落在 packages/combat 新模块或新包 `combat-tactics`）

```ts
interface CombatSnapshot {            // §9：单次决策的完整输入，全字段带 observedAtMs
  self: OurCombatState;
  enemies: readonly EnemyBeliefState[];  // §8
  allies: readonly AllyObservation[];
  world: CombatWorldFacts;            // 掩体/地形/维度/水晶位/锚位/追踪范围
  policy: PolicyContext;              // gameplayPolicy + ServerPolicy + compat effectiveMode/gates
  loop: { nowMonotonicMs; stepMs; pingMs; rttEstimateMs; setbackSignals: number };
}

type TacticalActionId = /* §10 的 18 个字面量 */;

interface ActionCandidate {
  id: TacticalActionId;
  utility: number;                    // §11 公式，有界 [0,1] 归一后
  breakdown: Record<string, number>;  // 每项考量得分 → Decision Evidence
  preconditionsMet: boolean;
  hardBlockedBy?: "POLICY_GATE" | "COMPAT_MODE" | "RED_LINE" | "STALE_STATE";
}

interface TacticalDecision {          // ActionSelector 输出
  action: TacticalActionId | "HOLD";
  previousAction: TacticalActionId | null;
  switched: boolean;                  // 滞回/承诺裁决
  switchReason: "NEW_UTILITY_DELTA" | "EMERGENCY" | "COMMITMENT_EXPIRED" | "STALE_INVALIDATION" | null;
  evidence: DecisionEvidence;         // §17
}
```

- **decision cadence**：T 档每步（standard 100ms / anarchy 50ms）重算全部 18 动作效用——纯函数无状态，天然与步进循环对齐。
- **ownership**：战术核心只发 TacticalAction，**移动所有权仲裁仍归现有机制**（combat 抢占=pathfinder.stop()+取消技能）；MovementArbiter（`skills/src/movement-arbiter.ts`）的 COMBAT:10 优先级建议未来统一接线（现为取消式所有权，行为等价但不可组合）。
- **server verification**：执行结果回流既有 ACK 链/事件；**未确认命中绝不更新 belief**（§8 纪律 3）。
- **配置与版本**：所有效用权重/曲线参数集中在 `tactics-profile.ts`（版本化 schema，canary/rollback 走现有配置通道）；与 ServerPolicy 数值一样禁止散落硬编码。
- **迁移步骤**（P0 详见 §20）：①纯函数库+测试（不动生产）②Decision Evidence 事件化 ③observer 接线 ④feature flag 双轨（旧闸门=兜底）⑤PvP Lab 对照实验后才切默认。

---

## 8. Enemy Belief State（敌方信念状态草案）

### 8.1 schema 草案

```ts
interface EnemyBeliefState {
  entityId: number;
  identity: { uuid: string | null; username: string; classification: "HOSTILE" | "UNKNOWN" };  // UUID 优先（现有 identity.ts）

  // —— 位置/运动（区间而非点）——
  lastObservedAtMs: number;
  position: { x: number; y: number; z: number };
  velocityInterval: { min: Vec3; max: Vec3 };        // 位置差分推断，1-2 tick 陈旧
  lineOfSight: boolean | null;                        // 射线+方块缓存；null=未知
  trackingRangeRisk: "IN_RANGE" | "EDGE" | "LOST";    // Paper 48 格地平线（S30）

  // —— 可观察装备事实（Set Equipment，含 data components；剥除则标 unknown）——
  equipment: {
    heldItem: ItemStackFacts | null;                  // id + 附魔(可见时) + 附魔未知标记
    offhandItem: ItemStackFacts | null;               // **offhand 图腾可直接观察**
    armorPieces: readonly (ItemStackFacts | null)[];  // 材质→armor/toughness 上界
    componentsStripped: boolean;                      // 服务器剥 components → 附魔不可知
  };
  blockingWithShield: boolean;                        // 手状态字节
  usingItem: { kind: "EATING" | "DRINKING" | null; startedAtMs: number | null };

  // —— 血量信念（核心）——
  healthBelief: HealthBelief;
  observedTotemPops: number;
  lastTotemPopAtMs: number | null;                    // status 35
  popWindowActive: boolean;                           // 5s 吸收 II + 45s 再生 II（§3.8）

  // —— 侧写 ——
  attackCadenceObserved: { samples: number; meanIntervalMs: number | null };  // animation 包
  critRateObserved: { samples: number; rate: number | null };                 // 暴击粒子
  pingMs: number | null;                              // player_info_update latency
  opponentProfile: "UNPROFILED" | "UTILITY_CLIENT" | "LEGACY" | "NORMAL_PLAYER"; // §5.2 侧写，UNPROFILED 起步

  confidence: number;                                 // [0,1]，随证据量/新鲜度衰减
  evidenceRefs: readonly string[];                    // 关联事件 id（审计/回放）
}

interface HealthBelief {
  /** 概率化区间：lo/hi 半心数；deadBy 下一次有效命中的死亡概率 */
  intervalHp: { lo: number; hi: number };   // lo≥0, hi≤20(+吸收修正)
  absorptionPossible: boolean;              // pop 窗口内=确定 4HP；进食金苹果=可能
  pDeadByNextHit: number;                   // 由区间+分布假设导出
  distribution: "UNIFORM" | "TRIANGULAR_PEAK_LO" | "POINT";  // POINT 仅当信任源
  pointSource: null | { kind: "SCOREBOARD"; trustedServer: boolean };  // §4 伪造风险
  lastUpdateEvidence: "CONFIRMED_HIT" | "OBSERVED_HEAL" | "TOTEM_POP" | "DECAY" | "TRUSTED_SOURCE" | "PRIOR";
}
```

### 8.2 更新规则（全部纯函数，可表驱动测试）

1. **先验**：新目标 = [20,20]？不——未知玩家按 [8,20]（成年玩家可能已掉血）起步，confidence 低；**禁止用任何"看起来很残"的直觉收窄**。
2. **确认命中扣减**（唯一合法的向下更新）：我方攻击获服务器侧确证（敌 hurt_animation 观察到，或伤害事件/i-frame 推断）后，按**伤害区间**同时收缩 lo/hi：
   - 伤害区间构成：武器基伤+附魔（我方已知）× 冷却倍率（`0.2+0.8p²`，我方时序已知）× 暴击 1.5（我方状态已知）→ 得原始伤害区间 [d_raw_lo, d_raw_hi]（hi=暴击、lo=未暴击/未满冷却）；
   - 敌方减伤区间：armor 材质可见 → armor/toughness 点值已知，Protection 未知 → 减免区间 [armor-only, armor+80%上限]（附魔可见则收窄）；
   - 净伤害 [d_net_lo, d_net_hi]；`hi -= d_net_lo; lo = max(0, lo - d_net_hi)`（区间算术保守向）。
   - **i-frame 规则**（§3.4）：若 HitWindowTracker 判定命中落在敌 0.5s 无敌帧内，扣减改为"差值规则"的区间近似——默认**只记证据不扣减**（保守），除非上一击伤害已知可算差值。
   - **未确认命中绝不扣减**（纪律 3：whiff/被格挡/无敌帧吞伤都无法确认）。
3. **治疗扩张**：观察到进食金苹果动画完成 → `hi += 8~9 有效回复`（再生 II 5s≈4HP+吸收 4HP，区间化）、`absorptionPossible=true`；饮水/掷药（药水粒子色 0x0000F8D 类即刻治疗色）→ 按对应区间扩张。**lo 不变**（治疗不证明之前满血）——但分布重心右移。
4. **图腾 pop 重置**：status 35 → `intervalHp = [1, 5]`（1HP + 吸收 II 4HP 上界）+ `popWindowActive`（5s 内再生不显著、45s 再生 II 总计至多 +36HP 的爬升项进 TTK 估计而非区间）。`observedTotemPops++`。
5. **时间衰减**：每 `decayMs`（建议起点 2000ms，校准项）无证据 → 区间向 [0,20] 全宽扩张一步、confidence 下降；治疗可能性随时间累积（敌方可能已吃过药）。
6. **死亡确证**：死亡消息（含敌名）/entityGone+尸体消失 → belief 关闭，输出 KILL_CONFIRMED 证据（击杀归属用于指标）。
7. **信任源**：操作员显式信任的服务器记分板 health（含吸收，S21）→ `POINT`+`pointSource`，confidence 高；**未信任服一律不用**（插件可伪造）。
8. **公平性红线**：测试裁判（RCON）真值只进**事后评分**，绝不进 bot 输入；对手与被测 bot 状态零共享。

### 8.3 敌方 TTK 估计（供 §11 使用）

`TTK_enemy = intervalDivide(healthBelief.intervalHp (+absorption), ourDamageInterval, ourAttackIntervalMs)` → 输出区间 [best, worst]（次）与所需命中数区间 [n_lo, n_hi]。同理 `TTD_us`：敌方对我 = 敌武器可见+攻速侧写+我方护甲已知（精确）→ 我方 TTD 是**点+ping 抖动区间**，比敌方 TTK 可靠得多——这是不对称优势，模型应利用。

---

## 9. 我方 Combat State（OurCombatState 草案）

```ts
interface OurCombatState {
  health: number; absorption: number; food: number; saturationEstimate: number; // 饥饿≤17 停再生（§3.12）
  effects: readonly ActiveEffectFacts[];            // 自身药水全知（客户端状态）
  armor: { points: number; toughness: number; epfEstimate: number; durabilityCritical: boolean };
  weapon: { current: ItemStackFacts; cooldownRatio: number; /** p=(t+0.5)/T 实时 */ };
  offhand: { item: ItemStackFacts | null; totemReady: boolean };
  totemsAvailable: number;                          // 0 是常态（§13）
  consumables: { goldenApples: number; potions: { healingII: number; ... }; shieldDurability: number };
  crystalMaterials: { crystals: number; obsidian: number; glowstone: number };
  position: Vec3; velocity: Vec3; onGround: boolean; inWater: boolean; fallState: ...;
  nearestCover: { blockPos: Vec3 | null; distanceBlocks: number | null };   // 射线+方块缓存
  escapeRoutes: readonly { direction: Vec3; clearanceBlocks: number; blocked: boolean }[];  // §12 反例 7/14
  movementOwner: "COMBAT" | "PATHFINDER" | "SKILL" | "IDLE";
  currentGoal: { id: string; kind: string; criticalInventory: boolean } | null;  // 死亡成本输入
  deathCostInputs: { inventoryValue: InventoryValueBand; distanceToBase: number | null; baseCoordsExposed: boolean };
  pingMs: number; rttEstimateMs: number; recentSetbacks: number;
  observationFreshness: { healthMs: number; positionMs: number; enemiesMs: number };  // 超龄→STALE 处置
}
```

要点：**所有字段带观察时间戳**；`escapeRoutes.blocked` 是反例 7 的关键输入（现有 retreat 方向函数只给方向，不给"该方向是否可走"——地形评估是新增量，用方块缓存 ray-cast，T 档预算内可负担少量样本）。

---

## 10. TacticalAction 模型（18 动作草案）

统一字段：`preconditions / expectedBenefit / expectedRisk / timeToEffectMs / serverVerification / cancellation / fallback / failureCode / featureGate / freshnessRequirement`。

| 动作 | 引擎映射 | preconditions（要点） | time-to-effect | 验证 | 失败码（新增） | 门/新鲜度 |
|---|---|---|---|---|---|---|
| PRESS | melee+wtap+crit | 目标 in belief、reach 内或可趋近、cooldown p≥0.85 | 0-100ms（已瞄准时） | hurt_animation/伤害事件 | `COMBAT_PRESS_FAILED` | 攻击节奏归 ServerPolicy/compat pacing |
| KILL_SECURE | melee/crystal/anchor 组合 | **§11.3 谓词全过**（belief 低血概率+动作即将生效+TTD margin+无高概率即疗/图腾+撤退更差+无自伤友伤+置信度） | 180-300ms（旋转+发包+tick） | 伤害事件/死亡消息 | `KILL_SECURE_FAILED` | belief 新鲜度 ≤250ms |
| TRADE | stance 权重+PRESS | 接受对换：TTK/TTD 比有利区间 | 同 PRESS | 同上 | `COMBAT_TRADE_UNFAVORABLE`（预判拒签） | riskBudget 允许 |
| RESET_DISTANCE | movement BACK_OFF+盾 | 有可走 escapeRoute、敌方追击估计受限 | 400-800ms（脱离 reach） | 距离差分 | `DISENGAGE_FAILED` | — |
| REPOSITION | movement STRAFE/绕侧 | 掩体存在、非被锁定 | 300-600ms | 位置差分 | `COMBAT_REPOSITION_FAILED` | — |
| TAKE_COVER | movement→掩体后 | nearestCover 存在且可及 | 距离依赖 | LoS 射线翻假 | `COMBAT_COVER_UNREACHABLE` | — |
| HEAL | consumables 金苹果/药水 | 敌方威胁受抑（LoS 断/被拖延）≥1.6s 窗口 | 1.6s（进食） | health/absorption 上行 | `HEAL_INTERRUPTED` | — |
| SWITCH_WEAPON | weapon-manager | 更优武器对当前 belief（斧禁盾窗口→斧） | 1 tick 换手 | heldItem 确认 | — | 冷却重置计入效用（§3.1 p 归零） |
| SWITCH_OFFHAND | totem/shield/potion | 图腾 0→补；敌方弓→盾 | reflex 优先级最高（R 档） | offhand 确认 | `TOTEM_SWAP_FAILED` | R 档硬规则非效用 |
| CRIT_CHAIN | critical-engine | 下落窗口+p≥0.848 | 0-200ms | 暴击粒子（自见） | 已有超时降级 | — |
| W_TAP_PRESSURE | wtap-engine | 疾跑态+将命中 | 50-100ms | 敌位移差分 | — | ping 高时降权（反例 12） |
| CRYSTAL_ATTACK | crystal-engine/executor | 有合法放置位+belief 收益+**自伤红线永不越** | 放置+引爆 ~300-500ms | 爆炸包+实体消失 | 已有红线码 | compat FEATURE_GATE（EXPLOSIVE_CRYSTAL） |
| ANCHOR_ATTACK | anchor-engine | 非下界 offense 门+充能材料 | ~400-600ms | 爆炸包 | 已有 | 同上（RESPAWN_ANCHOR_COMBAT） |
| PACKETMINE_ACTION | packetmine-controller | 目标掩体/床壳拆除 | 依方块 | 方块差分（WORLD_STATE 事件） | 已有 | compat pacing（PACKET_INTENSIVE） |
| CHASE | melee-controller 追击带 | 追上概率（速度比+距离）≥阈值、时间/距离双截断、无地形陷阱标记 | — | 距离收敛 | `CHASE_ABANDONED`（截断，非失败） | 反例 14 假撤退 |
| DISENGAGE | retreat 几何+movement | escapeRoute 可走或 TRADE 已拒 | 800-2000ms | 脱离追踪/威胁降级 | `DISENGAGE_FAILED` | — |
| CALL_SUPPORT | coordinator 队列（P 档） | 有盟友、支援 ETA < 场景存续估计 | 支援延迟（秒级） | 盟友接近观察 | `SUPPORT_UNAVAILABLE` | 不进 R/T 档 |
| PROTECT_OBJECTIVE | 任务防护（护送/守点） | objective 在危险半径 | — | 目标存续 | `OBJECTIVE_EXPOSED` | deathCost/exposure 主导 |
| RECOVER_DROPS | 战利品/尸袋回收 | 战斗结束或安全窗口、掉落 5min 时钟 | — | 拾取确认 | `DROPS_LOST` | 与 CHASE 冲突时 utility 裁决 |

---

## 11. 核心决策模型（PRESS/KILL_SECURE/…统一比较）

### 11.1 效用式（研究起点，非实现默认值）

```text
U(a) = w_kill   · P(kill | a)                  ← TTK 区间 + 动作生效时序
     + w_surv   · P(survive | a)               ← TTD 区间 + escapeP + 治疗可用性
     + w_obj    · objectiveCoverage(a)         ← 目标存续/物资保护/暴露成本
     + w_ally   · allySynergy(a)               ← 换防/集火增益（多 Bot）
     − w_death  · P(death | a) · deathCost     ← deathCost 由 §13 风险预算调制
     − w_dmg    · E[damageTaken | a] / maxHp   ← 含自伤（水晶/锚）
     − w_res    · resourceCost(a)              ← 消耗品/耐久/水晶存量
     − w_exp    · exposureCost(a)              ← 暴露路线/坐标（反例 8/15）
     − w_unc    · (1 − confidence) · actionIrreversibility(a)
```

- 全部项归一 [0,1]，权重和为 1，**每考量 ≤2 个校准参数**（响应曲线的斜率/拐点），总参数 ~30 个 → §19 网格/Bayesian 有界搜索可行。
- **TTK/TTD 区间计算**（§8.3）：`P(kill|PRESS) ≈ P(belief 区间 ≤ 1-2 次命中净伤)` × 命中率估计（ping/敌方速度/历史 whiff 率）。
- **first-action advantage**：`timeToEffect(a) < TTD_us.best` 且有 margin → 该动作享有先手项（乘子而非加分，避免小概率大数值失真）。KILL_SECURE 的 180-300ms 生效 vs 敌方 625ms 起的下一刀，是反例 1 的数学本体。
- **escapeP**：`escapeRoutes.clearance × 速度比(7.127 vs 7.127+KB) × 敌追击意愿侧写`；被墙/悬崖截断 → 反例 7 中 DISENGAGE 的效用崩塌、TRADE 上升。
- **uncertaintyPenalty 只惩罚不可逆动作**（KILL_SECURE 换命、水晶自伤近致死），对可逆动作（RESET/REPOSITION）近乎零——这是"置信度低时选中庸"的机制化表达。

### 11.2 硬约束层（先于效用）

1. ServerPolicy/compat 节奏与 FEATURE_GATE（现有：anarchy 才开 EXPLOSIVE_CRYSTAL 等）。
2. 水晶/锚自伤红线（现有 blast-model，不可协商——"可以死≠可以自杀"，survival-stance.ts 纪律 2 保留）。
3. Reflex 档抢占（图腾补装/举盾/岩浆脱离）永远先于效用裁决。
4. belief 核心字段超龄（>250ms）→ KILL_SECURE/CRYSTAL_ATTACK 直接 `hardBlockedBy:"STALE_STATE"`。

### 11.3 KILL_SECURE 候选谓词（全部满足才可成为最高优先候选）

1. `P(enemyHp ≤ 本次动作净伤上界) ≥ θ_kill`（belief 区间+分布；θ 为校准参数，非本文示例值）；
2. 动作 time-to-effect 内我方不死于任何已观察威胁（`TTD_us.best − timeToEffect ≥ margin`）；
3. 敌方**无高概率即疗/图腾**：offhand 图腾未观察为在场 + 无进食动画 + pop 窗口外（或已计入二次 pop 预算）；
4. 撤退不优于进攻：`escapeP ≤ θ_escape` 或撤退路线 blocked（反例 1/7 的判据）；
5. 无不可接受自伤/友伤（红线 + 盟友半径）；
6. belief confidence ≥ θ_conf。

任一不满足 → 退而比较 PRESS（无 1/6 约束）/TRADE（无 4 约束）/RESET（默认中庸）——**置信度不足时模型自然落向 RESET/REPOSITION 而非两个极端**。

### 11.4 滞回与承诺（防 PRESS↔DISENGAGE 每 tick 抖动）

- **最小承诺** `minCommitMs`（建议校准起点：普通动作 400ms、HEAL 1.6s 不可中断除非 Reflex、KILL_SECURE 单次冲刺 300ms）：承诺期内只有**紧急谓词**（ Reflex 档、belief 剧变如敌突然举盾/新敌人入 reach、自伤红线触发）可打断。
- **效用差滞回**：`switch iff U(new) > U(current) + hysteresisΔ`（Δ 校准起点 0.15）或紧急。
- **target switch penalty**：换目标需新目标效用超现目标 Δ_target（防多敌抖动）。
- **no-progress 降级**：CHASE 300-800ms 无距离收敛 → 降级放弃（`CHASE_ABANDONED`）；连续 2 次动作 STEP_UNACKED → 进 REPOSITION/RESET 并上报 compat observer（服务器拒绝信号）。
- **evidence revision**：belief 更新（pop/治疗/新敌）视为紧急级重裁决。

---

## 12. 低血补刀 vs 撤退：15 个反例逐项分析

> 格式：观察事实 → belief → 候选与裁决 → 置信度与 fallback。数字引用 §3 机制；效用比较为〔推论〕示例，参数须 §19 校准后生效。

**反例 1｜我 4 血，敌大概率 1-3 血，我攻击 ready、在 reach 内**
- 观察：连续确认命中（hurt_animation 数次）按区间扣减后 belief=[1,4]；我 cooldown p≥0.9；距 2.8 格。
- belief：P(≤4HP)≈0.8+；敌攻击刚出手（其 cadence 侧写 ≈625ms 剑）→ 我 TTD ≥625ms。
- 裁决：**KILL_SECURE**。time-to-effect ≈180-260ms（旋转已对准+发包+服务器 tick）<< TTD 625ms，先手项乘数最大；escapeP 低（贴脸距离 2.8 格 < 敌 reach 3.0+追击速度对等，转身=吃背身刀）。U(KILL_SECURE) > U(DISENGAGE) 当且仅当 P(kill)·w_kill > P(death|disengage)·deathCost——4 血贴脸被追死概率高于换命。
- 置信度：belief 新鲜（<250ms）则高。Fallback：**350ms 内未确认命中（无敌帧吞/whiff/格挡）→ 立即 DISENGAGE**（§10 表）。

**反例 2｜我 4 血，敌血量完全未知，敌攻击 ready**
- 观察：无任何确认命中历史；敌持下界剑疾跑逼近。
- belief：[8,20]，confidence 低 → P(一次净伤致死) 低。
- 裁决：**DISENGAGE/TAKE_COVER**（不是 PRESS）。敌 ready → 我 TTD 可低至 1 击（6-9 净伤区间可及 4）；P(kill)≈0.1-0.2 无先手。举盾（0.25s 生效）掩护脱离；地形有掩体优先 TAKE_COVER→HEAL。
- 置信度：高（决策不依赖未知量）。Fallback：路线 blocked → TRADE 仅当 riskBudget=Desperation。

**反例 3｜我 6 血无图腾，敌刚 pop 图腾**
- 观察：status 35 → belief=[1,5]+吸收 4 确定在（5s 窗）→ 有效 [5,9]；45s 再生爬升中；敌 pop 后常见反打/逃生二择。
- belief：敌 survived lethal → 大概率满配（profile→UTILITY_CLIENT）。
- 裁决：**PRESS（带盾）或 CRYSTAL_ATTACK**，不是无条件 KILL_SECURE：吸收+再生吃掉 1 次命中；无图腾的我方 P(death|一次失手) 高（6 血 vs 敌 crit 斧 ~6-19 净伤可即死）。**二次 pop 预算**：敌 offhand 若观察到还有图腾 → 需 2× 净击穿预算，U 大降 → RESET。
- 置信度：pop 事件高置信。Fallback：敌举盾/进食 → 转 RESET_DISTANCE+HEAL 窗口。

**反例 4｜我低血，敌正在逃跑且无反击角度**
- 观察：敌背身+速度 7 m/s 远离、超 reach、无转向。
- belief：威胁瞬时降级；我 4-6 血。
- 裁决：**RESET+HEAL（+RECOVER_DROPS）**，不 CHASE：速度对等追不上（7.127 vs 7.127），追击=延长暴露时间；效用上 P(kill|chase) 随距离衰减、damage window 为 0。仅当敌 belief 低血且**我方远程 ready（弓 0.9s 蓄力）** 时 CHASE 才可能正效用。
- Fallback：敌突然转向（速度向量反转）→ 立即重裁决（假撤退，见反例 14）。

**反例 5｜我高血（18）但 2v1，敌方队友即将到达**
- 观察：tab list/实体出现显示第二敌 30-50 格接近中；我满血满甲。
- belief：TTD 从 ~5s（1v1）压至 ~2.5s（双输出叠加，i-frame 内差值规则使双持剑合流伤害提升有限但击退叠加）。
- 裁决：**先手窗口内 KILL_SECURE/PRESS 现目标，窗口闭合前 DISENGAGE**——不是"血多就打到底"：当 `TTD_us(best) − 敌增援ETA < 本次击杀所需时间` 时 U(PRESS) 翻负。有盟友 → CALL_SUPPORT 并评估换防。
- Fallback：增援提前出现（ETA 估计错误）→ 立即 DISENGAGE（evidence revision 紧急级）。

**反例 6｜我低血，有掩体和治疗窗口**
- 观察：nearestCover 6 格、敌被地形/距离拖延 ≥2s；有金苹果。
- 裁决：**TAKE_COVER → HEAL**：1.6s 投资换 +4 立即吸收 + 再生爬升，TTK/TTD 比翻转幅度全模型最大；敌接近速度下 2s 窗口可判（速度差分）。
- Fallback：HEAL_INTERRUPTED（敌绕后突破预测）→ 举盾 + RESET 重找窗口；HEAL 承诺期内只有 Reflex 可断。

**反例 7｜我低血，撤退路线被堵，继续压制反而可能创造出口**
- 观察：escapeRoutes 全 blocked（墙/崖/水晶阵）；敌 1 名在 reach 边缘。
- belief：escapeP≈0.1 → DISENGAGE 的 w_surv 项崩塌。
- 裁决：**TRADE/PRESS（Desperation 档）**：疾打击退 1.5-2.6 格（§3.3）能物理推开敌人开出口——"边打边撤"在旧代码被 `suppressOffense=true` 一刀禁掉（§2.2），新模型允许 PRESS-with-movement 组合；击退创造的 clearance 反向更新 escapeRoutes。
- Fallback：连续 2 击未确认 → CRYSTAL_ATTACK 若红线允许（自伤<致死 margin）→ 都不行则接受 TRADE 死亡换击杀（deathCost 低档时正效用）。

**反例 8｜我携带关键基地坐标/稀缺物资，死亡成本极高**
- 观察：currentGoal.criticalInventory=true（迁移/运输任务）；baseCoordsExposed 风险。
- 裁决：**Preservation 档全权重**：deathCost↑ 数量级 → 即使 P(enemy低血)=0.8 也可能 DISENGAGE（w_death·deathCost 压倒 w_kill）；exposureCost 使战斗位置远离路线（不把追兵带向基地）；首选 BREAK_LOS+远脱离，不打"顺手"的架。
- Fallback：被迫交战 → 边打边向**远离**基地方向引导（exposureCost 有符号化）。

**反例 9｜多 Bot 中一个低血，队友即将支援**
- 观察：我 4 血；盟友 20 格接近 ETA ~3s；敌 1 名。
- 裁决：**低血者 RESET/TAKE_COVER+CALL_SUPPORT，满血队友 PRESS 接管压力**（换防）：team utility = 集火增益 + 存活人数；单机视角下低血 bot 的 U(DISENGAGE) 因"敌被牵制"上升（敌 TTK 目标切换）。
- Fallback：支援 ETA 失约（盟友受阻事件）→ 低血者按反例 2/7 独立裁决。

**反例 10｜敌方血量低但可能有图腾/金苹果**
- 观察：敌 offhand **观察到图腾在场**（Set Equipment 可见，§4）；或进食动画刚完成。
- belief：击穿预算 = HP + 图腾(1+吸收4) + 金苹果(+8~9) → P(dead by N hits) 需按加层重算；进食 → 区间上扩+absorptionPossible。
- 裁决：不 KILL_SECURE（谓词 3 失败：高概率即疗）；**PRESS+水晶/斧持续削** 或 **RESET 等其消耗品耗尽侧写**（观察其剩余存量不可知——只能靠时间侧写）。敌 offhand 空且无进食 → 谓词 3 恢复。
- Fallback：pop 突然发生（漏观察）→ 按反例 3 重裁决。

**反例 11｜水晶可补刀，但无图腾且自伤区间接近致死**
- 观察：敌 [1,4]；水晶放置位距我 2 格 → 自伤区间 [x, y] 且 y ≥ 我当前 HP-margin。
- 裁决：**红线（硬约束）直接拒绝**当 y 无致死 margin；margin 内（如自伤 ≤ HP−敌一击上界）且 P(kill) 高 → CRYSTAL_ATTACK 可选但权重受 w_dmg 惩罚；无图腾常态下 margin 计算不含图腾保底（§13）。**"可以死≠可以自杀"纪律保留为硬约束，utility 只在 margin 内做次优选择**。
- Fallback：margin 不足 → PACKETMINE 拆其掩体/RESET。

**反例 12｜Ping 升高，attack/position 确认变慢**
- 观察：rttEstimate 从 80ms → 400ms；最近 setback 1 次；**敌 ping 亦可见**（若敌也高 ping → 对称劣势）。
- 裁决：timeToEffect 全体上浮 → 先手项收窄；W_TAP_PRESSURE/CRIT_CHAIN 时序类动作降权（时序依赖 ping），CRYSTAL_ATTACK（AoE、时序宽容）与 TAKE_COVER（不依赖对手时序）升权；uncertaintyPenalty 全局上调。
- Fallback：ping 持续高 + compat 降级 → 按 Round 7 适应状态机自动收缩动作族。

**反例 13｜服务器连续 setback，追击动作可靠性下降**
- 观察：observer 记录 REPEATED_SETBACK → 适应机 RESTRICTED → pacing 收紧。
- 裁决：这**不是战术问题是兼容问题**：CHASE/PRESS 的执行成功率乘数随 setback 率下降；切 zone 控制（水晶封锁区域而非追人）+TAKE_COVER；SERVER 层 Incident（R-COMPAT-1 已有），**绝不归咎 Skill**。
- Fallback：RESTRICTED 持续 → DISENGAGE 到稳定环境（与 §13 server profile 联动）。

**反例 14｜对手假撤退诱导追击**
- 观察：敌后撤但速度向量频繁回瞥/路径朝向"对其有利地形"（洞/crystal spot/狭窄口）；utility 客户常见套路（§5.2）。
- 裁决：CHASE 截断谓词（时间/距离双上限+地形陷阱标记：目标点若为封闭/半封闭结构 → chase utility 乘惩罚）；进窄口前要求 LoS+escapeRoute 评估；敌转向事件=紧急重裁决（反例 4 fallback 同源）。
- 置信度：假撤退识别属 opponent profile 高级项 → P1 先做"截断+地形惩罚"保守版，模式识别列 P2。

**反例 15｜当前正在基地迁移，交战会暴露路线**
- 观察：goal.kind=migration；敌 1 名远距骚扰（弓/远远窥视）。
- 裁决：exposureCost 主导：**DISENGAGE+隐匿路线**优先，即使可赢（击杀也暴露位置——死亡消息广播敌名侧暴露我方活跃区，§3.12）；若敌持续尾随 → 选远离新基地的预设战场（反例 8 同型）。
- Fallback：被迫交战 → CALL_SUPPORT 分流 + 迁移队列暂停（现有 handleDamaged 已取消任务，天然兼容）。

**汇总**：15 例中现有固定闸门做错/次优的：1（4 血必拒战→等死）、3（无图腾=紧急撤退，错失 pop 窗口）、5（血 18 无脑打到被 2v1）、6（HEAL 不在闸门模型里）、7（撤退必 suppressOffense）、8（死亡成本不入模型）、10（图腾/治疗不可见性无概念）、11（红线外无权衡）、12-15（ping/setback/诱敌/暴露完全不在决策面）。新模型全部有明确输入位。

---

## 13. NO_TOTEM 策略与动态风险偏好

### 13.1 NO_TOTEM 是常态

- 现状缺陷：preserve-life（默认）把"无图腾"钉成 emergency 撤退+断线（`retreat-controller.ts:139-145,187`）——anarchy 服无图腾是**常态而非错误**（弹药/图腾供应链不存在）。
- 新模型：图腾缺失只改两处计算——①`P(death|a)` 不含图腾保底（1HP+吸收 4 的存活概率项移除）；②riskBudget 档位下调一档（Aggressive→Balanced 类映射）。**NO_TOTEM 下 PRESS/KILL_SECURE/TRADE/RESET/DISENGAGE 全部仍可选**（§12 反例 1/3/7/11 都是无图腾场景）。
- 保留不变：水晶/锚自伤红线、Reflex 副手补图腾（有则装）、`preserve-life` 语义作为 Preservation 档的别名。

### 13.2 RiskBudget 四档（动态，非固定值）

```ts
type RiskBudgetMode = "AGGRESSIVE" | "BALANCED" | "PRESERVATION" | "DESPERATION";
// 输入: totem(NORMAL 常态) · stance(expendable/aggressive) · inventoryValueBand ·
//       deathRecoveryFeasibility(距离基地/重生点) · allySupportETA · objectiveCriticality ·
//       opponentStrengthBias(gear-assessor+profile) · serverProfile(compat mode) ·
//       recentDeathPenalty · operatorPolicy(gameplay-policy)
```

- **AGGRESSIVE**：w_kill↑、deathCost 折减（anarchy+operator 授权时；对应现 aggressive 立场但不豁免红线）。
- **BALANCED**：默认；anarchy_first 下的常态档（游戏玩法策略是"允许高强度"≠"风险偏好最大"）。
- **PRESERVATION**：criticalInventory/迁移中（反例 8/15）；deathCost 数量级↑。
- **DESPERATION**：escapeP 崩塌+低血（反例 7）→ 唯一允许"TRADE 换命优先于 DISENGAGE"的档；由谓词触发，不允许 operator 常开。
- 档位切换自身也有滞回（≥1s 稳定证据），防随血量抖动。

---

## 14. Crystal / Anchor / PacketMine 在决策体系中的位置

1. **它们是 TacticalAction 的执行器，不是独立决策者**：crystal/anchor-engine 现有"放置评分"保留为**可行性枚举**（红线的最终守卫），但其"是否值得爆"由 T 档 utility 统一裁决（收益=belief 区间伤害期望，成本=自伤区间+暴露+材料+compat 门）。红线仍为硬约束第 2 条（§11.2）。
2. **特征门联动**（Round 7）：EXPLOSIVE_CRYSTAL/RESPAWN_ANCHOR_COMBAT gates 关闭时这三个动作 `hardBlockedBy:"POLICY_GATE"`——UI 上显示"被门禁用"而非"技能失败"。
3. **时序位置**：CRYSTAL_ATTACK 的 time-to-effect（放置+引爆 300-500ms）天然承接"敌 belief 低血但 melee 生效太慢"的场景（反例 12 ping 高时亦优）；ANCHOR_ATTACK 仅非下界 offense（§3.10 维度规则，现有引擎已维度闸）。
4. **PACKETMINE_ACTION** 用于拆对方 surround/hole（Meteor 系对手的标配防御，§5.2）与开射界——utility 里作为 KILL_SECURE 的前置使能动作（拆壳→可打），不是伤害动作。
5. 反制面（对方水晶/锚）已有 CRYSTAL/ANCHOR_THREAT 撤退原因与 SurroundPlanner；新模型中它们转为 belief 的威胁字段 + TAKE_COVER/Surround 的效用输入。

---

## 15. 多 Bot 战斗决策

- **默认 SOLO / PARALLEL_INDEPENDENT**（现有白名单制天然支持）：每个 bot 独立跑 §7 战术核心，零通信依赖。
- **协作仅在 team utility 为正时启用**（建议最小集，P2 实施）：
  1. **focus fire**：多 bot 同目标 → 敌 TTK 按 (n_attackers × 命中率) 缩短，但受敌 i-frame 差值规则约束（双打同敌的合流伤害 <2×，§3.4）→ 收益有界；
  2. **压力接管（换防）**：低血者 RESET、满血者 PRESS（反例 9）——通过 coordinator 现有 pendingStanceSwitches 队列低频传递，不上 R/T 档；
  3. **retreat 传播**：一人 DISENGAGE 不传染；仅当**同一威胁**使多人 belief 的 TTD 崩塌时各自独立会得出相同结论（分布式一致性免通信）；
  4. **不掉进同一诱饵**：独立决策+target switch penalty 天然分散；显式"目标去重"提示作为 P2 可选项（消耗品/路径冲突同理，先靠距离带自然分离）。
- **友伤**：identity UUID 优先已有；新增效用硬约束=盟友半径内禁 CRYSTAL/ANCHOR（红线扩展）；死亡装备回收=RECOVER_DROPS 动作+盟友优先拾取标记（P2）。
- **support latency**：CALL_SUPPORT 的 ETA 估计误差大（秒级）→ 效用上按保守上界计（反例 5/9 的 fallback 均为"支援失约则独立裁决"）。

---

## 16. LLM/Spark 边界

**绝不交给 Spark（时序红线）**：
- per-tick target lock / attack timing / crit 窗口 / W-tap 时序；
- totem 副手紧急换装、crystal 引爆时机、escape 中断；
- action policy 节奏（ServerPolicy/compat 域）；
- 任何 <1s 决策（Spark 往返 ~13s 级 + 模型可更换：战术核心必须是纯确定性代码，**不依赖当前具体模型**——这是能在模型更换/降级下存活的架构要求，与 Round 7 "VL 降级 bigmodel" 教训同源）。

**Spark 可做（P 档/离线）**：
- 战前计划：装备/补给清单、进攻路线择优（GOAP 式准备序列的参数建议）；
- 长期对手模式总结：从 Decision Evidence/Incident 聚类（"该玩家偏好 crystal + 假撤退"）写入 opponentProfile **建议位**（置信度标记，最终由确定性代码采信）；
- Incident 聚类与复盘报告；
- 参数实验建议（§19 shadow：只出 patch/config 提案，经 sandbox→PvP Lab→真实回归→人工门禁，**绝不在战斗中自改**）；
- 基地迁移/多 Bot 高层策略（现有 strategy-review 已是此形态：只能建议 enum 立场）。

现状佐证：coordinator 已无任何 `combat.engage` 触达（§2 审计第 6 条），LLM 仅能建议 stance——边界现状即正确，新架构保持并成文化。

---

## 17. Decision Evidence 与 Incident

### 17.1 Decision Evidence schema（每次动作选择产出，确定性可回放）

```jsonc
{
  "schemaVersion": 1, "atMonotonicMs": 1234567, "stepMs": 100,
  "decision": "KILL_SECURE", "previous": "PRESS", "switched": true,
  "switchReason": "NEW_UTILITY_DELTA",
  "scores": { "KILL_SECURE": 0.81, "PRESS": 0.62, "TRADE": 0.55,
              "RESET_DISTANCE": 0.44, "DISENGAGE": 0.18, "...": "…" },
  "breakdown": { "KILL_SECURE": { "pKill": 0.83, "pDeath": 0.19, "escapeP": 0.22,
                "firstActionAdvantage": 1.0, "uncertaintyPenalty": -0.04 } },
  "inputs": {
    "ourTtdMs": [850, 1200], "actionTimeToEffectMs": [180, 260],
    "enemyHealthBeliefHp": [1, 4], "pEnemyBelow4": 0.81,
    "totemState": "NO_TOTEM", "riskBudget": "BALANCED",
    "confidence": 0.78, "pingMs": 120, "compatMode": "EXPLICIT_UNRESTRICTED"
  },
  "reason": "first-action advantage + retreat route exposed",
  "fallback": "DISENGAGE if hit not confirmed within 350ms",
  "evidenceRefs": ["ev:hit:881", "ev:hurt_anim:882", "belief@6f03825"]
}
```

> 示例数字为**格式演示**（§16 提示词纪律：示例不能变成硬编码默认值）——所有数值运行时由模型输入派生，回放同一 snapshot+profile 必须复现同一 decision。

### 17.2 Incident / FailureCode 补充（现状断层：incidents.ts 零 COMBAT 码）

新增码建议（P0 落地，分类遵循 Round 7 R-COMPAT 规则）：

| 码 | 层 | 语义 |
|---|---|---|
| `COMBAT_ENGAGE_REFUSED` / `COMBAT_PRESS_FAILED` | RUNTIME | 交战/压制失败（非服务器证据） |
| `KILL_SECURE_FAILED` | RUNTIME | 补刀冲刺未确认（fallback 已触发） |
| `DISENGAGE_FAILED` | RUNTIME | 脱离路线失效（blocked/被截） |
| `HEAL_INTERRUPTED` | RUNTIME | 治疗窗口被破 |
| `CHASE_ABANDONED` | — | 追击截断（**信息事件非故障**，不进故障分类） |
| `BELIEF_STALE_INVALIDATED` | WORLD_STATE | belief 超龄导致决策回退 |
| `SUPPORT_UNAVAILABLE` | RUNTIME | 支援失约 |
| 现有 `SERVER_*`/`ACTION_POLICY_*` | SERVER/RUNTIME | 战斗中服务器拒绝**必须**走兼容层码，禁止归咎 Skill（§12 反例 13） |

死亡：`bot_deaths_total` 指标之外，死亡事件应产出带 DecisionEvidence 引用的结构化记录（击杀者/位置/最近决策链）——PvP Lab 指标的数据源。

---

## 18. PvP Lab 实验设计（本轮只设计，不实现）

### 18.1 总纪律

- **裁判真值隔离**：RCON `execute if ...`/数据包侧的精确血量只进**事后评分文件**，绝不进被测 bot 输入；对手 harness 与被测 bot **零共享内部状态**；
- 每局导出 JSONL：每步 DecisionEvidence + 裁判终局（真实双方 HP/时间/结果）；
- 多 seed × 多距离 × 多地形；统计置信区间必报。

### 18.2 P1 — 决策正确性（确定性对手，isolated fixture）

| 维度 | 值 |
|---|---|
| 场景 | §12 的 15 反例逐条脚本化（固定对手走位/攻击脚本） |
| 变量 | 我方真实 HP × 敌方 belief 状态 × 敌方真实 HP（belief 与真值**故意错开**，测校准） |
| 裁判 | RCON 真值仅评分：kill-secure success、failed-kill-secure death、unnecessary retreat |
| 通过线 | 15 反例各自"应选动作"命中率 ≥ 目标值（P0 定 80% 起步，校准后收紧）；零"4 血必撤"回归 |

### 18.3 P2 — 对手行为矩阵（ scripted personas ）

- PERSONA：`NORMAL`（人形走位+间歇攻击）/ `MOBILE`（疾跑跳+W-tap+假撤退脚本）/ `GEARED`（满甲+图腾+金苹果+举盾斧反击）；
- 变量：persona × seed(≥10) × 初始距离(3/8/16) × 地形（平地/掩体/半开放洞口）；
- 我方默认 **NO_TOTEM**（常态优先）；对手可配置 ping 仿真（延迟注入）。
- 事件注入：治疗中断、pop、setback（测试服强拉脚本）。

### 18.4 P3 — 强对抗（对手=完整战斗栈实例）

- 用本项目 combat 栈起一个"对手 bot"（可调 GEARED+MOBILE 叠加，等价强 scripted；**Meteor 类真实客户端不可自动集成，标记为人工基准可选**）；
- 变量：ping/jitter 注入、水晶/锚地形、追踪边界（48 格）churn；
- 禁止：读取对手内部状态（走 wire 层观察）。

### 18.5 P4 — luv.mc6.cn 真实遭遇记录

- 模式：encounter recorder（被动+anarchy 常规生存），绝不主动骚扰真实玩家（OperationalSecurity 边界不变）；
- 真人样本不足时输出 `INSUFFICIENT_SAMPLES`（诚实原则），bot 继续生存备战；
- 记录：SLP/在线、遭遇事件流、DecisionEvidence、compat 信号——只观察学习，不发布。

### 18.6 指标/KPI（§19 校准的目标函数）

| 指标 | 定义 |
|---|---|
| win/survival/death rate | 终局裁判 |
| kill-secure success | KILL_SECURE 决策后 T_kill 内敌死亡比例 |
| **failed kill-secure death rate** | KILL_SECURE 后我方先死比例（**最危险的错误方向**） |
| disengage success | DISENGAGE 后 N 秒内脱离追踪且存活 |
| **unnecessary retreat rate** | DISENGAGE 时敌 belief 实际 HP≤阈值（错失击杀）比例 |
| missed kill opportunity rate | PRESS/RESET 时敌实际 HP ≤ 1 击且 escapeP 高（错失）比例 |
| decision switch frequency | 每秒动作切换数（滞回健康度，过高=抖动） |
| **confidence calibration** | P(kill) 预测 vs 实际的 Brier score + 校准曲线（belief 质量的直接度量） |
| health/resource cost | 每局净 HP/物资损耗 |
| friendly fire / task recovery | 多 Bot 与任务恢复 |

---

## 19. 参数校准与学习边界

- **本轮不产生任何"实测战斗参数"**（DoD #5）；以下为校准**方法**：
  1. **离线回放**：PvP Lab JSONL → 重放 snapshot 流过纯函数评分器 → 网格搜索（~30 参数、有界网格）+ Bayesian 优化（预算封顶）；
  2. **cross-seed / opponent profile split**：train seeds vs holdout seeds；persona 分层评估（防只赢 NORMAL）；
  3. **holdout 场景**：15 反例集永不进训练目标，只做验收；
  4. **校准曲线**：confidence calibration（Brier）单列——belief 坏则一切坏，先修 belief 再调权重；
  5. **FP/FN 分析**：failed-kill-secure death（FN 方向代价高）与 unnecessary retreat（FP 方向）不对称加权；
  6. **canary/rollback**：tactics-profile 走现有配置版本化通道，灰度可秒回滚。
- **学习边界**：未来 Shadow Learner 只产 patch/config 建议，管线 = sandbox 单测 → PvP Lab P1/P2 → 真实 Minecraft 回归 → 人工/规则门禁；**战斗中自改代码/参数一律禁止**。

---

## 20. 实施路线（Backlog）

### P0（下一轮，最高价值）
1. **combat-tactics 纯函数库**：`EnemyBeliefState` 更新器 + `CombatSnapshot` 组装器 + `UtilityTacticalScorer`（18 动作）+ `ActionSelector`（滞回/承诺/紧急中断）+ `DecisionEvidence` —— 全部零依赖纯函数 + 表驱动单测（含 15 反例固化用例）；
2. **兼容层 observer 接线**（bot-runtime 真实信号 → observer → belief/uncertainty）——偿还 Round 7 wiring-pending；
3. **Incident 码**：§17.2 新码 + 分类规则 + failure-classifier 表项；
4. **feature flag 双轨**：旧闸门为兜底路径，T 档循环接战术核心，DecisionEvidence 入事件（有界+redact）；
5. 顺带修复两个生产疑点（§2.9）：`combatReflexProbe` 供给或降级、`entity_status 2`→`hurt_animation` 迁移；
6. T0 回归全绿 + 双 CI。

### P1
1. PvP Lab P1/P2 harness（15 反例脚本 + personas + JSONL 导出 + 裁判隔离）；
2. 校准管线 v1（离线回放 + 网格搜索 + holdout）；
3. 滞回/承诺参数首调；dashboard 战术决策页（DecisionEvidence 展示）；
4. E3 PvP 真实对局（luv，若样本允许）/ F3-F5 回归补跑。

### P2
1. T1/T2 兼容矩阵（Paper/限制插件 fixture）+ 26.x（协议 775/776）实测对齐；
2. 多 Bot 协作最小集（换防/focus-fire 评估/盟友红线）；
3. opponentProfile 模式识别（假撤退/水晶偏好侧写）+ Spark 复盘建议闭环；
4. Shadow Learner 提案管线；E4 多 Bot / E5 长跑 soak（60-120min）。

---

## 21. Remaining Unknowns（如实）

1. **MC 26.1.2（协议 775）相对 1.21.11 的战斗机制差异**：全量 UNKNOWN——mineflayer 对 26.1 的 adapter 完整性需 E2E 实测（README 声称支持，S20）；
2. luv.mc6.cn 是否剥离 equipment data components（影响敌附魔可观察性）——E0 型 SLP/实连探测可测；
3. 锚爆炸精确伤害值/自伤曲线（§3.10 UNVERIFIED）；水晶引爆与攻击冷却交互（§3.9 UNKNOWN）；
4. 图腾重装（offhand swap）在服务器侧的最短时序（影响 Reflex 补装节奏上界）；
5. `entity_status 2` 现役语义在 1.21.11/26.x 的实测确认（文档冲突：S8 表 vs adapter 现值）；
6. Paper/Spigot 对 vanilla 机制的静默修改面（reach/追踪/KNOCKBACK 调整是服务器生态常态）；
7. 敌方"速度向量频繁回瞥"类假撤退特征的可检测性（P2 研究项）；
8. 多版本并存（fixture 1.21.11 vs 目标 26.1.2）下 blast/crit 数值的版本参数化方案；
9. utility 权重初值的冷启动偏置（校准前只能靠人工先验，必须 canary）；
10. Meteor 类真实强客户端作为 P3 对手的可自动化性（当前只能强 scripted 替代）。

---

## 22. 下一轮实施提示词建议

```text
Minecraft Multi-Agent Studio — 战术决策核心 P0（combat-tactics）

基线：origin/main @ <HEAD>；本轮只读审计→实现 P0。
范围：
1. 新增 packages/combat 战术子模块（零依赖纯函数）：EnemyBeliefState 更新器
   （确认命中区间扣减/治疗扩张/pop 重置/时间衰减/信任源；未确认命中绝不扣减）、
   CombatSnapshot、UtilityTacticalScorer（18 TacticalAction，硬约束先于效用：
   ServerPolicy/compat 门+水晶锚红线+Reflex 抢占+STALE_STATE）、
   ActionSelector（最小承诺/效用差滞回/目标切换惩罚/紧急中断）。
   所有参数进版本化 tactics-profile，禁止散落硬编码；示例数字不得成为默认值。
2. DecisionEvidence JSON（schemaVersion/redact/有界）+ 新 FailureCode（§17.2 表）
   + failure-classifier 表项 + 分类测试。
3. bot-runtime 接线：兼容层 observer 真实信号上报（偿还 wiring-pending）；
   受击源迁移到 hurt_animation 包并核实 entity_status 2（26.x 与 1.21.11 双测）；
   combatReflexProbe 生产供给或显式降级。
4. Feature flag 双轨：旧 TargetSelector/RetreatController 为兜底；T 档循环步内调用
   战术核心；flag 默认关闭。
5. 测试：15 反例固化为表驱动用例（docs/research/PVP_SYSTEM_RESEARCH.md §12）；
   belief 更新、效用、滞回、红线、门禁各成测试组；包内测试 ≥80 例。
6. T0 回归全绿（C/D/G/J1L/J2/J3L/F1/F2）+ 双 CI + 零残留。
7. 诚实报告：DONE/PARTIAL/BLOCKED；不提交未实测参数；生产 flag 关闭下行为与
   当前 HEAD 逐字节等价（除 Incident 新码注册）。
边界不变：不碰 OperationalSecurity；对手真值绝不进 bot 输入；Spark 不进 R/T 档。
```

---

## 附录 A：来源文献库（全部 2026-09-02 访问）

### 官方机制（minecraft.wiki）

- S1 Protocol version numbers — https://minecraft.wiki/w/Protocol_version
- S2 Attack cooldown — https://minecraft.wiki/w/Attack_cooldown
- S3 Attack speed / Sword / Axe / Mace / Bow / Crossbow — https://minecraft.wiki/w/Attack_speed , /Sword , /Axe , /Mace , /Bow , /Crossbow
- S4 Critical hit — https://minecraft.wiki/w/Critical_hit
- S5 Sprint-knockback attack — https://minecraft.wiki/w/Sprint-knockback_attack
- S6 Knockback (mechanic)/(enchantment) — https://minecraft.wiki/w/Knockback_(mechanic) , /Knockback
- S7 Damage — https://minecraft.wiki/w/Damage
- S8 Java Edition protocol/Entity_metadata · /Entity_statuses · /Packets — https://minecraft.wiki/w/Java_Edition_protocol/Entity_metadata , /Entity_statuses , /Packets
- S9 Armor — https://minecraft.wiki/w/Armor
- S10 Protection — https://minecraft.wiki/w/Protection
- S11 Shield — https://minecraft.wiki/w/Shield
- S12 Sweep attack — https://minecraft.wiki/w/Sweep_attack
- S13 Golden Apple / Enchanted Golden Apple / Potion / Splash potion / Totem of Undying — https://minecraft.wiki/w/Golden_Apple , /Enchanted_Golden_Apple , /Potion , /Splash_potion , /Totem_of_Undying
- S14 End Crystal — https://minecraft.wiki/w/End_Crystal
- S15 Explosion — https://minecraft.wiki/w/Explosion
- S16 Respawn anchor — https://minecraft.wiki/w/Respawn_anchor
- S17 Attack range / Attribute / Player — https://minecraft.wiki/w/Attack_range , /Attribute , /Player
- S18 Hunger / Sprinting — https://minecraft.wiki/w/Hunger , /Sprinting
- S19 Death — https://minecraft.wiki/w/Death
- S21 Scoreboard — https://minecraft.wiki/w/Scoreboard
- S22 MC-173747（附魔光客户端渲染 bug） — https://bugs.mojang.com/browse/MC-173747

### 协议/生态

- S20 PrismarineJS/mineflayer（README+api.md） — https://github.com/PrismarineJS/mineflayer （MIT）
- S23 PrismarineJS/mineflayer-pvp — https://github.com/PrismarineJS/mineflayer-pvp （MIT）
- S24 PrismarineJS/mineflayer-pathfinder（goals 教程） — https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/examples/tutorial/goalsExplained.md （MIT）
- S25 MineflayerArmorManager / mineflayer-auto-eat / mineflayer-tool — https://github.com/PrismarineJS/MineflayerArmorManager ; https://github.com/linkle69/mineflayer-auto-eat ; https://github.com/PrismarineJS/mineflayer-tool （均 MIT）
- S26 cabaletta/baritone — https://github.com/cabaletta/baritone （**LGPL-3.0 + 例外条款：仅思想**）
- S27 MeteorDevelopment/meteor-client — https://github.com/MeteorDevelopment/meteor-client （**GPL-3.0：仅思想**）
- S28 Wurst-Imperium/Wurst7 — https://github.com/Wurst-Imperium/Wurst7 （GPL-3.0）
- S30 Paper spigot.yml 参考（追踪距离） — https://docs.papermc.io/paper/reference/spigot-configuration/
- S36 MineRL / OpenAI VPT — https://github.com/minerllabs/minerl ; https://github.com/openai/Video-Pre-Training

### 决策算法文献

- S29 Dave Mark, "Building a Better Centaur"（GDC 2015, Infinite Axis Utility System） — https://www.gdcvault.com/play/1021848/ ; https://gameai.com/iaus.php
- S31 Jeff Orkin, GOAP（AI Game Programming Wisdom 2, 2003; GDC 2006 F.E.A.R.） — https://gdcvault.com/play/1013282/Three-States-and-a-Plan
- S32 C. Simpson, "Behavior trees for AI"（Game Developer, 2013） — https://www.gamedeveloper.com/ai/behavior-trees-for-ai-how-they-work
- S34 Kaelbling, Littman & Cassandra, "Planning and acting in partially observable stochastic domains"（AIJ 1998） — https://www.cs.cmu.edu/~ggordon/780-fall07/downloads/kaelbling-planning-acting.pdf
- S35 Browne et al., "A Survey of MCTS Methods"（2012）；Świechowski et al.（2021） — https://ar5iv.labs.arxiv.org/html/2103.04931

### 社区共识（非官方文档，交叉验证）

- S33 W-tap 机理（sprint 重挂加成） — https://www.reddit.com/r/CompetitiveMinecraft/comments/nlog9w/ ; https://gaming.stackexchange.com/questions/396548/ ; https://www.badlion.net/forum/thread/81200 ；原始击退速度 0.4 为社区代码派生（UNVERIFIED）

### 内部资料（仓库内）

- I1 `docs/frogclient-analysis-2026-09-02.md` — FrogClient（AlienV4-Base）反编译机制分析（许可存疑，仅思想）
- I2 `docs/combat-tactics-reference.md` / `docs/codex-prompt-combat-v3.md` — W0-W8 与战术参考（全部已实现）
- I3 `docs/anarchy-charter.md` — 无政府服定位章程（Round 8）

---

*研究轮产物：本文档 + 零生产代码改动。所有 UNKNOWN/UNVERIFIED 项见 §21；下一轮实施建议见 §22。*


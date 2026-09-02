# Iron Farm Research Memo（BASE-AUTO §7.1）

> 状态：研究文档（先于编码）。全部来源 2026-09-03 访问（深度研究代理补充）。
> 基线研究来自 2026-09-02 FARM_BLUEPRINTS.md §3 + 2026-09-03 深度研究。

## 0. 结论（先说答案）

**推荐候选：A（简单恐慌单胞）**，因为 Bot 可独立完成建造和村民运输、坏了能定位到单胞、重启恢复可靠。产量预期 ~250-400 铁/时（社区值，Java 无官方数）——对多 Bot 补给够用，不是理论最高但稳定。

**⚠️ 版本关键发现（2026-09-03 深度研究新增）**：
- **1.21.9+ spawn chunks 完全移除**〔S20〕——luv.mc6.cn（26.1.2 = 协议 775 ≥ 1.21.9）**必须有 Bot/玩家在模拟距离内**（默认 ~10 chunks），否则村民不 tick、铁机停产。
- **Java 版澄清**：wiki 的 "worked recently/75%" 与 1/700/tick 是 **Bedrock-only**；Java 自 1.16 起只有 30s 冷却限制〔S10〕。
- **1.20.5 起 spawn chunks 缩至 3×3**；1.21.9 起彻底移除——所有 spawn-chunk 铁机在 1.21.9+ 失效〔S20〕。
- **Paper 特有风险**：床放在 soul sand/trapdoor 上会破坏村民睡眠→傀儡不刷（Paper issue #7488）；ClearLagg 插件会删掉漏斗前的掉落物〔S21〕。

## 1. 候选比较矩阵

| 维度 | A. 简单恐慌单胞 | B. 无僵尸恐慌变体 | C. 高产堆叠 |
|---|---|---|---|
| 版本 1.21.x | ✅ 1.14 机制未变〔S10〕 | ⚠️ 需验证 gossip 触发替代 | ✅ 同 A 但多胞叠加 |
| 村民数 | 3 | 3+ | 每胞 3 |
| 需敌对实体 | ✅ 僵尸 1（井中） | ❌（gossip 驱动） | 每胞 1 |
| 实体运输难度 | 低（船推/工作站诱骗） | 低 | 中（多村民搬运） |
| 占地 | ~7×7×8 | ~7×7×8 | A×N |
| 红石 | 无 | 无 | 无 |
| 流体风险 | 水（推傀儡）| 水 | 水多路 |
| 首产延迟 | 2 夜（村民睡眠）+ 冷却 30s〔S10〕 | 同 A + gossip 累积更慢 | 同 A |
| 预期产量 | 250-400/hr | ~50-100/hr（慢） | 500-800+/hr |
| 维修难度 | **低**（单胞定位） | 低 | 中（多胞排查） |
| Bot 可独立建 | ✅ | ✅ | ⚠️ 村民运输量×N |
| 外部破坏恢复 | **简单**（单胞重建） | 简单 | 复杂 |
| 来源 | minecraft.wiki Tutorial:Iron golem farming〔S11〕 | wiki gossip 机制〔S10〕 | 社区堆叠设计 |

**选择原则命中**（BASE-AUTO §2.1）：
1. 目标版本真实兼容 ✅（1.14 机制 1.21 未变）
2. 稳定和易维修 ✅（单胞独立，坏了定位准）
3. Bot 可施工 ✅（纯方块+村民+僵尸，无红石）
4. 实体可运输 ✅（3 村民+1 僵尸，船/诱骗可达）
5. 服务器规则兼容 ✅（vanilla/Paper 均可）
6. 资源成本 ✅（~64 圆石+3 床+少量水/岩浆块）
7. 占地合理 ✅（7×7 底面）
8. **实际产量** 250-400/hr——不为理论最高选堆叠版

## 2. 已验证机制事实（2026-09-02 研究确认）

### 生成触发〔S10〕
- 村民恐慌 = 敌对怪 ≤8 格 + 无遮挡视线（保守按 ≤6 格建）→ 每 5s 尝试召唤
- 前提：20min 内睡过（床已认领）
- 冷却：16 格内 30s 无傀儡 + 10 格内 30s 无成功召唤
- 参与者：恐慌者 10 格内 ≥3 人恐慌

### 生成体积〔S10〕
- 恐慌村民 ±8XZ/±6Y 的 17×13×17 box
- 底面需实体顶面；上方 2 格非整块；2 格上方不能有水
- **注意**：傀儡免疫摔落和溺水〔S12〕

### 杀法（关键修正）〔S12〕
- ❌ 摔落杀不可用（免疫）
- ❌ 溺水不可用（免疫）
- ✅ **熔岩刃**（开口栅栏门托岩浆于离地 ~3 格头高处；物品穿过不焚）
- ✅ **岩浆块地板**（物品不被毁）
- ✅ **Bot 近战**（100HP≈10 刃；傀儡不主动攻击不被挑衅者）
- ❌ 仙人掌（会毁物品）

### 村民物流〔S13〕
- 船 + `bot.attack(boatEntity)` 冲撞（mineflayer 可复刻）
- 工作站诱骗：48 格球内村民自动走向最近未认领工作站
- 禁 lead（不支持村民）〔S14〕

### 僵尸持久化〔S14〕
- 丢任意物品使其拾取 → 变 persistent（不 despawn）
- Baby zombie 0.98 高（1×1 井可容）；白天燃烧（需盖顶）

## 3. 结构布局草案〔设计〕

```
俯视（y=6 生成平台层）：
  +———+
  |   | ← 水道环（推傀儡向中心落口）
  | ⊕ | ← 中心 2×2 落口（傀儡掉入杀膛）
  |   | ← 水道环
  +———+
  尺寸：7×7（外框）

侧视（y=0..8）：
  y=0   收集垫（Bot 站位拾取）
  y=1   熔岩刃层（栅栏门+岩浆，离地 3 格）
  y=2-3 落管（傀儡坠落通道）
  y=4   村民格底板（3 个 1×1 格，各含床）
  y=5   村民活动层（村民站立；井=中心 1×1 僵尸坑）
  y=6   生成平台（实体顶面+2 格空气）
  y=7   平台边缘水道（推傀儡入落口）
  y=8   顶盖（防外部生物/掉落物）
```

## 4. 施工阶段（BASE-AUTO §7.5 映射）

| 阶段 | facilityPhase | 内容 |
|---|---|---|
| SITE | — | site.assess（地形/村庄距离/区块） |
| FOUNDATION | foundation | y=0 收集垫+周边 |
| STRUCTURE | structure | 落管/骨架/外壳 |
| VILLAGER CELLS | villager_cells | 3 个 1×1 格+隔墙 |
| BEDS | beds_workstations | 3 张床（双格方块，专门步骤） |
| SPAWN PLATFORM | spawn_platform | y=6 顶面+水道 |
| COLLECTION | water_collection | 水源+引流 |
| KILL SHELL | kill_chamber_shell | 熔岩刃/岩浆块安装（不含岩浆） |
| SEAL/ESCAPE | seal_escape | 顶盖+维修通道 |
| **DANGEROUS** | dangerous_activation | **岩浆放置（最后！）** |
| ENTITY | — | 3 村民运输+1 僵尸部署 |
| COMMISSION | commissioning | 观察窗+产量验证 |

## 5. 实体需求

```json
[
  { "role": "villager", "count": 3, "targetOffset": {"x":-2,"y":5,"z":-2}, "transportTimeoutMs": 120000 },
  { "role": "villager", "count": 1, "targetOffset": {"x":0,"y":5,"z":2}, "transportTimeoutMs": 120000 },
  { "role": "zombie", "count": 1, "targetOffset": {"x":0,"y":5,"z":0}, "transportTimeoutMs": 60000, "requiresPersistence": true }
]
```

## 6. Commissioning 验收标准（BASE-AUTO §7.6）

- 结构 25+ cells server-verified（RCON execute-if-block）
- 3 村民在位（RCON data get entity 确认 UUID/位置）
- 1 僵尸在位（persistent=true）
- 岩浆已激活（dangerous_activation 完成）
- collector baseline（收集垫无铁锭）
- **观察窗口 ≥ 10min**：golem spawn evidence（Bot 视线/服务器日志）
- **铁锭净增 ≥ 3**（RCON data get entity Bot Inventory / 收集垫物品）
- 多窗口（≥2 次）一致性
- 预置铁锭排除（baseline 减法）

## 7. 风险与失败模式

| 风险 | 缓解 |
|---|---|
| 村民未睡（首产延迟） | 等 2 夜；检测村民位置=床 |
| 僵尸白天燃烧 | 井上盖板 |
| 村民被僵尸杀死 | 隔墙+1×1 井宽度 |
| 服务器 mob cap 满傀儡不刷 | 周边照亮/清理 |
| Paper 插件影响 | isolated fixture 先验证 |
| 岩浆意外流出 | dangerous_activation 最后+精确放置 |
| 村民掉出格子 | 格上方封顶 |

## 8. 来源

- S10 Iron Golem — https://minecraft.wiki/w/Iron_Golem
- S11 Tutorial:Iron golem farming — https://minecraft.wiki/w/Tutorial:Iron_golem_farming
- S12 Fall damage + 傀儡免疫 — https://minecraft.wiki/w/Fall_damage ; https://minecraft.fandom.com/wiki/Iron_Golem
- S13 船运村民 — https://www.reddit.com/r/Minecraft/comments/15qwisc/
- S14 Zombie（拾取物品成持久） — https://minecraft.wiki/w/Zombie
- S15 单胞产率社区值 — https://www.reddit.com/r/technicalminecraft/comments/1f39gpr/

## 9. 深度研究新增（2026-09-03）

### 9.1 版本敏感性

| 版本 | 变更 | 影响 |
|---|---|---|
| 1.19 (22w12a) | 生成体积 16→**17×13×17**；间隔 bug 35s | 结构需更大平台 |
| 1.19 (22w19a) | 生成面需**实体顶面+阻挡材质** | 平台方块选择 |
| 1.20.2 (23w31a) | 冷却恢复 **30s** | 产量正常化 |
| 1.20.5 (24w03a) | **spawn chunks 19×19→3×3** | spawn-chunk 铁机失效 |
| 1.21.5 (25w09a) | random ticks 仅在 entity-processing chunks | 红石依赖设施 |
| **1.21.9** | **spawn chunks 完全移除** | **必须有 Bot/玩家在场** |

### 9.2 Java vs Bedrock 澄清

- "worked recently/75% worked" → **Bedrock-only**，Java 1.16 已移除
- 1/700/tick 生成概率 → **Bedrock-only**，Java 用 30s 冷却
- Java golem 生成**不依赖 doMobSpawning**（villager-driven）

### 9.3 模拟距离要求

- 村民必须在 **entity-ticking chunks**（玩家模拟距离内）
- 服务器默认模拟距离 = 10 chunks
- mineflayer bot **算作玩家** → Bot AFK 在村民 10 chunks 内即可
- 1.21.9+ 无 spawn chunks → **Bot 必须永远在场**（多 Bot 轮换 AFK 或接受间歇停产）

### 9.4 村民睡眠精确规则

Java 版（wiki）：村民在**最近 20 分钟内睡过**（床认领+实际睡眠）才能召唤。夜间村民会停止恐慌去睡觉——恐慌农场夜间产量降低（社区共识，UNVERIFIED on wiki）。

### 9.5 Paper/插件特殊风险

| 风险 | 来源 | 缓解 |
|---|---|---|
| 床在 soul sand/trapdoor 上 → 睡眠失败 | Paper issue #7488 | 床底放实心方块 |
| ClearLagg 删掉掉落物 | r/admincraft PSA | 收集器靠近杀膛/水道快速收集 |
| Paper 性能调优降产量 ~20% | r/admincraft | 预期调低 |
| spigot.yml iron-golem-can-spawn-in-air | Paper forum | site.assess 时确认 |

### 9.6 候选 B 补充：无僵尸 gossip 设计

r/technicalminecraft "Alabama Focus Camp"（~2025）：
- 5 gossiping 村民，无僵尸
- ~240 铁/天（≈3.75 组）
- **只在白天运行**（夜间村民睡觉）
- 优点：无僵尸持久化问题
- 缺点：产量最低，夜间停产

### 9.7 推荐选择确认

维持候选 A（简单恐慌单胞）——候选 C（spawn-chunk 4 胞 880+ 铁/时）在 1.21.9+ 不可用（目标 luv.mc6.cn ≥ 1.21.9）。

新来源：
- S20 Spawn chunk — https://minecraft.wiki/w/Spawn_chunk
- S21 Paper issues / ClearLagg — https://github.com/PaperMC/Paper/issues/7488 ; r/admincraft
- S22 Simulation distance — https://minecraft.wiki/w/Simulation_distance
- S23 Alabama Focus Camp — https://www.reddit.com/r/technicalminecraft/comments/1mjgqao/

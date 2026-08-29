# AI Base Architecture — 研究结论与选型（Phase 8）

> 目标：为**自主 Bot 建造**（不是人类审美）选择基地架构。
> 结论先行：默认架构 = **地下轴对齐模块网格**（modular_base_v1），
> starter_base_v1（地表 5×5 小屋）保留为过渡/诱饵结构。

## 1. Research Findings（带来源）

### 1.1 尺寸：5×5 vs 7×7
- 第一晚最小封闭体 ~5×5×3（床+基础工作站够用）；要放下熔炉组+多箱子+工作台需要 7×7 或 9×9（[Bedrock 初学者指南](https://minecraftbedrock.fandom.com/wiki/Tutorials/Beginner%27s_guide)、[minecraft.wiki Shelter types](https://minecraft.wiki/w/Tutorial:Shelter_types)）
- 奇数边长有中心块，门/走廊轴线天然对齐；7×7 在 16×16 chunk 内有余量

### 1.2 无政府服（2b2t 类）的生存共识：地下/隐藏
- 地表建筑会被渲染距离扫描、尾随、破解客户端发现；远离出生点的埋地基地存活最久（[r/2b2t](https://www.reddit.com/r/2b2t/comments/1lgdbe8/griefing_on_small_bases/)、[2b2t Miraheze 指南](https://2b2t.miraheze.org/wiki/Ultimate_Guide_to_2b2t.org)）
- 对 Bot 的推论：starter_base_v1 地表小屋定位改为**临时/诱饵**；modular_base_v1 走地下（挖入式 7×7 房间 + 衬墙），比地表施工更便宜且暴露面更小

### 1.3 模块网格模式
- 公开资料无权威 hub-and-spoke 规范；社区通行做法：中央 hub 房间先行，直线走廊外接统一规格模块（[Quora](https://www.quora.com/What-would-be-the-most-practical-way-to-building-of-a-Minecraft-group-base)、[r/feedthebeast](https://www.reddit.com/r/feedthebeast/comments/ejg4oc/modular_base_design_for_e2e/)）
- 本项目约定（推导，低风险）：**7×7×4 模块、9 格间距（共享 1 格墙）、1 宽 2 高走廊、门居中于共享墙、全轴对齐平顶**（无楼梯/对角线——每个模块都是可逐层放置的矩形棱柱）

### 1.4 材料分级（爆炸抗性数据）
- cobblestone = stone = stone_bricks = 爆炸抗性 6（[Explosion](https://minecraft.wiki/w/Explosion)、[Blast resistance values](https://minecraft.wiki/w/Module:Blast_resistance_values)）
- 石砖需要额外烧炼+合成步骤，抗性零增益 → **Bot 基地跳过石砖**
- dirt 抗性 0.5（苦力怕可炸穿）仅应急；木板抗性 ~3 且可燃 → **modular_base_v1 墙体用 cobblestone 替换木板**
- 材料层级：`cobblestone（首选，石镐无限自采）→ dirt（应急）`；不存在值得的中间档

### 1.5 Mineflayer 建造生态
- mineflayer-builder（PrismarineJS）README 自述 "not a usable package yet"，需平坦世界+创造+op，排序逻辑未文档化（[GitHub](https://github.com/PrismarineJS/mineflayer-builder)）
- mineflayer-schem 可用（`.schem`/`.schematic`，活跃维护）（[libraries.io](https://libraries.io/npm/mineflayer-schem)）
- WorldEdit `.schem` 格式按 Y,Z,X 存储 → 朴素遍历天然先底层；层内顺序自选（推荐**就近优先**减少寻路调用）
- 结论：**自研 BuildPlanner 排序（本项目已有 CLASS_RANK + order 字段方案）优于依赖未成熟生态**；未来导入 schematic 时用 Y-first 遍历

### 1.6 自困避免（folk knowledge，无正式文档）
- 已知失败模式：把方块放进自己占据的空间、下落中放置、四面封死后寻路器死循环（[pathfinder #296](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/296)、[#181](https://github.com/PrismarineJS/mineflayer-pathfinder/issues/181)）
- 可用 Bot 建造者的做法：站在footprint外固定偏移、逐层 outside-in、门洞/屋顶缺口最后封（[procedural house bot](https://www.youtube.com/watch?v=IqK-tSoSXk4)）
- modular_base_v1 硬规则：**(a) 永不在 bot 脚/头位置放置（已在 E2E placeAndVerify 实现拒绝逻辑）(b) 墙先于顶、顶从外圈向内 (c) 门洞保持开放直到 pathfinder 确认 bot 在外 (d) canDig:true 让被围 bot 能挖出去**

### 1.7 熔炉组
- 手动/无漏斗 Bot 自动化：并行熔炉无传输上限；每 smelting module **2 排 × 8 = 16 熔炉**足够（[furnace array 设计](http://burntchrome.blogspot.com/2020/10/super-smelter-and-furnace-array-designs.html)、[r/technicalminecraft](https://www.reddit.com/r/technicalminecraft/comments/ryz4xj/best_amount_of_furnaces_per_minecart/)）
- 布局：熔炉贴墙一排，燃料/输入/输出箱子平行一排间隔 1 格（Bot 两排都够得着，零漏斗成本）——与 FacilityRegistry 的 smelting_line/wall_grid pattern 吻合

### 1.8 多智能体建造（学术）
- CraftUtopia（LLM 多智能体协作建造，[ACM](https://dl.acm.org/doi/10.65109/PUIJ7087)）；TeamCraft 基准 55k 任务变体（[arXiv 2412.05255](https://arxiv.org/html/2412.05255v1)）；VillagerAgent 图组织空间/因果/时序依赖（[ACL 2024](https://aclanthology.org/2024.findings-acl.964.pdf)）；MINDCraft/MineCollab（NeurIPS 2025）
- 共识坑：agent 互相挡放置、抢同一方块；**按角色/层分工（A 地板、B 墙、C 顶）优于按体积分割**——与本项目 BaseRegistry 的 cell 级预约 + class-rank 顺序吻合

**如实声明的空白**：走廊宽度无公开规范；"schemaginator" 不存在（搜索零结果）；mineflayer-builder 排序需读源码；自困避免是民间经验非正式文档。

## 2. AI Buildability Score（二十节）

对候选架构按 20 维打分（0-2：0 差 / 1 中 / 2 好）：

| 维度 | 地表 5×5 小屋 (starter_base_v1) | 地下 7×7 模块网格 (modular_base_v1) | 精美多层别墅 |
|---|---|---|---|
| 方块数 | 2（85） | 1（~180/模块） | 0（2000+） |
| 前期材料成本 | 2（圆石+木板） | 2（纯圆石，挖入省料） | 0 |
| 方向性方块复杂度 | 2（仅门洞缺口） | 2（无楼梯台阶） | 0（大量楼梯/台阶） |
| 脚手架需求 | 2（顶 5×5 外圈向内） | 2（平顶同样外圈向内） | 0 |
| 场地平整成本 | 1 | 2（挖入式，无需找平） | 0 |
| 自困风险 | 1 | 2（房间大、门多） | 0 |
| 寻路兼容 | 2 | 2 | 0 |
| 验证复杂度 | 2（轴对齐矩形棱柱） | 2 | 1 |
| 维修复杂度 | 2 | 2 | 0 |
| 模块化 | 0 | 2 | 0 |
| 扩建 | 0 | 2（共享墙+预留连接口） | 0 |
| 多 Bot 并行施工 | 1 | 2（按模块/层分工） | 0 |
| 设施集成 | 1 | 2（每模块=一个 Facility zone） | 0 |
| 导航简单性 | 2 | 2（直线走廊） | 0 |
| 地形适应 | 1 | 2 | 0 |
| 版本兼容 | 2 | 2 | 1 |
| 施工恢复 | 2 | 2 | 0 |
| 防爆/防火 | 1（木板墙） | 2（全石） | 1 |
| 隐蔽性（无政府服） | 0 | 2（地下） | 0 |
| 升级路径 | 1 | 2（v1→v2 换 blueprintId） | 0 |
| **合计（40 满）** | **25** | **37** | **5** |

## 3. 默认架构选择：地下轴对齐模块网格（modular_base_v1）

**选择理由**（buildability 37/40，隐蔽性满分的唯一候选）：
1. 挖入式地下施工省去找平与材料（挖出来的圆石直接回砌墙）
2. 全石结构防火防爆，替换 starter_base_v1 的木板墙缺陷
3. 模块=Facility zone 一一映射（smelting/crafting/storage 模块），CapacityPlanner 在模块内 scale-out（2→4→8 熔炉），BasePlanner 决定加新模块——职责分离与现有 Registry 架构同构
4. 共享墙 + 预留连接口让扩建无需重建
5. 无政府服隐蔽性：地表无渲染距离可扫的目标

**starter_base_v1 定位修订**：第一夜过渡 + 诱饵结构（真实价值：把扫描者从地下基地引开）。保留现有 85 格蓝图不动（向后兼容），modular_base_v1 作为新主架构（v2 蓝图，versioned）。

## 4. 与现有实现的映射

| 研究结论 | 现有实现 |
|---|---|
| Y-first 放置 | `orderBlueprintCells` CLASS_RANK + order 字段 |
| 就近优先 | BuildPlanner 排序待实现（Phase 11 剩余） |
| 永不放置于自身 | E2E `placeAndVerify` 拒绝逻辑（已真机验证） |
| 顶外圈向内 | starter_base_v1 roof ring order 300+ |
| 熔炉 2×8 墙 | `smeltingWallGridPattern(4, 2)` 已有，扩到 (8, 2) |
| 按层分工多 Bot | `BaseRegistry.reserveCell` TTL 预约（已测） |
| 版本化蓝图 | `blueprintId` + `blueprintVersion`（BaseRecord 已有） |

研究方法：web 检索（Minecraft Wiki、Reddit r/2b2t、PrismarineJS GitHub、ACM/arXiv/ACL 论文）+ 架构对比评分。检索由子代理完成，来源逐条标注；无可靠公开材料的条目已如实标注空白。

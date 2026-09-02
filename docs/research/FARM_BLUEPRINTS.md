# 基地自动农场体系研究（Blueprints & Feasibility）

> Research Round 产物（2026-09-03）。所有机制事实带 minecraft.wiki 来源（S*，附录 A）；
> 布局建议标注〔设计〕。目标：bot 自建基地 + 四类自动农场（食物/建材/铁/火药）。
> 已随附实现：蓝图文件 DSL（apps/coordinator/blueprints/ + deterministic goal 模板）与首个蓝图
> `cobble-generator`（固体部分）。

## 0. 结论矩阵（bot 可建性）

| 农场 | 机制风险 | 建造（现有能力） | 运营（缺口） | 产量预期 | 判定 |
|---|---|---|---|---|---|
| 胡萝卜田 9×9 | 低（机制稳定） | ✅ 无需蓝图结构（锄+种即可；围栏/火把可选） | ❌ 锄地/播种/收成三能力未实现 | 80 块田，~31min/轮〔S2〕 | 结构 READY，运营能力 P1 |
| 刷石机（5 槽） | 低（1.21.x 无变更〔S9〕） | ✅ 蓝图已发（25 格固体）+ collect.block 挖掘 | ⚠️ 流体注入需桶能力（生产）/RCON（测试） | 铁镐 0.5s/块，即时再生〔S8,S9〕 | **本轮 E2E 目标** |
| 刷铁机（3 村民恐慌单胞） | 中（村民物流+20min 睡眠规则） | ⚠️ 结构蓝图可发（~60 格），床=双格块需专门步骤 | ❌ 村民搬运（船+冲撞〔S13〕/工作站诱骗 48 格〔S4〕）、命名僵尸、流体 | ~250-400 铁/时〔S15〕社区值 | 结构 P1，物流 P2 |
| 火药塔（无猫变体） | 中（产率未知） | ⚠️ 大结构（暗室+水道+24+ 格落差） | ⚠️ 活板门顶滤精度、AFK 24-128 格窗口 | 无猫版未量化（带猫 ~700/时〔S17〕） | 设计 P2 |

## 1. 食物：胡萝卜 9×9 田〔设计〕

**为什么是胡萝卜不是小麦**：生吃 3 饥饿（免合成/免熔炼），收获 2-5 倍自我繁殖（无种子概念），80 块田自扩张〔S5,S6〕。小麦链（3 麦→1 面包）在 bot 场景多两步工艺。

- **布局**：9×9 耕地，中心 1 格水源（Chebyshev ≤4 恰好全覆盖，80 格可耕）〔S1,S2〕；可选 11×11 栅栏环（40 格，防踩踏/兽害）；每 ~8 格一支火把（夜间生长需光照 ≥9 于作物格）〔S2〕。
- **同作物拥挤**：对角同行同作 → 生长速度减半；接受（80 格满种 ~33min/轮）或隔行种植〔S2〕。
- **运营循环（新能力）**：锄（dirt/grass→farmland，1 耐久）→ 右键种 → 轮询 blockstate `age`（**客户端可见**，mineflayer getProperties，S7）→ `age=7` 破坏收成 → 补种。踩踏仅来自跳跃坠落（bot 不跳即无险）〔S1〕。
- **干田可用**：无水也可种（速度约半：干 7.69-14.29% vs 湿 14.29-33.33%/随机刻）——首块农场可零水起步，水源后补（需桶能力）〔S1,S2〕。

## 2. 建材：5 槽刷石机〔已发蓝图〕

- **规则**（S8,S9）：水流+岩浆**流**→圆石；水碰岩浆**源**→黑曜石（毁机禁忌）；岩浆盖水上方→石。下界不可用（无水）。挖掘：硬度 2.0，木镐即可、铁镐 0.5s；破坏后流体重新接触**立即再生**。
- **布局**（见 `blueprints/cobble-generator.json`，锚点=缺口正下方实体格）：
  - y=0：5×1 地板（x=-2..2）+ z=±1 侧墙 ×5；y=1：z=±1 侧墙 ×5（挡 y=1 流体外溢）
  - 流体（非蓝图）：岩浆源 (-2,1,0)、水源 (+2,1,0)；缺口 (0,1,0) 生成圆石
  - 站位：批 1 (-1,1,2) / 批 2 (+1,1,2)；bot 于 (0,1,2) 面向缺口连挖
- **安全**（S9）：水源侧加台阶防漫至岩浆源；岩浆口盖不可燃块防掉落物焚毁。

## 3. 铁材：3 村民恐慌单胞刷铁机〔设计〕

- **生成规则**（S10,S11）：村民恐慌（敌对怪 ≤8 格 + 视线，**保守按 ≤6**）时每 5s 尝试召唤；需 20min 内睡过（床已认领可达）；16 格内 30s 无铁傀儡 + 10 格内 30s 无成功召唤；≥3 村民在恐慌者 10 格内。生成体积=恐慌村民 ±8XZ/±6Y 的 17×13×17，顶面向上 2 格非整块。
- **关键修正**：**铁傀儡免疫摔落与溺水**〔S12〕——跌落杀不可用。杀法=熔岩刃（开口栅栏门托岩浆于离地 ~3 格头高处，物品穿过不焚）或岩浆块地板，或 bot 近战（傀儡 ~2.7 高、100HP≈10 刃；不主动攻击不被挑衅者）。**仙人掌会毁物品，禁用**。
- **布局**〔设计〕：y+3 生成平台（实体顶面+2 格空气）→ 边缘水道推傀儡入 2×2 落口 → 落管底=熔岩刃/岩浆块层，物品穿缝落 y0 收集垫（bot 站垫上拾取）；y0=3 个 1×1 村民格（各含床）环 1×1 僵尸井（视线通）。
- **物流缺口**：床=双格方块（蓝图外专门步骤）；村民搬运=船+bot.attack 冲撞〔S13〕或工作站 48 格诱骗〔S4〕；僵尸防消失=丢任意物品使其拾取成持久〔S14〕；**首产需等村民睡过两夜**。
- **产量**：社区单胞 ~250-400 铁/时〔S15〕（wiki 无 Java 官方数，标 UNKNOWN）。

## 4. 火药：无猫暗室火药塔〔设计〕

- **苦力怕事实**（S16,S17）：1.7 高/0.6 宽，方块光 0 生成；2 格顶+底活板门=净空 1.8125——**苦力怕可生成、僵尸(1.95)/骷髅不可**（Java 专属机制）；怕猫（保持 6 格）。0-2 火药/只。**摔落 >16 格未死的苦力怕落地 5tick 后爆炸**——落差必须 ≥24 格致死（20HP→23.5 实用值）〔S12〕。
- **布局**〔设计〕：高空/海上暗室平台（提升刷怪率）→ 顶=方块+活板门过滤层 → 地板水道环扫汇入中央落井（蜘蛛以 3×3 破除+毯子占位排除）→ ≥24 格垂直落杀（**熔岩会焚毁火药，杀法=摔落/营火**〔S17〕）→ 落点收集垫（bot 站 24-128 格 AFK 窗口内、垫旁拾取）〔S18〕。
- **猫增强可选**：村庄 5 床 48 格内每分钟刷新流浪猫，生鱼 1/3 驯服〔S19〕；船中猫仍具驱赶力（官方教程设计）→ 带 ~700/时 vs 无猫未量化〔S17〕。

## 5. 能力缺口与实施顺序

| 缺口 | 阻塞 | 建议轮次 |
|---|---|---|
| **fluid.place**（水/岩浆桶使用放置） | 刷石机/铁机水道/农田水源 | P0（实现前 E2E 用 RCON 引导并如实标注） |
| farm.till / farm.plant / farm.harvest（锄/种/收+age 轮询） | 食物自动化 | P0-P1 |
| 床放置（双格块专门步骤） | 铁机村民睡眠 | P1 |
| 村民物流（船冲撞/工作站诱骗）+ 僵尸持久化 | 铁机运营 | P2 |
| 活板门/多点流体精度 | 火药塔 | P2 |
| 批间自动移动交错（coordinator 多步派发） | 大结构一次 goal 建完 | P1（当前=显式 move+build 编排） |

## 附录 A：来源（全部 2026-09-03 访问）

- S1 Farmland — https://minecraft.wiki/w/Farmland
- S2 Wheat Crops / Tutorials/Crop farming — https://minecraft.wiki/w/Wheat_Crops ; https://minecraft.wiki/w/Tutorials/Crop_farming
- S5 Carrot / S6 Potato / S4 Villager — https://minecraft.wiki/w/Carrot ; /Potato ; /Villager
- S7 prismarine-block（getProperties/age 可读）— https://github.com/PrismarineJS/prismarine-block
- S8 Cobblestone — https://minecraft.wiki/w/Cobblestone
- S9 Tutorials/Cobblestone farming — https://minecraft.wiki/w/Tutorials/Cobblestone_farming
- S10 Iron Golem — https://minecraft.wiki/w/Iron_Golem
- S11 Tutorial:Iron golem farming — https://minecraft.wiki/w/Tutorial:Iron_golem_farming
- S12 Fall damage（傀儡免疫/苦力怕摔爆） — https://minecraft.wiki/w/Fall_damage ; https://minecraft.fandom.com/wiki/Iron_Golem
- S13 船运村民（bot.attack 可复刻冲撞） — https://www.reddit.com/r/Minecraft/comments/15qwisc/ ; mineflayer docs
- S14 Zombie（拾取物品成持久） — https://minecraft.wiki/w/Zombie
- S15 单胞产率社区值 — https://www.reddit.com/r/technicalminecraft/comments/1f39gpr/
- S16 Creeper — https://minecraft.wiki/w/Creeper
- S17 Tutorial:Creeper farming（活板门滤/营火/带猫产率） — https://minecraft.wiki/w/Tutorial:Creeper_farming
- S18 Mob spawning（24/128 规则、mob cap 70） — https://minecraft.wiki/w/Mob_spawning
- S19 Cat — https://minecraft.wiki/w/Cat
- S20 Basalt（下界替代建材） — https://minecraft.wiki/w/Basalt

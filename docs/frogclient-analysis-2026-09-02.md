# FrogClient（Alien 基底）参考分析 · 2026-09-02

> **本文件是"机制/思路描述"，不是代码。** 依据 AGENTS.md §0.6 的纪律，且本文分析对象为 **CFR 0.152 反编译产物**（非原生源码、许可存疑）：以下所有内容只描述公开可观察的游戏机制与通用算法思路（idea），供本项目确定性 TypeScript 层**自研重写**。**严禁**将任何反编译片段逐行翻译或复制进本项目。分析时引用的反编译 bug 也如实标注，避免照抄错误。

---

## 1. 对象与仓库事实

| 项 | 事实 |
|---|---|
| 对象 | IDhammaI/FrogClient（描述 "AlienV4-Base"），Fabric 1.21.1 crystal PvP utility client |
| 状态 | 本体与 Releases 页已 **404**（删除/转私有），下载地址失效 |
| 存活副本 | 镜像 `awds14592478/FrogClient`（16 star，2026-02 建，无 release） |
| 规模 | ~130 模块（7 类）、441 Java 文件、55+ 种事件，集成 Baritone + nether-pathfinder + sodium mixin |
| 源码形态 | 全部文件头 `Decomiled with CFR 0.152`——**反编译产物**，变量语义丢失、偶有反编译错误 |
| 本地克隆 | `C:\Users\renna\AppData\Local\Temp\FrogClient`（临时目录，可能被清；需要时从镜像重克隆） |
| 混淆提醒 | frogclient.com 是无关的波兰极简客户端，勿混淆 |

**项目定位对齐**：本项目（无规则服 bot，对决无规则玩家/外挂用户）与该客户端的对抗场景同构——对手也是 utility client 用户。因此其 combat/exploit 侧与 rotation 侧**都是正当参考面**；差异在形态：它是客户端 mod（握有本地物理/渲染全权），本项目 bot 走 Mineflayer 协议端，客户端物理侧逻辑只能**翻译成包级逻辑**实现。

## 2. 核心可借鉴：RotationManager 防漂移（对应 RotationController，战术级 T 档）

背景：本项目曾因 yaw/pitch strict 漂移（10 技能 state schema 死代码）付出整轮返工。该客户端的旋转子系统是同类问题的成熟解法，四个要点：

1. **唯一真值 = 出站包**。`lastYaw/lastPitch` 不记本地期望值，而是在出站包拦截处（`PlayerMoveC2SPacket.changesLook()`）截获更新；每一步旋转插值的基准永远是"上一次实际发出的包"。
   **漂移根源**就是拿本地状态当基准——Mineflayer 端等价做法：记录每个 look 包实际发出的 yaw/pitch，作为下一次插值的起点，而不是用本地缓存的目标值。
2. **每 tick 步长钳制**：yaw 每 tick ≤ `180° × steps`（默认 steps=0.6 → 108°/tick），pitch ±45°/tick；`wrapDegrees` 处理 ±180° 环绕（跨南北轴时 179°→-179° 不可直接做差）。这是过 Grim 类 strict 校验的关键参数形态。
3. **拟人抖动**：基于实体 age 的周期正弦偏移（±3° 量级）叠加随机噪声（yaw ±1° / pitch ±0.6° 量级）。
4. **snapBack**：交互（放块/攻击）前才 snap 到目标朝向，交互后立即恢复（Force=立刻补发全量移动包 / Tick=下一 tick 恢复两档）——服务器视角只是"一瞥"而非长期凝视。

**视角/移动解耦（movementSync）**：物理计算事件 pre 阶段临时把玩家 yaw/pitch 替换为服务器视角、post 阶段还原（跳跃方向、烟花推进用服务器视角算）；同时把移动输入按 (客户端yaw − 服务器yaw) 做三角旋转补偿，实现"朝 B 看但朝 A 走"。Mineflayer 中移动与视角同样耦合，解耦需同型补偿（协议端只能作用于我们发出的包序列，无法作用客户端物理）。

**架构结论（本项目落地形态）**：旋转策略收敛为**全局单例 RotationService + 集中式 profile**——该客户端把 steps/LookTime/random/serverSide/snapBack/grimRotation/movementSync 等旋钮全部集中在一个 AntiCheat 配置模块里全局调档，技能只调 `lookAt(vec)`。对应到本项目：各 skill 只声明 look 目标，旋转实现与拟人参数是 runtime 级单服务——10 技能各自带旋转逻辑、各自爆雷的教训。

> ⚠️ 反编译错误示例：其 `injectStep` 的 Vec3d 重载里 `yawDelta > 180 时 -=180` 一眼是错的（wrapDegrees 已保证 |delta|≤180，再减必错）。照抄前必须自行推导。

## 3. combat / exploit 参考面（无规则服对抗主战场）

| FrogClient 概念 | 机制要点 | 本项目落点 |
|---|---|---|
| AutoCrystal / Breaker / CevBreaker | 水晶放置/破坏决策循环（爆炸伤害自评、放置点枚举、破坏时序） | CrystalEngine（反射级 R 档，§0 时序表已有槽位） |
| AntiCheat·Predict 页 + PredictUtil | 目标运动预判：predictTicks（0-10 tick）、simulation 步数、maxMotionY 钳制、含跳跃/上步分支开关 | PredictionEngine（战术级；参数形态可参考，实现自研） |
| HoleManager / HoleSnap | 安全洞（岩床/黑曜石 1×1）地形缓存与吸附 | 共享世界记忆（按 serverProfileId 隔离，§13 硬规则） |
| Velocity | 击退包接受/部分接受/拒绝的比例控制 | 战斗反射层的击退策略开关 |
| TimerManager / ServerManager | TPS 估算与 tick 对齐 | bot-runtime 时基（monotonic 已有，补 TPS 通道） |
| Baritone + nether-pathfinder + 自研 A* | 地表/地狱双寻路 | 已有 mineflayer-pathfinder，地狱侧为已知缺口 |
| Aura / Offhand / AutoTotem 同类 | 目标选择→副手/图腾轮换 | TotemManager（反射级，图腾补位 ≤1 tick 是硬约束） |

## 4. 架构模式（工程层可借）

- **事件总线**：`@EventListener` 注解 + 优先级（-999~999 插入排序）+ 可取消事件短路；**pre/post 两阶段事件**（移动包发送前/后、Travel 物理前后）+ **PacketEvent Sent/Receive 分离**——"在移动包发出的瞬间改写 yaw/pitch"正靠 pre 拦截。本项目 eventWindow 是记录层，此为同步分发层，互补；若 bot-runtime 引入 tick 流水线可按此粒度设计。
- **模块生命周期**：模块 enable 时订阅事件总线、disable 时退订——关闭即停止收事件，天然防僵尸监听（对应 skill 生命周期）。
- **类型化 Setting**：Boolean/Slider(min,max,step,suffix)/Enum/Bind，每个带 visibility 谓词实现条件显隐与分页——skill 配置形态可直接套用。
- **Manager 单一职责**：16 个 manager（Rotation/Break/Timer/Server/Hole/Thread/Config…）是把散落逻辑收敛为全局服务的清单式参考。
- **sendSequencedPacket**：1.19+ block change sequence 的封装——服务器端防 desync，Mineflayer 端有对应物（block update acknowledgement）。

## 5. 不可取 / 警示

- Module 基类（397 行）塞 9 种 toggle 消息风格 switch——UI 花活混进核心类。
- 依赖 jar 直接进 `lib/` 目录用 flatDir——供应链坏实践，本项目不采纳。
- 反编译可读性差、语义丢失；**许可存疑，只借思想不搬实现**（比 Meteor 等 MIT 项目更严格一等）。
- 客户端物理侧代码（Travel 事件视角替换等）协议端无法直接对应，只能借逻辑意图。

## 6. 结论

对该客户端的参考价值排序：**RotationManager 防漂移设计 > 集中式拟人 profile 架构 > combat/exploit 机制参数形态 > 事件总线与模块生命周期工程模式**。修 yaw/pitch strict 漂移、或上 RotationController/PredictionEngine 实现时，以本文 §2/§3 为起点，按 §0.6 纪律自研重写。

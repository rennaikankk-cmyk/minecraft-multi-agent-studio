# SPAWN ESCAPE 规格（立项 2026-09-03，operator 需求全集）

> 背景：G1 luv 实弹 + 法证（docs/G1_LUV_FIELD.md）——出生点是结构性击杀区
> （竖井坠落 4.5=7.5 格 + 井底怪坑），认证后物理放开即坠落。
> operator 定调：**裸装逃离而不是与怪物交战；边逃边找安全地点；躲避弓箭
> 和苦力怕；不仅出生点，基地被毁/存档点（床）被毁直接回出生点的情况都要覆盖。**

## 定位

runtime 级确定性反射（不经 planner/LLM），与 L0 安全层同层叠放：
L0 仍是最高层（crit → 断线保号不变）；escape 在其下、普通任务之上。

## v0（已交付，本 commit）

1. **第一 tick 疾跑逃逸**（mineflayer-client `trySpawnEscape`）：
   anarchy 导航档 spawn 事件即沿预设方位（默认 135°东南）疾跑 96 格；
   env 旋钮 STUDIO_SPAWN_ESCAPE=0/_DISTANCE/_BEARING_DEG。
2. **重触发语义**：以"首个出生点 64 格邻近"判定而非一次性标志——
   床毁重生/出生拉回循环都会再逃；跨维度/远点 spawn 不误触。
3. **裸装不接战**（combat）：CombatThreat 增加 entityKind；
   RetreatController 新增 MOB_PACK_AVOIDABLE——纯 mob（无玩家参与）
   威胁 + preserve-life → **零血量门槛立即撤**（anarchy policy 默认开，
   保守 profile 默认关）。混入玩家威胁则不走此零门槛（玩家另一量级）。
4. 寻路不可用兜底：疾跑直向 5s。

## v1 待实现（operator 需求，按优先级）

### V1-1 边逃边寻找安全地点（动态寻位）
- 逃跑不是固定方位直线：每 3-5s 重估——对 8 方向采样
  （敌对实体密度[threat-analyzer 复用]、地形可走性[chunk census 消费]、
  距出生点距离增益），选当前最优方向修正 GoalXZ。
- 停止条件：距出生点 > 500 格 ∧ 近旁 32 格无敌对 ∧ （夜间则挖掘掩体
  [shelter.dig 反射化] 或 继续）。
- 与 RECON_PATROL 触发模型的 patrol 让位语义天然一致（生存 > 一切）。

### V1-2 躲避弓箭（投射物预测横移）
- 监听 entitySpawn（arrow/trident）+ 位置差分得速度向量；
  预测线经过自身 2 格内 → 垂直于弹道横移 3-4 格（strafe）。
- 确定性几何计算（无模型）；每箭至多一次横移（防抖）。
- 参考：FrogClient 的 projectile 预测思想（clean-room，GPL 纪律）。

### V1-3 躲避苦力怕（引信半径撤离）
- 监听 creeper 实体 swell 状态（metadata）或距离 < 6 格即视为引信中；
- 反应：沿背离方向疾跑 ≥ 8 格（爆炸半径 3-5 + 冲量）；
- 与 V1-1 联动：creepers 计入方向采样的敌对密度（权重高于近战怪）。

### V1-4 重生场景闭环（与死亡恢复链合流）
- 死亡事件 → 判定重生点：无床/床被毁 → 世界出生点 → escape 重触发
  （v0 的邻近判定已覆盖，此条补**检测**：bed destroyed 事件/重生后
  位置与 lastDeath 点比对）。
- DeathRecovery 交互：裸装（无装备可捡）→ 跳过掉落回收直接逃；
  有装备 → 先评估（现有 assessDropRecovery），回收与逃生冲突时逃生优先。

## 验收（fixture 可复现）

- 井形出生点 + 井底刷怪笼 + 发射器周期射箭 + 苦力怕释放：
  v0 = 逃离 96 格且零交战；v1 = 逃离途中零中箭、零苦力怕近身、
  终点满足停止条件三联。
- 床毁模拟：rcon 清床 → 杀 bot → 重生回出生点 → 自动再逃。

## 边界

- 只动 bot 自身移动/朝向，不放置方块（v1 掩体场景除外，走 shelter 反射）；
- 不与 L0 竞争：L0 EMERGENCY_STOP 依然压顶；
- 非 anarchy profile 默认全关（保守服不动）。

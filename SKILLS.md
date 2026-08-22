# 确定性技能目录

本目录只记录已经注册且存在真实 Runtime 适配器的技能。测试夹具和规划中的能力不列为可用技能。

## 状态标记

每个技能标一档成熟度。**标记不是手写的结论，而是从证据位推导出来的**——判定逻辑与证据位都在
`packages/skills/src/skill-status.ts`，本文件只是它的展示面。没有 `status: "Stable"` 这样可写的字段：
要升档只能去把对应的闸门真的跑绿。

| 标记 | 含义 |
|---|---|
| **Stable** | 四道闸全绿：离线单测 + 运行时接线 + 真实隔离服六类场景 + 跨版本矩阵 |
| **Partial** | 代码接通且离线可判定，但真实服/跨版本还没有结果 |
| **Experimental** | 只有离线单测，运行时能力尚未接线 |
| **Broken** | 有已知缺陷。已知缺陷压倒任何数量的绿灯 |
| **Untested** | 连离线单测都没有——不知道它能不能用 |

四道闸依次是 `offline-tests` → `runtime-wiring` → `isolated-server-scenarios` → `cross-version-matrix`
（与 `docs/skill-verification-runbook.md` 的分级一致）。每条"待完成"由缺失的闸门派生，不手写。

三条纪律由测试保证（`packages/skills/tests/skill-status.test.ts`）：

- 证据目录与注册表**逐个对齐**。代码里有、证据表里没有的技能会在装载期抛错，
  不会默认显示成绿的；反之多出一个不存在的技能 id 也过不了测试。
- 自相矛盾的证据组合**拒绝装载**，例如"真实服跑过但运行时没接线"。
- 只有四道闸全绿才允许对外称"已验证"（`evidenceSupportsVerifiedClaim`）。

当前七个原有技能为 **Partial**，缺 `isolated-server-scenarios` 与 `cross-version-matrix`
两道闸；新增的两个 combat 技能为 **Experimental**，尚缺运行时接线以及这两道真实环境闸门。
真实隔离服六类场景与 1.21.8 跨版本矩阵一次没跑过。这与编译产物里的
`verification=unverified` 是同一个事实的两种表述（AGENTS.md §8：无隔离测试服时不得声称联机测试通过）。

## 跨版本兼容契约

- Skill ID 后的 SemVer 表示技能输入、输出和行为契约，不表示 Minecraft 服务器版本。
- 每个 Skill 另有有序 `compatibility.variants`。Runtime 只使用连接后真实协商出的版本/协议，以及当前 registry 的 feature、物品、方块、实体和显式服务端能力探针解析变体；不以 `minVersion/maxVersion` 一刀切。
- 当前目录中的九个 Skill 都声明无额外资源要求的 `portable` 变体；combat 技能还需要确定性 Runtime driver 接线。其余技能在当前 Mineflayer 适配器能够连接的版本上保持可用。跨版本真实场景矩阵尚未执行，所以目录上报 `availability=available`、`verification=unverified`，不冒充实机已验证。
- 新版本特色 Skill 必须声明它实际依赖的 feature/资源；如果还依赖服务器插件、数据包或规则，则必须等待显式探针。能力为 `unknown` 时 fail-closed，不从版本号猜测。
- `collect.block`、`craft.item`、`world.place-block` 和 `container.transfer` 当前仍接收目标版本 registry 的原生资源名。兼容变体可以表达旧/新 ID 的替代顺序，但规划器使用的语义资源别名尚未接入。

## `movement.goto@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`bot.move`
- 风险：R1
- 适配器操作：`pathfinder.goto-safe`
- 超时：20 秒
- 自动重试：无（移动是非幂等操作）
- 并发：每个 Bot 最多一个活动 Pathfinder 调用

输入：

```json
{
  "target": {
    "x": 12,
    "y": 64,
    "z": -6,
    "dimension": "minecraft:overworld",
    "serverProfileId": "isolated-local"
  },
  "radius": 2
}
```

约束：

- 目标 ServerProfile 和维度必须与 Bot 当前真实状态一致。
- 目标三维直线距离最多 64 格，半径为 1～4 格。
- 禁止挖掘、放置方块、搭塔、开门、跑酷、冲刺和超过 2 格的下落。
- L0 暂停、Runtime 停止、断线、超时或外部取消都会停止寻路。
- 只允许连接已批准的隔离测试服，不能用该技能绕过 ServerProfile 策略。

已过闸门：技能 Schema、授权、范围与前置条件离线单测；Runtime 能力调用与 L0 阻断测试。
未过闸门：真实隔离服路径场景、跨版本矩阵。

## `inventory.equip-armor@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`inventory.read` + `inventory.write`
- 风险：R1
- 适配器操作：`armor.snapshot`（读）/ `armor.equip`（写单件）
- 超时：8 秒
- 自动重试：无
- 幂等：是（重复执行会收敛到同一"每槽最优"状态）
- 来源：机制参考 GPL-3.0 的 `@nxg-org/mineflayer-auto-armor` / `mineflayer-armor-manager`（"每槽选最优、平手不换"），代码全部自研 TypeScript，未逐行拷贝 GPL。

输入：

```json
{ "serverProfileId": "isolated-local" }
```

输出（结构化遥测，可从日志判定）：

```json
{
  "slots": [
    { "slot": "head", "before": "leather_helmet", "after": "diamond_helmet",
      "action": "equipped", "beforeScore": 1, "afterScore": 3 }
  ],
  "changedCount": 1,
  "capabilityCallCount": 2,
  "totalScoreBefore": 9,
  "totalScoreAfter": 16
}
```

约束：

- 授权的 `serverProfileId` 必须与 Bot 当前连接的服一致，否则前置条件与 client 双重拒绝（世界隔离）。
- 决策在技能里做（选哪件），client 只提供原子读/写，且硬护栏拒绝"非该槽护甲"或"背包没有的护甲"。
- 平手不换，避免无谓的库存扰动；空槽有候选才装。
- 不伪造成功：物理装备未生效时如实记 `action: "kept"` / `equipped:false`。
- L0 暂停、Runtime 停止、超时或外部取消都会中断。

已过闸门：决策纯函数（选优/平手/空槽）、full-flow、前置条件失败离线单测；运行时能力接线与遥测摘要日志。
未过闸门：真实隔离服换装、跨版本矩阵。验证方法见 `docs/skill-verification-runbook.md`。

## `combat.engage@1.0.0`

- 状态：**Experimental**（待 `runtime-wiring`、`isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`combat.control`
- 风险：R2
- 适配器操作：`combat.engage`
- 超时：1 秒
- 自动重试：无（战斗意图不是幂等操作）

控制面只提交有界的 `ENGAGE` 意图和 `serverProfileId`，不携带目标、坐标、白名单或原始 Tick 动作。确定性 Runtime driver 负责敌我识别、目标选择、反射层门控与实际执行回执；未接线时 fail-closed。白名单外玩家和怪物才会进入敌对候选，动物、未知实体及未明确激怒的末影人保持中立。

## `combat.disengage@1.0.0`

- 状态：**Experimental**（待 `runtime-wiring`、`isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`combat.control`
- 风险：R2
- 适配器操作：`combat.disengage`
- 超时：1 秒
- 自动重试：无（战斗意图不是幂等操作）

控制面只提交有界的 `DISENGAGE` 意图。Runtime 必须返回结构化实际回执；已延迟、丢弃或修改的请求都要带稳定原因码，不能伪造已执行。

## `collect.block@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`world.interact`
- 风险：R1
- 适配器操作：`collect.blocks-safe`
- 超时：60 秒
- 自动重试：无（移动+挖掘非幂等）
- 底层：MIT 的 `mineflayer-collectblock` 1.6.0 + `mineflayer-tool` 1.2.0（供应链已锁定，见 SECURITY.md；插件不直接暴露给 AI/任务层）
- 并发：与寻路互斥（共用移动通道）

输入：

```json
{ "blockName": "oak_log", "maxCount": 8, "maxDistance": 16,
  "dimension": "minecraft:overworld", "serverProfileId": "isolated-local" }
```

输出遥测：`targetsFound`（找到的目标数）、`itemsCollected`（背包总量实际增量——不假设方块→掉落物映射，如实读回）。

约束：

- 单次最多 32 个目标、32 格半径；采集移动允许挖掘（canDig=true）但仍禁跑酷/冲刺/搭塔。
- 采集途中禁止插件自动倒箱（chestLocations 强制清空）——入库走 `container.transfer` 显式授权。
- `targetsFound: 0` 是合法完成（附近没有该方块），不算失败。
- L0 暂停/取消会同时停掉采集任务与寻路。

## `craft.item@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`craft.execute`
- 风险：R1
- 适配器操作：`craft.item-safe`
- 超时：20 秒
- 自动重试：无（部分合成后重试会重复耗材）
- 底层：自研（mineflayer 原生 `recipesFor` + `craft`，无第三方插件）

输入：

```json
{ "itemName": "wooden_pickaxe", "count": 1,
  "craftingTable": { "x": 10, "y": 64, "z": -3 },
  "dimension": "minecraft:overworld", "serverProfileId": "isolated-local" }
```

`craftingTable: null` = 只用 2x2 随身合成。

输出遥测：`requestedCount` / `craftedCount`（合成后背包读回的实际增量，非理论产量）、`usedCraftingTable`。

约束：

- 工作台必须在 4.5 格伸手范围内（寻路由 `movement.goto` 负责，职责分离）；坐标处不是工作台报 `CRAFTING_TABLE_NOT_FOUND`。
- 无可用配方（材料不够或本就不可合成）报 `RECIPE_UNAVAILABLE`。
- craft 中途抛错但已有产出时，如实返回部分产量而不是丢弃。

## `world.place-block@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`world.interact`
- 风险：R1
- 适配器操作：`block.place-safe`
- 超时：10 秒
- 自动重试：无
- 底层：自研（mineflayer 原生 `placeBlock`），一次一块，批量建造由上层任务编排

输入：

```json
{ "itemName": "torch", "referenceBlock": { "x": 5, "y": 63, "z": 5 },
  "face": { "x": 0, "y": 1, "z": 0 },
  "dimension": "minecraft:overworld", "serverProfileId": "isolated-local" }
```

`face` 必须是单位轴向量（目标位 = 参照方块 + face）。

输出遥测：`placed: true` + `placedBlockName`（放置后读回的实际方块名，如 torch 上墙变 wall_torch 会如实上报）+ 目标坐标。

约束：

- 参照方块必须在 4.5 格内且非空气；目标位已被占用报 `PLACE_TARGET_OCCUPIED`。
- 放置后读回校验，读不到实体方块报 `PLACE_NOT_CONFIRMED`——不伪造成功。

## `container.transfer@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`container.read` + `container.write`
- 风险：R1
- 适配器操作：`container.transfer-safe`
- 超时：15 秒
- 自动重试：无（部分转移后重试会重复搬运；上层用 `movedCount` 反馈决定是否续搬）
- 底层：自研（mineflayer 原生 `openContainer` + `deposit`/`withdraw`）

输入：

```json
{ "direction": "deposit", "itemName": "cobblestone", "count": 64,
  "container": { "x": 8, "y": 64, "z": 2 },
  "dimension": "minecraft:overworld", "serverProfileId": "isolated-local" }
```

输出遥测：`requestedCount` / `movedCount`（操作前后背包该物品数量差，读回值；箱子满/物品不够时少于请求量，如实上报）。

约束：

- 只允许箱子/木桶/潜影盒（白名单），漏斗等红石敏感容器拒绝。
- 容器必须在 4.5 格内；坐标处不是允许的容器报 `CONTAINER_NOT_FOUND`。
- 这是基地分类存储与按角色补货的原子底座。

## `smelt.item@1.0.0`

- 状态：**Partial**（待 `isolated-server-scenarios`、`cross-version-matrix`）
- 权限：`craft.execute`
- 风险：R1
- 适配器操作：`smelt.item-safe`
- 超时：60 秒
- 自动重试：无（部分熔炼后重试会重复耗料与燃料）
- 单次上限：原料与燃料各最多 5 个（`SMELT_MAX_COUNT`）
- 底层：自研（mineflayer 原生 `openFurnace` + `putInput`/`putFuel`/`takeOutput`，无第三方插件）

输入：

```json
{ "inputItemName": "raw_iron", "fuelItemName": "coal",
  "fuelCount": 1, "count": 2,
  "furnace": { "x": 9, "y": 64, "z": 1 },
  "dimension": "minecraft:overworld", "serverProfileId": "isolated-local" }
```

输出遥测：`outputItemName`（**取出后读回的真实产物名**，不查配方表推断）、`requestedCount` /
`smeltedCount`（实际取出总数）、`insertedFuelCount`。

约束：

- 熔炉必须在 4.5 格伸手范围内（寻路由 `movement.goto` 负责）；坐标处不是熔炉报 `FURNACE_NOT_FOUND`。
- **只使用空熔炉**：输入/燃料/产出任一槽非空即报 `FURNACE_NOT_EMPTY`，绝不动别人正在烧的炉子，
  也避免把他人产物计成自己的产量。
- 原料或燃料不足在开炉前就拒绝（`SMELT_INPUT_INSUFFICIENT` / `SMELT_FUEL_INSUFFICIENT`），不做半程消耗。
- 产出中途换名（炉内混入他物）报 `FURNACE_OUTPUT_MISMATCH`。
- 一次也没取到产物报 `SMELT_OUTPUT_NOT_CONFIRMED`——不伪造成功。
- 等待产出是 250ms 一轮的 `update` 事件轮询，总时长由 60 秒技能超时兜住；超时与外部取消都会关炉退出。
- L0 暂停、Runtime 停止、超时或外部取消都会中断，且 `finally` 关炉不吞掉失败。

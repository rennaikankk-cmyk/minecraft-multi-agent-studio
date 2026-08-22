# Skill 服务器验证 Runbook

目的：当你让某个 bot 上**隔离测试服**跑一个技能时，运行时会打出结构化日志。本文件告诉你**看哪几行、怎么判定"这个技能到底能不能用"**。

> 纪律前提（不可绕过）
> - 只在 `purpose: "isolated-test"`、`networkScope: loopback|private-lan`、`auth: offline` 的 ServerProfile 上验证。绝不自动连生产服/未批准服。
> - 日志里不会出现凭据、坐标、库存明细——observability 层按 `SENSITIVE_KEY_PATTERN` 强制脱敏。runbook 里的字段都是有意暴露的**标量摘要**。
> - 不伪造成功：技能"装备没生效"会如实报 `action: "kept"` / `equipped:false`，不会谎报 `equipped`。

---

## 1. 每次技能调用只看一行

运行时在 `apps/bot-runtime/src/runtime.ts::handleSkillInvocation` 打一行 JSON：

```
event = "bot_runtime_skill_result"
```

- `completed` → `level: "info"`（走 stdout）
- 其它任何结局 → `level: "warn"`（走 stderr）

关键字段：

| 字段 | 含义 | 判定用途 |
|---|---|---|
| `skillId` / `skillVersion` | 哪个技能 | 确认跑的是你想验证的那个 |
| `outcome` | `completed`/`rejected`/`failed`/`timed_out`/`cancelled` | 第一眼看能不能用 |
| `attempts` | 实际执行次数 | 是否触发重试 |
| `durationMs` | 端到端墙钟耗时（运行时测量，不由技能自报） | 时延是否可接受 |
| `errorCode` | 仅非 `completed` 时出现 | 失败根因（见 §4 签名表） |
| `telemetry` | `completed` 时的标量摘要（见 §3） | 判定"真干了活"还是"空跑" |

grep 起手式（把 `<botId>` 换成实际 botId）：

```bash
# 只看某个 bot 的技能结果
grep '"event":"bot_runtime_skill_result"' bot.log | grep '"botId":"<botId>"'

# 只看装甲技能，且只看失败
grep '"event":"bot_runtime_skill_result"' bot.log \
  | grep '"skillId":"inventory.equip-armor"' \
  | grep '"level":"warn"'
```

---

## 2. `inventory.equip-armor@1.0.0` —— 首个二档技能

来源声明：机制参考 GPL-3.0 的 `@nxg-org/mineflayer-auto-armor` / `mineflayer-armor-manager`（"每个槽位选最优、平手不换"），**代码全部自研 TypeScript，未逐行拷贝 GPL**。决策在技能里（可离线单测），运行时只提供 `armor.snapshot`（读）/`armor.equip`（写单件）两个原子能力。

### "能用"的样子

一行 `completed`，且 `telemetry` 自洽：

```json
{"event":"bot_runtime_skill_result","level":"info","skillId":"inventory.equip-armor",
 "outcome":"completed","attempts":1,"durationMs":137,
 "telemetry":{"changedCount":2,"capabilityCallCount":3,"totalScoreBefore":9,"totalScoreAfter":16}}
```

判定：
- `capabilityCallCount == 1 + changedCount`（1 次快照 + 每次实际换装 1 次写）。对不上 → 换装没落地。
- `totalScoreAfter >= totalScoreBefore`，绝不倒退。
- `changedCount == 0` **也算能用**——代表身上已是最优，无需换装（不是故障）。

### 用一次调用同时验证读能力

即使 `changedCount==0`，只要 `outcome==completed`，就证明 `armor.snapshot`（inventory.read）这条链路通了。想强制看到 `changedCount>0`，先让 bot 背包里放一件比身上更好的护甲再触发。

---

## 3. `telemetry` 摘要来自哪里

运行时的 `skillResultTelemetryDigest()` 只从技能已验证的 `output` 里**白名单**摘出这些标量：

```
changedCount, capabilityCallCount, totalScoreBefore, totalScoreAfter, distanceToTarget,
targetsFound, itemsCollected, requestedCount, craftedCount, movedCount
```

- 未知形状 / 非数字 → 该字段直接不出现（降级为 `null` 整体），绝不倾倒任意 output。
- `movement.goto` 带 `distanceToTarget`；`inventory.equip-armor` 带 changed/capability/score 四个；`collect.block` 带 `targetsFound`+`itemsCollected`；`craft.item` 带 `requestedCount`+`craftedCount`；`container.transfer` 带 `requestedCount`+`movedCount`。
- 新技能想被"日志可判定"，只需在 output 上暴露上面某个标量键即可，无需改运行时。

### 生存链技能的"能用"判定速查

| 技能 | completed 时看什么 | 判定 |
|---|---|---|
| `collect.block` | `targetsFound` / `itemsCollected` | `itemsCollected > 0` = 真挖到了；`targetsFound:0` = 附近没有该方块（合法完成，不是故障） |
| `craft.item` | `craftedCount` vs `requestedCount` | 相等 = 全成；少 = 部分成功（材料耗尽，如实上报）；`RECIPE_UNAVAILABLE` = 材料不够或不可合成 |
| `world.place-block` | `placedBlockName` | 出现即已放置并读回确认；名字可能与物品名不同（torch→wall_torch 属正常） |
| `container.transfer` | `movedCount` vs `requestedCount` | 少于请求 = 箱子满/物品不够（诚实反馈，上层决定续搬） |

---

## 4. 失败签名表（`errorCode` → 病因 → 下一步）

| errorCode | 含义 | 你该做什么 |
|---|---|---|
| `SKILL_CAPABILITY_UNSUPPORTED` | 该 capability/operation 运行时没接线 | 技能没接到 client 层——检查 `mineflayer-client.invokeSkillCapability` 的分派 |
| `NORMAL_ACTIONS_PAUSED` | L0 安全层暂停了普通动作，或 bot 不在线 | 正常的安全拦截；确认 bot 已上线且未处于安全暂停 |
| `TARGET_SERVER_PROFILE_MISMATCH` | 授权的 ServerProfile ≠ 当前连接的服 | **世界隔离在起作用**（预期行为）。你连错服了或授权串了服 |
| `BOT_NOT_ONLINE` | 前置条件：bot 未在线 | 等连接建立再触发 |
| `SKILL_CAPABILITY_INPUT_INVALID` | 传给能力层的入参没过 schema | 技能与 client 的能力契约不一致——版本对齐 |
| `ARMOR_ITEM_SLOT_MISMATCH` | 想把某件护甲装到不匹配的槽位 | client 的硬护栏拦下了非法组合，通常意味着技能决策有 bug |
| `ARMOR_ITEM_NOT_IN_INVENTORY` | 要装的护甲背包里其实没有 | 快照与实装之间背包变了（掉了/被拿走）；重试即可 |
| `ARMOR_EQUIP_FAILED` | mineflayer `equip()` 抛错 | 看是不是被打断/背包满；`durationMs` 常接近超时 |
| `BLOCK_NAME_UNKNOWN` / `ITEM_NAME_UNKNOWN` | 名字不在当前版本注册表 | 检查拼写/版本差异（如 1.12 与 1.20 物品名不同） |
| `BOT_MOVEMENT_BUSY` | 采集/寻路互斥占用 | 等上一个移动类技能结束再触发 |
| `COLLECT_BLOCKS_FAILED` | 采集插件异常（路被堵/目标消失） | 偶发可上层重试；连续出现看寻路日志 |
| `RECIPE_UNAVAILABLE` | 无可用配方（材料不够或不可合成） | 先补材料；给了工作台坐标但材料只够 2x2 也报这个 |
| `CRAFTING_TABLE_NOT_FOUND` / `CRAFTING_TABLE_OUT_OF_REACH` | 坐标处不是工作台 / 超 4.5 格 | 先 `movement.goto` 走到工作台旁 |
| `CRAFT_FAILED` | craft 抛错且无部分产出 | 看背包空间/被打断 |
| `REFERENCE_BLOCK_NOT_FOUND` / `PLACE_TARGET_OCCUPIED` | 参照方块是空气 / 目标位被占 | 世界与预期不符，上层重新观察再下指令 |
| `PLACE_BLOCK_FAILED` / `PLACE_NOT_CONFIRMED` | 放置动作失败 / 放完读不回 | 后者= 服务器回滚（反作弊/保护插件），重点关注 |
| `CONTAINER_NOT_FOUND` / `CONTAINER_OUT_OF_REACH` | 坐标处不是白名单容器 / 超 4.5 格 | 只支持箱子/木桶/潜影盒；先走到容器旁 |
| `CONTAINER_TRANSFER_FAILED` | 存取抛错且无部分转移 | 看容器是否被占用/保护 |
| `ITEM_NOT_IN_INVENTORY` | 要放置/存入的物品背包里没有 | 快照过期或被消耗，重新清点 |
| `SKILL_TIMEOUT` | 超过 `timeoutMs`（equip-armor=8s，goto=20s，collect=60s，craft=20s，place=10s，transfer=15s） | 服卡顿或动作卡死；结合 `durationMs` 看 |
| `SKILL_CANCELLED` | 被 L0 或上层中断 | 预期——安全中断优先级最高，不算技能坏 |
| `RUNTIME_STOPPING` | 运行时正在停机 | 停机期间的正常拒绝 |

判定口径：
- 看到 `SKILL_CAPABILITY_UNSUPPORTED` = **没接好，不可用**，先修接线。
- 只看到 `NORMAL_ACTIONS_PAUSED` / `TARGET_SERVER_PROFILE_MISMATCH` / `SKILL_CANCELLED` = 技能本身没问题，是安全/隔离/时序在按设计拦截。
- 反复 `ARMOR_EQUIP_FAILED` / `SKILL_TIMEOUT` = 机制层真有问题，需要看 mineflayer 侧。

---

## 5. 一次典型验证流程

### 推荐的一键入口

在已准备并人工接受 EULA 的回环隔离服环境中运行：

```powershell
pnpm test:minecraft-skills
```

脚本会复用固定 Minecraft 1.21.8 服务端哈希、安全 `server.properties` 与本地 ServerProfile 校验，启动临时回环服，执行真实连接、断线恢复，以及全部七个内建技能各一个成功场景，最后输出 `MINECRAFT_SKILL_ACCEPTANCE=PASS`。测试场景只触发脚本内硬编码的白名单控制台命令；marker 文件内容不会作为服务器命令执行。只有 CI 或本地真实运行完成后才能登记证据；测试代码存在本身不改变任何技能的 `verification=unverified` 状态。

当前固定成功场景依次覆盖移动、采集单个原木、合成工作台、放置方块、箱子存入、四槽铁甲换装，以及 `1 raw_iron + 1 coal -> 1 iron_ingot`。后续场景应沿用同一入口扩展，不另建启动器。

### 版本化场景清单

`@minecraft-studio/skills` 导出 `builtinSkillVerificationManifestsV1`。清单由严格的
`skillVerificationManifestV1Schema` 校验，当前为 7 个内置技能固定 Minecraft 1.21.8
的验收矩阵。每个技能必须包含成功、材料不足、权限/位置拒绝、L0 抢占、取消、断线和
部分成功读回七类场景，否则校验失败。

每个场景记录初始背包、世界方块、技能输入、预期背包与世界状态、稳定错误码、真实
读回要求和不超过 60 秒的硬超时。未知字段会被拒绝，场景 ID 不允许重复。

### GitHub 隔离验收门禁

普通 PR 仍只运行离线质量门禁。真实 Minecraft 技能验收仅通过以下两种方式启动：

1. 在 GitHub Actions 中手动运行“Minecraft 技能隔离验收”，并勾选 EULA 人工确认；
2. 仓库管理员先将 Actions 变量 `MINECRAFT_EULA_ACCEPTED` 设为 `true`，再给同仓库 PR
   添加 `minecraft-acceptance` 标签。PR 更新后必须移除并重新添加标签，避免旧授权自动覆盖新提交。

门禁拒绝 Fork PR，不读取任何 Secret，只授予 `contents: read`。它在 Windows GitHub Runner
中下载固定 Mojang 官方 1.21.8 服务端并核对 SHA-1 与 SHA-256，只生成 `127.0.0.1:25565`、离线认证、
禁用 RCON/Query 的临时世界。验收日志保留 7 天；流程不会连接私有测试服或正式服。

1. 准备隔离服 ServerProfile（`isolated-test` + loopback）。
2. 给 bot 背包放几件不同材质的护甲（至少一件优于身上）。
3. 触发 `inventory.equip-armor`，`serverProfileId` 填当前服。
4. `grep '"skillId":"inventory.equip-armor"' bot.log | tail -1`。
5. 对照 §2/§4：
   - `completed` + `telemetry` 自洽 → **可用**。
   - `warn` + `errorCode` → 查签名表定位。
6. 把这一行贴给我，我据此给出"可用/不可用 + 根因"的判定。

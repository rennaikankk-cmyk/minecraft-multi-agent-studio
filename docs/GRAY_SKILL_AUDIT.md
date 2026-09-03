# 灰度前 Skill 层加固审查（2026-09-03，G0 交由另一窗口，本报告覆盖 skill 面）

## 已修复（本轮提交）

### 1. 脚手架死锁（CRITICAL，实锤修复）
- **问题**：`authorizeHarvest` 对 own_bot/own_team 一律拒绝挖掘——包括
  `purpose: temporary`。anarchy 导航（搭高/垫脚/沿途挖掘）的方块经
  placeBlock 包装全部记为 `structural/own_bot` → **bot 被自己的桥/塔永久卡死**
  （wrappedDig 抛 HARVEST_PROTECTED_ASSET → pathfinder 中止）。
  复现：own structural/temporary dig → 均 HARVEST_PROTECTED_OWN。
- **修复**：①一次性用途（navigation/temporary/sacrificial）的 own 方块放行
  （reason=disposable_own）；②placeBlock 包装按移动租约区分——寻路租约期内
  的放置记 `navigation`（可自拆），技能建造（build/blueprint）在无租约时
  发生 → 保持 `structural`（受保护）。结构性资产保护不变。
- **测试**：+3（disposable 三用途放行 / structural+facility+storage+farm+
  portal+undefined 仍拒 / own_team disposable 放行）；skills 880、
  bot-runtime 362 全绿。

### 2. luv 重连覆盖不足（修复：profile 参数）
- **问题**：原 reconnect 10 次×3-30s 退避 = 225s 总覆盖 ≈ 2 个放行窗口
  （实测限速 ~1 次登录/120s/IP）——运气差两次都撞封锁窗就放弃。
- **修复**：luv profile reconnect = 14 次×45-60s ≈ 13 分钟 ≈ 6 个放行窗口。

### 3. Forge 不兼容闩锁（已在 P1 落地，此处确认覆盖面）
- INCOMPATIBLE_MOD_LOADER：确定性 FML kick → 停止重连 + 单 Incident +
  BLOCKED（不再打服务器）。

## 操作注意（不修代码，进灰度 Runbook）

### 4. 建 bot 必须显式传版本 + connectHost（FOOTGUN）
- manager 的 profile 由 **create 请求**生成（非 Server Profile 文件）——
  若建 bot 时传 `minecraftVersion: "auto"`，runtime 会在 SLP 屏蔽下死在
  版本探测（luv 实测 30s 静默）。灰度建 bot 模板：
  `POST /v1/bots {username, serverHost:"luv.mc6.cn", serverPort:22936,
  minecraftVersion:"1.21.11", connectHost:"202.189.13.131", purpose:"anarchy"}`

## Watch 项（G2+ 自主生存时盯，G1 不触发）

5. **观察类 goal 高 noop 率**（已知）：planner grounding 策略对无坐标观察
   goal 诚实 noop（两模型 70-80%）——G1 的"观察"环节应视为尽力而为，
   在场真值以 connectionState+遥测为准。
6. **mine.branch/vein 液体防护**：确定性模板已带 liquid-adjacent 排除 +
   backfill；anarchy 实际岩浆密度下首跑盯 Incident。
7. **food.secure 夜间觅食**：L0 安全闸（LOW_HEALTH/CRITICAL_HEALTH 暂停
   normal tasks）+ 战斗反射为确定性层，不依赖模型——按设计工作，但
   首个夜晚时段重点观察。
8. **死亡恢复撞守尸**：assessDropRecovery 有 streak≥3 停送装备闸；
   单次死亡回捡遇敌的恢复目标是设计内风险（撤退优先级在）。
9. **skill 成熟面**：22 Partial + 1 Experimental（stock.levels，纯函数
   只读豁免）全部 planner 可达（anarchy_first）——G1 只应触碰
   movement/goto+scan；G2 autonomy 会拉宽面，按灰度熔断条款监控。
10. **placeBlock 租约标记的边界**：若未来技能在移动租约活跃期间做
    建造（当前无此路径），其方块会被记为 navigation（可拆）——
    记录为已知语义边界，出现建造技能+移动并发时需重审。

## 审查结论

G1（登录/观察/移动/重连）skill 面**就绪**：唯一 CRITICAL（脚手架死锁）
已修复+回归；G2+ 的 watch 项已列，无新的阻断。

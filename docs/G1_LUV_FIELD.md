# G1 luv 实测报告（2026-09-03 夜，22:42-22:48）

> 前置：docs/FINGERPRINT_LUV.md（登录路径已证 CONDITIONAL_ACCEPT）。
> 本轮 = G1（1-bot 登录/观察/移动/重连）在生产 luv.mc6.cn:22936 的首次实弹。

## 配置

- Bot：`StudioGray01`（studio-bot-01，purpose=anarchy，connectHost=202.189.13.131，
  钉版本 1.21.11=774，域名握手）——全部按 profile SSOT。
- Studio：HEAD 804e14e（含本日五修复），AUTONOMY=0。

## 结果

**G1 = PARTIAL（登录与保号实证 PASS；稳定会话与移动腿被环境阻断）**

### 实证 PASS 的部分

1. **登录路径端到端**：首个放行窗即上线（22:43:02，create→online 26s）；
   全程多次跨窗重登成功（22:43/22:44/22:45/22:47 四个会话）——钉版本+
   域名握手+真实 IP 直连的指纹结论在 studio 生产链路复现。
2. **L0 保号（断线保命）实战首证**：出生点 (0,105,0) 被持续攻击，
   LOW_HEALTH→CRITICAL_HEALTH（0.5s 内，血量最低见 0.83/20）触发
   `l0_emergency_stop` 共 3 次——**零死亡、零 BOT_CRASH 噪音**
   （incidents 104→104 delta 0）。
3. **干净退出**：user stop → `requested_stop / expected=true`（EXPECTED_STOP）。
4. **fail-closed 纪律实战**：危急血量下提交移动 goal → `GOAL_REJECTED`
   （L0 PAUSE_NORMAL_TASKS 语义）——安全层在真实攻击下没有被绕过。

### 被环境阻断的部分

- **稳定会话（30-60min）与移动腿**：luv 出生点在晚间高峰被围猎
  （伤害速度快于任何移动/恢复）。bot 无法在出生点立足 → 无法进入
  观察期。这是无规则服环境现实，不是 studio 缺陷。

## 证据

- `runtime-data/logs/bot-studio-bot-01.log`（append，本轮 22:42-22:48 段：
  4 会话/3 emergency stop/138 历史累计登录）
- `runtime-data/logs/studio-luv-g1.log`
- incidents.json BOT_CRASH delta = 0

## 结论与下一步

1. **服务器侧前提彻底解除**（登录+存活工程双证）；G1 剩余腿只差
   "一个不被围猎的登录时机"。
2. **凌晨低峰重试**（建议 04:00-07:00）：bot 配置已在
   local-bots.json（stopped 态），起 studio 后 start 即可，无需重建。
3. **产品缺口立项建议——spawn escape（登录即逃逸）**：anarchy 服出生点
   常态化围猎，"登录→L0 反应→被围死"是结构性的。需要的能力：登录
   加载完成的第一 tick 立即沿预设方向疾跑/搭高（在 L0 crit 之前离开
   攻击范围），或错峰+多变道登录策略。这是 R5-RECON 之后 anarchy
   生存链的高优先级项。
4. 10-bot 错峰存在性实测（~120s/个登录）在 1-bot 稳定立足之后才有意义。

---

## 追加：伤害法证（2026-09-03 22:54，牺牲式探针 StudioProbe01）

**问题**：22:43-48 的 3 次 CRITICAL_HEALTH 是谁/什么造成的？

**方法**：裸 mineflayer 探针（无 L0 保护）同出生点登录 2 分钟，记录
实体/方块/血量/聊天（`eval/fingerprint/spawn-forensics-probe.mjs` +
`apps/bot-runtime/e2e/` 副本，日志 runtime-data/logs/spawn-forensics-probe.log）。

**结论：没有人。是出生点空洞坠落 + 井底敌对怪。**

1. **48 格内零玩家**——"围猎的玩家"假设不成立，晚间高峰也没有。
2. **出生点 (0,~106) 脚下/身周全 air**——世界出生点是个竖井/空洞
   （无政府服经典出生洞）。探针位置循环 106→99→105：下坠-被拉回。
3. **正下方 (0,88,0) 及周围 y=52-88 有多个 hostile 实体**——井底怪坑。
   StudioGray01 会话的交战目标 713006 即此类。
4. **4.5 首击伤害 = 7.5 格坠落伤害（106→99），逐字节吻合两次会话的
   20→15.5**——确定性环境伤害，非玩家攻击。后续 LOW→CRITICAL 0.5s =
   继续坠落 + 井底怪补刀。
5. **重大新发现：服务器有注册/登录插件**——聊天栏持续刷
   `你还没有注册,请输入/reg 密码 重复密码 来注册`。未认证账号处于
   出生点拉回循环（这可能就是 106→99→105 回弹的来源）。探针全程
   零伤害未被踢——**伤害不是插件惩罚**。

### 对 G1/灰度的修正结论（22:58 二次修正：认证已自动完成）

- **勘误**：上一版"前置新增：手动 /reg 注册"不成立——combat 包的
  ServerAuthHandler（2487863 已落地）在 14:42:41 **自动注册成功**
  （凭据库 `~/.studio-auth/StudioGray01.json`；persist 仅在服务器确认
  成功后写入=真值；14:48:18 还自动 /login 过一次）。探针看到的注册
  提示是给探针新号的，不是 StudioGray01 的。
- **完整因果链**：认证后的 bot 物理放开 → 从出生竖井坠落 → 井底怪
  → L0 保号断线。未认证的探针反而被插件反复拉回 106 格——这正是
  探针零伤害的原因（拉回=保护）。
- **唯一真阻断 = 出生点击杀区本身** → spawn-escape 即第一优先
  （docs/research/SPAWN_ESCAPE_SPEC.md 立项；v0 同日交付：第一 tick
  疾跑逃逸 + 纯 mob 零门槛撤 + 床毁重生重触发语义）。
- 下一步：带 v0 逃逸重跑 G1 剩余腿（稳定会话 + 移动 + 观察）。

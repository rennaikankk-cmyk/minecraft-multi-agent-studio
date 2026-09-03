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

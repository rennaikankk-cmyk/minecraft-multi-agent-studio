# GRAY_CANARY_REPORT（外部灰度闭环）

目标服务器：**luv.mc6.cn:22936**（Server Profile `configs/servers/luv-anarchy.json`）。
历史事实：Paper 26.1.2 / protocol 775（防护开启前实测），SLP 被反探测屏蔽，
**bot 完整登录是唯一在场真值**。1.21.11(774) 客户端曾被跨版本接受（Round 8 实证）。

## 纪律（每阶段生效）

1. 固定 gitCommit、模型 ID+revision、推理容器、启动参数、Server Profile。
2. 保存 goalId/botId/traceId/世界观察/工具调用/状态转换/Incident/服务端确认。
3. 失败响应链：Incident → 导出证据 → 本地最小复现 → 修代码 → 回归测试 → CI →
   隔离服重测 → **从当前灰度级别重跑**。
4. 一次只引入一组可归因改动。
5. 灰度运行中禁止改代码/配置/Prompt/模型参数。
6. 外部服禁止调用本地服 Stop/Reset/重建世界/fixture 清理。
7. 凭据/代理地址/令牌不进 Git。
8. 必须可用：全局 kill switch、单 bot stop、自动回滚、超时熔断、模型降级。
9. 失败后先保存现场再清理。
10. 只有通过回归测试的修复才可重入同级灰度。

### 晋级熔断（任一立即停止晋级）

丢失/重复 goal；拆毁 own/team/facility 资产；user stop 记成 BOT_CRASH；
单次外部终止产生多个重复 Incident；死亡恢复连续送装备；OOM/模型崩溃/大面积断线；
无效工具调用率>1%；verified success 环比降>5pp；任一 bot >30s 调度饥饿；
持续乱码/语言漂移/无限思考/重复工具调用；kill switch/manual stop 不能立即止动。

## 当前状态（P0 固化，2026-09-03）

- **G0 = FAIL**（L7 10-bot 公平性 FAILED；60min soak PARTIAL）
- **G1 = NOT_STARTED**（尚未开始；此前一切外服连接尝试不计入 G1 计时）
- **External preflight（simpfun）= BLOCKED_INCOMPATIBLE_MOD_LOADER**（B 裸探针 PRE_LOGIN Forge/FML kick 原文已存证；C Runtime 复现闭环修复中，见 P1）
- **External preflight（luv）= CONDITIONAL_ACCEPT**（2026-09-03 指纹对抗修正，推翻此前 BLOCKED_PROTOCOL_AUTH_COMPAT：mineflayer 原版协议可登录——raw login774 实测 LOGIN SUCCESS、经中继完整登录链 30s 稳定、5 次直连 2/5 成功（≈每 IP 120s 放行 1 次限速）；硬条件=钉版本+域名握手+真 IP 直连（profile 已配）。详见 docs/FINGERPRINT_LUV.md。G1 服务器侧前提解除；G0/选型前置不变）

## 阶段状态（2026-09-03）

| 阶段 | 内容 | 状态 | 证据 |
|---|---|---|---|
| G0 | 本地隔离服 L1-L8 全过 | **FAILED**（L7 10-bot 公平性 4 轮未过：单 fixture 容量瓶颈；修复项 L7B-1/2/3 见 MASTER_COMPLETION_MATRIX） | /tmp/l6/l7/l8-*.log + coordinator.log 2026-09-03 |
| G1 | 1 bot 登录/观察/移动/重连 30-60min | **NOT_STARTED** | 前置 G0 未过；外部预检事实见下文（不计入 G1 计时） |
| G2-G6 | 自主生存→2bot→5bot→10bot→复验 | NOT STARTED（G0/G1 前置） | — |

## luv 登录阻断（BLOCKED_PENDING_ROOT_CAUSE）

2026-09-03 实测（方法论修正后，工具 `external-canary-e2e.mjs`）：

- **ping**：SLP 8s 超时（与 simpfun 同为反探测，如实记录）。
- **B 裸探针**（host/connectHost 分离；握手=luv.mc6.cn，TCP=真实 IP 直连出口已验证）：
  新身份 3s 内被踢；SSOT 身份（StudioGray01）60s 登录挂起无响应。
  （对照：simpfun 同日 B 探针 2.2s kick，原文已存——两台外服同日均拒。）
- **C 完整 Studio Runtime**：NOT_ONLINE（重连循环）。
- **A 官方客户端**：**待用户执行**（同网络同账号登录 luv 一次），或提供 luv 服务端日志。
- 结论：**BLOCKED_PENDING_ROOT_CAUSE**——不写"服务端拒绝 bot"根因，
  等 A 或服务端日志。证据目录 `runtime-data/canary-evidence/`。
- 对照事实：本地登录栈健康（L1-L8 场景全部登录成功）；Round 8（2026-09-02）
  luv 登录正常——当日与今日服务端行为不同。

## G1 通过判据（解除阻断后）

1. 登录在场 ≥30min（connectionState=online 持续，遥测齐全）。
2. 轻量观察 goal ≥1 次真实完成（或如实记录失败码）。
3. 断线重连：restart 后 60s 内重新在场。
4. 干净退出：EXPECTED_STOP、BOT_CRASH delta=0。
5. 全程 kill switch 演练一次成功（停后 5s 内无新动作）。

## P2：simpfun Forge 判定（A 意外配置 / B 有意模组服）——待决

**已知事实**（全部有证据）：B 裸探针 PRE_LOGIN 2.2s kick，原文含 FML/Forge
client-mods 要求（runtime-data/canary-evidence/2026-09-03T05-41-34-685Z）；
SLP 屏蔽；C Runtime 因 SLP 屏蔽→版本自动探测失败（32s unknown，从未到达
握手——P1 捕获代码已就绪但无触发条件）；P1 复验一次（纪律内）确认该缺口。

**判定所需输入（用户提供其一即可）**：
1. simpfun 控制台：服务端类型/核心（Forge/NeoForge 版本）、mod 列表、
   2026-09-03 05:42:50 与 06:25:48 前后的服务端日志；
2. 或官方客户端（同网络）登录一次 simpfun 的结果（能否进服、要求的 modpack）。

**分支 A（意外开成 Forge/mod 服）**：
- 控制台改为 Vanilla/Paper（与 Mineflayer 兼容的版本，记录确切版本号）；
- 建立新 Server Profile revision（新 minecraftVersion + 探测事实）；
- 官方客户端完成一次登录控制测试；再跑裸探针与 Runtime（新矩阵）。

**分支 B（有意 Forge 模组服）**：
- Forge 支持拆成独立兼容性工作流（minecraft-protocol-forge 评估在 P2 完成后，
  现在不引入）；
- 先取准确 Minecraft 版本、Forge/FML 版本、mod 列表、服务端日志；
- 官方客户端 + 完整相同 modpack 完成控制测试；
- 可行性评估后再决定是否开发——**不阻塞 luv 主线的 Vanilla/Paper 灰度**。

## 复现命令

```bash
# 矩阵（ping/B/C，每配置≤1 次，60s 冷却）
node apps/bot-runtime/e2e/external-canary-e2e.mjs \
  --profile configs/servers/luv-anarchy.json --matrix ping,B,C
# 证据输出：runtime-data/canary-evidence/<ts>-luv-anarchy-*.json
```

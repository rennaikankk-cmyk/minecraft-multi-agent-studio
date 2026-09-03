# luv.mc6.cn 指纹对抗报告（2026-09-03）

## 结论（修正此前判定）

**luv 可登录** —— 此前 `BLOCKED_PROTOCOL_AUTH_COMPAT` 判定**不成立**，修正为：

`CONDITIONAL_ACCEPT — 需钉版本 + 限速间歇（实测 2/5，约每 120s 放行 1 次登录/每 IP）`

无需任何指纹伪装：mineflayer 原版协议字节与官方客户端语义一致（offline UUID
逐字节校验一致 `a821a063-…`；handshake/login_start 字节逐项对齐）。

## 实验记录（工具：eval/fingerprint/raw-handshake-probe.mjs + tap-relay.mjs）

| # | 时间 | 实验 | 结果 |
|---|---|---|---|
| T1 | 12:42 | raw status ping（774, nextState=1） | **0 字节 20s**（SLP 恒屏蔽——反探测，已知行为） |
| T5 | 12:44 | 悬空握手（774, next=2, 不发 login） | 0 字节 25s |
| T3 | 12:46 | raw login **775** | 0 字节 25s（未知版本静默丢弃） |
| T0 | 12:47 | raw login **774**+login_start（单 write） | **2.3s 后 37B：set compression(256) + LOGIN SUCCESS** |
| R | 12:49 | mineflayer（774 钉版+fakeHost 域名）经本地中继 | **完整登录链**（brand=vanilla/26.1.2、registry、维度数据、30s 稳定在线） |
| D1 | 12:52 | mineflayer 直连同参数 | 静默 30s |
| D2 | 12:56 | mineflayer 直连+写时序 tap | **LOGIN 成功** |
| Q1-Q5 | 13:0X | 5 次直连、60s 间隔 | 败/成/败/成/败 = **2/5**（登录延迟 2.5-4.0s） |

## 行为模型（解释全天数据）

1. **SLP 恒屏蔽**（status ping 永远 0 字节）→ 任何 `version=auto` 客户端死在
   自动探测（mineflayer auto 先 ping）→ **必须钉版本**。profile 已钉 1.21.11。
2. **未知/不匹配协议版本（775 原生握手）静默丢弃**——774（ViaVersion 跨版本）正常受理。
3. **悬空握手（只握手不登录）丢弃**——防探测。
4. **登录限速：约每 IP 每 120s 放行 1 次**——窗口外的登录 TCP 连接被静默 tarpit。
   上午/午间的"全部静默"批次与 2/5 交替均吻合此模型。
5. 上午经代理路径的「3 秒活跃 kick」为不同入口行为（代理出口 IP 走了另一条
   边缘规则）——与本机直连路径无关。

## 对灰度的含义

- **Bot 可登录**：钉版本 + 域名握手 + 真实 IP 直连（profile 现配置），
  重连退避下几分钟内必进（runtime 现有 reconnect：10 次×3-30s 退避 ≈ 覆盖
  2 个放行窗口；如需更稳可把 luv profile reconnect.baseDelayMs 调 60s）。
- 登录成功后 30s+ 稳定（registry/维度数据正常接收）。
- G1（1 bot 30-60min）的**服务器侧前提已解除**；剩余前置仍是 G0（L1-L8）
  与模型选型。
- 证据：runtime-data/fingerprint/*.log + 本报告 + profile matrix 事实。

## 复现

```bash
# raw 实验（可换 experiment: ping|hello-only|login775|login774|ping-then-login）
node eval/fingerprint/raw-handshake-probe.mjs login774
# 中继抓包（mineflayer 全字节流）
node eval/fingerprint/tap-relay.mjs   # 127.0.0.1:22936 → 202.189.13.131:22936
# mineflayer 经中继
node -e "require('mineflayer').createBot({host:'127.0.0.1',port:22936,fakeHost:'luv.mc6.cn',username:'StudioGray01',version:'1.21.11',auth:'offline'})"
```

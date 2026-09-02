# Anarchy-First 产品章程（Product Charter）

> 状态：**生效中**（Round 8 / 2026-09-02 起）。本文件是项目的持久化产品定位，
> 独立于任何聊天上下文。所有后续 Skill 开发、修复、Incident、E2E、前端
> 与 Codex/GLM 工作在读取产品边界时以本文件为准。
> 实现入口：`packages/protocol/src/gameplay-policy.ts`（单一事实源）。

## 1. 产品定位

本项目（Minecraft Multi-Agent Studio）默认面向**无规则（anarchy）服务器**：
目标环境中可能存在使用强力外挂客户端的真人玩家。Bot 不是和平生存 NPC，
也不会因旧的保守边界成为待宰目标。默认允许并持续发展：

- 完整的无规则服生存、自动化、建造、防御与恢复；
- 主动战斗、追击、撤退、换装、图腾、水晶、重生锚；
- 物资争夺、容器/设施自由使用；
- NoHunger、PacketMine 等高强度能力（经统一 capability gate）；
- 多 Bot 独立行动与按收益的显式协作。

## 2. 边界分类（永久纪律）

| 类别 | 定义 | 处置 |
|---|---|---|
| **BotSurvivalSafety** | 防 Bot 自杀/友伤/必败送死；图腾、撤退、爆炸自伤保护、断线保命 | **永远保留并强化**，不受 profile 影响 |
| **OperationalSecurity** | 主机/凭据/外部服务器管理边界；不入侵宿主机、不窃取凭据、不 DDoS、不故意崩服、secrets 不入库/日志/导出 | **永远保留**，与游戏行为无关 |
| **GameplayRestraint** | 限制 PvP/破坏/争夺/高强度能力的旧和平服边界 | 在 `anarchy_first` 下**移除或改为 profile 配置** |
| **ServerCompatibility** | 按服务器实际纠正/拒绝动态调整动作参数 | **保留**——不是道德限制，是存活率工程 |

仍然禁止（OperationalSecurity，永远）：

- 入侵服务器宿主机、控制面、数据库、文件系统或 RCON；
- 窃取账号/密码/Token/Cookie/代理凭据/他人身份；
- 攻击认证服务、绕过账号所有权、破解验证码；
- DDoS、网络洪泛、端口扫描、RCE、故意使服务器进程崩溃；
- 把 secrets 写入 Git、日志、Incident 或导出包；
- Studio 对 External Server 显示或调用 Start/Stop/Restart/Reset；
- 无限循环、无限重试、无界内存/队列或失控发包。

## 3. Gameplay Policy（实现事实）

- 类型：`StudioGameplayProfile = "anarchy_first" | "standard" | "custom"`；
- 默认：**`STUDIO_GAMEPLAY_PROFILE=anarchy_first`**（项目默认）；
- 优先级：ServerProfile override > operator env > 项目默认；
- 非法值 **fail-closed**（启动失败，绝不静默降级）；
- 与 `STUDIO_MODE`（startup）和 `STUDIO_DEPLOYMENT_MODE`（部署）**三向隔离**，互不承载。

`ANARCHY_FIRST` 默认语义：

| 字段 | 默认 | 含义 |
|---|---|---|
| unknownPlayerDisposition | **hostile** | 非白名单玩家按敌对处理（确定性白名单判定，非 AI 判断） |
| proactiveCombat | true | 允许主动战斗；仍受 CRITICAL_SURVIVAL / ESCAPE 更高优先级约束 |
| propertyInteraction | unrestricted | 容器/设施自由使用（含先掠夺后使用他人熔炉） |
| resourceAcquisition | unrestricted | 自由资源获取 |
| highIntensityCapabilities | true | NoHunger/PacketMine 等进入默认规划位；实际生效走 capability gate |
| antiCheatAdaptation | adaptive | 按服务器真实纠正/拒绝自适应（存活工程，不是道德） |
| multiBotMode | solo_first | 默认独立行动；协作按真实收益显式开启 |

`standard` profile 仅作对照（local fixture / E2E 可用），不是项目定位。

## 4. 身份与敌对模型（既有事实，重申）

- `packages/combat/src/identity.ts`：确定性白名单——**白名单外玩家按 hostile**，
  白名单（ALLY/OWN_BOT）永不作为敌对目标；UUID 优先，display name 仅展示；
  AI 不做敌我判断（AGENTS.md §0.1 三层架构）。
- 白名单只能由用户显式配置；AI 无权增删。

## 5. 开发准则（新 Skill / 修复 / E2E）

1. 新增 Skill **默认服务 Anarchy-First**（高强度、主动、争夺都是合理需求）；
2. 仍必须有：真实 server truth verification、bounded timeout/retry、
   FailureCode/Incident、版本/服务器 capability gate；
3. 没有真实证据时诚实标 PARTIAL，不因"anarchy 允许"就伪造未实现能力；
4. secrets redaction 与 OperationalSecurity 纪律一字不减；
5. 测试专用安全边界放在 standard/local fixture profile，不影响生产默认。

## 6. 指定无规则服务器

`luv.mc6.cn:22936` —— 用户指定的无规则实战服务器：

```text
serverProfileId = luv_mc6_22936_anarchy
gameplayProfile = anarchy_first
compatibility desiredMode = explicit_unrestricted
unknownPlayerDisposition = hostile
proactiveCombat = true
```

effectiveMode 仍按真实服务器行为自适应降级（保 Bot 不因重复拒绝/踢出失效）。

## 7. 反作弊适配的长期定位

反作弊/服务器限制适配是**无规则服生存能力**，不是和平服限制开关。统一链：
Skill → Capability → Action Policy → Server Compatibility Profile →
Mineflayer/Protocol → Server Truth → Adaptive Feedback。原则见
`packages/skills/src/policy/`（STRICT / VANILLA_COMPATIBLE / ANARCHY 基线）与
AGENTS.md §0。不在每个 Skill 内散落 anti-cheat if；Spark 不决定实时数据包。

# NoHunger 设计与运行说明

## 目标

Bot Runtime 默认启用 `adaptive` NoHunger。它不伪造客户端饱食度，而是在
安全的地面位移窗口减少服务端认可的移动消耗；战斗、生存和 `food.secure`
仍然读取服务端下发的真实 food/saturation，NoHunger 失效时不会出现假成功。

ServerProfile 可覆盖默认值：

```json
{
  "noHunger": {
    "enabled": true,
    "mode": "adaptive"
  }
}
```

省略 `noHunger` 时等价于上面的配置。`enabled: false` 完全恢复原版发包；
`mode: "maximum"` 固定使用最高强度且不自动降级，仅适合已确认无检测的服。

## clean-room 研究依据

- Meteor AntiHunger 同时处理 sprint action 与 movement `onGround`，并明确说明
  功能是减少而非彻底消除所有饥饿消耗：
  <https://github.com/MeteorDevelopment/meteor-client/blob/a2acc0bc480f65023bcfee75ccdcae29154a652e/src/main/java/meteordevelopment/meteorclient/systems/modules/player/AntiHunger.java>
- Wurst AntiHunger 只在真实落地、未明显下落且未挖掘时修改移动包：
  <https://github.com/Wurst-Imperium/Wurst7/blob/master/src/main/java/net/wurstclient/hacks/AntiHungerHack.java>
- Mineflayer 4.37.1 的 physics 插件使用 `position`、`look`、
  `position_look`、`flying`，1.21.3+ 同时携带 `flags.onGround`；本实现同时改写
  旧字段与新字段：
  <https://github.com/PrismarineJS/mineflayer/blob/48f5a513fa483812e9eb0657c47a343f3c0172c5/lib/plugins/physics.js>
- Grim 的 GroundSpoof 会比较客户端声明与预测落地状态，因此永久
  `onGround=false` 不能宣称可稳定绕过现代预测式反作弊：
  <https://github.com/GrimAnticheat/Grim/blob/58c8b92db9d84576b59ea4a86d1aff9f68c7db13/common/src/main/java/ac/grim/grimac/checks/impl/prediction/GroundSpoof.java>

本项目只复现机制并按自己的状态机重写，没有复制 GPL 客户端实现。

## 自适应状态机

`adaptive` 从高到低依次为：

1. `maximum`：平稳地面位移包声明 airborne，并成对隐藏 sprint start/stop。
2. `ground-only`：恢复真实 sprint action，只保留地面字段策略。
3. `pulse`：使用带稳定抖动的低占空比地面脉冲，避免持续固定特征。
4. `vanilla`：完全停止改写，正常进食链继续工作。

连续、且与最近一次改写相关的服务端位置纠正会触发逐级降档；明确的
反作弊告警会立即降档；改写后出现相关踢出则直接记忆为 `vanilla`。
同一服务器在当前进程内共享已学习的最低档位，避免多个 Bot 重复撞检测。

## 强制跳过的危险窗口

以下情况永不主动改写地面状态：落地第一包、垂直速度非零、跳跃、液体、
鞘翅、骑乘、挖掘、无水平移动输入，以及不包含位置的 look/flying 包。
这既保护摔落伤害结算，也避免为没有饥饿收益的包增加检测面。

## 现实边界

NoHunger 的效果和检测规则都由目标服务端决定。预测式反作弊可以识别真实
地面与包声明不一致，因此不存在跨版本、跨插件、可保证不封禁的通用绕过。
`adaptive` 是检测面缩减与自动退避，不是“免封承诺”。正式服仍须按照
隔离服 → 私有测试服 → 单 Bot 灰度的顺序验收。

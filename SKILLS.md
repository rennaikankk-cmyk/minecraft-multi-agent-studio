# 确定性技能目录

本目录只记录已经注册且存在真实 Runtime 适配器的技能。测试夹具和规划中的能力不列为可用技能。

## `movement.goto@1.0.0`

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

当前验证：

- 技能 Schema、授权、范围和前置条件单元测试：已完成。
- Runtime 能力调用与 L0 阻断测试：已完成。
- 真实隔离服路径场景和跨版本矩阵：待完成。

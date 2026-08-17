# CPU Resource Manager Phase 1 Benchmark

日期：2026-08-17  
类型：合成 Resource Scheduler 开销门禁  
结论：Phase 1 轻量性门禁通过；真实 Minecraft OFF/ON 门禁尚未执行，scheduler 继续默认关闭。

## 运行环境

| 项目 | 值 |
|---|---|
| Node.js | 24.19.0 |
| OS / Architecture | Linux / x64 |
| 容器可用逻辑 CPU | 9 |
| CPU 识别 | AMD EPYC，generic fallback |
| P/E 可靠性 | none（未声称 P/E Core） |
| 采样规模 | 40 组（4 个 Bot 数量 × 10 个场景） |
| 每组迭代 | 500 |

## 覆盖矩阵

Bot 数量为 1、5、10、20；场景为 Idle、聊天、移动、采矿、同时寻路、建筑、
大量实体、PvP、自动测试并发和数据库高负载。每组比较 scheduler OFF 的最小控制循环
与 scheduler ON 的注册、指标更新、决策和 commit 路径。

## 结果

| 指标 | 结果 |
|---|---:|
| Scheduler wall-time 开销中位数 | 13.994 µs/tick |
| Scheduler wall-time 开销 P95 | 30.542 µs/tick |
| Scheduler wall-time 开销最大值 | 31.657 µs/tick |
| 40 组 CPU 开销增量合计 | 327,323 µs |
| 默认启用 | false |

该结果表明纯策略层在当前容器中没有出现毫秒级采样开销。它不包含 Mineflayer、真实 Minecraft
服务器、PostgreSQL/Redis、P-Core/E-Core 利用率或跨进程 IPC，因此不能证明实时任务已经改善。

## 尚未完成的真实门禁

在任何默认启用变更前，仍需在 Intel 混合架构实体机执行相同 1/5/10/20 Bot 的 OFF/ON 对照，
并采集：

- P-Core / E-Core utilization；
- event-loop lag、Bot tick/command latency；
- Pathfinder latency、队列深度；
- 数据库和 BullMQ latency；
- RAM、TPS perception、crash 和 timeout。

只有 ON 改善关键实时指标且其他场景没有统计显著退化，才能进入默认启用评审。

## 复现

```bash
pnpm benchmark:cpu-scheduler
```

原始脚本输出版本化 JSON，并明确列出未测量指标。回滚无需代码变更：保持
`CPU_RESOURCE_MANAGER_ENABLED=false`、`CPU_AFFINITY_ENABLED=false` 和
`CPU_SCHEDULER_ENABLED=false`。

# 机器人进程监管器第二阶段性能门禁

日期：2026-08-17
类型：合成空 Host 进程生命周期门禁
结论：1、5、10、20 Bot 的认证启动与停止均无崩溃、无超时；真实 Minecraft 性能门禁尚未执行。

## 一、运行环境

| 项目 | 值 |
|---|---|
| Node.js | 24.19.0 |
| 操作系统 / 架构 | Linux / x64 |
| Bot 数量 | 1、5、10、20 |
| 分组参数 | `botsPerProcess=2` |
| CPU Resource Manager | 默认关闭，普通核心回退 |
| 子进程 | 真实 `child_process.fork` |
| Bot Host | 测试专用空 Host，不连接 Minecraft |

## 二、结果

| Bot 数 | 子进程数 | Supervisor 启动 | Supervisor 停止 | 父进程事件循环单次让出 | 崩溃 | 超时 |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 1 | 344.381 ms | 8.821 ms | 0.022 ms | 0 | 0 |
| 5 | 3 | 395.900 ms | 9.479 ms | 0.033 ms | 0 | 0 |
| 10 | 5 | 429.527 ms | 28.034 ms | 0.031 ms | 0 | 0 |
| 20 | 10 | 773.334 ms | 26.527 ms | 0.020 ms | 0 | 0 |

直接空 Host 对照不创建子进程，启动和停止均低于 0.1 ms。Supervisor 增加的是一次性进程创建、
模块加载、双向认证和清理成本，不是每个 Minecraft tick 的持续开销。当前数据中父进程事件循环
让出延迟未超过 0.033 ms，但单次样本不能替代长时间分位数测试。

## 三、额外恢复门禁

独立真实子进程测试还覆盖一次故意启动失败：首个子进程失败退出后，Supervisor 使用 100 ms
退避预算创建新 PID，第二次认证和启动成功；最终优雅停止，无残留 workload。该场景验证恢复
路径存在，不代表真实 Mineflayer 崩溃原因已经覆盖。

## 四、不能从该结果推出的结论

本次性能门禁没有测量：

- Minecraft 连接和服务器 TPS；
- Bot tick、命令或 Pathfinder 延迟；
- P-Core / E-Core utilization；
- PvP、实体扫描、方块搜索或建筑计算；
- PostgreSQL、Redis、BullMQ 或自动测试并发；
- 子进程自身 RSS 总和和长时间内存稳定性。

因此它只能作为 Phase 2 生命周期回归门禁，不能证明 Scheduler ON 改善性能，也不能据此默认
开启 CPU affinity 或动态调度。

## 五、复现命令

```bash
pnpm benchmark:bot-supervisor
```

DGX Spark 或其他目标主机首次验收时运行完整门禁：

```bash
pnpm validate:phase2-host
```

该命令会额外生成当前主机的 `hardware-profile.json`。只有保存 Spark 实机输出后，才能新增
Linux / ARM64 的实测结果；当前表格仍只代表 Linux / x64 开发环境，不冒充 Spark 数据。

脚本输出版本化 JSON。真实默认启用前仍需在 Intel 混合架构与 4C4T 低端实体机上，使用真实
1/5/10/20 Bot 执行 Idle、移动、采矿、同时寻路、建筑、大量实体、PvP、测试并发和数据库高负载
OFF/ON 对照，并采集 CPU、P/E 利用率、事件循环、Bot/Pathfinder 延迟、RAM、TPS、崩溃和超时。

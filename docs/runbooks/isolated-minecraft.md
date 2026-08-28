# 隔离 Minecraft 联机验收手册

## 适用范围

本手册只用于本机回环地址上的 Minecraft Java 隔离测试服。不得改为公网地址、正式服务器或他人服务器。普通 `pnpm test` 不启动 Minecraft，真实联机必须显式执行验收脚本。

## 准备可信文件

仓库不提交 Minecraft 服务端、Java 运行时、世界存档或本地配置。先运行准备命令，它只会从固定的 Mojang 官方地址取得 1.21.8 服务端并校验 SHA-1/SHA-256，然后生成回环服务端属性和本地 ServerProfile；它不会启动服务端，也不会替用户接受 EULA：

```powershell
pnpm prepare:minecraft
```

准备命令可重复执行。已有 `server.jar` 必须通过双哈希校验，否则命令会失败；已有配置内容不一致时不会静默覆盖。若网络不可用，也可以从 Mojang 官方地址手工取得同一文件后放入 `runtime-data/isolated-test/server/server.jar`，再重新运行命令进行校验。

1. 从 Eclipse Adoptium 官方 GitHub Release 取得固定的 Temurin JDK 21.0.12.1+1 Windows x64 ZIP：`https://github.com/adoptium/temurin21-binaries/releases/download/jdk-21.0.12.1%2B1/OpenJDK21U-jdk_x64_windows_hotspot_21.0.12.1_1.zip`。官方页面列出的 SHA-256 为 `f9d6e191ab098c0d416e7d588a24420a8621cd2f4720dab2459b8b7b2d2d8b4e`；校验成功后才解压到 `runtime-data/isolated-test/java/`。
2. `pnpm prepare:minecraft` 会从 Mojang 固定地址取得 Minecraft Java 1.21.8 `server.jar`，并校验 SHA-1：`6bce4ef400e4efaa63a13d5e6f6b500be969ef81` 和 SHA-256：`2349d9a8f0d4be2c40e7692890ef46a4b07015e7955b075460d02793be7fbbe7`。
3. 不下载、不运行来源不明或哈希不匹配的文件。准备脚本不会自动下载 Java，也不会启动服务端；验收脚本只在所有门禁通过后启动本机回环服务端。
4. 阅读 Minecraft EULA；准备脚本只生成或保留 `eula=false`。只有用户明确接受后，才手工把 `runtime-data/isolated-test/server/eula.txt` 设置为 `eula=true`。脚本不会代替用户接受。

准备运行时前确认 Java 主版本：

```powershell
java -version
```

校验示例：

```powershell
Get-FileHash -LiteralPath '<下载的 JDK 安装包>' -Algorithm SHA256
Get-FileHash -LiteralPath '.\runtime-data\isolated-test\server\server.jar' -Algorithm SHA1
Get-FileHash -LiteralPath '.\runtime-data\isolated-test\server\server.jar' -Algorithm SHA256
```

如果下载被网络策略阻断，不要改用第三方镜像或未固定版本；可在已允许访问官方来源的 Windows 2025 GitHub Runner 上执行同一隔离验收工作流。

## 配置

`pnpm prepare:minecraft` 会生成 `configs/servers/isolated-test.local.json`。修改配置时必须保留 `purpose=isolated-test`、`networkScope=loopback`、`host=127.0.0.1`、`auth=offline` 和 `minecraftVersion=1.21.8`。

```powershell
Get-Content .\configs\servers\isolated-test.local.json
```

`server.properties` 必须满足：

- `server-ip=127.0.0.1`
- `server-port=25565`
- `online-mode=false`
- `enable-rcon=false`
- `enable-query=false`
- `enforce-secure-profile=false`
- `level-name=world`
- `force-gamemode=true`
- `gamemode=survival`
- `spawn-animals=false`
- `spawn-monsters=false`
- `spawn-npcs=false`
- `max-players=2`（内存受限环境只启动两个真实 Bot 并发验收）

## 执行与判定

确认 Java 21 已放在 `runtime-data/isolated-test/java/`（或通过 `MC_TEST_JAVA_EXE` 显式指定）、用户已手工设置 `eula=true` 且 25565 未被占用，然后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-isolated-minecraft-test.ps1
```

成功标准：3 个真实集成测试全部通过，最后出现 `REAL_MINECRAFT_INTEGRATION=PASS` 和 `MINECRAFT_SKILL_ACCEPTANCE=PASS`。脚本验证两个真实 Bot 同时在线、移动、探索、采集、制作、建造、仓储、装备、熔炼、挖矿、庇护所、战斗和自然语言生存闭环，并验证优雅停止、服务端断开和有限重连；只清理本次启动的子进程，不会停止未知的占端口进程。测试代码存在不等于真实运行通过，技能仍保持 `verification=unverified`，直到相应证据门实际完成并登记。

验收输出位于 `runtime-data/isolated-test/acceptance/`，服务端日志位于 `runtime-data/isolated-test/server/logs/`。这些目录均不得提交。

## 世界重置策略

隔离服不需要按固定日期重置，按测试批次和世界污染情况重置：

- 每次完整真实技能验收前，建议使用全新世界，保证坐标、库存和方块状态可重复。
- 日常开发可以复用世界；但测试失败、中断、服务端崩溃，或执行了破坏性场景后，应在下一批测试前重置。
- 当前验收 runner 会在固定夹具区域内清理并重新布置场景，但不会自动删除整个 `server/world`；夹具区域之外的状态可能跨运行保留。
- 重置前必须先正常停止服务端并确认 `25565` 没有监听，再备份或删除 `runtime-data/isolated-test/server/world`。不要在服务端运行时删除世界目录。
- 不需要重置已校验的 Java、`server.jar` 或 ServerProfile；验收 marker 和本次测试输出会由 runner 重新生成，服务端日志保留作证据。

## 结束检查

```powershell
Get-NetTCPConnection -LocalPort 25565 -State Listen -ErrorAction SilentlyContinue
```

无输出表示隔离服已停止。失败时不要连接其他服务器代替验收，按[故障排查手册](./troubleshooting.md)处理。

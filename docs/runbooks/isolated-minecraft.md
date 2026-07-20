# 隔离 Minecraft 联机验收手册

## 适用范围

本手册只用于本机回环地址上的 Minecraft Java 隔离测试服。不得改为公网地址、正式服务器或他人服务器。普通 `pnpm test` 不启动 Minecraft，真实联机必须显式执行验收脚本。

## 准备可信文件

1. 从可信 JDK 发行商的官方站点取得 Java 21，记录发行商、版本、下载地址和官方 SHA-256；校验成功后才解压到 `runtime-data/isolated-test/java/`。
2. 从 Mojang 官方版本清单取得 Minecraft Java 1.21.8 `server.jar`，放到 `runtime-data/isolated-test/server/server.jar`。脚本固定校验 SHA-1：`6bce4ef400e4efaa63a13d5e6f6b500be969ef81`。
3. 不下载、不运行来源不明或哈希不匹配的文件。验收脚本本身不会自动下载依赖。
4. 阅读 Minecraft EULA；只有用户明确接受后，才手工把 `runtime-data/isolated-test/server/eula.txt` 设置为 `eula=true`。脚本不会代替用户接受。

校验示例：

```powershell
Get-FileHash -LiteralPath '<下载的 JDK 安装包>' -Algorithm SHA256
Get-FileHash -LiteralPath '.\runtime-data\isolated-test\server\server.jar' -Algorithm SHA1
```

## 配置

复制配置并保留 `purpose=isolated-test`、`networkScope=loopback`、`host=127.0.0.1`、`auth=offline`。推荐 `minecraftVersion=auto`，由适配器读取目标测试服的真实协议版本。

```powershell
Copy-Item .\configs\servers\isolated-test.example.json .\configs\servers\isolated-test.local.json
```

`server.properties` 必须满足：

- `server-ip=127.0.0.1`
- `server-port=25565`
- `online-mode=false`
- `enable-rcon=false`
- `enable-query=false`
- `enforce-secure-profile=false`

## 执行与判定

确认 25565 未被占用，然后运行：

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\run-isolated-minecraft-test.ps1
```

成功标准：2 个真实集成测试全部通过，最后出现 `REAL_MINECRAFT_INTEGRATION=PASS`。脚本验证真实连接、优雅停止、服务端断开和有限重连，并只清理本次启动的子进程；不会停止未知的占端口进程。

验收输出位于 `runtime-data/isolated-test/acceptance/`，服务端日志位于 `runtime-data/isolated-test/server/logs/`。这些目录均不得提交。

## 结束检查

```powershell
Get-NetTCPConnection -LocalPort 25565 -State Listen -ErrorAction SilentlyContinue
```

无输出表示隔离服已停止。失败时不要连接其他服务器代替验收，按[故障排查手册](./troubleshooting.md)处理。

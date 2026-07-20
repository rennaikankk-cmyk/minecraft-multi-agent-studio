# Minecraft Multi-Agent Studio

面向 Minecraft Java 版多智能体机器人的硬件无关控制平台。

当前已完成项目基线、真实环境检测和版本化 Bot 状态协议：

- 自动检测当前 CPU、内存、操作系统和 GPU 探测状态。
- 检测 Node.js、Java、Docker 和 Git 是否可用。
- 识别标准、Docker、便携和网吧运行模式。
- 通过真实 API 在响应式前端展示检测结果。
- 明确标记 Bot Runtime、Coordinator、Minecraft 测试服和 Local AI Hub 尚未接入。
- 定义并测试 Bot 状态、心跳、断线和安全停止协议 v1。
- 实现只允许隔离测试服的单 Bot Mineflayer Runtime。

当前不会自动连接 Minecraft，不会调用模型，也不会显示模拟 Bot。

仅在显式设置隔离测试服配置并执行 `pnpm bot:start` 时才会尝试连接 Minecraft。

## 环境要求

- Node.js 22 或更高版本
- pnpm 11.9.0

## 安装

```powershell
pnpm install --frozen-lockfile
```

首次生成锁文件的开发环境使用：

```powershell
pnpm install
```

## 启动

```powershell
pnpm dev
```

浏览器打开 `http://localhost:3000`。

## 检查

```powershell
pnpm typecheck
pnpm test
pnpm build
```

生产服务启动后可运行冒烟测试：

```powershell
$env:STUDIO_SMOKE_BASE_URL="http://127.0.0.1:3000"
pnpm smoke
```

## 运行模式

在 `.env` 中设置：

```dotenv
STUDIO_MODE=standard
```

可选值：`standard`、`docker`、`portable`、`netcafe`。

当前模块完成模式识别。Docker 镜像、便携数据迁移，以及网吧模式的 API 训练、成果导出、断点恢复和安全清理将在后续独立模块实现。

## 启动隔离测试 Bot

复制示例配置：

```powershell
Copy-Item .\configs\servers\isolated-test.example.json .\configs\servers\isolated-test.local.json
```

确认配置指向你自己的 Minecraft 1.21.8 隔离测试服，然后运行：

```powershell
$env:BOT_SERVER_PROFILE_PATH="$PWD\configs\servers\isolated-test.local.json"
pnpm bot:start
```

安全限制：

- 当前只允许离线认证的本机或私有局域网测试服。
- 不支持公网地址、正式服务器或配置文件密码。
- 没有设置 `BOT_SERVER_PROFILE_PATH` 时不会尝试连接。
- 当前 Bot 状态只写入脱敏结构化日志，尚未接入 Dashboard。

## 安全说明

- 软件检测使用固定可执行文件和固定参数，不拼接用户输入。
- 子进程明确禁用 Shell。
- 不采集主机名、用户名、IP、密钥或 Minecraft 服务器信息。
- 依赖只允许从官方 npm Registry 下载，并由锁文件记录完整性哈希。
- pnpm 只允许经过审核的 `sharp` 执行安装脚本，其余依赖脚本默认阻止。

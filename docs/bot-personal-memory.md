# Bot 独立记忆

新建离线 Bot 的 `botId` 等于输入的 Minecraft 用户名。新建在线 Bot 先通过受控 `accountRef` 找到本机凭据，经 Microsoft Authflow 取得 Java 档案用户名和 UUID，再绑定 BotID。请求中声明的用户名不能代替认证结果。每次在线启动重新校验用户名/UUID；不匹配则拒绝启动，避免账号更换或改名后沿用旧身份。真实 Microsoft 账号认证仍需单独联机验证。

Manager 内部的 `slotId` 只分配运行进程和密钥，个人身份使用游戏名。受管理 Runtime Link 按本机绑定文件核对 key、BotID 和已授权密钥摘要，握手与消息/指令均重新校验；槽位改绑或移除会拒绝旧会话。独立静态 peer 维持原有配置。旧 manifest 的 `studio-bot-XX` 保留为历史别名，避免静默改写已有数据归属；新建配置使用新规则。当前禁止同一游戏身份同时占用多个本地槽位；停止并移除配置可换服，个人记忆不随配置删除。

新建 Bot 的服务器标识由规范化 hostname 和端口确定，同一服务器上的多个 Bot 使用相同服务器标识；`connectHost` 仅用于 TCP 直连，不改变记忆归属。域名别名或不同端口不会自动合并成一个服务器。

个人观测通过真实 Runtime `bot.status.v1` → Coordinator `BotRegistry.ingest()` 链路写入，按 `serverProfileId + worldId + botId` 隔离。位置同时包含维度。认证、序列、运行实例和服务器范围校验通过后，写入成功才确认消息；损坏文件或磁盘错误不会被当成成功。

已保存背包、护甲装备、最后位置、死亡点及死亡时物资快照、服务器出生点包。未上报背包表示未知；实际空背包会覆盖旧内容。重新启动 Coordinator 后，通过只读接口仍可读取这些历史观测，但不会用旧快照宣称 Bot 在线或允许任务执行。

`worldSpawn` 来自服务器 `spawn_position` 包，只表示服务器发给客户端的出生/指南针位置；不等于个人床。`verifiedRespawn` 仅接受明确服务器确认的床或重生锚观测，当前 Mineflayer 采集链没有这类确认，保持 `null`。进入服务器时站立的位置不会被当成复活点。保留的历史确认始终带原始观测时间，不代表床当前有效。

ServerProfile 可设置 `worldId`，用于明确区分同服重置前后的世界；重置后必须由配置方赋予新值并重启 Runtime。同一 Runtime 不允许修改世界标识。未配置时存为 `null`，系统无法自动识别服务器换档/重置，因此不能承诺这类服务器上的自动世界重置检测。

桌面适配使用文件持久化，公开能力明确为 `durability: "file"`，并非 PostgreSQL。默认目录为 Coordinator 工作目录下的 `runtime-data/personal-memory`，可通过 `STUDIO_PERSONAL_MEMORY_DIR` 指定。文件名是完整身份组合的 SHA-256，避免 Windows 保留文件名和路径注入。每条观测使用临时文件、文件 fsync 和原子 rename；Windows 不声称具备目录 fsync 的掉电保证。仅支持一个 Coordinator 写入该目录。

共享状态服务提供 `GET /personal-memory?botId=<BotID>&serverProfileId=<ServerProfileID>&worldId=<世界标识>`，响应通过 `botPersonalMemoryResponseV1Schema` 校验。未知世界标识时省略 `worldId`。必须配置并提供 `STUDIO_SHARED_STATE_TOKEN` 的 Bearer 认证，即使在回环地址也不开放匿名读取。服务端必须收到具体 Bot 和服务器，不提供跨服通配读取。返回 `freshness: "historical"`；无对应记忆返回 `memory: null`。个人记忆不加入普通 `/snapshot` 或公开 Bot 列表。

身份与记忆专项验证使用单元测试、临时磁盘重启恢复和回环 HTTP/WebSocket。目标服务器联机证据另行记录，不能由这些测试推断床绑定、完整生存或长期驻留已完成。

为连接协议 775，依赖已锁定到 Mineflayer 4.39.0、minecraft-protocol 1.67.0 和 minecraft-data 3.114.0。统一 minecraft-data 版本，避免某些传递依赖继续使用缺少 26.1 协议定义的旧数据。prismarine-chunk 锁定 1.41.0，并保留原有光照小端序补丁；没有跳过该修复。回环握手矩阵覆盖 1.8.8、1.12.2、1.16.5、1.21.11 和 26.1.2，协议 775 的适配器版本归一为 26.1。

最终 `pnpm check` 退出码 0，包含完整类型检查、全部工作区测试和构建：Runtime 586 通过 / 6 跳过、Coordinator 607 通过及 5 个跨进程测试、Manager/身份 47 通过。既有跳过的基础设施场景仍是跳过状态；完整 Windows SEA EXE 和真实 Microsoft 账号尚未实测。

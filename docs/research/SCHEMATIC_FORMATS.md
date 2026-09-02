# Schematic Format Research（BASE-AUTO §五）

> .schem / .litematic / vanilla .nbt 解析与安全约束。2026-09-03 访问。

## 1. 格式对比

| 格式 | 压缩 | 结构 | palette | 索引 | 稀疏/稠密 |
|---|---|---|---|---|---|
| Sponge .schem v3 | GZip NBT | `Schematic` root compound | `Blocks.Palette`: block-state string→Int | `Blocks.Data`: varint Byte Array (YZX) | 稠密 |
| Sponge .schem v2 | 同 | 同 v3 但 palette/data 顶层 | `Palette`: string→Int | `BlockData`: varint | 稠密 |
| .litematic | GZip NBT | `Regions.{name}` compound | `BlockStatePalette`: List<{Name,Properties}> | `BlockStates`: Long Array（位打包，**不跨 long 边界**） | 稠密 |
| vanilla .nbt | GZip NBT | root compound | `palette`: List<{Name,Properties}> | `blocks`: sparse List<{pos,state,nbt}> | **稀疏** |

## 2. 推荐解析方案

**NBT 层**：`prismarine-nbt`（已有 workspace 依赖，支持 big/little/varint endian、自动 gzip/zlib）。

**.schem 层**：
- `prismarine-schematic`（PrismarineJS，Sponge R/W + mineflayer 集成）
- 或 `@enginehub/schematicjs`（WorldEdit 团队 TypeScript，Sponge+vanilla）

**.litematic 层**：无可靠维护的 npm 库 → **自写 ~150 行 parser**（prismarine-nbt 上层）。关键坑：
- `BlockStates` 位打包**不跨 64-bit long 边界**（每个 long 独立填充）
- bits/entry = `max(2, ceil(log2(palette.size)))`，palette 增长时 bits 递增
- 索引序 YZX：`y*(sizeZ*sizeX) + z*sizeX + x`
- `Size` 分量可为负（负=原点在 max 角）

**vanilla .nbt**：最简（显式位置稀疏列表），适合小型模板。

## 3. 安全约束（parser 必须强制）

| 约束 | 上限 | 原因 |
|---|---|---|
| 压缩文件大小 | 50 MB | 防内存耗尽 |
| 解压输出 | `zlib.createGunzip({maxOutputLength})` 流式 | 防 gzip 炸弹（CWE-409）|
| NBT 嵌套深度 | 512 | MC 自身限制；prismarine-nbt 递归下降需包裹 depth check |
| palette 大小 | 4096 entries | 合理方块种类上限 |
| cells 总数 | 2048 | 与 FacilityPlatform 上限对齐 |
| 声称尺寸 vs 实际数据 | 严格等长 `Width×Height×Length` | 防 65535³ OOM |
| palette 索引 | < palette.size() | 防越界 |
| BlockEntities/Entities | 丢弃不必要 NBT payload | 防嵌套炸弹 |
| 坐标偏移 | ±30M（MC 世界边界）| 防异常放置 |
| 未知方块 | **fail-closed 拒绝** | 不猜不替代 |

## 4. 版本映射

- `DataVersion`（.schem/vanilla）或 `MinecraftDataVersion`（.litematic）标识源版本
- 关键值：1343=1.12.2, 2586=1.16.5, 3465=1.20.1, 4189=1.21.4
- palette 存字符串 block state（非数字 ID）→ 用 `minecraft-data` npm 按版本解析 Name+Properties
- **不做跨版本 DataFixer**（Mojang DataFixerUpper 是 Java-only）→ 目标版本 palette 不认识的条目 fail-closed

## 5. Canonical 转换管道

```
External (.schem/.litematic/.nbt)
→ readFileSync (≤50MB)
→ zlib gunzip (streaming, maxOutputLength)
→ prismarine-nbt.parse (depth ≤512)
→ format-specific extraction (palette + indices)
→ block state resolve via minecraft-data (target version)
→ canonical cells (purpose/phase 自动标注)
→ material list
→ SHA-256 content hash
→ FacilityTemplateManifest
```

## 6. 来源

- Sponge Schematic Specification v3 — https://github.com/SpongePowered/Schematic-Specification/blob/master/versions/schematic-3.md
- Litematica format — https://github.com/maruohon/litematica/issues/53
- litemapy format docs — https://litemapy.readthedocs.io/en/latest/litematics.html
- Vanilla structure file — https://minecraft.wiki/w/Structure_block_file_format
- prismarine-nbt — https://github.com/PrismarineJS/prismarine-nbt
- prismarine-schematic — https://www.npmjs.com/package/prismarine-schematic
- SchematicJS — https://github.com/EngineHub/SchematicJS
- NBT 格式（深度限制 512）— https://minecraft.wiki/w/NBT_format
- Data Version 表 — https://minecraft.wiki/w/Data_version

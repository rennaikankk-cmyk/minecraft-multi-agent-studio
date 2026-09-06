// spark-strategy-v1/facts.ts —— 作用域化团队事实输入（无 I/O 副作用）。
//
// 设计纪律（一期指令 §4）：
//  - unknown 是一等值：未知库存/设施/死亡次数表达为 "unknown"，
//    绝不能被转换成 0/false/已完成（上游 deaths:0 占位的教训）。
//  - 一个事实快照限定一个 serverProfileId + dimension；跨服务器/维度
//    混用与过期快照在构建入口拒绝（fail-closed）。
//  - 隐私：基地/设施/资源点一律用不透明引用（facilityId），本层类型
//    根本不携带坐标；自由文本过 scrubFreeText 脱敏。
//  - factVersion：规范化输入的确定性指纹（FNV-1a 64 hex）——建议与
//    事实的版本绑定基础。

import { z } from "zod";

/** 可 unknown 化字段：值或字面 "unknown"（模型输入/fixture 友好）。 */
export const unknownable = <T extends z.ZodTypeAny>(inner: T) =>
  z.union([inner, z.literal("unknown")]);

export const scopeSchema = z.object({
  serverProfileId: z.string().min(1),
  dimension: z.string().min(1),
  /** 可选身份锚点（epoch/session/version 等有效身份信息；缺省=未提供）。 */
  sessionEpoch: z.number().int().nonnegative().optional(),
  snapshotId: z.string().min(1).optional(),
  /** 事实观测时间（ms epoch）。 */
  observedAtMs: z.number().int().nonnegative(),
});

export type Scope = z.infer<typeof scopeSchema>;

export const inventoryItemSchema = z.object({
  itemName: z.string().min(1),
  count: z.number().int().nonnegative(),
});
export type InventoryItem = z.infer<typeof inventoryItemSchema>;

/** 设施/资源点不透明引用（无坐标；由可信代码解析物理位置）。 */
export const facilitySchema = z.object({
  facilityId: z.string().min(1),
  kind: z.string().min(1), // farm / furnace / storage / ...
  status: z.enum(["available", "busy", "unknown"]),
  heldByBotId: z.string().min(1).optional(),
});
export type Facility = z.infer<typeof facilitySchema>;

export const reservedResourceSchema = z.object({
  resource: z.string().min(1),
  heldByBotId: z.string().min(1),
});
export type ReservedResource = z.infer<typeof reservedResourceSchema>;

export const botFactsSchema = z.object({
  botId: z.string().min(1),
  online: z.boolean(),
  /** null=空闲；对象=任务中；"unknown"=状态未知。 */
  currentTask: z.union([
    z.object({
      goalText: z.string().min(1),
      phase: z.string().min(1),
      progressNote: z.string().optional(),
    }),
    z.null(),
    z.literal("unknown"),
  ]),
  survival: z.object({
    health: unknownable(z.number().nonnegative()),
    food: unknownable(z.number().int().nonnegative()),
    armorPoints: unknownable(z.number().int().nonnegative()),
  }),
  inventory: unknownable(z.array(inventoryItemSchema)),
  /** 死亡计数：未知必须保持 unknown（不得填 0）。 */
  deaths: unknownable(z.number().int().nonnegative()),
});
export type BotFacts = z.infer<typeof botFactsSchema>;

export const teamFactsSchema = z.object({
  sharedInventory: unknownable(z.array(inventoryItemSchema)),
  facilities: unknownable(z.array(facilitySchema)),
  shortages: z.array(z.string().min(1)),
  reservedResources: z.array(reservedResourceSchema),
});
export type TeamFacts = z.infer<typeof teamFactsSchema>;

export const scopedEventSchema = z.object({
  kind: z.enum(["failure", "completion", "interruption", "death", "other"]),
  atMs: z.number().int().nonnegative(),
  /** 事件来源（引用），如 incident fingerprint / 日志通道名。 */
  source: z.string().min(1),
  botId: z.string().min(1).optional(),
  detail: z.string(),
});
export type ScopedEvent = z.infer<typeof scopedEventSchema>;

export const capabilityEntrySchema = z.object({
  skillId: z.string().min(1),
  supported: z.boolean(),
  maturity: z.string().min(1).optional(),
});
export type CapabilityEntry = z.infer<typeof capabilityEntrySchema>;

export const phaseGateSchema = z.object({
  gate: z.string().min(1),
  botId: z.string().min(1).optional(),
  satisfied: unknownable(z.boolean()),
});
export type PhaseGate = z.infer<typeof phaseGateSchema>;

export const constraintsSchema = z.object({
  capabilities: z.array(capabilityEntrySchema),
  phaseGates: z.array(phaseGateSchema),
  /** 不可被建议改派的 bot（任务仍活跃且不可抢占）。 */
  nonPreemptibleBots: z.array(z.string().min(1)),
  /** 允许建议更改的范围描述（自由文本，进入摘要）。 */
  allowedChangeScope: z.string().min(1),
});
export type Constraints = z.infer<typeof constraintsSchema>;

export const teamFactsInputSchema = z.object({
  scope: scopeSchema,
  capturedAtMs: z.number().int().nonnegative(),
  bots: z.array(botFactsSchema).min(1),
  team: teamFactsSchema,
  events: z.array(scopedEventSchema),
  constraints: constraintsSchema,
  /** 来源引用（导出文件/查询通道；进入报告不进入模型提示）。 */
  sourceRefs: z.array(z.string().min(1)).optional(),
});
export type TeamFactsInput = z.infer<typeof teamFactsInputSchema>;

export class FactsError extends Error {
  constructor(readonly code: "SCOPE_MISSING" | "SCHEMA_INVALID", message: string) {
    super(message);
    this.name = "FactsError";
  }
}

/** 解析并校验事实输入：作用域身份缺失=拒绝（不出可执行建议的基础）。 */
export function parseTeamFactsInput(raw: unknown): TeamFactsInput {
  const parsed = teamFactsInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new FactsError("SCHEMA_INVALID", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const scope = parsed.data.scope;
  if (scope.serverProfileId.trim().length === 0 || scope.dimension.trim().length === 0) {
    throw new FactsError("SCOPE_MISSING", "serverProfileId and dimension are required for an actionable snapshot");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// 确定性 factVersion（FNV-1a 64，canonical JSON：键排序、无空白）。
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = (1n << 64n) - 1n;

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function factVersion(input: TeamFactsInput): string {
  const canonical = canonicalJson({
    scope: input.scope,
    capturedAtMs: input.capturedAtMs,
    bots: input.bots,
    team: input.team,
    events: input.events,
    constraints: input.constraints,
  });
  let h = FNV_OFFSET;
  for (const byte of Buffer.from(canonical, "utf8")) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, "0");
}

// ---------------------------------------------------------------------------
// 自由文本脱敏：URL/长十六进制（疑似 token/fingerprint 全文）替换为占位。
// ---------------------------------------------------------------------------

export function scrubFreeText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "[URL_REDACTED]")
    .replace(/\b[0-9a-f]{16,}\b/gi, "[HEX_REDACTED]");
}

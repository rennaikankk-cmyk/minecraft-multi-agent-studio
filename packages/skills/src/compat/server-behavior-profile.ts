import { z } from "zod";

// ---------------------------------------------------------------------------
// Round 7 —— Anti-Cheat Compatibility Domain Model（单一事实源）。
//
// 与既有层的关系（不重复、不平行）：
// - packages/skills/src/policy/server-policy.ts 的 ServerPolicy/Limits 是
//   "每服已验证的具体数值边界"（reach/CPS/转头速率）——本模块引用它，不复制；
// - 本模块回答的是"当前用什么兼容模式、为什么、证据是什么、如何升降"：
//   desired/effective mode、modeSource、confidence、观测计数、降级原因。
//
// 语义纪律：
// - EXPLICIT_UNRESTRICTED 只能由 operator 对授权服务器显式开启
//   （modeSource=operator）；观测不到限制 ≠ 自动进入。
// - UNKNOWN 默认保守（映射既有 STRICT 基线）并 fail-closed。
// - absence of evidence 不是"没有限制"的证据。
// ---------------------------------------------------------------------------

export const SERVER_COMPATIBILITY_MODES = [
  "VANILLA",
  "CONSERVATIVE",
  "ADAPTIVE",
  "EXPLICIT_UNRESTRICTED",
  "UNKNOWN_FAIL_CLOSED",
] as const;
export type ServerCompatibilityMode = (typeof SERVER_COMPATIBILITY_MODES)[number];

export const MODE_SOURCES = [
  "operator",
  "validated_profile",
  "adaptive_fallback",
  "default",
] as const;
export type CompatibilityModeSource = (typeof MODE_SOURCES)[number];

export const ACTION_FAMILIES = [
  "MOVEMENT",
  "ROTATION",
  "DIGGING",
  "PLACEMENT",
  "INVENTORY",
  "CONTAINER",
  "CRAFTING",
  "SMELTING",
  "MELEE_ATTACK",
  "PROJECTILE",
  "EXPLOSIVE_COMBAT",
  "PACKET_INTENSIVE",
  "CHAT_COMMAND",
] as const;
export type ActionFamily = (typeof ACTION_FAMILIES)[number];

export const ACTION_RISKS = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type ActionRisk = (typeof ACTION_RISKS)[number];

export const COMPAT_PROFILE_SCHEMA_VERSION = "1.0" as const;

export const featureGateSchema = z
  .object({
    feature: z.enum([
      "NO_HUNGER",
      "PACKET_MINE",
      "RAPID_DIG",
      "RAPID_PLACE",
      "FAST_ROTATION",
      "EXPLOSIVE_CRYSTAL",
      "RESPAWN_ANCHOR_COMBAT",
      "HIGH_RATE_MELEE",
    ]),
    desiredState: z.boolean(),
    effectiveState: z.boolean(),
    source: z.enum(["operator", "compat-check", "probe", "default"]),
    risk: z.enum(ACTION_RISKS),
    disableReason: z.string().min(1).max(200).nullable(),
    lastValidatedAt: z.string().nullable(),
    /** 重新验证前的冷却（ms）；CRITICAL 门被拒后保持关闭直至 operator。 */
    revalidationCooldownMs: z.number().int().min(0).max(86_400_000),
  })
  .strict();
export type FeatureGate = z.infer<typeof featureGateSchema>;

export const serverBehaviorProfileSchema = z
  .object({
    schemaVersion: z.literal(COMPAT_PROFILE_SCHEMA_VERSION),
    profileId: z.string().min(1).max(128),
    serverProfileId: z.string().min(1).max(128),
    minecraftVersion: z.string().min(1).max(32).nullable(),
    protocolVersion: z.number().int().nullable(),
    serverBrand: z.string().min(1).max(128).nullable(),
    desiredMode: z.enum(SERVER_COMPATIBILITY_MODES),
    effectiveMode: z.enum(SERVER_COMPATIBILITY_MODES),
    modeSource: z.enum(MODE_SOURCES),
    /** 0..1 的确定性置信度（样本量与窗口稳定性的函数，非模型打分）。 */
    confidence: z.number().min(0).max(1),
    firstObservedAt: z.string(),
    lastObservedAt: z.string(),
    expiresAt: z.string().nullable(),
    sampleCount: z.number().int().min(0),
    networkBaseline: z
      .object({
        pingMs: z.number().min(0).nullable(),
        jitterMs: z.number().min(0).nullable(),
        timeouts: z.number().int().min(0),
      })
      .strict(),
    /** 每 ActionFamily 的拒绝/纠正计数（rolling window 内）。 */
    actionFamilySignals: z.record(
      z.string(),
      z.object({
        corrections: z.number().int().min(0),
        rejections: z.number().int().min(0),
        divergences: z.number().int().min(0),
      }),
    ),
    featureGates: z.array(featureGateSchema),
    downgradeReason: z.string().min(1).max(200).nullable(),
    recoveryReason: z.string().min(1).max(200).nullable(),
    evidenceRefs: z.array(z.string().min(1).max(128)).max(64),
    validationCommit: z.string().min(1).max(64).nullable(),
    buildVersion: z.string().min(1).max(64).nullable(),
    revision: z.number().int().min(0),
  })
  .strict();
export type ServerBehaviorProfile = z.infer<typeof serverBehaviorProfileSchema>;

export class CompatibilityProfileError extends Error {
  readonly code = "COMPAT_PROFILE_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "CompatibilityProfileError";
  }
}

/** 各模式映射到的既有 ServerPolicy 基线档名（单一映射，防双轨）。 */
export const MODE_TO_BASELINE: Readonly<
  Record<ServerCompatibilityMode, "STRICT" | "VANILLA_COMPATIBLE" | "ANARCHY">
> = Object.freeze({
  VANILLA: "VANILLA_COMPATIBLE",
  CONSERVATIVE: "STRICT",
  ADAPTIVE: "STRICT",
  EXPLICIT_UNRESTRICTED: "ANARCHY",
  UNKNOWN_FAIL_CLOSED: "STRICT",
});

/**
 * 解析 desired/effective 模式。优先级：operator 显式配置（含
 * EXPLICIT_UNRESTRICTED 许可）> validated profile > 默认 UNKNOWN_FAIL_CLOSED。
 * 非法值 fail-closed；EXPLICIT_UNRESTRICTED 无法从 default/adaptive 来源获得。
 */
export function resolveCompatibilityMode(input: Readonly<{
  operatorConfigured?: string | null | undefined;
  operatorAllowsUnrestricted?: boolean;
  validatedProfileMode?: ServerCompatibilityMode | null | undefined;
}>): { desired: ServerCompatibilityMode; effective: ServerCompatibilityMode; source: CompatibilityModeSource } {
  const raw = input.operatorConfigured?.trim() ?? "";
  if (raw.length > 0) {
    if (!(SERVER_COMPATIBILITY_MODES as readonly string[]).includes(raw)) {
      throw new CompatibilityProfileError(
        `STUDIO_SERVER_COMPATIBILITY is invalid: ${raw} (expected one of ${SERVER_COMPATIBILITY_MODES.join("|")}). Refusing to start with an ambiguous compatibility mode.`,
      );
    }
    const mode = raw as ServerCompatibilityMode;
    if (mode === "EXPLICIT_UNRESTRICTED" && input.operatorAllowsUnrestricted !== true) {
      throw new CompatibilityProfileError(
        "EXPLICIT_UNRESTRICTED requires explicit operator authorization for a designated server; refusing to enable it implicitly.",
      );
    }
    return { desired: mode, effective: mode, source: "operator" };
  }
  if (input.validatedProfileMode !== null && input.validatedProfileMode !== undefined) {
    // validated profile 永远不携带 EXPLICIT_UNRESTRICTED（那是 operator 专属）
    const mode =
      input.validatedProfileMode === "EXPLICIT_UNRESTRICTED"
        ? ("VANILLA" as ServerCompatibilityMode)
        : input.validatedProfileMode;
    return { desired: mode, effective: mode, source: "validated_profile" };
  }
  return { desired: "UNKNOWN_FAIL_CLOSED", effective: "UNKNOWN_FAIL_CLOSED", source: "default" };
}

/** 新 profile 骨架（revision 0，等待观测填充）。 */
export function newBehaviorProfile(input: Readonly<{
  serverProfileId: string;
  desired: ServerCompatibilityMode;
  effective: ServerCompatibilityMode;
  source: CompatibilityModeSource;
  minecraftVersion?: string | null;
  protocolVersion?: number | null;
  serverBrand?: string | null;
  featureGates?: readonly Partial<FeatureGate>[];
}>): ServerBehaviorProfile {
  const now = new Date().toISOString();
  const gates: FeatureGate[] = (input.featureGates ?? []).map((gate) =>
    featureGateSchema.parse({
      feature: gate.feature,
      desiredState: gate.desiredState ?? false,
      effectiveState: false,
      source: gate.source ?? "default",
      risk: gate.risk ?? "HIGH",
      disableReason: gate.desiredState ? "compat-check pending" : "operator disabled",
      lastValidatedAt: null,
      revalidationCooldownMs: 60_000,
    }),
  );
  return {
    schemaVersion: COMPAT_PROFILE_SCHEMA_VERSION,
    profileId: `compat-${input.serverProfileId}`,
    serverProfileId: input.serverProfileId,
    minecraftVersion: input.minecraftVersion ?? null,
    protocolVersion: input.protocolVersion ?? null,
    serverBrand: input.serverBrand ?? null,
    desiredMode: input.desired,
    effectiveMode: input.effective,
    modeSource: input.source,
    confidence: 0,
    firstObservedAt: now,
    lastObservedAt: now,
    expiresAt: null,
    sampleCount: 0,
    networkBaseline: { pingMs: null, jitterMs: null, timeouts: 0 },
    actionFamilySignals: {},
    featureGates: gates,
    downgradeReason: null,
    recoveryReason: null,
    evidenceRefs: [],
    validationCommit: null,
    buildVersion: null,
    revision: 0,
  };
}

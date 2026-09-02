import { z } from "zod";

// ---------------------------------------------------------------------------
// Gameplay Policy —— 项目产品定位的单一事实源（Round 8 / Anarchy-First 迁移）。
//
// 与既有配置的隔离（不可混用）：
// - STUDIO_MODE：startup 形态（normal/local_test/e2e）——进程怎么起；
// - STUDIO_DEPLOYMENT_MODE：部署形态——进程跑在哪；
// - STUDIO_GAMEPLAY_PROFILE（本模块）：产品行为边界——Bot 在游戏世界里
//   如何对待未知玩家、财产、资源与高强度能力。
//
// 优先级：ServerProfile override > operator env > 项目默认（anarchy_first）。
// 未知/非法值 fail-closed：启动失败，绝不静默落到其它策略。
//
// 边界分类纪律（docs/anarchy-charter.md）：
// - BotSurvivalSafety（图腾/防自伤/撤退）与 OperationalSecurity（主机/凭据/
//   外部服务器管理边界）不受 profile 影响，永远保留；
// - 本模块只承载 GameplayRestraint 的迁移：ANARCHY_FIRST 下不限制 PvP/
//   财产交互/资源获取，STANDARD 保留对照行为。
// ---------------------------------------------------------------------------

export const STUDIO_GAMEPLAY_PROFILES = [
  "anarchy_first",
  "standard",
  "custom",
] as const;
export type StudioGameplayProfile = (typeof STUDIO_GAMEPLAY_PROFILES)[number];

export const PLAYER_DISPOSITIONS = ["hostile", "neutral", "avoid"] as const;
export type PlayerDisposition = (typeof PLAYER_DISPOSITIONS)[number];

export const PROPERTY_INTERACTION_MODES = ["unrestricted", "owned_only", "disabled"] as const;
export type PropertyInteractionMode = (typeof PROPERTY_INTERACTION_MODES)[number];

export const RESOURCE_ACQUISITION_MODES = ["unrestricted", "unclaimed_only", "disabled"] as const;
export type ResourceAcquisitionMode = (typeof RESOURCE_ACQUISITION_MODES)[number];

export const ANTICHEAT_ADAPTATION_MODES = ["adaptive", "conservative", "disabled"] as const;
export type AntiCheatAdaptationMode = (typeof ANTICHEAT_ADAPTATION_MODES)[number];

export const MULTI_BOT_MODES = ["solo_first", "cooperative", "custom"] as const;
export type MultiBotMode = (typeof MULTI_BOT_MODES)[number];

export const GAMEPLAY_POLICY_SCHEMA_VERSION = "1.0" as const;

export const gameplayPolicySchema = z
  .object({
    schemaVersion: z.literal(GAMEPLAY_POLICY_SCHEMA_VERSION),
    profile: z.enum(STUDIO_GAMEPLAY_PROFILES),
    /** 未知玩家处置：ANARCHY_FIRST 默认 hostile（非白名单即可主动攻击）。 */
    unknownPlayerDisposition: z.enum(PLAYER_DISPOSITIONS),
    /** 是否允许主动战斗（抢占普通任务；仍受 CRITICAL_SURVIVAL/ESCAPE 高优先级约束）。 */
    proactiveCombat: z.boolean(),
    /** 财产交互：开箱/使用他人设施/破坏。 */
    propertyInteraction: z.enum(PROPERTY_INTERACTION_MODES),
    /** 资源获取：采集/掠夺边界。 */
    resourceAcquisition: z.enum(RESOURCE_ACQUISITION_MODES),
    /** 高强度能力（NoHunger/PacketMine/水晶/锚等）默认规划位；实际生效仍走 capability gate。 */
    highIntensityCapabilities: z.boolean(),
    /** 反作弊适配：adaptive=按 server truth 自适应；与 BotSurvivalSafety 无关。 */
    antiCheatAdaptation: z.enum(ANTICHEAT_ADAPTATION_MODES),
    /** 多 Bot 默认独立行动；协作按收益显式开启。 */
    multiBotMode: z.enum(MULTI_BOT_MODES),
    /** 生效来源："project-default" | "operator-env" | "server-profile"。 */
    source: z.string().min(1).max(64),
    /** 配置修订标识（审计用；非秘密）。 */
    revision: z.string().min(1).max(64),
  })
  .strict();
export type GameplayPolicy = z.infer<typeof gameplayPolicySchema>;

export const ANARCHY_FIRST_DEFAULT_POLICY: Readonly<GameplayPolicy> = Object.freeze({
  schemaVersion: GAMEPLAY_POLICY_SCHEMA_VERSION,
  profile: "anarchy_first",
  unknownPlayerDisposition: "hostile",
  proactiveCombat: true,
  propertyInteraction: "unrestricted",
  resourceAcquisition: "unrestricted",
  highIntensityCapabilities: true,
  antiCheatAdaptation: "adaptive",
  multiBotMode: "solo_first",
  source: "project-default",
  revision: "anarchy-first-v1",
});

export const STANDARD_DEFAULT_POLICY: Readonly<GameplayPolicy> = Object.freeze({
  schemaVersion: GAMEPLAY_POLICY_SCHEMA_VERSION,
  profile: "standard",
  unknownPlayerDisposition: "neutral",
  proactiveCombat: false,
  propertyInteraction: "owned_only",
  resourceAcquisition: "unclaimed_only",
  highIntensityCapabilities: false,
  antiCheatAdaptation: "conservative",
  multiBotMode: "solo_first",
  source: "project-default",
  revision: "standard-v1",
});

export class GameplayPolicyError extends Error {
  readonly code = "GAMEPLAY_POLICY_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "GameplayPolicyError";
  }
}

export function isStudioGameplayProfile(value: string): value is StudioGameplayProfile {
  return (STUDIO_GAMEPLAY_PROFILES as readonly string[]).includes(value);
}

/**
 * 解析生效 GameplayPolicy。优先级：serverProfile override > operator env >
 * 项目默认（anarchy_first）。非法 env 值 fail-closed 抛错——绝不静默降级。
 * custom profile 必须由 override 显式提供（无自定义内容的 custom = 配置错误）。
 */
export function resolveGameplayPolicy(input: Readonly<{
  environment?: Readonly<Record<string, string | undefined>> | undefined;
  serverProfileOverride?: Partial<Omit<GameplayPolicy, "schemaVersion">> | null;
}>): GameplayPolicy {
  const env = (input.environment ?? {}) as Record<string, string | undefined>;
  const rawProfile = env.STUDIO_GAMEPLAY_PROFILE?.trim() ?? "";
  const override = input.serverProfileOverride ?? null;

  // 1) profile 判定：override.profile > env > 默认 anarchy_first
  let profile: StudioGameplayProfile;
  let source: string;
  if (override?.profile !== undefined && override.profile !== null) {
    if (!isStudioGameplayProfile(override.profile)) {
      throw new GameplayPolicyError(
        `ServerProfile gameplay profile is invalid: ${String(override.profile)}`,
      );
    }
    profile = override.profile;
    source = "server-profile";
  } else if (rawProfile.length > 0) {
    if (!isStudioGameplayProfile(rawProfile)) {
      throw new GameplayPolicyError(
        `STUDIO_GAMEPLAY_PROFILE is invalid: ${rawProfile} (expected one of ${STUDIO_GAMEPLAY_PROFILES.join("|")}). Refusing to start with an ambiguous gameplay boundary.`,
      );
    }
    profile = rawProfile;
    source = "operator-env";
  } else {
    profile = "anarchy_first";
    source = "project-default";
  }

  // 2) 基线按 profile 选择
  const base =
    profile === "anarchy_first"
      ? ANARCHY_FIRST_DEFAULT_POLICY
      : profile === "standard"
        ? STANDARD_DEFAULT_POLICY
        : null;
  if (base === null) {
    // custom：override 必须给出全部策略字段（部分字段=配置不完整，fail-closed）
    if (override === null || override.profile !== "custom") {
      throw new GameplayPolicyError(
        "custom gameplay profile requires a complete server-profile override.",
      );
    }
    const parsed = gameplayPolicySchema.safeParse({
      ...override,
      schemaVersion: GAMEPLAY_POLICY_SCHEMA_VERSION,
      source: "server-profile",
      revision: override.revision ?? "custom-v1",
    });
    if (!parsed.success) {
      throw new GameplayPolicyError(
        `custom gameplay policy is incomplete: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
    }
    return parsed.data;
  }

  // 3) 非 profile 字段的 override 逐项覆盖（仅 server-profile 来源允许）
  if (source === "server-profile" && override !== null) {
    const merged = {
      ...base,
      ...Object.fromEntries(
        Object.entries(override).filter(([, v]) => v !== undefined && v !== null),
      ),
      profile,
      schemaVersion: GAMEPLAY_POLICY_SCHEMA_VERSION,
      source: "server-profile",
      revision: override.revision ?? base.revision,
    } as GameplayPolicy;
    const parsed = gameplayPolicySchema.safeParse(merged);
    if (!parsed.success) {
      throw new GameplayPolicyError(
        `server-profile gameplay override is invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
      );
    }
    return parsed.data;
  }
  return { ...base, profile, source };
}

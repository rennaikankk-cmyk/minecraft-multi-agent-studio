import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

// ---------------------------------------------------------------------------
// ServerPolicy —— 每服独立的"经验证能力边界"。
//
// 目标是**兼容**，不是绕过反作弊：让确定性动作层主动把自己限制在服务器实际
// 接受的范围内，从而不被 correction/warning/kick 打断，也不因为超界动作把
// 账号送进风险区。所以这里的每个上限都是"我们自愿不越过的线"，越保守越安全，
// 任何放宽都必须有该服的实测证据（见 boundary-probe.ts）。
//
// 两类参数必须分清，不能混为一谈：
//   1. 原版机制硬事实（reach 距离）——有确定数值，来自公开的原版交互属性。
//   2. 原版**没有**约束、只有反作弊插件才会管的项（每 tick 转头角度、CPS、
//      动作间隔）——原版无上限，所以这里的数值是**本项目自定的保守假设**，
//      在该服实测之前不得当作"该服的真实边界"。字段注释逐条标明属于哪一类。
// ---------------------------------------------------------------------------

/**
 * 原版方块交互距离（生存模式）。1.20.5 起为 `block_interaction_range`
 * 属性，默认 4.5 格；此前硬编码同值。属"机制硬事实"。
 */
export const VANILLA_BLOCK_INTERACTION_REACH = 4.5;

/**
 * 原版实体交互/攻击距离。1.20.5 起为 `entity_interaction_range` 属性，
 * 默认 3.0 格。注意服务端对攻击包的校验比这个宽（历史上按 6 格平方距离
 * 兜底），但我们按**客户端合法值 3.0** 自限，不吃那段宽容度。
 */
export const VANILLA_ENTITY_ATTACK_REACH = 3.0;

/** Minecraft 服务器逻辑帧长度，一切"每 tick"限额的基准。 */
export const MINECRAFT_TICK_MS = 50;

export const antiCheatCompatibilityProfiles = [
  /** 最保守：假设服务器装了严格反作弊，未知服的默认档。 */
  "STRICT",
  /** 贴原版机制硬事实，速率仍保守。 */
  "VANILLA_COMPATIBLE",
  /** 已确认宽容的服，仍不超过原版机制。 */
  "NORMAL",
  /** 只能由该服实测证据生成，不得手写放宽。 */
  "CUSTOM_VERIFIED",
] as const;

export type AntiCheatCompatibilityProfile =
  (typeof antiCheatCompatibilityProfiles)[number];

/**
 * 有内置基线限额的档位。`CUSTOM_VERIFIED` 被刻意排除在外：它只能由该服实测
 * 证据生成，没有"内置数值"可取，所以类型层面就不允许拿它去查基线表。
 */
export type BaselineAntiCheatProfile = Exclude<
  AntiCheatCompatibilityProfile,
  "CUSTOM_VERIFIED"
>;

export const antiCheatCompatibilityProfileSchema = z.enum(
  antiCheatCompatibilityProfiles,
);

/**
 * 保守程度排序（下标越小越保守）。放宽一个档位必须有证据；收紧永远允许。
 */
const PROFILE_CONSERVATISM_ORDER: readonly BaselineAntiCheatProfile[] = [
  "STRICT",
  "VANILLA_COMPATIBLE",
  "NORMAL",
];

/** 未知服务器的默认档：最保守，fail-closed，禁止自动探测放宽。 */
export const DEFAULT_UNKNOWN_SERVER_PROFILE: BaselineAntiCheatProfile =
  "STRICT";

export const serverPolicyLimitsSchema = z
  .object({
    // --- 距离：机制硬事实，任何档位都不得超过原版值 ---
    blockInteractionReach: z
      .number()
      .finite()
      .min(1)
      .max(VANILLA_BLOCK_INTERACTION_REACH),
    entityAttackReach: z
      .number()
      .finite()
      .min(1)
      .max(VANILLA_ENTITY_ATTACK_REACH),

    // --- 旋转：原版无上限，以下为本项目自定保守假设 ---
    maxYawDeltaPerTick: z.number().finite().min(1).max(180),
    maxPitchDeltaPerTick: z.number().finite().min(1).max(90),
    /** 要求转头分帧插值，禁止单帧瞬时大角度跳变。 */
    requireRotationSmoothing: z.boolean(),

    // --- 频率：原版无上限，以下为本项目自定保守假设 ---
    maxAttacksPerSecond: z.number().finite().min(0.5).max(20),
    maxPlacementsPerSecond: z.number().finite().min(0.5).max(20),
    maxDigStartsPerSecond: z.number().finite().min(0.5).max(20),
    maxHotbarSwitchesPerSecond: z.number().finite().min(0.5).max(20),
    /** 任意两次受限动作之间的最小间隔，抹掉"亚 tick 完美连招"特征。 */
    minActionIntervalMs: z.number().int().min(0).max(2_000),

    // --- 移动：原版允许，但反作弊最常在这里判定 ---
    allowSprint: z.boolean(),
    allowJump: z.boolean(),
    allowSprintJumpCombo: z.boolean(),
    allowAirStrafe: z.boolean(),
    maxFallBlocks: z.number().int().min(0).max(8),
  })
  .strict();

export type ServerPolicyLimits = z.infer<typeof serverPolicyLimitsSchema>;

export const serverPolicySchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    /** 边界按服硬隔离：A 服测出的值绝不用于 B 服。 */
    serverProfileId: identifierSchema,
    profile: antiCheatCompatibilityProfileSchema,
    limits: serverPolicyLimitsSchema,
    /**
     * 该策略的来源。`baseline` = 内置保守档，未经该服实测；
     * `probed` = 由该服的有界探测证据收敛得到。
     */
    origin: z.enum(["baseline", "probed"]),
    /** 证据引用（探测记录 ID），baseline 恒为空数组——不冒充已验证。 */
    evidenceIds: z.array(identifierSchema).max(64),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.profile === "CUSTOM_VERIFIED" && policy.origin !== "probed") {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "CUSTOM_VERIFIED policies require probed evidence.",
      });
    }
    if (policy.origin === "probed" && policy.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Probed policies must reference at least one evidence record.",
      });
    }
    if (policy.origin === "baseline" && policy.evidenceIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Baseline policies must not claim probe evidence.",
      });
    }
  });

export type ServerPolicy = z.infer<typeof serverPolicySchema>;
/**
 * 三个内置基线档。数值取舍原则：
 * - reach 一律 ≤ 原版硬事实，STRICT 再留安全余量（浮点/延迟导致的边界抖动）。
 * - 转头与频率原版无约束，故取"人类可达且明显低于常见反作弊阈值"的值，
 *   属保守假设，未经该服实测不得声称是该服真实边界。
 */
const BASELINE_LIMITS: Readonly<
  Record<BaselineAntiCheatProfile, ServerPolicyLimits>
> = Object.freeze({
  STRICT: Object.freeze({
    blockInteractionReach: 3.8,
    entityAttackReach: 2.6,
    maxYawDeltaPerTick: 18,
    maxPitchDeltaPerTick: 12,
    requireRotationSmoothing: true,
    maxAttacksPerSecond: 6,
    maxPlacementsPerSecond: 4,
    maxDigStartsPerSecond: 4,
    maxHotbarSwitchesPerSecond: 3,
    minActionIntervalMs: 150,
    allowSprint: false,
    allowJump: true,
    allowSprintJumpCombo: false,
    allowAirStrafe: false,
    maxFallBlocks: 2,
  }),
  VANILLA_COMPATIBLE: Object.freeze({
    blockInteractionReach: VANILLA_BLOCK_INTERACTION_REACH,
    entityAttackReach: VANILLA_ENTITY_ATTACK_REACH,
    maxYawDeltaPerTick: 30,
    maxPitchDeltaPerTick: 20,
    requireRotationSmoothing: true,
    maxAttacksPerSecond: 8,
    maxPlacementsPerSecond: 6,
    maxDigStartsPerSecond: 6,
    maxHotbarSwitchesPerSecond: 4,
    minActionIntervalMs: 100,
    allowSprint: true,
    allowJump: true,
    allowSprintJumpCombo: false,
    allowAirStrafe: false,
    maxFallBlocks: 3,
  }),
  NORMAL: Object.freeze({
    blockInteractionReach: VANILLA_BLOCK_INTERACTION_REACH,
    entityAttackReach: VANILLA_ENTITY_ATTACK_REACH,
    maxYawDeltaPerTick: 45,
    maxPitchDeltaPerTick: 30,
    requireRotationSmoothing: true,
    maxAttacksPerSecond: 10,
    maxPlacementsPerSecond: 8,
    maxDigStartsPerSecond: 8,
    maxHotbarSwitchesPerSecond: 6,
    minActionIntervalMs: 80,
    allowSprint: true,
    allowJump: true,
    allowSprintJumpCombo: true,
    allowAirStrafe: false,
    maxFallBlocks: 3,
  }),
});

/** 读取一个内置基线档的限额副本（冻结，调用方无法改动内部状态）。 */
export function baselineLimits(
  profile: BaselineAntiCheatProfile,
): ServerPolicyLimits {
  return BASELINE_LIMITS[profile];
}

/**
 * 构造一个 baseline 策略。baseline 永远 `origin: "baseline"` 且不带证据，
 * 因此不会被误读成"该服已验证"。
 */
export function baselineServerPolicy(
  serverProfileId: string,
  profile: BaselineAntiCheatProfile = DEFAULT_UNKNOWN_SERVER_PROFILE,
): ServerPolicy {
  return serverPolicySchema.parse({
    schemaVersion: "1.0",
    serverProfileId,
    profile,
    limits: BASELINE_LIMITS[profile],
    origin: "baseline",
    evidenceIds: [],
  });
}

/**
 * 逐字段取两个限额中更保守的一侧。用于"证据只能收紧、不能凭空放宽"，
 * 以及把探测结果压回原版机制硬上限之内。
 */
export function intersectLimits(
  left: ServerPolicyLimits,
  right: ServerPolicyLimits,
): ServerPolicyLimits {
  return serverPolicyLimitsSchema.parse({
    blockInteractionReach: Math.min(
      left.blockInteractionReach,
      right.blockInteractionReach,
    ),
    entityAttackReach: Math.min(left.entityAttackReach, right.entityAttackReach),
    maxYawDeltaPerTick: Math.min(
      left.maxYawDeltaPerTick,
      right.maxYawDeltaPerTick,
    ),
    maxPitchDeltaPerTick: Math.min(
      left.maxPitchDeltaPerTick,
      right.maxPitchDeltaPerTick,
    ),
    requireRotationSmoothing:
      left.requireRotationSmoothing || right.requireRotationSmoothing,
    maxAttacksPerSecond: Math.min(
      left.maxAttacksPerSecond,
      right.maxAttacksPerSecond,
    ),
    maxPlacementsPerSecond: Math.min(
      left.maxPlacementsPerSecond,
      right.maxPlacementsPerSecond,
    ),
    maxDigStartsPerSecond: Math.min(
      left.maxDigStartsPerSecond,
      right.maxDigStartsPerSecond,
    ),
    maxHotbarSwitchesPerSecond: Math.min(
      left.maxHotbarSwitchesPerSecond,
      right.maxHotbarSwitchesPerSecond,
    ),
    minActionIntervalMs: Math.max(
      left.minActionIntervalMs,
      right.minActionIntervalMs,
    ),
    allowSprint: left.allowSprint && right.allowSprint,
    allowJump: left.allowJump && right.allowJump,
    allowSprintJumpCombo:
      left.allowSprintJumpCombo && right.allowSprintJumpCombo,
    allowAirStrafe: left.allowAirStrafe && right.allowAirStrafe,
    maxFallBlocks: Math.min(left.maxFallBlocks, right.maxFallBlocks),
  });
}

/** true 当 `candidate` 在每一个字段上都不比 `reference` 更宽松。 */
export function isAtLeastAsConservative(
  candidate: ServerPolicyLimits,
  reference: ServerPolicyLimits,
): boolean {
  const merged = intersectLimits(candidate, reference);
  return (
    JSON.stringify(merged) ===
    JSON.stringify(serverPolicyLimitsSchema.parse(candidate))
  );
}

/** 保守程度比较：返回 true 当 `left` 至少和 `right` 一样保守。 */
export function profileIsAtLeastAsConservative(
  left: AntiCheatCompatibilityProfile,
  right: AntiCheatCompatibilityProfile,
): boolean {
  if (left === "CUSTOM_VERIFIED" || right === "CUSTOM_VERIFIED") return false;
  return (
    PROFILE_CONSERVATISM_ORDER.indexOf(left) <=
    PROFILE_CONSERVATISM_ORDER.indexOf(right)
  );
}


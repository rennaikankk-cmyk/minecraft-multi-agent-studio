import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  assessAdjacentFluids,
  assessBedUse,
  assessDepth,
  assessFall,
  assessOverhead,
  assessSafetyFlags,
  assessStraightDown,
  hazardCodeSchema,
  hazardProfileFor,
  isRefusalHazard,
  mostSevereVerdict,
  SAFE_FALL_BLOCKS,
  type HazardCode,
} from "../commons/hazards.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// hazard.assess —— 危险预检（纯函数技能）。
//
// 定位：给**别的**规划器当安全前置闸用。它不碰世界、不碰背包，
// 只把"这一步动作 + 当前高度/维度/安全位"喂给 commons/hazards 的知识表，
// 换回一个确定性的裁决（ALLOW / WARN / REFUSE）与稳定的 hazardCodes。
//
// 为什么必须是纯的：运行时状态里没有方块数据（挖的是什么、下面是空气还是岩浆
// 都看不到），所以"动作事实"必须由调用方作为 INPUT 给出——给不了事实的调用方
// 拿到的是"按已知信息能给出的最强裁决"，而不是一个假装看得见的答案。
// ---------------------------------------------------------------------------

export const HAZARD_ASSESS_TIMEOUT_MS = 2_000;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const positionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角（与 craft-item 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const hazardActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dig-straight-down"), depthBlocks: z.number().int().min(1).max(64) }).strict(),
  z.object({ kind: z.literal("dig-horizontal"), depthBlocks: z.number().int().min(1).max(64) }).strict(),
  z
    .object({
      kind: z.literal("dig-overhead"),
      depthBlocks: z.number().int().min(1).max(64),
      fluidAbove: z.boolean().optional(),
      gravityBlockAbove: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("dig-target"),
      target: positionSchema,
      adjacentLava: z.boolean().optional(),
      adjacentWater: z.boolean().optional(),
    })
    .strict(),
  z.object({ kind: z.literal("move-to") }).strict(),
  z.object({ kind: z.literal("fall"), fallBlocks: z.number().int().min(0).max(256) }).strict(),
  z.object({ kind: z.literal("use-bed") }).strict(),
]);
export type HazardAction = z.infer<typeof hazardActionSchema>;

export const hazardAssessInputSchema = z
  .object({
    action: hazardActionSchema,
    /** 动作发生的维度；省略时取 state.position.dimension。 */
    dimension: dimensionSchema.optional(),
    serverProfileId: identifierSchema,
    /** 动作发生的高度；省略时取 state.position.y。 */
    y: z.number().finite().min(-2_048).max(2_048).optional(),
    /** 已知的相邻危险信号（来自 world.read 观测；缺省即未知，按"未知不放大"处理）。 */
    adjacentLava: z.boolean().optional(),
    adjacentWater: z.boolean().optional(),
    /** 计划的下落格数：给了就同时做坠落裁决。 */
    fallBlocks: z.number().int().min(0).max(256).optional(),
  })
  .strict();
export type HazardAssessInput = z.infer<typeof hazardAssessInputSchema>;

export const hazardFindingSchema = z
  .object({
    code: hazardCodeSchema,
    severity: z.enum(["refuse", "warn"]),
    detail: z.string().min(1).max(256),
  })
  .strict();
export type HazardFinding = z.infer<typeof hazardFindingSchema>;

export const hazardAssessOutputSchema = z
  .object({
    verdict: z.enum(["ALLOW", "WARN", "REFUSE"]),
    /** REFUSE/WARN 时的代表码：取最严重的一个，保证同输入同输出。 */
    refusalCode: hazardCodeSchema,
    hazards: z.array(hazardFindingSchema).max(32),
    dimension: dimensionSchema,
    dimensionLabel: z.string().min(1).max(32),
    y: z.number().finite(),
    /** fail-closed 建议：REFUSE 时调用方应当停下并重新规划，而不是换个动作硬上。 */
    safeToProceed: z.boolean(),
  })
  .strict();
export type HazardAssessOutput = z.infer<typeof hazardAssessOutputSchema>;

export const hazardAssessStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    isolatedTestServer: z.boolean(),
    policyLimits: z
      .object({
        allowSprint: z.boolean(),
        allowSprintJumpCombo: z.boolean(),
        allowAirStrafe: z.boolean(),
        maxFallBlocks: z.number().int().min(0).max(8),
      })
      .strict(),
    safety: z
      .object({ lavaAdjacent: z.boolean(), waterAdjacent: z.boolean(), voidRisk: z.boolean() })
      .strict(),
    position: observedPositionSchema.nullable(),
  })
  .strip();
export type HazardAssessState = z.infer<typeof hazardAssessStateSchema>;

function finding(code: HazardCode, detail: string): HazardFinding {
  return hazardFindingSchema.parse({ code, severity: isRefusalHazard(code) ? "refuse" : "warn", detail });
}

/** 把动作本身翻译成危险码（不含高度/策略/维度类判定，那些在 execute 里统一加）。 */
export function hazardCodesForAction(action: HazardAction): readonly HazardCode[] {
  switch (action.kind) {
    case "dig-straight-down":
      return assessStraightDown();
    case "dig-overhead":
      return assessOverhead({
        breaking: true,
        fluidAbove: action.fluidAbove,
        gravityBlockAbove: action.gravityBlockAbove,
      });
    case "dig-target":
      return assessAdjacentFluids({
        lavaAdjacent: action.adjacentLava === true,
        waterAdjacent: action.adjacentWater === true,
      });
    // 床是否危险取决于维度，在 execute 里用实际维度判定；
    // 水平挖掘/移动/坠落没有"动作本身即危险"的情形。
    case "use-bed":
    case "dig-horizontal":
    case "move-to":
    case "fall":
      return Object.freeze([] as HazardCode[]);
    default:
      return Object.freeze([] as HazardCode[]);
  }
}

export const hazardAssessSkill = defineSkill({
  id: "hazard.assess",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: hazardAssessInputSchema,
  outputSchema: hazardAssessOutputSchema,
  stateSchema: hazardAssessStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  // 纯计算：不调用任何 capability（与 stock.levels / movement.profile 同类）。
  requiredCapabilities: [] as const,
  timeoutMs: HAZARD_ASSESS_TIMEOUT_MS,
  idempotent: true,
  retryPolicy: { maxAttempts: 1, baseDelayMs: 100, maxDelayMs: 500, retryableErrorCodes: [] },
  preconditions: [
    { id: "bot.online", failureCode: "BOT_NOT_ONLINE", check: (_input, state) => state.online },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input, state) => state.normalActionsAllowed,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input, state) => input.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.position-available",
      failureCode: "BOT_POSITION_UNAVAILABLE",
      check: (input, state) =>
        (input.y !== undefined && input.dimension !== undefined) || state.position !== null,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position === null ||
        (input.dimension ?? state.position.dimension) === state.position.dimension,
    },
  ],
  execute: async (_context, input, state) => {
    const dimension = input.dimension ?? state.position?.dimension ?? "unknown";
    const y = input.y ?? state.position?.y ?? 0;
    const profile = hazardProfileFor(dimension);
    const codes = new Set<HazardCode>();
    const hazards: HazardFinding[] = [];
    const add = (code: HazardCode, detail: string): void => {
      if (codes.has(code)) return;
      codes.add(code);
      hazards.push(finding(code, detail));
    };

    // 1) 高度面（虚空 / 岩浆海 / 深处 / 基岩顶）——最严重，先算。
    for (const code of assessDepth(y, dimension)) {
      add(code, `y=${y} 落在「${profile.label}」危险高度（硬地板 ${profile.hardFloor}${profile.lavaSeaLevel === null ? "" : `、岩浆海 ${profile.lavaSeaLevel}`}）。`);
    }
    // 2) 动作面。
    const actionCodes = new Set<HazardCode>(hazardCodesForAction(input.action));
    // 顶层 adjacentLava/adjacentWater 是调用方单独观测到的补充事实（例如"当前
    // 站立位置旁就是岩浆"），与动作自带的同名字段取并集，不互相覆盖。
    if (input.adjacentLava === true) actionCodes.add("LAVA_ADJACENT");
    if (input.adjacentWater === true) actionCodes.add("WATER_ADJACENT");
    if (input.action.kind === "use-bed") {
      const bed = assessBedUse(dimension);
      for (const code of bed.codes) actionCodes.add(code);
      if (!bed.allowed) {
        add("BED_EXPLODES", `床在「${profile.label}」使用会爆炸（原版机制，${bed.dimensions.join("、")} 均如此）。`);
      }
    }
    for (const code of actionCodes) {
      add(code, describeActionCode(code));
    }
    // 3) 安全观测位。
    for (const code of assessSafetyFlags(state.safety)) {
      add(code, describeActionCode(code));
    }
    // 4) 坠落（动作自带 fallBlocks 或 fall 动作）。
    const fallBlocks =
      input.action.kind === "fall" ? input.action.fallBlocks : input.fallBlocks;
    if (fallBlocks !== undefined) {
      const fall = assessFall(fallBlocks, state.policyLimits.maxFallBlocks);
      if (!fall.allowed) {
        add(
          fall.code,
          `下落 ${fallBlocks} 格会掉 ${fall.damagePoints} 点血（原版阈值 ${SAFE_FALL_BLOCKS} 格），策略上限 ${state.policyLimits.maxFallBlocks} 格。`,
        );
      }
    }

    const hazardCodes = hazards.map(({ code }) => code);
    const verdict: HazardAssessOutput["verdict"] = hazardCodes.some(isRefusalHazard)
      ? "REFUSE"
      : hazardCodes.length > 0
        ? "WARN"
        : "ALLOW";
    return hazardAssessOutputSchema.parse({
      verdict,
      refusalCode: mostSevereVerdict(hazardCodes),
      hazards,
      dimension,
      dimensionLabel: profile.label,
      y,
      safeToProceed: verdict !== "REFUSE",
    });
  },
});

function describeActionCode(code: HazardCode): string {
  switch (code) {
    case "VOID_FLOOR":
      return "已到达虚空平面：继续往下会掉出世界，物品与装备不可回收。";
    case "LAVA_SEA":
      return "已进入岩浆海高度：脚下的方块随时可能是岩浆。";
    case "DEEP_DANGER_ZONE":
      return "已越过该维度的规划地板：再往下是巨型洞穴与熔岩湖密集区。";
    case "BEDROCK_CEILING":
      return "已贴近不可破坏的基岩顶：上方无法继续通行。";
    case "DIG_STRAIGHT_DOWN":
      return "垂直下挖看不到落点：可能直接挖进洞穴、岩浆湖或深坑。";
    case "HOLLOW_OVERHEAD":
      return "掏空头顶会失去掩体，并可能被上方坠落方块砸中。";
    case "FALL_DAMAGE":
      return "坠落高度超过原版安全阈值（3 格）：4 格起每格 1 点伤害。";
    case "FALL_BEYOND_POLICY":
      return "坠落高度未超过原版阈值，但超过当前服务器策略允许的落差。";
    case "DIG_INTO_LAVA":
      return "目标相邻/上方有岩浆：破坏方块后岩浆会立刻灌入空位。";
    case "DIG_INTO_WATER":
      return "目标相邻/上方有水：破坏方块后水流会灌入，可能把自己冲进危险处。";
    case "LAVA_ADJACENT":
      return "身侧或目标旁贴着岩浆：任何误操作都会造成不可逆伤害。";
    case "WATER_ADJACENT":
      return "身边有水：注意溺水与被水流冲走（本身不是致命信号）。";
    case "VOID_RISK":
      return "运行时已标记 voidRisk：当前位置存在掉出世界的风险。";
    case "BED_EXPLODES":
      return "床在下界/末地使用会爆炸并引燃周围，禁止睡觉。";
    case "SAFE":
      return "无已知危险。";
    default:
      return "未知危险码。";
  }
}

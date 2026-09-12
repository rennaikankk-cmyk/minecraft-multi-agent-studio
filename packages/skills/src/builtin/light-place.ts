import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import { MAX_TORCH_SPACING, maxTorchSpacingFor, torchOffsets } from "../commons/placement.js";
import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// 照明布光技能（"防刷怪"这条常识的**执行**面）。
//
// 纯组合：不新增底层能力。按 commons/placement.ts 的间距规则算出位置，每一支都走
// 既有的 world.place-block（block.place-safe），因此放置读回校验、越界拒绝与 L0
// 抢占语义全部复用同一条已被验证的路径。
//
// 只铺**地面**（face=up）：直线走廊/隧道地面是防刷怪最常见的形态。墙面火把
// （wall_torch）与天花板不在本技能范围内——需要时另开技能，不在这里假装支持。
//
// 失败与恢复遵循本仓多步技能的既有约定（见 planning/stock-levels.ts）：
//   - 能力失败**不吞**：带稳定码向上传播，由 executor 与失败分类器处理；
//   - 部分完成用 startIndex/nextIndex 表达，调用方据此续做，而不是靠技能自己
//     "报一个失败码然后假装完成"。
// ---------------------------------------------------------------------------

export const LIGHT_PLACE_TIMEOUT_MS = 60_000;

/** 一次调用最多铺多少支：单支约 2 秒，16 支已接近 60 秒技能硬超时。 */
export const LIGHT_PLACE_MAX_PLACEMENTS = 16;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const itemNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/u);

const blockPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();

/**
 * 布光请求：沿 axis 轴、从 origin 起、长度 length 的一条直线。
 * `floorY` 是**地面方块所在的高度**——火把放在它上面，因此参照方块取该地面方块、
 * face 取 up。
 */
export const lightPlaceInputSchema = z
  .object({
    itemName: itemNameSchema,
    axis: z.enum(["x", "z"]),
    origin: z
      .object({
        x: z.number().int().min(-30_000_000).max(30_000_000),
        z: z.number().int().min(-30_000_000).max(30_000_000),
      })
      .strict(),
    floorY: z.number().int().min(-2_048).max(2_048),
    length: z.number().int().min(0).max(512),
    /**
     * 要求的最低方块光照。缺省 1（原版敌对生物需要方块光照为 0 才刷）。
     * 实际间距取 `min(maxTorchSpacingFor(level), MAX_TORCH_SPACING)` 的较小者：
     * 公式给的是"中点恰好仍不刷怪"的**理论最远**距离，而 commons 的 26 留了 1 格
     * 余量——保守方向永远是放得更密，绝不会更稀。
     */
    minimumBlockLight: z.number().int().min(0).max(14).optional(),
    maxPlacements: z.number().int().min(1).max(LIGHT_PLACE_MAX_PLACEMENTS),
    /** 从第几支开始（续做用）；缺省 0。 */
    startIndex: z.number().int().min(0).max(LIGHT_PLACE_MAX_PLACEMENTS).optional(),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

export const lightPlaceStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: z
      .object({
        x: z.number(),
        y: z.number(),
        z: z.number(),
        dimension: z.string(),
        serverProfileId: identifierSchema,
      })
      .strip()
      .nullable(),
  })
  .strip();

export const lightPlaceOutputSchema = z
  .object({
    startIndex: z.number().int().min(0).max(LIGHT_PLACE_MAX_PLACEMENTS),
    /** 下次应从第几支续做；等于 totalPlacements 即全部完成。 */
    nextIndex: z.number().int().min(0).max(LIGHT_PLACE_MAX_PLACEMENTS),
    totalPlacements: z.number().int().min(0).max(LIGHT_PLACE_MAX_PLACEMENTS),
    /** 本次采用的间距（格），来自 commons 的间距规则而不是拍脑袋。 */
    spacingBlocks: z.number().int().min(1).max(64),
    /** 本次真正放好的位置（以 block.place-safe 的读回为准）。 */
    placed: z.array(blockPositionSchema),
    completed: z.boolean(),
  })
  .strict();

export type LightPlaceInput = z.infer<typeof lightPlaceInputSchema>;
export type LightPlaceOutput = z.infer<typeof lightPlaceOutputSchema>;

/** 按请求算出这次要尝试的火把位置（纯算术，便于单测直接断言）。 */
export function plannedTorchPositions(
  input: LightPlaceInput,
): Readonly<{ positions: readonly z.infer<typeof blockPositionSchema>[]; spacingBlocks: number }> {
  const minimumBlockLight = input.minimumBlockLight ?? 1;
  // 取公式值与 commons 保守上限的较小者（见输入 schema 上的说明）。
  const spacingBlocks = Math.max(
    1,
    Math.min(64, MAX_TORCH_SPACING, maxTorchSpacingFor(minimumBlockLight)),
  );
  const offsets = torchOffsets(input.length, spacingBlocks).slice(0, input.maxPlacements);
  const positions = offsets.map((offset) => ({
    x: input.axis === "x" ? input.origin.x + offset : input.origin.x,
    y: input.floorY,
    z: input.axis === "z" ? input.origin.z + offset : input.origin.z,
  }));
  return { positions, spacingBlocks };
}

export const lightPlaceSkill = defineSkill({
  id: "light.place",
  version: "1.0.0",
  progressContract: "PLACE_AND_VERIFY",
  inputSchema: lightPlaceInputSchema,
  outputSchema: lightPlaceOutputSchema,
  stateSchema: lightPlaceStateSchema,
  compatibility: {
    variants: [
      { id: "portable", requirements: [], verifiedMinecraftVersions: [] },
    ],
  },
  // 只用到放置能力：位置由本地常识算出，不需要世界读取。
  requiredCapabilities: ["world.interact"] as const,
  timeoutMs: LIGHT_PLACE_TIMEOUT_MS,
  // 重复执行会往已占用的格子再放一次：要么失败要么多耗一支火把，禁止自动重试。
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 250,
    maxDelayMs: 1_000,
    retryableErrorCodes: [],
  },
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
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
  ],
  execute: async (context, input) => {
    const { positions, spacingBlocks } = plannedTorchPositions(input);
    const startIndex = input.startIndex ?? 0;
    const placed: z.infer<typeof blockPositionSchema>[] = [];
    let nextIndex = startIndex;

    for (const referenceBlock of positions.slice(startIndex)) {
      if (context.signal.aborted) {
        // 位置刻意不进消息：火把坐标等于基地位置，§6 禁止入日志。
        throw new SkillFault("SKILL_CANCELLED", "取消信号已置位，照明布光未完成。");
      }
      const receipt = (await context.callCapability("world.interact", "block.place-safe", {
        itemName: input.itemName,
        // 火把放在地面方块**上面**：参照方块是地面本身，face 指向 +y。
        referenceBlock,
        face: { x: 0, y: 1, z: 0 },
        dimension: input.dimension,
        serverProfileId: input.serverProfileId,
      })) as { placed?: unknown; position?: unknown } | null;
      // 读回校验：只有能力确认放下了才算数，不按"我发过请求"计。
      // 用 SkillFault 而不是 SkillRefusal：这一支可能已经产生了副作用（能力可能
      // 放了一半才失败），按 SkillRefusal 的契约"拿不准就用 SkillFault"。
      const confirmed = receipt !== null && receipt.placed === true;
      if (!confirmed) {
        throw new SkillFault(
          "SKILL_VERIFY_FAILED",
          "block.place-safe 未确认放置，照明布光在当前位置停止（坐标已脱敏）。",
        );
      }
      placed.push(referenceBlock);
      nextIndex += 1;
    }

    return lightPlaceOutputSchema.parse({
      startIndex,
      nextIndex,
      totalPlacements: positions.length,
      spacingBlocks,
      placed,
      completed: nextIndex >= positions.length,
    });
  },
});

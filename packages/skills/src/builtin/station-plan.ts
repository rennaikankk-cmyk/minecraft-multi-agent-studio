import { identifierSchema } from "@minecraft-studio/protocol";
import { z } from "zod";

import {
  blockReachDistance,
  stationKindSchema,
  stationRequirements,
  VANILLA_BLOCK_REACH,
  type StationKind,
} from "../commons/placement.js";
import { defineSkill } from "../types.js";

// ---------------------------------------------------------------------------
// station.plan —— 工位（工作台/熔炉/箱子/床）的"就地放还是去找"裁决（纯函数）。
//
// 为什么需要它：3×3 配方必须先有工作台，熔炼必须先有熔炉，而"先有"包含两件事——
//   (1) 位置合法：下方实心、上方留够空间（工作台/箱子 1 格、床 2 格）；
//   (2) 够得着：交互距离上限由 ServerPolicy 裁决（原版 4.5，STRICT 档更严）。
// 这两件事都不该由 AI 现场感觉，所以做成确定性的判定。
//
// 它只出裁决与摆放要求，**不放置、不移动**（那是 world.place-block /
// movement.goto 的事），因此不声明任何 capability。
// ---------------------------------------------------------------------------

export const STATION_PLAN_TIMEOUT_MS = 2_000;

const dimensionSchema = z.string().min(3).max(128).regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const blockPositionSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();

export const stationPlanInputSchema = z
  .object({
    /** 任务需要哪种工位。 */
    station: stationKindSchema,
    /** 已知的现有工位坐标（world.read 观测；没有就是 null）。 */
    existing: blockPositionSchema.nullable().optional(),
    /** 计划放置的落点（"就地放"时给出；省略则只报要求不报坐标）。 */
    candidate: blockPositionSchema.nullable().optional(),
    /** 落点上方是否有足够空间（观测事实；缺省即未知 → 按需人工确认，不假装够）。 */
    headroomBlocks: z.number().int().min(0).max(8).nullable().optional(),
    /** 落点下方是否是实心方块。 */
    solidFloor: z.boolean().nullable().optional(),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();
export type StationPlanInput = z.infer<typeof stationPlanInputSchema>;

export const stationCodeSchema = z.enum([
  "USE_EXISTING",
  "PLACE_STATION",
  "FIND_STATION",
  "STATION_OUT_OF_REACH",
  "STATION_HEADROOM_MISSING",
  "STATION_FLOOR_MISSING",
  "STATION_PLACEMENT_UNKNOWN",
  "INVENTORY_SLOT_NEEDED",
]);
export type StationCode = z.infer<typeof stationCodeSchema>;

export const stationRequirementSchema = z
  .object({
    station: stationKindSchema,
    /** 建议落点；调用方没给候选坐标时为 null（此时 code = STATION_PLACEMENT_UNKNOWN）。 */
    position: blockPositionSchema.nullable(),
    /** 上方必须空出的格数。 */
    headroomBlocks: z.number().int().min(0).max(8),
    /** 下方是否需要实心方块。 */
    needsSolidFloor: z.boolean(),
    /** 交互距离上限（原版 4.5 格；实际裁决权在 ServerPolicy）。 */
    reachBlocks: z.number().finite().positive().max(64),
    /** 是否可以就地放置（相对现有落点/候选落点）。 */
    placeable: z.boolean(),
    footprintWidth: z.number().int().min(1).max(4),
    footprintDepth: z.number().int().min(1).max(4),
  })
  .strict();
export type StationRequirement = z.infer<typeof stationRequirementSchema>;

export const stationPlanOutputSchema = z
  .object({
    verdict: z.enum(["USE_EXISTING", "MUST_PLACE", "MUST_FIND", "REQUIREMENTS_INCOMPLETE"]),
    code: stationCodeSchema,
    station: stationKindSchema,
    requirement: stationRequirementSchema,
    /** 现有工位到 bot 的距离；没有工位/没有位置信息时为 null。 */
    existingDistance: z.number().finite().min(0).nullable(),
    rationale: z.string().min(1).max(512),
    dimension: dimensionSchema,
  })
  .strict();
export type StationPlanOutput = z.infer<typeof stationPlanOutputSchema>;

export const stationPlanStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    retreatInProgress: z.boolean(),
    serverProfileId: identifierSchema,
    position: z
      .object({
        x: z.number().finite().min(-30_000_000).max(30_000_000),
        y: z.number().finite().min(-2_048).max(2_048),
        z: z.number().finite().min(-30_000_000).max(30_000_000),
        dimension: dimensionSchema,
        serverProfileId: identifierSchema,
        yaw: z.number().finite().optional(),
        pitch: z.number().finite().optional(),
      })
      .strict()
      .nullable(),
  })
  .strip();
export type StationPlanState = z.infer<typeof stationPlanStateSchema>;

function requirementFor(station: StationKind, position: z.infer<typeof blockPositionSchema> | null, placeable: boolean): StationRequirement {
  const spec = stationRequirements[station];
  return stationRequirementSchema.parse({
    station,
    position,
    headroomBlocks: spec.headroomBlocks,
    needsSolidFloor: spec.needsSolidFloor,
    reachBlocks: spec.reachBlocks,
    placeable,
    footprintWidth: spec.footprint.width,
    footprintDepth: spec.footprint.depth,
  });
}

export const stationPlanSkill = defineSkill({
  id: "station.plan",
  version: "1.0.0",
  progressContract: "WAITING_EXTERNAL",
  inputSchema: stationPlanInputSchema,
  outputSchema: stationPlanOutputSchema,
  stateSchema: stationPlanStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  // 纯规划：不放置、不移动、不读世界（与 tool.plan / movement.profile 同类）。
  requiredCapabilities: [] as const,
  timeoutMs: STATION_PLAN_TIMEOUT_MS,
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
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input, state) => state.position === null || input.dimension === state.position.dimension,
    },
    {
      id: "bot.position-available",
      failureCode: "BOT_POSITION_UNAVAILABLE",
      check: (_input, state) => state.position !== null,
    },
  ],
  execute: async (_context, input, state) => {
    const spec = stationRequirements[input.station];
    const position = input.candidate ?? input.existing ?? null;
    const requirement = requirementFor(input.station, position, position !== null);
    const botPosition = state.position;

    // 1) 有现成的：先看够不够得着（够得着就用，够不着就去别处找/重新放）。
    //    距离裁决照抄原版 4.5 格基准——stateSchema 里没有 SkillPolicyView，
    //    策略档位更严时由调用方把该工位当作"够不着"再问一次。
    if (input.existing !== null && input.existing !== undefined && botPosition !== null) {
      const distance = blockReachDistance(input.existing, botPosition);
      if (distance > VANILLA_BLOCK_REACH) {
        return stationPlanOutputSchema.parse({
          verdict: "MUST_FIND",
          code: "STATION_OUT_OF_REACH",
          station: input.station,
          requirement,
          existingDistance: distance,
          rationale: `现有 ${input.station} 距 ${distance.toFixed(2)} 格外，超出原版交互距离上限 ${VANILLA_BLOCK_REACH} 格。`,
          dimension: input.dimension,
        });
      }
      return stationPlanOutputSchema.parse({
        verdict: "USE_EXISTING",
        code: "USE_EXISTING",
        station: input.station,
        requirement,
        existingDistance: distance,
        rationale: `现有 ${input.station} 在 ${distance.toFixed(2)} 格外，够得着，直接使用。`,
        dimension: input.dimension,
      });
    }

    // 2) 没有现成的：要就地放。先看落点事实够不够。
    if (position === null) {
      return stationPlanOutputSchema.parse({
        verdict: "REQUIREMENTS_INCOMPLETE",
        code: "STATION_PLACEMENT_UNKNOWN",
        station: input.station,
        requirement,
        existingDistance: null,
        rationale: `附近没有 ${input.station}，也没有候选落点：需要先观测一块合法的地面（下方实心、上方留 ${spec.headroomBlocks} 格）再决定放在哪。`,
        dimension: input.dimension,
      });
    }
    const headroom = input.headroomBlocks ?? null;
    const solidFloor = input.solidFloor ?? null;
    if (solidFloor === false) {
      return stationPlanOutputSchema.parse({
        verdict: "MUST_FIND",
        code: "STATION_FLOOR_MISSING",
        station: input.station,
        requirement,
        existingDistance: null,
        rationale: `${input.station} 下方不是实心方块，放上去会掉/无法交互，需换落点。`,
        dimension: input.dimension,
      });
    }
    if (headroom !== null && headroom < spec.headroomBlocks) {
      return stationPlanOutputSchema.parse({
        verdict: "MUST_FIND",
        code: "STATION_HEADROOM_MISSING",
        station: input.station,
        requirement,
        existingDistance: null,
        rationale: `${input.station} 上方只有 ${headroom} 格空间，需要 ${spec.headroomBlocks} 格（床要容纳身体、工作台/熔炉/箱子要能打开）。`,
        dimension: input.dimension,
      });
    }
    if (input.existing === null || input.existing === undefined) {
      // 既有下落点又通过检查 → 可以就地放。
      return stationPlanOutputSchema.parse({
        verdict: "MUST_PLACE",
        code: "PLACE_STATION",
        station: input.station,
        requirement,
        existingDistance: null,
        rationale: `附近没有 ${input.station}，落点合法（上方 ${headroom ?? "未观测"} 格、下方${solidFloor === null ? "未确认实心" : "实心"}），就地放置。`,
        dimension: input.dimension,
      });
    }
    return stationPlanOutputSchema.parse({
      verdict: "MUST_PLACE",
      code: "PLACE_STATION",
      station: input.station,
      requirement,
      existingDistance: null,
      rationale: `现有 ${input.station} 不在可交互范围内（缺少 bot 位置观测，无法给出距离），按"就地另放一个"处理。`,
      dimension: input.dimension,
    });
  },
});

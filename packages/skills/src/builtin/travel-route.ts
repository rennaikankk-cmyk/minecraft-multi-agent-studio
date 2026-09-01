import {
  identifierSchema,
  skillErrorCodeSchema,
} from "@minecraft-studio/protocol";
import { z } from "zod";

import { SkillFault } from "../errors.js";
import { defineSkill } from "../types.js";
import {
  SAFE_PATH_MAX_DISTANCE,
  safeMovementGotoOutputSchema,
} from "./movement-goto.js";

export const TRAVEL_ROUTE_TIMEOUT_MS = 60_000;
export const MAX_ROUTE_SEGMENTS = 256;
export const TRAVEL_ROUTE_SEGMENT_OPERATION = "travel.route-segment" as const;

const dimensionSchema = z
  .string()
  .min(3)
  .max(128)
  .regex(/^[a-z0-9_.-]+:[a-z0-9_./-]+$/u);

const coordinateSchema = z
  .object({
    x: z.number().int().min(-30_000_000).max(30_000_000),
    y: z.number().int().min(-2_048).max(2_048),
    z: z.number().int().min(-30_000_000).max(30_000_000),
  })
  .strict();

const targetSchema = coordinateSchema
  .extend({
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
  })
  .strict();

const observedPositionSchema = z
  .object({
    x: z.number().finite().min(-30_000_000).max(30_000_000),
    y: z.number().finite().min(-2_048).max(2_048),
    z: z.number().finite().min(-30_000_000).max(30_000_000),
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    // runtime 快照附带朝向角（与 movement-goto 同一形状）：strict 下缺失会拒真状态
    yaw: z.number().finite().optional(),
    pitch: z.number().finite().optional(),
  })
  .strict();

export const travelCorridorPolicies = [
  "pathfinder",
  "axis-aligned",
  "highway",
] as const;
export const travelCorridorPolicySchema = z.enum(travelCorridorPolicies);
export type TravelCorridorPolicy = z.infer<
  typeof travelCorridorPolicySchema
>;

export const travelRouteInputSchema = z
  .object({
    destination: coordinateSchema,
    dimension: dimensionSchema,
    serverProfileId: identifierSchema,
    maxSegments: z.number().int().min(1).max(MAX_ROUTE_SEGMENTS),
    corridorPolicy: travelCorridorPolicySchema,
  })
  .strict();

export const travelRouteStateSchema = z
  .object({
    online: z.boolean(),
    normalActionsAllowed: z.boolean(),
    serverProfileId: identifierSchema,
    position: observedPositionSchema.nullable(),
  })
  .strip();

export const travelRouteCapabilityInputSchema = z
  .object({
    target: targetSchema,
    radius: z.number().int().min(1).max(4),
    corridorPolicy: travelCorridorPolicySchema,
    segmentIndex: z.number().int().min(0).max(MAX_ROUTE_SEGMENTS - 1),
  })
  .strict();

export const travelRouteCapabilityOutputSchema = safeMovementGotoOutputSchema;

const timestampMsSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

export const travelRouteSegmentStatusSchema = z.enum([
  "executed",
  "clipped",
  "delayed",
  "dropped",
  "modified",
]);

export const travelRouteSegmentAuditSchema = z
  .object({
    segmentIndex: z.number().int().min(0).max(MAX_ROUTE_SEGMENTS - 1),
    requested: targetSchema,
    executed: observedPositionSchema.nullable(),
    requestedAtMs: timestampMsSchema,
    executedAtMs: timestampMsSchema.nullable(),
    durationMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    l0Interrupted: z.boolean(),
    status: travelRouteSegmentStatusSchema,
    reasonCode: skillErrorCodeSchema.nullable(),
  })
  .strict();

export const travelRouteOutputSchema = z
  .object({
    reached: z.literal(true),
    destination: coordinateSchema,
    finalPosition: observedPositionSchema,
    distanceToDestination: z.number().finite().min(0),
    segmentCount: z.number().int().min(0).max(MAX_ROUTE_SEGMENTS),
    segmentAudits: z.array(travelRouteSegmentAuditSchema).max(MAX_ROUTE_SEGMENTS),
  })
  .strict()
  .superRefine((output, context) => {
    if (output.segmentCount !== output.segmentAudits.length) {
      context.addIssue({
        code: "custom",
        path: ["segmentCount"],
        message: "segmentCount must equal segmentAudits.length",
      });
    }
  });

export type TravelRouteInput = z.infer<typeof travelRouteInputSchema>;
export type TravelRouteState = z.infer<typeof travelRouteStateSchema>;
export type TravelRouteTarget = z.infer<typeof targetSchema>;
export type TravelRouteSegmentAudit = z.infer<typeof travelRouteSegmentAuditSchema>;

type Coordinate = z.infer<typeof coordinateSchema>;
type CoordinateAxis = keyof Coordinate;
type ObservedPosition = z.infer<typeof observedPositionSchema>;

function distance(left: Coordinate, right: Coordinate): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function floorPosition(position: ObservedPosition): Coordinate {
  return coordinateSchema.parse({
    x: Math.floor(position.x),
    y: Math.floor(position.y),
    z: Math.floor(position.z),
  });
}

function nextEuclideanSegment(
  current: Coordinate,
  destination: Coordinate,
): Coordinate {
  const total = distance(current, destination);
  if (total <= SAFE_PATH_MAX_DISTANCE) return destination;
  const ratio = SAFE_PATH_MAX_DISTANCE / total;
  const next = {
    x: current.x + Math.trunc((destination.x - current.x) * ratio),
    y: current.y + Math.trunc((destination.y - current.y) * ratio),
    z: current.z + Math.trunc((destination.z - current.z) * ratio),
  };
  if (next.x === current.x && next.y === current.y && next.z === current.z) {
    const axis = (["x", "y", "z"] as CoordinateAxis[]).sort(
      (left, right) =>
        Math.abs(destination[right] - current[right]) -
        Math.abs(destination[left] - current[left]),
    )[0]!;
    next[axis] += Math.sign(destination[axis] - current[axis]);
  }
  return coordinateSchema.parse(next);
}

function nextAxisSegment(
  current: Coordinate,
  destination: Coordinate,
): Coordinate {
  const axis = (["x", "z", "y"] as CoordinateAxis[]).sort(
    (left, right) =>
      Math.abs(destination[right] - current[right]) -
      Math.abs(destination[left] - current[left]),
  ).find((candidate) => destination[candidate] !== current[candidate]);
  if (!axis) return destination;
  const amount = Math.min(
    SAFE_PATH_MAX_DISTANCE,
    Math.abs(destination[axis] - current[axis]),
  );
  return coordinateSchema.parse({
    ...current,
    [axis]: current[axis] + Math.sign(destination[axis] - current[axis]) * amount,
  });
}

export function nextTravelRouteSegment(
  current: Coordinate,
  destination: Coordinate,
  policy: TravelCorridorPolicy,
): Coordinate {
  return policy === "pathfinder"
    ? nextEuclideanSegment(current, destination)
    : nextAxisSegment(current, destination);
}

export function estimateTravelRouteSegments(
  current: Coordinate,
  destination: Coordinate,
  policy: TravelCorridorPolicy,
): number {
  let cursor = coordinateSchema.parse({ x: current.x, y: current.y, z: current.z });
  const target = coordinateSchema.parse({ x: destination.x, y: destination.y, z: destination.z });
  let count = 0;
  while (cursor.x !== target.x || cursor.y !== target.y || cursor.z !== target.z) {
    const next = nextTravelRouteSegment(cursor, target, policy);
    if (next.x === cursor.x && next.y === cursor.y && next.z === cursor.z) {
      throw new RangeError("Travel route planner made no progress");
    }
    cursor = next;
    count += 1;
    if (count > MAX_ROUTE_SEGMENTS) return count;
  }
  return count;
}

function auditStatus(
  requested: TravelRouteTarget,
  executed: ObservedPosition,
): z.infer<typeof travelRouteSegmentStatusSchema> {
  return distance(requested, executed) <= 0.001 ? "executed" : "modified";
}

export const travelRouteSkill = defineSkill({
  id: "travel.route",
  version: "1.0.0",
  inputSchema: travelRouteInputSchema,
  outputSchema: travelRouteOutputSchema,
  stateSchema: travelRouteStateSchema,
  compatibility: {
    variants: [{ id: "portable", requirements: [], verifiedMinecraftVersions: [] }],
  },
  requiredCapabilities: ["bot.move"] as const,
  timeoutMs: TRAVEL_ROUTE_TIMEOUT_MS,
  idempotent: false,
  retryPolicy: {
    maxAttempts: 1,
    baseDelayMs: 50,
    maxDelayMs: 250,
    retryableErrorCodes: [],
  },
  preconditions: [
    {
      id: "bot.online",
      failureCode: "BOT_NOT_ONLINE",
      check: (_input: TravelRouteInput, state: TravelRouteState) => state.online,
    },
    {
      id: "l0.normal-actions-allowed",
      failureCode: "NORMAL_ACTIONS_PAUSED",
      check: (_input: TravelRouteInput, state: TravelRouteState) =>
        state.normalActionsAllowed,
    },
    {
      id: "bot.position-available",
      failureCode: "BOT_POSITION_UNAVAILABLE",
      check: (_input: TravelRouteInput, state: TravelRouteState) =>
        state.position !== null,
    },
    {
      id: "target.server-profile-matches",
      failureCode: "TARGET_SERVER_PROFILE_MISMATCH",
      check: (input: TravelRouteInput, state: TravelRouteState) =>
        input.serverProfileId === state.serverProfileId,
    },
    {
      id: "target.dimension-matches",
      failureCode: "TARGET_DIMENSION_MISMATCH",
      check: (input: TravelRouteInput, state: TravelRouteState) =>
        state.position !== null && input.dimension === state.position.dimension,
    },
    {
      id: "route.segment-limit",
      failureCode: "POLICY_ROUTE_SEGMENT_LIMIT",
      check: (input: TravelRouteInput, state: TravelRouteState) =>
        state.position !== null &&
        estimateTravelRouteSegments(
          floorPosition(state.position),
          input.destination,
          input.corridorPolicy,
        ) <= input.maxSegments,
    },
  ],
  execute: async (context, input, state) => {
    if (state.position === null) throw new SkillFault("BOT_POSITION_UNAVAILABLE");
    let observed = state.position;
    let current = floorPosition(observed);
    const audits: TravelRouteSegmentAudit[] = [];
    while (distance(observed, input.destination) > 1.5) {
      const segmentIndex = audits.length;
      if (segmentIndex >= input.maxSegments) {
        throw new SkillFault("POLICY_ROUTE_SEGMENT_LIMIT");
      }
      const requested: TravelRouteTarget = {
        ...nextTravelRouteSegment(current, input.destination, input.corridorPolicy),
        dimension: input.dimension,
        serverProfileId: input.serverProfileId,
      };
      const requestedAtMs = Date.now();
      const raw = await context.callCapability(
        "bot.move",
        TRAVEL_ROUTE_SEGMENT_OPERATION,
        travelRouteCapabilityInputSchema.parse({
          target: requested,
          radius: 1,
          corridorPolicy: input.corridorPolicy,
          segmentIndex,
        }),
      );
      const receipt = travelRouteCapabilityOutputSchema.parse(raw);
      if (receipt.finalPosition.serverProfileId !== input.serverProfileId) {
        throw new SkillFault("TARGET_SERVER_PROFILE_MISMATCH");
      }
      if (receipt.finalPosition.dimension !== input.dimension) {
        throw new SkillFault("TARGET_DIMENSION_MISMATCH");
      }
      const nextObserved = receipt.finalPosition;
      const nextCurrent = floorPosition(nextObserved);
      if (
        nextCurrent.x === current.x &&
        nextCurrent.y === current.y &&
        nextCurrent.z === current.z
      ) {
        throw new SkillFault("PATH_TARGET_NOT_REACHED");
      }
      const executedAtMs = Date.now();
      audits.push({
        segmentIndex,
        requested,
        executed: nextObserved,
        requestedAtMs,
        executedAtMs: Math.max(requestedAtMs, executedAtMs),
        durationMs: Math.max(0, executedAtMs - requestedAtMs),
        l0Interrupted: false,
        status: auditStatus(requested, nextObserved),
        reasonCode: null,
      });
      observed = nextObserved;
      current = nextCurrent;
    }
    return travelRouteOutputSchema.parse({
      reached: true,
      destination: input.destination,
      finalPosition: observed,
      distanceToDestination: distance(observed, input.destination),
      segmentCount: audits.length,
      segmentAudits: audits,
    });
  },
});

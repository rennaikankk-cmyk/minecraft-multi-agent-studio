import type { Bot } from "mineflayer";
import pathfinderModule from "mineflayer-pathfinder";
import { Vec3 } from "vec3";
import { z } from "zod";
import { SkillFault, navigationGoalInputSchema, followEntityInputSchema, getToBlockInputSchema, exploreInputSchema,
  type WorkPosition } from "@minecraft-studio/skills";

const { goals } = pathfinderModule;
type Goal = InstanceType<typeof goals.Goal>;
export type NavigationProcessPort = {
  bot: Bot;
  assertActive(): void;
  goto(goal: Goal): Promise<void>;
  wait(ms: number): Promise<void>;
  now(): number;
  stop(): void;
};
export function navigationGoal(input: z.infer<typeof navigationGoalInputSchema>): Goal {
  const targets = input.clauses.map(({ kind, position: p, radius, invert }) => {
    let goal: Goal;
    switch (kind) {
      case "block": goal = new goals.GoalBlock(p.x, p.y, p.z); break;
      case "near": goal = new goals.GoalNear(p.x, p.y, p.z, radius); break;
      case "xz": goal = new goals.GoalNearXZ(p.x, p.z, radius); break;
      case "y": goal = new goals.GoalY(p.y); break;
      case "adjacent": goal = new goals.GoalGetToBlock(p.x, p.y, p.z); break;
      case "runaway": goal = new goals.GoalInvert(new goals.GoalNear(p.x, p.y, p.z, radius)); break;
    }
    return invert ? new goals.GoalInvert(goal) : goal;
  });
  return input.combine === "all" ? new goals.GoalCompositeAll(targets) : new goals.GoalCompositeAny(targets);
}
export function processPosition(bot: Bot): WorkPosition {
  const p = bot.entity.position;
  return { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
}
export function processGoalReached(bot: Bot, goal: Goal): boolean {
  return goal.isEnd(processPosition(bot) as Parameters<Goal["isEnd"]>[0]);
}
export async function runNavigationGoal(port: NavigationProcessPort, input: z.infer<typeof navigationGoalInputSchema>) {
  const goal = navigationGoal(input);
  port.assertActive();
  await port.goto(goal);
  port.assertActive();
  if (!processGoalReached(port.bot, goal)) throw new SkillFault("PATH_TARGET_NOT_REACHED");
  return { reached: true as const, position: processPosition(port.bot), observedAt: new Date().toISOString() };
}
export async function followEntity(port: NavigationProcessPort, input: z.infer<typeof followEntityInputSchema>) {
  const started = port.now();
  let nearTargetMs = 0;
  const initial = port.bot.entities[input.entityId];
  if (!initial || initial === port.bot.entity) throw new SkillFault("FOLLOW_TARGET_UNAVAILABLE");
  let status: "INTERVAL_COMPLETE" | "TARGET_LOST" | "TARGET_OUT_OF_RANGE" | "WAITING_PATH" = "INTERVAL_COMPLETE";
  port.bot.pathfinder.setGoal(new goals.GoalFollow(initial, input.radius), true);
  try {
    while (port.now() - started < input.durationMs) {
      port.assertActive();
      const target = port.bot.entities[input.entityId];
      if (!target || target !== initial || target.isValid === false) { status = "TARGET_LOST"; break; }
      const distance = port.bot.entity.position.distanceTo(target.position);
      if (distance > input.maxDistance) { status = "TARGET_OUT_OF_RANGE"; break; }
      const now = port.now();
      await port.wait(Math.min(100, input.durationMs - (now - started)));
      const after = port.bot.entities[input.entityId];
      if (after !== initial || after?.isValid === false) { status = "TARGET_LOST"; break; }
      if (distance <= input.radius + 1 && port.bot.entity.position.distanceTo(after.position) <= input.radius + 1) nearTargetMs += port.now() - now;
    }
    port.assertActive();
    if (status === "INTERVAL_COMPLETE" && nearTargetMs === 0) status = "WAITING_PATH";
    return { completed: status === "INTERVAL_COMPLETE", status, trackedMs: Math.max(0, port.now() - started),
      nearTargetMs, observedAt: new Date().toISOString() };
  } finally { port.stop(); }
}
export async function getToBlock(port: NavigationProcessPort, input: z.infer<typeof getToBlockInputSchema>) {
  const type = port.bot.registry.blocksByName[input.blockName];
  if (!type) throw new SkillFault("BLOCK_NAME_UNKNOWN");
  const attempted = new Set<string>();
  for (let attempt = 0; attempt < input.maxCandidates; attempt++) {
    port.assertActive();
    const positions = port.bot.findBlocks({ matching: type.id, maxDistance: input.maxDistance, count: input.maxCandidates });
    const target = positions.find((p) => !attempted.has(p.toString()) && port.bot.blockAt(p)?.name === input.blockName);
    if (!target) break;
    attempted.add(target.toString());
    const goal = new goals.GoalLookAtBlock(target, port.bot.world, { reach: 4 });
    try { await port.goto(goal); }
    catch (error) {
      port.assertActive();
      if (!(error instanceof Error) || !["NoPath", "Timeout"].includes(error.name)) throw error;
      continue;
    }
    port.assertActive();
    if (port.bot.blockAt(target)?.name !== input.blockName || !processGoalReached(port.bot, goal)) continue;
    return { reached: true as const, position: { x: target.x, y: target.y, z: target.z },
      blockName: input.blockName, observedAt: new Date().toISOString() };
  }
  throw new SkillFault("GET_TO_BLOCK_UNREACHABLE");
}
export async function exploreChunks(port: NavigationProcessPort, input: z.infer<typeof exploreInputSchema>) {
  const key = (p: { x: number; z: number }) => `${p.x},${p.z}`;
  const excluded = new Set(input.excluded.map(key));
  const history = new Set(input.visited.map(key));
  const visited = new Map<string, { x: number; z: number }>();
  const candidates: { x: number; z: number }[] = [];
  for (let z = input.center.z - input.radiusChunks; z <= input.center.z + input.radiusChunks; z++) {
    for (let x = input.center.x - input.radiusChunks; x <= input.center.x + input.radiusChunks; x++) {
      if (!excluded.has(key({ x, z }))) candidates.push({ x, z });
    }
  }
  candidates.sort((a, b) => Number(history.has(key(a))) - Number(history.has(key(b))) ||
    Math.hypot(a.x - input.center.x, a.z - input.center.z) - Math.hypot(b.x - input.center.x, b.z - input.center.z));
  let newlyObserved = 0;
  let status: "AREA_OBSERVED" | "BATCH_LIMIT" | "WAITING_PATH" | "WAITING_OBSERVATION" = "AREA_OBSERVED";
  const loaded = (p: { x: number; z: number }) => port.bot.world.getColumn(p.x, p.z) != null;
  // Checkpoints guide repeated calls, but cannot substitute for current chunk observations.
  for (const candidate of candidates) if (loaded(candidate)) visited.set(key(candidate), candidate);
  for (const candidate of candidates) {
    port.assertActive();
    if (visited.has(key(candidate))) continue;
    if (newlyObserved >= input.maxChunks) { status = "BATCH_LIMIT"; break; }
    try { await port.goto(new goals.GoalXZ(candidate.x * 16 + 8, candidate.z * 16 + 8)); }
    catch (error) {
      port.assertActive();
      if (!(error instanceof Error) || !["NoPath", "Timeout"].includes(error.name)) throw error;
      status = "WAITING_PATH"; break;
    }
    port.assertActive();
    if (!loaded(candidate)) { status = "WAITING_OBSERVATION"; break; }
    visited.set(key(candidate), candidate); newlyObserved++;
  }
  for (const [id, candidate] of visited) if (!loaded(candidate)) visited.delete(id);
  if (status === "AREA_OBSERVED" && visited.size !== candidates.length) status = "WAITING_OBSERVATION";
  return { completed: visited.size === candidates.length, status, visited: [...visited.values()], newlyObserved,
    observedAt: new Date().toISOString() };
}

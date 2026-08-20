import { describe, expect, it } from "vitest";

import { BotRegistry, TeamCoordinator } from "../src/index.js";

const NOW = new Date("2026-08-20T11:00:00.000Z");
let messageSequence = 1;

function uuid(): string {
  return `00000000-0000-4000-8000-${(messageSequence++).toString(16).padStart(12, "0")}`;
}

function addBot(
  registry: BotRegistry,
  botId: string,
  serverProfileId = "isolated-team",
  skills: readonly string[] = ["collect.block", "storage.account"],
  health = 20,
): void {
  const runtimeInstanceId = `runtime-${botId}`;
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(),
    traceId: `trace-${botId}`,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: runtimeInstanceId },
    botId,
    type: "bot.status.v1",
    payload: {
      serverProfileId,
      runtimeInstanceId,
      sequence: 1,
      observedAt: NOW.toISOString(),
      connectionState: "online",
      health: { current: health, maximum: 20 },
      food: { level: 18, saturation: 5 },
      armorPoints: 4,
      position: { x: 0, y: 64, z: 0, dimension: "minecraft:overworld" },
      latencyMs: 10,
      currentTask: null,
    },
  }, NOW);
  registry.ingest({
    schemaVersion: "1.0",
    messageId: uuid(),
    traceId: `trace-${botId}`,
    timestamp: NOW.toISOString(),
    source: { service: "bot-runtime", instanceId: runtimeInstanceId },
    botId,
    type: "bot.skill-catalog.v1",
    payload: {
      serverProfileId,
      runtimeInstanceId,
      sequence: 2,
      observedAt: NOW.toISOString(),
      minecraftVersion: "1.21.8",
      protocolVersion: 772,
      skills: skills.map((skillId) => ({
        skillId,
        skillVersion: "1.0.0",
        availability: "available",
        verification: "unverified",
        selectedVariantId: "portable",
        unavailableReasons: [],
      })),
    },
  }, NOW);
}

function registry(count: number, serverProfileId = "isolated-team"): BotRegistry {
  const value = new BotRegistry({ staleAfterMs: 30_000, now: () => NOW });
  for (let index = 1; index <= count; index += 1) {
    addBot(value, `worker-${index.toString().padStart(2, "0")}`, serverProfileId);
  }
  return value;
}

describe("TeamCoordinator", () => {
  it("prefers the requested role and includes bounded live team state for AI", () => {
    const bots = registry(3);
    const team = new TeamCoordinator({ registry: bots, now: () => NOW });
    team.setRole("worker-01", "scout");
    team.setRole("worker-02", "logistics");
    team.setRole("worker-03", "combat");
    team.createObjective({
      objectiveId: "objective-stockpile",
      serverProfileId: "isolated-team",
      title: "Build the shared stone stockpile",
      maxBots: 2,
      preferredRoles: ["logistics", "infrastructure"],
    });

    expect(team.assignTask({
      taskId: "task-stockpile-01",
      objectiveId: "objective-stockpile",
      requiredSkills: ["storage.account"],
      preferredRoles: ["logistics"],
      leaseMs: 30_000,
    })).toMatchObject({ botId: "worker-02", role: "logistics" });
    expect(team.teamStateForBot("worker-01")).toEqual(expect.arrayContaining([
      expect.stringContaining("online=3/3"),
      expect.stringContaining("bot=worker-02 role=logistics"),
      expect.stringContaining("objective=objective-stockpile"),
    ]));
  });

  it("atomically rejects overlapping resource leases and conflicting task reuse", () => {
    const team = new TeamCoordinator({ registry: registry(2), now: () => NOW });
    team.createObjective({
      objectiveId: "objective-farm",
      serverProfileId: "isolated-team",
      title: "Harvest two farm plots",
      maxBots: 2,
    });
    const firstRequest = {
      taskId: "task-farm-01",
      objectiveId: "objective-farm",
      requiredSkills: ["collect.block"],
      claims: [{
        kind: "area" as const,
        dimension: "minecraft:overworld",
        x: 0,
        y: 64,
        z: 0,
        radius: 8,
      }],
      leaseMs: 30_000,
    };
    const first = team.assignTask(firstRequest);
    expect(team.assignTask(firstRequest)).toEqual(first);
    expect(() => team.assignTask({
      taskId: "task-farm-02",
      objectiveId: "objective-farm",
      requiredSkills: ["collect.block"],
      claims: [{
        kind: "area",
        dimension: "minecraft:overworld",
        x: 10,
        y: 64,
        z: 0,
        radius: 8,
      }],
      leaseMs: 30_000,
    })).toThrowError(expect.objectContaining({ code: "TEAM_RESOURCE_CONFLICT" }));
    expect(() => team.assignTask({ ...firstRequest, leaseMs: 60_000 }))
      .toThrowError(expect.objectContaining({ code: "TEAM_TASK_CONFLICT" }));
  });

  it("releases expired Bot and resource leases for deterministic recovery", () => {
    let now = new Date(NOW);
    const team = new TeamCoordinator({ registry: registry(1), now: () => now });
    team.createObjective({
      objectiveId: "objective-retry",
      serverProfileId: "isolated-team",
      title: "Retry an interrupted collection",
      maxBots: 1,
    });
    team.assignTask({
      taskId: "task-retry-01",
      objectiveId: "objective-retry",
      requiredSkills: ["collect.block"],
      claims: [{ kind: "named", key: "chest:main" }],
      leaseMs: 1_000,
    });
    now = new Date(NOW.getTime() + 1_001);
    expect(team.sweepExpired()).toBe(1);
    expect(team.snapshot().assignments).toHaveLength(0);
  });

  it.each([1, 2, 5, 10])(
    "assigns %i compatible Bots without duplicate ownership through one Coordinator",
    (count) => {
      const team = new TeamCoordinator({ registry: registry(count), now: () => NOW });
      team.createObjective({
        objectiveId: `objective-scale-${count}`,
        serverProfileId: "isolated-team",
        title: `Scale test for ${count} Bots`,
        maxBots: count,
      });
      const assignments = Array.from({ length: count }, (_, index) =>
        team.assignTask({
          taskId: `task-scale-${count}-${index}`,
          objectiveId: `objective-scale-${count}`,
          requiredSkills: ["collect.block"],
          claims: [{ kind: "named", key: `resource-${index}` }],
          leaseMs: 30_000,
        })
      );

      expect(new Set(assignments.map(({ botId }) => botId)).size).toBe(count);
      expect(team.snapshot().assignments).toHaveLength(count);
    },
  );

  it("fails closed when no live Bot advertises every required skill", () => {
    const team = new TeamCoordinator({ registry: registry(2), now: () => NOW });
    team.createObjective({
      objectiveId: "objective-unsupported",
      serverProfileId: "isolated-team",
      title: "Require an unavailable skill",
      maxBots: 2,
    });
    expect(() => team.assignTask({
      taskId: "task-unsupported",
      objectiveId: "objective-unsupported",
      requiredSkills: ["combat.pvp-melee"],
      leaseMs: 30_000,
    })).toThrowError(expect.objectContaining({ code: "TEAM_NO_ELIGIBLE_BOT" }));
  });
});

import { describe, expect, it, vi } from "vitest";

import {
  baselineLimits,
  baselineServerPolicy,
  blockCenterDistance,
  collectBlockSkill,
  containerTransferSkill,
  craftItemSkill,
  placeBlockSkill,
  smeltItemSkill,
  ServerPolicyGate,
  SkillExecutor,
  SkillRegistry,
  type SkillExecutionAuthorization,
  type SkillPolicyView,
} from "../src/index.js";
import type { SkillCapability } from "@minecraft-studio/protocol";

const NOW = "2026-08-08T12:00:00.000Z";
const SERVER = "isolated-local";
const DIMENSION = "minecraft:overworld";

const state = {
  online: true,
  normalActionsAllowed: true,
  serverProfileId: SERVER,
  position: {
    x: 0,
    y: 64,
    z: 0,
    dimension: DIMENSION,
    serverProfileId: SERVER,
  },
  inventory: { usedSlots: 4, totalSlots: 36 },
};

function makeInvocation(
  skillId: string,
  input: unknown,
): Record<string, unknown> & {
  payload: { authorization: { decisionId: string; actorId: string; issuedAt: string; expiresAt: string } };
  source: { instanceId: string };
  traceId: string;
  taskId: string;
  botId: string;
} {
  return {
    schemaVersion: "1.0" as const,
    messageId: "11111111-1111-4111-8111-111111111111",
    traceId: `trace-${skillId.replace(/\./gu, "-")}-001`,
    timestamp: NOW,
    source: { service: "coordinator" as const, instanceId: "coordinator-01" },
    botId: "worker-01",
    taskId: `task-${skillId.replace(/\./gu, "-")}-001`,
    type: "skill.invoke.v1" as const,
    payload: {
      invocationId: "22222222-2222-4222-8222-222222222222",
      skillId,
      skillVersion: "1.0.0",
      expiresAt: "2026-08-08T12:01:00.000Z",
      input,
      authorization: {
        decisionId: "33333333-3333-4333-8333-333333333333",
        actorId: "coordinator-agent",
        issuedAt: "2026-08-08T11:59:59.000Z",
        expiresAt: "2026-08-08T12:01:00.000Z",
      },
    },
  };
}

function makeAuthorization(
  invocation: ReturnType<typeof makeInvocation>,
  capabilities: readonly SkillCapability[],
): SkillExecutionAuthorization {
  const payload = invocation.payload as unknown as {
    invocationId: string;
    skillId: string;
    skillVersion: string;
    authorization: { decisionId: string; actorId: string; issuedAt: string; expiresAt: string };
  };
  return {
    decisionId: payload.authorization.decisionId,
    actorId: payload.authorization.actorId,
    sourceInstanceId: invocation.source.instanceId,
    traceId: invocation.traceId,
    taskId: invocation.taskId,
    botId: invocation.botId,
    invocationId: payload.invocationId,
    skillId: payload.skillId,
    skillVersion: payload.skillVersion,
    issuedAt: payload.authorization.issuedAt,
    expiresAt: payload.authorization.expiresAt,
    allowedCapabilities: new Set(capabilities),
  };
}

function makeExecutor(
  invoke = vi.fn(),
  policyView?: (serverProfileId: string) => SkillPolicyView,
) {
  const registry = new SkillRegistry();
  registry.register(collectBlockSkill);
  registry.register(craftItemSkill);
  registry.register(placeBlockSkill);
  registry.register(containerTransferSkill);
  registry.register(smeltItemSkill);
  return {
    invoke,
    executor: new SkillExecutor(registry, {
      runtimeInstanceId: "runtime-01",
      capabilityAdapter: { invoke },
      now: () => new Date(NOW),
      random: () => 0,
      messageId: () => "44444444-4444-4444-8444-444444444444",
      ...(policyView ? { policyView } : {}),
    }),
  };
}

describe("collect.block@1.0.0", () => {
  const input = {
    blockName: "oak_log",
    maxCount: 8,
    maxDistance: 16,
    dimension: DIMENSION,
    serverProfileId: SERVER,
  };

  it("passes the validated request to the collect capability and returns telemetry", async () => {
    const adapter = vi.fn(async () => ({
      blockName: "oak_log",
      targetsFound: 5,
      itemsCollected: 5,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("collect.block", input);

    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["world.interact"]),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { targetsFound: 5, itemsCollected: 5 },
    });
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "world.interact",
        operation: "collect.blocks-safe",
        input,
      }),
    );
  });

  it("rejects cross-server and cross-dimension targets before any capability call", async () => {
    const run = makeExecutor();
    const wrongServer = makeInvocation("collect.block", {
      ...input,
      serverProfileId: "some-other-server",
    });
    expect(
      (
        await run.executor.execute(
          wrongServer,
          makeAuthorization(wrongServer, ["world.interact"]),
          state,
        )
      ).payload.errorCode,
    ).toBe("TARGET_SERVER_PROFILE_MISMATCH");

    const wrongDimension = makeInvocation("collect.block", {
      ...input,
      dimension: "minecraft:the_nether",
    });
    expect(
      (
        await run.executor.execute(
          wrongDimension,
          makeAuthorization(wrongDimension, ["world.interact"]),
          state,
        )
      ).payload.errorCode,
    ).toBe("TARGET_DIMENSION_MISMATCH");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("refuses to start a collect into a full backpack", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("collect.block", input);

    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["world.interact"]),
          { ...state, inventory: { usedSlots: 36, totalSlots: 36 } },
        )
      ).payload.errorCode,
    ).toBe("INVENTORY_FULL");
    // 关键点不只是报错码，而是**一次 capability 都没打出去**：否则采集器仍会
    // 跑满超时，掉落物落地无人捡。
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("refuses a collect when the backpack was never observed", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("collect.block", input);

    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["world.interact"]),
          { ...state, inventory: null },
        )
      ).payload.errorCode,
    ).toBe("INVENTORY_FULL");
    expect(run.invoke).not.toHaveBeenCalled();
  });
});

describe("craft.item@1.0.0", () => {
  const input = {
    itemName: "crafting_table",
    count: 1,
    craftingTable: null,
    dimension: DIMENSION,
    serverProfileId: SERVER,
  };

  it("crafts via the craft capability and reports the read-back count", async () => {
    const adapter = vi.fn(async () => ({
      itemName: "crafting_table",
      requestedCount: 1,
      craftedCount: 1,
      usedCraftingTable: false,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("craft.item", input);

    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["craft.execute"]),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { craftedCount: 1, usedCraftingTable: false },
    });
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "craft.execute",
        operation: "craft.item-safe",
      }),
    );
  });

  it("rejects a crafting table beyond interaction reach", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("craft.item", {
      ...input,
      craftingTable: { x: 30, y: 64, z: 30 },
    });
    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["craft.execute"]),
          state,
        )
      ).payload.errorCode,
    ).toBe("CRAFTING_TABLE_OUT_OF_REACH");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("accepts a crafting table within reach", async () => {
    const adapter = vi.fn(async () => ({
      itemName: "crafting_table",
      requestedCount: 1,
      craftedCount: 1,
      usedCraftingTable: true,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("craft.item", {
      ...input,
      craftingTable: { x: 1, y: 64, z: 1 },
    });
    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["craft.execute"]),
      state,
    );
    expect(result.payload.outcome).toBe("completed");
  });
});

describe("world.place-block@1.0.0", () => {
  const input = {
    itemName: "crafting_table",
    referenceBlock: { x: 1, y: 63, z: 1 },
    face: { x: 0, y: 1, z: 0 },
    dimension: DIMENSION,
    serverProfileId: SERVER,
  };

  it("places one block and returns the read-back confirmation", async () => {
    const adapter = vi.fn(async () => ({
      placed: true,
      placedBlockName: "crafting_table",
      position: { x: 1, y: 64, z: 1 },
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("world.place-block", input);

    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["world.interact"]),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { placed: true, placedBlockName: "crafting_table" },
    });
  });

  it("rejects diagonal face vectors at input validation", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("world.place-block", {
      ...input,
      face: { x: 1, y: 1, z: 0 },
    });
    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["world.interact"]),
          state,
        )
      ).payload.errorCode,
    ).toBe("SKILL_INPUT_INVALID");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("rejects an out-of-reach reference block", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("world.place-block", {
      ...input,
      referenceBlock: { x: 40, y: 64, z: 40 },
    });
    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["world.interact"]),
          state,
        )
      ).payload.errorCode,
    ).toBe("TARGET_OUT_OF_REACH");
    expect(run.invoke).not.toHaveBeenCalled();
  });
});

describe("container.transfer@1.0.0", () => {
  const input = {
    direction: "deposit" as const,
    itemName: "cobblestone",
    count: 32,
    container: { x: 2, y: 64, z: 0 },
    dimension: DIMENSION,
    serverProfileId: SERVER,
  };

  it("transfers via container.write and reports the actual moved count", async () => {
    const adapter = vi.fn(async () => ({
      direction: "deposit",
      itemName: "cobblestone",
      requestedCount: 32,
      // 箱子快满，只进去 20——如实上报。
      movedCount: 20,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("container.transfer", input);

    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["container.read", "container.write"]),
      state,
    );

    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { movedCount: 20, requestedCount: 32 },
    });
    expect(adapter).toHaveBeenCalledWith(
      expect.objectContaining({
        capability: "container.write",
        operation: "container.transfer-safe",
      }),
    );
  });

  it("rejects an out-of-reach container before any capability call", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("container.transfer", {
      ...input,
      container: { x: 50, y: 64, z: 50 },
    });
    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["container.read", "container.write"]),
          state,
        )
      ).payload.errorCode,
    ).toBe("CONTAINER_OUT_OF_REACH");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("rejects when normal actions are paused (L0 gate)", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("container.transfer", input);
    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["container.read", "container.write"]),
          { ...state, normalActionsAllowed: false },
        )
      ).payload.errorCode,
    ).toBe("NORMAL_ACTIONS_PAUSED");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  // 方向敏感的背包闸门。这一对断言是整条自救路径的关键：存货必须在背包满时
  // 仍然放行，否则"背包满了 → 去存箱子"这条唯一的出路也被自己拦死，bot 卡到人工介入。
  it("still deposits when the backpack is full", async () => {
    const adapter = vi.fn(async () => ({
      direction: "deposit",
      itemName: "cobblestone",
      requestedCount: 32,
      movedCount: 32,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("container.transfer", input);

    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["container.read", "container.write"]),
      { ...state, inventory: { usedSlots: 36, totalSlots: 36 } },
    );

    expect(result.payload.outcome).toBe("completed");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("still deposits when the backpack was never observed", async () => {
    const adapter = vi.fn(async () => ({
      direction: "deposit",
      itemName: "cobblestone",
      requestedCount: 32,
      movedCount: 32,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("container.transfer", input);

    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["container.read", "container.write"]),
      { ...state, inventory: null },
    );

    expect(result.payload.outcome).toBe("completed");
  });

  it("refuses a withdraw into a full backpack", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("container.transfer", {
      ...input,
      direction: "withdraw" as const,
    });

    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["container.read", "container.write"]),
          { ...state, inventory: { usedSlots: 36, totalSlots: 36 } },
        )
      ).payload.errorCode,
    ).toBe("INVENTORY_FULL");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("refuses a withdraw when the backpack was never observed", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("container.transfer", {
      ...input,
      direction: "withdraw" as const,
    });

    expect(
      (
        await run.executor.execute(
          invocation,
          makeAuthorization(invocation, ["container.read", "container.write"]),
          { ...state, inventory: null },
        )
      ).payload.errorCode,
    ).toBe("INVENTORY_FULL");
    expect(run.invoke).not.toHaveBeenCalled();
  });
});

describe("smelt.item@1.0.0", () => {
  const input = {
    inputItemName: "raw_iron",
    fuelItemName: "coal",
    fuelCount: 1,
    count: 5,
    furnace: { x: 2, y: 64, z: 0 },
    dimension: DIMENSION,
    serverProfileId: SERVER,
  };

  it("smelts through the bounded craft capability and reports read-back output", async () => {
    const adapter = vi.fn(async () => ({
      inputItemName: "raw_iron",
      fuelItemName: "coal",
      outputItemName: "iron_ingot",
      requestedCount: 5,
      insertedFuelCount: 1,
      smeltedCount: 5,
    }));
    const run = makeExecutor(adapter);
    const invocation = makeInvocation("smelt.item", input);
    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["craft.execute"]),
      state,
    );
    expect(result.payload).toMatchObject({
      outcome: "completed",
      output: { outputItemName: "iron_ingot", smeltedCount: 5 },
    });
    expect(adapter).toHaveBeenCalledWith(expect.objectContaining({
      capability: "craft.execute",
      operation: "smelt.item-safe",
    }));
  });

  it("rejects an out-of-reach furnace before capability execution", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("smelt.item", {
      ...input,
      furnace: { x: 50, y: 64, z: 50 },
    });
    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["craft.execute"]),
      state,
    );
    expect(result.payload.errorCode).toBe("FURNACE_OUT_OF_REACH");
    expect(run.invoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// reach 是否真的从 ServerPolicy 读——不是把 4.5 换个地方写死。
//
// 判据：找一个落在两档之间的距离。方块 (3,64,1)、bot (0,64,0)，按方块中心
// 算出 ≈3.841 格：STRICT（3.8）该拒，VANILLA_COMPATIBLE（4.5）该放。同一份
// 输入两种档位得出相反结果，才说明策略层接上了（AGENTS.md §2）。
// ---------------------------------------------------------------------------
describe("skill reach reads the active ServerPolicy", () => {
  const BETWEEN_PROFILES = { x: 3, y: 64, z: 1 };

  it("puts the probe distance strictly between the STRICT and VANILLA_COMPATIBLE ceilings", () => {
    const distance = blockCenterDistance(BETWEEN_PROFILES, state.position);
    expect(distance).toBeGreaterThan(
      baselineLimits("STRICT").blockInteractionReach,
    );
    expect(distance).toBeLessThanOrEqual(
      baselineLimits("VANILLA_COMPATIBLE").blockInteractionReach,
    );
  });

  it("rejects it under the STRICT baseline the executor falls back to", async () => {
    const run = makeExecutor();
    const invocation = makeInvocation("world.place-block", {
      itemName: "torch",
      referenceBlock: BETWEEN_PROFILES,
      face: { x: 0, y: 1, z: 0 },
      dimension: DIMENSION,
      serverProfileId: SERVER,
    });
    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["world.interact"]),
      state,
    );
    expect(result.payload.errorCode).toBe("TARGET_OUT_OF_REACH");
    expect(run.invoke).not.toHaveBeenCalled();
  });

  it("accepts the same input once the server profile resolves to VANILLA_COMPATIBLE", async () => {
    const adapter = vi.fn(async () => ({
      placed: true,
      placedBlockName: "torch",
      position: { x: 3, y: 65, z: 1 },
    }));
    const run = makeExecutor(adapter, (serverProfileId) =>
      new ServerPolicyGate(
        baselineServerPolicy(serverProfileId, "VANILLA_COMPATIBLE"),
      ),
    );
    const invocation = makeInvocation("world.place-block", {
      itemName: "torch",
      referenceBlock: BETWEEN_PROFILES,
      face: { x: 0, y: 1, z: 0 },
      dimension: DIMENSION,
      serverProfileId: SERVER,
    });
    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["world.interact"]),
      state,
    );
    expect(result.payload.outcome).toBe("completed");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("resolves the view by the server the bot is actually on, not the one input claims", async () => {
    const seen: string[] = [];
    const run = makeExecutor(vi.fn(), (serverProfileId) => {
      seen.push(serverProfileId);
      return new ServerPolicyGate(baselineServerPolicy(serverProfileId));
    });
    const invocation = makeInvocation("world.place-block", {
      itemName: "torch",
      referenceBlock: BETWEEN_PROFILES,
      face: { x: 0, y: 1, z: 0 },
      dimension: DIMENSION,
      serverProfileId: "some-other-server",
    });
    const result = await run.executor.execute(
      invocation,
      makeAuthorization(invocation, ["world.interact"]),
      state,
    );
    // 声称的服与实际连的服不一致，前置条件先拒；策略视图按 state 解析。
    expect(result.payload.errorCode).toBe("TARGET_SERVER_PROFILE_MISMATCH");
    expect(seen).toEqual([SERVER]);
  });
});


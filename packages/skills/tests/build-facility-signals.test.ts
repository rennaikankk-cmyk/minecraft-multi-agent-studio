import { describe, expect, it } from "vitest";

import {
  classifyIncident,
  FAILURE_CODE_ALIASES,
  INCIDENT_TYPE_BY_CODE,
  normalizeFailureCode,
} from "../src/incidents.js";
import {
  acquireWorkstation,
  InMemoryWorkstationRegistry,
  type FacilityFailureSignal,
  type WorkstationRegistryPort,
  type WorkstationEntry,
} from "../src/workstation-registry.js";

function registryWithLeasedFurnace(options: {
  leaseTtlMs: number;
  leaseAgeMs: number;
}): { registry: WorkstationRegistryPort & { get(...args: never[]): unknown } } {
  const registry = new InMemoryWorkstationRegistry({ leaseTtlMs: options.leaseTtlMs });
  registry.register("sp-1", "minecraft:overworld", "furnace", { x: 0, y: 64, z: 0 });
  const otherBot = "bot-other";
  // 直接用 claim 建 lease，再用时间推进模拟 lease 老化
  const claimedFresh = registry.claim("sp-1", "minecraft:overworld", { x: 0, y: 64, z: 0 }, otherBot, options.leaseTtlMs);
  expect(claimedFresh).toBe(true);
  if (options.leaseAgeMs > 0) {
    // 冻结时间的效果用 lease TTL 差值模拟：短 TTL 让 lease 立即过期
    registry.renewClaim("sp-1", "minecraft:overworld", { x: 0, y: 64, z: 0 }, otherBot, options.leaseAgeMs);
  }
  return { registry: registry as never };
}

describe("P1-1 facility failure signals (library hook)", () => {
  it("emits FACILITY_VERIFY_FAILED when the registry entry is disproven server-side", async () => {
    const registry = new InMemoryWorkstationRegistry();
    registry.register("sp-1", "minecraft:overworld", "furnace", { x: 0, y: 64, z: 0 });
    const signals: FacilityFailureSignal[] = [];

    const result = await acquireWorkstation(registry, {
      serverProfileId: "sp-1",
      dimension: "minecraft:overworld",
      type: "furnace",
      from: { x: 0, y: 64, z: 3 },
      botId: "bot-a",
      verifyFn: async () => false,
      onFailureSignal: (signal) => signals.push(signal),
    });

    expect(result.status).toBe("not_found");
    expect(signals.length).toBe(1);
    expect(signals[0]?.failureCode).toBe("FACILITY_VERIFY_FAILED");
    expect(signals[0]?.position).toEqual({ x: 0, y: 64, z: 0 });
    expect(signals[0]?.expected).toContain("workstation type=furnace present");
    expect(signals[0]?.actual).toContain("verifyFn rejected");
  });

  it("emits no signal for normal lease contention (busy is not an incident)", async () => {
    const registry = new InMemoryWorkstationRegistry({ leaseTtlMs: 60_000 });
    registry.register("sp-1", "minecraft:overworld", "furnace", { x: 0, y: 64, z: 0 });
    const claimed = registry.claim("sp-1", "minecraft:overworld", { x: 0, y: 64, z: 0 }, "bot-other", 60_000);
    expect(claimed).toBe(true);
    const signals: FacilityFailureSignal[] = [];

    const result = await acquireWorkstation(registry, {
      serverProfileId: "sp-1",
      dimension: "minecraft:overworld",
      type: "furnace",
      from: { x: 0, y: 64, z: 3 },
      botId: "bot-a",
      verifyFn: async (entry: WorkstationEntry) => entry.position.x === 0,
      onFailureSignal: (signal) => signals.push(signal),
    });

    expect(result.status).toBe("busy");
    expect(signals.length).toBe(0);
  });

  it("emits FACILITY_RESERVATION_CORRUPT when a claim is refused despite an expired lease", async () => {
    const registry = new InMemoryWorkstationRegistry({ leaseTtlMs: 60_000 });
    registry.register("sp-1", "minecraft:overworld", "furnace", { x: 0, y: 64, z: 0 });
    // 1ms lease 然后等待过期：真实注册表的 lease 已过期（可回收），
    // 但损坏的 claim 实现仍然拒绝——这才是 corruption 语义。
    expect(registry.claim("sp-1", "minecraft:overworld", { x: 0, y: 64, z: 0 }, "bot-other", 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const signals: FacilityFailureSignal[] = [];
    const corrupted: WorkstationRegistryPort = {
      findCandidates: registry.findCandidates.bind(registry),
      register: registry.register.bind(registry),
      get: registry.get.bind(registry),
      // 损坏语义：无论 lease 状态如何一律拒绝
      claim: () => false,
      renewClaim: registry.renewClaim.bind(registry),
      release: registry.release.bind(registry),
      releaseAllClaims: registry.releaseAllClaims.bind(registry),
      invalidate: registry.invalidate.bind(registry),
      clearServer: registry.clearServer.bind(registry),
    } as never;

    const result = await acquireWorkstation(corrupted, {
      serverProfileId: "sp-1",
      dimension: "minecraft:overworld",
      type: "furnace",
      from: { x: 0, y: 64, z: 3 },
      botId: "bot-a",
      onFailureSignal: (signal) => signals.push(signal),
    });

    expect(result.status).toBe("busy");
    expect(signals.length).toBe(1);
    expect(signals[0]?.failureCode).toBe("FACILITY_RESERVATION_CORRUPT");
    expect(signals[0]?.expected).toContain("expired lease is reclaimable");
  });

  it("swallows a throwing signal sink (diagnostics must not break acquisition)", async () => {
    const registry = new InMemoryWorkstationRegistry();
    registry.register("sp-1", "minecraft:overworld", "furnace", { x: 0, y: 64, z: 0 });

    const result = await acquireWorkstation(registry, {
      serverProfileId: "sp-1",
      dimension: "minecraft:overworld",
      type: "furnace",
      from: { x: 0, y: 64, z: 3 },
      botId: "bot-a",
      verifyFn: async () => false,
      onFailureSignal: () => {
        throw new Error("sink exploded");
      },
    });

    expect(result.status).toBe("not_found");
  });
});

describe("P1-1 build/facility registry classification", () => {
  it("maps the new stable build codes to BUILD layer with stable incident types", () => {
    expect(INCIDENT_TYPE_BY_CODE.BUILD_CELL_UNREACHABLE).toBe("UNREACHABLE");
    expect(INCIDENT_TYPE_BY_CODE.BUILD_MATERIAL_MISSING).toBe("PLACEMENT_FAILED");
    expect(INCIDENT_TYPE_BY_CODE.BUILD_PLACEMENT_REJECTED).toBe("PLACEMENT_FAILED");
    expect(INCIDENT_TYPE_BY_CODE.BUILD_RECOVERY_EXHAUSTED).toBe("SKILL_FAILED");
    expect(classifyIncident({ failureCode: "BUILD_WRONG_BLOCK" })).toMatchObject({
      suspectedLayer: "BUILD",
      ruleId: "R-BUILD-1",
    });
    expect(classifyIncident({ failureCode: "BUILD_CELL_UNREACHABLE" })).toMatchObject({
      suspectedLayer: "BUILD",
    });
  });

  it("maps the facility codes to FACILITY layer", () => {
    expect(classifyIncident({ failureCode: "FACILITY_VERIFY_FAILED" })).toMatchObject({
      suspectedLayer: "FACILITY",
      ruleId: "R-FAC-1",
    });
    expect(classifyIncident({ failureCode: "FACILITY_RESERVATION_CORRUPT" })).toMatchObject({
      suspectedLayer: "FACILITY",
    });
    expect(INCIDENT_TYPE_BY_CODE.FACILITY_RESERVATION_CORRUPT).toBe("RESERVATION_CONFLICT");
    expect(INCIDENT_TYPE_BY_CODE.FACILITY_SLOT_INVALID).toBe("STATE_DIVERGENCE");
  });

  it("keeps the legacy blueprint codes as aliases of the stable codes", () => {
    expect(FAILURE_CODE_ALIASES.BLUEPRINT_STEP_BLOCKED).toBe("BUILD_WRONG_BLOCK");
    expect(FAILURE_CODE_ALIASES.BLUEPRINT_MATERIAL_INSUFFICIENT).toBe("BUILD_MATERIAL_MISSING");
    expect(FAILURE_CODE_ALIASES.ALL_CELLS_OUT_OF_REACH).toBe("BUILD_CELL_UNREACHABLE");
    expect(normalizeFailureCode("BLUEPRINT_STEP_BLOCKED")).toBe("BUILD_WRONG_BLOCK");
  });
});

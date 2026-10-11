import { describe, expect, it } from "vitest";
import { FacilityExecutor } from "../src/facility-executor.js";
import { FacilityRegistry } from "../src/facility-registry.js";

function makeRegistry() {
  const registry = new FacilityRegistry();
  const facility = registry.create({ facilityType: "iron_farm", serverProfileId: "server", dimension: "overworld", anchor: { x: 0, y: 64, z: 0 }, orientation: "north", layoutVersion: "1", patternSlots: [{ localOffset: { x: 0, y: 0, z: 0 }, workstationType: "chest" as never }] });
  return { registry, facility };
}

describe("FacilityExecutor", () => {
  it("requires server readback and drives the production ledger", async () => {
    const { registry, facility } = makeRegistry();
    const executor = new FacilityExecutor(registry, {
      invoke: async ({ phase }) => ({ ok: true, consumed: phase === "entities" ? { iron_ingot: 1 } : undefined }),
      readback: async () => ({ cells: [{ slotIndex: 0, blockPresent: true, blockName: "chest" }], output: { iron_ingot: 12 } }),
    });
    const result = await executor.run(facility.id);
    expect(result.ok).toBe(true);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("ACTIVE");
    expect((facility.metadata.productionLedger as { produced: Record<string, number> }).produced.iron_ingot).toBe(12);
    // 实体阶段消耗的 1 个铁锭只能记一次。修复前 entities 与
    // verification.output 两处循环都写 "consumed"，累加成 2。
    expect((facility.metadata.productionLedger as { consumed: Record<string, number> }).consumed).toEqual({ iron_ingot: 1 });
    expect(result.consumed).toEqual({ iron_ingot: 1 });
  });

  it("counts activation consumption exactly once alongside entity consumption", async () => {
    const { registry, facility } = makeRegistry();
    const executor = new FacilityExecutor(registry, {
      invoke: async ({ phase }) => ({
        ok: true,
        consumed: phase === "entities"
          ? { iron_ingot: 3 }
          : phase === "activate"
            ? { redstone: 2 }
            : undefined,
      }),
      readback: async () => ({ cells: [{ slotIndex: 0, blockPresent: true, blockName: "chest" }], output: { iron_ingot: 12 } }),
    });
    expect((await executor.run(facility.id)).ok).toBe(true);
    expect((facility.metadata.productionLedger as { consumed: Record<string, number> }).consumed).toEqual({
      iron_ingot: 3,
      redstone: 2,
    });
  });

  it("marks blocked collectors degraded and can restart through repair", async () => {
    const { registry, facility } = makeRegistry();
    let blocked = true;
    const executor = new FacilityExecutor(registry, {
      invoke: async () => ({ ok: true }),
      readback: async () => ({ cells: [{ slotIndex: 0, blockPresent: true, blockName: "chest" }], collectorFull: blocked, output: blocked ? {} : { iron_ingot: 1 } }),
    });
    expect((await executor.run(facility.id)).ok).toBe(false);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("DEGRADED");
    blocked = false;
    expect((await executor.repair(facility.id)).ok).toBe(true);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("ACTIVE");
  });

  it("handles a capability invocation crash without leaking a reserved slot (executor deep-scan round 31)", async () => {
    // 此前 adapter.invoke reject 时异常直接冒出：slot 卡 placement_reserved、
    // 无 markPlacementFailed（退避不启动）、无 DEGRADED、ledger 永停 BUILDING。
    // 现在 catch → markPlacementFailed + DEGRADED + 返回失败。
    let nowMs = 1_000;
    const registry = new FacilityRegistry({ now: () => nowMs });
    const facility = registry.create({ facilityType: "iron_farm", serverProfileId: "server", dimension: "overworld", anchor: { x: 0, y: 64, z: 0 }, orientation: "north", layoutVersion: "1", patternSlots: [{ localOffset: { x: 0, y: 0, z: 0 }, workstationType: "chest" as never }] });
    const executor = new FacilityExecutor(registry, {
      invoke: async ({ phase }) => {
        if (phase === "construct") throw new Error("bot disconnected mid-placement");
        return { ok: true };
      },
      readback: async () => ({ cells: [], output: {} }),
    }, () => nowMs);
    const result = await executor.run(facility.id);
    expect(result).toMatchObject({ ok: false, blockedReason: "CAPABILITY_INVOCATION_CRASHED" });
    expect(facility.slots[0]!.status).toBe("temporarily_blocked");
    expect(facility.slots[0]!.failureCount).toBe(1);
    expect(facility.slots[0]!.lastFailureAtMs).toBe(1_000);
    expect((facility.metadata.productionLedger as { state: string }).state).toBe("DEGRADED");
  });

  it("respects the placement backoff window for temporarily_blocked slots", async () => {
    // 退避绕过修复：temporarily_blocked 的 slot 在 lastFailureAtMs + backoff
    // 未到期前跳过；到期后可正常 reserve。
    let nowMs = 1_000;
    const registry = new FacilityRegistry({ now: () => nowMs });
    const facility = registry.create({ facilityType: "iron_farm", serverProfileId: "server", dimension: "overworld", anchor: { x: 0, y: 64, z: 0 }, orientation: "north", layoutVersion: "1", patternSlots: [{ localOffset: { x: 0, y: 0, z: 0 }, workstationType: "chest" as never }] });
    // 手动设置退避状态：reserve → markPlacementFailed（failureCount=1，退避 10s）。
    registry.reserveSlot(facility.id, 0, "facility-executor:test", 120_000);
    registry.markPlacementFailed(facility.id, 0, "simulated_failure", "facility-executor:test");
    expect(facility.slots[0]!.status).toBe("temporarily_blocked");
    expect(facility.slots[0]!.failureCount).toBe(1);
    expect(facility.slots[0]!.lastFailureAtMs).toBe(1_000);
    // 退避窗口内（5s < 10s）：run 应跳过该 slot → entities/activate/verify
    // 阶段照跑（无 construct 调用）。
    const invokeCalls: number[] = [];
    const executor = new FacilityExecutor(registry, {
      invoke: async ({ phase, slotIndex }) => {
        if (phase === "construct") invokeCalls.push(slotIndex!);
        return { ok: true };
      },
      readback: async () => ({ cells: [{ slotIndex: 0, blockPresent: true, blockName: "chest" }], output: { iron_ingot: 1 } }),
    }, () => nowMs);
    nowMs = 5_500;
    const withinWindow = await executor.run(facility.id);
    expect(withinWindow.ok).toBe(true);
    expect(invokeCalls).toHaveLength(0); // 退避内 construct 未被调用
    expect(facility.slots[0]!.status).toBe("temporarily_blocked"); // 未被翻动
    // 退避窗口过后（11s > 10s）：construct 被正常调用，slot 占位。
    nowMs = 11_000;
    const afterBackoff = await executor.run(facility.id);
    expect(afterBackoff.ok).toBe(true);
    expect(invokeCalls).toEqual([0]); // construct 已执行
    expect(facility.slots[0]!.status).toBe("occupied");
  });
});

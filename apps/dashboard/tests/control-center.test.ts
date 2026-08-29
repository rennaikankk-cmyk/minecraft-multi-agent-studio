// ---------------------------------------------------------------------------
// Control Center 组件纯逻辑测试（四十二节：状态徽章 / 蓝图网格 / 视图模型）
// ---------------------------------------------------------------------------
import { describe, expect, it } from "vitest";

import {
  baseStatusTone,
  connectionLabel,
  connectionTone,
  facilitySlotLabel,
  facilitySlotTone,
} from "@/components/status-badges";
import { buildGrid } from "@/components/blueprint-grid";
import { toSharedStateView } from "@/lib/shared-state-client";

describe("connection badge classification", () => {
  it("online is ok, connecting is info, error is bad", () => {
    expect(connectionTone("online")).toBe("ok");
    expect(connectionTone("connecting")).toBe("info");
    expect(connectionTone("stale")).toBe("warn");
    expect(connectionTone("offline")).toBe("muted");
    expect(connectionTone("stopping")).toBe("muted");
    expect(connectionTone("error")).toBe("bad");
  });

  it("labels are uppercase (state not color-only)", () => {
    expect(connectionLabel("online")).toBe("ONLINE");
    expect(connectionLabel("connecting")).toBe("CONNECTING");
  });
});

describe("facility slot badge classification (7-state parity with backend)", () => {
  it("occupied=ok planned=muted reserved=info missing/temp_blocked/invalid=bad/warn", () => {
    expect(facilitySlotTone("occupied")).toBe("ok");
    expect(facilitySlotTone("planned")).toBe("muted");
    expect(facilitySlotTone("placement_reserved")).toBe("info");
    expect(facilitySlotTone("missing")).toBe("bad");
    expect(facilitySlotTone("temporarily_blocked")).toBe("warn");
    expect(facilitySlotTone("invalid")).toBe("bad");
  });

  it("unknown values fall back to warn with UNKNOWN() label (never silently green)", () => {
    expect(facilitySlotTone("whatever")).toBe("warn");
    expect(facilitySlotLabel("whatever")).toBe("UNKNOWN(whatever)");
    expect(facilitySlotLabel("occupied")).toBe("OCCUPIED");
  });
});

describe("base status badge", () => {
  it("operational=ok building=info damaged=bad abandoned=muted unknown=warn", () => {
    expect(baseStatusTone("operational")).toBe("ok");
    expect(baseStatusTone("building")).toBe("info");
    expect(baseStatusTone("damaged")).toBe("bad");
    expect(baseStatusTone("abandoned")).toBe("muted");
    expect(baseStatusTone("weird")).toBe("warn");
  });
});

describe("buildGrid geometry", () => {
  const cells = [
    { offset: { x: 0, y: 0, z: 0 }, itemName: "cobblestone", blockClass: "foundation", reconcileStatus: "unknown" },
    { offset: { x: 2, y: 0, z: 1 }, itemName: "cobblestone", blockClass: "foundation", reconcileStatus: "unknown" },
    { offset: { x: 1, y: 3, z: 1 }, itemName: "torch", blockClass: "decoration", reconcileStatus: "unknown" },
  ];

  it("splits levels, orders rows north-first (z desc) and cells x asc, computes bounds", () => {
    const grid = buildGrid(cells);
    expect(grid.levels).toEqual([0, 3]);
    const level0 = grid.rowsByLevel.get(0)!;
    expect(level0.map((row) => row.z)).toEqual([1, 0]); // 北（-z）在上 → z 大的先
    expect(level0[0]!.cells.map((cell) => cell.offset.x)).toEqual([2]);
    expect(level0[1]!.cells.map((cell) => cell.offset.x)).toEqual([0]);
    expect(grid.bounds).toEqual({ minX: 0, maxX: 2, minZ: 0, maxZ: 1 });
  });

  it("empty input yields empty levels and zeroed bounds", () => {
    const grid = buildGrid([]);
    expect(grid.levels).toEqual([]);
    expect(grid.bounds).toEqual({ minX: 0, maxX: 0, minZ: 0, maxZ: 0 });
  });
});

describe("toSharedStateView aggregation", () => {
  it("derives slot counts, base facility counts, and lease views from a snapshot", () => {
    const view = toSharedStateView({
      savedAt: "2026-08-29T12:00:00Z",
      workstations: {
        entries: [
          {
            type: "furnace",
            serverProfileId: "srv-a",
            dimension: "minecraft:overworld",
            position: { x: 1, y: 65, z: 2 },
            usageMode: "exclusive",
            lastSeenAt: 1_000,
            lease: { ownerBotId: "bot-1", expiresAtMs: 2_000 },
          },
        ],
      },
      facilities: {
        facilities: [
          {
            id: "facility-x",
            facilityType: "smelting_zone",
            serverProfileId: "srv-a",
            dimension: "minecraft:overworld",
            baseId: "base-x",
            anchor: { x: 1, y: 65, z: 2 },
            discovery: "observed_existing",
            slots: [
              { slotId: "facility-x#0", index: 0, workstationType: "furnace", status: "occupied" },
              { slotId: "facility-x#1", index: 1, workstationType: "furnace", status: "planned" },
              { index: 2, workstationType: "furnace", status: "missing", statusReason: "griefed", failureCount: 2 },
            ],
          },
        ],
      },
      bases: {
        bases: [
          {
            id: "base-x",
            name: "hideout",
            serverProfileId: "srv-a",
            dimension: "minecraft:overworld",
            anchor: { x: 1, y: 65, z: 2 },
            blueprintId: "starter_base_v1",
            status: "operational",
            integrity01: 1,
            placedCells: 85,
            updatedAt: "2026-08-29T11:00:00Z",
          },
        ],
      },
    });

    expect(view.savedAt).toBe("2026-08-29T12:00:00Z");
    expect(view.facilities[0]!.slotCounts).toEqual({ occupied: 1, planned: 1, missing: 1 });
    expect(view.facilities[0]!.slots[2]!.slotId).toBe("facility-x#2"); // 缺省 slotId 派生
    expect(view.facilities[0]!.slots[2]!.failureCount).toBe(2);
    expect(view.bases[0]!.facilityCount).toBe(1);
    expect(view.workstations[0]!.leaseOwnerBotId).toBe("bot-1");
  });

  it("handles empty/absent snapshot sections without throwing", () => {
    const view = toSharedStateView({});
    expect(view.bases).toEqual([]);
    expect(view.facilities).toEqual([]);
    expect(view.workstations).toEqual([]);
    expect(view.savedAt).toBeNull();
  });
});

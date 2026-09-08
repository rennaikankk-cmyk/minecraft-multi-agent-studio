import { describe, expect, it } from "vitest";
import { botPersonalContextSchema, botPersonalMemoryScopeSchema } from "../src/index.js";

describe("personal memory schemas", () => {
  it("requires all scope identities and distinguishes unknown from an assigned world", () => {
    const scope = { botId: "MinerOne", serverProfileId: "private-server", worldId: null };
    expect(botPersonalMemoryScopeSchema.parse(scope)).toEqual(scope);
    expect(botPersonalMemoryScopeSchema.safeParse({ botId: "MinerOne" }).success).toBe(false);
    expect(botPersonalMemoryScopeSchema.safeParse({ ...scope, worldId: "" }).success).toBe(false);
    expect(botPersonalMemoryScopeSchema.safeParse({ ...scope, botId: "../../other" }).success).toBe(false);
  });
  it("rejects generic spawn events as evidence of a bed and requires dimensioned finite coordinates", () => {
    const context = { worldId: null, worldSpawn: null, verifiedRespawn: null };
    expect(botPersonalContextSchema.parse(context)).toEqual(context);
    const observed = { position: { x: 1, y: 64, z: 2, dimension: "minecraft:overworld" },
      observedAt: "2026-09-08T12:00:00.000Z", kind: "bed", source: "spawn_event" };
    expect(botPersonalContextSchema.safeParse({ ...context, verifiedRespawn: observed }).success).toBe(false);
    expect(botPersonalContextSchema.safeParse({ ...context, verifiedRespawn: { ...observed, source: "server_confirmation" } }).success).toBe(true);
    expect(botPersonalContextSchema.safeParse({ ...context, worldSpawn: { ...observed, kind: undefined, source: "server_spawn_packet", position: { x: 1, y: 2, z: 3 } } }).success).toBe(false);
  });
});
